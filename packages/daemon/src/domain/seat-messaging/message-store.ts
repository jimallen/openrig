import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { OutboxHandler, OutboxHandlerError, type OutboxRecordInput } from "../outbox-handler.js";
import { messageId, type GateRecord, type LastHopResult, type MessageId, type SeatMessageClass, type SeatMessageLane } from "./ports.js";
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
 * A retired row leaves the pump, because `OPEN` does not admit it.
 */
export const MESSAGE_STATES = ["accepted", "attempting", "received", "undeliverable"] as const;
export type MessageState = (typeof MESSAGE_STATES)[number];

type HopPause = Extract<LastHopResult, { kind: "paused" }>["reason"];
/** Why the pump is not attempting now. Two are the pump's own: `gate_unavailable`, the gate cannot be read, which proves nothing; `lane_held`,
 *  the seat's startup or another lifecycle sequence has the content lane. */
export type MessagePauseReason = HopPause | "gate_unavailable" | "lane_held";

/** FIFO's unit (S4 design, N4). The lowest open lane goes first, so nothing lands between restore stages or ahead of a startup packet. */
export const MESSAGE_LANES = { startup: 0, compaction: 1, content: 2 } as const satisfies Record<string, SeatMessageLane>;

/** A message's lane when its caller named none. The compaction enforcer names its own. */
export function defaultLane(messageClass: SeatMessageClass | undefined): SeatMessageLane {
  return messageClass === "lifecycle" ? MESSAGE_LANES.startup : MESSAGE_LANES.content;
}

export interface StoredMessage {
  readonly id: MessageId;
  readonly seat: string;
  readonly body: string;
  readonly occupantGeneration: string | null;
  /** The queue item or job this message stands for, when it has one. */
  readonly auditPointer: string | null;
  /** The wake group this row went out with. Null: a message on its own. */
  readonly group: string | null;
  /** Set when a held row went to a new occupant: the occupant that held it. Every attempt then carries the label. */
  readonly previousOccupant: string | null;
  /** The pump took this row. Otherwise it is S1's bookkeeping on a seat the pump does not serve. */
  readonly pumpOwned: boolean;
  readonly sender: string;
  readonly lane: SeatMessageLane;
  readonly messageClass: SeatMessageClass;
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
  lane?: SeatMessageLane;
  /** Absent reads as content. A `command` is refused here: it stays with its owner (`/compact` with the compaction enforcer). */
  messageClass?: SeatMessageClass;
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
  lane: number | null;
  class: string | null;
  attempts: number;
  next_attempt_at: string | null;
  message_pause_reason: string | null;
  message_last_refusal: string | null;
  occupant_generation: string | null;
  audit_pointer: string | null;
  message_group: string | null;
  message_previous_occupant: string | null;
  message_pump_owned: number | null;
}

/** Open and the pump's. A `retained` row is the guard's until its hold is released; a `retired` or settled row is nobody's. */
const OPEN = "message_state IN ('accepted', 'attempting') AND (delivery_state = 'pending' OR (delivery_state = 'retained' AND message_hold_released_at IS NOT NULL))";

const PAUSE_REASONS: readonly string[] = ["busy", "blocked", "guard_held", "seat_stopped", "draft", "agent_absent", "gate_unavailable", "lane_held"];

function pauseReasonOf(raw: string | null): MessagePauseReason | null {
  return raw !== null && PAUSE_REASONS.includes(raw) ? raw as MessagePauseReason : null;
}

/** Columns with no CHECK: a value this build does not know reads as the default, the lane and class nothing special happens on. */
function laneOf(raw: number | null): SeatMessageLane { return raw === 0 || raw === 1 ? raw : 2; }
function classOf(raw: string | null): SeatMessageClass { return raw === "nudge" || raw === "lifecycle" ? raw : "content"; }

function iso(ms: number | null): string | null { return ms === null ? null : new Date(ms).toISOString(); }

