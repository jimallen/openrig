import type Database from "better-sqlite3";
import { OutboxHandler, OutboxHandlerError, type OutboxRecordInput } from "../outbox-handler.js";
import { messageId, type GateRecord, type LastHopResult, type MessageId, type SeatMessage } from "./ports.js";
import type { HeldBinding } from "./pump-ports.js";

/**
 * The `Message` aggregate's persistence (census-delivery-guarantees-20261101, part 2). It reuses the outbox row and owns the
 * `message_*` columns. Every move is a compare-and-set on those columns, so the database, not memory, says where a message is.
 *
 * Invariants held here: (2) id and body are never rewritten; (3) only `recordReceived`, which takes a gate record, makes a row
 * `received`; (5) `headOf` is the oldest open row of a seat's first open lane: FIFO per seat per lane, by rowid, the one order every writer shares.
 *
 * `delivery_state` stays what old readers expect: an accepted row is `pending`, and a held row that rejoins stays `retained` until
 * it is received, so `rig seat held-messages`, `retire`, the quota and a rolled-back daemon all keep seeing a held message as held.
 * A retired row leaves the pump, because `OPEN` requires `pending` or `retained`.
 */
export const MESSAGE_STATES = ["accepted", "attempting", "received", "undeliverable"] as const;
export type MessageState = (typeof MESSAGE_STATES)[number];

type HopPause = Extract<LastHopResult, { kind: "paused" }>["reason"];
/** Why the pump is not attempting now. `gate_unavailable` is the pump's own: the gate cannot be read, which proves nothing. */
export type MessagePauseReason = HopPause | "gate_unavailable";

/** FIFO's unit (S4 design, N4). The lowest open lane goes first, so nothing lands between restore stages or ahead of a startup packet. */
export const MESSAGE_LANES = { startup: 0, compaction: 1, content: 2 } as const;
export type MessageLane = (typeof MESSAGE_LANES)[keyof typeof MESSAGE_LANES];

export interface StoredMessage extends SeatMessage {
  readonly sender: string;
  readonly lane: number;
  readonly state: "accepted" | "attempting";
  readonly attempts: number;
  /** Null: never attempted, so it is due now. */
  readonly nextAttemptAtMs: number | null;
  readonly pauseReason: MessagePauseReason | null;
  readonly lastRefusal: string | null;
  readonly acceptedAt: string;
}

export interface MessageAcceptInput extends Pick<OutboxRecordInput, "urgency" | "tags" | "auditPointer" | "identityProvenance"> {
  id: MessageId;
  seat: string;
  sender: string;
  body: string;
  occupantGeneration?: string | null;
  lane?: MessageLane;
  /** S1's class. A `command` is refused here: it stays with its owner (`/compact` with the compaction enforcer). */
  messageClass?: string | null;
  /** Null or absent: at once. */
  firstAttemptAtMs?: number | null;
}

/** How a wait on a message ended. `timeout` says nothing about the message: it is still open and the pump is still on it. */
export type MessageOutcome = "received" | "undeliverable" | "open" | "unknown";

export interface OpenSeatSummary {
  seat: string;
  open: number;
  oldestId: string;
  oldestAcceptedAt: string;
  attempts: number;
  pauseReason: string | null;
  lastRefusal: string | null;
  state: string;
}

interface MessageRow {
  outbox_id: string;
  sender_session: string;
  destination_session: string;
  body: string;
  ts_dispatched: string;
  message_state: string;
  lane: number;
  attempts: number;
  message_next_attempt_ms: number | null;
  message_pause_reason: string | null;
  message_last_refusal: string | null;
  occupant_generation: string | null;
}

const OPEN = "message_state IN ('accepted', 'attempting') AND delivery_state IN ('pending', 'retained')";

const PAUSE_REASONS: readonly string[] = ["busy", "blocked", "guard_held", "seat_stopped", "gate_unavailable"];

function pauseReasonOf(raw: string | null): MessagePauseReason | null {
  return raw !== null && PAUSE_REASONS.includes(raw) ? raw as MessagePauseReason : null;
}

function toMessage(row: MessageRow): StoredMessage {
  return {
    id: messageId(row.outbox_id), seat: row.destination_session, sender: row.sender_session, body: row.body,
    occupantGeneration: row.occupant_generation,
    state: row.message_state === "accepted" ? "accepted" : "attempting", lane: row.lane,
    attempts: row.attempts, nextAttemptAtMs: row.message_next_attempt_ms,
    pauseReason: pauseReasonOf(row.message_pause_reason), lastRefusal: row.message_last_refusal, acceptedAt: row.ts_dispatched,
  };
}

export class MessageStore {
  private readonly outbox: OutboxHandler;
  constructor(private readonly db: Database.Database) { this.outbox = new OutboxHandler(db); }

