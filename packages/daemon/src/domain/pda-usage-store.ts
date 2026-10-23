// pda runtime (pda-runtime-design-9l, "Usage (J-3)"): the store behind the usage facts a pda runner reports
// (migration 116). One row per (conversation_id, entry_id): an entry the runner posts again (a gap fill, the
// unacknowledged facts it re-sends on the next run_end, a restart) is never stored or counted twice. The only
// change ever made to a stored row is an `unknown` origin settling to `own` or `other`, and only by the seat
// that stored it. The facts arrive already checked by parsePdaUsageFact (cost and basis agree, J-5); this store
// writes them as given and derives nothing.
import type { Database } from "better-sqlite3";
import type { PdaUsageFact } from "../adapters/pda-runner-protocol.js";

export function hasPdaUsageEntriesTable(db: Database): boolean {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pda_usage_entries'").get();
  } catch {
    return false;
  }
}

export class PdaUsageEntriesStore {
  constructor(private readonly db: Database) {}

  /** Store each fact once. Returns how many were new (or had an unknown origin settled) and how many were
   *  already stored. A fact whose (conversation, entry) another seat stored first is a duplicate, never moved. */
  record(
    input: { seatSession: string; nodeId: string | null; generation: string | null; agent: string; facts: PdaUsageFact[] },
    recordedAt: string,
  ): { stored: number; duplicates: number } {
    const insert = this.db.prepare(
      `INSERT INTO pda_usage_entries
         (conversation_id, entry_id, agent, entry_timestamp, kind, provider, model, api, response_id, stop_reason,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_total, cost_basis, origin,
          seat_session, node_id, occupant_generation, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id, entry_id) DO UPDATE SET origin = excluded.origin
         WHERE pda_usage_entries.origin = 'unknown' AND excluded.origin <> 'unknown'
           AND pda_usage_entries.seat_session = excluded.seat_session`,
    );
    let stored = 0;
    this.db.transaction(() => {
      for (const f of input.facts) {
        stored += insert.run(
          f.conversationId, f.entryId, input.agent, f.entryTimestamp, f.kind, f.provider, f.model, f.api, f.responseId, f.stopReason,
          f.input, f.output, f.cacheRead, f.cacheWrite, f.costTotal, f.costBasis, f.origin,
          input.seatSession, input.nodeId, input.generation, recordedAt,
        ).changes;
      }
    })();
    return { stored, duplicates: input.facts.length - stored };
  }
}
