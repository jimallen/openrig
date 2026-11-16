import type Database from "better-sqlite3";
import { openMessageIdsFor } from "../domain/seat-messaging/message-store.js";
import type { QueuedMessageReader, QueuedRow } from "../domain/seat-messaging/queued-messages.js";

interface Row {
  id: string;
  sender: string;
  recorded_at: string;
  state: string;
  attempts: number;
  lane: number | null;
  pause_reason: string | null;
  last_refusal: string | null;
  next_attempt_at: string | null;
  previous_occupant: string | null;
  body: string;
}

/**
 * The open rows of one seat, read from the outbox. Which rows are open is the message store's one rule (its `OPEN` predicate, through
 * `openMessageIdsFor`), never a copy of it here: a state the store adds or a row it reopens shows up on this list by the same rule the
 * pump uses. Order is the pump's own (`MessageStore.headOf`): lowest lane first, then oldest by rowid, so the first row is the next one.
 * SELECT only, in one read transaction, so the count and the rows are of the same moment.
 */
export class SqliteQueuedMessages implements QueuedMessageReader {
  constructor(private readonly db: Database.Database) {}

  openRowsFor(seat: string, limit: number): { rows: QueuedRow[]; total: number } {
    return this.db.transaction((): { rows: QueuedRow[]; total: number } => {
      const ids = openMessageIdsFor(this.db, [seat]);
      if (ids.length === 0) return { rows: [], total: 0 };
      const rows = this.db.prepare(`SELECT outbox_id AS id, sender_session AS sender, ts_dispatched AS recorded_at, message_state AS state, attempts,
          lane, message_pause_reason AS pause_reason, message_last_refusal AS last_refusal, next_attempt_at, message_previous_occupant AS previous_occupant, body
        FROM outbox_entries WHERE outbox_id IN (SELECT value FROM json_each(?)) ORDER BY coalesce(lane, 2), rowid LIMIT ?`)
        .all(JSON.stringify(ids), limit) as Row[];
      return {
        total: ids.length,
        rows: rows.map((r) => ({
          id: r.id, sender: r.sender, recordedAt: r.recorded_at, state: r.state === "accepted" ? "accepted" : "attempting", attempts: r.attempts,
          lane: r.lane ?? 2, pauseReason: r.pause_reason, lastRefusal: r.last_refusal, nextAttemptAt: r.next_attempt_at, previousOccupant: r.previous_occupant, body: r.body,
        })),
      };
    })();
  }

  knownSeat(seat: string): boolean {
    return this.db.prepare("SELECT 1 FROM sessions WHERE session_name = ? LIMIT 1").get(seat) !== undefined;
  }

  bodyOf(id: string): string | null {
    const row = this.db.prepare("SELECT body FROM outbox_entries WHERE outbox_id = ?").get(id) as { body: string } | undefined;
    return row?.body ?? null;
  }
}
