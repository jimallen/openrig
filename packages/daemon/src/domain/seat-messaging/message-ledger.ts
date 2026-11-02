import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  isUnconfirmedHcSend, labelForTmuxSend, OutboxHandler, SEAT_MESSAGE_ID_PREFIX,
  type OutboxDeliveryPath, type SeatMessageClass, type SeatMessageLane,
} from "../outbox-handler.js";
import { defaultLane } from "./message-store.js";

/**
 * The `Message` aggregate's write seam (Seat Messaging; design: census-delivery-guarantees-20261101, part 2). Two invariants live here:
 *  1. The row commits before anything is written to the seat, so a crash at any later point leaves it.
 *  2. The id and the body never change: a repeat under an id is one more attempt at the same row, never a second row.
 *
 * Text written past SessionTransport (startup, handover, the resume probe) is not here: those 8 sites move in S4 and keep their own loops.
 * Delivery itself is not this module's business, and S1 changes none of it: nothing here retries, gates or reads a seat.
 */

/** A new message's id, when its caller named none. */
export function mintMessageId(): string {
  return `${SEAT_MESSAGE_ID_PREFIX}${randomUUID()}`;
}

export interface AcceptInput {
  id: string;
  seat: string;
  body: string;
  sender: string;
  identityProvenance: string;
  auditPointer?: string;
  messageClass?: SeatMessageClass;
  lane?: SeatMessageLane;
  occupantGeneration?: string | null;
  /** The row's body wins over `body`: for a caller that rebuilds its text per attempt from a stamp or a clock. Off, a different body
   *  under the same id is a conflict. */
  freezeBody?: boolean;
}

export type AcceptOutcome =
  | { kind: "accepted"; id: string; body: string }
  | { kind: "conflict"; id: string }
  /** A database with no outbox table (a curated test schema): there is nothing to commit to. */
  | { kind: "no_table"; id: string; body: string };

/** Enough of a send's result to settle its row. */
export interface AttemptResult {
  ok: boolean;
  sent?: boolean;
  path?: string;
  outcome?: string;
  verified?: boolean;
  reason?: string;
  hcPending?: unknown;
}

export class MessageLedger {
  private readonly outbox: OutboxHandler;
  private readonly hasTable: boolean;

  constructor(private readonly db: Database.Database) {
    this.outbox = new OutboxHandler(db);
    this.hasTable = (db.prepare("PRAGMA table_info(outbox_entries)").all() as Array<{ name?: string }>).some((col) => col.name === "outbox_id");
  }

  /** Commits the row, or counts one more attempt on it. Throws when the row cannot be written: the caller must not send. */
  accept(input: AcceptInput): AcceptOutcome {
    if (!this.hasTable) return { kind: "no_table", id: input.id, body: input.body };
    return this.db.transaction((): AcceptOutcome => {
      const prior = this.outbox.getById(input.id);
      if (!prior) {
        this.outbox.record({
          outboxId: input.id, senderSession: input.sender, destinationSession: input.seat, body: input.body,
          identityProvenance: input.identityProvenance,
          ...(input.auditPointer ? { auditPointer: input.auditPointer } : {}),
          ...(input.messageClass ? { messageClass: input.messageClass } : {}),
          lane: input.lane ?? (input.messageClass === "command" ? null : defaultLane(input.messageClass)),
          ...(input.occupantGeneration ? { occupantGeneration: input.occupantGeneration } : {}),
          // A Command is confirmed by effect and retried by its owner, so it is never the pump's.
          ...(input.messageClass === "command" ? {} : { messageState: "accepted" as const }),
        });
        return { kind: "accepted", id: input.id, body: input.body };
      }
      if (!input.freezeBody && (prior.body !== input.body || prior.destinationSession !== input.seat || prior.senderSession !== input.sender)) {
        return { kind: "conflict", id: input.id };
      }
      return { kind: "accepted", id: input.id, body: prior.body };
    })();
  }

  /** Separate from `accept`, so a crash between them leaves `accepted` with 0 attempts: a message that certainly never went out. */
  beginAttempt(id: string): void {
    if (this.hasTable) this.outbox.beginAttempt(id);
  }

  /** The outcome of one attempt. Only a row still open moves, so a retained, native or already settled row is left as it is. */
  settle(id: string, result: AttemptResult, opts?: { keepOpenOnRefusal?: boolean }): void {
    if (!this.hasTable || result.outcome === "retained") return;
    if (result.path === "native") { this.outbox.closeMessageState(id); return; }
    this.outbox.returnToPending(id);
    if (result.ok) this.outbox.markDelivered(id, labelForTmuxSend(result));
    else if (isUnconfirmedHcSend(result)) this.outbox.markIndeterminate(id, labelForTmuxSend(result));
    else if (opts?.keepOpenOnRefusal) return;
    else this.outbox.markFailed(id, labelForTmuxSend(result));
  }

  /** An attempt that threw: bytes may have left, so the row is neither delivered nor failed. */
  settleThrown(id: string, path: OutboxDeliveryPath): void {
    if (!this.hasTable) return;
    this.outbox.returnToPending(id);
    this.outbox.markIndeterminate(id, { path, evidence: "send_failed", detail: "thrown" });
  }
}
