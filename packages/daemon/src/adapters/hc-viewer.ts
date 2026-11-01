import { createConnection, type Socket } from "node:net";
import { HcAttach, type HcAttachEnd, type HcAttachOpener, type HcAttachment } from "./hc-attach.js";
import { HC_GENERATION, HcClient, HcError, HcUnavailableError, resolveHcSocket, type HcHello, type HcTerminal } from "./hc-client.js";
import { HC_HEARTBEAT_TIMEOUT_MS } from "./hc-core-watch.js";
import { HcCapture } from "./hc-capture.js";
import { ModeTracker, type TerminalModes } from "./hc-modes.js";
import { hcTerminalRef, isAbsentFailure, isHcFailure } from "./hc-identity.js";
import type { TmuxClient, TmuxCursorPosition, TmuxResult } from "./tmux.js";

/**
 * The live view of a terminal, on `terminal.attach` instead of `pipe-pane` plus `capture-pane`.
 *
 * Sources: "spike 3" is spike-hc-3-20261031.md (measured on hc 0.1.15, Linux, stubs); "w14" is what hc-viewer.real.test.ts
 * measured against a private core. Nothing here touched Jim's core or the app.
 *
 * - A viewer is an OBSERVER. A reader that is not one resizes the program and the last to attach or type wins (spike 3), so
 *   the broker's fixed 90x27 pin has no equivalent. The view FOLLOWS the terminal's size instead: the attach reply gives it
 *   at attach, and the `size` event (`{cols, rows}`, w14) gives every change. The stream carries no resize notice.
 * - Observer keystrokes are dropped without an error (spike 3). A person's keys and text go in by `terminal.keys` and by a
 *   writer at the terminal's own size, both behind `ViewerInput`.
 * - The first paint of an attach is the snapshot: it holds the escapes, the program's modes and the cursor, which
 *   `terminal.read` never gives (design gap 3). Each viewer attaches for itself, so a late viewer gets its own paint, and
 *   credit is granted per socket on receipt (hc-attach.ts), so one slow browser cannot stall another.
 * - A slow viewer loses scrolled bytes and is brought back to a true screen (spike 3). Nothing that needs every byte may
 *   read a view: use `terminal.read` or the runtime's files.
 * - A core restart is a plain EOF with no CLOSE (spike 3): the view attaches again, and says so with `onPaint`.
 */

export interface ViewSize { cols: number; rows: number }

// Kept importable from here: the stream session and the tests name them through the viewer.
export { ModeTracker, fullScreenHistoryReadIsUnsafe, type TerminalModes } from "./hc-modes.js";

export type ViewEnd =
  /** The program ended: the CLOSE frame's facts, or the terminal's own when it had finished before the attach. */
  | { reason: "program_ended"; exitCode: number | null; signal: number | null; endReason: string | null; finishedMs: number | null }
  /** The terminal is not there (hc said `not_found`), as opposed to the core not being reachable. */
  | { reason: "absent" }
  /** The core could not be reached, or was lost and did not come back within the reconnect delays. */
  | { reason: "unavailable"; cause: string };

export interface ViewHandlers {
  /** A fresh paint is about to arrive (the first attach, a repaint, or after a core restart): drop any half-read character. */
  onPaint(): void;
  /** The terminal's size, before the first byte of a view's first paint and whenever it changes. */
  onSize(size: ViewSize): void;
  /** The terminal's bytes in order, first paint included. A frame may split a multibyte character. */
  onData(bytes: Buffer): void;
  /** The view ended for good (never called for our own `close()`). */
  onEnd(end: ViewEnd): void;
}

export interface HcLiveView {
  /** The terminal's size as last seen. */
  size(): ViewSize;
  /** The private modes the stream has set, for deciding whether a history read is safe (see `fullScreenHistoryReadIsUnsafe`). */
  modes(): TerminalModes;
  /** Attach again now and have a fresh paint delivered. True once the new attach is open, false if the view ended instead. */
  repaint(): Promise<boolean>;
  close(): Promise<void>;
}

export type ViewOpen =
  | { ok: true; view: HcLiveView }
  | { ok: false; end: ViewEnd };

// ---- the cursor, read from the stream (the modes are in hc-modes.ts) ------------------------------------------------

