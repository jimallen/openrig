import { nativeMarker } from "../claude-native-inbox.js";
import { OutboxHandlerError } from "../outbox-handler.js";
import type { MessagePump } from "./message-pump.js";
import type { MessageAcceptInput, MessageOutcome, MessageStore, RetiringOccupantHandOver } from "./message-store.js";
import { messageId, type MessageId } from "./ports.js";
import type { SeatMessagingPorts } from "./pump-ports.js";

export type HandOffResult =
  | { readonly kind: "accepted"; readonly id: string }
  | { readonly kind: "conflict" }
  /** The id ended earlier: `received` true when it arrived. A repeat changes nothing. */
  | { readonly kind: "ended"; readonly received: boolean };

/**
 * One driver per row. For a seat the pump serves, SessionTransport never writes a message: it commits the row here and answers. Reached
 * through the host adapter, as the delivery guard is, so no SessionTransport a caller builds can miss it. Absent: the pump is off.
 *
 * This is all a consumer needs of the pump (S4): `takes` picks the branch, because an ungated seat keeps its old path until S5.
 */
export interface MessageHandOff {
  takes(seat: string): boolean;
  accept(input: MessageAcceptInput & { freezeBody?: boolean }): HandOffResult;
  /** Rows a drain claimed: they become the pump's, so the drain's send stops here and its final write finds nothing to move. Several rows are one
   *  wake group, and go out as one text. */
  adoptClaimed(ids: readonly string[]): void;
  /** Waits up to `waitMs`. `open` is not a failure: the pump goes on until someone calls `cancel`. */
  awaitReceived(id: MessageId, waitMs: number): Promise<MessageOutcome>;
  /** Ends a row nobody should still deliver, with no notice. False when it was not open. */
  cancel(id: MessageId, reason: string, actor?: string | null): boolean;
  /** A pass of this seat now, in the caller's context, so a caller waiting under a lifecycle lease has its own retries made under that lease. */
  drive(seat: string): void;
  /** What a paste of this message put in the composer, given the text it was accepted with: the text and its marker, whatever its length (decision
   *  35: startup text never goes as a note). Null when no paste went: nothing was attempted, or it went by socket. */
  stagedPaste(id: MessageId, text: string): string | null;
  /** Lane 2 waits on this seat until the returned function is called, for a sequence of lower-lane messages that each wait for the last, so
   *  nothing lands between two of them. Call it in a `finally`. It lives and dies with this process: a daemon that died mid-sequence is not
   *  still running it, and a hold on disk would wedge the seat's queue for good. */
  holdContentLane(seat: string): () => void;
  /** workspaces-o9o.7: a fresh launch stopped `seat`'s occupant. What it took from `sinceIso` on, and what was attempted on it and is still open,
   *  goes to the fresh occupant (MessageStore.handOverFromRetiringOccupant). A seat the pump does not serve has nothing here to carry it: its
   *  messages delivered since are named in `notHandedOver`, never dropped in silence. Call it once the old session is gone. */
  handOverFromRetiringOccupant(seat: string, sinceIso: string, retiringTag: string): RetiringOccupantHandOver & { readonly notHandedOver: readonly MessageId[] };
}

export class PumpHandOff implements MessageHandOff {
  constructor(private readonly store: MessageStore, private readonly pump: MessagePump, private readonly ports: SeatMessagingPorts) {}

  takes(seat: string): boolean {
    return this.ports.gateFor(seat) !== null && this.ports.hopFor(seat) !== null;
  }

  accept(input: MessageAcceptInput & { freezeBody?: boolean }): HandOffResult {
    try {
      return { kind: "accepted", id: this.pump.accept(input) };
    } catch (error) {
      if (!(error instanceof OutboxHandlerError)) throw error;
      if (error.code === "delivery_identity_conflict") return { kind: "conflict" };
      if (error.code === "delivery_already_attempted") return { kind: "ended", received: this.store.outcomeOf(input.id) === "received" };
      throw error;
    }
  }

  adoptClaimed(ids: readonly string[]): void {
    this.store.adoptClaimed(ids.map(messageId));
    const seat = ids[0] === undefined ? null : this.store.seatOf(messageId(ids[0]));
    if (seat !== null) void this.pump.ask(seat);
  }

  awaitReceived(id: MessageId, waitMs: number): Promise<MessageOutcome> {
    return this.pump.awaitReceived(id, waitMs);
  }

  cancel(id: MessageId, reason: string, actor: string | null = null): boolean {
    return this.pump.cancel(id, reason, actor);
  }

  drive(seat: string): void {
    void this.pump.ask(seat);
  }

  stagedPaste(id: MessageId, text: string): string | null {
    const nonce = this.store.nonceOf(id);
    if (nonce === null || this.store.lastSocketWriteMs(id) !== null) return null;
    return `${text}\n${nativeMarker(id, nonce)}`;
  }

  holdContentLane(seat: string): () => void {
    return this.pump.holdContentLane(seat);
  }

  handOverFromRetiringOccupant(seat: string, sinceIso: string, retiringTag: string): RetiringOccupantHandOver & { readonly notHandedOver: readonly MessageId[] } {
    if (!this.takes(seat)) return { carried: [], reissued: [], notHandedOver: this.store.deliveredSinceUnpumped(seat, sinceIso) };
    // No pass is asked for here: the caller holds the seat's lifecycle lease and the new occupant does not exist yet, so a pass now would judge the
    // rows against the occupant that just ended. They are due at once, and go on the first pass after the launch.
    return { ...this.store.handOverFromRetiringOccupant(seat, sinceIso, retiringTag), notHandedOver: [] };
  }
}
