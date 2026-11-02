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

/** Content and nudges take an id gate and the pump. A Command (`/compact`, `/clear`) has no marker, is confirmed by its effect and
 *  never by `SeatGate.lookup`, and its retry stays with the enforcer, so the pump never carries one. */
export type SeatMessageClass = "content" | "nudge" | "lifecycle" | "command";

/** Invariant 5: delivery is FIFO per seat per lane. 0 startup and handover, 1 compaction prompts, 2 content and nudges. Lane 2 waits while
 *  a seat's startup is open. */
export type SeatMessageLane = 0 | 1 | 2;

/** What a seat needs to take a message: the ids and body never change between attempts. `ids` holds one id, or a wake group's: N rows
 *  go out as one text, each carrying its own marker, so a group is one attempt and each id has its own gate record. Never empty, and
 *  in staging order. `occupantGeneration` binds a message to one occupant, so it never reaches a successor (a lifecycle message, a
 *  watchdog fire). The body never holds a marker: the last hop adds it at the attempt. */
export interface SeatMessage {
  readonly ids: readonly [MessageId, ...MessageId[]];
  readonly seat: string;
  readonly body: string;
  /** Each row's own text, label included, in `ids` order; `body` is these joined. A last hop that cannot send a long group as one paste sends the
   *  first row alone. Absent: the rows are not known apart. */
  readonly bodies?: readonly string[];
  readonly messageClass: SeatMessageClass;
  readonly lane: SeatMessageLane;
  readonly occupantGeneration?: string | null;
  /** A long message goes one numbered part per turn: the first (from 1) still to arrive. Absent: the first. */
  readonly part?: number;
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
 *  a failure: the seat is busy, blocked on a dialog, held by the typing guard, or stopped, or its composer holds text that may be a person's
 *  (`draft`, Jim's rule: never touched, and the message goes the moment it clears), or the process in its terminal is not its agent
 *  (`agent_absent`: a paste into a login shell runs each line as a command, so nothing is typed until the agent is back), or its screen shows no composer at all, such as a picker (`screen_unreadable`). */
export type LastHopResult =
  | { readonly kind: "sent" }
  | { readonly kind: "paused"; readonly reason: "busy" | "blocked" | "guard_held" | "seat_stopped" | "draft" | "agent_absent" | "screen_unreadable" }
  | { readonly kind: "refused"; readonly reason: string };

/** How bytes reach a seat: the socket, a paste, a runner. Safe to repeat, because the gate drops a repeat. */
export interface LastHop {
  attempt(message: SeatMessage): Promise<LastHopResult>;
  /** The gate recorded the id after more than one attempt: a blocked repeat may sit in a composer. Best effort, and it changes no row. */
  afterReceived?(message: SeatMessage): Promise<void>;
  /** The seat's oldest message left: anything of its text held on disk for the seat goes. Best effort. */
  forget?(seat: string): void;
}
