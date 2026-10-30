import type Database from "better-sqlite3";
import { RowColumnReader } from "./unreadable-row.js";
import { namedRows } from "./named-rows.js";

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

/**
 * Outbox id prefixes the daemon itself writes (wake intents; guard-claim-, guard-nudge-,
 * guard-watchdog-, guard-send-, guard-model- deliveries). `POST /outbox/record` refuses a caller
 * outboxId under any of them: otherwise a caller could pre-record a predictable daemon id and get
 * the later daemon row returned unchanged, carrying the manual-record origin marker that hides it
 * from RSI D8 (OF-77, u16 review N1).
 */
export const DAEMON_OUTBOX_ID_PREFIXES = [WAKE_INTENT_PREFIX, "guard-"] as const;

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
 *  yet; `none` means nothing was sent (see migration 117). */
export const OUTBOX_DELIVERY_PATHS = ["tmux", "native", "gateway", "none"] as const;
export type OutboxDeliveryPath = (typeof OUTBOX_DELIVERY_PATHS)[number];

/** What a settled row's outcome rests on. The tmux values mirror SendResult's outcome vocabulary and the wake drain's
 *  classification; `crash_reconciled` is a `sending` claim a restarted daemon found (it may or may not have landed). */
export const OUTBOX_ACK_EVIDENCE = [
  "render_verified", "render_unconfirmed", "send_ok", "send_timeout", "send_failed", "retained",
  "gateway_owned", "local_inbox", "unroutable", "no_qitem", "superseded", "crash_reconciled",
  // Native comms step 3: written to the seat's inbox socket, awaiting its UserPromptSubmit ack; acked by that hook;
  // found in the seat's transcript after the ack was lost; not taken (or not confirmable) by the deadline.
  "native_written", "native_hook_delivered", "native_transcript", "native_unconfirmed",
] as const;
export type OutboxAckEvidence = (typeof OUTBOX_ACK_EVIDENCE)[number];

/** How a row was settled. `detail` is the transport's own reason code, when it gave one. */
export interface OutboxOutcomeLabel {
  path: OutboxDeliveryPath;
  evidence: OutboxAckEvidence;
  detail?: string | null;
}

/** The label for a tmux send's result, from SendResult's own vocabulary (structural, so this module does not import the
 *  transport). An ok send that reports neither `outcome` nor `verified` is `send_ok`: it landed, with no render claim. */
