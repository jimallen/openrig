/**
 * A PRIVATE herdr-core (`hc`) for a test, and the refusals that keep a test from ever reaching the host's own core.
 *
 * Why this exists. After the tmux cutover the seat host is `hc`, and the "real" suites that today start a private tmux
 * server (helpers/hermetic-env.ts `tmuxSocketPath`) need a private core instead. The hazard is the same silent-retarget
 * class hermetic-env.ts kills for daemons and tmux, and it is worse here: `hc server status`, `hc schema` and `hc --skill`
 * START a core when none runs, and the default core is the one Jim's app shows, so a test whose env lost its `HC_SESSION`
 * would start or stop terminals beside his own (design-hc-cutover §6, "Shared core").
 *
 * The rules, each with a named refusal:
 *  - The env a core and its clients see is BUILT, never copied: PATH and nothing else from the caller. Its HOME, its four
 *    XDG paths and `HC_SESSION` are inside one directory this module created, and `HC_SOCKET`, `HC_TERMINAL_SOCKET`,
 *    `HC_TERMINAL_ID` and `HC_SCOPE` are absent (a seat's env carries the last three; they are scrubbed by never being
 *    copied, so this runs inside a seat too).
 *  - An AMBIENT `HC_SOCKET` in the caller's env is refused outright, before anything is created: it is an explicit
 *    redirect at a core this module did not start (`HcForeignCoreError`, zero traffic, zero filesystem side effects).
 *  - Every `hc` this module spawns goes through `assertPrivateHcEnv`, which refuses an env whose resolved socket is not
 *    inside the scratch root, whose session is empty or `default`, or whose HOME/XDG paths leave the root
 *    (`HcNotPrivateError`). The check is on the env actually handed to the child, not on the options that built it.
 *  - The socket path is measured before `hc` is asked: it refuses a path over the limit itself ("the socket path for
 *    session is too long here", usage error, exit 2, measured at 0.1.15 on Linux: 107 allowed), and the root is short
 *    (`/tmp/hcs-xxxxxx`) so a deep CI workdir cannot trip it. A too-long `baseDir` is `HcSocketTooLongError`.
 *
 * The root is registered for the end-of-run tripwire (hermetic-env.global.ts) the moment it is created: a root still on disk
 * when the run ends is a failure naming the test file that asked for it.
 *
 * Cleanup. `cleanup()` stops the core with `hc server stop`, then VERIFIES: the recorded core and holder processes are gone
 * (and, on Linux, no process anywhere still carries this scratch session's `HC_SESSION=` entry; terminal programs inherit
 * the core's env), killing only a process whose identity (pid, start time, command line) still matches. It removes the
 * root only after that; a core it cannot verify stopped keeps the root and throws. The orphan guard
 * (`reapWhenOwnerDies`, helpers/orphan-reaper.ts) is armed before the core starts and disarmed only after the verified
 * stop, so a worker that is killed or times out does not leave a core running after its temp home is deleted.
 *
 * Unmeasured here: macOS. Its socket lives in the state dir (hc-client.ts `resolveHcSocket`), its sun_path limit is 104
 * (documented by the platform, not measured against hc), and with no /proc the guard covers recorded identities only: the
 * core at start, and holders and terminals after `refreshOrphanGuard()`.
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { basename, join, relative, isAbsolute } from "node:path";
import { registerHcScratchRoot } from "../../../../test/hc-scratch-tripwire.js";
import { HcClient, resolveHcSocket } from "../../src/adapters/hc-client.js";
import {
  canSweepEnviron, hasProcFs, identityOf, pidsWithEnv, reapWhenOwnerDies, sameProcess, type ProcessIdentity,
} from "./orphan-reaper.js";

type EnvLike = Record<string, string | undefined>;

/** Vars that name a core other than the one this module starts. Presence in the caller's env is a refusal. */
export const FOREIGN_HC_CORE_ENV_VARS = ["HC_SOCKET"] as const;
/**
 * The lower of the two platform limits on a unix socket path, in bytes: Linux allows 107 (measured through hc 0.1.15's own
 * refusal), macOS 103 (sun_path is 104 with its NUL; documented, not measured). One number for both so a layout that passes
 * here passes there.
 */
