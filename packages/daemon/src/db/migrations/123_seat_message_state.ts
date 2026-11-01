import type { Migration } from "../migrate.js";

/**
 * Seat Messaging stage S3: the `Message` aggregate's own state, beside the outbox row it reuses (census-delivery-guarantees-20261101,
 * part 2; design-delivery-s4-20261101, N1 and section 3). `delivery_state` keeps its old vocabulary on purpose: `parseDeliveryState`
 * throws on a value it does not know, and one such row poisons a whole listing on a rolled-back build. An old build ignores these
 * columns, keeps reading the row as a plain outbox row, and stops driving it. Nullable or defaulted only, no CHECK.
 *
 * `message_state` NULL means the pump never touches the row: every older row, every row a sender wrote outside the seam, and a
 * Command, which stays with its owner (S4 design, premise 6).
 *
 * `lane` is FIFO's unit (N4): 0 startup and handover, 1 compaction prompts, 2 content and nudges.
 *
 * MERGE NOTE: `attempts`, `occupant_generation` and `message_class` belong to S1's migration 122, not yet committed when this was
 * written. They are here under S1's exact names so this branch runs alone. Merging S1 fails loud on a duplicate column: delete those
 * three lines then.
 */
export const seatMessageStateSchema: Migration = {
  name: "123_seat_message_state.sql",
  sql: `
    ALTER TABLE outbox_entries ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE outbox_entries ADD COLUMN occupant_generation TEXT;
    ALTER TABLE outbox_entries ADD COLUMN message_class TEXT;
    ALTER TABLE outbox_entries ADD COLUMN message_state TEXT;
    ALTER TABLE outbox_entries ADD COLUMN lane INTEGER NOT NULL DEFAULT 2;
    ALTER TABLE outbox_entries ADD COLUMN message_next_attempt_ms INTEGER;
    ALTER TABLE outbox_entries ADD COLUMN message_pause_reason TEXT;
    ALTER TABLE outbox_entries ADD COLUMN message_last_refusal TEXT;
    ALTER TABLE outbox_entries ADD COLUMN message_received_at TEXT;
    ALTER TABLE outbox_entries ADD COLUMN message_gate_version INTEGER;
    ALTER TABLE outbox_entries ADD COLUMN message_gate_nonce TEXT;
    ALTER TABLE outbox_entries ADD COLUMN message_closed_reason TEXT;
    ALTER TABLE outbox_entries ADD COLUMN message_closed_at TEXT;
    CREATE INDEX idx_outbox_message_open ON outbox_entries(destination_session, lane, message_state)
      WHERE message_state IN ('accepted', 'attempting');
  `,
};
