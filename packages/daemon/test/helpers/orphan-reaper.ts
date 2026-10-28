import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * A test that starts a process which outlives the test runner (a tmux server, a daemon the CLI detaches) must not rely on
 * its own teardown alone: a vitest timeout, a killed worker or a swallowed stop failure never reaches it, and the process
 * then runs for days after its temp home is deleted.
 *
 * IDENTITY. A pid alone is not an identity (it can be stale or reused), and another process's environment cannot be read on
 * every platform (macOS `ps -E` shows none for a same-user process). So a process the test means to stop is RECORDED when
 * it is found: its pid, its start time and its command line (`ps -o lstart=`, `ps -o command=`: the same on Linux and macOS).
 * Every signal is preceded by a check that all three still match; a pid that now belongs to something else is left alone.
 * tmux servers are identified by their explicit private socket path instead.
 *
 * `reapWhenOwnerDies` starts a tiny detached watchdog that waits for the OWNER (the test worker) to die and then stops the
 * recorded identities and the tmux servers on the listed sockets. `disarm()` removes it once the test's own teardown has run
 * and VERIFIED the stop.
 */
export interface ProcessIdentity { pid: number; started: string; command: string }

export interface OrphanReaperTargets {
  /** tmux servers this test started, by explicit socket path. */
  tmuxSockets?: string[];
  /** Processes recorded with `identityOf`; stopped only while pid, start time and command all still match. */
  identities?: ProcessIdentity[];
  /**
   * Linux only (it reads /proc/<pid>/environ): exact `NAME=value` entries that only this test's processes carry. Covers a
   * window in which no identity is known yet (a `rig daemon start` still running). Refused loudly where /proc is absent.
   */
  environ?: string[];
  /** The process whose death triggers the reaping; default: this process. */
  ownerPid?: number;
}

export const hasProcFs = (): boolean => existsSync("/proc/self/environ");

/** The recorded identity of a live process, or null when there is none (gone, or ps cannot say). */
export function identityOf(pid: number): ProcessIdentity | null {
  try {
    const started = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim();
    const command = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim();
    return started === "" || command === "" ? null : { pid, started, command };
  } catch { return null; }
}

export const processAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

/** Still the recorded process: alive, and the same start time and command (so not a reused pid). */
export function sameProcess(id: ProcessIdentity): boolean {
  if (!processAlive(id.pid)) return false;
  const now = identityOf(id.pid);
  return now !== null && now.started === id.started && now.command === id.command;
}

/** Epoch ms of a `ps lstart` string (second resolution, local time). */
export const startedAtMs = (lstart: string): number => Date.parse(lstart);

/** Pids listening on a TCP port (lsof; present on Linux and macOS). Throws if it cannot be asked: never "none" by default. */
export function listenerPids(port: number): number[] {
  try {
    const out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
    return out.split("\n").filter((l) => /^\d+$/.test(l.trim())).map(Number);
  } catch (error) {
    const e = error as { status?: number; code?: string };
    if (e.status === 1) return []; // lsof's own "nothing found"
    throw new Error(`cannot discover the listener on port ${port}: ${e.code ?? `lsof exit ${e.status}`}`);
  }
}

const WATCHDOG = `owner=$1; shift
while kill -0 "$owner" 2>/dev/null; do sleep 1; done
same() { [ "$(ps -o lstart= -p "$1" 2>/dev/null | sed 's/^ *//;s/ *$//')" = "$2" ] && [ "$(ps -o command= -p "$1" 2>/dev/null | sed 's/^ *//;s/ *$//')" = "$3" ]; }
holders() {
  for e in /proc/[0-9]*/environ; do
    p=\${e#/proc/}; p=\${p%/environ}
    [ "$p" = "$$" ] && continue
    tr '\\0' '\\n' < "$e" 2>/dev/null | grep -qxF -- "$1" && echo "$p"
  done
}
sweep() {
  sig=$1; shift
  while [ $# -gt 0 ]; do
    case "$1" in
      tmux) [ "$sig" = TERM ] && tmux -S "$2" kill-server 2>/dev/null; shift 2 ;;
      env) for p in $(holders "$2"); do kill -$sig "$p" 2>/dev/null; done; shift 2 ;;
      pid) if same "$2" "$3" "$4"; then kill -$sig "$2" 2>/dev/null; fi; shift 4 ;;
      *) shift ;;
    esac
  done
}
sweep TERM "$@"
sleep 3
sweep KILL "$@"
`;

export function reapWhenOwnerDies(targets: OrphanReaperTargets): { disarm: () => void; pid: number } {
  if ((targets.environ?.length ?? 0) > 0 && !hasProcFs()) {
    throw new Error("environ-based reaping needs /proc (Linux); on this platform record process identities instead");
  }
  const args = [
    ...(targets.tmuxSockets ?? []).flatMap((socket) => ["tmux", socket]),
    ...(targets.environ ?? []).flatMap((entry) => ["env", entry]),
    ...(targets.identities ?? []).flatMap((id) => ["pid", String(id.pid), id.started, id.command]),
  ];
  const child = spawn("/bin/sh", ["-c", WATCHDOG, "reaper", String(targets.ownerPid ?? process.pid), ...args], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  const pid = child.pid;
  if (pid === undefined) throw new Error("could not start the orphan reaper");
  return {
    pid,
    disarm: () => { try { process.kill(-pid, "SIGKILL"); } catch { /* already finished */ } },
  };
}

/** Linux only: processes whose environment holds exactly `entry`. */
export function pidsWithEnv(entry: string): number[] {
  if (!hasProcFs()) throw new Error("pidsWithEnv needs /proc (Linux)");
  const found: number[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      if (readFileSync(`/proc/${name}/environ`, "utf8").split("\0").includes(entry)) found.push(Number(name));
    } catch { /* gone, or not ours to read */ }
  }
  return found;
}

