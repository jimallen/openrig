import type Database from "better-sqlite3";
import { RowColumnReader } from "./unreadable-row.js";
import { namedRows } from "./named-rows.js";
import { parseSqliteUtcMs } from "./sqlite-time.js";
import { HC_UNSETTLED_ESCALATE_AFTER_MS } from "./hc-unsettled-health.js";
import type { SeatMessageClass, SeatMessageLane } from "./seat-messaging/ports.js";

/**
 * The EXECUTABLE wake-intent namespace. A durable wake intent is written by the
 * daemon (QueueRepository.stageWakeIntent) with an id under this prefix, and the
 * startup drain EXECUTES every pending row under it as a real wake.
 *
 * Single source of truth for the drain query. History: the W4-era MF5 route guard was unbuilt
 * (founder ruling, over-engineering audit), so `/outbox/record` accepted ids under this prefix.
 * u16 review N1 (coordinator decision, 2026-10-27) restored a narrow refusal: see
 * DAEMON_OUTBOX_ID_PREFIXES, which the route enforces.
 */
export const WAKE_INTENT_PREFIX = "wake-intent-";

/** Ids the daemon mints for a seat message (see domain/seat-messaging/message-ledger.ts). */
export const SEAT_MESSAGE_ID_PREFIX = "seat-msg-";

/**
 * Outbox id prefixes the daemon itself writes (wake intents; guard-claim-, guard-nudge-,
 * guard-watchdog-, guard-send-, guard-model- deliveries). `POST /outbox/record` refuses a caller
 * outboxId under any of them: otherwise a caller could pre-record a predictable daemon id and get
 * the later daemon row returned unchanged, carrying the manual-record origin marker that hides it
 * from RSI D8 (OF-77, u16 review N1).
 */
export const DAEMON_OUTBOX_ID_PREFIXES = [WAKE_INTENT_PREFIX, "guard-", SEAT_MESSAGE_ID_PREFIX] as const;

// `delivered` has TWO meanings in this table, keyed on the id prefix (OF-74 / review F1):
//  - `wake-intent-*` rows (drained by QueueRepository): `delivered` = the render was CONFIRMED;
//    ok-but-unverified becomes `indeterminate` (the W1 rule below).
//  - `/send` and `/broadcast` auto-recorded rows (`outbox-*`, transport:v1): `delivered` = the text
//    and Enter landed in the pane (transport result.ok), UNVERIFIED by default — a plain `rig send`
//    without --verify, or a rendered-unconfirmed outcome, still settles `delivered`.
// The W1 rule below therefore describes the wake-intent drain, not every writer of this table.
// W1 (transactional closure): `indeterminate` is the ambiguous-delivery outcome —
// a send that landed on the wire but whose render could not be CONFIRMED (transport
// res.ok && !verified). It is never silently promoted to `delivered` (unconfirmed)
// nor demoted to `failed` (it may have landed); the CAS transitions gate on 'pending',
// so an indeterminate row is TERMINAL-BY-CAS (reconciliation is an out-of-scope
// follow-on, not a W1 transition).
// `sending` (MF3) is a transient CLAIM state: a drainer atomically moves a wake
// intent pending→sending BEFORE the external send, so an overlapping drainer finds
// nothing to claim and cannot double-send. A crash mid-send leaves the row visibly
// `sending`; the recovery boundary (`reconcileAbandonedSending`, run once at
// startup) reconciles it to `indeterminate` — the send is never blindly re-driven.
export const OUTBOX_DELIVERY_STATES = ["pending", "sending", "delivered", "failed", "indeterminate", "retained", "retired"] as const;
export type OutboxDeliveryState = (typeof OUTBOX_DELIVERY_STATES)[number];

/**
 * Validate a raw `delivery_state` cell against the closed union before it is typed
 * as an {@link OutboxDeliveryState}. Replaces the prior unchecked `as` cast: a cast
 * never fails, so a stray DB value (corruption, a newer daemon's state read by an
 * older one) would silently masquerade as a typed value and make every downstream
 * narrowing unsound. We control every writer, so an unknown value is a real defect —
 * fail loud rather than fabricate a type.
 */
/** An entry as a route may show it. The nonce is what lets a gate tell a real message from a forged one, so it never leaves the daemon. */
export function publicOutboxEntry(entry: OutboxEntry): OutboxEntry {
  const { nativeNonce: _nonce, ...shown } = entry;
  return shown;
}

export function parseDeliveryState(raw: string): OutboxDeliveryState {
  if ((OUTBOX_DELIVERY_STATES as readonly string[]).includes(raw)) {
    return raw as OutboxDeliveryState;
  }
  throw new OutboxHandlerError(
    "invalid_delivery_state",
    `outbox row has unknown delivery_state ${JSON.stringify(raw)} (expected one of ${OUTBOX_DELIVERY_STATES.join(", ")})`,
  );
}

/** Native comms step 1: the last hop that carried (or would have carried) a settled row's text. `native` has no writer
 *  yet; `none` means nothing was sent (see migration 117). `hc` (hc cutover): a seat on herdr-core. Rows settled before
 *  the cutover keep `tmux`, which stays true of them; a daemon that predates `hc` reads the new value as an unreadable
 *  label (null, flagged) and never refuses the row. */
export const OUTBOX_DELIVERY_PATHS = ["tmux", "native", "gateway", "none", "hc"] as const;
export type OutboxDeliveryPath = (typeof OUTBOX_DELIVERY_PATHS)[number];

/** What a settled row's outcome rests on. The tmux values mirror SendResult's outcome vocabulary and the wake drain's
 *  classification; `crash_reconciled` is a `sending` claim a restarted daemon found (it may or may not have landed). */
export const OUTBOX_ACK_EVIDENCE = [
  "render_verified", "render_unconfirmed", "send_ok", "send_timeout", "send_failed", "retained",
  "gateway_owned", "local_inbox", "unroutable", "no_qitem", "superseded", "crash_reconciled",
  // Native comms step 3: written to the seat's inbox socket, awaiting its UserPromptSubmit ack; acked by that hook;
  // found in the seat's transcript after the ack was lost; not taken (or not confirmable) by the deadline.
  "native_written", "native_hook_delivered", "native_transcript", "native_unconfirmed",
  // hc cutover: the core accepted the send and a person is typing, or the reply was lost; neither is a failure. Both rows
  // are `indeterminate` and hold the pending record in `ack_detail`; a sweep settles them (`verified_after_wait` when the
  // evidence arrived). Never resent from here.
  "waiting_on_person", "outcome_unknown", "verified_after_wait",
  // hc cutover: the sweep proved the queued send was lost with a core restart (the program never took it, its screen is as it was).
  // The row stays `indeterminate` and listed, for a person to send again by hand: nothing resends it, and `failed` would have left
  // the list and `rig health` with no retry behind it.
  "send_gone",
  // Seat Messaging S3: the seat's gate recorded the id (the only thing that makes a Message `received`); the seat is gone for good.
  "gate_seen", "seat_gone",
  // Seat Messaging, decision 36: the far daemon's row is `received`, by that seat's own gate.
  "far_received",
] as const;
export type OutboxAckEvidence = (typeof OUTBOX_ACK_EVIDENCE)[number];

