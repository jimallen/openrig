// pda runtime L1b (pda-runtime-design-9l Rev 2, "Reconnect", "Mid-message resync"): the incremental parser for
// pda's `GET /agents/:name/events` Server-Sent Events body. The client (L1a) hands over raw bytes; this module
// turns them into events and nothing else. It does not render, redact or decide anything.
//
// Framing follows the SSE rules the runner depends on:
//   - a line ends at LF, CR or CRLF, and a CRLF split across two chunks is still ONE line end;
//   - `data:` lines accumulate (joined with LF) and a blank line dispatches the event;
//   - a line starting with `:` is a comment (a keep-alive) and dispatches nothing;
//   - `event:`, `id:` and `retry:` fields are accepted and ignored: pda puts the event type inside the JSON;
//   - an event still incomplete when the stream ends is discarded, never dispatched half-read;
//   - a multi-byte UTF-8 character split across two chunks is decoded whole.
// A single event larger than `maxEventBytes` is a protocol failure (`PdaSseOverflowError`), not a truncation.
//
// Pure: no I/O, no printing. The message of the one error it throws names no stream content.

const DEFAULT_MAX_EVENT_BYTES = 32 * 1024 * 1024;

export class PdaSseOverflowError extends Error {
  readonly code = "pda_sse_event_too_large";
  constructor() { super("an event exceeded the size limit"); this.name = "PdaSseOverflowError"; }
}

export interface PdaSseMessage {
  /** The joined `data:` payload (LF between lines). */
  data: string;
}

export interface PdaSseParserOptions {
  /** Upper bound on one event's data plus any unfinished line. Default 32 MiB. */
  maxEventBytes?: number;
}

export class PdaSseParser {
  // The default decoder drops a leading byte-order mark (ignoreBOM is false), which is the SSE rule.
  private readonly decoder = new TextDecoder("utf-8", { fatal: false });
  private readonly maxEventBytes: number;
  // The unfinished line is kept as the chunks that make it up and joined ONCE, when its terminator arrives, and a
  // chunk is scanned once: the cost of an event is linear in its size however the network cut it (the first
  // version re-joined and re-scanned the whole pending line per chunk: 2.9 s for an 8 MiB event).
  private pending: string[] = [];
  private pendingChars = 0;
  /** The previous chunk ended in a CR, which ended its line: a LF now at the start of a chunk is the CRLF's second half. */
  private skipLF = false;
  private dataLines: string[] = [];
  private dataChars = 0;

  constructor(options: PdaSseParserOptions = {}) {
    this.maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
  }

  /** Feed one chunk; returns the events it completed, in order. */
  push(chunk: Uint8Array): PdaSseMessage[] {
    const text = this.decoder.decode(chunk, { stream: true });
    const out: PdaSseMessage[] = [];
    const n = text.length;
    if (n === 0) return out;
    let i = 0;
    if (this.skipLF) {
      this.skipLF = false;
      if (text.charCodeAt(0) === 10) i = 1;
    }
    for (;;) {
      let j = i;
      while (j < n) {
        const c = text.charCodeAt(j);
        if (c === 10 || c === 13) break;
        j++;
      }
      if (j >= n) break; // an unfinished line
      const head = text.slice(i, j);
      let line = head;
      if (this.pending.length > 0) {
        line = this.pending.join("") + head;
        this.pending = [];
        this.pendingChars = 0;
      }
      if (text.charCodeAt(j) === 13) {
        if (j + 1 < n) i = text.charCodeAt(j + 1) === 10 ? j + 2 : j + 1;
        else { i = j + 1; this.skipLF = true; }
      } else i = j + 1;
      this.line(line, out);
    }
    if (i < n) {
      const rest = text.slice(i);
      this.pending.push(rest);
      this.pendingChars += rest.length;
    }
    // The unfinished line counts against the same bound as the event it belongs to.
    if (this.dataChars + this.pendingChars > this.maxEventBytes) throw new PdaSseOverflowError();
    return out;
  }

  /** The stream ended. A trailing line without a terminator is processed; an unfinished event is discarded. */
  end(): PdaSseMessage[] {
    const out: PdaSseMessage[] = [];
    const tail = this.pending.join("") + this.decoder.decode();
    this.pending = [];
    this.pendingChars = 0;
    if (tail.length > 0) this.line(tail, out);
    // Per the SSE rules an event with no closing blank line is NOT dispatched.
    this.dataLines = [];
    this.dataChars = 0;
    return out;
  }

  private line(line: string, out: PdaSseMessage[]): void {
    if (line.length === 0) {
      if (this.dataLines.length > 0) out.push({ data: this.dataLines.join("\n") });
      this.dataLines = [];
      this.dataChars = 0;
      return;
    }
    if (line.charCodeAt(0) === 58) return; // ':' comment / keep-alive
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    if (field !== "data") return;
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.charCodeAt(0) === 32) value = value.slice(1);
    this.dataLines.push(value);
    this.dataChars += value.length + 1;
    if (this.dataChars > this.maxEventBytes) throw new PdaSseOverflowError();
  }
}

/** One pda event: a JSON object with a string `type`. Anything else is not an event (null). */
export type PdaStreamEvent = { type: string } & Record<string, unknown>;

export function parsePdaEventData(data: string): PdaStreamEvent | null {
  let parsed: unknown;
  try { parsed = JSON.parse(data); } catch { return null; }
  if (typeof parsed !== "object" || parsed === null) return null;
  const type = (parsed as Record<string, unknown>).type; // an array has none, so it is refused here
  if (typeof type !== "string" || type.length === 0) return null;
  return parsed as PdaStreamEvent;
}
