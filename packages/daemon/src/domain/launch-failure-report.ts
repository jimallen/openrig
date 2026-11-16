// launch-failure-report.ts — what a failed launch's pane showed, in a form fit to surface (workspaces-o9o.3).
//
// A launch that never becomes ready used to report only "Readiness timeout after 30s"; the cause (a shell prompt that
// swallowed the launch command, a runner's own refusal) was visible only by reading the dead pane. These pure functions
// turn captured pane text into the short quote a failure carries. Pure: no tmux, no I/O; callers read the pane through
// their TmuxAdapter (with soft-wrapped lines joined) and pass the text in.
//
// Two rules, from the security review of this unit:
// - Deny by default for text this unit added. The pane tail is never put in a durable store: a failure's durable text
//   (StartupResult.errors, persisted in node.startup_failed and folded into restore and bootstrap records) carries only
//   the runner's own ERROR line, else the fixed PANE_TAIL_NOT_STORED marker. The tail itself rides a transient field
//   (paneTail) that responses carry and persisting code strips or never reads.
// - Redact what is stored anyway. Pane evidence that was durable before this unit (restore attention evidence, the
//   resume-failure quote) and the runner ERROR line go through redactPaneText: the v0 transcript patterns plus shapes
//   they miss. A pattern list is never complete; that is why the first rule exists.

import { redactTranscriptContent } from "./transcript-redaction.js";

/** The durable suffix when the pane showed something but no runner ERROR line: the tail is withheld from every store. */
export const PANE_TAIL_NOT_STORED = " — pane tail not stored";

/** Shapes the v0 transcript patterns (transcript-redaction.ts, a twin of the CLI's restore-packet list, so not widened
 *  here) miss. Pane text only. Order matters: token shapes first, then secret-named assignments. */
const PANE_TOKEN_PATTERNS: readonly RegExp[] = [
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,                                   // Slack
  /\bglpat-[A-Za-z0-9_-]{20,}/g,                                        // GitLab personal access token
  /\bnpm_[A-Za-z0-9]{36}\b/g,                                           // npm
  /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g,    // JWT
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,                                      // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}/g,                                           // Google API key
];
/** user:password@ in a URL: the password is redacted, the user and host kept. */
const URL_PASSWORD = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+@/gi;
/** NAME=value or NAME: value where NAME ends in a secret word: the value is redacted. */
const SECRET_ASSIGNMENT = /\b([A-Za-z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|ACCESS_KEY|PRIVATE_KEY|KEY))(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s"']+)/gi;

/** Pane text with the v0 transcript patterns and the pane-only shapes above replaced by `[REDACTED]`. */
export function redactPaneText(text: string): string {
  let out = redactTranscriptContent(text);
  for (const pattern of PANE_TOKEN_PATTERNS) out = out.replace(pattern, "[REDACTED]");
  out = out.replace(URL_PASSWORD, "$1[REDACTED]@");
  return out.replace(SECRET_ASSIGNMENT, "$1$2[REDACTED]");
}

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
  const redacted = redactPaneText(text);
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

/** The suffix a failure's DURABLE text appends: the runner's own ERROR line when it printed one (OpenRig-authored, and
 *  redacted), else PANE_TAIL_NOT_STORED when the pane showed anything, else nothing. Never the tail itself. */
export function durableLaunchFailureSuffix(content: string | null | undefined): string {
  const said = runnerErrorQuote(content);
  if (said) return ` — runner said: ${said}`;
  return paneTailQuote(content) ? PANE_TAIL_NOT_STORED : "";
}

/** The suffix a RESPONSE-ONLY failure message appends (the handover successor's, never persisted): the runner's own ERROR
 *  line when it printed one, else the pane's last lines. */
export function launchFailureSuffix(content: string | null | undefined): string {
  const said = runnerErrorQuote(content);
  if (said) return ` — runner said: ${said}`;
  const tail = paneTailQuote(content);
  return tail ? ` — pane: ${tail}` : "";
}