function toMessage(row: MessageRow): StoredMessage {
  return {
    id: messageId(row.outbox_id), seat: row.destination_session, sender: row.sender_session, body: row.body,
    occupantGeneration: row.occupant_generation, auditPointer: row.audit_pointer, group: row.message_group, previousOccupant: row.message_previous_occupant, pumpOwned: row.message_pump_owned === 1,
    state: row.message_state === "accepted" ? "accepted" : "attempting",
    lane: laneOf(row.lane), messageClass: classOf(row.class),
    attempts: row.attempts, nextAttemptAtMs: row.next_attempt_at === null ? null : Date.parse(row.next_attempt_at),
    pauseReason: pauseReasonOf(row.message_pause_reason), lastRefusal: row.message_last_refusal, acceptedAt: row.ts_dispatched,
  };
}

/** Rolls a group's claim back: another claim took one of its rows first. */
class LostClaim extends Error {}

export class MessageStore {
  private readonly outbox: OutboxHandler;
  constructor(private readonly db: Database.Database) { this.outbox = new OutboxHandler(db); }

  /** Commits the row before any attempt (invariant 1). Accepting an id again is the same answer, so a sender may repeat it free. A
   *  row the send path already wrote and has not settled is adopted; one it settled is refused, since accepting it would send it again. */
  accept(input: MessageAcceptInput & { freezeBody?: boolean }): StoredMessage {
    if (input.messageClass === "command") throw new OutboxHandlerError("command_not_pumped", "A command is confirmed by its effect and stays with its owner; the pump never carries it.");
    return this.db.transaction(() => {
      const existing = this.outbox.getById(input.id);
      if (existing && (existing.senderSession !== input.sender || existing.destinationSession !== input.seat || (!input.freezeBody && existing.body !== input.body))) {
        throw new OutboxHandlerError("delivery_identity_conflict", "The message id already names different content or target identity.");
      }
      if (existing && existing.deliveryState !== "pending" && existing.deliveryState !== "retained") {
        const open = this.db.prepare(`SELECT 1 FROM outbox_entries WHERE outbox_id = ? AND ${OPEN}`).get(input.id) !== undefined;
        if (!open) throw new OutboxHandlerError("delivery_already_attempted", `Message ${input.id} is already ${existing.deliveryState}; it is not accepted again.`);
      }
      this.outbox.record({
        outboxId: input.id, senderSession: input.sender, destinationSession: input.seat, body: input.body,
        urgency: input.urgency, tags: input.tags, auditPointer: input.auditPointer, identityProvenance: input.identityProvenance,
      });
      this.db.prepare(`UPDATE outbox_entries SET message_state = 'accepted', message_id = coalesce(message_id, outbox_id), occupant_generation = ?, lane = ?, class = ?, next_attempt_at = ?
        WHERE outbox_id = ? AND message_state IS NULL`).run(input.occupantGeneration ?? null, input.lane ?? defaultLane(input.messageClass), input.messageClass ?? null, iso(input.firstAttemptAtMs ?? null), input.id);
      this.db.prepare("UPDATE outbox_entries SET message_pump_owned = 1 WHERE outbox_id = ? AND message_state IN ('accepted', 'attempting')").run(input.id);
      return toMessage(this.read(input.id)!);
    })();
  }

  /** Every seat with an open message, each once. */
  seatsWithOpenMessages(): string[] {
    return (this.db.prepare(`SELECT DISTINCT destination_session AS seat FROM outbox_entries WHERE ${OPEN}`).all() as Array<{ seat: string }>).map((r) => r.seat);
  }

  /** The seat's oldest open message: the only one the pump may attempt (invariant 5). */
  headOf(seat: string): StoredMessage | null {
    const row = this.db.prepare(`SELECT * FROM outbox_entries WHERE destination_session = ? AND ${OPEN} ORDER BY coalesce(lane, 2), rowid LIMIT 1`).get(seat) as MessageRow | undefined;
    return row ? toMessage(row) : null;
  }

  /** `message` and the rows that go out with it, in staging order, which is rowid. Only rows that can be one text: still open, and for the same
   *  seat, lane and occupant. A member that left any of those goes on its own when its turn comes. */
  groupOf(message: StoredMessage): StoredMessage[] {
    if (message.group === null) return [message];
    const rows = this.db.prepare(`SELECT * FROM outbox_entries WHERE message_group = ? AND destination_session = ? AND coalesce(lane, 2) = ? AND occupant_generation IS ? AND ${OPEN} ORDER BY rowid`)
      .all(message.group, message.seat, message.lane, message.occupantGeneration) as MessageRow[];
    return rows.map(toMessage);
  }

