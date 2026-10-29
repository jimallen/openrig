import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

/**
 * A test that starts a process which outlives the test runner (a tmux server, a daemon the CLI detaches) must not rely on
 * its own teardown alone: a vitest timeout, a killed worker or a swallowed stop failure never reaches it, and the process
 * then runs for days after its temp home is deleted.
 *
 * IDENTITY. A pid alone is not an identity (it can be stale or reused), and another process's environment cannot be read on
 * every platform (macOS `ps -E` shows none for a same-user process). So a process the test means to stop is RECORDED when
 * it is found: its pid, its start time and its command line (`ps -o lstart=`, `ps -o command=`: the same on Linux and macOS).
 * Every signal is preceded by a check that all three still match; a pid that now belongs to something else is left alone.
 * tmux servers are found through an explicit `-S` socket in a directory the test created (never tmux's shared per-user
 * directory, see `assertOwnedTmuxSocket`), and the server found there is recorded and checked the same way before a signal.
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
  /** Names the watchdog in its argument list (`reaper:<label>`), so a test can tell one helper's watchdog from another's. */
  label?: string;
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

// `kill-server` runs in the background: against a stopped (starved) server the client never returns, and a watchdog waiting
// on it would never reach the targets after it. The last line ends the watchdog's own process group (it was spawned detached,
// so the group holds only the watchdog and its children), which also ends any such client still waiting.
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
      tmux) if [ "$sig" = TERM ]; then tmux -S "$2" kill-server >/dev/null 2>&1 & fi; shift 2 ;;
      env) for p in $(holders "$2"); do kill -$sig "$p" 2>/dev/null; done; shift 2 ;;
      pid) if same "$2" "$3" "$4"; then kill -$sig "$2" 2>/dev/null; fi; shift 4 ;;
      *) shift ;;
    esac
  done
}
sweep TERM "$@"
sleep 3
sweep KILL "$@"
kill -KILL 0
`;

export function reapWhenOwnerDies(targets: OrphanReaperTargets): { disarm: () => void; pid: number } {
  for (const socket of targets.tmuxSockets ?? []) assertOwnedTmuxSocket(socket);
  if ((targets.environ?.length ?? 0) > 0 && !hasProcFs()) {
    throw new Error("environ-based reaping needs /proc (Linux); on this platform record process identities instead");
  }
  const args = [
    ...(targets.tmuxSockets ?? []).flatMap((socket) => ["tmux", socket]),
    ...(targets.environ ?? []).flatMap((entry) => ["env", entry]),
    ...(targets.identities ?? []).flatMap((id) => ["pid", String(id.pid), id.started, id.command]),
  ];
  const child = spawn("/bin/sh", ["-c", WATCHDOG, `reaper:${targets.label ?? "test"}`, String(targets.ownerPid ?? process.pid), ...args], {
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

/** Linux only: whether process `pid` holds exactly `entry` in its environment (false when it cannot be read). */
export function hasEnvEntry(pid: number, entry: string): boolean {
  if (!hasProcFs()) throw new Error("hasEnvEntry needs /proc (Linux)");
  try { return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(entry); } catch { return false; }
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

/**
 * `tmuxCall`, synchronously, for teardown that cannot await (the hermetic scaffold's `cleanup()`). The client writes into
 * files, not pipes: a client of a stopped server hands its descriptors to that server, and a synchronous spawn would wait on
 * pipes that never close. A timeout SIGKILLs the client and is reported as `timedOut`.
 */
export function tmuxCallSync(args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): TmuxCallResult {
  const dir = mkdtempSync(join(tmpdir(), "tmux-call-"));
  const outPath = join(dir, "out"), errPath = join(dir, "err");
  const out = openSync(outPath, "w"), err = openSync(errPath, "w");
  try {
    const r = spawnSync("tmux", args, { env, stdio: ["ignore", out, err], timeout: timeoutMs, killSignal: "SIGKILL" });
    const failure: NodeJS.ErrnoException | undefined = r.error;
    const timedOut = failure?.code === "ETIMEDOUT";
    const stderr = readFileSync(errPath, "utf8") + (failure && !timedOut ? failure.message : "");
    return { code: r.status, signal: r.signal, stdout: readFileSync(outPath, "utf8"), stderr, timedOut };
  } finally {
    closeSync(out);
    closeSync(err);
    rmSync(dir, { recursive: true, force: true });
  }
}

const realpathOr = (p: string): string => { try { return realpathSync(p); } catch { return p; } };

/**
 * tmux's shared per-user socket directories, taken from this process's environment when the module loads (before any test
 * stubs it): the default server and every run's `-L` servers live there, so no test owns a socket in them.
 */
const SHARED_TMUX_DIRS: ReadonlySet<string> = new Set(
  ["/tmp", tmpdir(), process.env.TMUX_TMPDIR ?? ""].filter((base) => base !== "")
    .map((base) => join(realpathOr(base), `tmux-${process.getuid?.() ?? 0}`)),
);

/**
 * Refuse, before any tmux command is sent, a socket a test must never stop: a `-L` name or a relative path (tmux resolves
 * those in a shared directory), or any socket in tmux's shared per-user directory. An owned socket is an explicit `-S` path
 * inside a directory the test created.
 */
export function assertOwnedTmuxSocket(socket: string): void {
  if (!isAbsolute(socket)) {
    throw new Error(`refusing to stop tmux on "${socket}": not an absolute -S path (a -L name or a relative path selects a shared socket directory)`);
  }
  const dir = realpathOr(dirname(socket));
  if (SHARED_TMUX_DIRS.has(dir)) {
    throw new Error(`refusing to stop tmux on ${socket}: ${dir} is tmux's shared per-user socket directory (the default server and other runs' -L servers), not one this test created`);
  }
}

/**
 * The explicit socket of the default server a test starts with `TMUX_TMPDIR` pointed at its own directory: tmux's rule is
 * `<realpath of TMUX_TMPDIR>/tmux-<uid>/default` (pinned against tmux's own `#{socket_path}` in orphan-reaper.test.ts).
 */
