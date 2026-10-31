import { createConnection, type Socket } from "node:net";
import { HC_GENERATION, HcError, HcOutcomeUnknownError, HcUnavailableError, resolveHcSocket, type HcTerminal } from "./hc-client.js";

/** The framed layer of hc's socket (spike 3, measured; the schema does not carry it):
 *  `[u32 LE channel][u8 kind][u32 LE length][payload]`. Channel 0 carries framed JSON-RPC; a channel from
 *  `terminal.attach` carries the terminal's bytes. */
export const FRAME_DATA = 0;
export const FRAME_CREDIT = 1;
export const FRAME_CLOSE = 2;
export const FRAME_RESIZE = 3;
const HEADER = 9;
/** The core sends at most 16 KiB per DATA frame (spike 3); a writer stays at that size too. */
export const MAX_DATA_FRAME = 16_384;

export interface HcFrame { channel: number; kind: number; payload: Buffer }

export function encodeFrame(channel: number, kind: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const out = Buffer.alloc(HEADER + payload.length);
  out.writeUInt32LE(channel, 0);
  out.writeUInt8(kind, 4);
  out.writeUInt32LE(payload.length, 5);
  payload.copy(out, HEADER);
  return out;
}

/** Frames split at arbitrary byte offsets (4,095-byte splits seen mid-line): keep what is incomplete. */
export class FrameDecoder {
  private pending: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): HcFrame[] {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    const frames: HcFrame[] = [];
    for (;;) {
      if (this.pending.length < HEADER) break;
      const length = this.pending.readUInt32LE(5);
      if (this.pending.length < HEADER + length) break;
      frames.push({
        channel: this.pending.readUInt32LE(0),
        kind: this.pending.readUInt8(4),
        payload: this.pending.subarray(HEADER, HEADER + length),
      });
      this.pending = this.pending.subarray(HEADER + length);
    }
    return frames;
  }
}

export interface HcAttachParams {
  /** `t7` or a name: hcTerminalName(seat) for a seat. */
  terminal: string;
  cols: number;
  rows: number;
  /** Watch only: never types, never resizes. The core drops an observer's input without an error. */
  observe?: boolean;
  /** Scrollback lines painted first (main screen only). */
  history?: number;
  /** Back after a dropped line: the size is set only once the viewer is active again. */
  resumed?: boolean;
}

/** How a stream ended. `core_lost` is an EOF with no CLOSE (a core restart, spike 1+2 and 3): the program lives, so a
 *  viewer reconnects. `program_ended` is a CLOSE that carries the finish. `detached` answers our own `detach()`. */
export type HcAttachEnd =
  | { reason: "program_ended"; exitCode: number | null; signal: number | null; endReason: string | null; finishedMs: number | null }
  | { reason: "detached" }
  | { reason: "core_lost" }
  /** Only from `detach()`: the core did not answer the CLOSE in time. */
  | { reason: "no_answer" };

export interface HcAttachHandlers {
  /** Every DATA frame in order, the first paint included. Called before the credit for it is granted. */
  onData(bytes: Buffer): void;
  onEnd(end: HcAttachEnd): void;
}

/** One attached stream. A frame may split a multibyte character: a text consumer decodes with a StringDecoder. */
export interface HcAttachment {
  /** The terminal as the attach reply saw it. */
  readonly terminal: HcTerminal;
  readonly observe: boolean;
  /** Bytes typed on the channel. Throws on an observer, whose input the core would drop silently. */
  write(data: Buffer | string): void;
  /** RESIZE on a writer: the last active viewer sets the size (spike 3). Throws on an observer. */
  resize(cols: number, rows: number): void;
  /** CLOSE, then wait for the core's answer so written bytes are not cut off by the socket closing. Resolves to how the
   *  stream ended: `detached` is the core's answer, which proves it read every byte written before the CLOSE. Idempotent. */
  detach(timeoutMs?: number): Promise<HcAttachEnd>;
}

export interface HcAttachOpener {
  open(params: HcAttachParams, handlers: HcAttachHandlers): Promise<HcAttachment>;
}

const DEFAULT_TIMEOUT_MS = 10_000;

interface Reply { id?: number; result?: unknown; error?: { code: number; message: string; data?: { kind?: string; hint?: string } } }

/** Opens framed attach channels. One socket per attachment: a writer's size ownership and a slow reader's credit never
 *  mix with another viewer's. Credit is granted on receipt of a frame, not when the consumer is done with it (spike 3:
 *  one slow browser must not stall the stream for the others, and an unacknowledged 256 KiB window stalls it). */
