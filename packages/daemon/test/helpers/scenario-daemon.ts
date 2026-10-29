/**
 * Slice 51-02 (L2 test-system) — the forced-local scenario daemon lifecycle.
 *
 * The hermetic helper SPAWNS a real scenario-local daemon via the shipped `rig`
 * bin under the scrubbed scratch env, and the runner drives it with real
 * `rig … --json` subprocesses. This proves the env-discipline at a real process
 * boundary (a direct in-process method call would not be a transport proof) and
 * makes the assertions read exactly what a user/agent observes (product-is-truth).
 *
 * The `rig` bin is a SINGLE injectable seam (`rigBin`) so 51-04 container-mode can
 * point it at the container's installed `rig` without touching this host-mode
 * contract.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { assertNoForeignDaemon, type HermeticScaffold } from "./hermetic-env.js";
import {
  hasEnvEntry, hasProcFs, identityOf, listenerPids, pidsWithEnv, reapWhenOwnerDies, startedAtMs, stopOwnedTmuxServer, terminateIdentified,
  waitNotSame, type ProcessIdentity,
} from "./orphan-reaper.js";

export interface RigResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** A running scenario-local daemon + how to read it + how to tear it down. */
export interface ScenarioDaemon {
  /** The ephemeral port the daemon is listening on. */
  port: number;
  /** http://127.0.0.1:<port> */
  baseUrl: string;
  /**
   * Environment for shipped read/write subprocesses: the scaffold's scrubbed
   * scratch env with OPENRIG_URL pointed at THIS daemon (the helper's own — not a
   * foreign target).
   */
  readEnv: Record<string, string | undefined>;
  /**
   * SIGTERM the scenario-local daemon (the `daemon: {op: sigterm}` verb) — kills
   * it via the shipped `rig daemon stop`; the scaffold is KEPT so a restart can
   * re-spawn through the same guarantees. Idempotent.
   */
  sigterm: () => Promise<void>;
  /**
   * Restart the scenario-local daemon (the `daemon: {op: restart}` verb) — ensures
   * it is down, then RE-SPAWNS on the same port/db/scratch env, i.e. through the
   * SAME forced-local/scratch/fail-closed guarantees (single owner, no second
   * lifecycle path). Distinct from a seat-level restart, which never touches it.
   */
  restart: () => Promise<void>;
  /** Stop the daemon (via the shipped `rig daemon stop`) and remove the scaffold. */
  stop: () => Promise<void>;
  /**
   * L6 STEP-0 — translate a HOST topology path to a path the daemon can read. Host-mode omits this
   * (identity: the daemon reads the host path directly). CONTAINER-mode implements it by staging the
   * topology's directory INTO the container and returning the in-container path, so `rig up` is never
   * handed a host-absolute path a container daemon cannot resolve ("Source not found").
   */
  stageTopology?: (hostTopologyPath: string) => Promise<string>;
}

export interface SpawnScenarioDaemonOptions {
  /** Path to the shipped `rig` bin (the single injectable invocation seam). */
  rigBin: string;
  /** Override the port (default: an ephemeral free port). */
  port?: number;
  /** Per-invocation timeout for `rig` subprocesses (ms). */
  timeoutMs?: number;
  /** How long `stop()` waits for the daemon to exit after `rig daemon stop`, and again after each signal it then sends (ms). */
  stopGraceMs?: number;
}

/** Reserve an ephemeral free port on 127.0.0.1 (closed immediately; best-effort). */
export function findFreePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = net.createServer();
    srv.once("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? res(port) : rej(new Error("could not reserve a free port"))));
    });
  });
}

/** Invoke `node <rigBin> <args...>` with the given env. Never rejects — returns the exit code. */
export function runRig(
  args: string[],
  env: Record<string, string | undefined>,
  rigBin: string,
  timeoutMs = 30_000,
): Promise<RigResult> {
  // execFile replaces the environment wholesale — drop undefined values so a
  // scrubbed (deleted) var never leaks back in as the literal string "undefined".
  const cleanEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) cleanEnv[k] = v;
  return new Promise((resolve) => {
    execFile(
      "node",
      [rigBin, ...args],
      { env: cleanEnv, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as NodeJS.ErrnoException & { code?: number }).code === "number"
            ? ((err as unknown as { code: number }).code)
            : err
              ? 1
              : 0;
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code });
      },
    );
  });
}

/**
 * Spawn a real forced-local scenario daemon under the hermetic scaffold. The
 * shipped `rig daemon start` waits for its own /healthz before returning, so a
 * zero exit means the daemon is accepting requests. Throws (fail-closed) if the
 * scaffold env still carries a foreign daemon target, or if start fails.
 */
