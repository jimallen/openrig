import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";

/** The protocol generation this build speaks. A core on any other refuses `hello`, and the daemon must stop there. */
export const HC_GENERATION = 1;

const DEFAULT_TIMEOUT_MS = 10_000;

/** Nothing reached the core: no socket, refused, or `hello` never answered. The core may be fine or gone; a caller
 *  must read this as "unknown", never as "the terminal is gone". */
export class HcUnavailableError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "HcUnavailableError";
  }
}

/** The request was written and no reply came. It may still take effect: a queued send outlives its client (spike
 *  1+2), so a caller must verify before it retries. */
export class HcOutcomeUnknownError extends Error {
  constructor(message: string, readonly method: string) {
    super(message);
    this.name = "HcOutcomeUnknownError";
  }
}

/** The core answered with a refusal. `kind` is hc's stable word: not_found, finished, blocked, status_mismatch,
 *  name_taken, unsupported_generation, ... */
export class HcError extends Error {
  constructor(message: string, readonly kind: string, readonly code: number, readonly hint?: string) {
    super(message);
    this.name = "HcError";
  }
}

export interface HcHello {
  generation: number;
  version: string;
  /** Which core answered. An older hc leaves out the id, or the whole object (o9o.165 verify-sec F4; workspaces-87f): every reader
   *  handles both, and a pin on the id cannot be judged without one. */
  core?: { id?: string; name?: string };
  framed: boolean;
  methods: string[];
  features: string[];
}

export interface HcTerminal {
  address: string;
  name?: string | null;
  labels: Record<string, string>;
  argv: string[];
  cwd: string;
  state: string;
  created_ms: number;
  screen: string;
  cols: number;
  rows: number;
  pid?: number | null;
  reason?: string | null;
  keep?: boolean;
  status_ms?: number | null;
  finished_ms?: number | null;
  reported?: boolean;
  exit_code?: number | null;
  turn?: number;
  /** The title the program set (schema `Terminal.title`, default ""). */
  title?: string;
  status?: { state: string; kind?: string | null } | null;
  foreground?: { pid: number; name: string; argv: string[]; cwd: string } | null;
}

/** The core's socket, as hc itself finds it: HC_SOCKET, else the runtime dir (Linux), else the state dir (macOS, read
 *  from the live core's open files; `<state>/herdr-core/<session>/<session>.sock`). */
export function resolveHcSocket(env: NodeJS.ProcessEnv = process.env, home?: string): string {
  if (env.HC_SOCKET) return env.HC_SOCKET;
  const session = env.HC_SESSION || "default";
  if (env.XDG_RUNTIME_DIR) return join(env.XDG_RUNTIME_DIR, "herdr-core", `${session}.sock`);
  // The env names the location or there is none (OF-199): os.homedir() reads the passwd entry when HOME is unset, which is the
  // account's real home, so a daemon started without a HOME joined the account's real core. An empty value is no value.
  const base = env.XDG_STATE_HOME || (home || env.HOME ? join(home || env.HOME!, ".local", "state") : "");
  if (!base) throw new HcUnavailableError("refusing to resolve an hc socket: none of HC_SOCKET, XDG_RUNTIME_DIR, XDG_STATE_HOME or HOME is set, so there is no named location (the account's home is not assumed)");
  return join(base, "herdr-core", session, `${session}.sock`);
}

/** Where hc keeps the identity of the core of this env's state dir: `<state dir>/herdr-core/<session>/core.json`, the state dir being
 *  XDG_STATE_HOME, else `$HOME/.local/state` (as resolveHcSocket). Null when the env names no state dir. workspaces-o9o.165, measured
 *  with hc 0.1.18: the file holds `{ id, name, machine_id }`, its `id` is the one `hello` answers with, it stays the same across
 *  restarts of that state dir's core, and a core started with another state dir has another, even at the same socket. */
export function hcCoreIdentityFile(env: NodeJS.ProcessEnv = process.env, home?: string): string | null {
  const base = env.XDG_STATE_HOME || (home || env.HOME ? join(home || env.HOME!, ".local", "state") : "");
  if (!base) return null;
  const session = env.HC_SESSION || "default";
  return join(base, "herdr-core", session, "core.json");
}

/** The core this instance's state dir names: none (it has never held a core), its id, or a file that cannot be read as one. */
export type ThisInstanceCore =
  | { kind: "none"; file: string | null }
  | { kind: "id"; id: string; file: string }
  | { kind: "unreadable"; file: string; detail: string };

const CORE_ID = /^[0-9a-f]{16,64}$/i;
/** hc writes about 100 bytes; anything far larger is not its core.json. */
const CORE_IDENTITY_MAX_BYTES = 64 * 1024;