export const HC_SOCKET_PATH_LIMIT = 103;

/** The env var a run sets to say where scratch cores are made (a run root, for a run that must contain everything it starts). */
export const HC_SCRATCH_ROOT_ENV = "OPENRIG_TEST_SCRATCH_ROOT";

/**
 * Where a scratch core's short root is made: the folder `OPENRIG_TEST_SCRATCH_ROOT` names when a run sets it (an absolute
 * path), else `fallback` (`/tmp`, as before). The socket is measured against the limit under whatever this returns, so a
 * run root that is too deep is refused (`HcSocketTooLongError`), never silently shortened.
 */
export function hcScratchBase(env: EnvLike = process.env, fallback = "/tmp"): string {
  const named = env[HC_SCRATCH_ROOT_ENV];
  return typeof named === "string" && isAbsolute(named) ? named : fallback;
}

/**
 * Where a scratch core goes when the run names no root: `tmp` (the host's temp folder) when it is short enough, else `/tmp`. hc refuses a
 * session whose sockets would pass the platform limit, and it measures more than the core's own socket: hc 0.1.19 on macOS counted
 * `<root>` + 36 + the session's length (111 bytes for a 69-byte root and a 7-byte session; exit 2, "the socket path ... is too long"),
 * 17 more than `<root>/r/herdr-core/<session>.sock`. macOS's tmpdir() is 56 bytes resolved, so a core made under it by the real-core
 * suites cannot start. 40 leaves room for the root's own name (`/hcp-xxxxxx`), a pid session and that allowance.
 */
export function hcScratchFallback(tmp: string): string {
  return Buffer.byteLength(tmp) <= 40 ? tmp : "/tmp";
}

/**
 * The env the run's scratch root is read from. The root belongs to the RUN, not to the env a caller hands the core: a caller (the
 * hermetic scaffold's `startHcCore`, with the narrow `baseEnv` its test built) that does not carry `OPENRIG_TEST_SCRATCH_ROOT` would
 * otherwise send its core to `/tmp`, outside the run root (macOS run at 99a9f7d6: /tmp/hcs-UQxEVs, /tmp/hcs-6iSiOM). A caller that
 * names a root of its own in `baseEnv` still wins.
 */
export function scratchRootEnv(baseEnv: EnvLike): EnvLike {
  return baseEnv[HC_SCRATCH_ROOT_ENV] !== undefined ? baseEnv : process.env;
}

export class HcForeignCoreError extends Error {
  constructor(readonly varName: string, readonly value: string) {
    super(
      `hc scratch refused: ${varName}=${value} points at a core this helper did not start. A test must never run against ` +
        `the host's own core (fail-closed; zero traffic sent, nothing created). Unset ${varName}.`,
    );
    this.name = "HcForeignCoreError";
  }
}

export class HcNotPrivateError extends Error {
  constructor(readonly reason: string) {
    super(`hc scratch refused: the env for this hc call is not private (${reason}). Fail-closed; no hc process was started.`);
    this.name = "HcNotPrivateError";
  }
}

export class HcSocketTooLongError extends Error {
  constructor(readonly path: string, readonly bytes: number) {
    super(`hc scratch refused: the core socket would be ${bytes} bytes (${path}); the limit is ${HC_SOCKET_PATH_LIMIT}. Use a shorter baseDir.`);
    this.name = "HcSocketTooLongError";
  }
}

export class HcCleanupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HcCleanupError";
  }
}

/** The first foreign-core var set (non-empty) in `env`, or null. Pure; sends nothing. */
export function detectForeignHcCore(env: EnvLike = process.env): { name: string; value: string } | null {
  for (const name of FOREIGN_HC_CORE_ENV_VARS) {
    const value = env[name];
    if (typeof value === "string" && value.length > 0) return { name, value };
  }
  return null;
}

