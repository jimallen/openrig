import type { Migration } from "../migrate.js";

/**
 * Seat Messaging S1 (census-delivery-guarantees-20261101, part 2; rollback rules: design-delivery-s4-20261101, section 3): the row of a
 * message commits before the first write to its seat, and its id never changes across attempts. Additive only: every column is
 * nullable or defaulted, with no CHECK, and no existing row or column changes.
 *
 * `outbox_entries` is the `Message` aggregate's table:
 *  - `message_state`: accepted, attempting; later received, undeliverable. NULL is a row the pump never touches: a legacy row, a row
 *    already settled by today's paths, a wake row the drain owns, or a Command (`/compact` stays with the enforcer). The new states
 *    live here and never in `delivery_state`: one unknown value there makes 771a08e5's `rowToEntry`, and so the sender's whole listing,
 *    throw (measured, design-delivery-s4 premise 2).
 *  - `message_id`: the id every attempt carries. Equal to `outbox_id` except on a native repeat's per-attempt row (`<id>.r<n>`). NULL on
 *    an older row, whose `outbox_id` is its message id.
 *  - `class`: content, nudge, lifecycle or command. `lane`: 0 startup and handover, 1 compaction prompts, 2 content and nudges (FIFO
 *    per seat per lane). `occupant_generation`: the occupant a message is bound to, so it never reaches a successor.
 *  - `attempts`: attempts started (0: this message never went out). `next_attempt_at`, `gate_recorded_at`, `gate_nonce`: no writer
 *    yet; the pump (S3) and the gates (S2) own them.
 *
 * `compaction_stages` holds the compaction enforcer's per-seat stage, which used to live only in memory and was lost at every restart.
 *
 * Rollback leaves this migration applied. The previous build's `migrate()` ignores a name it does not know, its `SELECT *` mapping
 * ignores extra columns, its inserts name their columns, and `compaction_stages` is not read, so it runs with all of this in place.
 * Reversing it was rejected: `DROP COLUMN` would destroy the record of undelivered messages. A second forward re-applies 121 and
 * skips 122. Open rows are closed by SEAT_MESSAGE_ROLLBACK_SQL, inside `reverse.sql` before the `bindings` update (step B4a), so the
 * pump does not resend at a second forward what a person may have resent by hand. Wake rows stay `pending` for the old drain.
 */
export const SEAT_MESSAGE_MIGRATION_NAME = "122_seat_message.sql";

export const seatMessageSchema: Migration = {
  name: SEAT_MESSAGE_MIGRATION_NAME,
  sql: `
    ALTER TABLE outbox_entries ADD COLUMN message_state TEXT;
    ALTER TABLE outbox_entries ADD COLUMN message_id TEXT;
    ALTER TABLE outbox_entries ADD COLUMN class TEXT;
    ALTER TABLE outbox_entries ADD COLUMN lane INTEGER;
    ALTER TABLE outbox_entries ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE outbox_entries ADD COLUMN next_attempt_at TEXT;
    ALTER TABLE outbox_entries ADD COLUMN occupant_generation TEXT;
    ALTER TABLE outbox_entries ADD COLUMN gate_recorded_at TEXT;
    ALTER TABLE outbox_entries ADD COLUMN gate_nonce TEXT;
    CREATE INDEX idx_outbox_message_state ON outbox_entries(message_state) WHERE message_state IS NOT NULL;
    CREATE TABLE compaction_stages (
      session_name TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `,
};

/** Step B4a, verbatim from design-delivery-s4 section 3: closes the rows still open at a rollback. No schema change. */
export const SEAT_MESSAGE_ROLLBACK_SQL = `
UPDATE outbox_entries SET delivery_state='failed', delivery_path='none', ack_evidence='superseded', ack_detail='rollback: lifecycle' WHERE message_state IN ('accepted','attempting') AND class IN ('lifecycle','command');
UPDATE outbox_entries SET delivery_state='indeterminate', ack_evidence='crash_reconciled', ack_detail='rollback: attempted' WHERE message_state IN ('accepted','attempting') AND delivery_state='pending' AND attempts>0 AND substr(outbox_id,1,12)<>'wake-intent-';
UPDATE outbox_entries SET delivery_state='failed', delivery_path='none', ack_evidence='send_failed', ack_detail='rollback: not sent' WHERE message_state IN ('accepted','attempting') AND delivery_state='pending' AND attempts=0 AND substr(outbox_id,1,12)<>'wake-intent-';
UPDATE outbox_entries SET message_state=NULL WHERE message_state IN ('accepted','attempting');
`;
