import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { HC_GENERATION, HcClient, HcError, HcOutcomeUnknownError, HcUnavailableError, setHcHelloCheck, type HcHello, type HcTerminal } from "./hc-client.js";
import { OPERATOR_SECRET_ENV_NAMES } from "./hc-seat.js";

/** The hc this build is tested against. Written and measured on 0.1.15 (spikes 1 to 4); moved to 0.1.16 after W36 re-ran every
 *  `*.real.test.ts` (daemon 171, CLI 21) on a private 0.1.16 core: the OpenRPC schema differs from 0.1.15 only in `info.version`.
 *  hc is a preview with no stability statement, so any other version is refused until the pin is moved on purpose, as a
 *  tested release step. */
export const HC_PINNED_VERSION = "0.1.16";

/** The core sends `heartbeat` this often when nothing else is sent (measured: first beat 15.0 s after the last event). */
export const HC_HEARTBEAT_INTERVAL_MS = 15_000;
/** Two beats and some slack: one late beat is not a dead stream, two missing ones are. */
export const HC_HEARTBEAT_TIMEOUT_MS = 2 * HC_HEARTBEAT_INTERVAL_MS + 5_000;

const HELLO_TIMEOUT_MS = 10_000;
const RECONNECT_DELAYS_MS = [100, 200, 500, 1_000, 2_000, 5_000];

/** The core is reachable and wrong for this daemon. The daemon must stop there and not proceed (design section 6):
 *  retrying cannot fix a generation, a version or a swapped core. */
export class HcCoreRefusedError extends Error {
  constructor(message: string, readonly kind: "unsupported_generation" | "unsupported_version" | "core_changed") {
    super(message);
    this.name = "HcCoreRefusedError";
  }
}

export interface HcCorePin {
  /** Versions accepted; default is the pinned one. */
  versions?: readonly string[];
  /** The core id seen first. A different one later is another core, with its own terminals. */
  coreId?: string;
}

/** Throws HcCoreRefusedError unless the core speaks this build's generation, an accepted version, and is the pinned core. */
export function verifyHello(hello: HcHello, pin: HcCorePin = {}): void {
  if (hello.generation !== HC_GENERATION) {
    throw new HcCoreRefusedError(`core speaks generation ${hello.generation}, this build ${HC_GENERATION}`, "unsupported_generation");
  }
  const versions = pin.versions ?? [HC_PINNED_VERSION];
  if (!versions.includes(hello.version)) {
    throw new HcCoreRefusedError(`core is hc ${hello.version}, this build is pinned to ${versions.join(" or ")}`, "unsupported_version");
  }
  if (pin.coreId !== undefined && hello.core.id !== pin.coreId) {
    throw new HcCoreRefusedError("the core answering is not the one this daemon first saw", "core_changed");
  }
}

export type HcCorePresence =
  | { state: "present"; hello: HcHello }
  /** The socket file exists and nothing listens (ECONNREFUSED): a killed core. Nothing restarts it. */
  | { state: "stale_socket" }
  /** No socket file (ENOENT): no core has run here, or its state was removed. */
  | { state: "absent" }
  /** Connected and no `hello` answer: a stopped or hung core. Never start another beside it. */
  | { state: "unresponsive"; cause: string }
  | { state: "unreachable"; cause: string };

