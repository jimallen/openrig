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
  private readonly decoder = new TextDecoder("utf-8", { fatal: false });
  private readonly maxEventBytes: number;
  private buf = "";
  private dataLines: string[] = [];
  private dataChars = 0;
  private sawBom = false;

  constructor(options: PdaSseParserOptions = {}) {
    this.maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
  }

  /** Feed one chunk; returns the events it completed, in order. */
  push(chunk: Uint8Array): PdaSseMessage[] {
    this.buf += this.decoder.decode(chunk, { stream: true });
    if (!this.sawBom && this.buf.length > 0) {
      this.sawBom = true;
      if (this.buf.charCodeAt(0) === 0xfeff) this.buf = this.buf.slice(1);
    }
    const out: PdaSseMessage[] = [];
    let i = 0;
    const b = this.buf;
    for (;;) {
      let j = i;
      while (j < b.length && b.charCodeAt(j) !== 10 && b.charCodeAt(j) !== 13) j++;
      if (j >= b.length) break;                                   // an unfinished line
      if (b.charCodeAt(j) === 13 && j === b.length - 1) break;    // a CR at the very end may be half of a CRLF
      const line = b.slice(i, j);
      i = b.charCodeAt(j) === 13 && b.charCodeAt(j + 1) === 10 ? j + 2 : j + 1;
      this.line(line, out);
    }
    this.buf = b.slice(i);
    // The unfinished line counts against the same bound as the event it belongs to.
    if (this.dataChars + this.buf.length > this.maxEventBytes) throw new PdaSseOverflowError();
    return out;
  }

  /** The stream ended. A trailing line without a terminator is processed; an unfinished event is discarded. */
  end(): PdaSseMessage[] {
    const out: PdaSseMessage[] = [];
    const tail = this.buf + this.decoder.decode();
    this.buf = "";
    if (tail.length > 0) this.line(tail.replace(/\r$/, ""), out);
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
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const type = (parsed as Record<string, unknown>).type;
  if (typeof type !== "string" || type.length === 0) return null;
  return parsed as PdaStreamEvent;
}
