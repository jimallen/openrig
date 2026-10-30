import type { Migration } from "../migrate.js";

/**
 * Native comms step 3 (design-native-comms-20261030 §8.1): a native outbox row carries the per-row nonce of its marker
 * (never returned to the sender), the time it was claimed for the socket write (the deadline sweeper works from it after
 * a restart), the seat's transcript at that time (a /clear later moves the seat to a new one; review N3), and the
 * prompt id of the hook that acked it (a second run of the same prompt's hook is the same delivery, not a duplicate). seat_native_endpoints holds, per node, what the seat's SessionStart hook reported (inbox
 * socket, transcript, claude pid and binary) and the launch probe of that binary (version, inject-format literal).
 */
export const nativeInboxSchema: Migration = {
  name: "118_native_inbox.sql",
  sql: `
    ALTER TABLE outbox_entries ADD COLUMN native_nonce TEXT;
    ALTER TABLE outbox_entries ADD COLUMN native_written_at TEXT;
    ALTER TABLE outbox_entries ADD COLUMN native_transcript_path TEXT;
    ALTER TABLE outbox_entries ADD COLUMN native_ack_prompt_id TEXT;
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
