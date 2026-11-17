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
//   Object keys are redacted the same way (a credential-shaped key is rare, so the meaning is kept). A line that is not
//   JSON is redacted as text.
// - A slice that starts inside a line (sinceBytes not at a line start) is served from the next line start, so the tail
//   of a token cut by the offset never reaches the text fallback (verify-sec review of o9o.60).

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
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [redactTranscriptContent(key), redactStrings(inner)]));
  }
  return value;
}

/** The field the view sets on a record whose raw message text is the walked piece (workspaces-o9o.82). */
export const PIECE_MATCH_FIELD = "openrigPieceMatch";

/** A message's text as rig walk reads it: a string, or the text / input_text blocks of an array, joined; CRLF and the
 *  surrounding whitespace are the only normalisation (twin of the CLI's walk-consumption.ts textOf + canonical). */
export function canonicalMessageText(content: unknown): string {
  const text = typeof content === "string" ? content
    : Array.isArray(content) ? content.map((block: unknown) => {
      const b = block as { type?: unknown; text?: unknown } | null;
      return (b?.type === "text" || b?.type === "input_text") && typeof b.text === "string" ? b.text : "";
    }).join("") : "";
  return text.replace(/\r\n/g, "\n").trim();
}

/** A user message's raw content in a Claude record (message.content) or a Codex one (payload.content); undefined else. */
function userMessageContent(record: unknown): unknown {
  const r = record as { type?: unknown; message?: { role?: unknown; content?: unknown }; payload?: { type?: unknown; role?: unknown; content?: unknown } } | null;
  if (r?.type === "user" && r.message?.role === "user") return r.message.content;
  if (r?.type === "response_item" && r.payload?.type === "message" && r.payload.role === "user") return r.payload.content;
  return undefined;
}

/** The outbound port for matching a walked piece: true when a raw message text (canonicalMessageText) is the piece. The
 *  route implements it with the piece's digest, so no raw digest is ever served (workspaces-o9o.82). */
export type PieceMatcher = (canonicalText: string) => boolean;

/** The redacted view of a slice of a native record: its complete lines, each redacted, each newline-terminated.
 *  `startsAtLine` says whether the slice's first byte begins a line; when it does not, the partial first line is
 *  dropped, as the unfinished last one is. With `matchesPiece`, a user-message record whose RAW text is the walked piece
 *  carries `openrigPieceMatch: true`: rig walk then trusts only that mark, so two messages that redact alike cannot
 *  certify each other. A record's own field of that name is dropped first, so only the view can set it. */
export function redactedRecordView(slice: string, startsAtLine: boolean, matchesPiece?: PieceMatcher): string {
  const whole = startsAtLine ? slice : slice.slice(slice.indexOf("\n") + 1 || slice.length);
  const lines = completeLines(whole).split("\n").slice(0, -1);
  return lines.map((line) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return `${redactTranscriptContent(line)}\n`;
    }
    const redacted = redactStrings(parsed);
    if (matchesPiece && redacted !== null && typeof redacted === "object" && !Array.isArray(redacted)) {
      const view = redacted as Record<string, unknown>;
      delete view[PIECE_MATCH_FIELD];
      const content = userMessageContent(parsed);
      if (content !== undefined && matchesPiece(canonicalMessageText(content))) view[PIECE_MATCH_FIELD] = true;
    }
    return `${JSON.stringify(redacted)}\n`;
  }).join("");
}
