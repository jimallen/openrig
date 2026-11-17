// generation-record-view.ts — what GET /api/sessions/:name/generation-record serves of a seat's native conversation record
// (a Claude JSONL or a Codex rollout), workspaces-o9o.60.
//
// The route addresses the record by RAW byte offsets (totalBytes, sinceBytes), and `rig walk` takes every offset from
// totalBytes, never from the served text, so the text can be a redacted view without breaking that protocol. This module
// is the view: pure, no I/O.
//
// - Only complete lines are served. A line still being appended, or one cut by the route's size cap, is held back, so a
//   secret is never served in part (and walk already ignores an unfinished line).
// - A JSON line is parsed, every string value in it redacted with the shared transcript policy, and written back as one
//   line. Redacting the parsed strings, not the serialized bytes, means a redaction can never eat a JSON quote or an
//   escape, and a reader comparing message text sees exactly what redacting that text gives (rig walk relies on it).
//   Object keys are kept as they are. A line that is not JSON is redacted as text.

import { redactTranscriptContent } from "./transcript-redaction.js";

/** The text up to and including its last newline; "" when it holds no complete line. */
export function completeLines(text: string): string {
  const end = text.lastIndexOf("\n");
  return end < 0 ? "" : text.slice(0, end + 1);
}

function redactStrings(value: unknown): unknown {
  if (typeof value === "string") return redactTranscriptContent(value);
  if (Array.isArray(value)) return value.map(redactStrings);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, redactStrings(inner)]));
  }
  return value;
}

/** The redacted view of a slice of a native record: its complete lines, each redacted, each newline-terminated. */
export function redactedRecordView(slice: string): string {
  const lines = completeLines(slice).split("\n").slice(0, -1);
  return lines.map((line) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return `${redactTranscriptContent(line)}\n`;
    }
    return `${JSON.stringify(redactStrings(parsed))}\n`;
  }).join("");
}