/** Reads hc's core.json the way a credential file is read (verify-sec, o9o.165 review): lstat first, and only a path that is
 *  not there is missing (its ENOENT is the one error passed on as is); a link, even a dangling one, or anything but a regular
 *  file is refused; the open follows no link and never blocks (a FIFO); the opened file must still be regular and small. */
export function readCoreIdentityFile(file: string): string {
  const st = lstatSync(file);
  if (st.isSymbolicLink()) throw new Error("it is a symbolic link, not a regular file");
  if (!st.isFile()) throw new Error("it is not a regular file");
  let fd: number;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (err) {
    // Not ENOENT: a path removed between the lstat and the open is not "missing", it is a file that changed under the read.
    throw new Error(`it cannot be opened: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw new Error("it is not a regular file");
    if (opened.size > CORE_IDENTITY_MAX_BYTES) throw new Error(`it is larger than ${CORE_IDENTITY_MAX_BYTES} bytes`);
    const buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < buffer.length) {
      const n = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (n === 0) break;
      offset += n;
    }
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** Reads hcCoreIdentityFile. A missing file (or no state dir) is `none`; anything else that is not a core id is `unreadable`. */
export function readThisInstanceCore(
  env: NodeJS.ProcessEnv = process.env, home?: string, read: (file: string) => string = readCoreIdentityFile,
): ThisInstanceCore {
  const file = hcCoreIdentityFile(env, home);
  if (!file) return { kind: "none", file: null };
  let text: string;
  try {
    text = read(file);
  } catch (err) {
    const code = typeof err === "object" && err !== null && "code" in err ? (err as { code?: unknown }).code : undefined;
    if (code === "ENOENT") return { kind: "none", file };
    return { kind: "unreadable", file, detail: err instanceof Error ? err.message : String(err) };
  }
  let id: unknown;
  try {
    id = (JSON.parse(text) as { id?: unknown } | null)?.id;
  } catch {
    return { kind: "unreadable", file, detail: "not JSON" };
  }
  if (typeof id !== "string" || !CORE_ID.test(id)) return { kind: "unreadable", file, detail: "no core id in it" };
  return { kind: "id", id, file };
}

/** Why the core answering `answeringId` at this instance's socket is not this instance's, or null when it is (or nothing says otherwise).
 *  On Linux the socket is the runtime dir's and the id the state dir's, so a core of another state dir (another HOME or XDG_STATE_HOME
 *  in the same runtime dir) can answer at this instance's socket, with another registry of terminals (workspaces-o9o.165). A state dir
 *  that has never held a core names none, and any core is joined, as a scratch harness's private core is. */
export function notThisInstanceCore(expected: ThisInstanceCore, answeringId: string): string | null {
  if (expected.kind === "none") return null;
  if (expected.kind === "unreadable") {
    return `refusing the hc core: this instance's core identity file ${expected.file} cannot be read as one (${expected.detail}), so the core at its socket `
      + "cannot be shown to be this instance's. hc writes that file when it starts a core with this state dir; have the operator repair it, or stop the core and start again.";
  }
  if (expected.id === answeringId) return null;
  return `refusing the hc core: the core answering at this instance's socket is ${answeringId}, but this instance's state dir names core ${expected.id} `
    + `(${expected.file}). It is the core of another state dir (another HOME or XDG_STATE_HOME in the same runtime dir), with another registry of terminals. `
    + "Have the operator stop that core, or start the daemon with the HOME that core was started with.";
}

/** The account the process runs as: its uid names the host's runtime dir (`/run/user/<uid>`), its home the host's state dir. */
export interface CoreAccount { uid: number; home: string }

function currentAccount(): CoreAccount | null {
  try {
    const { uid, homedir: home } = userInfo();
    return uid >= 0 && home ? { uid, home } : null;
  } catch { return null; }
}

/** Why a core must not be started with this env, or null when it names where its runtime lives. A core started with no named runtime
 *  location takes the host's: on Linux hc asks the user manager and uses `/run/user/<uid>`, where a core with a fresh state dir adopts
 *  every holder it finds and ends the programs its own registry does not know (incident 2026-11-02, every terminal under the host's
 *  holder ended). On macOS there is no runtime dir: the socket and the holders live under the state dir, `XDG_STATE_HOME` or else
 *  `$HOME/.local/state` (see resolveHcSocket), so HOME names the location and an env without one is the refusal. `HC_SOCKET` and
 *  `XDG_RUNTIME_DIR` name it on both. An empty value is no value, as for resolveHcSocket.
 *
 *  Naming the HOST's runtime dir is not enough on Linux: the registry lives in the state dir, so the same runtime dir with another state
 *  dir is the destructive pair (two homes, one runtime dir, no lock between them; second plan read S2b). A core whose runtime dir is
 *  `/run/user/<this uid>` (named by XDG_RUNTIME_DIR or under it by HC_SOCKET) is refused unless its state dir is the account's own
 *  (`XDG_STATE_HOME`, else `$HOME/.local/state`, equal to `<account home>/.local/state`). A private runtime dir with a private HOME, the
 *  scratch cores' shape, and the production unit (account HOME, the manager's runtime dir) both pass. OPENRIG_HOME is not judged: it does not
 *  key the registry, and a second instance with its own OPENRIG_HOME and the account's HOME joins the same core. Never makes `resolveHcSocket`
 *  fall back to `/run/user/<uid>`: a scratch daemon would then talk to the host's core. */
export function coreRuntimeLocationRefusal(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform, account: CoreAccount | null = currentAccount()): string | null {
  if (env.HC_SOCKET || env.XDG_RUNTIME_DIR) return hostRuntimeWithOtherState(env, platform, account);
  if (platform === "linux") {
    return "refusing to start an hc core: neither XDG_RUNTIME_DIR nor HC_SOCKET is set, so hc would use the host's runtime dir (/run/user/<uid>) "
      + "and could take over, or end the programs of, a core that is not this instance's. Set XDG_RUNTIME_DIR to this instance's runtime dir (or HC_SOCKET to its socket) and start again.";
  }
  if (env.XDG_STATE_HOME || env.HOME) return null;
  return "refusing to start an hc core: none of HC_SOCKET, XDG_RUNTIME_DIR, XDG_STATE_HOME or HOME is set, so hc would take the account's own home for "
    + "its state dir and could take over a core that is not this instance's. Set HOME (or XDG_STATE_HOME, or HC_SOCKET) to this instance's and start again.";
}

function hostRuntimeWithOtherState(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, account: CoreAccount | null): string | null {
  if (platform !== "linux" || account === null) return null;
  const hostRuntime = `/run/user/${account.uid}`;
  // Paths, not text: `/run/user//1000`, `/run/user/1000/.` and `/run/user/1000/../1000` are the host's runtime dir too (review of 6f813a07, F2).
  const runtime = env.XDG_RUNTIME_DIR ? resolve(env.XDG_RUNTIME_DIR) : "";
  const socket = env.HC_SOCKET ? resolve(env.HC_SOCKET) : "";
  if (runtime !== hostRuntime && !socket.startsWith(`${hostRuntime}/`)) return null;
  const accountState = resolve(account.home, ".local", "state");
  const state = resolve(env.XDG_STATE_HOME || join(env.HOME || account.home, ".local", "state"));
  if (state === accountState) return null;
  return `refusing to start an hc core: it names the host's runtime dir (${hostRuntime}) but its state dir is ${state}, not the account's (${accountState}). `
    + "A core with another state dir in the host's runtime dir adopts the host's holders and ends the programs its own registry does not know. "
    + "Give this instance its own XDG_RUNTIME_DIR with its own HOME, or the account's own HOME with the host's.";
}

/** A check every `hello` this build makes to a socket must pass, beyond the generation: the daemon's pin on the core's version and
 *  identity (hc-core-watch.ts `pinCallsToCore`). It lives here, keyed by socket, because three places say `hello` (HcClient, the
 *  attach wire, the size watch) and all three must refuse a core that is no longer the one the daemon pinned (security review F5).
 *  No pin registered for a socket is no check, as for the CLI and for tests on a private core. Throws an HcError to refuse. */
export type HcHelloCheck = (hello: HcHello) => void;
const helloChecks = new Map<string, HcHelloCheck>();
export function setHcHelloCheck(socketPath: string, check: HcHelloCheck | null): void {
  if (check) helloChecks.set(socketPath, check);
  else helloChecks.delete(socketPath);
}
export function checkHcHello(socketPath: string, hello: HcHello): void {
  helloChecks.get(socketPath)?.(hello);
}

interface RpcReply { id?: number; result?: unknown; error?: { code: number; message: string; data?: { kind?: string; hint?: string } } }

/** One short-lived connection per call: a queued send can block for as long as a person types, and must never hold up
 *  a liveness read. Reaching the core and hearing it are kept apart: see the two error classes. */
export class HcClient {
  /** `enforcePin` is false only for the core watch's own probe (probeCore): the watch judges and pins that hello itself and must see a
   *  refused core as `present`. A structural test (hc-unchecked-connections.test.ts) fails on any other construction that turns it off.
   *  `ownCheck` (workspaces-87f): a further check every hello of this client must pass, beside the per-socket one; the core watch's own
   *  reads pass its pin through it, so they are held to it even before pinCallsToCore installs the per-socket check. */
  constructor(readonly socketPath: string = resolveHcSocket(), private readonly defaultTimeoutMs = DEFAULT_TIMEOUT_MS, private readonly enforcePin = true, private readonly ownCheck?: HcHelloCheck) {}

  private refusal: string | null = null;

  /** The core watch found the core wrong for this build (another generation, version or core id) after the daemon started.
   *  From here every call fails as an UNAVAILABLE core, which no caller reads as a seat that is gone. The watch stops at a
   *  refusal and nothing retries a generation or a version, so this holds until the daemon restarts. Calls already in
   *  flight are not touched. */
  refuseCore(reason: string): void { this.refusal = reason; }
  /** Why calls are refused now, or null. */
  get refusedBecause(): string | null { return this.refusal; }

  private launchBlock: string | null = null;
  /** A launch was refused because the core has no holder (hc-launch-refusal.ts). Read by `rig health`; the next launch that succeeds clears it. */
  noteLaunchBlocked(message: string): void { this.launchBlock = message; }
  get launchBlockedBecause(): string | null { return this.launchBlock; }

  private refuseIfRefused(): void {
    if (this.refusal !== null) throw new HcUnavailableError(`the hc core is refused: ${this.refusal}`);
  }

  async hello(): Promise<HcHello> {
    const conn = await this.open();
    try {
      return await this.greet(conn);
    } finally {
      conn.close();
    }
  }

  async call<T>(method: string, params: Record<string, unknown> = {}, options: { timeoutMs?: number } = {}): Promise<T> {
    this.refuseIfRefused();
    const conn = await this.open();
    try {
      await this.greet(conn);
      const result = await conn.request<T>(method, params, options.timeoutMs ?? this.defaultTimeoutMs);
      if (method === "terminal.run") this.launchBlock = null;
      return result;
    } finally {
      conn.close();
    }
  }

  private async greet(conn: Connection): Promise<HcHello> {
    let hello: HcHello;
    try {
      hello = await conn.request<HcHello>("hello", { generation: HC_GENERATION, framed: false }, this.defaultTimeoutMs);
    } catch (err) {
      if (err instanceof HcOutcomeUnknownError) throw new HcUnavailableError(err.message, err);  // hello changes nothing
      throw err;
    }
    if (hello.generation !== HC_GENERATION) {
      throw new HcError(`core speaks generation ${hello.generation}, this build ${HC_GENERATION}`, "unsupported_generation", -32000);
    }
    if (this.enforcePin) checkHcHello(this.socketPath, hello);
    this.ownCheck?.(hello);
    return hello;
  }

  private open(): Promise<Connection> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      socket.once("connect", () => {
        socket.removeAllListeners("error");
        resolve(new Connection(socket));
      });
      socket.once("error", (err) => reject(new HcUnavailableError(`hc core not reachable at ${this.socketPath}: ${err.message}`, err)));
    });
  }
}

