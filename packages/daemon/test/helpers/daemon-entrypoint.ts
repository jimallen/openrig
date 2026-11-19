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
import { withoutSeatPath } from "../../../../scripts/seat-path.mjs";
import fs from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { claimTestPort } from "./test-ports.js";
import { waitBound, waitTimedOut } from "./wait-timeout.js";

export const TEST_DAEMON_BIND_HOST = "127.0.0.1";

export const DAEMON_ENTRYPOINT = path.resolve(import.meta.dirname, "../../src/index.ts");

/** A free loopback port (the only interface a test daemon binds), claimed for this test process so no other test process is handed it
 *  before the daemon binds it (workspaces-o9o.81). The spawn still retries on a lost race with anything outside the suites. */
export function getFreeLoopbackPort(): Promise<number> {
  return claimTestPort();
}

export interface EntrypointDaemon {
  child: ChildProcess;
  port: number;
  stderr: () => string;
  stdout: () => string;
}

export interface SpawnDaemonEntrypointOptions {
  /** The daemon's private OPENRIG_HOME. Its database is <home>/openrig.sqlite, and every other location it uses is under it. */
  home: string;
  /** Extra child env (PATH stubs, ...). It may not name where state lives or which server to join (stateRoutingName: HOME, XDG_*,
   *  TMUX*, HC_*, OPENRIG_*, RIGGED_*, CODEX_HOME, CLAUDE_CONFIG_DIR): those are refused, and the helper's own values win anyway. */
  env?: Record<string, string | undefined>;
  /** A private hc core for this daemon (its socket, which must lie under `home`): the one way to give a test daemon an hc core. */
  privateHcSocket?: string;
  /** Extra node arguments before the entrypoint (after `--import tsx`). */
  nodeArgs?: string[];
  /** Upper bound on one attempt becoming healthy. */
  readyTimeoutMs: number;
  /** Test seam: where each attempt's port comes from (default: a fresh loopback reservation). */
  portSource?: () => Promise<number>;
  /** Attempts when the port was lost between reservation and bind (EADDRINUSE). Default 4. */
  attempts?: number;
}

/** workspaces-o9o.61: the names a test daemon takes from whoever started it. Nothing here names a place where live state lives:
 *  the hc core (HC_*, XDG_RUNTIME_DIR, XDG_STATE_HOME, HOME), the tmux server (TMUX, TMUX_TMPDIR), the daemon and its files
 *  (OPENRIG_*, RIGGED_*), or a harness's own state (CODEX_HOME, CLAUDE_CONFIG_DIR). The old helper spread process.env, which
 *  inside vitest had already been scrubbed (test/hermetic-env.setup.ts) but from a standalone tsx caller carried the seat's
 *  XDG_RUNTIME_DIR, and the test daemons joined the LIVE hc core (incident 2026-11-16 ~20:50Z). An allow-list, not a scrub: a name a
 *  later release starts reading is withheld until someone adds it here. */
export const TEST_DAEMON_INHERITED_ENV: readonly string[] = ["PATH", "TERM", "LANG", "LANGUAGE", "TZ", "TMPDIR", "USER", "LOGNAME"];
/** Locale names (LC_ALL, LC_CTYPE, ...) are inherited by prefix. */
const INHERITED_ENV_PREFIX = "LC_";

/** The whole env of a test daemon: the allow-listed names from `parent`, then every location under `opts.home` (a caller's
 *  `opts.env` may name another on purpose, e.g. a private hc core's HC_SOCKET), then the pinned bind and home names. */
/** A name that says where a process keeps state or which server it joins: the hc core (HC_*, XDG_RUNTIME_DIR, XDG_STATE_HOME,
 *  HOME), tmux (TMUX, TMUX_TMPDIR), the daemon and its files (OPENRIG_*, RIGGED_*), a harness's home (CODEX_HOME,
 *  CLAUDE_CONFIG_DIR) and the other XDG locations. A test daemon gets these only from the helper (review of f56e9f131: an opts.env
 *  spread after the private values put the live ones back). */