export async function spawnScenarioDaemon(
  scaffold: HermeticScaffold,
  opts: SpawnScenarioDaemonOptions,
): Promise<ScenarioDaemon> {
  const { rigBin, timeoutMs } = opts;
  const stopGraceMs = opts.stopGraceMs ?? 15_000;
  // `rigBin` is a node script run as `node <rigBin>`: when the CLI has not been built it is absent, and the
  // only symptom would be a node "Cannot find module" buried inside "scenario-local daemon failed to start".
  if (!existsSync(rigBin)) {
    throw new Error(
      `the rig CLI is not built: ${rigBin} does not exist. Build it first (npm run build -w packages/cli); the daemon scenario/integration tests spawn the real CLI.`,
    );
  }

  // Defense in depth: the scaffold env is already scrubbed, but never spawn
  // against a foreign target.
  assertNoForeignDaemon(scaffold.env);

  const port = opts.port ?? (await findFreePort());
  const db = join(scaffold.stateDir, "scenario.db");

  // Every `rig daemon start|stop` this helper runs is recorded as a time window: the daemon (or a replacement it brings up)
  // can only have been started inside one of them, so a process found later that started outside every window is not ours,
  // whatever daemon.json or the port says (a stale daemon.json naming a reused pid; another process on the port).
  const windows: Array<{ from: number; to: number }> = [];
  const cli = async (args: string[]): Promise<RigResult> => {
    const window = { from: Date.now(), to: Number.POSITIVE_INFINITY };
    windows.push(window);
    try { return await runRig(args, scaffold.env, rigBin, timeoutMs); } finally { window.to = Date.now(); }
  };
  // Listeners found on the port BEFORE a start are someone else's: refused and never signalled.
  const foreign = new Set<number>();

  // The single start path — reused by initial spawn AND by restart, so a restart
  // re-spawns through EXACTLY the same forced-local/scratch/fail-closed guarantees.
  const startProc = async () => {
    const occupied = listenerPids(port);
    if (occupied.length > 0) {
      for (const pid of occupied) foreign.add(pid);
      throw new Error(
        `port ${port} already has a listener this helper did not start (pid ${occupied.join(", ")}); refusing to start the scenario daemon there (that process is never signalled)`,
      );
    }
    const start = await cli(["daemon", "start", "--port", String(port), "--db", db, "--no-kernel"]);
    if (start.code !== 0) {
      throw new Error(
        `scenario-local daemon failed to start (exit ${start.code}) on port ${port}: ${start.stderr || start.stdout}`,
      );
    }
  };
  // The daemon is detached by `rig daemon start`, so it outlives this runner. Everything that signals it goes through a
  // RECORDED identity (pid + start time + command, verified before every signal; see orphan-reaper.ts), never through a bare
  // pid from daemon.json and never through another process's environment (unreadable on macOS). The daemon is found by two
  // independent routes, the pid in this scaffold's private daemon.json and the listener on the port chosen for it, each kept
  // only if the process started inside one of this helper's own `rig daemon` calls (`windows`), was not on the port before
  // a start (`foreign`), and, when the port is its only witness, carries this scaffold's OPENRIG_HOME (Linux, where that can
  // be read). On Linux the watchdog is also armed BEFORE `rig daemon start` with the scaffold's private OPENRIG_HOME, so a
  // worker that dies mid-start still gets its daemon reaped; on macOS that window has no identity to go on yet, and a
  // process that binds the port during one of the helper's own calls is not told apart from the daemon (both reported, not
  // hidden).
  const homeEntry = `OPENRIG_HOME=${scaffold.openrigHome}`;
  // Bounds for stopping the scaffold's tmux server: each tmux command gets at least 5 s, so a loaded host is not read as a starved one.
  const tmuxStop = { commandTimeoutMs: Math.max(5_000, 2 * stopGraceMs), graceMs: stopGraceMs };
  const inWindow = (id: ProcessIdentity) => {
    // ps start times have one-second resolution: a window opens at the start of the second in which its call began.
    const startedMs = startedAtMs(id.started);
    return windows.some((w) => startedMs >= Math.floor(w.from / 1000) * 1000 && startedMs <= w.to);
  };
  const discover = (envScan: boolean): ProcessIdentity[] => {
    const named = new Set<number>(), carrying = new Set<number>();
    try {
      const pid = (JSON.parse(readFileSync(join(scaffold.openrigHome, "daemon.json"), "utf8")) as { pid?: unknown }).pid;
      if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) named.add(pid);
    } catch { /* no state file (yet) */ }
    const listening = listenerPids(port);
    // Only on a failed start, when no seat or tmux server exists yet to carry the home too.
    if (envScan && hasProcFs()) for (const pid of pidsWithEnv(homeEntry)) carrying.add(pid);
    const found: ProcessIdentity[] = [];
    for (const pid of new Set([...named, ...listening, ...carrying])) {
      if (foreign.has(pid)) continue;
      // A port is the weakest witness: another process can bind the port the helper picked and released.
      if (!named.has(pid) && !carrying.has(pid) && hasProcFs() && !hasEnvEntry(pid, homeEntry)) continue;
      const id = identityOf(pid);
      if (id !== null && inWindow(id)) found.push(id);
    }
    return found;
  };
  let current: ProcessIdentity[] = [];
  const armWith = (identities: ProcessIdentity[]) => reapWhenOwnerDies({
    tmuxSockets: [scaffold.tmuxSocketPath], identities, environ: hasProcFs() ? [homeEntry] : [], label: "scenario-daemon",
  });
  let reaper = armWith([]);
  const rearm = (identities: ProcessIdentity[]) => { const old = reaper; reaper = armWith(identities); old.disarm(); };
  const startRecorded = async () => {
    try {
      await startProc();
      current = discover(false);
      if (current.length === 0) throw new Error(`the daemon started on port ${port} but cannot be identified (no live process in daemon.json or listening there); refusing to continue without a reapable identity`);
    } catch (error) {
      // The CLI may have detached the daemon before failing or timing out: stop whatever it left, then say so.
      let holders: ProcessIdentity[] = [];
      try { holders = discover(true); } catch (discoveryError) {
        throw new Error(`${(error as Error).message}; and the leftover daemon could not be looked for: ${(discoveryError as Error).message}`);
      }
      const survivors = await terminateIdentified(holders, stopGraceMs);
      current = [];
      // The daemon starts the scaffold's tmux server at boot (an empty `tmux -D`), so a start that failed after that has
      // left one: stop it too. Disarm only when nothing survived and that server is verified gone; otherwise the watchdog
      // stays armed on the survivors and the socket.
      let tmuxLeft = "";
      try { await stopOwnedTmuxServer(scaffold.tmuxSocketPath, scaffold.tmuxEnv, tmuxStop); } catch (tmuxError) {
        tmuxLeft = `; and the scaffold's tmux server could not be verified stopped: ${(tmuxError as Error).message}`;
      }
      if (survivors.length === 0 && tmuxLeft === "") reaper.disarm(); else rearm(survivors);
      if (tmuxLeft !== "") throw new Error(`${(error as Error).message}${tmuxLeft}`);
      throw error;
    }
    rearm(current);
  };
  const killProc = async () => {
    // `rig daemon stop` reads daemon.json under the scratch OPENRIG_HOME and
    // SIGTERMs the daemon. Best-effort (already-down is fine), but the daemon must really be gone before the
    // scaffold (and the daemon.json that names it) can be deleted: a swallowed stop failure leaked it.
    const known = [...current];
    await cli(["daemon", "stop"]);
    await waitNotSame(known, stopGraceMs);
    await terminateIdentified(known, stopGraceMs);
  };

  await startRecorded();

  const baseUrl = `http://127.0.0.1:${port}`;
  const readEnv: Record<string, string | undefined> = { ...scaffold.env, OPENRIG_URL: baseUrl };

  return {
    port,
    baseUrl,
    readEnv,
    sigterm: killProc,
    restart: async () => {
      await killProc();
      await startRecorded();
    },
    stop: async () => {
      await killProc();
      // Verify against what is found NOW (daemon.json and the port, not only what was recorded at start, but only processes
      // started inside one of this helper's own calls): a daemon that is still alive keeps the scaffold and the watchdog.
      const left = await terminateIdentified(discover(false), stopGraceMs);
      if (left.length > 0) {
        rearm(left);
        throw new Error(`the scenario daemon (pid ${left.map((l) => l.pid).join(", ")}) is still alive after stop; scaffold and watchdog kept`);
      }
      // The daemon's tmux server (seats, and the empty `tmux -D` it starts at boot) is verified gone BEFORE the watchdog is
      // disarmed: a server that cannot be verified stopped keeps the watchdog and the scaffold.
      await stopOwnedTmuxServer(scaffold.tmuxSocketPath, scaffold.tmuxEnv, tmuxStop);
      reaper.disarm();
      scaffold.cleanup();
    },
  };
}
