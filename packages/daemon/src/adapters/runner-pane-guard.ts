// hc cutover W41 (security F4): only the runner's own status writer may put OSC 7501 on its pane.
//
// herdr-core reads a program's state from OSC 7501 in the program's output. A pane-hosted runner prints text it does not
// author (the model's reply, a tool name, another seat's `rig send`, Pi's stderr) and echoes what is pasted into its line
// editor; if any of that carries `ESC ] 7501 ; state=blocked ESC \`, the core believes it and the seat reads `blocked` (sends
// refused) or gains a turn. W37 made that matter by making the runners report at all.
//
// The rule, in two layers:
//   1. TEXT: every string a runner prints goes through `sanitizeForPane` (the pda runner's own sanitiser) at the point it is
//      handed to the pane, so no escape sequence of any kind is printed from text.
//   2. CHOKEPOINT: `installPaneGuard` replaces `write` on the runner's stdout and stderr, so EVERY other writer (console.log,
//      readline's echo of a paste or a typed line, the line editor's own prompts, a path nobody listed) leaves only plain text
//      and a short list of CSI forms (see the allow-list below); every other ESC is removed, and a write that ends inside an
//      allowed form is held until the next write, so a sequence split across two writes cannot join.
//   The one exception is `paneGuard.statusWrite`, the original `write` captured before the patch. Only the status sink calls it.
//
// Only node builtins and local runner helpers, so a compiled runner entry stays runnable with no daemon dependencies.

import { StringDecoder } from "node:string_decoder";
import { sanitizeForPane } from "./pda-runner-protocol.js";

export { sanitizeForPane };

// ── The allow-list ───────────────────────────────────────────────────────────
// A denylist of string-sequence introducers (hc-w41) missed `ESC <C0 byte or DEL> ]`: a terminal parser in its escape state
// executes a C0 control and ignores DEL and stays in that state, so the `]` still opens an OSC (security F6, confirmed on real
// 0.1.15 and 0.1.16 cores). The class is closed the other way round: what leaves the guard is plain text and a short list of CSI
// forms, and EVERY other ESC is removed. So no byte the guard emits can put a terminal in an escape state, and an introducer of any
// kind (`ESC ]`, `ESC P`, `ESC X`, `ESC ^`, `ESC _`, with anything between) cannot be built from what it passes.
//
//   plain text   every character except C0 controls, DEL and the C1 range U+0080-U+009F; of the C0 controls only TAB, LF, CR, BS, BEL.
//   CSI          ESC [ <up to 12 digits or ;>  then one of A B C D G H J K m      (cursor moves, erase, SGR: the line editor)
//                ESC [ ? 2004 h|l                                                  (bracketed paste on and off: runner-pane-io)
//   anything else with an ESC loses the ESC. The bytes after it stay as ordinary text, which a terminal prints and ignores.
//
// A write may end inside an allowed form (`ESC`, `ESC [`, `ESC [ 1`): that prefix is held and joined to the next write, so a split
// cannot make an introducer out of two clean halves. The held prefix is at most 17 characters.
//
// Linear: one pass over the text, a bounded look-ahead at each ESC.

const CSI_FINALS = new Set([..."ABCDGHJKm"].map((c) => c.charCodeAt(0)));
const MAX_CSI_PARAMS = 12;

type CsiMatch = { end: number } | "partial" | null;

/** Does an allowed CSI start at `at` (an ESC)? `end` is one past its last character; "partial" when the text ends while the
 *  characters so far are still a prefix of an allowed form (the next write decides); null when it is not one. */
