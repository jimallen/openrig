// OF-67 — lines the daemon types into a cmux terminal surface.
//
// A cmux surface is an interactive shell, so a typed line meets the same line-editor widgets a tmux pane does
// (autopair rewrites quotes and brackets). A line is typed as it stands only when it holds no control character (C0,
// DEL or C1: LF and CR end the line, and ETX, EOT, ESC, TAB, DEL and the 8-bit CSI are read by the tty or the line editor
// as keys, whatever quoting surrounds them) and is no more than MAX_TYPED_BYTES with none of ()[]{}"'`
// (isTypedLineWidgetSafe); any other line is written to a private script the shell removes as it starts, and only
// `/bin/sh <script>` is typed. A control byte inside a script file is just file content, so the quoted word that holds it
// reaches the program unchanged. (a5: a rig-spec member id, which only has to be free of dots, can reach the helper console.)
//
// Staging is the control for widgets, line breaks and length, nothing else. A line with a `;`, `&`, `|`, `$`, `<`,
// `>` or `\` is typed raw when it is otherwise widget-safe, and a staged script runs all of its text just as a
// typed line does. What keeps a name inert is the caller: every name is interpolated
// through shellWord (or the view composer's shellQuote), so a name is one word whatever it holds.

import { defaultTmuxFileOps, isTypedLineWidgetSafe, type TmuxFileOps } from "./tmux.js";
import { shellWord } from "./tmux-server.js";

/** The longest line typed unstaged: the canonical tty input bound the tmux path also keeps. */
const MAX_TYPED_BYTES = 512;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;
const TYPED_SAFE_PATH = /^\/[A-Za-z0-9_./-]*$/;

/**
 * ok: what to send to the surface (no trailing newline) and `discard`, which removes the script when the surface
 * never received the line (a no-op for an unstaged line). Not ok: the script could not be written, so nothing is
 * typed; the caller reports it as a failed open, not a thrown error.
 */
export type StagedCmuxLine =
  | { ok: true; line: string; discard(): Promise<void> }
  | { ok: false; message: string };

export async function stageCmuxLine(line: string, fileOps: TmuxFileOps = defaultTmuxFileOps()): Promise<StagedCmuxLine> {
  if (!CONTROL_CHARACTER.test(line) && Buffer.byteLength(line, "utf8") <= MAX_TYPED_BYTES && isTypedLineWidgetSafe(line)) {
    return { ok: true, line, discard: async () => {} };
  }
  const path = fileOps.tmpName();
  try {
    await fileOps.writeFile(path, `/bin/rm -f -- ${shellWord(path)}\n${line}\n`, { mode: 0o600, flag: "wx" });
  } catch (err) {
    return { ok: false, message: `could not stage the terminal line: ${err instanceof Error ? err.message : String(err)}` };
  }
  return {
    ok: true,
    line: `/bin/sh ${TYPED_SAFE_PATH.test(path) ? path : shellWord(path)}`,
    discard: async () => { try { await fileOps.unlink(path); } catch { /* already consumed */ } },
  };
}
