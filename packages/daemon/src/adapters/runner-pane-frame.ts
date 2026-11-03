// OF-213 (widened): a Pi seat's pane has a console, not just output: a rule naming the seat and an input line, at the bottom of the
// pane at all times, with Pi's output scrolling above them.
//
// Why. The Pi runner's pane was a stream of lines. The line editor echoed typed text on whatever row the cursor was on (the next
// output overwrote it), nothing named the seat once the banner scrolled away, and a pasted rig message was echoed into the scrollback
// before the seat gate decided whether to take it (OF-214: a refused repeat stayed visible).
//
// How (measured on a private core, hc 0.1.17, Linux and macOS, 400 lines through a region of rows 1..R-2): herdr-core honours a
// scroll region (DECSTBM), the cursor save and restore (ESC 7 / ESC 8), and lines that scroll off the top of the region reach the
// scrollback in order, once each (`hc read` history keeps all of them; the two bottom rows are never duplicated into it). So:
//   - rows 1..R-2 are the output region. Every write the runner makes to its stdout or stderr goes through `write` below: restore the
//     output cursor (ESC 8), the text, save it again (ESC 7), repaint the two bottom rows. A streamed reply that ends mid-row carries on
//     from where it stopped.
//   - row R-1 is the rule `── <seat> · <runtime> · <model> ────`, row R the input line `❯ <text>`. The line editor (Node's readline)
//     still does the editing, but its echo goes to a sink; the input row is drawn from its line and cursor by this module alone. A
//     typed or pasted line is therefore never written to the output region: a submitted message shows once, as the runner's own
//     `you ▸ ...` line after the gate takes it, and a refused repeat shows only the runner's `repeat dropped` line.
//   - the input row is one row. A longer line shows its tail around the cursor (`…` first), a newline as `⏎`, and a control
//     character as `·`. The tail is what the daemon looks for when it checks a staged paste (seat-hops.ts looks for the message's
//     last line, the `[openrig-msg ...]` marker, on the screen).
//
// Security. The frame's escape sequences (region, save and restore, cursor position, autowrap, SGR) are written by the stream's
// ORIGINAL writer, the one the pane guard (runner-pane-guard.ts) keeps for the runner's own mode writes. Text still goes through the
// guarded writer, so nothing the model, Pi's stderr or a pasted message carries can build one. The text drawn on the two bottom rows is
// the runner's own (the seat name, the runtime, the model) and the editor's line, with every control character replaced first.
//
// Not a TTY, or a pane under MIN_ROWS x MIN_COLUMNS: the frame is inactive and the runner behaves as before.
//
// Only node builtins and local runner helpers, so a compiled runner entry stays runnable with no daemon dependencies.

import { Writable } from "node:stream";
import { sanitizeForPane } from "./runner-pane-guard.js";

export const MIN_ROWS = 6;
export const MIN_COLUMNS = 24;
export const INPUT_PROMPT = "❯ ";
const NEWLINE_MARK = "⏎";
const CONTROL_MARK = "·";
const ELLIPSIS = "…";

/** The part of a tty output stream the frame uses. A test hands a fake. */
export interface FrameStream {
  /** Any `write` of a stream: a pane's stdout, or a test's fake. */
  write: (...args: never[]) => boolean;
  rows?: number;
  columns?: number;
  isTTY?: boolean;
  on(event: "resize", listener: () => void): unknown;
  off(event: "resize", listener: () => void): unknown;
}

export interface PaneFrameOptions {
  /** The pane's stdout: its rows and columns, its resize event, and the guarded write the text goes through. */
  stdout: FrameStream;
  /** The stream's original writer (rawWriterOf): the only way the frame's own escape sequences reach the pane. */
  raw: (text: string) => void;
  /** What the rule names, e.g. `── verify-qa@eztrack · pi · openai-codex/gpt-6-luna:medium ──`. */
  ruleLabel: string;
}

/** Terminal columns a character takes: 0 for combining and zero-width marks, 2 for the East Asian wide ranges, else 1. An approximation
 *  (no table): a wrong guess shifts the cursor by a column on a line of unusual characters; it never corrupts the output region. */