  /** Write-ahead for an attempt: the count and the next time are committed before a byte leaves, so a crash mid-attempt resumes from
   *  here on the same schedule. The CAS on `attempts` means one claim per attempt. Leaves `accepted`. */
  claimAttempt(message: StoredMessage, nextAttemptAtMs: number): boolean {
    return this.db.prepare(`UPDATE outbox_entries SET message_state = 'attempting', attempts = attempts + 1,
        next_attempt_at = ?, message_pause_reason = NULL, native_nonce = coalesce(native_nonce, ?)
      WHERE outbox_id = ? AND attempts = ? AND ${OPEN}`).run(iso(nextAttemptAtMs), randomBytes(16).toString("hex"), message.id, message.attempts).changes === 1;
  }

  /** One attempt of one text: every row claims it, or none does. */
  claimAttempts(messages: readonly StoredMessage[], nextAttemptAtMs: number): boolean {
    const claimAll = this.db.transaction(() => {
      for (const message of messages) if (!this.claimAttempt(message, nextAttemptAtMs)) throw new LostClaim();
    });
    try {
      claimAll();
      return true;
    } catch (error) {
      if (error instanceof LostClaim) return false;
      throw error;
    }
  }

  /** The nonce every attempt of this message carries, or null before its first. A gate's record is this message's only under it. */
  nonceOf(id: MessageId): string | null {
    return (this.db.prepare("SELECT native_nonce AS nonce FROM outbox_entries WHERE outbox_id = ?").get(id) as { nonce: string | null } | undefined)?.nonce ?? null;
  }

  senderOf(id: MessageId): string | null {
    return (this.db.prepare("SELECT sender_session AS sender FROM outbox_entries WHERE outbox_id = ?").get(id) as { sender: string } | undefined)?.sender ?? null;
  }

  /** Recorded before the write, so a crash after it still waits (M1). */
  recordSocketWrite(id: MessageId, atMs: number): void {
    this.db.prepare("UPDATE outbox_entries SET message_socket_written_ms = ? WHERE outbox_id = ?").run(atMs, id);
  }

  lastSocketWriteMs(id: MessageId): number | null {
    return (this.db.prepare("SELECT message_socket_written_ms AS at FROM outbox_entries WHERE outbox_id = ?").get(id) as { at: number | null } | undefined)?.at ?? null;
  }

  /** Reconcile cleared this (id, nonce): the hook recorded it and the agent died before persisting it (M5), so the message did not
   *  arrive, whatever the row says. It opens again, keeping its id, nonce, body and place in the queue. The one way out of `received`, and
   *  only for the nonce the gate cleared. A row that is still open needs nothing: its next attempt now passes the gate. */
  reopenCleared(id: MessageId, nonce: string): boolean {
    return this.db.prepare(`UPDATE outbox_entries SET message_state = 'attempting', delivery_state = 'pending', delivered_at = NULL, gate_recorded_at = NULL,
        gate_nonce = NULL, message_gate_version = NULL, delivery_path = NULL, ack_evidence = NULL, ack_detail = NULL, next_attempt_at = NULL, message_id = coalesce(message_id, outbox_id), message_pump_owned = 1
      WHERE outbox_id = ? AND native_nonce = ? AND delivery_state = 'delivered'`).run(id, nonce).changes === 1;
  }

  /** The hop did not send, so the claim gives its attempt back: a pause spends no step of the backoff. */
  recordHopPause(id: MessageId, reason: HopPause, nextAttemptAtMs: number): void {
    this.db.prepare(`UPDATE outbox_entries SET attempts = max(attempts - 1, 0), next_attempt_at = ?, message_pause_reason = ?
      WHERE outbox_id = ? AND ${OPEN}`).run(iso(nextAttemptAtMs), reason, id);
  }

  /** The gate cannot be read: no attempt was claimed, so there is none to give back. */
  recordGateUnavailable(id: MessageId, nextAttemptAtMs: number): void {
    this.db.prepare(`UPDATE outbox_entries SET message_state = 'attempting', next_attempt_at = max(coalesce(next_attempt_at, ''), ?), message_pause_reason = 'gate_unavailable'
      WHERE outbox_id = ? AND ${OPEN}`).run(iso(nextAttemptAtMs), id);
  }

