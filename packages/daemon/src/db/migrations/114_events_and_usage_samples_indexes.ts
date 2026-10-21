import type { Migration } from "../migrate.js";

// RSI A2b: the counted detectors read one trailing window per health read.
//  - D5, D9 and D12 read one event type over a created_at window. Without events(type, created_at)
//    each read scans the whole append-only events table (no retention; about 2.6k rows a day).
//  - D6 and D7 read usage_samples by lane over a captured_at window; usage_samples had no index that
//    leads with the lane or the time. With this index their plans are SEARCH (lane=? AND captured_at>?).
//  - D10 and the retention sweep compare captured_at ALONE, and this index does NOT serve them as a
//    seek: it leads with `lane`. Measured with EXPLAIN QUERY PLAN (SQLite 3.53.4, no sqlite_stat1):
//    both are a full SCAN of a covering index, this one with it and idx_usage_samples_node_time without
//    it. They stay O(rows); a captured_at-led index would be needed to make them a range seek.
// Number 113 belongs to RSI B1 (rsi_finding_state and rsi_notifications); this migration deliberately
// takes 114. Both indexes live in one migration because neither has shipped.
export const eventsAndUsageSamplesIndexesSchema: Migration = {
  name: "114_events_and_usage_samples_indexes.sql",
  sql: `
    CREATE INDEX IF NOT EXISTS idx_events_type_created_at ON events(type, created_at);
    CREATE INDEX IF NOT EXISTS idx_usage_samples_lane_captured_at ON usage_samples(lane, captured_at);
  `,
};
