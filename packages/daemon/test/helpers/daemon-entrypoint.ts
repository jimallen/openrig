// OF-232 — the one spawn helper for a test that runs the PRODUCTION daemon entrypoint (src/index.ts, isDirectRun -> startServer)
// as a child process.
//
// Two things a bare `spawn(... index.ts)` with only OPENRIG_PORT got wrong, both measured on Sparky (release 54):
//  1. With no OPENRIG_BIND_HOST the daemon takes its DEFAULT bind plan: loopback AND the host's own Tailscale address. A test
//     daemon was therefore reachable on the tailnet (unauthenticated: the tailnet is the daemon's only auth boundary), and it
//     could collide on a port that something else held on that interface ("listen EADDRINUSE 100.76.25.39:45509").
//  2. The port was reserved on 127.0.0.1 only and released before the child bound it, so the reservation said nothing about the
//     other interface, and a lost race was fatal.
// This helper pins the bind host to loopback through the daemon's dedicated bind-intent env (OPENRIG_BIND_HOST, which wins over
// any inherited value because it is set after the inherited env is spread), and retries on a port that was lost between the
// reservation and the bind.
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import path from "node:path";

export const TEST_DAEMON_BIND_HOST = "127.0.0.1";

export const DAEMON_ENTRYPOINT = path.resolve(import.meta.dirname, "../../src/index.ts");

/** Reserve a free port on loopback (the only interface a test daemon binds). Released at once: the spawn retries on a lost race. */
export function getFreeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, TEST_DAEMON_BIND_HOST, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("could not reserve a free port"))));
    });
  });
}

export interface EntrypointDaemon {
  child: ChildProcess;
  port: number;
  stderr: () => string;
  stdout: () => string;
}

export interface SpawnDaemonEntrypointOptions {
  /** The daemon's private OPENRIG_HOME (its database defaults to <home>/openrig.sqlite unless env.OPENRIG_DB says otherwise). */
  home: string;
  /** Extra child env (PATH stubs, ...). Spread after the inherited env, before the pinned names. */
  env?: Record<string, string | undefined>;
  /** Extra node arguments before the entrypoint (after `--import tsx`). */
  nodeArgs?: string[];
  /** Upper bound on one attempt becoming healthy. */
  readyTimeoutMs: number;
  /** Test seam: where each attempt's port comes from (default: a fresh loopback reservation). */
  portSource?: () => Promise<number>;
  /** Attempts when the port was lost between reservation and bind (EADDRINUSE). Default 4. */
  attempts?: number;
}

async function waitHealthy(port: number, child: ChildProcess, stderr: () => string, timeoutMs: number): Promise<"ready" | "exited"> {
  let exited = child.exitCode !== null || child.signalCode !== null;
  child.once("exit", () => { exited = true; });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited) return "exited";
    try {
      const res = await fetch(`http://${TEST_DAEMON_BIND_HOST}:${port}/healthz`, { signal: AbortSignal.timeout(2_000) });
      if (res.status === 200) return "ready";
    } catch {
      // not up yet, or something else holds the port and never answers (a lost race): the loop re-checks the child's exit
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`daemon never became healthy: ${stderr()}`);
}

/** Start the production entrypoint on a private home, bound to loopback only, and wait for /healthz. */
export async function spawnDaemonEntrypoint(opts: SpawnDaemonEntrypointOptions): Promise<EntrypointDaemon> {
  const attempts = opts.attempts ?? 4;
  let lastStderr = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const port = await (opts.portSource ?? getFreeLoopbackPort)();
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...opts.env,
      OPENRIG_NO_KERNEL: "1",
      OPENRIG_HOME: opts.home,
      OPENRIG_DB: opts.env?.["OPENRIG_DB"] ?? path.join(opts.home, "openrig.sqlite"),
      OPENRIG_PORT: String(port),
      OPENRIG_URL: "",
      OPENRIG_BIND_HOST: TEST_DAEMON_BIND_HOST,
    };
    delete env["VITEST"];
    delete env["NODE_ENV"];
    const child = spawn(process.execPath, ["--import", "tsx", ...(opts.nodeArgs ?? []), DAEMON_ENTRYPOINT], {
      env: env as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    child.stderr!.setEncoding("utf8");
    child.stdout!.setEncoding("utf8");
    child.stderr!.on("data", (c: string) => { stderr += c; });
    child.stdout!.on("data", (c: string) => { stdout += c; });
    let outcome: "ready" | "exited";
    try {
      outcome = await waitHealthy(port, child, () => stderr, opts.readyTimeoutMs);
    } catch (error) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      throw error;
    }
    if (outcome === "ready") return { child, port, stderr: () => stderr, stdout: () => stdout };
    lastStderr = stderr;
    if (!/EADDRINUSE/.test(stderr)) throw new Error(`daemon exited before ready: ${stderr}`);
    // The port was lost between the reservation and the bind: a different port next attempt. The failed child's database
    // is private to this home and is reopened by the next attempt.
    if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
  }
  throw new Error(`daemon exited before ready on ${attempts} ports (EADDRINUSE each time): ${lastStderr}`);
}

/** Terminate a spawned daemon: SIGKILL only a child that is still running. */
export function killIfRunning(child: ChildProcess): void {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}
