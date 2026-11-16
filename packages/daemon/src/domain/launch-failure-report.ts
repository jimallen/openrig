// launch-failure-report.ts — what a failed launch's pane showed, in a form fit to surface (workspaces-o9o.3).
//
// A launch that never becomes ready used to report only "Readiness timeout after 30s"; the cause (a shell prompt that
// swallowed the launch command, a runner's own refusal) was visible only by reading the dead pane. These pure functions
// turn captured pane text into the short quote a failure carries. Pure: no tmux, no I/O; callers read the pane through
// their TmuxAdapter and pass the text in.
//
// Where the quote goes: into StartupResult.errors / evidence and the successor launcher's message, so into the persisted
// node.startup_failed event (the SQLite events table) and the CLI's rig up / restore / handover output. That store is
// durable, so every quote is redacted with the transcript redaction policy before it leaves this module.

import { redactTranscriptContent } from "./transcript-redaction.js";

/** Non-empty pane lines a tail quotes. */
export const PANE_TAIL_LINES = 4;
/** Longest quote a failure carries. */
export const PANE_QUOTE_MAX_CHARS = 400;

/** A runner's own failure line: every pane runner (pi, omp, pda, stub) prints `[<runtime>-runner] ERROR <what>`. Matched by
 *  shape, not by a list of runtimes, so a new runner is covered without an edit here. */
const RUNNER_ERROR_LINE = /\[[a-z]+-runner\] ERROR\b/;

// CSI / OSC escape sequences, then any other C0 control or DEL (tabs become spaces first).
const ESCAPE_SEQUENCES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CONTROL_CHARS = /[\x00-\x08\x0b-\x1f\x7f]/g;

function cleanLines(content: string): string[] {
  return content
    .replace(ESCAPE_SEQUENCES, "")
    .replace(/\t/g, " ")
    .split(/\r?\n|\r/)
    .map((line) => line.replace(CONTROL_CHARS, "").trim())
    .filter(Boolean);
}

function fit(text: string): string {
  const redacted = redactTranscriptContent(text);
  return redacted.length > PANE_QUOTE_MAX_CHARS ? `${redacted.slice(0, PANE_QUOTE_MAX_CHARS - 1)}…` : redacted;
}

/** The pane's last non-empty lines joined with " | ", redacted and capped; "" when the pane shows nothing. */
export function paneTailQuote(content: string | null | undefined): string {
  if (!content) return "";
  return fit(cleanLines(content).slice(-PANE_TAIL_LINES).join(" | "));
}

/** The last runner ERROR line in the pane, redacted and capped; null when there is none. */
export function runnerErrorQuote(content: string | null | undefined): string | null {
  if (!content) return null;
  const line = cleanLines(content).filter((l) => RUNNER_ERROR_LINE.test(l)).at(-1);
  return line ? fit(line) : null;
}

/** The suffix a launch failure appends: the runner's own ERROR line when it printed one, else the pane's last lines. */
export function launchFailureSuffix(content: string | null | undefined): string {
  const said = runnerErrorQuote(content);
  if (said) return ` — runner said: ${said}`;
  const tail = paneTailQuote(content);
  return tail ? ` — pane: ${tail}` : "";
}