export function stateRoutingName(name: string): boolean {
  return name === "HOME" || name === "TMUX" || name === "TMUX_TMPDIR" || name === "CODEX_HOME" || name === "CLAUDE_CONFIG_DIR"
    || ["XDG_", "HC_", "OPENRIG_", "RIGGED_"].some((prefix) => name.startsWith(prefix));
}

/** Whether `socket` is a canonical path inside `home`, the strict rule (Jim, 2026-11-17, after three review rounds): absolute;
 *  normalized (no `.` or `..` segment, which a lexical resolve would cancel across a symlink); its folder's real path equal to
 *  the folder as given (no symlinked component); that folder inside the home's real path; and the socket itself, if it exists,
 *  not a link. Anything that cannot be proved is a refusal. */
function canonicalSocketUnder(socket: string, home: string): boolean {
  if (!path.isAbsolute(socket) || path.normalize(socket) !== socket) return false;
  if (socket.split(path.sep).some((segment) => segment === "." || segment === "..")) return false;
  const folder = path.dirname(socket);
  let realFolder: string;
  let realHome: string;
  try {
    realFolder = fs.realpathSync(folder);
    realHome = fs.realpathSync(home);
  } catch {
    return false;
  }
  if (realFolder !== folder) return false;
  if (folder !== realHome && !folder.startsWith(realHome + path.sep)) return false;
  try {
    if (fs.lstatSync(socket).isSymbolicLink()) return false;
  } catch (error) {
    // Only ENOENT means "not there yet" (the daemon's core makes it); any other error leaves it unproven, so it is a refusal.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  return true;
}

/** The allow-listed names of `parent` (TEST_DAEMON_INHERITED_ENV and LC_*), and nothing else. Shared by every test helper that
 *  starts a daemon, CLI or seat from a caller's env (testDaemonEnv here; prepareHermeticEnv's scaffold, workspaces-o9o.66). */
export function inheritedTestEnv(parent: Record<string, string | undefined>): Record<string, string | undefined> {
  const kept = Object.fromEntries(Object.entries(parent).filter(([name]) =>
    TEST_DAEMON_INHERITED_ENV.includes(name) || name.startsWith(INHERITED_ENV_PREFIX)));
  // workspaces-o9o.77: never a seat's PATH head (its git worktree shim, its own rig), whoever the caller is.
  if (kept["PATH"] !== undefined) kept["PATH"] = withoutSeatPath(kept["PATH"]);
  return kept;
}

/** The HOME a test daemon on OpenRig home `home` gets: `<home>-user-home`, beside it (see testDaemonEnv). */
export function testDaemonUserHome(home: string): string {
  return `${path.resolve(home)}-user-home`;
}

export function testDaemonEnv(
  opts: Pick<SpawnDaemonEntrypointOptions, "home" | "env" | "privateHcSocket">, port: number, parent: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const routed = Object.keys(opts.env ?? {}).filter(stateRoutingName).sort();
  if (routed.length > 0) {
    throw new Error(`spawnDaemonEntrypoint: opts.env may not name ${routed.join(", ")}: a test daemon's state and servers are the `
      + "helper's (under its home). For a private hc core pass privateHcSocket.");
  }
  if (opts.privateHcSocket !== undefined && !canonicalSocketUnder(opts.privateHcSocket, opts.home)) {
    throw new Error(`spawnDaemonEntrypoint: privateHcSocket ${opts.privateHcSocket} is not under the test home ${opts.home} (it must be a canonical path, no link, inside the home's real path)`);
  }
  const inherited = inheritedTestEnv(parent);
  // The daemon's HOME is a SIBLING of its OPENRIG_HOME, never inside it: workspaces-o9o.36 refuses an OpenRig home that is the
  // user's home or above it ("expected instance-home, found user-home"), and <home>/user-home made <home> an ancestor of HOME.
  // The same naming as the vitest setup's fixture homes. spawnDaemonEntrypoint removes it when its daemon exits.
  const userHome = testDaemonUserHome(opts.home);
  return {
    ...inherited,
    ...opts.env,
    // Pinned after opts.env, so nothing a caller passes can route the daemon (the refusal above already names any attempt).
    HOME: userHome,
    XDG_CONFIG_HOME: path.join(userHome, ".config"),
    XDG_STATE_HOME: path.join(userHome, ".local", "state"),
    XDG_DATA_HOME: path.join(userHome, ".local", "share"),
    XDG_CACHE_HOME: path.join(userHome, ".cache"),
    // tmux's default server is <TMUX_TMPDIR or /tmp>/tmux-<uid>/default: with nothing set it is the operator's own.
    TMUX_TMPDIR: path.join(opts.home, "tmux"),
    // tmux and seat panes start in $SHELL; the operator's (zsh with no startup files in this HOME) runs its first-use wizard.
    SHELL: "/bin/bash",
    // A test daemon never starts an hc core under its scratch HOME and leaves it behind (as test/hermetic-env.setup.ts sets for
    // in-process daemons).
    OPENRIG_HC_NO_START_CORE: "1",
    ...(opts.privateHcSocket !== undefined ? { HC_SOCKET: opts.privateHcSocket } : {}),
    OPENRIG_NO_KERNEL: "1",
    OPENRIG_HOME: opts.home,
    OPENRIG_DB: path.join(opts.home, "openrig.sqlite"),
    OPENRIG_PORT: String(port),
    OPENRIG_URL: "",
    OPENRIG_BIND_HOST: TEST_DAEMON_BIND_HOST,
  };
}

async function waitHealthy(port: number, child: ChildProcess, stderr: () => string, timeoutMs: number): Promise<"ready" | "exited"> {
  let exited = child.exitCode !== null || child.signalCode !== null;
  child.once("exit", () => { exited = true; });
  const bound = waitBound(timeoutMs);
  while (!bound.expired()) {
    if (exited) return "exited";
    try {
      const res = await fetch(`http://${TEST_DAEMON_BIND_HOST}:${port}/healthz`, { signal: AbortSignal.timeout(2_000) });
      if (res.status === 200) return "ready";
    } catch {
      // not up yet, or something else holds the port and never answers (a lost race): the loop re-checks the child's exit
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw waitTimedOut(`daemon never became healthy: ${stderr()}`, bound);
}

/** Start the production entrypoint on a private home, bound to loopback only, and wait for /healthz. */
export async function spawnDaemonEntrypoint(opts: SpawnDaemonEntrypointOptions): Promise<EntrypointDaemon> {
  const attempts = opts.attempts ?? 4;
  let lastStderr = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const port = await (opts.portSource ?? getFreeLoopbackPort)();
    const env = testDaemonEnv(opts, port);
    // The daemon changes into HOME at start, so the private one must exist. It is the helper's own (beside the caller's home, which
    // the caller removes), so it goes when the daemon exits.
    fs.mkdirSync(env["HOME"]!, { recursive: true });
    const child = spawn(process.execPath, ["--import", "tsx", ...(opts.nodeArgs ?? []), DAEMON_ENTRYPOINT], {
      env: env as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    USER_HOMES.set(child, env["HOME"]!);
    child.once("exit", () => fs.rmSync(env["HOME"]!, { recursive: true, force: true }));
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

/** Each test daemon's private HOME (testDaemonUserHome), removed by killIfRunning and when the daemon exits. */
const USER_HOMES = new WeakMap<ChildProcess, string>();

/** Terminate a spawned daemon: SIGKILL only a child that is still running. Its private HOME goes now, not only when the exit is
 *  seen: a test file can end before that event arrives, and the HOME is beside the caller's own temp folder. */
export function killIfRunning(child: ChildProcess): void {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  const userHome = USER_HOMES.get(child);
  if (userHome !== undefined) fs.rmSync(userHome, { recursive: true, force: true });
}