function errorCode(err: unknown): string | undefined {
  const cause = err instanceof HcUnavailableError ? err.cause : err;
  if (typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string") return cause.code;
  return undefined;
}

/** Is a core there? One socket connection and a `hello`: the hc CLI is never run, because `hc server status`, `hc schema`
 *  and `hc --skill` each START a core when none runs (design section 4, spike 1+2). Generation and version are not
 *  judged here; see verifyHello. */
export async function probeCore(socketPath: string, options: { helloTimeoutMs?: number } = {}): Promise<HcCorePresence> {
  try {
    return { state: "present", hello: await new HcClient(socketPath, options.helloTimeoutMs ?? HELLO_TIMEOUT_MS, false).hello() };
  } catch (err) {
    // A generation the core refuses still proves a core is there; the caller's verify names the refusal.
    if (err instanceof HcError && err.kind === "unsupported_generation") throw new HcCoreRefusedError(err.message, "unsupported_generation");
    if (!(err instanceof HcUnavailableError)) throw err;
    const code = errorCode(err);
    if (code === "ECONNREFUSED") return existsSync(socketPath) ? { state: "stale_socket" } : { state: "absent" };
    if (code === "ENOENT") return { state: "absent" };
    if (err.cause instanceof HcOutcomeUnknownError) return { state: "unresponsive", cause: err.message };
    return { state: "unreachable", cause: err.message };
  }
}

/** Starts a core with the hc CLI, which is the one thing that does. The core's env is the env given here without the operator
 *  secrets, whatever env that is, and every terminal on the core inherits it (design section 4), so pass the env a core should
 *  have. `hc run` on that core goes through no launch wrapper, so what the core never held is the only thing it cannot pass on. */
export function startCoreWithCli(options: { env?: NodeJS.ProcessEnv; hcPath?: string; timeoutMs?: number } = {}): () => Promise<void> {
  return () => new Promise<void>((resolve, reject) => {
    const env = { ...(options.env ?? process.env) };
    for (const name of OPERATOR_SECRET_ENV_NAMES) delete env[name];
    execFile(options.hcPath ?? "hc", ["server", "start"], { env, timeout: options.timeoutMs ?? 30_000 }, (err) => {
      if (err) reject(new HcUnavailableError(`hc server start failed: ${err.message}`, err));
      else resolve();
    });
  });
}

// ---- the view and its reducer -------------------------------------------------------------------------------------

/** A terminal as the stream knows it: the facts `terminal.get` gives, with the ones events change. */
export interface HcViewTerminal extends HcTerminal {
  reported?: boolean;
  records?: Record<string, unknown>;
  finished_ms?: number | null;
  signal?: number | null;
}

export interface HcView {
  /** The last event seq applied on THIS connection. Seq restarts at 0 on every connection and core; it is never
   *  compared across them, and a snapshot replaces it. */
  readonly seq: number;
  readonly terminals: ReadonlyMap<string, HcViewTerminal>;
  /** Addresses an event touched that the reducer cannot apply from the event alone: re-read them with `terminal.get`. */
  readonly stale: ReadonlySet<string>;
}

export const EMPTY_HC_VIEW: HcView = { seq: 0, terminals: new Map(), stale: new Set() };

export type HcStreamMessage =
  | { kind: "snapshot"; seq: number; terminals: readonly HcViewTerminal[] }
  | { kind: "event"; seq: number; type: string; terminal: string; data: unknown }
  | { kind: "missed"; seq: number; terminals: readonly HcViewTerminal[] }
  | { kind: "refreshed"; terminal: HcViewTerminal }
  | { kind: "gone"; address: string };

export type HcNotice =
  /** A terminal's history may be incomplete (a core crash): captures should note it. */
  | { kind: "screen_inexact"; address: string }
  | { kind: "finished"; address: string; reason: string | null; seat: string | null }
  | { kind: "gone"; address: string }
  | { kind: "missed" }
  | { kind: "stream_dead"; why: string }
  | { kind: "disconnected"; why: string }
  | { kind: "connected"; coreId: string; version: string }
  | { kind: "core_started" }
  | { kind: "refused"; refusal: HcCoreRefusedError };

export interface HcReduction { view: HcView; notices: HcNotice[]; dropped: boolean }

const SEAT_LABEL_KEY = "openrig.seat";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStatus(value: unknown): value is { state: string; kind?: string | null } {
  return isRecord(value) && typeof value.state === "string";
}

function isLabels(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((v) => typeof v === "string");
}

/** Apply one measured event to a terminal. null means the event's shape is not one this reducer knows, so the
 *  terminal is re-read instead of guessed at. Types and shapes measured on hc 0.1.15 (Linux): status, turn,
 *  foreground, labels, finished. */
function applyEvent(prev: HcViewTerminal, type: string, data: unknown): HcViewTerminal | null {
  if (!isRecord(data)) return null;
  switch (type) {
    case "status": {
      const status = data.status;
      if (status !== null && !isStatus(status)) return null;
      return { ...prev, status, ...(typeof data.reported === "boolean" ? { reported: data.reported } : {}), ...(isRecord(data.records) ? { records: data.records } : {}) };
    }
    case "turn":
      return typeof data.turn === "number" ? { ...prev, turn: data.turn } : null;
    case "foreground":
      return typeof data.pid === "number" && typeof data.name === "string" && typeof data.cwd === "string" && Array.isArray(data.argv) && data.argv.every((a) => typeof a === "string")
        ? { ...prev, pid: data.pid, foreground: { pid: data.pid, name: data.name, argv: data.argv, cwd: data.cwd } }
        : null;
    case "labels":
      return isLabels(data.labels) ? { ...prev, labels: data.labels } : null;  // the full set, not a delta (measured)
    case "finished":
      return {
        ...prev, state: "finished", foreground: null,
        reason: typeof data.reason === "string" ? data.reason : null,
        exit_code: typeof data.exit_code === "number" ? data.exit_code : null,
        finished_ms: typeof data.finished_ms === "number" ? data.finished_ms : null,
        signal: typeof data.signal === "number" ? data.signal : null,
      };
    default:
      return null;
  }
}

function diffNotices(prev: HcViewTerminal | undefined, next: HcViewTerminal | undefined): HcNotice[] {
  const notices: HcNotice[] = [];
  if (next === undefined) {
    if (prev !== undefined) notices.push({ kind: "gone", address: prev.address });
    return notices;
  }
  if (next.screen === "inexact" && prev?.screen !== "inexact") notices.push({ kind: "screen_inexact", address: next.address });
  if (next.state === "finished" && prev?.state !== "finished") {
    notices.push({ kind: "finished", address: next.address, reason: next.reason ?? null, seat: next.labels[SEAT_LABEL_KEY] ?? null });
  }
  return notices;
}

function replaceAll(view: HcView, seq: number, terminals: readonly HcViewTerminal[]): HcReduction {
  const next = new Map<string, HcViewTerminal>();
  for (const terminal of terminals) next.set(terminal.address, terminal);
  const notices: HcNotice[] = [];
  for (const [address, prev] of view.terminals) if (!next.has(address)) notices.push(...diffNotices(prev, undefined));
  for (const [address, terminal] of next) notices.push(...diffNotices(view.terminals.get(address), terminal));
  return { view: { seq, terminals: next, stale: new Set() }, notices, dropped: false };
}

/** The pure reducer. `snapshot` and `missed` are FULL replacements of the terminals (never a merge: a terminal removed
 *  while the subscriber lagged must vanish) and set the seq; an event at or below the current seq is dropped, which is
 *  how the events seen before a `missed` snapshot are discarded. */
export function reduceHcView(view: HcView, message: HcStreamMessage): HcReduction {
  switch (message.kind) {
    case "snapshot":
      return replaceAll(view, message.seq, message.terminals);
    case "missed": {
      const reduction = replaceAll(view, message.seq, message.terminals);
      return { ...reduction, notices: [{ kind: "missed" }, ...reduction.notices] };
    }
    case "refreshed": {
      const terminals = new Map(view.terminals).set(message.terminal.address, message.terminal);
      const stale = new Set(view.stale);
      stale.delete(message.terminal.address);
      return { view: { ...view, terminals, stale }, notices: diffNotices(view.terminals.get(message.terminal.address), message.terminal), dropped: false };
    }
    case "gone": {
      const terminals = new Map(view.terminals);
      terminals.delete(message.address);
      const stale = new Set(view.stale);
      stale.delete(message.address);
      return { view: { ...view, terminals, stale }, notices: diffNotices(view.terminals.get(message.address), undefined), dropped: false };
    }
    case "event": {
      if (message.seq <= view.seq) return { view, notices: [], dropped: true };
      const terminals = new Map(view.terminals);
      const stale = new Set(view.stale);
      const prev = view.terminals.get(message.terminal);
      let next: HcViewTerminal | undefined = prev;
      if (message.type === "removed") {
        terminals.delete(message.terminal);
        stale.delete(message.terminal);
        next = undefined;
      } else if (message.type === "created" && isRecord(message.data) && typeof message.data.address === "string") {
        next = message.data as unknown as HcViewTerminal;  // the wire's terminal record, as terminal.get returns it
        terminals.set(message.terminal, next);
      } else {
        const applied = prev !== undefined ? applyEvent(prev, message.type, message.data) : null;
        if (applied !== null) {
          next = applied;
          terminals.set(message.terminal, applied);
        } else {
          stale.add(message.terminal);  // an unmeasured type, an odd shape, or a terminal never seen: re-read it
        }
      }
      return { view: { seq: message.seq, terminals, stale }, notices: diffNotices(prev, next), dropped: false };
    }
  }
}

/** Status events are coalesced, not a log (20,000 reports became 3 events): a turn is only ever counted by comparing
 *  `turn` values read at two moments. */
export function turnsCompleted(before: Pick<HcTerminal, "turn"> | undefined, after: Pick<HcTerminal, "turn">): number {
  return Math.max(0, (after.turn ?? 0) - (before?.turn ?? 0));
}

/** A finished terminal whose end was not the program's own doing or an explicit kill: the seat was LOST (holder died,
 *  core stopped, host shutdown, a kept program killed by a signal). Read from `reason`, which hc reports. */
export function lossReason(terminal: Pick<HcTerminal, "state" | "reason">): string | null {
  if (terminal.state !== "finished") return null;
  const reason = terminal.reason ?? null;
  return reason !== null && ["holder_lost", "server_stop", "host_shutdown", "signaled", "stopped_by_restart"].includes(reason) ? reason : null;
}

// ---- the connection -----------------------------------------------------------------------------------------------

interface StreamHandlers {
  onSnapshot(seq: number, terminals: HcViewTerminal[]): void;
  onNotification(method: string, params: unknown): void;
  /** Any line at all: the heartbeat watchdog's clock. */
  onActivity(): void;
  onClose(why: string): void;
}

interface OpenStream {
  hello: HcHello;
  close(): void;
  /** Stop reading: the core's queue for this subscriber then fills and it answers `missed` (backpressure, measured). */
  pause(): void;
  resume(): void;
}

interface RpcLine { id?: number; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: { kind?: string; hint?: string } } }

