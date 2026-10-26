// OF-67 — lines the daemon types into a cmux terminal surface.
//
// A cmux surface is an interactive shell, so a typed line meets the same line-editor widgets a tmux pane does
// (autopair rewrites quotes and brackets), and a line that carries a newline or `;` runs as more than one command.
// A line is typed as it stands only when it is one line of widget-safe characters (isTypedLineWidgetSafe); any other
// line is written to a private script the shell removes as it starts, and only `/bin/sh <script>` is typed.
//
// Staging controls how the line reaches the shell. It does not make a name inside the line inert: callers quote every
// name they interpolate (shellWord), because a script runs its text just as a typed line does.

import { defaultTmuxFileOps, isTypedLineWidgetSafe, type TmuxFileOps } from "./tmux.js";
import { shellWord } from "./tmux-server.js";

/** The longest line typed unstaged: the canonical tty input bound the tmux path also keeps. */
const MAX_TYPED_BYTES = 512;
const TYPED_SAFE_PATH = /^\/[A-Za-z0-9_./-]*$/;

export interface StagedCmuxLine {
  /** What to send to the surface, without the trailing newline. */
  line: string;
  /** Remove the script when the surface never received the line. A no-op for an unstaged line. */
  discard(): Promise<void>;
}

export async function stageCmuxLine(line: string, fileOps: TmuxFileOps = defaultTmuxFileOps()): Promise<StagedCmuxLine> {
  if (!line.includes("\n") && !line.includes("\r") && Buffer.byteLength(line, "utf8") <= MAX_TYPED_BYTES && isTypedLineWidgetSafe(line)) {
    return { line, discard: async () => {} };
  }
  const path = fileOps.tmpName();
  await fileOps.writeFile(path, `/bin/rm -f -- ${shellWord(path)}\n${line}\n`, { mode: 0o600, flag: "wx" });
  return {
    line: `/bin/sh ${TYPED_SAFE_PATH.test(path) ? path : shellWord(path)}`,
    discard: async () => { try { await fileOps.unlink(path); } catch { /* already consumed */ } },
  };
}
