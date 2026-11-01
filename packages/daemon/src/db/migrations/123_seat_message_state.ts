import type { Migration } from "../migrate.js";

/**
 * Seat Messaging stage S3: what the pump keeps beyond S1's columns (migration 122: `message_state`, `class`, `lane`, `attempts`,
 * `next_attempt_at`, `occupant_generation`, `gate_recorded_at`, `gate_nonce`). Nullable only, no CHECK, and `delivery_state` keeps its old
 * vocabulary, so a rolled-back build reads these rows as plain outbox rows (design-delivery-s4, section 3).
 *
 *  - `message_pause_reason`: why `attempting` is waiting (busy, blocked, guard_held, seat_stopped, gate_unavailable). A reason, not a state.
 *  - `message_last_refusal`: the last hop refusal, for health.
 *  - `message_gate_version`: the gate that recorded the id.
 *  - `message_closed_reason`, `message_closed_at`: why and when a row ended `undeliverable`.
 *  - `message_hold_released_at`: when a held row rejoined its seat's queue. A `retained` row stays the guard's until this is set, whatever
 *    its `message_state`: the send path leaves a held row `attempting`, so `message_state` cannot say who holds it.
 */
export const seatMessageStateSchema: Migration = {
  name: "123_seat_message_state.sql",
  sql: `
    ALTER TABLE outbox_entries ADD COLUMN message_pause_reason TEXT;
    ALTER TABLE outbox_entries ADD COLUMN message_last_refusal TEXT;
    ALTER TABLE outbox_entries ADD COLUMN message_gate_version INTEGER;
    ALTER TABLE outbox_entries ADD COLUMN message_closed_reason TEXT;
    ALTER TABLE outbox_entries ADD COLUMN message_closed_at TEXT;
    ALTER TABLE outbox_entries ADD COLUMN message_hold_released_at TEXT;
    CREATE INDEX idx_outbox_message_open ON outbox_entries(destination_session, message_state)
      WHERE message_state IN ('accepted', 'attempting');
  `,
};