/** The labels of an hc send nobody has settled: the core may hold it, its reply was lost, or a crash left the claim. */
const HC_UNSETTLED_EVIDENCE = ["waiting_on_person", "outcome_unknown", "crash_reconciled", "send_gone"] as const;
const HC_UNSETTLED_EVIDENCE_SQL = HC_UNSETTLED_EVIDENCE.map((e) => `'${e}'`).join(", ");

/** How a row was settled. `detail` is the transport's own reason code, when it gave one. */
export interface OutboxOutcomeLabel {
  path: OutboxDeliveryPath;
  evidence: OutboxAckEvidence;
  detail?: string | null;
}

/** The label for a tmux send's result, from SendResult's own vocabulary (structural, so this module does not import the
 *  transport). An ok send that reports neither `outcome` nor `verified` is `send_ok`: it landed, with no render claim. */
/** An hc send with no confirmation yet: not a failure, and never to be resent by a caller (a queued send outlives its client). */
export function isUnconfirmedHcSend(res: { ok: boolean; reason?: string }): boolean {
  return !res.ok && (res.reason === "waiting_on_person" || res.reason === "delivery_outcome_unknown");
}

export function labelForTmuxSend(res: { ok: boolean; verified?: boolean; outcome?: string; reason?: string; path?: string; hcPending?: unknown }): OutboxOutcomeLabel {
  if (res.path === "hc") return labelForHcSend(res);
  if (res.outcome === "retained") return { path: "tmux", evidence: "retained", detail: res.reason ?? null };
  if (!res.ok || res.outcome === "failed") return { path: "tmux", evidence: "send_failed", detail: res.reason ?? null };
  if (res.outcome === "delivered" || res.verified === true) return { path: "tmux", evidence: "render_verified" };
  if (res.outcome === "rendered-unconfirmed" || res.verified === false) return { path: "tmux", evidence: "render_unconfirmed" };
  return { path: "tmux", evidence: "send_ok" };
}

/** The label for a send to a seat on hc. A send the core may still deliver is neither delivered nor failed: it is labelled
 *  with its pending record, which a later check needs to settle it. Anything else is labelled as a tmux send is, on the
 *  `hc` path. */
function labelForHcSend(res: { ok: boolean; verified?: boolean; outcome?: string; reason?: string; hcPending?: unknown }): OutboxOutcomeLabel {
  if (!res.ok && (res.reason === "waiting_on_person" || res.reason === "delivery_outcome_unknown")) {
    return {
      path: "hc", evidence: res.reason === "waiting_on_person" ? "waiting_on_person" : "outcome_unknown",
      detail: res.hcPending === undefined ? res.reason : JSON.stringify(res.hcPending),
    };
  }
  const { path: _path, ...label } = labelForTmuxSend({ ...res, path: undefined });
  return { path: "hc", ...label };
}

/** How a row's message is carried and what a repeat of it costs (design part 2, "Content versus nudge"). */
export const SEAT_MESSAGE_CLASSES = ["content", "nudge", "lifecycle", "command"] as const satisfies readonly SeatMessageClass[];
export type { SeatMessageClass, SeatMessageLane };

/** A message's own state (migration 122). Separate from `delivery_state`, whose vocabulary an older build must be able to read. */
export const SEAT_MESSAGE_STATES = ["accepted", "attempting", "received", "undeliverable"] as const;
export type SeatMessageState = (typeof SEAT_MESSAGE_STATES)[number];

export interface OutboxEntry {
  outboxId: string;
  senderSession: string;
  destinationSession: string;
  body: string;
  tags: string[] | null;
  urgency: string;
  tsDispatched: string;
  deliveryState: OutboxDeliveryState;
  deliveredAt: string | null;
  auditPointer: string | null;
  guardBinding?: { nodeId: string; session: string; occupant: string | null; pane: string | null } | null;
  /** OF-117: set on an entry served by a listing when its saved `tags` / `guard_binding` are not readable (they read as null
   *  BECAUSE of that). A read a decision rests on refuses instead (UnreadableRowError). */
  unreadable?: string[];
  retiredAt?: string | null;
  retiredBy?: string | null;
  retirementReason?: string | null;
  /** Native comms step 1 (migration 117): present only on a database that has the columns; null = settled unlabelled. */
  deliveryPath?: OutboxDeliveryPath | null;
  ackEvidence?: OutboxAckEvidence | null;
  ackDetail?: string | null;
  /** Native comms step 3 (migration 118). The nonce is internal: routes must not return it. */
  nativeNonce?: string | null;
  nativeWrittenAt?: string | null;
  nativeTranscriptPath?: string | null;
  /** Seat Messaging (migration 122): the id every attempt of this message carries. Differs from `outboxId` only on a native
   *  repeat's per-attempt row (`<id>.r<n>`). Older rows have none: their `outboxId` is their message id. */
  messageId?: string;
  messageClass?: SeatMessageClass | null;
  lane?: SeatMessageLane | null;
  attempts?: number;
  occupantGeneration?: string | null;
  /** Null: a row the pump never touches (legacy, settled, a wake row, a Command). Never written into `delivery_state`. */
  messageState?: SeatMessageState | null;
}

interface OutboxEntryRow {
  outbox_id: string;
  sender_session: string;
  destination_session: string;
  body: string;
  tags: string | null;
  urgency: string;
  ts_dispatched: string;
  delivery_state: string;
  delivered_at: string | null;
  audit_pointer: string | null;
  guard_binding?: string | null;
  retired_at?: string | null;
  retired_by?: string | null;
  retirement_reason?: string | null;
  delivery_path?: string | null;
  ack_evidence?: string | null;
  ack_detail?: string | null;
  native_nonce?: string | null;
  native_written_at?: string | null;
  native_transcript_path?: string | null;
  message_id?: string | null;
  class?: string | null;
  lane?: number | null;
  attempts?: number;
  occupant_generation?: string | null;
  message_state?: string | null;
}

/**
 * Daemon-written origin marker (OF-77, RSI D8). A row recorded through the manual audit route
 * (`POST /outbox/record`) carries this tag; the send path never does, so the D8 "outbox never
 * settles" detector can tell an audit row (which has no delivery to settle) from a send row.
 * Callers cannot forge or fake it: `record` strips any caller-supplied copy of the tag and adds
 * it only when the route passes `origin: "manual-record"`.
 */
export const OUTBOX_ORIGIN_MANUAL_RECORD_TAG = "origin:manual-record";

export interface OutboxRecordInput {
  outboxId?: string;
  senderSession: string;
  destinationSession: string;
  body: string;
  tags?: string[];
  urgency?: string;
  auditPointer?: string;
  /** P21 §4 era-stamp: the route passes `transport:v1` (senderSession derived from the transport
   *  header chokepoint). Written onto the outbox row; absence = claimed-era. */
  identityProvenance?: string | null;
  /** Set only by the manual audit route; stamps OUTBOX_ORIGIN_MANUAL_RECORD_TAG onto the row. */
  origin?: "manual-record";
  /** Seat Messaging (migration 122). `messageId` defaults to the row's id. All are dropped on a database before 122. A row with a
   *  `messageState` is one the pump may carry: only the message ledger sets it. */
  messageId?: string;
  messageClass?: SeatMessageClass;
  lane?: SeatMessageLane | null;
  occupantGeneration?: string | null;
  messageState?: SeatMessageState;
}

