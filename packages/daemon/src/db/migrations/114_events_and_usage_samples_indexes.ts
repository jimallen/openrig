import type { Migration } from "../migrate.js";

// RSI A2b: the counted detectors read one trailing window per health read.
//  - D5, D9 and D12 read one event type over a created_at window. Without events(type, created_at)
//    each read scans the whole append-only events table (no retention; about 2.6k rows a day).
//  - D6 and D7 read usage_samples by lane over a captured_at window, and D10 and the retention sweep
//    compare captured_at alone. usage_samples has no index that leads with the lane or the time.
// Number 113 belongs to RSI B1 (rsi_finding_state and rsi_notifications); this migration deliberately
// takes 114. Both indexes live in one migration because neither has shipped.
export const eventsAndUsageSamplesIndexesSchema: Migration = {
  name: "114_events_and_usage_samples_indexes.sql",
  sql: `
    CREATE INDEX IF NOT EXISTS idx_events_type_created_at ON events(type, created_at);
    CREATE INDEX IF NOT EXISTS idx_usage_samples_lane_captured_at ON usage_samples(lane, captured_at);
  `,
};