  /** Commits the row before any attempt (invariant 1). Accepting an id again is the same answer, so a sender may repeat it free. A
   *  row the send path already wrote and has not settled is adopted; one it settled is refused, since accepting it would send it again. */
  accept(input: MessageAcceptInput): StoredMessage {
    if (input.messageClass === "command") throw new OutboxHandlerError("command_not_pumped", "A command is confirmed by its effect and stays with its owner; the pump never carries it.");
    return this.db.transaction(() => {
      const existing = this.outbox.getById(input.id);
      if (existing && (existing.senderSession !== input.sender || existing.destinationSession !== input.seat || existing.body !== input.body)) {
        throw new OutboxHandlerError("delivery_identity_conflict", "The message id already names different content or target identity.");
      }
      if (existing && existing.deliveryState !== "pending") {
        const open = this.db.prepare(`SELECT 1 FROM outbox_entries WHERE outbox_id = ? AND ${OPEN}`).get(input.id) !== undefined;
        if (!open) throw new OutboxHandlerError("delivery_already_attempted", `Message ${input.id} is already ${existing.deliveryState}; it is not accepted again.`);
      }
      this.outbox.record({
        outboxId: input.id, senderSession: input.sender, destinationSession: input.seat, body: input.body,
        urgency: input.urgency, tags: input.tags, auditPointer: input.auditPointer, identityProvenance: input.identityProvenance,
      });
      this.db.prepare(`UPDATE outbox_entries SET message_state = 'accepted', occupant_generation = ?, lane = ?, message_class = ?, message_next_attempt_ms = ?
        WHERE outbox_id = ? AND message_state IS NULL`).run(input.occupantGeneration ?? null, input.lane ?? MESSAGE_LANES.content, input.messageClass ?? null, input.firstAttemptAtMs ?? null, input.id);
      return toMessage(this.read(input.id)!);
    })();
  }

  /** Every seat with an open message, each once. */
  seatsWithOpenMessages(): string[] {
    return (this.db.prepare(`SELECT DISTINCT destination_session AS seat FROM outbox_entries WHERE ${OPEN}`).all() as Array<{ seat: string }>).map((r) => r.seat);
  }

  /** The seat's oldest open message: the only one the pump may attempt (invariant 5). */
  headOf(seat: string): StoredMessage | null {
    const row = this.db.prepare(`SELECT * FROM outbox_entries WHERE destination_session = ? AND ${OPEN} ORDER BY lane, rowid LIMIT 1`).get(seat) as MessageRow | undefined;
    return row ? toMessage(row) : null;
  }

  /** Write-ahead for an attempt: the count and the next time are committed before a byte leaves, so a crash mid-attempt resumes from
   *  here on the same schedule. The CAS on `attempts` means one claim per attempt. Leaves `accepted`. */
  claimAttempt(message: StoredMessage, nextAttemptAtMs: number): boolean {
    return this.db.prepare(`UPDATE outbox_entries SET message_state = 'attempting', attempts = attempts + 1,
        message_next_attempt_ms = ?, message_pause_reason = NULL
      WHERE outbox_id = ? AND attempts = ? AND ${OPEN}`).run(nextAttemptAtMs, message.id, message.attempts).changes === 1;
  }

  /** The hop did not send, so the claim gives its attempt back: a pause spends no step of the backoff. */
  recordHopPause(id: MessageId, reason: HopPause, nextAttemptAtMs: number): void {
    this.db.prepare(`UPDATE outbox_entries SET attempts = max(attempts - 1, 0), message_next_attempt_ms = ?, message_pause_reason = ?
      WHERE outbox_id = ? AND ${OPEN}`).run(nextAttemptAtMs, reason, id);
  }

  /** The gate cannot be read: no attempt was claimed, so there is none to give back. */
  recordGateUnavailable(id: MessageId, nextAttemptAtMs: number): void {
    this.db.prepare(`UPDATE outbox_entries SET message_state = 'attempting', message_next_attempt_ms = max(coalesce(message_next_attempt_ms, 0), ?), message_pause_reason = 'gate_unavailable'
      WHERE outbox_id = ? AND ${OPEN}`).run(nextAttemptAtMs, id);
  }

  recordRefusal(id: MessageId, reason: string): void {
    this.db.prepare(`UPDATE outbox_entries SET message_last_refusal = ? WHERE outbox_id = ? AND ${OPEN}`).run(reason, id);
  }

  recordSent(id: MessageId): void {
    this.db.prepare(`UPDATE outbox_entries SET message_last_refusal = NULL WHERE outbox_id = ? AND ${OPEN}`).run(id);
  }

  /** The only way to `received` (invariant 3). A row that is no longer open is left as it is. */
  recordReceived(record: GateRecord, gateVersion: number): boolean {
    return this.db.prepare(`UPDATE outbox_entries SET message_state = 'received', message_received_at = ?, message_gate_version = ?, message_gate_nonce = ?,
        message_next_attempt_ms = NULL, message_pause_reason = NULL, delivery_state = 'delivered', delivered_at = ?,
        delivery_path = NULL, ack_evidence = 'gate_seen', ack_detail = NULL
      WHERE outbox_id = ? AND ${OPEN}`).run(record.recordedAt, gateVersion, record.nonce, record.recordedAt, record.id).changes === 1;
  }