/** FAIL-CLOSED: throw `HcForeignCoreError` if the caller's env redirects hc at a core of its own. */
export function assertNoForeignHcCore(env: EnvLike = process.env): void {
  const foreign = detectForeignHcCore(env);
  if (foreign) throw new HcForeignCoreError(foreign.name, foreign.value);
}

const inside = (root: string, path: string | undefined): boolean => {
  if (!path || !isAbsolute(path)) return false;
  const rel = relative(root, path);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
};

/**
 * FAIL-CLOSED check on the env a child `hc` is about to get. It reads the env itself, not the options that built it, so a
 * later edit of the env object (the way `HC_SESSION` goes missing) is caught where it matters.
 */
export function assertPrivateHcEnv(env: EnvLike, root: string): void {
  for (const name of FOREIGN_HC_CORE_ENV_VARS) {
    const value = env[name];
    if (value && !inside(root, value)) throw new HcNotPrivateError(`${name} is set outside the scratch root`);
  }
  for (const name of ["HC_TERMINAL_SOCKET", "HC_TERMINAL_ID", "HC_SCOPE"]) {
    if (env[name]) throw new HcNotPrivateError(`${name} is set: the child would act as a terminal of another core`);
  }
  const session = env.HC_SESSION;
  if (!session) throw new HcNotPrivateError("HC_SESSION is empty, which selects the default core");
  if (session === "default") throw new HcNotPrivateError("HC_SESSION is `default`, the host's own core");
  for (const name of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR"]) {
    if (!inside(root, env[name])) throw new HcNotPrivateError(`${name} is not inside the scratch root`);
  }
  // The socket hc will actually use, resolved by the production resolver the daemon's client uses.
  const socket = resolveHcSocket(env, env.HOME);
  if (!inside(root, socket)) throw new HcNotPrivateError(`the resolved socket ${socket} is outside the scratch root`);
}

/** The longest socket path either platform layout would produce under `root` for `session`. */
export function longestSocketPath(root: string, session: string): string {
  const linux = join(root, "r", "herdr-core", `${session}.sock`);
  const mac = join(root, "s", "herdr-core", session, `${session}.sock`);
  return Buffer.byteLength(mac) > Buffer.byteLength(linux) ? mac : linux;
}

export interface HcScratch {
  /** The scratch root (short, owned by this module); everything lives inside it. */
  readonly root: string;
  readonly home: string;
  readonly session: string;
  /** The core's socket, as `resolveHcSocket` finds it with `env`. */
  readonly socketPath: string;
  /** The env a core and its clients get. A distinct object, never `process.env` or the caller's. */
  readonly env: NodeJS.ProcessEnv;
  readonly hcBin: string;
  /** Run the real `hc` CLI against the private core, after `assertPrivateHcEnv`. */
  run(args: string[], options?: { timeoutMs?: number; input?: string }): SpawnSyncReturns<string>;
  /** A client of the private core's socket (the production `HcClient`). */
  client(): HcClient;
  /** Re-record the core, holder and terminal processes now alive and re-arm the orphan guard with them (matters off Linux). */
  refreshOrphanGuard(): void;
  /** Stop the core, verify nothing of it remains, remove the root, disarm the guard. Idempotent. Throws, keeping the root, if it cannot verify. */
  cleanup(): void;
}

export interface StartHcScratchOptions {
  /** Where the short root is made. Default: `hcScratchBase()` (`OPENRIG_TEST_SCRATCH_ROOT` when set, else `/tmp`). */
  baseDir?: string;
  /** The `hc` binary. Default: `command -v hc`. */
  hcBin?: string;
  /** The caller's env: only `PATH` is read, and `HC_SOCKET` is refused. Default `process.env`. */
  baseEnv?: EnvLike;
  /** The process whose death triggers the orphan guard. Default: this process. A seam for the test that kills an owner. */
  ownerPid?: number;
}