class Connection {
  private buffer = "";
  private nextId = 1;
  private pending: { id: number; method: string; resolve: (value: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout } | null = null;

  constructor(private readonly socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("error", (err) => this.fail(err.message));
    socket.on("close", () => this.fail("the core closed the connection"));
  }

  request<T>(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => this.fail(`no reply in ${timeoutMs} ms`), timeoutMs);
      this.pending = { id, method, resolve: resolve as (value: unknown) => void, reject, timer };
      this.socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  close(): void {
    this.socket.destroy();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (let end = this.buffer.indexOf("\n"); end >= 0; end = this.buffer.indexOf("\n")) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (line.trim()) this.onLine(line);
    }
  }

  private onLine(line: string): void {
    const pending = this.pending;
    if (!pending) return;
    let reply: RpcReply;
    try {
      reply = JSON.parse(line) as RpcReply;
    } catch {
      this.fail("the core sent a line that is not JSON");
      return;
    }
    if (reply.id !== pending.id) return;  // a notification, not this reply
    this.pending = null;
    clearTimeout(pending.timer);
    if (reply.error) {
      const { code, message, data } = reply.error;
      pending.reject(new HcError(message, data?.kind ?? "unknown", code, data?.hint));
    } else {
      pending.resolve(reply.result);
    }
  }

  private fail(reason: string): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.reject(new HcOutcomeUnknownError(`${pending.method}: ${reason}`, pending.method));
  }
}