  /** Terminal. `returnQitem` is the sender's queue item, when one could be made. */
  recordUndeliverable(id: MessageId, reason: string, returnQitem: string | null, atIso: string): boolean {
    return this.db.prepare(`UPDATE outbox_entries SET message_state = 'undeliverable', message_closed_reason = ?, message_closed_at = ?, message_next_attempt_ms = NULL,
        message_pause_reason = NULL, delivery_state = 'failed', delivery_path = NULL, ack_evidence = 'seat_gone', ack_detail = ?
      WHERE outbox_id = ? AND ${OPEN}`).run(reason, atIso, returnQitem, id).changes === 1;
  }

  /** S4: ends a row nobody should still deliver (an unwound handover, a superseded reminder), with no notice to the sender. A record
   *  that arrives later changes nothing. */
  cancel(id: MessageId, reason: string, atIso: string): boolean {
    return this.db.prepare(`UPDATE outbox_entries SET message_state = 'undeliverable', message_closed_reason = ?, message_closed_at = ?, message_next_attempt_ms = NULL,
        message_pause_reason = NULL, delivery_state = 'failed', delivery_path = 'none', ack_evidence = 'superseded', ack_detail = NULL
      WHERE outbox_id = ? AND ${OPEN}`).run(reason, atIso, id).changes === 1;
  }

  /** Where a message stands now. A retired held row is not open and never arrived, so it reads `undeliverable`. */
  outcomeOf(id: MessageId): MessageOutcome {
    const row = this.db.prepare("SELECT message_state AS state, delivery_state AS delivery FROM outbox_entries WHERE outbox_id = ?").get(id) as { state: string | null; delivery: string } | undefined;
    if (!row || row.state === null) return "unknown";
    if (row.state === "received") return "received";
    if (row.state === "undeliverable" || row.delivery === "retired") return "undeliverable";
    return "open";
  }

  /** Decision 1: the same id and body, now for the successor. Attempt history stays with the message. */
  moveToSuccessor(id: MessageId, successor: string): boolean {
    return this.db.prepare(`UPDATE outbox_entries SET destination_session = ?, message_next_attempt_ms = NULL, message_pause_reason = NULL
      WHERE outbox_id = ? AND ${OPEN}`).run(successor, id).changes === 1;
  }

  /** Held rows the pump has not taken yet, oldest first. A binding that is not JSON names no seat, so such a row stays with `retire`. */
  listHeld(): Array<{ id: MessageId; seat: string; binding: HeldBinding }> {
    const rows = this.db.prepare(`SELECT outbox_id AS id, destination_session AS seat, guard_binding AS binding FROM outbox_entries
      WHERE delivery_state = 'retained' AND message_state IS NULL AND guard_binding IS NOT NULL AND json_valid(guard_binding) ORDER BY rowid`)
      .all() as Array<{ id: string; seat: string; binding: string }>;
    return rows.map((r) => ({ id: messageId(r.id), seat: r.seat, binding: JSON.parse(r.binding) as HeldBinding }));
  }

  /** Decision 4: a held message rejoins its seat's queue when the guard lifts. It keeps its rowid, so it stays ahead of anything
   *  newer, and stays `retained` until received (see the class note). */
  adoptHeld(id: MessageId): boolean {
    return this.db.prepare(`UPDATE outbox_entries SET message_state = 'accepted' WHERE outbox_id = ? AND delivery_state = 'retained' AND message_state IS NULL`).run(id).changes === 1;
  }

  /** One line per seat with an open message: how many, and the oldest. SELECT only. */
  openBySeat(): OpenSeatSummary[] {
    const rows = this.db.prepare(`SELECT destination_session AS seat, count(*) AS open FROM outbox_entries WHERE ${OPEN} GROUP BY destination_session ORDER BY min(rowid)`)
      .all() as Array<{ seat: string; open: number }>;
    return rows.map((r) => {
      const head = this.headOf(r.seat)!;
      return { seat: r.seat, open: r.open, oldestId: head.id, oldestAcceptedAt: head.acceptedAt, attempts: head.attempts,
        pauseReason: head.pauseReason, lastRefusal: head.lastRefusal, state: head.state };
    });
  }

  /** How many messages reached each end since `sinceIso`. SELECT only. */
  endedSince(sinceIso: string): { received: number; undeliverable: number } {
    const count = (state: MessageState, column: string) => (this.db.prepare(`SELECT count(*) AS n FROM outbox_entries WHERE message_state = ? AND ${column} >= ?`)
      .get(state, sinceIso) as { n: number }).n;
    return { received: count("received", "message_received_at"), undeliverable: count("undeliverable", "message_closed_at") };
  }

  private read(id: string): MessageRow | undefined {
    return this.db.prepare("SELECT * FROM outbox_entries WHERE outbox_id = ?").get(id) as MessageRow | undefined;
  }
}
