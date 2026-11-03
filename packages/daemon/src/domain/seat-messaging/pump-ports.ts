/**
 * What the pump needs beyond the two seat ports (ports.ts): which seats have a gate, what became of a seat, whether a typing guard
 * has lifted, and how a message goes back to its sender. Each is a question about the fleet, asked in the Seat Messaging words, so
 * the pump never reads `nodes`, `rigs` or a guard table itself.
 */
import type { LastHop, MessageId, SeatGate, SeatMessageClass } from "./ports.js";

/** Which seats the pump may serve (design: migration note 6). A seat with no gate is left as it is, and shows on health. */
export interface SeatMessagingPorts {
  gateFor(seat: string): SeatGate | null;
  hopFor(seat: string): LastHop | null;
}

/** Nothing gated: the daemon's default until a gate is wired, so turning the setting on before then drives nothing. */
export const NO_SEAT_MESSAGING_PORTS: SeatMessagingPorts = { gateFor: () => null, hopFor: () => null };

/** `live` covers a stopped seat: it can come back. `gone` is for good (Jim, 2026-11-01: a message for a seat that is gone goes to its successor if there is one, labelled; it is returned to its sender only after the rig is archived, or when the seat never existed in a live rig, and the reason is true).
 *  `unknown` proves nothing, so the pump does nothing on it. */
export type SeatFate =
  /** `occupantGeneration` is minted at every launch (lifecycle text is bound to it); `conversation` is the agent's, which a launch that resumes does not change
   *  (ordinary text is bound to it). Absent: the same as the generation. */
  | { readonly kind: "live"; readonly occupantGeneration: string | null; readonly conversation?: string | null }
  | { readonly kind: "successor"; readonly seat: string }
  /** No seat answers to the name now, but its rig is live (OF-209: `rig remove` took the node out). A successor can still be added at the same
   *  address, and until the rig is archived the message waits for it: it is neither attempted nor returned. */
  | { readonly kind: "vacant"; readonly rig: string }
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

/** `occupant_changed`: the guard lifted, but the seat is not the one that held the message (Jim's decision): it goes to the new occupant,
 *  labelled, unless it is lifecycle text, which goes back to its sender. */
export type HoldStatus = "held" | "lifted" | "occupant_changed";

export interface HeldMessages {
  status(binding: HeldBinding | null, seat: string): HoldStatus;
}

/** The row as an obligation check sees it. */
export interface ObligedMessage {
  readonly id: MessageId;
  readonly seat: string;
  readonly messageClass: SeatMessageClass;
  readonly attempts: number;
  readonly occupantGeneration: string | null;
  readonly auditPointer: string | null;
}

/** Why nobody should still deliver this message, or null while it is wanted. */
export type ObligationCheck = (message: ObligedMessage) => string | null;

/**
 * What a message stands for, read at every attempt, since it can end after the row committed: a closed queue item ends its wake, a job's new
 * occurrence ends an older row that never went out, a session started after a restore ends that restore's notice. Each owner registers its
 * own id prefix (`DAEMON_OUTBOX_ID_PREFIXES` names the families), so the pump knows none of them. A message no check claims is wanted; so is
 * one whose check throws, because a repeat is free and a dropped message is not. An end here tells nobody: the owner is the one who knows.
 */
export class MessageObligations {
  private readonly checks: Array<{ idPrefix: string; check: ObligationCheck }> = [];

  register(idPrefix: string, check: ObligationCheck): void {
    if (this.checks.some((entry) => entry.idPrefix === idPrefix)) throw new Error(`An obligation check for ${idPrefix} is already registered.`);
    this.checks.push({ idPrefix, check });
  }

  whyNoLongerWanted(message: ObligedMessage): string | null {
    return this.checks.find((entry) => message.id.startsWith(entry.idPrefix))?.check(message) ?? null;
  }
}

export type SenderReturnResult =
  | { readonly kind: "returned"; readonly qitemId: string }
  /** No queue can reach the sender (it has none, or its rig is gone): the row ends `undeliverable` naming why, keeps its text, and health
   *  names it, since nothing later can change it. */
  | { readonly kind: "no_return_path"; readonly reason: string };

/** Gives the sender a queue item for a message that can never arrive. Repeatable: a crash after it runs repeats it on the same item.
 *  A throw means "not now"; the pump comes back. */
export interface SenderReturn {
  returnToSender(message: { readonly id: MessageId; readonly seat: string; readonly sender: string; readonly body: string }, reason: string): Promise<SenderReturnResult>;
}