/** A long-lived plain-mode connection: `hello` with the generation pinned, then `events.subscribe`. Notifications that
 *  arrive in the same chunk as the snapshot are delivered after it, in order. */
function openStream(socketPath: string, params: Record<string, unknown>, helloTimeoutMs: number, handlers: StreamHandlers): Promise<OpenStream> {
  return new Promise((resolve, reject) => {
    const socket: Socket = createConnection(socketPath);
    socket.setEncoding("utf8");
    let buffer = "";
    let phase: "connecting" | "hello" | "subscribe" | "streaming" = "connecting";
    let hello: HcHello | null = null;
    let closed = false;
    let timer: NodeJS.Timeout | null = null;

    const settleFail = (err: Error) => {
      if (timer) clearTimeout(timer);
      socket.destroy();
      reject(err);
    };
    const armTimer = (what: string) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => settleFail(new HcUnavailableError(`${what}: no reply in ${helloTimeoutMs} ms`)), helloTimeoutMs);
    };
    const send = (id: number, method: string, body: Record<string, unknown>) => socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params: body })}\n`);

    socket.once("connect", () => {
      phase = "hello";
      armTimer("hello");
      send(1, "hello", { generation: HC_GENERATION, framed: false });
    });
    socket.on("error", (err) => {
      if (phase === "streaming") return;  // the close event follows and reports it
      settleFail(new HcUnavailableError(`hc core not reachable at ${socketPath}: ${err.message}`, err));
    });
    socket.on("close", () => {
      if (phase !== "streaming") {
        if (!closed) settleFail(new HcUnavailableError(`the core closed the connection during ${phase}`));
        return;
      }
      if (!closed) {
        closed = true;
        handlers.onClose("the core closed the connection");  // a plain EOF is what a core restart looks like
      }
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const raw = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!raw.trim()) continue;
        let line: RpcLine;
        try {
          line = JSON.parse(raw) as RpcLine;
        } catch {
          if (phase === "streaming") {
            closed = true;
            socket.destroy();
            handlers.onClose("the core sent a line that is not JSON");
          } else {
            settleFail(new HcUnavailableError("the core sent a line that is not JSON"));
          }
          return;
        }
        if (phase === "streaming") {
          handlers.onActivity();
          if (typeof line.method === "string") handlers.onNotification(line.method, line.params);
          continue;
        }
        if (line.error) {
          const { code, message, data } = line.error;
          settleFail(new HcError(message, data?.kind ?? "unknown", code, data?.hint));
          return;
        }
        if (phase === "hello" && line.id === 1) {
          hello = line.result as HcHello;
          phase = "subscribe";
          armTimer("events.subscribe");
          send(2, "events.subscribe", params);
        } else if (phase === "subscribe" && line.id === 2 && hello) {
          if (timer) clearTimeout(timer);
          const result = line.result as { seq: number; terminals: HcViewTerminal[] };
          phase = "streaming";
          handlers.onActivity();
          handlers.onSnapshot(result.seq, result.terminals);
          resolve({
            hello,
            close: () => { closed = true; socket.destroy(); },
            pause: () => socket.pause(),
            resume: () => socket.resume(),
          });
        }
      }
    });
  });
}

// ---- the watch ----------------------------------------------------------------------------------------------------

export interface HcCoreWatchOptions {
  socketPath: string;
  onNotice?: (notice: HcNotice) => void;
  /** Starts a core when the socket is stale or gone (see startCoreWithCli). Without it a killed core stays down and the watch
   *  keeps retrying and reporting. */
  startCore?: () => Promise<void>;
  pin?: Pick<HcCorePin, "versions">;
  /** Only terminals carrying all of these labels. */
  labels?: Record<string, string>;
  heartbeatTimeoutMs?: number;
  helloTimeoutMs?: number;
  reconnectDelaysMs?: readonly number[];
  /** How long after `startCore` the socket may take to answer. */
  startSettleMs?: number;
}

export type HcWatchState = "idle" | "connecting" | "streaming" | "reconnecting" | "refused" | "stopped";

/** The daemon's view of the core: terminals kept current by `events.subscribe`, surviving core restarts and kills. */
export class HcCoreWatch {
  private current: HcView = EMPTY_HC_VIEW;
  private watchState: HcWatchState = "idle";
  private coreId: string | undefined;
  private stream: OpenStream | null = null;
  private generation = 0;
  private stopped = false;
  private wake: (() => void) | null = null;
  private first: { resolve: (state: HcWatchState) => void; reject: (err: unknown) => void } | null = null;

  constructor(private readonly options: HcCoreWatchOptions) {}

  view(): HcView { return this.current; }
  state(): HcWatchState { return this.watchState; }
  /** The core id the first successful `hello` pinned. */
  pinnedCoreId(): string | undefined { return this.coreId; }

  /** First connection attempt. Resolves when it has streamed or found the core unavailable (the watch then keeps
   *  retrying in the background); rejects with HcCoreRefusedError when the core is refused. */
  start(): Promise<HcWatchState> {
    if (this.watchState !== "idle") return Promise.resolve(this.watchState);
    this.watchState = "connecting";
    const firstAttempt = new Promise<HcWatchState>((resolve, reject) => { this.first = { resolve, reject }; });
    void this.loop();
    return firstAttempt;
  }

  stop(): void {
    this.stopped = true;
    this.watchState = "stopped";
    this.stream?.close();
    this.wake?.();
  }

  pause(): void { this.stream?.pause(); }
  resume(): void { this.stream?.resume(); }

  private notify(notice: HcNotice): void {
    try { this.options.onNotice?.(notice); } catch { /* a listener never breaks the stream */ }
  }

  private apply(message: HcStreamMessage): void {
    const reduction = reduceHcView(this.current, message);
    this.current = reduction.view;
    for (const notice of reduction.notices) this.notify(notice);
  }

  private settleFirst(state: HcWatchState): void {
    this.first?.resolve(state);
    this.first = null;
  }

  private async loop(): Promise<void> {
    const delays = this.options.reconnectDelaysMs ?? RECONNECT_DELAYS_MS;
    let attempt = 0;
    while (!this.stopped) {
      try {
        const { closed } = await this.connectOnce();
        attempt = 0;
        this.watchState = "streaming";
        this.settleFirst("streaming");
        const why = await closed;
        if (this.stopped) return;
        this.notify({ kind: "disconnected", why });
      } catch (err) {
        if (err instanceof HcCoreRefusedError) {
          this.watchState = "refused";
          this.notify({ kind: "refused", refusal: err });
          this.first?.reject(err);
          this.first = null;
          return;
        }
        this.settleFirst("reconnecting");
      }
      if (this.stopped) return;
      this.watchState = "reconnecting";
      const delay = delays[Math.min(attempt++, delays.length - 1)] ?? 1_000;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        this.wake = () => { clearTimeout(timer); resolve(); };
      });
      this.wake = null;
    }
  }

  /** One connection: find the core (starting it when its socket is stale or gone, as after a reboot, and never when one may
   *  be alive and slow), verify it, subscribe. Resolves with a
   *  promise of why the stream ended, inside an object so it is not awaited. */
  private async connectOnce(): Promise<{ closed: Promise<string> }> {
    const { socketPath } = this.options;
    const helloTimeoutMs = this.options.helloTimeoutMs ?? HELLO_TIMEOUT_MS;
    let presence = await probeCore(socketPath, { helloTimeoutMs });
    if ((presence.state === "stale_socket" || presence.state === "absent") && this.options.startCore) {
      await this.options.startCore();
      this.notify({ kind: "core_started" });
      const settleMs = this.options.startSettleMs ?? 5_000;
      for (let waited = 0; presence.state !== "present" && waited <= settleMs; waited += 100) {
        presence = await probeCore(socketPath, { helloTimeoutMs });
        if (presence.state !== "present") await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (presence.state !== "present") {
      throw new HcUnavailableError(`hc core ${presence.state.replace("_", " ")} at ${socketPath}`);
    }
    // Re-verify core id and generation after any start: nothing restarts a killed core, and a swapped one is another core.
    verifyHello(presence.hello, { ...this.options.pin, coreId: this.coreId });
    this.coreId ??= presence.hello.core.id;

    const generation = ++this.generation;
    let resolveClosed: (why: string) => void = () => undefined;
    const closed = new Promise<string>((resolve) => { resolveClosed = resolve; });
    const heartbeatMs = this.options.heartbeatTimeoutMs ?? HC_HEARTBEAT_TIMEOUT_MS;
    let watchdog: NodeJS.Timeout | null = null;
    let live: OpenStream | null = null;
    let ended = false;
    const end = (why: string) => {
      if (ended) return;
      ended = true;
      if (watchdog) clearTimeout(watchdog);
      resolveClosed(why);
    };
    const handlers: StreamHandlers = {
      onSnapshot: (seq, terminals) => {
        // A new connection's seq counts from its own start: the snapshot replaces the view, seq included.
        this.apply({ kind: "snapshot", seq, terminals });
      },
      onNotification: (method, params) => this.onNotification(generation, method, params),
      onActivity: () => {
        if (watchdog) clearTimeout(watchdog);
        watchdog = setTimeout(() => {
          this.notify({ kind: "stream_dead", why: `no heartbeat or event in ${heartbeatMs} ms` });
          live?.close();
          end(`no heartbeat or event in ${heartbeatMs} ms`);
        }, heartbeatMs);
      },
      onClose: (why) => end(why),
    };
    const stream = await openStream(socketPath, this.options.labels ? { labels: this.options.labels } : {}, helloTimeoutMs, handlers).catch((err: unknown) => {
      if (err instanceof HcError && err.kind === "unsupported_generation") throw new HcCoreRefusedError(err.message, "unsupported_generation");
      throw err;
    });
    try {
      verifyHello(stream.hello, { ...this.options.pin, coreId: this.coreId });
    } catch (err) {
      stream.close();
      if (watchdog) clearTimeout(watchdog);
      throw err;
    }
    live = stream;
    this.stream = stream;
    this.notify({ kind: "connected", coreId: stream.hello.core.id, version: stream.hello.version });
    return { closed };  // wrapped: an async function would otherwise wait for the promise it returns
  }

  private onNotification(generation: number, method: string, params: unknown): void {
    if (generation !== this.generation) return;
    if (!isRecord(params)) return;
    if (method === "event" && typeof params.seq === "number" && typeof params.type === "string" && typeof params.terminal === "string") {
      this.apply({ kind: "event", seq: params.seq, type: params.type, terminal: params.terminal, data: params.data });
      if (this.current.stale.size > 0) void this.refreshStale(generation);
    } else if (method === "missed" && typeof params.seq === "number" && Array.isArray(params.terminals)) {
      this.apply({ kind: "missed", seq: params.seq, terminals: params.terminals as HcViewTerminal[] });
    }
    // `heartbeat` only feeds the watchdog (onActivity). Its seq is global, so it says nothing about a filtered view.
  }

  private async refreshStale(generation: number): Promise<void> {
    const client = new HcClient(this.options.socketPath, undefined, false);
    for (const address of [...this.current.stale]) {
      try {
        const terminal = await client.call<HcViewTerminal>("terminal.get", { terminal: address });
        if (generation === this.generation) this.apply({ kind: "refreshed", terminal });
      } catch (err) {
        if (err instanceof HcError && err.kind === "not_found" && generation === this.generation) this.apply({ kind: "gone", address });
        // anything else: the stream's own failure handling reconnects and the snapshot replaces the view
      }
    }
  }
}

export interface ConnectHcCoreOptions {
  socketPath: string;
  log?: (message: string) => void;
  /** Test runs set OPENRIG_HC_NO_START_CORE=1: a suite must never start a core under a scratch HOME and leave it. */
  env?: NodeJS.ProcessEnv;
  startCore?: () => Promise<void>;
  pin?: Pick<HcCorePin, "versions">;
  firstAttemptMs?: number;
  /** The daemon's own client. A refusal after the first attempt (a core upgraded, swapped or restarted onto another version
   *  under a running daemon) makes its calls fail as an unavailable core instead of going on talking to a core this build was
   *  not written for. */
  client?: Pick<HcClient, "refuseCore">;
}

/** Make every later `hello` to this socket (every `call`, attach and size watch of this build) pass the pin, not only the first:
 *  a core swapped for another version or another core id after startup is refused as an HcError of the same kind, so a read of
 *  "absent" from the wrong core can never be taken for the seat's. The core id is the one the watch saw first (none yet if the
 *  core was down at start: then only the version is checked, until the watch has seen one). Returns the function that lifts it. */
export function pinCallsToCore(socketPath: string, watch: Pick<HcCoreWatch, "pinnedCoreId">, pin: HcCorePin = {}): () => void {
  setHcHelloCheck(socketPath, (hello) => {
    try {
      verifyHello(hello, { ...pin, coreId: watch.pinnedCoreId() });
    } catch (err) {
      if (err instanceof HcCoreRefusedError) throw new HcError(err.message, err.kind, -32000);
      throw err;
    }
  });
  return () => setHcHelloCheck(socketPath, null);
}

/** The daemon's link to the seat host: pins the core's generation and version at startup and keeps watching. A refused core
 *  stops the daemon's start, here, before any seat is touched. A core that is simply down is not refused: the watch keeps
 *  trying, seats read transport_unavailable, and nothing is archived (OF-177). */
export async function connectHcCore(options: ConnectHcCoreOptions): Promise<HcCoreWatch> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((message: string) => console.warn(`[hc] ${message}`));
  const startCore = env.OPENRIG_HC_NO_START_CORE === "1" ? undefined : options.startCore ?? startCoreWithCli({ env });
  const watch = new HcCoreWatch({
    socketPath: options.socketPath,
    ...(startCore ? { startCore } : {}),
    ...(options.pin ? { pin: options.pin } : {}),
    onNotice: (notice) => {
      if (notice.kind === "refused") options.client?.refuseCore(notice.refusal.message);
      // A refusal is not a loss of the core and a loss is not "gone": the log line says which.
      log(JSON.stringify(notice.kind === "refused" ? { kind: "refused", why: notice.refusal.message, refusalKind: notice.refusal.kind } : notice));
    },
  });
  let timer: NodeJS.Timeout | undefined;
  const firstAttemptOver = new Promise<void>((resolve) => { timer = setTimeout(resolve, options.firstAttemptMs ?? 15_000); });
  try {
    await Promise.race([watch.start(), firstAttemptOver]);
  } finally {
    clearTimeout(timer);
  }
  return watch;
}
