import { StringDecoder } from "node:string_decoder";
import { fullScreenHistoryReadIsUnsafe, type HcLiveView, type ViewEnd, type ViewHandlers, type ViewOpen } from "../adapters/hc-viewer.js";
import type { TmuxResult } from "../adapters/tmux.js";
import { stripPasteTerminators } from "../domain/packet-text.js";
import type { TerminalInputMessage, TerminalSubscriber } from "./TerminalSessionBroker.js";

/**
 * One viewed terminal on herdr-core: the stream half of TerminalSessionBroker, in place of pipe-pane, the tail poll, the
 * history ring, the liveness poll and the capture-pane snapshot.
 *
 * Each subscriber has a view of its own (an observer attach, hc-viewer.ts). The first paint of that attach is its seed: it
 * carries the escapes, the program's modes and the cursor, which no capture gives (spike 3, design gap 3), and it
 * respects the app's own state, which is why the ring and `isSafeHistoryReplay` have no job here. Credit is granted per
 * socket on receipt, so one slow browser loses its own bytes and nobody else's. The core's CLOSE frame, with the
 * program's exit code, signal and reason, replaces the 2-second `hasSession` poll.
 *
 * There is no fixed geometry. A subscriber is told the terminal's size (`TerminalSubscriber.size`) before its first byte
 * and whenever it changes, and follows it: a viewer that is not an observer would resize the person's program.
 */

/** The part of HcViewer the stream broker drives. */
export interface BrokerStreamHost {
  humanInput?<T>(name: string, fn: () => Promise<T>): Promise<T>;
  view(target: string, handlers: ViewHandlers): Promise<ViewOpen>;
  /** Plain history and screen text, for the scroll-back window. */
  readHistory(target: string, lines: number): Promise<string | null>;
  pressKeys(name: string, keys: string[]): Promise<TmuxResult>;
  pasteText(name: string, text: string): Promise<TmuxResult>;
}

export function isStreamHost(host: object): host is BrokerStreamHost {
  return typeof (host as { view?: unknown }).view === "function";
}

interface Seat {
  view: HcLiveView | null;
  decoder: StringDecoder;
  /** Lines above the live bottom this subscriber is scrolled to; 0 is live. */
  offset: number;
  /** The newest scroll request: an older one that finishes later is dropped. */
  ticket: number;
  gone: boolean;
}