export class HcAttach implements HcAttachOpener {
  constructor(private readonly socketPath: string = resolveHcSocket(), private readonly timeoutMs = DEFAULT_TIMEOUT_MS) {}

  async open(params: HcAttachParams, handlers: HcAttachHandlers): Promise<HcAttachment> {
    const socket = await this.connect();
    try {
      const wire = new Wire(socket, handlers);
      await wire.hello(this.timeoutMs);
      const result = await wire.attach({
        terminal: params.terminal, cols: params.cols, rows: params.rows,
        observe: params.observe ?? false, history: params.history ?? 0, resumed: params.resumed ?? false,
      }, this.timeoutMs);
      return wire.attachment(result.channel, result.terminal, params.observe ?? false);
    } catch (err) {
      socket.destroy();
      throw err;
    }
  }

  private connect(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      socket.once("connect", () => { socket.removeAllListeners("error"); resolve(socket); });
      socket.once("error", (err) => reject(new HcUnavailableError(`hc core not reachable at ${this.socketPath}: ${err.message}`, err)));
    });
  }
}

class Wire {
  private bytes: Buffer = Buffer.alloc(0);
  private framed = false;
  private readonly decoder = new FrameDecoder();
  private reply: { id: number; method: string; resolve: (r: Reply) => void; fail: (reason: string) => void; timer: NodeJS.Timeout } | null = null;
  private nextId = 1;
  private channel: number | null = null;
  private ended = false;
  private detaching: { done: (end: HcAttachEnd) => void } | null = null;

  constructor(private readonly socket: Socket, private readonly handlers: HcAttachHandlers) {
    socket.on("data", (chunk: Buffer) => this.onBytes(chunk));
    socket.on("error", () => {});
    socket.on("close", () => this.onGone());
  }

  async hello(timeoutMs: number): Promise<void> {
    let reply: Reply;
    try {
      reply = await this.request("hello", { generation: HC_GENERATION, framed: true }, timeoutMs);
    } catch (err) {
      if (err instanceof HcOutcomeUnknownError) throw new HcUnavailableError(err.message, err);  // hello changes nothing
      throw err;
    }
    const hello = reply as unknown as { generation: number; framed: boolean };
    if (hello.generation !== HC_GENERATION) {
      throw new HcError(`core speaks generation ${hello.generation}, this build ${HC_GENERATION}`, "unsupported_generation", -32000);
    }
    if (!hello.framed) throw new HcError("the core did not switch to framed mode", "needs_framed", -32000);
    this.framed = true;
    // Bytes that came with the hello line are already frames.
    const rest = this.bytes;
    this.bytes = Buffer.alloc(0);
    if (rest.length) this.onFrames(this.decoder.push(rest));
  }

  async attach(params: Record<string, unknown>, timeoutMs: number): Promise<{ channel: number; terminal: HcTerminal }> {
    // The channel is learned inside the reply handler, not after it resolves: the first paint can arrive in the same
    // chunk as the reply, and a frame for a channel not yet known would be dropped.
    const result = await this.request("terminal.attach", params, timeoutMs, (r) => { this.channel = (r as unknown as { channel: number }).channel; });
    return result as unknown as { channel: number; terminal: HcTerminal };
  }

  attachment(channel: number, terminal: HcTerminal, observe: boolean): HcAttachment {
    const refuse = (what: string): never => { throw new Error(`${what} on an observer channel is dropped by the core`); };
    return {
      terminal,
      observe,
      write: (data) => {
        if (observe) refuse("input");
        const buffer = typeof data === "string" ? Buffer.from(data, "utf8") : data;
        for (let at = 0; at < buffer.length; at += MAX_DATA_FRAME) {
          this.send(encodeFrame(channel, FRAME_DATA, buffer.subarray(at, at + MAX_DATA_FRAME)));
        }
      },
      resize: (cols, rows) => {
        if (observe) refuse("a resize");
        const payload = Buffer.alloc(4);
        payload.writeUInt16LE(cols, 0);
        payload.writeUInt16LE(rows, 2);
        this.send(encodeFrame(channel, FRAME_RESIZE, payload));
      },
      detach: (timeoutMs = 2_000) => this.detach(channel, timeoutMs),
    };
  }

  private send(frame: Buffer): void {
    if (this.ended || this.socket.destroyed) throw new HcUnavailableError("the attach channel is closed");
    this.socket.write(frame);
  }

  private concluded: HcAttachEnd | null = null;

