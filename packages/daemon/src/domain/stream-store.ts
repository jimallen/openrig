import type Database from "better-sqlite3";
import { monotonicFactory } from "ulid";
import type { EventBus } from "./event-bus.js";
import { readStoredJsonStrings } from "./stored-json.js";
import { namedRows, nameRowsThrottled } from "./named-rows.js";

const ulid = monotonicFactory();

export interface StreamItem {
  streamItemId: string;
  tsEmitted: string;
  streamSortKey: string;
  sourceSession: string;
  body: string;
  format: string;
  hintType: string | null;
  hintUrgency: string | null;
  hintDestination: string | null;
  hintTags: string[] | null;
  interrupt: boolean;
  archivedAt: string | null;
}

export interface StreamEmitInput {
  streamItemId?: string;
  sourceSession: string;
  body: string;
  format?: string;
  hintType?: string | null;
  hintUrgency?: string | null;
  hintDestination?: string | null;
  hintTags?: string[] | null;
  interrupt?: boolean;
  /** P21 §4 era-stamp: the route passes `transport:v1` (sourceSession derived from the transport
   *  header chokepoint). Written onto the stream row; absence = claimed-era. */
  identityProvenance?: string | null;
}

export interface StreamListOptions {
  limit?: number;
  afterSortKey?: string;
  sourceSession?: string;
  hintDestination?: string;
  hintTag?: string;
  since?: string;
  until?: string;
  includeArchived?: boolean;
  direction?: "chronological" | "latest";
}

interface StreamItemRow {
  stream_item_id: string;
  ts_emitted: string;
  stream_sort_key: string;
  source_session: string;
  body: string;
  format: string;
  hint_type: string | null;
  hint_urgency: string | null;
  hint_destination: string | null;
  hint_tags: string | null;
  interrupt: number;
  archived_at: string | null;
}

/**
 * L1 — Stream store. Append-only intake/audit root.
 * Items are immutable after emit (only `archived_at` may be set).
 */
export class StreamStore {
  readonly db: Database.Database;
  private readonly eventBus: EventBus;
  /** P21 §4: detected once — a curated-migration test DB (or a pre-067 daemon) may lack the
   *  era-stamp column, so the writer degrades (omits it) instead of throwing. */
  private readonly hasIdentityProvenanceColumn: boolean;

  constructor(db: Database.Database, eventBus: EventBus) {
    this.db = db;
    this.eventBus = eventBus;
    this.hasIdentityProvenanceColumn = (
      this.db.prepare("PRAGMA table_info(stream_items)").all() as Array<{ name: string }>
    ).some((col) => col.name === "identity_provenance");
  }

