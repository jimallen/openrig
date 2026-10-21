import type { Migration } from "../migrate.js";

// RSI A2b: the event-counted detectors (D5, D9, D12) read one trailing window of one event type on
// every health read. Without this index each read scans the whole append-only events table
// (no retention; about 2.6k rows a day). Number 113 belongs to RSI B1 (rsi_finding_state and
// rsi_notifications); this migration deliberately takes 114.
export const eventsTypeCreatedAtIndexSchema: Migration = {
  name: "114_events_type_created_at_index.sql",
  sql: `
    CREATE INDEX IF NOT EXISTS idx_events_type_created_at ON events(type, created_at);
  `,
};
