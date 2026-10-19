import type { Migration } from "../migrate.js";

/**
 * OF-30: a launch the operator made fresh (`rig seat launch --fresh`, which `rig up` / `rig start` use for an accepted
 * fresh start, or a restore with `--fresh <seat>`) is a choice not to continue the earlier conversation. When such a
 * launch fails it leaves a token-less row that looks exactly like any other failed launch, and a later restore must not
 * read past it into the conversation the operator chose to leave. This marks the row at launch time.
 *
 * Additive and defaulted: a row written by an older revision reads 0 ("not marked"), and an older revision ignores the
 * column. Rows already written are not backfilled; their fresh intent was never recorded.
 */
export const sessionFreshStartSchema: Migration = {
  name: "110_session_fresh_start.sql",
  sql: `
    ALTER TABLE sessions ADD COLUMN fresh_start INTEGER NOT NULL DEFAULT 0
      CHECK (fresh_start IN (0, 1));
  `,
};