  /** Waiting its lane's turn: nothing is claimed and nothing is rescheduled, so it goes on the first pass after the hold lifts. */
  recordLaneHeld(id: MessageId): void {
    this.db.prepare(`UPDATE outbox_entries SET message_pause_reason = 'lane_held' WHERE outbox_id = ? AND ${OPEN}`).run(id);
  }

  recordRefusal(id: MessageId, reason: string): void {
    this.db.prepare(`UPDATE outbox_entries SET message_last_refusal = ? WHERE outbox_id = ? AND ${OPEN}`).run(reason, id);
  }

  recordSent(id: MessageId): void {
    this.db.prepare(`UPDATE outbox_entries SET message_last_refusal = NULL WHERE outbox_id = ? AND ${OPEN}`).run(id);
  }

  get isOpen(): boolean { return this.db.open; }

  /** The only way to `received` (invariant 3). A row that is no longer open is left as it is. */
  recordReceived(record: GateRecord, gateVersion: number): boolean {
    return this.db.prepare(`UPDATE outbox_entries SET message_state = 'received', gate_recorded_at = ?, message_gate_version = ?, gate_nonce = ?,
        next_attempt_at = NULL, message_pause_reason = NULL, delivery_state = 'delivered', delivered_at = ?,
        delivery_path = NULL, ack_evidence = ?, ack_detail = NULL
      WHERE outbox_id = ? AND ${OPEN}`).run(record.recordedAt, gateVersion, record.nonce, record.recordedAt, record.evidence ?? "gate_seen", record.id).changes === 1;
  }

  /** Terminal. `returnQitem` is the sender's queue item, when one could be made. */
  recordUndeliverable(id: MessageId, reason: string, returnQitem: string | null, atIso: string): boolean {
    return this.db.prepare(`UPDATE outbox_entries SET message_state = 'undeliverable', message_closed_reason = ?, message_closed_at = ?, next_attempt_at = NULL,
        message_pause_reason = NULL, delivery_state = 'failed', delivery_path = NULL, ack_evidence = 'seat_gone', ack_detail = ?
      WHERE outbox_id = ? AND ${OPEN}`).run(reason, atIso, returnQitem, id).changes === 1;
  }

  /** S4: ends a row nobody should still deliver (an unwound handover, a superseded reminder, an operator's cancel), with no notice to the
   *  sender. A record that arrives later changes nothing. `actor` is whoever asked for it by hand; it is written to the same columns a
   *  hand-retired row uses (`retired_by`, `retired_at`, `retirement_reason`), so no schema moves. The daemon's own cancels pass none. */
  cancel(id: MessageId, reason: string, atIso: string, actor: string | null = null): boolean {
    return this.db.prepare(`UPDATE outbox_entries SET message_state = 'undeliverable', message_closed_reason = ?, message_closed_at = ?, next_attempt_at = NULL,
        message_pause_reason = NULL, delivery_state = 'failed', delivery_path = 'none', ack_evidence = 'superseded', ack_detail = NULL,
        retired_by = coalesce(?, retired_by), retired_at = coalesce(?, retired_at), retirement_reason = coalesce(?, retirement_reason)
      WHERE outbox_id = ? AND ${OPEN}`).run(reason, atIso, actor, actor === null ? null : atIso, actor === null ? null : reason, id).changes === 1;
  }

  /** Where a message stands now. A retired held row is not open and never arrived, so it reads `undeliverable`. */
  outcomeOf(id: MessageId): MessageOutcome {
    const row = this.db.prepare("SELECT message_state AS state, delivery_state AS delivery FROM outbox_entries WHERE outbox_id = ?").get(id) as { state: string | null; delivery: string } | undefined;
    if (!row || row.state === null) return "unknown";
    if (row.state === "received") return "received";
    if (row.state === "undeliverable" || row.delivery === "retired") return "undeliverable";
    return "open";
  }

  /** Jim's rule: only lifecycle text stays with its occupant. Other text bound to one (a watchdog's fire) goes on to the new occupant,
   *  labelled as sent to the previous one. */
  rebindToNewOccupant(id: MessageId, previousOccupant: string): boolean {
    return this.db.prepare(`UPDATE outbox_entries SET occupant_generation = NULL, message_previous_occupant = ? WHERE outbox_id = ? AND ${OPEN}`).run(previousOccupant, id).changes === 1;
  }