const CURSOR_POSITION = /\x1b\[(\d*)(?:;(\d*))?H/g;

/** Where the first paint leaves the cursor: its last absolute move (spike 3: the paint ends with the cursor move). Zero-based
 *  as tmux's `#{cursor_x}`; null when the paint holds none. */
export function cursorOfPaint(paint: string): { x: number; y: number } | null {
  let last: RegExpMatchArray | null = null;
  for (const match of paint.matchAll(CURSOR_POSITION)) last = match;
  if (!last) return null;
  const row = Number(last[1] || "1");
  const column = Number(last[2] || "1");
  return { x: Math.max(0, column - 1), y: Math.max(0, row - 1) };
}

// ---- following the size ----------------------------------------------------------------------------------------------

export interface SizeWatch { close(): void }

export interface SizeHandlers {
  size(size: ViewSize): void;
  /** The line to the core died or went quiet: the size can no longer be followed. */
  lost(cause: string): void;
}

/** Where a terminal's size changes come from. */
export interface SizeSource {
  /** `terminal` is an hc address, which is what the events name it by. Rejects with the hc errors when the terminal is not
   *  there or the core cannot be reached. Gives the current size first. */
  watch(terminal: string, handlers: SizeHandlers): Promise<SizeWatch>;
}

interface RpcLine { id?: number; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: { kind?: string; hint?: string } } }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isDimension = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0;

/** `events.subscribe` on one terminal over a plain connection of its own: the snapshot's size, then each `size` event
 *  (`{cols, rows}`, w14). The core's heartbeat (every 15 s, also on a filtered subscription, w14) is the watchdog. */
export class CoreSizeSource implements SizeSource {
  constructor(
    private readonly socketPath: string = resolveHcSocket(),
    private readonly options: { timeoutMs?: number; heartbeatTimeoutMs?: number } = {},
  ) {}

  watch(terminal: string, handlers: SizeHandlers): Promise<SizeWatch> {
    const timeoutMs = this.options.timeoutMs ?? 10_000;
    const heartbeatMs = this.options.heartbeatTimeoutMs ?? HC_HEARTBEAT_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const socket: Socket = createConnection(this.socketPath);
      socket.setEncoding("utf8");
      let buffer = "";
      let phase: "connecting" | "hello" | "subscribe" | "streaming" = "connecting";
      let done = false;
      let timer: NodeJS.Timeout | null = null;
      const clear = (): void => { if (timer) { clearTimeout(timer); timer = null; } };
      const fail = (err: Error): void => {
        if (done) return;
        done = true;
        clear();
        socket.destroy();
        reject(err);
      };
      const arm = (what: string): void => {
        clear();
        timer = setTimeout(() => fail(new HcUnavailableError(`${what}: no reply in ${timeoutMs} ms`)), timeoutMs);
      };
      const lose = (cause: string): void => {
        if (done) return;
        done = true;
        clear();
        socket.destroy();
        handlers.lost(cause);
      };
      const quiet = (): void => {
        clear();
        timer = setTimeout(() => lose(`no heartbeat or event in ${heartbeatMs} ms`), heartbeatMs);
      };
      const send = (id: number, method: string, params: Record<string, unknown>): void => {
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      };
      const watch: SizeWatch = { close: () => { done = true; clear(); socket.destroy(); } };

      socket.once("connect", () => {
        phase = "hello";
        arm("hello");
        send(1, "hello", { generation: HC_GENERATION, framed: false });
      });
      socket.on("error", (err) => {
        if (phase === "streaming") return;  // close follows
        fail(new HcUnavailableError(`hc core not reachable at ${this.socketPath}: ${err.message}`, err));
      });
      socket.on("close", () => {
        if (phase === "streaming") lose("the core closed the connection");
        else fail(new HcUnavailableError(`the core closed the connection during ${phase}`));
      });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
          const raw = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          if (!raw.trim() || done) continue;
          let line: RpcLine;
          try {
            line = JSON.parse(raw) as RpcLine;
          } catch {
            if (phase === "streaming") lose("the core sent a line that is not JSON");
            else fail(new HcUnavailableError("the core sent a line that is not JSON"));
            return;
          }
          if (phase === "streaming") {
            quiet();
            if (line.method === "event" && isRecord(line.params) && line.params.type === "size" && line.params.terminal === terminal && isRecord(line.params.data)) {
              const { cols, rows } = line.params.data;
              if (isDimension(cols) && isDimension(rows)) handlers.size({ cols, rows });
            }
            continue;
          }
          if (line.error) {
            const { code, message, data } = line.error;
            fail(new HcError(message, data?.kind ?? "unknown", code, data?.hint));
            return;
          }
          if (phase === "hello" && line.id === 1) {
            const hello = line.result as HcHello;
            if (hello.generation !== HC_GENERATION) {
              fail(new HcError(`core speaks generation ${hello.generation}, this build ${HC_GENERATION}`, "unsupported_generation", -32000));
              return;
            }
            phase = "subscribe";
            arm("events.subscribe");
            send(2, "events.subscribe", { terminal });
          } else if (phase === "subscribe" && line.id === 2) {
            clear();
            phase = "streaming";
            quiet();
            const terminals = isRecord(line.result) && Array.isArray(line.result.terminals) ? line.result.terminals : [];
            const first = terminals[0];
            if (isRecord(first) && isDimension(first.cols) && isDimension(first.rows)) handlers.size({ cols: first.cols, rows: first.rows });
            resolve(watch);
          }
        }
      });
    });
  }
}