export function labelForTmuxSend(res: { ok: boolean; verified?: boolean; outcome?: string; reason?: string }): OutboxOutcomeLabel {
  if (res.outcome === "retained") return { path: "tmux", evidence: "retained", detail: res.reason ?? null };
  if (!res.ok || res.outcome === "failed") return { path: "tmux", evidence: "send_failed", detail: res.reason ?? null };
  if (res.outcome === "delivered" || res.verified === true) return { path: "tmux", evidence: "render_verified" };
  if (res.outcome === "rendered-unconfirmed" || res.verified === false) return { path: "tmux", evidence: "render_unconfirmed" };
  return { path: "tmux", evidence: "send_ok" };
}

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

  constructor(db: Database.Database) {
    this.db = db;
    this.hasIdentityProvenanceColumn = (
      this.db.prepare("PRAGMA table_info(outbox_entries)").all() as Array<{ name: string }>
    ).some((col) => col.name === "identity_provenance");
    this.hasOutcomeLabelColumns = (
      this.db.prepare("PRAGMA table_info(outbox_entries)").all() as Array<{ name: string }>
    ).some((col) => col.name === "ack_evidence");
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

    return this.getByIdOrThrow(id);
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
           SET delivery_state = 'delivered', delivered_at = ?${set.sql}
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
  claimNative(outboxId: string, nonce: string, writtenAt: string): boolean {
    if (!this.hasNativeColumns()) return false;
    return this.db.prepare(`UPDATE outbox_entries SET delivery_state = 'sending', delivery_path = 'native', ack_evidence = 'native_written',
        ack_detail = NULL, native_nonce = ?, native_written_at = ?
      WHERE outbox_id = ? AND delivery_state IN ('pending', 'sending') AND delivery_path IS NOT 'native'`).run(nonce, writtenAt, outboxId).changes === 1;
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

  /** The receiver's UserPromptSubmit echoed the row's marker. Acks only a native row still awaiting it, whose nonce
   *  matches and whose destination is the hooking seat. `already_delivered`: the row was settled delivered (or
   *  indeterminate) by another path, so this copy is a late duplicate. */
  ackNative(outboxId: string, nonce: string, destinationSession: string): "acked" | "already_delivered" | "no_match" {
    if (!this.hasNativeColumns()) return "no_match";
    const row = this.db.prepare(`SELECT delivery_state AS state, delivery_path AS path, ack_evidence AS evidence, native_nonce AS nonce,
        destination_session AS dest FROM outbox_entries WHERE outbox_id = ?`).get(outboxId) as
      { state: string; path: string | null; evidence: string | null; nonce: string | null; dest: string } | undefined;
    if (!row || row.nonce !== nonce || row.dest !== destinationSession) return "no_match";
    if (row.state === "sending" && row.path === "native" && row.evidence === "native_written") {
      const changed = this.db.prepare(`UPDATE outbox_entries SET delivery_state = 'delivered', delivered_at = ?, ack_evidence = 'native_hook_delivered', ack_detail = NULL
        WHERE outbox_id = ? AND delivery_state = 'sending' AND ack_evidence = 'native_written'`).run(new Date().toISOString(), outboxId).changes;
      return changed === 1 ? "acked" : "no_match";
    }
    // A row the deadline sweeper failed over: its tmux copy did not land, so this late native copy IS the delivery.
    if (row.state === "failed" && row.evidence !== "native_unconfirmed") {
      this.db.prepare(`UPDATE outbox_entries SET delivery_state = 'delivered', delivered_at = ?, delivery_path = 'native', ack_evidence = 'native_hook_delivered',
          ack_detail = 'late, after a failed fallback' WHERE outbox_id = ? AND delivery_state = 'failed'`).run(new Date().toISOString(), outboxId);
      return "acked";
    }
    // Settled by another path, or failed over and its tmux copy in flight: this copy is a late duplicate. (Blocking it
    // while the fallback is in flight trades a duplicate for a visible `failed` row should that tmux copy not land.)
    if (row.state === "delivered" || row.state === "indeterminate" || (row.state === "failed" && row.evidence === "native_unconfirmed")) return "already_delivered";
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

  /** Native rows still awaiting their ack, oldest first. */
  listNativePending(): OutboxEntry[] {
    if (!this.hasNativeColumns()) return [];
    const rows = this.db.prepare(`SELECT * FROM outbox_entries WHERE delivery_state = 'sending' AND delivery_path = 'native'
      AND ack_evidence = 'native_written' ORDER BY native_written_at, outbox_id`).all() as OutboxEntryRow[];
    return rows.map((r) => this.rowToEntry(r, "mark"));
  }

  private hasNativeColumns(): boolean {
    if (this.nativeColumns === undefined) {
      this.nativeColumns = (this.db.prepare("PRAGMA table_info(outbox_entries)").all() as Array<{ name: string }>).some((c) => c.name === "native_nonce");
    }
    return this.nativeColumns;
  }
  private nativeColumns: boolean | undefined;

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
           SET delivery_state = 'failed'${set.sql}
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
           SET delivery_state = 'indeterminate'${set.sql}
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
          WHERE delivery_state = 'pending' AND substr(outbox_id, 1, ?) = ?
          ORDER BY ts_dispatched ASC, rowid ASC LIMIT ? OFFSET ?`
      )
      .all(idPrefix.length, idPrefix, limit, offset) as OutboxEntryRow[];
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
  reconcileAbandonedSending(idPrefix: string): number {
    // Every claimed wake intent is sent through tmux today, so an abandoned claim is labelled with that path.
    const set = this.labelSet({ path: "tmux", evidence: "crash_reconciled" });
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
      ...(row.native_nonce !== undefined ? { nativeNonce: row.native_nonce ?? null, nativeWrittenAt: row.native_written_at ?? null } : {}),
      ...(unreadable.length > 0 ? { unreadable } : {}),
    };
  }
}
