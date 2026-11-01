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
 *  - `message_previous_occupant`: set when a held row goes to a new occupant (Jim's decision): every attempt carries the label, built
 *    from this at the attempt. The stored body never changes (invariant 2).
 *  - `message_socket_written_ms`: the last socket write of this message. Claude drops an identical line inside 25 to 40 s (M1), so the
 *    wait must survive a daemon restart.
 *  - `message_pasted_at`: when this message was pasted into an empty composer, committed before the paste. A collapsed paste shows only a
 *    size, so this record is what lets a hop treat one of exactly that size as this message's own copy.
 *
 * The row's nonce is `native_nonce` (migration 118), minted at the first attempt and never changed: (id, nonce) is the gate's identity.
 */
/** Step B4a, run BEFORE SEAT_MESSAGE_ROLLBACK_SQL, which nulls `message_state`. No schema change: rollback leaves 123 applied, as it does
 * 122. An old build ignores every column here, so this is for the second forward. A held row the pump took stays `retained` for the old
 * build, but with its release left set it would be open to nobody at the second forward: `listHeld` skips a released row and `OPEN` needs a
 * state. So it goes back to the guard, to be judged again. An open row's schedule, pause and socket window describe a daemon that is gone.
 * `native_nonce` stays: it belongs to rows the old build still reads. */
export const SEAT_MESSAGE_STATE_ROLLBACK_SQL = `
UPDATE outbox_entries SET message_hold_released_at=NULL, message_previous_occupant=NULL WHERE delivery_state='retained' AND message_hold_released_at IS NOT NULL;
UPDATE outbox_entries SET message_pause_reason=NULL, message_last_refusal=NULL, message_socket_written_ms=NULL, message_pasted_at=NULL, next_attempt_at=NULL WHERE message_state IN ('accepted','attempting');
`;

export const seatMessageStateSchema: Migration = {
  name: "123_seat_message_state.sql",
  sql: `
    ALTER TABLE outbox_entries ADD COLUMN message_pause_reason TEXT;
    ALTER TABLE outbox_entries ADD COLUMN message_last_refusal TEXT;
    ALTER TABLE outbox_entries ADD COLUMN message_gate_version INTEGER;
    ALTER TABLE outbox_entries ADD COLUMN message_closed_reason TEXT;
    ALTER TABLE outbox_entries ADD COLUMN message_closed_at TEXT;
    ALTER TABLE outbox_entries ADD COLUMN message_hold_released_at TEXT;
    ALTER TABLE outbox_entries ADD COLUMN message_previous_occupant TEXT;
    ALTER TABLE outbox_entries ADD COLUMN message_socket_written_ms INTEGER;
    ALTER TABLE outbox_entries ADD COLUMN message_pasted_at TEXT;
    CREATE INDEX idx_outbox_message_open ON outbox_entries(destination_session, message_state)
      WHERE message_state IN ('accepted', 'attempting');
  `,
};
