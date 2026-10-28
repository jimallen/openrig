// PL-005 Phase B: read-only audit-history browse over mission_control_actions.
//
// Filters: qitem_id (exact), action_verb (exact), actor_session (exact),
// since/until (acted_at range). Pagination via before_id + limit.
// Returns {rows, has_more, next_before_id} shape so the UI can paginate.
//
// Read-only: no writers, no UPDATE/DELETE methods. Phase A's
// MissionControlActionLog is the only writer; this layer only queries.

import type Database from "better-sqlite3";
import {
  type MissionControlActionEntry,
  type MissionControlVerb,
  MISSION_CONTROL_VERBS,
} from "./mission-control-action-log.js";
import { readStoredJsonObject } from "../stored-json.js";
import { NAMED_ROWS_LIMIT } from "../named-rows.js";

export interface AuditQueryInput {
  qitemId?: string;
  actionVerb?: string;
  actorSession?: string;
  /** ISO timestamp; rows with acted_at >= since are included. */
  since?: string;
  /** ISO timestamp; rows with acted_at <= until are included. */
  until?: string;
  /** Default 50; capped at 200. */
  limit?: number;
  /** Pagination cursor: returns rows whose action_id < beforeId. */
  beforeId?: string;
  /** OPR.0.4.4.19 FR-9 — the scope-approval target filters (the pinned
   *  audit_notes_json shape's read path). These make Packet 2's one-query
   *  UNVERIFIED-stamp cross-check real: filter by the stable scope target
   *  (tier + dot-ID + canonical path) and/or approval scope. */
  scopeTier?: string;
  scopeId?: string;
  scopePath?: string;
  approvalScope?: string;
}

export interface AuditQueryResult {
  rows: MissionControlActionEntry[];
  hasMore: boolean;
  nextBeforeId: string | null;
  /** OF-168: present only when a scope filter was given AND rows matching every OTHER filter have an `audit_notes_json` that is not
   *  JSON. Such a row cannot say what scope it carries, so a scope filter cannot match it; it is named here (action ids, newest
   *  first, at most NAMED_ROWS_LIMIT) instead of the filtered browse reading as if it did not exist. Which rows match is unchanged. */
  unreadableAuditNotes?: string[];
  /** How many MORE such rows exist beyond the ones named; present only when the list was cut at NAMED_ROWS_LIMIT. */
  unreadableAuditNotesMore?: number;
}

interface ActionRow {
  action_id: string;
  action_verb: string;
  qitem_id: string | null;
  actor_session: string;
  acted_at: string;
  before_state_json: string | null;
  after_state_json: string | null;
  reason: string | null;
  annotation: string | null;
  notify_attempted: number;
  notify_result: string | null;
  audit_notes_json: string | null;
  identity_provenance?: string | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;


export class MissionControlAuditQueryError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "MissionControlAuditQueryError";
  }
}

export class MissionControlAuditBrowse {
  constructor(private readonly db: Database.Database) {}