  /**
   * Idempotent emit: same `streamItemId` returns the existing row.
   */
  emit(input: StreamEmitInput): StreamItem {
    const tsEmitted = new Date().toISOString();
    const id = input.streamItemId ?? ulid();

    const existing = this.getByIdRaw(id);
    if (existing) return this.rowToItem(existing);

    const sortKey = ulid();
    const interrupt = input.interrupt ? 1 : 0;
    const tagsJson = input.hintTags ? JSON.stringify(input.hintTags) : null;

    const persistTxn = this.db.transaction(() => {
      if (this.hasIdentityProvenanceColumn) {
        this.db
          .prepare(
            `INSERT INTO stream_items (
              stream_item_id, ts_emitted, stream_sort_key, source_session, body,
              format, hint_type, hint_urgency, hint_destination, hint_tags, interrupt, identity_provenance
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            id,
            tsEmitted,
            sortKey,
            input.sourceSession,
            input.body,
            input.format ?? "text",
            input.hintType ?? null,
            input.hintUrgency ?? null,
            input.hintDestination ?? null,
            tagsJson,
            interrupt,
            input.identityProvenance ?? null
          );
      } else {
        this.db
          .prepare(
            `INSERT INTO stream_items (
              stream_item_id, ts_emitted, stream_sort_key, source_session, body,
              format, hint_type, hint_urgency, hint_destination, hint_tags, interrupt
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            id,
            tsEmitted,
            sortKey,
            input.sourceSession,
            input.body,
            input.format ?? "text",
            input.hintType ?? null,
            input.hintUrgency ?? null,
            input.hintDestination ?? null,
            tagsJson,
            interrupt
          );
      }

      return this.eventBus.persistWithinTransaction({
        type: "stream.emitted",
        streamItemId: id,
        sourceSession: input.sourceSession,
        hintDestination: input.hintDestination ?? null,
        hintType: input.hintType ?? null,
        hintUrgency: input.hintUrgency ?? null,
        interrupt: Boolean(input.interrupt),
      });
    });

    const persistedEvent = persistTxn();
    this.eventBus.notifySubscribers(persistedEvent);

    return this.rowToItem(this.getByIdRaw(id)!);
  }

  getById(streamItemId: string): StreamItem | null {
    const row = this.getByIdRaw(streamItemId);
    return row ? this.rowToItem(row) : null;
  }

  list(opts?: StreamListOptions): StreamItem[] {
    const limit = opts?.limit ?? 100;
    const conditions: string[] = [];
    const params: unknown[] = [];
    // The conditions that are not the hint-tag filter, for naming the rows that filter cannot read (OF-168).
    const plainConditions: string[] = [];
    const plainParams: unknown[] = [];
    const addPlain = (condition: string, ...values: unknown[]): void => {
      conditions.push(condition);
      params.push(...values);
      plainConditions.push(condition);
      plainParams.push(...values);
    };

    if (!opts?.includeArchived) {
      addPlain("archived_at IS NULL");
    }
    if (opts?.afterSortKey) {
      addPlain("(ts_emitted, stream_sort_key) > (SELECT ts_emitted, stream_sort_key FROM stream_items WHERE stream_sort_key = ?)", opts.afterSortKey);
    }
    if (opts?.sourceSession) {
      addPlain("source_session = ?", opts.sourceSession);
    }
    if (opts?.hintDestination) {
      addPlain("hint_destination = ?", opts.hintDestination);
    }
    if (opts?.hintTag) {
      conditions.push("json_valid(stream_items.hint_tags) AND EXISTS (SELECT 1 FROM json_each(stream_items.hint_tags) WHERE json_each.value = ?)");
      params.push(opts.hintTag);
    }
    if (opts?.since) {
      addPlain("ts_emitted >= ?", opts.since);
    }
    if (opts?.until) {
      addPlain("ts_emitted <= ?", opts.until);
    }
    if (opts?.hintTag) {
      // OF-168: a stream item whose hint_tags are damaged cannot say whether it carries this tag, so the filter cannot match it.
      // Which items match is unchanged; the ones whose tag text names the tag (and match every other filter) are NAMED in the log.
      const unreadable = (this.db.prepare(
        `SELECT stream_item_id FROM stream_items WHERE hint_tags IS NOT NULL AND NOT json_valid(hint_tags) AND instr(hint_tags, '"' || ? || '"') > 0${plainConditions.map((c) => ` AND ${c}`).join("")}
         ORDER BY ts_emitted, stream_sort_key`,
      ).all(opts.hintTag, ...plainParams) as Array<{ stream_item_id: string }>).map((row) => row.stream_item_id);
      const tag = opts.hintTag;
      nameRowsThrottled(`stream-list:${tag}`, unreadable, (due, total) => {
        console.error(`[stream] list hintTag ${JSON.stringify(tag)}: ${namedRows(due, total)} not listed: saved hint_tags are not readable JSON, so a match on that tag is unknown (repair or remove the row)`);
      });
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit);

    const latest = opts?.direction === "latest";
    const rows = this.db
      .prepare(
        `SELECT * FROM stream_items ${where} ORDER BY ts_emitted ${latest ? "DESC" : "ASC"}, stream_sort_key ${latest ? "DESC" : "ASC"} LIMIT ?`
      )
      .all(...params) as StreamItemRow[];

    return (latest ? rows.reverse() : rows).map((r) => this.rowToItem(r));
  }

  /**
   * Soft-archive — sets `archived_at`. Items remain in the table for audit.
   */
  archive(streamItemId: string): boolean {
    const result = this.db
      .prepare(
        "UPDATE stream_items SET archived_at = datetime('now') WHERE stream_item_id = ? AND archived_at IS NULL"
      )
      .run(streamItemId);
    return result.changes > 0;
  }

  private getByIdRaw(streamItemId: string): StreamItemRow | undefined {
    return this.db
      .prepare("SELECT * FROM stream_items WHERE stream_item_id = ?")
      .get(streamItemId) as StreamItemRow | undefined;
  }

  private rowToItem(row: StreamItemRow): StreamItem {
    return {
      streamItemId: row.stream_item_id,
      tsEmitted: row.ts_emitted,
      streamSortKey: row.stream_sort_key,
      sourceSession: row.source_session,
      body: row.body,
      format: row.format,
      hintType: row.hint_type,
      hintUrgency: row.hint_urgency,
      hintDestination: row.hint_destination,
      hintTags: readStoredJsonStrings(row.hint_tags),
      interrupt: row.interrupt === 1,
      archivedAt: row.archived_at,
    };
  }
}