export const ownedDefaultSocket = (tmuxTmpDir: string): string =>
  join(realpathSync(tmuxTmpDir), `tmux-${process.getuid?.() ?? 0}`, "default");

type PidAnswer = { pid: number } | { absent: true } | { unknown: string };

/** One `display-message -p #{pid}` answer: the pid, a positive "no server", or anything else (never read as "none"). */
function pidAnswer(r: TmuxCallResult, commandTimeoutMs: number): PidAnswer {
  const out = r.stdout.trim();
  if (!r.timedOut && r.code === 0 && /^\d+$/.test(out)) return { pid: Number(out) };
  if (!r.timedOut && r.code !== 0 && NO_SERVER.test(r.stderr)) return { absent: true };
  return { unknown: r.timedOut ? `no answer within ${commandTimeoutMs} ms` : `exit ${r.code ?? r.signal}: ${(r.stderr || out).split("\n")[0]}` };
}

const pidLookupFailed = (socket: string, last: string) =>
  new Error(`the tmux server on ${socket} could not be located, so it cannot be verified stopped: ${last}`);

/**
 * The pid of the tmux server on `socket`: null only when tmux positively says there is none. A timeout or any other failure
 * (a starved server) is retried and then THROWN, never read as "no server": a caller that deletes the socket directory on a
 * silent "nothing to stop" orphans the live server.
 */
export async function tmuxServerPid(socket: string, env: NodeJS.ProcessEnv, commandTimeoutMs = 30_000): Promise<number | null> {
  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const a = pidAnswer(await tmuxCall(["-S", socket, "display-message", "-p", "#{pid}"], env, commandTimeoutMs), commandTimeoutMs);
    if ("pid" in a) return a.pid;
    if ("absent" in a) return null;
    last = a.unknown;
  }
  throw pidLookupFailed(socket, last);
}

/** `tmuxServerPid`, synchronously. */
export function tmuxServerPidSync(socket: string, env: NodeJS.ProcessEnv, commandTimeoutMs = 30_000): number | null {
  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const a = pidAnswer(tmuxCallSync(["-S", socket, "display-message", "-p", "#{pid}"], env, commandTimeoutMs), commandTimeoutMs);
    if ("pid" in a) return a.pid;
    if ("absent" in a) return null;
    last = a.unknown;
  }
  throw pidLookupFailed(socket, last);
}

/**
 * The tmux server on an owned `socket`, as a recorded identity (pid + start time + command, see `identityOf`), or null when
 * tmux positively says there is none (or the server it named has already exited). Record it when the server starts, so a
 * later stop never signals a pid that has since been reused.
 */
