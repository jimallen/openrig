/**
 * What the pump needs beyond the two seat ports (ports.ts): which seats have a gate, what became of a seat, whether a typing guard
 * has lifted, and how a message goes back to its sender. Each is a question about the fleet, asked in the Seat Messaging words, so
 * the pump never reads `nodes`, `rigs` or a guard table itself.
 */
import type { LastHop, MessageId, SeatGate } from "./ports.js";

/** Which seats the pump may serve (design: migration note 6). A seat with no gate is left as it is, and shows on health. */
export interface SeatMessagingPorts {
  gateFor(seat: string): SeatGate | null;
  hopFor(seat: string): LastHop | null;
}

/** Nothing gated: the daemon's default until a gate is wired, so turning the setting on before then drives nothing. */
export const NO_SEAT_MESSAGING_PORTS: SeatMessagingPorts = { gateFor: () => null, hopFor: () => null };

/** `live` covers a stopped seat: it can come back. `gone` is for good (Jim's decision 1: the rig is archived, or its record is gone).
 *  `unknown` proves nothing, so the pump does nothing on it. */
export type SeatFate =
  | { readonly kind: "live"; readonly occupantGeneration: string | null }
  | { readonly kind: "successor"; readonly seat: string }
  | { readonly kind: "gone"; readonly reason: string }
  | { readonly kind: "unknown" };

export interface SeatDirectory {
  fate(seat: string): SeatFate;
}

/** The identity a typing guard captured when it held a message. */
export interface HeldBinding {
  readonly nodeId: string;
  readonly session: string;
  readonly occupant: string | null;
  readonly pane: string | null;
}

/** `occupant_changed`: the guard lifted, but the seat is not the one that held the message. A held message is never rebound
 *  to a new occupant (seat-delivery-guard.ts), so it stays held and shows on health. */
export type HoldStatus = "held" | "lifted" | "occupant_changed";

export interface HeldMessages {
  status(binding: HeldBinding): HoldStatus;
}

export type SenderReturnResult =
  | { readonly kind: "returned"; readonly qitemId: string }
  /** No queue can reach the sender: the row ends `undeliverable` naming why, since nothing later can change it. */
  | { readonly kind: "no_return_path"; readonly reason: string };

/** Gives the sender a queue item for a message that can never arrive. Repeatable: a crash after it runs repeats it on the same item.
 *  A throw means "not now"; the pump comes back. */
export interface SenderReturn {
  returnToSender(message: { readonly id: MessageId; readonly seat: string; readonly sender: string; readonly body: string }, reason: string): Promise<SenderReturnResult>;
}
