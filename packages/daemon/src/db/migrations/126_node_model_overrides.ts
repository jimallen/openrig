import type { Migration } from "../migrate.js";

/**
 * A Pi seat's model overrides (spec member `model_overrides`, OF-270), as JSON text of
 * { <provider>: { <model>: { contextWindow } } }. The pane runner merges it into the seat's agent-dir models.json at
 * every launch. Numbers and names only. NULL or absent: nothing to write, as before.
 */
export const nodeModelOverridesSchema: Migration = {
  name: "126_node_model_overrides.sql",
  sql: `
    ALTER TABLE nodes ADD COLUMN model_overrides TEXT;
  `,
};