// ---- the viewer ------------------------------------------------------------------------------------------------------

/** How a person's typing in the viewer reaches the terminal. An observer's own input is dropped by the core, so this is
 *  separate: HcInput's `sendKeys` and `sendText` with `blocked: "allow"` (a person may answer a dialog). It is injected so
 *  the one sender of a person's text stays where the typed-text census (a5) classifies it. */
export interface ViewerInput {
  keys(name: string, keys: string[]): Promise<TmuxResult>;
  paste(name: string, text: string): Promise<TmuxResult>;
  /** The delivery guard's mark that a person is typing. */
  humanInput?<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

export interface HcViewerOptions {
  socketPath?: string;
  client?: HcClient;
  opener?: HcAttachOpener;
  sizes?: SizeSource;
  /** Plain-text history, for the scroll-back window. */
  capture?: Pick<HcCapture, "capturePaneContent">;
  input?: ViewerInput;
  /** Waits between attempts to attach again after the core was lost; the view ends `unavailable` after the last. */
  reconnectDelaysMs?: readonly number[];
  /** First-paint collection for `snapshot`: quiet time after the last frame, the longest after the first, the longest to wait for any. */
  paintSettleMs?: number;
  paintMaxMs?: number;
  paintFirstMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** An observer attach asks for a size and is given the terminal's own (spike 3), so the ask is nominal. */
const OBSERVER_ASK: ViewSize = { cols: 80, rows: 24 };
const DEFAULT_RECONNECT_DELAYS_MS: readonly number[] = [200, 400, 800, 1_600, 3_200, 3_200];

/** The thing this module does not do, said as an error: a caller that hits it must not read it as "none". */
export class HcViewerUnsupportedError extends Error {
  constructor(what: string, readonly why: string) {
    super(`${what}: ${why}`);
    this.name = "HcViewerUnsupportedError";
  }
}

export class HcViewer {
  private readonly client: HcClient;
  private readonly opener: HcAttachOpener;
  private readonly sizes: SizeSource;
  private readonly capture: Pick<HcCapture, "capturePaneContent">;
  private readonly input: ViewerInput | undefined;
  private readonly delays: readonly number[];
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly paint: { settleMs: number; maxMs: number; firstMs: number };

  constructor(options: HcViewerOptions = {}) {
    const socketPath = options.socketPath ?? resolveHcSocket();
    this.client = options.client ?? new HcClient(socketPath);
    this.opener = options.opener ?? new HcAttach(socketPath);
    this.sizes = options.sizes ?? new CoreSizeSource(socketPath);
    this.capture = options.capture ?? new HcCapture(this.client);
    this.input = options.input;
    this.delays = options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.paint = { settleMs: options.paintSettleMs ?? 40, maxMs: options.paintMaxMs ?? 400, firstMs: options.paintFirstMs ?? 1_500 };
  }

  get humanInput(): ViewerInput["humanInput"] {
    return this.input?.humanInput?.bind(this.input);
  }

  // ---- what the terminal session broker drives ----

  /** Watch a terminal as an observer, following its size and surviving a core restart. The target is a seat's canonical
   *  name, a tmux exact form of it, or an hc address (hcTerminalRef). */
  async view(target: string, handlers: ViewHandlers): Promise<ViewOpen> {
    const ref = hcTerminalRef(target);
    if (ref === null) return { ok: false, end: { reason: "absent" } };
    const following = new Following({ opener: this.opener, sizes: this.sizes, client: this.client, delays: this.delays, sleep: this.sleep }, ref, handlers);
    const first = await following.start();
    return first === null ? { ok: true, view: following } : { ok: false, end: first };
  }

