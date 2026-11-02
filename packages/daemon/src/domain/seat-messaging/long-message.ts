import { messageId, type MessageId } from "./ports.js";

/**
 * A long message on a paste path goes as a short paste, and the seat's gate hook adds its text as `additionalContext`. Real Codex truncates that
 * context past about 10k characters, keeping the first and last 5000 (measured, d65d5416), so a longer message goes in numbered parts, each with
 * an id of its own, in a turn of its own. Claude's limit on it is not measured.
 */
export const LONG_PART_CHARS = 9000;

/** The body in order, cut every `LONG_PART_CHARS` characters, never inside one. Joined, the parts are the body. */
export function splitLongMessage(body: string): string[] {
  const chars = Array.from(body);
  const parts: string[] = [];
  for (let at = 0; at < chars.length; at += LONG_PART_CHARS) parts.push(chars.slice(at, at + LONG_PART_CHARS).join(""));
  return parts.length > 0 ? parts : [""];
}

export function partId(id: MessageId, index: number, total: number): MessageId {
  return messageId(`${id}.part${index}of${total}`);
}

/** The row a part's id belongs to. An id that is no part's is its own. */
export function messageOfPart(id: MessageId): MessageId {
  return messageId(id.replace(/\.part\d+of\d+$/, ""));
}