export async function waitGone(pid: number, withinMs: number): Promise<boolean> {
  const until = Date.now() + withinMs;
  while (processAlive(pid)) {
    if (Date.now() > until) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

export async function waitNotSame(ids: ProcessIdentity[], withinMs: number): Promise<void> {
  const until = Date.now() + withinMs;
  while (ids.some(sameProcess) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 25));
}

/**
 * TERM, then KILL, each followed by `graceMs` of waiting, for recorded identities: a signal goes to a pid only while that
 * pid is still the recorded process. Returns the identities that are STILL the recorded process afterwards (survivors).
 */
export async function terminateIdentified(ids: ProcessIdentity[], graceMs: number): Promise<ProcessIdentity[]> {
  for (const id of ids) if (sameProcess(id)) { try { process.kill(id.pid, "SIGTERM"); } catch { /* gone */ } }
  await waitNotSame(ids, graceMs);
  for (const id of ids) if (sameProcess(id)) { try { process.kill(id.pid, "SIGKILL"); } catch { /* gone */ } }
  await waitNotSame(ids, graceMs);
  return ids.filter(sameProcess);
}

const NO_SERVER = /no server running|error connecting to|no such file or directory|failed to connect/i;

export interface TmuxCallResult { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean }

/**
 * Run one tmux client command with a HARD bound. `execFile`'s timeout is not enough against a stopped (SIGSTOPped) server:
 * a tmux client hands its stdout/stderr descriptors to the server, so while the server is stopped the pipes never close and
 * `execFile` never calls back (measured on macOS: the test hung to its 60 s limit), and a SIGTERMed client exits 0 as if
 * it had succeeded. Here the client gets stdio it can pass on without consequence being waited for: the call settles on the
 * client's own `exit` (after a brief drain), a timeout SIGKILLs the client and is reported as `timedOut`, and the pipes are
 * destroyed rather than awaited.
 */
export function tmuxCall(args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<TmuxCallResult> {
  return new Promise((resolve) => {
    let client: ChildProcess;
    let stdout = "", stderr = "", timedOut = false, settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.stdout?.destroy();
      client.stderr?.destroy();
      resolve({ code, signal, stdout, stderr, timedOut });
    };
    client = spawn("tmux", args, { env, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => { timedOut = true; try { client.kill("SIGKILL"); } catch { /* gone */ } }, timeoutMs);
    client.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    client.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    client.once("error", (error) => { stderr += error.message; finish(null, null); });
    client.once("exit", (code, signal) => { setTimeout(() => finish(code, signal), 50); });
  });
}

export interface TmuxStopOptions {
  /** The server's pid recorded when it was started (see `tmuxServerPid`); looked up if absent. */
  pid?: number;
  /** Bound on each tmux command (default 30 s). */
  commandTimeoutMs?: number;
  /** How long to wait for the server to exit after `kill-server`, and again after SIGKILL (default 15 s). */
  graceMs?: number;
}

/**
 * The pid of the tmux server on `socket`: null only when tmux positively says there is none. A timeout or any other failure
 * (a starved server) is retried and then THROWN, never read as "no server": a caller that deletes the socket directory on a
 * silent "nothing to stop" orphans the live server.
 */
export async function tmuxServerPid(socket: string, env: NodeJS.ProcessEnv, commandTimeoutMs = 30_000): Promise<number | null> {
  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await tmuxCall(["-S", socket, "display-message", "-p", "#{pid}"], env, commandTimeoutMs);
    const out = r.stdout.trim();
    if (!r.timedOut && r.code === 0 && /^\d+$/.test(out)) return Number(out);
    if (!r.timedOut && r.code !== 0 && NO_SERVER.test(r.stderr)) return null; // tmux positively says there is no server
    last = r.timedOut ? `no answer within ${commandTimeoutMs} ms` : `exit ${r.code ?? r.signal}: ${(r.stderr || out).split("\n")[0]}`;
  }
  throw new Error(`the tmux server on ${socket} could not be located, so it cannot be verified stopped: ${last}`);
}

/**
 * Stop the tmux server this test started on `socket` and prove it is gone, or throw: the caller must then keep its watchdog
 * armed and its socket directory in place. `kill-server` gets a bound; a server still alive after it is SIGKILLed by the
 * pid (checked first to still be a tmux holding this socket).
 */
export async function stopOwnedTmuxServer(socket: string, env: NodeJS.ProcessEnv, options: TmuxStopOptions = {}): Promise<void> {
  const commandTimeoutMs = options.commandTimeoutMs ?? 30_000, graceMs = options.graceMs ?? 15_000;
  const pid = options.pid ?? await tmuxServerPid(socket, env, commandTimeoutMs);
  if (pid === null) return;
  if (!processAlive(pid)) return;
  await tmuxCall(["-S", socket, "kill-server"], env, commandTimeoutMs);
  if (await waitGone(pid, graceMs)) return;
  const command = await run("ps", ["-o", "command=", "-p", String(pid)]).then((r) => r.stdout, () => "");
  if (command !== "" && !command.includes(socket)) return; // the pid was reused by something that is not our tmux server
  try { process.kill(pid, "SIGKILL"); } catch { /* gone meanwhile */ }
  if (!(await waitGone(pid, graceMs))) throw new Error(`the tmux server (pid ${pid}) on ${socket} is still alive after SIGKILL`);
}