function matchAllowedCsi(text: string, at: number): CsiMatch {
  const n = text.length;
  let i = at + 1;
  if (i >= n) return "partial";
  if (text.charCodeAt(i) !== 0x5b) return null;      // [
  i++;
  if (i >= n) return "partial";
  if (text.charCodeAt(i) === 0x3f) {                  // ? : only ?2004h / ?2004l
    const rest = "2004";
    i++;
    for (let k = 0; k < rest.length; k++, i++) {
      if (i >= n) return "partial";
      if (text.charCodeAt(i) !== rest.charCodeAt(k)) return null;
    }
    if (i >= n) return "partial";
    const final = text.charCodeAt(i);
    return final === 0x68 || final === 0x6c ? { end: i + 1 } : null;   // h l
  }
  let params = 0;
  for (; i < n; i++, params++) {
    const c = text.charCodeAt(i);
    if ((c >= 0x30 && c <= 0x39) || c === 0x3b) { if (params >= MAX_CSI_PARAMS) return null; continue; }
    return CSI_FINALS.has(c) ? { end: i + 1 } : null;
  }
  return "partial";
}

function plainCode(c: number): boolean {
  if (c < 0x20) return c === 0x09 || c === 0x0a || c === 0x0d || c === 0x08 || c === 0x07;
  return c !== 0x7f && !(c >= 0x80 && c <= 0x9f);
}

/** The allow-list over `text` as a whole: a form the text ends inside of is not allowed (nothing can complete it). */
export function filterPaneText(text: string): string {
  return filterWithCarry(text, "", false).out;
}

function filterWithCarry(text: string, carry: string, keepPartial: boolean): { out: string; carry: string } {
  const s = carry + text;
  const n = s.length;
  const parts: string[] = [];
  let runStart = 0;
  let i = 0;
  let held = "";
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 0x1b) {
      if (runStart < i) parts.push(s.slice(runStart, i));
      const m = matchAllowedCsi(s, i);
      if (m === "partial") {
        if (keepPartial) { held = s.slice(i); i = n; runStart = n; break; }
        i++; runStart = i; continue;
      }
      if (m) { parts.push(s.slice(i, m.end)); i = m.end; runStart = i; continue; }
      i++; runStart = i; continue;       // any other ESC is removed
    }
    if (plainCode(c)) { i++; continue; }
    if (runStart < i) parts.push(s.slice(runStart, i));
    i++; runStart = i;
  }
  if (runStart < n) parts.push(s.slice(runStart, n));
  return { out: parts.join(""), carry: held };
}

/** The same allow-list for a stream of writes: a write that ends inside an allowed CSI waits for the next one. */
export function createPaneFilter(): (text: string) => string {
  let carry = "";
  return (text) => {
    const r = filterWithCarry(text, carry, true);
    carry = r.carry;
    return r.out;
  };
}

/** What the status sink writes with. Before `installPaneGuard` it is the plain stdout write; after, the original one. */
export const paneGuard: { statusWrite: (text: string) => void } = {
  statusWrite: (text) => { process.stdout.write(text); },
};

type Write = (chunk: string | Uint8Array, encoding?: BufferEncoding | ((err?: Error | null) => void), cb?: (err?: Error | null) => void) => boolean;

/** What the guard needs of a pane stream: its `write`. A real stdout/stderr is one; so is a test's PassThrough. */
export interface PaneStream { write: NodeJS.WriteStream["write"] }

export function guardPaneStream(stream: PaneStream): (text: string) => void {
  const original = stream.write.bind(stream) as Write;
  const filter = createPaneFilter();
  const decoder = new StringDecoder("utf8");
  stream.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((err?: Error | null) => void), cb?: (err?: Error | null) => void): boolean => {
    const text = typeof chunk === "string" ? chunk : decoder.write(Buffer.from(chunk));
    const safe = filter(text);
    return typeof encoding === "function" ? original(safe, encoding) : original(safe, encoding, cb);
  }) as typeof stream.write;
  return (text) => { original(text); };
}

const guarded = new WeakSet<object>();

/** Guard this process's stdout and stderr (the pane). Call once, first, in a runner's entry; never in a test process (the
 *  streams are parameters only so a test can hand it fakes). A stream already guarded is left alone. */
export function installPaneGuard(out: PaneStream = process.stdout, err: PaneStream = process.stderr): void {
  if (guarded.has(out)) return;
  guarded.add(out);
  paneGuard.statusWrite = guardPaneStream(out);
  if (!guarded.has(err)) { guarded.add(err); guardPaneStream(err); }
}
