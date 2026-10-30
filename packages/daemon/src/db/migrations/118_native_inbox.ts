import type { Migration } from "../migrate.js";

/**
 * Native comms step 3 (design-native-comms-20261030 §8.1): a native outbox row carries the per-row nonce of its marker
 * (never returned to the sender) and the time it was claimed for the socket write, from which the deadline sweeper
 * works after a restart. seat_native_endpoints holds, per node, what the seat's SessionStart hook reported (inbox
 * socket, transcript, claude pid and binary) and the launch probe of that binary (version, inject-format literal).
 */
export const nativeInboxSchema: Migration = {
  name: "118_native_inbox.sql",
  sql: `
    ALTER TABLE outbox_entries ADD COLUMN native_nonce TEXT;
    ALTER TABLE outbox_entries ADD COLUMN native_written_at TEXT;
    CREATE TABLE IF NOT EXISTS seat_native_endpoints (
      node_id TEXT PRIMARY KEY,
      session_name TEXT,
      generation TEXT,
      socket_path TEXT,
      transcript_path TEXT,
      claude_pid INTEGER,
      exec_path TEXT,
      claude_version TEXT,
      probe_result TEXT,
      registered_at TEXT NOT NULL
    );
  `,
};