export async function ownedTmuxServer(socket: string, env: NodeJS.ProcessEnv, commandTimeoutMs = 30_000): Promise<ProcessIdentity | null> {
  assertOwnedTmuxSocket(socket);
  const pid = await tmuxServerPid(socket, env, commandTimeoutMs);
  return pid === null ? null : identityOf(pid);
}

/** `ownedTmuxServer`, synchronously. */
export function ownedTmuxServerSync(socket: string, env: NodeJS.ProcessEnv, commandTimeoutMs = 30_000): ProcessIdentity | null {
  assertOwnedTmuxSocket(socket);
  const pid = tmuxServerPidSync(socket, env, commandTimeoutMs);
  return pid === null ? null : identityOf(pid);
}

export interface TmuxStopOptions {
  /** The server recorded when it was started (`ownedTmuxServer`); looked up through the socket if absent. */
  server?: ProcessIdentity;
  /** Bound on each tmux command (default 30 s). */
  commandTimeoutMs?: number;
  /** How long to wait for the server to exit after `kill-server`, and again after SIGKILL (default 15 s). */
  graceMs?: number;
}

const stillAliveAfterKill = (server: ProcessIdentity, socket: string) =>
  new Error(`the tmux server (pid ${server.pid}) on ${socket} is still alive after SIGKILL`);
const keepsAnswering = (socket: string) =>
  new Error(`a tmux server still answers on ${socket} after it was stopped three times`);

/**
 * Stop the tmux server this test started on its OWNED `socket` (an explicit `-S` path in a directory the test created; see
 * `assertOwnedTmuxSocket`) and prove it is gone, or throw: the caller must then keep its watchdog armed and its socket
 * directory in place. `kill-server` is bounded; a server still alive after it is SIGKILLed, but only while it is still the
 * recorded process (same pid, start time and command), so a reused pid is never signalled. Done only when tmux itself says
 * no server answers on the socket: a server started there after the one recorded is stopped too.
 */
export async function stopOwnedTmuxServer(socket: string, env: NodeJS.ProcessEnv, options: TmuxStopOptions = {}): Promise<void> {
  assertOwnedTmuxSocket(socket);
  const commandTimeoutMs = options.commandTimeoutMs ?? 30_000, graceMs = options.graceMs ?? 15_000;
  let server = options.server ?? await ownedTmuxServer(socket, env, commandTimeoutMs);
  for (let round = 0; round < 3; round++) {
    if (server !== null && sameProcess(server)) {
      await tmuxCall(["-S", socket, "kill-server"], env, commandTimeoutMs);
      await waitNotSame([server], graceMs);
      if (sameProcess(server)) {
        try { process.kill(server.pid, "SIGKILL"); } catch { /* gone meanwhile */ }
        await waitNotSame([server], graceMs);
        if (sameProcess(server)) throw stillAliveAfterKill(server, socket);
      }
    }
    server = await ownedTmuxServer(socket, env, commandTimeoutMs);
    if (server === null) return;
  }
  throw keepsAnswering(socket);
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function waitNotSameSync(ids: ProcessIdentity[], withinMs: number): void {
  const until = Date.now() + withinMs;
  while (ids.some(sameProcess) && Date.now() < until) sleepSync(25);
}

/** `stopOwnedTmuxServer`, synchronously, for teardown that cannot await (the same checks, the same refusals). */
export function stopOwnedTmuxServerSync(socket: string, env: NodeJS.ProcessEnv, options: TmuxStopOptions = {}): void {
  assertOwnedTmuxSocket(socket);
  const commandTimeoutMs = options.commandTimeoutMs ?? 30_000, graceMs = options.graceMs ?? 15_000;
  let server = options.server ?? ownedTmuxServerSync(socket, env, commandTimeoutMs);
  for (let round = 0; round < 3; round++) {
    if (server !== null && sameProcess(server)) {
      tmuxCallSync(["-S", socket, "kill-server"], env, commandTimeoutMs);
      waitNotSameSync([server], graceMs);
      if (sameProcess(server)) {
        try { process.kill(server.pid, "SIGKILL"); } catch { /* gone meanwhile */ }
        waitNotSameSync([server], graceMs);
        if (sameProcess(server)) throw stillAliveAfterKill(server, socket);
      }
    }
    server = ownedTmuxServerSync(socket, env, commandTimeoutMs);
    if (server === null) return;
  }
  throw keepsAnswering(socket);
}
