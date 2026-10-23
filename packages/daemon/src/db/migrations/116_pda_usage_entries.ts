import type { Migration } from "../migrate.js";

/**
 * pda runtime (pda-runtime-design-9l, "Usage (J-3)"): one row per assistant entry a pda agent has produced,
 * keyed by the pda conversation and the entry id, so a replay, a gap fill or a runner restart that returns the
 * entry again stores nothing new. A sibling of pi_usage_entries, not a generalisation of it: `pi_session_id`,
 * the `own`/`inherited` origin and the charges join are Pi's language.
 *
 * `origin` is `own` only when the run that produced the entry took one of this seat's submissions; `other` when
 * every input of that run was foreign (Jim in `pda chat`); `unknown` for gap-filled entries and runs the runner
 * saw no inputs for. `cost_total` is NULL unless pda's provider priced the entry: `cost_basis` says why
 * (`declared_zero_price`: the provider declares a zero price table, so its 0 is not spend; `absent`: no usable
 * cost). The table holds assistant entries only: compaction summaries and tool usage have no entry identity in
 * pda. The number and the name are reserved in RESERVED_MIGRATION_NAMES (all-migrations.ts).
 */
export const pdaUsageEntriesSchema: Migration = {
  name: "116_pda_usage_entries.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS pda_usage_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      agent TEXT NOT NULL,
      entry_timestamp TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('assistant')),
      provider TEXT,
      model TEXT,
      api TEXT,
      response_id TEXT,
      stop_reason TEXT,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL,
      cache_write_tokens INTEGER NOT NULL,
      cost_total REAL,
      cost_basis TEXT NOT NULL CHECK (cost_basis IN ('model_priced', 'declared_zero_price', 'absent')),
      origin TEXT NOT NULL CHECK (origin IN ('own', 'other', 'unknown')),
      seat_session TEXT NOT NULL,
      node_id TEXT,
      occupant_generation TEXT,
      recorded_at TEXT NOT NULL,
      UNIQUE (conversation_id, entry_id)
    );
    CREATE INDEX IF NOT EXISTS idx_pda_usage_entries_seat
      ON pda_usage_entries(seat_session, conversation_id, entry_timestamp);
  `,
};
