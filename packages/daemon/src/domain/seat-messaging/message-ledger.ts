import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import {
  isUnconfirmedHcSend, labelForTmuxSend, OutboxHandler, SEAT_MESSAGE_ID_PREFIX,
  type OutboxDeliveryPath, type SeatMessageClass, type SeatMessageLane,
} from "../outbox-handler.js";

/**
 * The `Message` aggregate's write seam (Seat Messaging; design: census-delivery-guarantees-20261101, part 2). Two invariants live here:
 *  1. The row commits before anything is written to the seat, so a crash at any later point leaves it.
 *  2. The id and the body never change: a repeat under an id is one more attempt at the same row, never a second row.
 *
 * Delivery itself is not this module's business, and S1 changes none of it: nothing here retries, gates or reads a seat.
 */

/** A new message's id, when its caller named none. */
export function mintMessageId(): string {
  return `${SEAT_MESSAGE_ID_PREFIX}${randomUUID()}`;
}

/** A lifecycle message's id: its seat, its occupant and its text decide it, so a repeat for this occupant is the same message and
 *  the same text to a successor is a different one. */
export function lifecycleMessageId(kind: string, seat: string, occupantGeneration: string | null, body: string): string {
  try {
    const digest = createHash("sha256").update(JSON.stringify([seat, occupantGeneration, body])).digest("hex").slice(0, 32);
    return `${SEAT_MESSAGE_ID_PREFIX}${kind}-${digest}`;
  } catch {
    return mintMessageId(); // A hash that fails must not fail a startup: this one write gets a one-off id.
  }
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

  constructor(private readonly db: Database.Database, private readonly opts?: { resolveOccupantGeneration?: (seat: string) => string | null }) {
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
          lane: input.lane ?? (input.messageClass === "lifecycle" ? 0 : input.messageClass === "command" ? null : 2),
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

  /**
   * Text a daemon writes to a seat without going through SessionTransport (startup, handover, the resume probe): the row first, then
   * `write`, which includes its Enter, then the row settled. A row that cannot be written stops the write. Nothing here retries.
   */
  async carryDirect<T extends { ok: boolean; message?: string }>(input: DirectTextInput, write: () => Promise<T>): Promise<T> {
    const generation = input.occupantGeneration ?? this.opts?.resolveOccupantGeneration?.(input.seat) ?? null;
    const id = lifecycleMessageId(input.kind, input.seat, generation, input.body);
    const accepted = this.accept({
      id, seat: input.seat, body: input.body, sender: DIRECT_TEXT_SENDER, identityProvenance: "transport:v1",
      messageClass: input.messageClass, occupantGeneration: generation,
    });
    this.beginAttempt(accepted.id);
    const path = this.pathOf(input.seat);
    let result: T;
    try {
      result = await write();
    } catch (error) {
      this.settleThrown(accepted.id, path);
      throw error;
    }
    if (this.hasTable) {
      this.outbox.returnToPending(id);
      if (result.ok) this.outbox.markDelivered(id, { path, evidence: "send_ok" });
      else this.outbox.markFailed(id, { path, evidence: "send_failed", detail: result.message ?? null });
    }
    return result;
  }

  /** The hop a direct write used: the seat's binding says. A seat with no binding yet is on the daemon's host, and tmux is the label's
   *  default, as `labelForTmuxSend` has it. */
  private pathOf(seat: string): OutboxDeliveryPath {
    try {
      const row = this.db.prepare("SELECT attachment_type AS t FROM bindings WHERE tmux_session = ? ORDER BY updated_at DESC LIMIT 1").get(seat) as { t: string | null } | undefined;
      return row?.t === "hc" ? "hc" : "tmux";
    } catch {
      return "tmux";
    }
  }
}

/** The sender of a row the daemon wrote for its own lifecycle text. */
export const DIRECT_TEXT_SENDER = "daemon@kernel";

export interface DirectTextInput {
  /** Names the site in the id: `startup`, `handover-restore`, `handover-rebuild`, `resume-probe`. */
  kind: string;
  seat: string;
  body: string;
  messageClass: SeatMessageClass;
  occupantGeneration?: string | null;
}

/** The port the runtime adapters and the refresher take, so they stay free of the database. */
export type DirectTextCarrier = Pick<MessageLedger, "carryDirect">;
