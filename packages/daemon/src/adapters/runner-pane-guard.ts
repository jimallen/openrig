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
//      readline's echo of a paste or a typed line, the line editor's own prompts, a path nobody listed) can still not produce
//      an OSC, DCS, SOS, PM or APC introducer. Complete string sequences are removed with their payload, a bare introducer
//      loses its introducer, and a trailing ESC is held back until the next write so that a sequence split across two writes
//      cannot join. CSI (cursor movement, `?2004h`) is left alone: the editor needs it, and it cannot carry a status.
//   The one exception is `paneGuard.statusWrite`, the original `write` captured before the patch. Only the status sink calls it.
//
// Only node builtins and local runner helpers, so a compiled runner entry stays runnable with no daemon dependencies.

import { StringDecoder } from "node:string_decoder";
import { sanitizeForPane } from "./pda-runner-protocol.js";

export { sanitizeForPane };

const STRINGS = new RegExp([
  "\\u001b\\][\\s\\S]*?(?:\\u0007|\\u001b\\\\)",       // OSC ... BEL | ST
  "\\u001b[PX^_][\\s\\S]*?\\u001b\\\\",               // DCS, SOS, PM, APC ... ST
  "\\u009d[\\s\\S]*?(?:\\u0007|\\u009c|\\u001b\\\\)",  // C1 OSC
  "[\\u0090\\u0098\\u009e\\u009f][\\s\\S]*?(?:\\u009c|\\u001b\\\\)", // C1 DCS, SOS, PM, APC
].join("|"), "g");
const INTRODUCERS = /\u001b[\]PX^_]|[\u0090\u0098\u009d\u009e\u009f]/g;

/** Text with no string-sequence introducer left. Removing a sequence can join its neighbours into a new introducer
 *  (`ESC` + `ESC ] x BEL` + `]`), so it runs to a fixed point. */
export function stripPaneStrings(text: string): string {
  let current = text;
  for (let i = 0; i < 64; i++) {
    const next = current.replace(STRINGS, "").replace(INTRODUCERS, "");
    if (next === current) return next;
    current = next;
  }
  // A text built to outlast 64 passes loses every ESC and C1 control instead: nothing can remain an introducer.
  return current.replace(/[\u001b\u0080-\u009f]/g, "");
}

/** A filter with one character of memory: a write that ends in ESC is held until the next write decides what it was. */
export function createPaneStringFilter(): (text: string) => string {
  let held = "";
  return (text) => {
    let joined = held + text;
    held = "";
    if (joined.endsWith("\u001b")) { held = "\u001b"; joined = joined.slice(0, -1); }
    return stripPaneStrings(joined);
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
  const filter = createPaneStringFilter();
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