/** `\x1b[2J` then each row at an absolute move: the window is painted whole, never appended (same shape as screenSnapshotEscape). */
function windowEscape(rows: readonly string[]): string {
  return `\x1b[2J${rows.map((row, index) => `\x1b[${index + 1};1H${row}`).join("")}\x1b[H`;
}

function describeEnd(end: ViewEnd): string {
  if (end.reason === "program_ended") {
    const how = end.signal !== null ? `signal ${end.signal}` : end.exitCode !== null ? `exit code ${end.exitCode}` : null;
    return [end.endReason, how].filter((part): part is string => part !== null).join(", ") || "ended";
  }
  return end.reason === "absent" ? "it is gone" : end.cause;
}

/** A WebSocket close reason holds 123 bytes. */
function clip(reason: string): string {
  return Buffer.byteLength(reason) <= 120 ? reason : `${Buffer.from(reason).subarray(0, 117).toString("utf8").replace(/�$/, "")}...`;
}

export class HcStreamSession {
  private readonly seats = new Map<TerminalSubscriber, Seat>();
  private inputQueue: Promise<void> = Promise.resolve();
  private torndown = false;
  /** The honest reason a subscriber that resumes after teardown is closed with. */
  private lastClose: { code: number; reason: string } | null = null;

  constructor(
    readonly sessionName: string,
    private readonly host: BrokerStreamHost,
    private readonly onEmpty?: (sessionName: string) => void,
  ) {}

  get subscriberCount(): number {
    return this.seats.size;
  }

  async attach(sub: TerminalSubscriber): Promise<void> {
    if (this.torndown) {
      this.closeTorndown(sub);
      return;
    }
    const seat: Seat = { view: null, decoder: new StringDecoder("utf8"), offset: 0, ticket: 0, gone: false };
    const handlers: ViewHandlers = {
      onPaint: () => { seat.decoder = new StringDecoder("utf8"); },
      onSize: (size) => {
        if (this.torndown || seat.gone) return;
        try { sub.size?.(size.cols, size.rows); } catch { /* a dead subscriber is detached by its next send */ }
      },
      onData: (bytes) => {
        // A subscriber scrolled back is looking at a static window: live bytes would overwrite it. Its next return to live repaints.
        if (seat.offset > 0 || seat.gone || this.torndown) return;
        const text = seat.decoder.write(bytes);
        if (!text) return;
        try {
          sub.send(text);
        } catch {
          this.detach(sub);  // a throwing send means a dead socket
        }
      },
      onEnd: (end) => this.ended(end),
    };
    const opened = await this.host.view(this.sessionName, handlers);
    if (!opened.ok) {
      this.failedOpen(sub, opened.end);
      return;
    }
    seat.view = opened.view;
    // Torn down while the attach was in flight (the program ended, or dispose): never leave a live-looking subscriber on a dead session.
    if (this.torndown || seat.gone) {
      void opened.view.close();
      this.closeTorndown(sub);
      return;
    }
    this.seats.set(sub, seat);
  }

  /** A person's input. Serialized so rapid input keeps order. Observers' own keystrokes are dropped by the core, so keys go by
   *  terminal.keys and text by a writer at the terminal's own size (hc-viewer.ts, ViewerInput). */
  async input(msg: TerminalInputMessage): Promise<void> {
    if (this.torndown) return;
    await this.enqueueInput(async () => {
      const write = async (): Promise<void> => {
        if (msg.type === "keys") await this.host.pressKeys(this.sessionName, msg.keys);
        // A paste-end sequence inside a paste would close it early and let the rest run as typed keys (OF-148).
        else if (msg.type === "text") await this.host.pasteText(this.sessionName, stripPasteTerminators(msg.text));
      };
      if (this.host.humanInput) await this.host.humanInput(this.sessionName, write);
      else await write();
    });
  }

  /** Scroll back `offset` lines for this subscriber only, from plain text; 0 returns to live with a fresh paint (the live bytes
   *  it skipped are gone, and a repaint is the only way to a true screen).
   *
   *  A full-screen app is never read: `terminal.read` with history injects wheel events into an app that reports the mouse
   *  (hc-viewer.ts, fullScreenHistoryReadIsUnsafe), and an alternate screen has no history. The request is ignored there. */
  async scroll(sub: TerminalSubscriber, offset: number): Promise<void> {
    const seat = this.seats.get(sub);
    if (!seat || !seat.view || this.torndown) return;
    const clamped = Math.max(0, Math.floor(offset));
    const ticket = ++seat.ticket;
    if (clamped === 0) {
      if (seat.offset === 0) return;
      seat.offset = 0;
      await seat.view.repaint();
      return;
    }
    if (fullScreenHistoryReadIsUnsafe(seat.view.modes())) return;
    const rows = seat.view.size().rows;
    let content: string | null;
    try {
      content = await this.host.readHistory(this.sessionName, clamped + rows);
    } catch {
      content = null;
    }
    if (content === null || ticket !== seat.ticket || seat.gone || this.torndown) return;
    const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    // The last element is the live-bottom row once the capture's trailing newline is gone, so the offset stays honest.
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    const bottom = lines.length - clamped;  // exclusive end: the window sits `offset` up
    const window = bottom <= rows ? lines.slice(0, rows) : lines.slice(bottom - rows, bottom);
    seat.offset = clamped;
    try {
      sub.send(windowEscape(window));
    } catch {
      this.detach(sub);
    }
  }

  /** The broker survives while others remain; the last detach ends the session's views and evicts it. */
  detach(sub: TerminalSubscriber): void {
    const seat = this.seats.get(sub);
    if (!seat) return;
    this.seats.delete(sub);
    seat.gone = true;
    void seat.view?.close();
    if (this.seats.size === 0) this.teardown({ code: 1011, reason: "terminal broker unavailable" });
  }

  dispose(): void {
    if (this.torndown) return;
    this.releaseAll();
    this.teardown({ code: 1011, reason: "terminal broker unavailable" });
  }

  private ended(end: ViewEnd): void {
    if (this.torndown) return;
    const close = end.reason === "unavailable"
      ? { code: 1011, reason: clip(`hc core unavailable: ${end.cause}`) }
      : { code: 1001, reason: clip(`session terminated: ${describeEnd(end)}`) };
    this.closeAll(close);
  }

  private failedOpen(sub: TerminalSubscriber, end: ViewEnd): void {
    // A co-waiter's failure already tore the session down: this subscriber gets the same remembered reason.
    if (this.torndown) {
      this.closeTorndown(sub);
      return;
    }
    const close = end.reason === "absent" ? { code: 1008, reason: `session not found: ${this.sessionName}` }
      : end.reason === "unavailable" ? { code: 1011, reason: clip(`hc core unavailable: ${end.cause}`) }
        : { code: 1001, reason: clip(`session terminated: ${describeEnd(end)}`) };
    // An open that fails while others are watching closes only this subscriber; the session may still be fine for them.
    if (this.seats.size > 0) {
      try { sub.close(close.code, close.reason); } catch { /* already closed */ }
      return;
    }
    this.lastClose = close;
    this.torndown = true;
    this.onEmpty?.(this.sessionName);
    try { sub.close(close.code, close.reason); } catch { /* already closed */ }
  }

  /** The program ended or the core is gone: every subscriber is told, never left looking live. */
  private closeAll(close: { code: number; reason: string }): void {
    const subs = [...this.seats.keys()];
    this.releaseAll();
    this.lastClose = close;
    this.torndown = true;
    for (const sub of subs) {
      try { sub.close(close.code, close.reason); } catch { /* already closed */ }
    }
    this.onEmpty?.(this.sessionName);
  }

  private releaseAll(): void {
    for (const seat of this.seats.values()) {
      seat.gone = true;
      void seat.view?.close();
    }
    this.seats.clear();
  }

  private teardown(close: { code: number; reason: string }): void {
    if (this.torndown) return;
    this.lastClose = close;
    this.torndown = true;
    this.onEmpty?.(this.sessionName);
  }

  private closeTorndown(sub: TerminalSubscriber): void {
    const close = this.lastClose ?? { code: 1011, reason: "terminal broker unavailable" };
    try { sub.close(close.code, close.reason); } catch { /* already closed */ }
  }

  private enqueueInput(op: () => Promise<void>): Promise<void> {
    const run = this.inputQueue.then(op, op);
    this.inputQueue = run.catch(() => {});
    return run;
  }
}