  /** The last `lines` of history and the screen as plain text (`terminal.read`). Callers decide whether the read is safe:
   *  see `fullScreenHistoryReadIsUnsafe`. */
  readHistory(target: string, lines: number): Promise<string | null> {
    return this.capture.capturePaneContent(target, lines);
  }

  async pressKeys(name: string, keys: string[]): Promise<TmuxResult> {
    if (!this.input) return { ok: false, code: "input_unavailable", message: "this viewer was built without a way to type" };
    return this.input.keys(name, keys);
  }

  async pasteText(name: string, text: string): Promise<TmuxResult> {
    if (!this.input) return { ok: false, code: "input_unavailable", message: "this viewer was built without a way to type" };
    return this.input.paste(name, text);
  }

  // ---- the tmux adapter's viewer methods ----

  /** The terminal's first paint as an observer sees it, and its size. Null when it is not there or cannot be reached. */
  async snapshot(target: string): Promise<{ paint: Buffer; cols: number; rows: number } | null> {
    const ref = hcTerminalRef(target);
    if (ref === null) return null;
    const painted = new PaintCollector(this.paint);
    let attachment: HcAttachment;
    try {
      attachment = await this.opener.open({ terminal: ref, ...OBSERVER_ASK, observe: true }, { onData: (bytes) => painted.add(bytes), onEnd: () => painted.stop() });
    } catch (err) {
      painted.stop();
      if (isHcFailure(err)) return null;
      throw err;
    }
    try {
      if (!(await painted.settled())) return null;
      return { paint: painted.bytes(), cols: attachment.terminal.cols, rows: attachment.terminal.rows };
    } finally {
      painted.stop();
      await attachment.detach();
    }
  }

  /** tmux: `display-message '#{cursor_x} #{cursor_y} ...'`. Here the cursor is where the first paint leaves it (zero-based, as
   *  tmux), the geometry the terminal's. Null when it is not there, cannot be reached, or the paint states no cursor. */
  async getPaneCursorPosition(paneId: string): Promise<TmuxCursorPosition | null> {
    const snap = await this.snapshot(paneId);
    if (!snap) return null;
    const cursor = cursorOfPaint(snap.paint.toString("latin1"));
    if (!cursor || snap.cols < 1 || snap.rows < 1) return null;
    return { x: cursor.x, y: cursor.y, width: snap.cols, height: snap.rows };
  }

  /** tmux: `pipe-pane -t <pane> 'cat >> file'`. DECISION: not provided. The one caller was the terminal session broker (four
   *  sites), which now reads the stream itself; a file sink would hide the gaps a slow reader leaves (spike 3), and what
   *  needs every byte reads `terminal.read` or the runtime's files. */
  async startPipePane(sessionName: string, outputPath: string): Promise<TmuxResult> {
    void outputPath;
    return { ok: false, code: "unsupported", message: `hc has no pipe-pane: watch ${sessionName} with the viewer (terminal.attach as an observer)` };
  }

  /** tmux: `pipe-pane -t <pane>` with no command stops the pipe. No pipe is ever started here, so stopping succeeds. */
  async stopPipePane(sessionName: string): Promise<TmuxResult> {
    void sessionName;
    return { ok: true };
  }

  /** tmux: `resize-window -x -y`, which pins the window. DECISION: not provided. hc has no resize method: a terminal is
   *  sized by its viewers (born 200x120, the last to attach or type wins, and it returns to 200x120 when the last writer
   *  leaves; spike 3), so a pin cannot be held. The broker follows the size instead. The tmux adapter's own argument
   *  checks are kept, so a bad call reads the same. */
  async resizeWindow(target: string, cols: number, rows: number): Promise<TmuxResult> {
    if (!Number.isFinite(cols) || !Number.isInteger(cols) || cols < 1) {
      return { ok: false, code: "validation_error", message: `resizeWindow: cols must be a positive integer, got ${cols}` };
    }
    if (!Number.isFinite(rows) || !Number.isInteger(rows) || rows < 1) {
      return { ok: false, code: "validation_error", message: `resizeWindow: rows must be a positive integer, got ${rows}` };
    }
    return { ok: false, code: "unsupported", message: `hc cannot pin the size of ${target}: a terminal takes the size of its viewers` };
  }

  /** tmux: `list-clients`, the human terminals attached to the server. DECISION: it throws, and does not answer `[]`. hc has no
   *  list of attached clients (none among its methods), and an empty list would read as "nobody is attached" to the one
   *  caller, seat-switch-client-service, which would then tell the operator to run `tmux attach`. What `rig seat
   *  switch-client` becomes (removed, or focus by the app's `herdr-app do`, whose verb is unverified) is a product call. */
  async listClients(): Promise<TmuxClient[]> {
    throw new HcViewerUnsupportedError("listClients", "hc has no list of attached clients; the Herdr app shows seats by label");
  }