/**
 * The test file that asked for the root, for the tripwire's report: the first `*.test.*` frame of the call stack, or undefined.
 * It reads the stack, not vitest's state, because this module is also loaded outside vitest (scripts/run-scenarios.mjs builds a
 * hermetic scaffold, which starts scratch cores), where importing vitest throws.
 */
function askingTestFile(): string | undefined {
  const frame = /\(?(?:file:\/\/)?(\/[^\s():]+\.test\.[cm]?[jt]s):\d+:\d+/.exec(new Error().stack ?? "");
  return frame?.[1];
}

/** The `hc` on PATH, or null (a suite skips on null). */
export function findHc(env: EnvLike = process.env): string | null {
  const out = spawnSync("sh", ["-c", "command -v hc"], { encoding: "utf8", env: { PATH: env.PATH ?? process.env.PATH ?? "" } });
  const path = out.stdout.trim();
  return path.length > 0 ? path : null;
}

const sleepSync = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

function waitSync(done: () => boolean, withinMs: number): boolean {
  const until = Date.now() + withinMs;
  while (!done()) {
    if (Date.now() > until) return false;
    sleepSync(25);
  }
  return true;
}

/** Recorded pids from `hc server status --json`: the core and every holder. Null when the status cannot be read. */
function statusPids(run: HcScratch["run"]): number[] | null {
  const out = run(["server", "status", "--json"], { timeoutMs: 10_000 });
  if (out.status !== 0) return null;
  try {
    const parsed = JSON.parse(out.stdout) as { pid?: unknown; holders?: Array<{ pid?: unknown }> };
    const pids = [parsed.pid, ...(parsed.holders ?? []).map((h) => h.pid)].filter((p): p is number => typeof p === "number");
    return pids;
  } catch {
    return null;
  }
}

/**
 * Start a private core and return its handle. Refuses, before creating anything, an ambient `HC_SOCKET` or a path that is
 * too long for a socket; refuses, after creating the root and before starting `hc`, an env that is not private or a
 * socket path that already exists. Setup that fails half-way stops what it started and removes the root.
 */
export function startHcScratch(options: StartHcScratchOptions = {}): HcScratch {
  const baseEnv = options.baseEnv ?? process.env;
  assertNoForeignHcCore(baseEnv);
  const hcBin = options.hcBin ?? findHc(baseEnv);
  if (!hcBin) throw new Error("hc scratch: no hc binary on PATH");

  const root = mkdtempSync(join(options.baseDir ?? hcScratchBase(scratchRootEnv(baseEnv)), "hcs-"));
  // On the run's list before anything else can fail: the end-of-run tripwire (test/hc-scratch-tripwire.ts) looks at exactly these roots.
  registerHcScratchRoot(root, askingTestFile());
  const session = `s${basename(root).slice(-6).toLowerCase().replace(/[^a-z0-9]/g, "0")}`;
  const fail = (error: unknown): never => { rmSync(root, { recursive: true, force: true }); throw error; };

  const longest = longestSocketPath(root, session);
  if (Buffer.byteLength(longest) > HC_SOCKET_PATH_LIMIT) fail(new HcSocketTooLongError(longest, Buffer.byteLength(longest)));

  const dirs = { home: join(root, "h"), config: join(root, "c"), data: join(root, "d"), state: join(root, "s"), runtime: join(root, "r") };
  try {
    for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) { fail(error); }

  // BUILT, not copied: PATH and nothing else. A seat's HC_* names, DOCKER_HOST, credentials: none of it reaches the core.
  const env: NodeJS.ProcessEnv = {
    PATH: baseEnv.PATH ?? process.env.PATH ?? "",
    HOME: dirs.home,
    HC_SESSION: session,
    XDG_CONFIG_HOME: dirs.config,
    XDG_DATA_HOME: dirs.data,
    XDG_STATE_HOME: dirs.state,
    XDG_RUNTIME_DIR: dirs.runtime,
  };

  const socketPath = resolveHcSocket(env, dirs.home);
  try {
    assertPrivateHcEnv(env, root);
  } catch (error) { fail(error); }

  const run: HcScratch["run"] = (args, opts = {}) => {
    assertPrivateHcEnv(env, root);
    return spawnSync(hcBin, args, { env, encoding: "utf8", timeout: opts.timeoutMs ?? 30_000, input: opts.input, stdio: ["pipe", "pipe", "pipe"] });
  };

  // Armed BEFORE the core starts: the window in which a killed worker leaves a core behind begins at start.
  const sessionEntry = `HC_SESSION=${session}`;
  let identities: ProcessIdentity[] = [];
  let core: ProcessIdentity | null = null;
  let reaper: { disarm: () => void } = { disarm: () => {} };
  const arm = () => {
    reaper.disarm();
    reaper = reapWhenOwnerDies({ environ: canSweepEnviron() ? [sessionEntry] : [], identities, label: "hc-scratch", ownerPid: options.ownerPid });
  };
  const record = (): void => {
    const pids = statusPids(run) ?? [];
    const corePid = pids[0];
    if (core === null && corePid !== undefined) core = identityOf(corePid);
    const found = pids.map((pid) => identityOf(pid)).filter((id): id is ProcessIdentity => id !== null);
    const known = new Map(identities.map((id) => [id.pid, id]));
    for (const id of found) known.set(id.pid, id);
    identities = [...known.values()];
  };

  let cleaned = false;
  const survivors = (): ProcessIdentity[] => identities.filter(sameProcess);
  const envHolders = (): number[] => (canSweepEnviron() ? pidsWithEnv(sessionEntry) : []);

  const cleanup = (): void => {
    if (cleaned || !existsSync(root)) { reaper.disarm(); cleaned = true; return; }
    // `status` and `stop` against a dead core can START one, so both wait for proof that the recorded core is still alive;
    // a dead core leaves only its holders and programs, which the identities and the session sweep below cover.
    if (core !== null && sameProcess(core)) {
      record();
      run(["server", "stop"], { timeoutMs: 20_000 });
    }
    waitSync(() => survivors().length === 0 && envHolders().length === 0, 8_000);
    // Anything left is killed only while it is still the recorded process (or still carries this session's unique entry).
    for (const sig of ["SIGTERM", "SIGKILL"] as const) {
      for (const id of survivors()) { try { process.kill(id.pid, sig); } catch { /* gone */ } }
      for (const pid of envHolders()) { try { process.kill(pid, sig); } catch { /* gone */ } }
      if (waitSync(() => survivors().length === 0 && envHolders().length === 0, 5_000)) break;
    }
    const left = [...survivors().map((id) => id.pid), ...envHolders()];
    if (left.length > 0) {
      throw new HcCleanupError(`hc scratch ${session}: could not verify the core stopped (pids ${[...new Set(left)].join(", ")}); root ${root} kept, orphan guard still armed`);
    }
    rmSync(root, { recursive: true, force: true });
    reaper.disarm();
    cleaned = true;
  };

  try {
    arm();
    const started = run(["server", "start"], { timeoutMs: 30_000 });
    // A binary that cannot be run at all (spawn error) has a null status and no stderr; say so instead of throwing on the missing text.
    if (started.status !== 0) {
      const what = started.error ? `could not run (${started.error.message})` : `exited ${started.status}`;
      throw new Error(`hc scratch: \`hc server start\` ${what}: ${(started.stderr ?? "").trim().slice(0, 300)}`);
    }
    if (!existsSync(socketPath)) throw new Error(`hc scratch: core started but ${socketPath} does not exist`);
    record();
    arm();
  } catch (error) {
    try { cleanup(); } catch { /* the original failure is the one to report; the guard stays armed if cleanup could not verify */ }
    throw error;
  }

  return {
    root, home: dirs.home, session, socketPath, env, hcBin,
    run,
    client: () => new HcClient(socketPath),
    refreshOrphanGuard: () => { record(); arm(); },
    cleanup,
  };
}