export class OutboxHandlerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function newOutboxId(): string {
  const ts = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const hex = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
  return `outbox-${ts}-${hex}`;
}

/**
 * Sender-side outbox. Symmetric to InboxHandler. Records what a sender
 * dispatched independent of receiver behavior. Idempotent on outbox_id.
 *
 * No event-bus events emitted in Phase A — outbox is pure audit. If a future
 * phase wants delivery-tracking events, add them through this surface.
 */
export class OutboxHandler {
  readonly db: Database.Database;
  /** P21 §4: detected once — a curated-migration test DB (or a pre-067 daemon) may lack the
   *  era-stamp column, so the writer degrades (omits it) instead of throwing. */
  private readonly hasIdentityProvenanceColumn: boolean;
  private readonly hasOutcomeLabelColumns: boolean;
  private readonly hasSeatMessageColumns: boolean;

  constructor(db: Database.Database) {
    this.db = db;
    this.hasIdentityProvenanceColumn = (
      this.db.prepare("PRAGMA table_info(outbox_entries)").all() as Array<{ name: string }>
    ).some((col) => col.name === "identity_provenance");
    this.hasOutcomeLabelColumns = (
      this.db.prepare("PRAGMA table_info(outbox_entries)").all() as Array<{ name: string }>
    ).some((col) => col.name === "ack_evidence");
    this.hasSeatMessageColumns = (
      this.db.prepare("PRAGMA table_info(outbox_entries)").all() as Array<{ name: string }>
    ).some((col) => col.name === "message_id");
  }

  /** The SET fragment and its values for an outcome label; empty when the database predates migration 117 or no label
   *  was given (the row then settles unlabelled, as before). */
  private labelSet(label: OutboxOutcomeLabel | undefined): { sql: string; values: Array<string | null> } {
    if (!label || !this.hasOutcomeLabelColumns) return { sql: "", values: [] };
    return { sql: ", delivery_path = ?, ack_evidence = ?, ack_detail = ?", values: [label.path, label.evidence, label.detail ?? null] };
  }

  record(input: OutboxRecordInput): OutboxEntry {
    const id = input.outboxId ?? newOutboxId();
    const existing = this.getByIdRaw(id);
    if (existing) return this.rowToEntry(existing);

    const ts = new Date().toISOString();
    const callerTags = input.tags?.filter((t) => t !== OUTBOX_ORIGIN_MANUAL_RECORD_TAG);
    const stamped = input.origin === "manual-record" ? [...(callerTags ?? []), OUTBOX_ORIGIN_MANUAL_RECORD_TAG] : callerTags;
    const tags = stamped ? JSON.stringify(stamped) : null;
    const urgency = input.urgency ?? "routine";

    if (this.hasIdentityProvenanceColumn) {
      this.db
        .prepare(
          `INSERT INTO outbox_entries (
            outbox_id, sender_session, destination_session, body, tags, urgency, ts_dispatched, audit_pointer, identity_provenance
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          input.senderSession,
          input.destinationSession,
          input.body,
          tags,
          urgency,
          ts,
          input.auditPointer ?? null,
          input.identityProvenance ?? null
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO outbox_entries (
            outbox_id, sender_session, destination_session, body, tags, urgency, ts_dispatched, audit_pointer
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          input.senderSession,
          input.destinationSession,
          input.body,
          tags,
          urgency,
          ts,
          input.auditPointer ?? null
        );
    }
    if (this.hasSeatMessageColumns) {
      this.db.prepare("UPDATE outbox_entries SET message_id = ?, class = ?, lane = ?, occupant_generation = ?, message_state = ? WHERE outbox_id = ?")
        .run(input.messageId ?? id, input.messageClass ?? null, input.lane ?? null, input.occupantGeneration ?? null, input.messageState ?? null, id);
    }

    return this.getByIdOrThrow(id);
  }

  /**
   * One more attempt at a message whose row exists. The attempt is counted, and a row the last attempt left `failed` is open again, so
   * this attempt's outcome can settle it. A row a native sweep failed over is not reopened: its tmux copy is in flight and
   * `settleFallback` owns it. A settled row keeps its state. A Command never gets a message state: the enforcer owns its retry.
   */
  beginAttempt(outboxId: string): void {
    if (!this.hasSeatMessageColumns) return;
    this.db.prepare(`UPDATE outbox_entries SET attempts = attempts + 1,
        delivery_state = CASE WHEN delivery_state = 'failed' AND ack_evidence IS NOT 'native_unconfirmed' THEN 'pending' ELSE delivery_state END,
        message_state = CASE
          WHEN class IS 'command' THEN NULL
          WHEN delivery_state IN ('pending', 'sending', 'retained') OR (delivery_state = 'failed' AND ack_evidence IS NOT 'native_unconfirmed') THEN 'attempting'
          ELSE message_state END
      WHERE outbox_id = ?`).run(outboxId);
  }

  /** A committed wake row's attempt: counted only. The drain owns the row, so it takes no message state. */
  countAttempt(outboxId: string): void {
    if (!this.hasSeatMessageColumns) return;
    this.db.prepare("UPDATE outbox_entries SET attempts = attempts + 1 WHERE outbox_id = ?").run(outboxId);
  }

  /** A row settled by today's paths is out of the pump's hands. */
  private closedMessage(): string {
    return this.hasSeatMessageColumns ? ", message_state = NULL" : "";
  }

  /** The row is no longer the pump's to carry: today's paths settled it, or a native sweep owns it. `received` is never set here. */
  closeMessageState(outboxId: string): void {
    if (!this.hasSeatMessageColumns) return;
    this.db.prepare("UPDATE outbox_entries SET message_state = NULL WHERE outbox_id = ? AND message_state IN ('accepted', 'attempting')").run(outboxId);
  }

  /** A native claim released with nothing written leaves an adopted row `sending` with no label. A message row not owned by a drain
   *  goes back to `pending`: the tmux attempt that follows settles it, and a crash before that leaves it open, not claimed. */
  returnToPending(outboxId: string): void {
    this.db.prepare(`UPDATE outbox_entries SET delivery_state = 'pending'
      WHERE outbox_id = ? AND delivery_state = 'sending'${this.hasOutcomeLabelColumns ? " AND ack_evidence IS NULL" : ""}`).run(outboxId);
  }

  /** Retention shares the existing outbox ID. Committed wakes preserve each member,
   * even if guard activation happened after staging and quota is now exhausted. */
  retain(input: OutboxRecordInput & { outboxId: string }, binding: NonNullable<OutboxEntry["guardBinding"]>, precommitted = false): OutboxEntry {
    return this.db.transaction(() => {
      const existing = this.getById(input.outboxId);
      if (existing) {
        if (existing.senderSession !== input.senderSession || existing.destinationSession !== input.destinationSession || existing.body !== input.body ||
            (existing.guardBinding && JSON.stringify(existing.guardBinding) !== JSON.stringify(binding))) {
          throw new OutboxHandlerError("delivery_identity_conflict", "The delivery ID already names different content or target identity.");
        }
        if (existing.deliveryState === "retained" || existing.deliveryState === "retired") return existing;
        if (existing.deliveryState !== "pending" && existing.deliveryState !== "sending") {
          throw new OutboxHandlerError("delivery_already_attempted", "This delivery already has a terminal outcome; it cannot be retained or retried.");
        }
      } else if (precommitted) {
        throw new OutboxHandlerError("outbox_not_found", "Precommitted delivery is missing; no replacement custody is created.");
      }
      if (!precommitted) this.assertRetentionCapacity(binding.nodeId, input.body);
      if (!existing) this.record(input);
      // OF-179 F1/F2: a hold is labelled here, where the row moves, so a wake the typing guard retains is labelled even
      // though the drain's later finalize finds the row no longer `sending`. Nothing was typed; the guard is the tmux path's.
      const set = this.labelSet({ path: "tmux", evidence: "retained" });
      this.db.prepare(`UPDATE outbox_entries SET delivery_state='retained', guard_binding=?, delivered_at=NULL${set.sql}
        WHERE outbox_id=? AND delivery_state IN ('pending','sending')`)
        .run(JSON.stringify(binding), ...set.values, input.outboxId);
      return this.getByIdOrThrow(input.outboxId);
    })();
  }

  assertRetentionCapacity(nodeId: string, body: string): void {
    // Provisional bounded defaults. Historical/retired rows and already committed
    // overflow are deliberately not evicted to make these active quotas fit.
    const usage = this.db.prepare(`SELECT count(*) AS count, coalesce(sum(length(CAST(body AS BLOB))),0) AS bytes
      FROM outbox_entries WHERE delivery_state='retained' AND json_valid(guard_binding) AND json_extract(guard_binding,'$.nodeId')=?`)
      .get(nodeId) as { count: number; bytes: number };
    // OF-168: a retained row whose binding is not JSON names no node, so it may be THIS node's: it counts toward every node's quota
    // (reading it as absent admitted new held messages past a quota it may already fill) and a refusal names it.
    const damaged = this.db.prepare(`SELECT outbox_id, length(CAST(body AS BLOB)) AS bytes FROM outbox_entries
      WHERE delivery_state='retained' AND guard_binding IS NOT NULL AND NOT json_valid(guard_binding) ORDER BY ts_dispatched,outbox_id`)
      .all() as Array<{ outbox_id: string; bytes: number }>;
    const count = usage.count + damaged.length;
    const bytes = usage.bytes + damaged.reduce((sum, row) => sum + row.bytes, 0);
    const size = Buffer.byteLength(body, "utf8");
    if (size > 1024 * 1024 || count >= 100 || bytes + size > 8 * 1024 * 1024) {
      // The way out for a row that cannot be read: retire it by id (retire() accepts it; the daemon cannot say which seat it was for).
      const named = damaged.length > 0
        ? ` ${damaged.length} held message${damaged.length === 1 ? "" : "s"} with an unreadable binding (${namedRows(damaged.map((row) => row.outbox_id))}) count${damaged.length === 1 ? "s" : ""} toward every seat's quota until retired or removed: rig seat retire-held-message <any seat> <id> --reason <text>.`
        : "";
      throw new OutboxHandlerError("retained_quota_full", `Held-message quota is full. Retire a specific held message to release active quota; no input was written.${named}`);
    }
  }

