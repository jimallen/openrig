import { SEAT_MESSAGE_ID_PREFIX } from "../outbox-handler.js";
import { messageId, type MessageId } from "./ports.js";

/**
 * A long message on a paste path goes as a short paste, and the seat's gate hook adds its text as `additionalContext`. Real Codex truncates that
 * context past about 10k, keeping the first and last 5000 (measured, d65d5416, on ASCII only), so a longer message goes in numbered parts, each with
 * an id of its own, in a turn of its own. Parts are cut by UTF-8 bytes (decision 38): the budget looks byte-based, and bytes are safe either way.
 * Claude's limit on it is not measured. The gate also reads the context back, to believe a record (hook-seat-gate.ts, OF-229): a part must come back
 * exactly, so 9000 bytes stays under the cut (measured, OF-229: ASCII, hex, CJK and emoji bodies of 9000 bytes came back exact; 12000 ASCII came back cut).
 */
export const LONG_PART_BYTES = 9000;

/** The body in order, in parts of at most `LONG_PART_BYTES` UTF-8 bytes, never cut inside a character. Joined, the parts are the body. */
export function splitLongMessage(body: string): string[] {
  const parts: string[] = [];
  let part = "";
  let bytes = 0;
  for (const char of body) {
    const size = Buffer.byteLength(char);
    if (bytes + size > LONG_PART_BYTES) { parts.push(part); part = ""; bytes = 0; }
    part += char;
    bytes += size;
  }
  parts.push(part);
  return parts;
}

const STARTUP_TEXT_PREFIX = `${SEAT_MESSAGE_ID_PREFIX}startup-`;
const HANDOVER_TEXT_PREFIX = `${SEAT_MESSAGE_ID_PREFIX}handover-`;

export function startupTextId(occupantGeneration: string, startupAttemptId: string, sendOrder: number): string {
  return `${STARTUP_TEXT_PREFIX}${occupantGeneration}-${startupAttemptId}-${sendOrder}`;
}

export function handoverTextId(successor: string, kind: string): string {
  return `${HANDOVER_TEXT_PREFIX}${successor}-${kind}`;
}

/** Decision 39, the named exception to decision 35: startup and handover text, known by a daemon-only id so a restart still knows it, may paste
 *  whole on a Claude seat with no socket. A seat that cannot start or take over is worse than a message that waits, and the body is in the prompt,
 *  so a gate record means it arrived. If its Enter is lost a collapsed paste cannot be told from a person's, so nothing presses it: the operation's
 *  wait runs out and fails out loud, with nothing recorded as arrived. */
export function pastesWhole(id: MessageId): boolean {
  return id.startsWith(STARTUP_TEXT_PREFIX) || id.startsWith(HANDOVER_TEXT_PREFIX);
}

export function partId(id: MessageId, index: number, total: number): MessageId {
  return messageId(`${id}.part${index}of${total}`);
}

/** The row a part's id would belong to, by its shape alone. A caller may have an id of this shape, so this never decides anything without a nonce
 *  to compare: see `MessageStore.reopenCleared`. */
export function messageOfPart(id: MessageId): MessageId {
  return messageId(id.replace(/\.part\d+of\d+$/, ""));
}
