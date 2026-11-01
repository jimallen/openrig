import { OutboxHandlerError } from "../outbox-handler.js";
import type { MessagePump } from "./message-pump.js";
import type { MessageAcceptInput, MessageStore } from "./message-store.js";
import { messageId } from "./ports.js";
import type { SeatMessagingPorts } from "./pump-ports.js";

export type HandOffResult =
  | { readonly kind: "accepted"; readonly id: string }
  | { readonly kind: "conflict" }
  /** The id ended earlier: `received` true when it arrived. A repeat changes nothing. */
  | { readonly kind: "ended"; readonly received: boolean };

/**
 * One driver per row. For a seat the pump serves, SessionTransport never writes a message: it commits the row here and answers. Reached
 * through the host adapter, as the delivery guard is, so no SessionTransport a caller builds can miss it. Absent: the pump is off.
 */
export interface MessageHandOff {
  takes(seat: string): boolean;
  accept(input: MessageAcceptInput & { freezeBody?: boolean }): HandOffResult;
  /** Rows a drain claimed: they become the pump's, so the drain's send stops here and its final write finds nothing to move. */
  adoptClaimed(ids: readonly string[]): void;
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
    for (const id of ids) this.store.adoptClaimed(messageId(id));
    void this.pump.tick();
  }
}