  /** OF-168: a retained message whose guard binding is not JSON (it names no seat; it counts toward every seat's quota). */
  isUnreadableHeld(outboxId: string): boolean {
    return this.hasDamagedBinding(outboxId, "retained");
  }

  private hasDamagedBinding(outboxId: string, state: "retained" | "retired"): boolean {
    return this.db.prepare(`SELECT 1 FROM outbox_entries WHERE outbox_id = ? AND delivery_state = ? AND guard_binding IS NOT NULL AND NOT json_valid(guard_binding)`).get(outboxId, state) !== undefined;
  }

  /** OF-179 F2: retiring leaves the outcome label as retain() wrote it (tmux / retained): the label records the delivery
   *  attempt, and the retired_* columns record the operator's act. Nothing is sent, so there is no new path to record. */
  retire(outboxId: string, actor: string, reason: string): OutboxEntry {
    if (!actor.trim() || !reason.trim()) throw new OutboxHandlerError("retirement_reason_required", "Actor and reason are required.");
    // OF-168: a retained row whose binding is not JSON is released by this explicit act by id. It is the only way out of the quota it
    // counts against, and the act needs nothing the binding holds; the reason records that the binding was unreadable.
    if (this.isUnreadableHeld(outboxId)) {
      this.db.prepare(`UPDATE outbox_entries SET delivery_state='retired', retired_at=?, retired_by=?, retirement_reason=?
        WHERE outbox_id=? AND delivery_state='retained'`).run(new Date().toISOString(), actor, `${reason} [guard_binding was not readable JSON when retired]`, outboxId);
      return this.rowToEntry(this.getByIdRaw(outboxId)!, "mark");
    }
    // Retiring it again is the same answer, not a refusal of the row that was just released.
    if (this.hasDamagedBinding(outboxId, "retired")) return this.rowToEntry(this.getByIdRaw(outboxId)!, "mark");
    const entry = this.getByIdOrThrow(outboxId);
    if (entry.deliveryState === "retired") return entry;
    if (entry.deliveryState !== "retained") throw new OutboxHandlerError("delivery_not_retained", "Only retained messages can be retired.");
    this.db.prepare(`UPDATE outbox_entries SET delivery_state='retired', retired_at=?, retired_by=?, retirement_reason=?
      WHERE outbox_id=? AND delivery_state='retained'`).run(new Date().toISOString(), actor, reason, outboxId);
    return this.getByIdOrThrow(outboxId);
  }