export function charWidth(codePoint: number): number {
  if ((codePoint >= 0x300 && codePoint <= 0x36f) || (codePoint >= 0x200b && codePoint <= 0x200f) || (codePoint >= 0xfe00 && codePoint <= 0xfe0f)) return 0;
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) || (codePoint >= 0x2e80 && codePoint <= 0xa4cf) || (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) || (codePoint >= 0xfe30 && codePoint <= 0xfe6f) || (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) || (codePoint >= 0x1f300 && codePoint <= 0x1f64f) || (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  ) return 2;
  return 1;
}

interface Token { text: string; width: number; start: number }

/** The editor's line as display tokens: a newline (and CRLF) as `⏎`, any other control, DEL or C1 character as `·`. `start` is the
 *  token's offset in the line, in UTF-16 units (the unit of readline's `cursor`). */
function tokens(line: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < line.length) {
    const cp = line.codePointAt(i)!;
    const len = cp > 0xffff ? 2 : 1;
    let text = String.fromCodePoint(cp);
    let consumed = len;
    if (cp === 0x0d && line.charCodeAt(i + 1) === 0x0a) { text = NEWLINE_MARK; consumed = 2; }
    else if (cp === 0x0a || cp === 0x0d) text = NEWLINE_MARK;
    else if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) text = CONTROL_MARK;
    out.push({ text, width: text === NEWLINE_MARK || text === CONTROL_MARK ? 1 : charWidth(cp), start: i });
    i += consumed;
  }
  return out;
}

/** What the input row shows for `line` with the cursor at `cursor` (a UTF-16 offset), in at most `width` columns, and the column (0-based,
 *  within that text) the cursor sits at. A line that fits is shown whole; a longer one shows the stretch that ends just after the cursor
 *  (its tail when the cursor is at the end), led by `…`. */
export function inputView(line: string, cursor: number, width: number): { text: string; cursorColumn: number } {
  const toks = tokens(line);
  const total = toks.reduce((n, t) => n + t.width, 0);
  const cursorToken = toks.findIndex((t) => t.start >= cursor);
  const at = cursorToken === -1 ? toks.length : cursorToken;
  if (total <= width) return { text: toks.map((t) => t.text).join(""), cursorColumn: toks.slice(0, at).reduce((n, t) => n + t.width, 0) };
  const end = Math.min(toks.length, at + 1);
  let start = end;
  let used = ELLIPSIS.length;
  while (start > 0 && used + toks[start - 1]!.width <= width) { start--; used += toks[start]!.width; }
  const shown = toks.slice(start, end);
  const column = ELLIPSIS.length + toks.slice(start, Math.min(at, end)).reduce((n, t) => n + t.width, 0);
  return { text: ELLIPSIS + shown.map((t) => t.text).join(""), cursorColumn: column };
}

/** The rule row's text for `columns` columns: the label, then rule characters to the edge. */
export function ruleText(label: string, columns: number): string {
  const chars = Array.from(sanitizeForPane(label));
  const widthOf = (cs: string[]) => cs.reduce((n, c) => n + charWidth(c.codePointAt(0)!), 0);
  while (chars.length > 0 && widthOf(chars) > columns) chars.pop();
  const used = widthOf(chars);
  return chars.join("") + (used < columns ? ` ${"─".repeat(Math.max(0, columns - used - 1))}` : "");
}

const CUP = (row: number, column: number) => `\u001b[${row};${column}H`;

export class PaneFrame {
  private readonly stdout: FrameStream;
  private readonly raw: (text: string) => void;
  private readonly label: string;
  private line = "";
  private cursor = 0;
  private started = false;
  private stopped = false;
  private geometry = { rows: 0, columns: 0 };
  private readonly onResize = () => { try { this.resize(); } catch { /* a closed pane is the runner's other handlers' business */ } };
  /** Where the line editor's echo goes: nowhere. The input row is drawn from the editor's line and cursor, never from its output. */
  readonly editorSink: Writable & { isTTY: true; readonly columns: number };