  /** tmux: `switch-client -c <client> -t <target>`. DECISION: not provided, for the reason `listClients` gives. */
  async switchClient(client: string, target: string): Promise<TmuxResult> {
    void client;
    return { ok: false, code: "unsupported", message: `hc has no client to retarget to ${target}; the Herdr app shows seats by label` };
  }
}

// ---- one following view ----------------------------------------------------------------------------------------------

interface FollowingDeps {
  opener: HcAttachOpener;
  sizes: SizeSource;
  client: HcClient;
  delays: readonly number[];
  sleep: (ms: number) => Promise<void>;
}

type Attempt =
  | { kind: "ok" }
  | { kind: "superseded" }
  | { kind: "ended"; end: ViewEnd }
  | { kind: "unavailable"; cause: string };

const sameSize = (a: ViewSize | null, b: ViewSize): boolean => a !== null && a.cols === b.cols && a.rows === b.rows;

class Following implements HcLiveView {
  private attachment: HcAttachment | null = null;
  private watch: SizeWatch | null = null;
  /** Bumped by every attach: frames, ends and sizes of an older one are dropped. */
  private generation = 0;
  private last: ViewSize | null = null;
  private readonly tracker = new ModeTracker();
  private closed = false;
  private ended = false;
  private recovering: Promise<boolean> | null = null;

  constructor(private readonly deps: FollowingDeps, private readonly terminal: string, private readonly handlers: ViewHandlers) {}

  /** The first attach, with no retry: null when open, else why it did not. */
  async start(): Promise<ViewEnd | null> {
    const attempt = await this.attachOnce();
    if (attempt.kind === "ok") return null;
    if (attempt.kind === "ended") return attempt.end;
    this.ended = true;
    return { reason: "unavailable", cause: attempt.kind === "unavailable" ? attempt.cause : "closed" };
  }

  size(): ViewSize {
    return this.last ?? { cols: OBSERVER_ASK.cols, rows: OBSERVER_ASK.rows };
  }

  modes(): TerminalModes {
    return this.tracker.modes();
  }

  repaint(): Promise<boolean> {
    if (this.closed || this.ended) return Promise.resolve(false);
    return this.recover();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.generation++;
    this.watch?.close();
    this.watch = null;
    const attachment = this.attachment;
    this.attachment = null;
    await attachment?.detach();
  }

  private guard(call: () => void): void {
    try { call(); } catch { /* a listener never breaks the stream */ }
  }

  private async attachOnce(): Promise<Attempt> {
    const generation = ++this.generation;
    this.watch?.close();
    this.watch = null;
    this.tracker.reset();
    const early: Buffer[] = [];
    let open = false;
    const onData = (bytes: Buffer): void => {
      if (generation !== this.generation || this.closed) return;
      this.tracker.feed(bytes);
      if (open) this.guard(() => this.handlers.onData(bytes));
      else early.push(bytes);  // the first paint can arrive with the reply, before the size is known
    };
    let attachment: HcAttachment;
    try {
      attachment = await this.deps.opener.open(
        { terminal: this.terminal, ...OBSERVER_ASK, observe: true },
        { onData, onEnd: (end) => this.attachEnded(generation, end) },
      );
    } catch (err) {
      return this.classify(err);
    }
    if (generation !== this.generation || this.closed) {
      void attachment.detach();
      return { kind: "superseded" };
    }
    const previous = this.attachment;
    this.attachment = attachment;
    if (previous) void previous.detach(500);
    this.guard(() => this.handlers.onPaint());
    this.report(attachment.terminal);
    open = true;
    for (const bytes of early) this.guard(() => this.handlers.onData(bytes));
    void this.follow(generation, attachment.terminal.address);
    return { kind: "ok" };
  }

  private report(size: ViewSize): void {
    if (sameSize(this.last, size)) return;
    this.last = { cols: size.cols, rows: size.rows };
    this.guard(() => this.handlers.onSize({ cols: size.cols, rows: size.rows }));
  }