  heldForNode(nodeId: string, limit = 100, offset = 0) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isInteger(offset) || offset < 0) {
      throw new OutboxHandlerError("invalid_pagination", "Use limit 1–1000 and a nonnegative offset.");
    }
    // OF-117: json_extract throws "malformed JSON" on a damaged binding, which ended this listing (HTTP 500) for every node's
    // held messages. A damaged binding names no node, so the row is not one of this node's; it is named in `unreadableHeld`
    // (rig-wide) so it is neither hidden nor a 500.
    const total = (this.db.prepare(`SELECT count(*) AS n FROM outbox_entries
      WHERE delivery_state='retained' AND json_valid(guard_binding) AND json_extract(guard_binding,'$.nodeId')=?`).get(nodeId) as { n: number }).n;
    const rows = this.db.prepare(`SELECT * FROM outbox_entries
      WHERE delivery_state='retained' AND json_valid(guard_binding) AND json_extract(guard_binding,'$.nodeId')=? ORDER BY ts_dispatched,outbox_id LIMIT ? OFFSET ?`)
      .all(nodeId, limit, offset) as OutboxEntryRow[];
    const unreadableHeld = (this.db.prepare(`SELECT outbox_id FROM outbox_entries
      WHERE delivery_state='retained' AND guard_binding IS NOT NULL AND NOT json_valid(guard_binding) ORDER BY ts_dispatched,outbox_id`).all() as Array<{ outbox_id: string }>).map((r) => r.outbox_id);
    return { items: rows.map(r => this.rowToEntry(r, "mark")), total, limit, offset, truncated: offset + rows.length < total, unreadableHeld };
  }

  markDelivered(outboxId: string, label?: OutboxOutcomeLabel): OutboxEntry {
    const ts = new Date().toISOString();
    const set = this.labelSet(label);
    const result = this.db
      .prepare(
        `UPDATE outbox_entries
           SET delivery_state = 'delivered', delivered_at = ?${set.sql}${this.closedMessage()}
         WHERE outbox_id = ? AND delivery_state = 'pending'`
      )
      .run(ts, ...set.values, outboxId);
    if (result.changes === 0) {
      const entry = this.getById(outboxId);
      if (!entry) throw new OutboxHandlerError("outbox_not_found", `outbox ${outboxId} not found`);
      return entry;
    }
    return this.getByIdOrThrow(outboxId);
  }

  // ── Native comms step 3 (migration 118): a native row is claimed (`sending`, native / native_written, with its nonce
  // and claim time) BEFORE the socket write, settled by the receiver's ack or by the deadline sweeper, and never moved
  // by the drain's finalize or by startup reconciliation (both act on non-native rows only).

  /** Claims a pending row, or a wake row the drain already moved to `sending`, for a native write. False when the row
   *  is in any other state, already native, or the database lacks migration 118. */
  claimNative(outboxId: string, nonce: string, writtenAt: string, transcriptPath: string | null = null): boolean {
    if (!this.hasNativeColumns()) return false;
    return this.db.prepare(`UPDATE outbox_entries SET delivery_state = 'sending', delivery_path = 'native', ack_evidence = 'native_written',
        ack_detail = NULL, native_nonce = ?, native_written_at = ?, native_transcript_path = ?
      WHERE outbox_id = ? AND delivery_state IN ('pending', 'sending') AND delivery_path IS NOT 'native'`).run(nonce, writtenAt, transcriptPath, outboxId).changes === 1;
  }

  /** Review F2: whether a row is a native write still awaiting its ack (a repeat of its id coalesces onto it). */
  isNativePending(outboxId: string): boolean {
    if (!this.hasNativeColumns()) return false;
    return this.db.prepare(`SELECT 1 FROM outbox_entries WHERE outbox_id = ? AND delivery_state = 'sending' AND delivery_path = 'native'
      AND ack_evidence = 'native_written'`).get(outboxId) !== undefined;
  }

  /** Review F2: the next free per-attempt id for a repeat of a settled id: `<id>.r<n>`. */
  nextAttemptId(outboxId: string): string {
    const n = (this.db.prepare(`SELECT count(*) AS n FROM outbox_entries WHERE outbox_id = ? OR substr(outbox_id, 1, ?) = ?`)
      .get(outboxId, outboxId.length + 2, `${outboxId}.r`) as { n: number }).n;
    return `${outboxId}.r${n}`;
  }

  /** Nothing was written: a row this send created is removed (the tmux path records its own); an adopted row returns
   *  to `sending`, unlabelled, for the caller's tmux path. */
  releaseNativeClaim(outboxId: string, created: boolean): void {
    if (created) {
      this.db.prepare(`DELETE FROM outbox_entries WHERE outbox_id = ? AND delivery_state = 'sending' AND ack_evidence = 'native_written'`).run(outboxId);
      return;
    }
    this.db.prepare(`UPDATE outbox_entries SET delivery_path = NULL, ack_evidence = NULL, ack_detail = NULL, native_nonce = NULL, native_written_at = NULL
      WHERE outbox_id = ? AND delivery_state = 'sending' AND ack_evidence = 'native_written'`).run(outboxId);
  }

  /** The receiver's UserPromptSubmit echoed the row's marker (id, nonce, at the row's destination seat). Outcomes:
   *  - `acked`: the row was awaiting this ack and is now delivered (native_hook_delivered); or it was settled without a
   *    delivery (indeterminate after the hard deadline or a partial write: review F1; failed after a fallback that did not
   *    land), so this late copy IS the delivery; or the same prompt's hook ran again (same prompt id): one delivery;
   *  - `already_delivered`: the row was delivered by an earlier prompt, or failed over with its tmux copy in flight, so
   *    this copy is a duplicate and the hook blocks it (R4 blocks only these);
   *  - `no_match`: nothing here (wrong nonce or seat, unknown row, or a database without migration 118). */
  ackNative(outboxId: string, nonce: string, destinationSession: string, promptId: string | null = null): "acked" | "already_delivered" | "no_match" {
    if (!this.hasNativeColumns()) return "no_match";
    const row = this.db.prepare(`SELECT delivery_state AS state, delivery_path AS path, ack_evidence AS evidence, ack_detail AS detail, native_nonce AS nonce,
        destination_session AS dest, native_ack_prompt_id AS prompt FROM outbox_entries WHERE outbox_id = ?`).get(outboxId) as
      { state: string; path: string | null; evidence: string | null; detail: string | null; nonce: string | null; dest: string; prompt: string | null } | undefined;
    if (!row || row.nonce !== nonce || row.dest !== destinationSession) return "no_match";
    // A row the pump carries is settled by the gate's record alone, so this path neither settles it nor calls a copy of it a duplicate.
    if (this.isPumpOwned(outboxId)) return "no_match";
    const now = new Date().toISOString();
    const settle = (fromState: string, detail: string | null) => this.db.prepare(`UPDATE outbox_entries SET delivery_state = 'delivered', delivered_at = ?,
        delivery_path = 'native', ack_evidence = 'native_hook_delivered', ack_detail = ?, native_ack_prompt_id = ?
      WHERE outbox_id = ? AND delivery_state = ?`).run(now, detail, promptId, outboxId, fromState).changes === 1;
    if (row.state === "sending" && row.path === "native" && row.evidence === "native_written") return settle("sending", null) ? "acked" : "no_match";
    if (row.state === "delivered") return promptId !== null && row.prompt === promptId ? "acked" : "already_delivered";
    if (row.state === "indeterminate" && row.evidence === "native_unconfirmed") {
      return settle("indeterminate", `late, after indeterminate (${row.detail ?? "unconfirmed"})`) ? "acked" : "no_match";
    }
    // ncomms-3b G1: an indeterminate row that is NOT native_unconfirmed is a tmux fallback that pasted without a confirmed
    // render, or timed out: the paste may have landed, so a late native copy is a duplicate.
    if (row.state === "indeterminate") return "already_delivered";
    if (row.state === "failed" && row.evidence === "native_unconfirmed") return "already_delivered"; // its tmux copy is in flight
    if (row.state === "failed" || row.state === "retained") return settle(row.state, "late, after a fallback that did not land") ? "acked" : "no_match";
    return "no_match";
  }

  /** Settles a native row the sweeper or a partial write decided; only a row still awaiting its ack moves. */
  settleNative(outboxId: string, state: "delivered" | "failed" | "indeterminate", label: OutboxOutcomeLabel): boolean {
    if (!this.hasNativeColumns()) return false;
    return this.db.prepare(`UPDATE outbox_entries SET delivery_state = ?, delivered_at = ?, delivery_path = ?, ack_evidence = ?, ack_detail = ?
      WHERE outbox_id = ? AND delivery_state = 'sending' AND ack_evidence = 'native_written'`)
      .run(state, state === "delivered" ? new Date().toISOString() : null, label.path, label.evidence, label.detail ?? null, outboxId).changes === 1;
  }

  /** Records the tmux fallback's own outcome on a native row the sweeper failed over (native / native_unconfirmed). */
  settleFallback(outboxId: string, state: "delivered" | "failed" | "indeterminate" | "retained", label: OutboxOutcomeLabel): boolean {
    if (!this.hasNativeColumns()) return false;
    return this.db.prepare(`UPDATE outbox_entries SET delivery_state = ?, delivered_at = ?, delivery_path = ?, ack_evidence = ?, ack_detail = ?
      WHERE outbox_id = ? AND delivery_state = 'failed' AND ack_evidence = 'native_unconfirmed'`)
      .run(state, state === "delivered" ? new Date().toISOString() : null, label.path, label.evidence, label.detail ?? null, outboxId).changes === 1;
  }

  /** Native rows still awaiting their ack, oldest first. Within one write time the order is staging order (OF-190): a
   *  coalesced wake group is written in that order, so a tmux resend rebuilt from these rows reads the same. The outbox id
   *  is no order ("blocker-10" sorts before "blocker-9"). */
  listNativePending(): OutboxEntry[] {
    if (!this.hasNativeColumns()) return [];
    const rows = this.db.prepare(`SELECT * FROM outbox_entries WHERE delivery_state = 'sending' AND delivery_path = 'native'
      AND ack_evidence = 'native_written' ORDER BY native_written_at, rowid`).all() as OutboxEntryRow[];
    return rows.map((r) => this.rowToEntry(r, "mark"));
  }

  /** OF-190: the entries in the order they were staged (insertion order, the table's rowid), the one order a wake group is
   *  written in and can be rebuilt in. */
  inStagingOrder(entries: OutboxEntry[]): OutboxEntry[] {
    const rank = this.db.prepare("SELECT rowid AS n FROM outbox_entries WHERE outbox_id = ?");
    return entries
      .map((entry) => ({ entry, n: (rank.get(entry.outboxId) as { n: number } | undefined)?.n ?? Number.MAX_SAFE_INTEGER }))
      .sort((a, b) => a.n - b.n)
      .map((x) => x.entry);
  }

  private isPumpOwned(outboxId: string): boolean {
    this.pumpOwnedColumn ??= (this.db.prepare("PRAGMA table_info(outbox_entries)").all() as Array<{ name: string }>).some((c) => c.name === "message_pump_owned");
    return this.pumpOwnedColumn && this.db.prepare("SELECT 1 FROM outbox_entries WHERE outbox_id = ? AND message_pump_owned = 1").get(outboxId) !== undefined;
  }
  private pumpOwnedColumn: boolean | undefined;

  private hasMessageStateColumn(): boolean {
    this.messageStateColumn ??= (this.db.prepare("PRAGMA table_info(outbox_entries)").all() as Array<{ name: string }>).some((c) => c.name === "message_state");
    return this.messageStateColumn;
  }
  private messageStateColumn: boolean | undefined;

  private hasNativeColumns(): boolean {
    if (this.nativeColumns === undefined) {
      this.nativeColumns = (this.db.prepare("PRAGMA table_info(outbox_entries)").all() as Array<{ name: string }>).some((c) => c.name === "native_nonce");
    }
    return this.nativeColumns;
  }
  private nativeColumns: boolean | undefined;

  /** hc cutover: rows left `indeterminate` because the core may still deliver them (`waiting_on_person`) or the reply was
   *  lost (`outcome_unknown`), oldest first. Their `ackDetail` is the pending record. Also the claims a crashed daemon left
   *  on an hc host (`crash_reconciled`, labelled `hc` by reconcileAbandonedSending), which carry no record: the text may
   *  or may not have landed, nothing can verify it, and without them here the crash left no trace in `rig health`.
   *  Empty before migration 117. */
  listHcUnsettled(limit = 200): OutboxEntry[] {
    if (!this.hasOutcomeLabelColumns) return [];
    const rows = this.db.prepare(`SELECT * FROM outbox_entries WHERE delivery_state = 'indeterminate' AND delivery_path = 'hc'
      AND ack_evidence IN (${HC_UNSETTLED_EVIDENCE_SQL}) ORDER BY ts_dispatched, rowid LIMIT ?`).all(limit) as OutboxEntryRow[];
    return rows.map((r) => this.rowToEntry(r, "mark"));
  }

  /** The rows the sweep can settle by reading (`waiting_on_person`, `outcome_unknown`), oldest first, a window of `limit` after `offset`.
   *  Not the rows nothing can settle (`crash_reconciled`, `send_gone`): they would sit at the head of a plain oldest-first list and
   *  starve every newer row. The sweep walks the window along the list pass by pass, so rows that never settle cannot hide a new one. */
  listHcSweepable(limit = 200, offset = 0): OutboxEntry[] {
    if (!this.hasOutcomeLabelColumns) return [];
    const rows = this.db.prepare(`SELECT * FROM outbox_entries WHERE delivery_state = 'indeterminate' AND delivery_path = 'hc'
      AND ack_evidence IN ('waiting_on_person', 'outcome_unknown') ORDER BY ts_dispatched, rowid LIMIT ? OFFSET ?`).all(limit, offset) as OutboxEntryRow[];
    return rows.map((r) => this.rowToEntry(r, "mark"));
  }

  /**
   * The operator's close of an unsettled hc send, for a seat with no token to settle it by (a plain terminal), or any row the
   * evidence cannot settle: the person has looked at the seat (rig capture) and decided. The row leaves the unsettled list as
   * `retired`, with who, when and why recorded in the retired_* columns and its label and pending record kept as evidence.
   * It asserts nothing about delivery and never sends or queues a resend.
   *
   * Refused, with the row untouched: a row that is not an unsettled hc send (already delivered, failed, retired by another
   * verb, or another transport's), a row that names another seat than the one given, and a row not yet past the escalation
   * age (the sweep may still settle it, and the health notice has not named it yet). Closing a row twice is the same answer.
   */
  retireHcUnsettled(outboxId: string, seat: string, actor: string, reason: string, nowMs: number = Date.now()): OutboxEntry {
    if (!actor.trim() || !reason.trim()) throw new OutboxHandlerError("retirement_reason_required", "Actor and reason are required.");
    const raw = this.hasOutcomeLabelColumns ? this.getByIdRaw(outboxId) : undefined;
    if (!raw) throw new OutboxHandlerError("outbox_not_found", `outbox ${outboxId} not found`);
    if (raw.destination_session !== seat) throw new OutboxHandlerError("wrong_seat", `outbox ${outboxId} is for ${raw.destination_session}, not ${seat}`);
    const unsettledLabel = raw.delivery_path === "hc" && (HC_UNSETTLED_EVIDENCE as readonly string[]).includes(raw.ack_evidence ?? "");
    if (raw.delivery_state === "retired" && unsettledLabel) return this.rowToEntry(raw, "mark");
    if (raw.delivery_state !== "indeterminate" || !unsettledLabel) {
      throw new OutboxHandlerError("not_unsettled", `outbox ${outboxId} is ${raw.delivery_state}${raw.ack_evidence ? ` (${raw.ack_evidence})` : ""}, not an unsettled send to an hc seat; nothing was changed.`);
    }
    const sinceMs = parseSqliteUtcMs(raw.ts_dispatched);
    if (!Number.isFinite(sinceMs) || nowMs - sinceMs <= HC_UNSETTLED_ESCALATE_AFTER_MS) {
      throw new OutboxHandlerError("not_escalated", `outbox ${outboxId} has not waited past ${Math.floor(HC_UNSETTLED_ESCALATE_AFTER_MS / 60_000)} min; the sweep may still settle it. Nothing was changed.`);
    }
    const changed = this.db.prepare(`UPDATE outbox_entries SET delivery_state = 'retired', retired_at = ?, retired_by = ?, retirement_reason = ?
      WHERE outbox_id = ? AND delivery_state = 'indeterminate' AND delivery_path = 'hc' AND ack_evidence IN (${HC_UNSETTLED_EVIDENCE_SQL})`)
      .run(new Date(nowMs).toISOString(), actor, reason, outboxId).changes;
    if (changed !== 1) throw new OutboxHandlerError("not_unsettled", `outbox ${outboxId} was settled while this ran; nothing was changed.`);
    return this.getByIdOrThrow(outboxId);
  }

  /** Settles one of those rows once the evidence is in: delivered, or failed because the send is proved gone (the only
   *  state a retry may follow). Only a row still waiting moves; a second settle finds nothing. */
  settleHcUnsettled(outboxId: string, state: "delivered" | "failed", label: OutboxOutcomeLabel): boolean {
    if (!this.hasOutcomeLabelColumns) return false;
    return this.db.prepare(`UPDATE outbox_entries SET delivery_state = ?, delivered_at = ?, delivery_path = ?, ack_evidence = ?, ack_detail = ?
      WHERE outbox_id = ? AND delivery_state = 'indeterminate' AND delivery_path = 'hc' AND ack_evidence IN ('waiting_on_person', 'outcome_unknown')`)
      .run(state, state === "delivered" ? new Date().toISOString() : null, label.path, label.evidence, label.detail ?? null, outboxId).changes === 1;
  }

  /** The sweep proved a waiting row's send lost. Only a row still waiting moves; it stays `indeterminate` (see `send_gone`). */
  markHcSendGone(outboxId: string): boolean {
    if (!this.hasOutcomeLabelColumns) return false;
    return this.db.prepare(`UPDATE outbox_entries SET ack_evidence = 'send_gone'
      WHERE outbox_id = ? AND delivery_state = 'indeterminate' AND delivery_path = 'hc' AND ack_evidence IN ('waiting_on_person', 'outcome_unknown')`)
      .run(outboxId).changes === 1;
  }

  /** Labels a row another writer has just settled (the queue's superseded wake). No-op before migration 117. */
  labelOutcome(outboxId: string, label: OutboxOutcomeLabel): void {
    const set = this.labelSet(label);
    if (!set.sql) return;
    this.db.prepare(`UPDATE outbox_entries SET ${set.sql.slice(2)} WHERE outbox_id = ?`).run(...set.values, outboxId);
  }

  markFailed(outboxId: string, label?: OutboxOutcomeLabel): OutboxEntry {
    const set = this.labelSet(label);
    const result = this.db
      .prepare(
        `UPDATE outbox_entries
           SET delivery_state = 'failed'${set.sql}${this.closedMessage()}
         WHERE outbox_id = ? AND delivery_state = 'pending'`
      )
      .run(...set.values, outboxId);
    if (result.changes === 0) {
      const entry = this.getById(outboxId);
      if (!entry) throw new OutboxHandlerError("outbox_not_found", `outbox ${outboxId} not found`);
      return entry;
    }
    return this.getByIdOrThrow(outboxId);
  }

  /**
   * W1 (transactional closure): record an AMBIGUOUS delivery outcome — the send
   * landed but its render could not be confirmed (transport res.ok && !verified).
   * Same compare-and-set shape as markFailed/markDelivered (guards on 'pending'),
   * so it is idempotent and NEVER clobbers a row that already resolved. An
   * indeterminate row is terminal-by-CAS: it is never silently promoted to
   * delivered nor demoted to failed by the drain.
   */
  markIndeterminate(outboxId: string, label?: OutboxOutcomeLabel): OutboxEntry {
    const set = this.labelSet(label);
    const result = this.db
      .prepare(
        `UPDATE outbox_entries
           SET delivery_state = 'indeterminate'${set.sql}${this.closedMessage()}
         WHERE outbox_id = ? AND delivery_state = 'pending'`
      )
      .run(...set.values, outboxId);
    if (result.changes === 0) {
      const entry = this.getById(outboxId);
      if (!entry) throw new OutboxHandlerError("outbox_not_found", `outbox ${outboxId} not found`);
      return entry;
    }
    return this.getByIdOrThrow(outboxId);
  }

  /**
   * MF3: atomically CLAIM a pending wake intent for delivery (pending→sending)
   * BEFORE the external send. Returns true iff this caller won the claim. An
   * overlapping drainer's claim finds the row no longer `pending` and returns
   * false, so exactly one caller performs the external send.
   */
  claimForDelivery(outboxId: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE outbox_entries SET delivery_state = 'sending'
          WHERE outbox_id = ? AND delivery_state = 'pending'`
      )
      .run(outboxId);
    return result.changes === 1;
  }

  /**
   * MF3: finalize a CLAIMED wake intent (sending→delivered|indeterminate|failed)
   * after its external send resolved. CAS-guarded on `sending` so it only ever
   * finalizes a row this drainer claimed. `delivered_at` is stamped only for a
   * confirmed delivery.
   */
  finalizeDelivery(outboxId: string, state: "delivered" | "indeterminate" | "failed" | "retained", label?: OutboxOutcomeLabel): OutboxEntry {
    const deliveredAt = state === "delivered" ? new Date().toISOString() : null;
    const set = this.labelSet(label);
    const result = this.db
      .prepare(
        `UPDATE outbox_entries SET delivery_state = ?, delivered_at = ?${set.sql}
          WHERE outbox_id = ? AND delivery_state = 'sending'${this.hasOutcomeLabelColumns ? " AND ack_evidence IS NOT 'native_written'" : ""}`
      )
      .run(state, deliveredAt, ...set.values, outboxId);
    if (result.changes === 0) {
      const entry = this.getById(outboxId);
      if (!entry) throw new OutboxHandlerError("outbox_not_found", `outbox ${outboxId} not found`);
      return entry;
    }
    return this.getByIdOrThrow(outboxId);
  }

  getById(outboxId: string): OutboxEntry | null {
    const row = this.getByIdRaw(outboxId);
    return row ? this.rowToEntry(row) : null;
  }

  listForSender(senderSession: string, limit = 100): OutboxEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM outbox_entries WHERE sender_session = ? ORDER BY ts_dispatched DESC, rowid DESC LIMIT ?`
      )
      .all(senderSession, limit) as OutboxEntryRow[];
    return rows.map((r) => this.rowToEntry(r, "mark"));
  }

  /**
   * W1 (transactional closure): list still-`pending` rows whose outbox_id begins
   * with `idPrefix`, oldest first. The drain uses this to recover intents a crash
   * left committed-but-undelivered. `idPrefix` is a trusted compile-time constant
   * (e.g. "wake-intent-") with no LIKE wildcards. Oldest-first + bounded `limit`
   * so a caller can page and terminate on a served short batch (never a silent cap).
   * `offset` (OF-136): a caller that leaves some pending rows in place on purpose (the drain skips damaged intents) pages past
   * them, so they cannot fill the head of every batch and starve the intents behind them.
   */
  listPending(idPrefix: string, limit = 200, offset = 0): OutboxEntry[] {
    // EXACT-CASE prefix match. SQLite `LIKE` is case-insensitive by default, so a
    // `LIKE 'wake-intent-%'` selector would also execute `WAKE-INTENT-…` variants.
    // `substr(...) = ?` uses the binary collation (case-sensitive), so exactly one
    // spelling is executable. With the route-side prefix refusal unbuilt, this
    // narrowness is the ONLY thing keeping a recorded case variant out of the
    // executable drain — widen it and variants become executable.
    const rows = this.db
      .prepare(
        `SELECT * FROM outbox_entries
          WHERE delivery_state = 'pending' AND substr(outbox_id, 1, ?) = ?${this.hasMessageStateColumn() ? " AND message_state IS NULL" : ""}
          ORDER BY ts_dispatched ASC, rowid ASC LIMIT ? OFFSET ?`
      )
      .all(idPrefix.length, idPrefix, limit, offset) as OutboxEntryRow[];
    // Seat Messaging: a row the pump owns (message_state set) has one driver; the drain never takes it too.
    // OF-117: marked, not refused: one damaged intent must not end the drain for the intents behind it (the drain skips it).
    return rows.map((r) => this.rowToEntry(r, "mark"));
  }

  /**
   * BLOCKING 1 (guard re-seal): at a process/recovery boundary, atomically
   * reconcile ABANDONED claims — rows a crashed process left in the transient
   * `sending` state — to `indeterminate` WITHOUT re-sending. A `sending` row is
   * ambiguous (the external send may or may not have landed after the claim), so
   * it records `indeterminate`, never a forever-transient claim and never a blind
   * re-send. EXACT-CASE prefix, matching the executable selector. Returns the
   * count reconciled.
   */
  reconcileAbandonedSending(idPrefix: string, path: "tmux" | "hc" = "tmux"): number {
    // The claim is labelled with the path the daemon's seats are on, so a crash on an hc host leaves a row the unsettled list
    // (and so `rig health`) sees. The label is a claim about the host, not about this row: every seat on an hc daemon is on hc.
    const set = this.labelSet({ path, evidence: "crash_reconciled" });
    const result = this.db
      .prepare(
        `UPDATE outbox_entries SET delivery_state = 'indeterminate'${set.sql}
          WHERE delivery_state = 'sending' AND substr(outbox_id, 1, ?) = ?${this.hasOutcomeLabelColumns ? " AND delivery_path IS NOT 'native'" : ""}`
      )
      .run(...set.values, idPrefix.length, idPrefix);
    return result.changes;
  }

  private getByIdRaw(outboxId: string): OutboxEntryRow | undefined {
    return this.db
      .prepare("SELECT * FROM outbox_entries WHERE outbox_id = ?")
      .get(outboxId) as OutboxEntryRow | undefined;
  }

  private getByIdOrThrow(outboxId: string): OutboxEntry {
    const entry = this.getById(outboxId);
    if (!entry) throw new OutboxHandlerError("outbox_not_found", `outbox ${outboxId} not found after write`);
    return entry;
  }

  /** OF-117: "refuse" (default; every read a delivery or guard decision rests on) throws UnreadableRowError for a damaged
   *  tags / guard_binding column; "mark" (listings) serves the entry with the column null and `unreadable` naming it. */
  private rowToEntry(row: OutboxEntryRow, damage: "refuse" | "mark" = "refuse"): OutboxEntry {
    const columns = new RowColumnReader("outbox_entries", row.outbox_id);
    const tags = columns.strings("tags", row.tags);
    const guardBinding = row.guard_binding !== undefined ? columns.json<NonNullable<OutboxEntry["guardBinding"]>>("guard_binding", row.guard_binding) : null;
    if (damage === "refuse") columns.refuseIfDamaged();
    // OF-179 F5: an outcome label is a record, not something a decision rests on, so a value outside the vocabulary (a
    // newer daemon's, or damage) reads as null and is flagged in `unreadable`, but never refuses the row.
    const labels = new RowColumnReader("outbox_entries", row.outbox_id);
    const deliveryPath = labels.oneOf("delivery_path", OUTBOX_DELIVERY_PATHS, row.delivery_path);
    const ackEvidence = labels.oneOf("ack_evidence", OUTBOX_ACK_EVIDENCE, row.ack_evidence);
    const message = row.attempts !== undefined ? {
      messageId: row.message_id ?? row.outbox_id,
      messageClass: labels.oneOf("class", SEAT_MESSAGE_CLASSES, row.class),
      lane: row.lane === 0 || row.lane === 1 || row.lane === 2 ? (row.lane as SeatMessageLane) : null,
      attempts: row.attempts,
      occupantGeneration: row.occupant_generation ?? null,
      messageState: labels.oneOf("message_state", SEAT_MESSAGE_STATES, row.message_state),
    } : {};
    const unreadable = [...columns.unreadable, ...labels.unreadable];
    return {
      outboxId: row.outbox_id,
      senderSession: row.sender_session,
      destinationSession: row.destination_session,
      body: row.body,
      tags,
      urgency: row.urgency,
      tsDispatched: row.ts_dispatched,
      deliveryState: parseDeliveryState(row.delivery_state),
      deliveredAt: row.delivered_at,
      auditPointer: row.audit_pointer,
      ...(row.guard_binding !== undefined ? {
        guardBinding,
        retiredAt: row.retired_at ?? null,
        retiredBy: row.retired_by ?? null,
        retirementReason: row.retirement_reason ?? null,
      } : {}),
      ...(row.ack_evidence !== undefined ? { deliveryPath, ackEvidence, ackDetail: row.ack_detail ?? null } : {}),
      ...message,
      ...(row.native_nonce !== undefined ? { nativeNonce: row.native_nonce ?? null, nativeWrittenAt: row.native_written_at ?? null, nativeTranscriptPath: row.native_transcript_path ?? null } : {}),
      ...(unreadable.length > 0 ? { unreadable } : {}),
    };
  }
}
