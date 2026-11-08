import type { Migration } from "../migrate.js";

/**
 * A Pi seat's `pi.link_operator_models` (spec member `pi: { link_operator_models: true }`, OF-279), as 1 (declared true).
 * The pane runner then links the seat's agent-dir models.json to the operator's at every launch. NULL or absent: not
 * declared, nothing is linked, as before. Only 1 and NULL are ever written.
 */
export const nodePiLinkOperatorModelsSchema: Migration = {
  name: "127_node_pi_link_operator_models.sql",
  sql: `
    ALTER TABLE nodes ADD COLUMN pi_link_operator_models INTEGER;
  `,
};