  private detach(channel: number, timeoutMs: number): Promise<HcAttachEnd> {
    if (this.concluded) { this.socket.destroy(); return Promise.resolve(this.concluded); }
    return new Promise((resolve) => {
      const finish = (end: HcAttachEnd): void => { clearTimeout(timer); this.detaching = null; this.concluded ??= end; this.socket.destroy(); resolve(end); };
      const timer = setTimeout(() => finish({ reason: "no_answer" }), timeoutMs);
      this.detaching = { done: finish };
      try { this.socket.write(encodeFrame(channel, FRAME_CLOSE)); } catch { finish({ reason: "core_lost" }); }
    });
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs: number, onResult?: (result: Reply) => void): Promise<Reply> {
    return new Promise<Reply>((resolve, reject) => {
      const id = this.nextId++;
      const fail = (reason: string): void => { reject(new HcOutcomeUnknownError(`${method}: ${reason}`, method)); };
      const timer = setTimeout(() => { this.reply = null; fail(`no reply in ${timeoutMs} ms`); }, timeoutMs);
      this.reply = {
        id, method, fail,
        resolve: (reply) => {
          if (reply.error) {
            const { code, message, data } = reply.error;
            reject(new HcError(message, data?.kind ?? "unknown", code, data?.hint));
          } else {
            const result = (reply.result ?? {}) as Reply;
            onResult?.(result);
            resolve(result);
          }
        },
        timer,
      };
      const line = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n", "utf8");
      // After hello the same request travels as a frame on channel 0.
      this.socket.write(this.framed ? encodeFrame(0, FRAME_DATA, line.subarray(0, line.length - 1)) : line);
    });
  }

  private onBytes(chunk: Buffer): void {
    if (this.framed) {
      this.onFrames(this.decoder.push(chunk));
      return;
    }
    this.bytes = Buffer.concat([this.bytes, chunk]);
    const end = this.bytes.indexOf(0x0a);
    if (end < 0) return;
    const line = this.bytes.subarray(0, end).toString("utf8");
    this.bytes = this.bytes.subarray(end + 1);
    this.onReply(line);
  }

  private onFrames(frames: HcFrame[]): void {
    for (const frame of frames) {
      if (frame.channel === 0) {
        if (frame.kind === FRAME_DATA) this.onReply(frame.payload.toString("utf8"));
      } else if (frame.channel === this.channel) {
        this.onChannel(frame);
      }
    }
  }

  private onReply(line: string): void {
    const pending = this.reply;
    if (!pending || !line.trim()) return;
    let reply: Reply;
    try { reply = JSON.parse(line) as Reply; } catch { return; }
    if (reply.id !== pending.id) return;  // a notification, not this reply
    this.reply = null;
    clearTimeout(pending.timer);
    pending.resolve(reply);
  }

  private onChannel(frame: HcFrame): void {
    if (frame.kind === FRAME_DATA) {
      this.handlers.onData(frame.payload);
      const credit = Buffer.alloc(4);
      credit.writeUInt32LE(frame.payload.length, 0);
      try { this.socket.write(encodeFrame(frame.channel, FRAME_CREDIT, credit)); } catch { /* the socket is going */ }
    } else if (frame.kind === FRAME_CLOSE) {
      if (frame.payload.length === 0) {
        // The core's answer to our CLOSE.
        if (this.detaching) this.finish({ reason: "detached" });
        return;
      }
      this.finish(parseClose(frame.payload));
    }
  }

  private finish(end: HcAttachEnd): void {
    if (this.ended) return;
    this.ended = true;
    this.concluded = end;
    this.handlers.onEnd(end);
    this.detaching?.done(end);
  }

  private onGone(): void {
    if (this.reply) {
      const pending = this.reply;
      this.reply = null;
      clearTimeout(pending.timer);
      pending.fail("the core closed the connection");
    }
    this.finish({ reason: "core_lost" });
    if (this.concluded) this.detaching?.done(this.concluded);
  }
}

function parseClose(payload: Buffer): HcAttachEnd {
  try {
    const body = JSON.parse(payload.toString("utf8")) as { exit_code?: number | null; signal?: number | null; reason?: string | null; finished_ms?: number | null };
    return { reason: "program_ended", exitCode: body.exit_code ?? null, signal: body.signal ?? null, endReason: body.reason ?? null, finishedMs: body.finished_ms ?? null };
  } catch {
    return { reason: "program_ended", exitCode: null, signal: null, endReason: null, finishedMs: null };
  }
}
