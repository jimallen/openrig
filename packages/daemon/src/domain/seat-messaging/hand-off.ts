import { shortPaste } from "../../adapters/seat-hops.js";
import { nativeMarker } from "../claude-native-inbox.js";
import { partId } from "./long-message.js";
import { OutboxHandlerError } from "../outbox-handler.js";
import type { MessagePump } from "./message-pump.js";
import type { MessageAcceptInput, MessageOutcome, MessageStore } from "./message-store.js";
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
  cancel(id: MessageId, reason: string): boolean;
  /** A pass now, in the caller's context, so a caller waiting under a lifecycle lease has its own retries made under that lease. */
  drive(): void;
  /** What a paste of this message put in the composer, given the text it was accepted with: the text and its marker, or, for a long message
   *  the gate hook completes, the short note and the marker of the part now due. Null when no paste went: nothing was attempted, or it went
   *  by socket. */
  stagedPaste(id: MessageId, text: string): string | null;
  /** Lane 2 waits on this seat until the returned function is called, for a sequence of lower-lane messages that each wait for the last, so
   *  nothing lands between two of them. Call it in a `finally`. It lives and dies with this process: a daemon that died mid-sequence is not
   *  still running it, and a hold on disk would wedge the seat's queue for good. */
  holdContentLane(seat: string): () => void;
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
    void this.pump.ask();
  }

  awaitReceived(id: MessageId, waitMs: number): Promise<MessageOutcome> {
    return this.pump.awaitReceived(id, waitMs);
  }

  cancel(id: MessageId, reason: string): boolean {
    return this.pump.cancel(id, reason);
  }

  drive(): void {
    void this.pump.ask();
  }

  stagedPaste(id: MessageId, text: string): string | null {
    const nonce = this.store.nonceOf(id);
    if (nonce === null || this.store.lastSocketWriteMs(id) !== null) return null;
    const total = this.store.partsOf(id);
    // Marked for parts only when the last hop spooled its text: a message that went whole was never marked.
    if (total === null) return `${text}\n${nativeMarker(id, nonce)}`;
    const index = Math.min(this.store.partsDoneOf(id) + 1, total);
    return shortPaste({ ids: [id], seat: "", body: text, messageClass: "lifecycle", lane: 0 }, { id: total === 1 ? id : partId(id, index, total), nonce }, index, total);
  }

  holdContentLane(seat: string): () => void {
    return this.pump.holdContentLane(seat);
  }
}