  private async follow(generation: number, address: string): Promise<void> {
    try {
      const watch = await this.deps.sizes.watch(address, {
        size: (size) => { if (generation === this.generation && !this.closed) this.report(size); },
        lost: () => { if (generation === this.generation && !this.closed && !this.ended) void this.recover(); },
      });
      if (generation !== this.generation || this.closed) watch.close();
      else this.watch = watch;
    } catch {
      // The size cannot be followed, and a viewer that cannot follow it would draw a wrong screen: attach again, which
      // finds out whether the terminal is gone or the core is.
      if (generation === this.generation && !this.closed && !this.ended) void this.recover();
    }
  }

  private attachEnded(generation: number, end: HcAttachEnd): void {
    if (generation !== this.generation || this.closed || this.ended) return;
    if (end.reason === "program_ended") {
      this.finish({ reason: "program_ended", exitCode: end.exitCode, signal: end.signal, endReason: end.endReason, finishedMs: end.finishedMs });
    } else if (end.reason === "core_lost") {
      void this.recover();
    }
  }

  /** Attach again, waiting out a core that is down. Shared: a repaint during a recovery joins it. */
  private recover(): Promise<boolean> {
    if (this.recovering) return this.recovering;
    const run = (async (): Promise<boolean> => {
      for (let attemptNo = 0; ; attemptNo++) {
        if (this.closed || this.ended) return false;
        const attempt = await this.attachOnce();
        if (attempt.kind === "ok") return true;
        if (attempt.kind === "superseded") return false;
        if (attempt.kind === "ended") { this.finish(attempt.end); return false; }
        const delay = this.deps.delays[attemptNo];
        if (delay === undefined) { this.finish({ reason: "unavailable", cause: attempt.cause }); return false; }
        await this.deps.sleep(delay);
      }
    })().finally(() => { this.recovering = null; });
    this.recovering = run;
    return run;
  }

  private finish(end: ViewEnd): void {
    if (this.ended || this.closed) return;
    this.ended = true;
    this.generation++;
    this.watch?.close();
    this.watch = null;
    const attachment = this.attachment;
    this.attachment = null;
    void attachment?.detach(200);
    this.guard(() => this.handlers.onEnd(end));
  }

  private async classify(err: unknown): Promise<Attempt> {
    if (isAbsentFailure(err)) return { kind: "ended", end: { reason: "absent" } };
    if (err instanceof HcError && err.kind === "finished") return { kind: "ended", end: await this.finishedFacts() };
    if (isHcFailure(err)) return { kind: "unavailable", cause: err instanceof HcError ? `hc refused the attach: ${err.kind}` : err.message };
    throw err;
  }

  /** The attach was refused because the terminal had finished: the facts it left. */
  private async finishedFacts(): Promise<ViewEnd> {
    try {
      const terminal = await this.deps.client.call<HcTerminal & { signal?: number | null }>("terminal.get", { terminal: this.terminal });
      return {
        reason: "program_ended", exitCode: terminal.exit_code ?? null, signal: terminal.signal ?? null,
        endReason: terminal.reason ?? null, finishedMs: terminal.finished_ms ?? null,
      };
    } catch (err) {
      if (isAbsentFailure(err)) return { reason: "absent" };
      return { reason: "program_ended", exitCode: null, signal: null, endReason: null, finishedMs: null };
    }
  }
}

/** The first paint of an attach, collected until it has been quiet for `settleMs`, capped at `maxMs` after its first frame;
 *  `settled()` is false if no frame came in `firstMs`. */
class PaintCollector {
  private chunks: Buffer[] = [];
  private first: NodeJS.Timeout | null;
  private quiet: NodeJS.Timeout | null = null;
  private max: NodeJS.Timeout | null = null;
  private seen = false;
  private release!: (seen: boolean) => void;
  private readonly done = new Promise<boolean>((resolve) => { this.release = resolve; });

  constructor(private readonly timing: { settleMs: number; maxMs: number; firstMs: number }) {
    this.first = setTimeout(() => this.release(false), timing.firstMs);
  }

  add(bytes: Buffer): void {
    this.chunks.push(bytes);
    if (!this.seen) {
      this.seen = true;
      if (this.first) clearTimeout(this.first);
      this.max = setTimeout(() => this.release(true), this.timing.maxMs);
    }
    if (this.quiet) clearTimeout(this.quiet);
    this.quiet = setTimeout(() => this.release(true), this.timing.settleMs);
  }

  settled(): Promise<boolean> { return this.done; }

  bytes(): Buffer { return Buffer.concat(this.chunks); }

  stop(): void {
    for (const timer of [this.first, this.quiet, this.max]) if (timer) clearTimeout(timer);
    this.release(this.seen);
  }
}
