import type { Migration } from "../migrate.js";

/**
 * Seat Messaging stage S4a (design-delivery-s4-20261101, N2): a wake group is N rows that go out as one text, one marker each.
 * `message_group` names the group; NULL is a message on its own. Nullable, no CHECK, and `delivery_state` is untouched, under the same state
 * rule as 122 and 123: a rolled-back build ignores the column, so rollback leaves this applied and needs no step of its own. The rows it
 * nulls at B4a lose their `message_state`, and only a state makes a group's column read: an adoption at a second forward writes it again.
 */
export const seatMessageGroupSchema: Migration = {
  name: "124_seat_message_group.sql",
  sql: `ALTER TABLE outbox_entries ADD COLUMN message_group TEXT;`,
};
