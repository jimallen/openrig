import type { Migration } from "../migrate.js";

/**
 * RSI (rev2 §3.4, §3.7): the two daemon-side state tables of the improvement loop, in ONE
 * migration so the human-gate notifier (B2) could be built against its table in parallel with
 * the health-finding wake (B1). The notifier is retired (2026-10-31, Jim: the inbox panel replaces the
 * macOS banner); its two tables stay in the schema, unwritten and unread, and this migration is unchanged.
 *
 * rsi_finding_state — one row per telemetry-finding fingerprint (rsi/fingerprint.ts). The
 *   health-finding-wake policy updates it on every scan. A fingerprint that goes quiet and
 *   later returns gets a new activated_at; that, not a stored set, is what makes a recurrence
 *   wake. `source` is the health source that reported it: a source whose coverage is
 *   unavailable or partial makes no transitions that scan, so its rows carry forward.
 *
 * rsi_notifications — the retired notifier's per-item banner state (§3.7); no longer written:
 *   (qitem_id, first_notified_at, last_notified_at), exactly as the design names it.
 *
 * rsi_notification_banners — one row per banner the retired notifier attempted (§3.7 rate limit);
 *   no longer written. The per-day cap counted these rows. A per-item last_notified_at cannot: one banner covers
 *   several items, and a reminder overwrites the earlier time.
 */
export const rsiWakeStateSchema: Migration = {
  name: "113_rsi_wake_state.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS rsi_finding_state (
      fingerprint TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('active', 'quiet')),
      activated_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rsi_finding_state_source_state
      ON rsi_finding_state(source, state);

    CREATE TABLE IF NOT EXISTS rsi_notifications (
      qitem_id TEXT PRIMARY KEY,
      first_notified_at TEXT NOT NULL,
      last_notified_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rsi_notification_banners (
      id INTEGER PRIMARY KEY,
      sent_at TEXT NOT NULL,
      item_count INTEGER NOT NULL,
      ok INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rsi_notification_banners_sent_at
      ON rsi_notification_banners(sent_at);
  `,
};