  query(input: AuditQueryInput): AuditQueryResult {
    if (input.actionVerb && !MISSION_CONTROL_VERBS.includes(input.actionVerb as MissionControlVerb)) {
      throw new MissionControlAuditQueryError(
        "verb_unknown",
        `unknown action_verb '${input.actionVerb}'; supported: ${MISSION_CONTROL_VERBS.join(", ")}`,
        { actionVerb: input.actionVerb, supported: [...MISSION_CONTROL_VERBS] },
      );
    }
    const limit = clampLimit(input.limit);
    const where: string[] = [];
    const params: Array<string | number> = [];
    // The conditions that are NOT scope filters, in order, for the damaged-notes naming below (same text, same parameters).
    const plain: Array<{ sql: string; param?: string | number }> = [];
    const addPlain = (sql: string, param?: string | number): void => {
      where.push(sql);
      if (param !== undefined) params.push(param);
      plain.push(param === undefined ? { sql } : { sql, param });
    };
    if (input.qitemId) {
      addPlain("qitem_id = ?", input.qitemId);
    }
    if (input.actionVerb) {
      addPlain("action_verb = ?", input.actionVerb);
    }
    if (input.actorSession) {
      addPlain("actor_session = ?", input.actorSession);
    }
    // OPR.0.4.4.19 FR-9 — filter on the pinned audit_notes_json shape via
    // SQLite JSON1 (ships with better-sqlite3). NULL audit_notes_json rows
    // simply don't match. OF-117: neither do damaged ones (json_extract throws "malformed JSON" for the whole listing).
    if (input.scopeTier) {
      where.push("json_valid(audit_notes_json) AND json_extract(audit_notes_json, '$.scope_tier') = ?");
      params.push(input.scopeTier);
    }
    if (input.scopeId) {
      where.push("json_valid(audit_notes_json) AND json_extract(audit_notes_json, '$.scope_id') = ?");
      params.push(input.scopeId);
    }
    if (input.scopePath) {
      where.push("json_valid(audit_notes_json) AND json_extract(audit_notes_json, '$.scope_path') = ?");
      params.push(input.scopePath);
    }
    if (input.approvalScope) {
      where.push("json_valid(audit_notes_json) AND json_extract(audit_notes_json, '$.approval_scope') = ?");
      params.push(input.approvalScope);
    }
    if (input.since) {
      addPlain("acted_at >= ?", input.since);
    }
    if (input.until) {
      addPlain("acted_at <= ?", input.until);
    }
    if (input.beforeId) {
      // Look up the cursor row's rowid so pagination uses SQLite's
      // monotonic insertion order (deterministic) rather than ULID
      // action_id (whose same-ms tail is random; non-deterministic
      // for tiebreaks). Filed lesson:
      // feedback_ulid_tiebreaker_nondeterministic.md.
      addPlain("rowid < (SELECT rowid FROM mission_control_actions WHERE action_id = ?)", input.beforeId);
    }
    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    // Fetch limit+1 to detect hasMore without a separate count query.
    // ORDER BY acted_at DESC primary; rowid DESC tiebreak (deterministic
    // insertion order; safer than ULID action_id for same-ms ties).
    const sql = `SELECT * FROM mission_control_actions ${whereClause}
       ORDER BY acted_at DESC, rowid DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...params, limit + 1) as ActionRow[];
    const hasMore = rows.length > limit;
    const trimmed = hasMore ? rows.slice(0, limit) : rows;
    const nextBeforeId = hasMore && trimmed.length > 0 ? trimmed[trimmed.length - 1]!.action_id : null;
    const scoped = Boolean(input.scopeTier || input.scopeId || input.scopePath || input.approvalScope);
    let unreadableAuditNotes: string[] = [];
    let unreadableAuditNotesMore = 0;
    if (scoped) {
      const damagedWhere = `audit_notes_json IS NOT NULL AND NOT json_valid(audit_notes_json)${plain.map((c) => ` AND ${c.sql}`).join("")}`;
      const plainParams = plain.flatMap((c) => (c.param === undefined ? [] : [c.param]));
      unreadableAuditNotes = (this.db.prepare(`SELECT action_id FROM mission_control_actions WHERE ${damagedWhere} ORDER BY acted_at DESC, rowid DESC LIMIT ?`)
        .all(...plainParams, NAMED_ROWS_LIMIT) as Array<{ action_id: string }>).map((r) => r.action_id);
      if (unreadableAuditNotes.length === NAMED_ROWS_LIMIT) {
        const total = (this.db.prepare(`SELECT count(*) AS n FROM mission_control_actions WHERE ${damagedWhere}`).get(...plainParams) as { n: number }).n;
        unreadableAuditNotesMore = total - NAMED_ROWS_LIMIT;
      }
    }
    return {
      rows: trimmed.map(rowToEntry),
      hasMore,
      nextBeforeId,
      ...(unreadableAuditNotes.length > 0 ? { unreadableAuditNotes } : {}),
      ...(unreadableAuditNotesMore > 0 ? { unreadableAuditNotesMore } : {}),
    };
  }
}

function clampLimit(input: number | undefined): number {
  if (input === undefined || !Number.isFinite(input)) return DEFAULT_LIMIT;
  if (input < 1) return 1;
  if (input > MAX_LIMIT) return MAX_LIMIT;
  return Math.floor(input);
}

function rowToEntry(row: ActionRow): MissionControlActionEntry {
  return {
    actionId: row.action_id,
    actionVerb: row.action_verb as MissionControlVerb,
    qitemId: row.qitem_id,
    actorSession: row.actor_session,
    actedAt: row.acted_at,
    // OF-51: a damaged state column reads as no recorded state, never a 500 for the whole audit listing.
    beforeState: readStoredJsonObject(row.before_state_json),
    afterState: readStoredJsonObject(row.after_state_json),
    reason: row.reason,
    annotation: row.annotation,
    notifyAttempted: row.notify_attempted !== 0,
    notifyResult: row.notify_result,
    auditNotes: readStoredJsonObject(row.audit_notes_json),
    identityProvenance: row.identity_provenance ?? null,
  };
}
