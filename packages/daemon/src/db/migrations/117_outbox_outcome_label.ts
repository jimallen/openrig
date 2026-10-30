import type { Migration } from "../migrate.js";

/**
 * Native comms step 1 (design-native-comms-20261030 §5.6): label every settled outbox row with HOW it was settled, so
 * delivery outcomes can be measured per path. `delivery_path` is the last hop that carried (or would have carried) the
 * text: `tmux` (paste into the pane), `native` (a runtime's own inbox; no writer yet), `gateway` (an @external or
 * paneless human destination the gateway owns), `none` (nothing was sent: unroutable, superseded, no qitem, the local
 * human inbox). `ack_evidence` is what the outcome rests on (OUTBOX_ACK_EVIDENCE); `ack_detail` keeps the transport's
 * own reason code when there is one, so refusals, timeouts and failures can be told apart without a hand-kept list.
 * Rows settled before this migration keep NULL in all three: unlabelled, not guessed.
 */
export const outboxOutcomeLabelSchema: Migration = {
  name: "117_outbox_outcome_label.sql",
  sql: `
    ALTER TABLE outbox_entries ADD COLUMN delivery_path TEXT;
    ALTER TABLE outbox_entries ADD COLUMN ack_evidence TEXT;
    ALTER TABLE outbox_entries ADD COLUMN ack_detail TEXT;
  `,
};