  /** Decision 1: the same id and body, now for the successor. Attempt history stays with the message. */
  moveToSuccessor(id: MessageId, successor: string): boolean {
    return this.db.prepare(`UPDATE outbox_entries SET destination_session = ?, next_attempt_at = NULL, message_pause_reason = NULL
      WHERE outbox_id = ? AND ${OPEN}`).run(successor, id).changes === 1;
  }

  /** Held rows still the guard's, oldest first. A binding that is not JSON reads as null: the seat is on the row. A command is not a
   *  message, so it stays with its owner. */
  listHeld(): Array<{ id: MessageId; seat: string; binding: HeldBinding | null }> {
    const rows = this.db.prepare(`SELECT outbox_id AS id, destination_session AS seat, CASE WHEN json_valid(guard_binding) THEN guard_binding END AS binding FROM outbox_entries
      WHERE delivery_state = 'retained' AND message_hold_released_at IS NULL AND class IS NOT 'command' ORDER BY rowid`)
      .all() as Array<{ id: string; seat: string; binding: string | null }>;
    return rows.map((r) => ({ id: messageId(r.id), seat: r.seat, binding: r.binding === null ? null : JSON.parse(r.binding) as HeldBinding }));
  }

  /** Decision 4: a held message rejoins its seat's queue when the guard lifts. It keeps its rowid, so it stays ahead of anything
   *  newer, and stays `retained` until received (see the class note). `previousOccupant`: the seat changed hands, so it goes labelled. */
  adoptHeld(id: MessageId, atIso: string, previousOccupant: string | null): boolean {
    return this.db.prepare(`UPDATE outbox_entries SET message_state = coalesce(message_state, 'accepted'), message_id = coalesce(message_id, outbox_id), message_hold_released_at = ?, message_previous_occupant = ?, message_pump_owned = 1
      WHERE outbox_id = ? AND delivery_state = 'retained' AND message_hold_released_at IS NULL`).run(atIso, previousOccupant, id).changes === 1;
  }

  /** Rows a drain claimed or still holds move to the pump, whole and together. A nudge in the content lane, unless the row says otherwise.
   *  More than one row is a wake group, named after its first: it goes out as one text. One row is no group, whatever an earlier run left. */
  adoptClaimed(ids: readonly MessageId[]): void {
    const group = ids.length > 1 ? ids[0]! : null;
    const adopt = this.db.prepare(`UPDATE outbox_entries SET delivery_state = 'pending', message_state = 'accepted', message_id = coalesce(message_id, outbox_id),
        class = coalesce(class, 'nudge'), lane = coalesce(lane, ?), message_pump_owned = 1, message_group = ?
      WHERE outbox_id = ? AND delivery_state IN ('pending', 'sending') AND message_state IS NULL`);
    this.db.transaction(() => { for (const id of ids) adopt.run(MESSAGE_LANES.content, group, id); })();
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
  endedSince(sinceIso: string): { received: number; returned: number } {
    const received = this.db.prepare("SELECT count(*) AS n FROM outbox_entries WHERE message_state = 'received' AND gate_recorded_at >= ?").get(sinceIso) as { n: number };
    const returned = this.db.prepare("SELECT count(*) AS n FROM outbox_entries WHERE message_state = 'undeliverable' AND ack_evidence = 'seat_gone' AND ack_detail IS NOT NULL AND message_closed_at >= ?").get(sinceIso) as { n: number };
    return { received: received.n, returned: returned.n };
  }

  /** Messages that ended with nobody told, oldest first: their seat is gone, and no queue can reach their sender. Their text stays on the row. SELECT only. */
  unreturnedSince(sinceIso: string): Array<{ id: string; seat: string; reason: string | null }> {
    return this.db.prepare(`SELECT outbox_id AS id, destination_session AS seat, message_closed_reason AS reason FROM outbox_entries
      WHERE message_state = 'undeliverable' AND ack_evidence = 'seat_gone' AND ack_detail IS NULL AND message_closed_at >= ? ORDER BY message_closed_at, rowid`)
      .all(sinceIso) as Array<{ id: string; seat: string; reason: string | null }>;
  }

  private read(id: string): MessageRow | undefined {
    return this.db.prepare("SELECT * FROM outbox_entries WHERE outbox_id = ?").get(id) as MessageRow | undefined;
  }
}
