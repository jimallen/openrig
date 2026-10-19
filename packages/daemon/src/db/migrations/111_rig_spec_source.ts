import type { Migration } from "../migrate.js";

/**
 * OF-32: where a rig's spec came from, in the spelling the operator chose (a spec library link keeps its link
 * path, so the release it points at can move). It is resolved again each time it is used: `rig seat launch
 * --fresh` re-reads the seat's startup files from it instead of replaying the absolute paths stored at first
 * launch. NULL = not recorded (a rig created before this column, or from a source that has no spec file).
 */
export const rigSpecSourceSchema: Migration = {
  name: "111_rig_spec_source.sql",
  sql: "ALTER TABLE rigs ADD COLUMN spec_source_path TEXT;",
};
