/**
 * Seat Messaging's two anti-corruption ports (design: census-delivery-guarantees-20261101, part 2). The `Message` aggregate
 * talks to a seat only through these. hc, the Claude socket and the runners stay behind them: nothing here names a turn, a
 * status, a screen or a pane, and an implementation must not leak one back.
 *
 * Types only. No implementation lives here, and nothing in S1 calls them: gates arrive in S2, the pump that consumes both in S3.
 */

/** A message's identity: it never changes across attempts, and every attempt carries it (invariant 2). */
export type MessageId = string & { readonly __messageId: unique symbol };

/** Mints the brand. Validity of the id's shape is the caller's rule, not this function's. */
export function messageId(id: string): MessageId {
  return id as MessageId;
}

/** What a seat needs to take a message: the id and body never change between attempts. `occupantGeneration`, on a lifecycle
 *  message, binds it to one occupant, so it never reaches a successor. */
export interface SeatMessage {
  readonly id: MessageId;
  readonly seat: string;
  readonly body: string;
  readonly occupantGeneration?: string | null;
}

/** The seat's record that an id arrived, written before the agent saw the text. Only this moves a row to `received`
 *  (invariant 3). `nonce` lets the daemon reject a forged marker: a gate that has none leaves it null. */
export interface GateRecord {
  readonly id: MessageId;
  readonly recordedAt: string;
  readonly nonce: string | null;
}

/** `unavailable`: the gate could not be read now (the seat is down, a file is missing), which proves nothing either way. */
export type GateLookup =
  | { readonly kind: "seen"; readonly record: GateRecord }
  | { readonly kind: "not_seen" }
  | { readonly kind: "unavailable"; readonly cause: string };

/** One per runtime: did this id arrive? The gate itself drops a repeat, before the agent sees it. This port is the daemon's
 *  read of that gate's record. */
export interface SeatGate {
  /** The gate version the seat declared at launch. A seat that declared none has no gate. */
  readonly version: number;
  lookup(seat: string, id: MessageId): Promise<GateLookup>;
}

/** Bytes left, or did not. Neither says the seat took the message; only the gate does. `paused` is a reason to come back, never
 *  a failure: the seat is busy, blocked on a dialog, held by the typing guard, or stopped. */
export type LastHopResult =
  | { readonly kind: "sent" }
  | { readonly kind: "paused"; readonly reason: "busy" | "blocked" | "guard_held" | "seat_stopped" }
  | { readonly kind: "refused"; readonly reason: string };

/** How bytes reach a seat: the socket, a paste, a runner. Safe to repeat, because the gate drops a repeat. */
export interface LastHop {
  attempt(message: SeatMessage): Promise<LastHopResult>;
}
