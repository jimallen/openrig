import type { Migration } from "../migrate.js";

// pda runtime (pda-runtime-design-9l D2): the pda agent a seat drives, as JSON
// `{"agent":"<name>","base_url":"http://127.0.0.1:<port>"}`. NULL for every seat that is not runtime pda,
// which is every seat until a spec member declares a `pda:` block. Restore reads the resume token, not this
// column; fresh-launch retry and `rig spec export` read it. The number and the name are reserved in
// RESERVED_MIGRATION_NAMES (all-migrations.ts).
export const nodePdaBindingSchema: Migration = {
  name: "115_node_pda_binding.sql",
  sql: `
    ALTER TABLE nodes ADD COLUMN pda_binding TEXT;
  `,
};