  constructor(options: PaneFrameOptions) {
    this.stdout = options.stdout;
    this.raw = options.raw;
    this.label = options.ruleLabel;
    const stdout = this.stdout;
    this.editorSink = Object.defineProperty(
      Object.assign(new Writable({ write(_chunk, _encoding, callback) { callback(); } }), { isTTY: true as const }),
      "columns", { get: () => stdout.columns ?? MIN_COLUMNS },
    ) as Writable & { isTTY: true; readonly columns: number };
  }

  /** The pane is a terminal big enough for the frame. */
  get usable(): boolean {
    return this.stdout.isTTY === true && (this.stdout.rows ?? 0) >= MIN_ROWS && (this.stdout.columns ?? 0) >= MIN_COLUMNS;
  }

  get active(): boolean { return this.started && !this.stopped; }

  /** Take the pane: what is on the screen goes up into the scrollback, the output region is set, and the rule and input row are drawn. */
  start(): void {
    if (this.started || !this.usable) return;
    this.started = true;
    const { rows, columns } = this.measure();
    this.raw(`${"\n".repeat(rows)}${this.regionSequence(rows)}${CUP(1, 1)}\u001b7${this.paint()}`);
    this.geometry = { rows, columns };
    this.stdout.on("resize", this.onResize);
  }

  /** The text for the output region. `emit` is the stream's guarded write. */
  write(emit: () => boolean): boolean {
    if (!this.active) return emit();
    this.raw("\u001b8");
    let result = true;
    try { result = emit(); } finally { this.raw(`\u001b7${this.paint()}`); }
    return result;
  }

  /** The editor's line and cursor changed. */
  setInput(line: string, cursor: number): void {
    this.line = line;
    this.cursor = cursor;
    if (this.active) this.raw(this.paint());
  }

  /** Give the pane back: the region is reset and the cursor goes to the last row. Idempotent. */
  stop(): void {
    if (!this.started || this.stopped) return;
    this.stopped = true;
    this.stdout.off("resize", this.onResize);
    const { rows } = this.measure();
    try { this.raw(`\u001b[r${CUP(rows, 1)}\u001b[2K\n`); } catch { /* the pane is gone */ }
  }

  private measure(): { rows: number; columns: number } {
    return { rows: this.stdout.rows ?? this.geometry.rows, columns: this.stdout.columns ?? this.geometry.columns };
  }

  private regionSequence(rows: number): string { return `\u001b[1;${rows - 2}r`; }

  /** The pane changed size: the region is set again for the new height, the output cursor goes to the bottom of it, the block is redrawn. */
  private resize(): void {
    if (!this.active) return;
    const { rows, columns } = this.measure();
    if (rows < MIN_ROWS || columns < MIN_COLUMNS) return;
    this.geometry = { rows, columns };
    this.raw(`${this.regionSequence(rows)}${CUP(rows - 2, 1)}\u001b7${this.paint()}`);
  }

  /** The rule and the input row, and the cursor on the input row. Autowrap is off while they are drawn, so a long line is clipped by the
   *  terminal instead of wrapping into a scroll. */
  private paint(): string {
    const { rows, columns } = this.measure();
    const view = inputView(this.line, this.cursor, Math.max(1, columns - INPUT_PROMPT.length - 1));
    const rule = ruleText(this.label, columns);
    const inputRow = `${INPUT_PROMPT}${view.text}`;
    return `\u001b[?7l${CUP(rows - 1, 1)}\u001b[2K\u001b[2m${rule}\u001b[0m${CUP(rows, 1)}\u001b[2K${inputRow}${CUP(rows, INPUT_PROMPT.length + view.cursorColumn + 1)}\u001b[?7h`;
  }

  /** Route a stream's writes into the output region. Text still passes through the stream's current (guarded) write. */
  wrap(stream: Pick<FrameStream, "write">): void {
    const inner = stream.write.bind(stream) as (...args: unknown[]) => boolean;
    stream.write = ((...args: unknown[]): boolean => this.write(() => inner(...args))) as typeof stream.write;
  }
}

/** The frame for a pane-hosted runner's stdout, or null when the pane cannot hold one. `raw` is `rawWriterOf(stdout)`. */
export function createPaneFrame(options: PaneFrameOptions): PaneFrame | null {
  const frame = new PaneFrame(options);
  return frame.usable ? frame : null;
}
