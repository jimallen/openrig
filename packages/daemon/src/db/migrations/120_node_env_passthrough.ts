import type { Migration } from "../migrate.js";

/**
 * A Pi seat's extra environment names (spec member `env_passthrough`), as a JSON array of names. The runner
 * copies only these names, from the seat pane's own environment, into its child; no value is ever stored. NULL or
 * absent: the baseline only, as before.
 */
export const nodeEnvPassthroughSchema: Migration = {
  name: "120_node_env_passthrough.sql",
  sql: `
    ALTER TABLE nodes ADD COLUMN env_passthrough TEXT;
  `,
};
