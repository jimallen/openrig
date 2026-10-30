import type { Migration } from "../migrate.js";

/**
 * Native comms ncomms-3d: whether the seat's claude binary parses the sender-name envelope (its launch probe found the
 * parser's from-name literal). 1: a native message carries the sender's seat name; 0 or NULL: plain content, as before.
 */
export const nativeNameEnvelopeSchema: Migration = {
  name: "119_native_name_envelope.sql",
  sql: `
    ALTER TABLE seat_native_endpoints ADD COLUMN name_envelope INTEGER;
  `,
};
