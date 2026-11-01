import { createHash, randomUUID } from "node:crypto";

/**
 * The delivery token of a message to an hc seat: a short marker the delivered text carries, so a send whose reply was lost
 * can be settled by finding it on the screen (HcDelivery) instead of by guessing, and so the SAME message sent twice (a
 * queue retry) finds its first landing and types nothing.
 *
 * What it costs: it is part of the text, so it reaches the agent's context, once per message, as one short trailing line.
 * It is inert (a bracketed id, no instruction), derived from the message's own delivery identity so a retry carries the
 * same one, and it is added only where the seat's format takes a trailing line: the agent runtimes below. A plain
 * terminal reads the text as a shell command, a PDA runner as its own protocol; neither gets one, and for them a send
 * whose reply is lost is settled by the program's status or left `waiting` for a person (see HcDelivery).
 */

/** Runtimes whose composer takes a message with one more line at the end. Everything not named here gets no token. */
export const TOKEN_RUNTIMES: ReadonlySet<string> = new Set(["claude-code", "codex", "pi", "omp"]);

export function carriesDeliveryToken(runtime: string | null | undefined): boolean {
  return runtime != null && TOKEN_RUNTIMES.has(runtime);
}

/** The token for one message: 12 hex characters (48 bits) of a digest of its delivery identity. Only the last screenful of
 *  a seat is searched for it, so a collision needs two messages in the same 200 lines with the same 48 bits. */
export function deliveryTokenFor(deliveryKey: string): string {
  return createHash("sha256").update(`openrig-hc-delivery\0${deliveryKey}`).digest("hex").slice(0, 12);
}

/** The line a message carries for its token. */
export function tokenLine(token: string): string {
  return `[openrig delivery ${token}]`;
}

/** The text with its token line appended after a line break. */
export function withDeliveryToken(text: string, token: string): string {
  return `${text}\n${tokenLine(token)}`;
}

/**
 * What identifies this message for a retry: the committed outbox ids of a queue wake (the same ids on every retry), else the
 * caller's own delivery id (stable by construction), else nothing, and the message is its own: a fresh random key, so its
 * token is unique but a retry would not share it (an ad hoc `rig send` is retried by a person, who is told to check first).
 */
export function deliveryKeyOf(opts: { committedOutboxIds?: readonly string[]; deliveryId?: string } | undefined): string {
  if (opts?.committedOutboxIds && opts.committedOutboxIds.length > 0) return `outbox:${opts.committedOutboxIds.join(",")}`;
  if (opts?.deliveryId) return `delivery:${opts.deliveryId}`;
  return `once:${randomUUID()}`;
}
