import type { Migration } from "../migrate.js";

/**
 * OF-28: until `SessionRegistry.registerSession` started copying the seat's restore policy, every session after a seat's
 * first took the column default (`resume_if_possible`) whatever its node said. A terminal seat (`checkpoint_only`, never
 * has a resume token) then stopped as "had a session but no token" on every restore. New rows are now correct; this
 * corrects the rows already written.
 *
 * Sets `sessions.restore_policy` to the node's value wherever the two differ. A node with no recorded policy is left
 * alone (its sessions keep what they have). Re-running changes nothing: after one pass no row differs.
 */
export const sessionRestorePolicyBackfillSchema: Migration = {
  name: "109_session_restore_policy_backfill.sql",
  sql: `
    UPDATE sessions
       SET restore_policy = (SELECT n.restore_policy FROM nodes n WHERE n.id = sessions.node_id)
     WHERE EXISTS (
       SELECT 1 FROM nodes n
        WHERE n.id = sessions.node_id
          AND n.restore_policy IS NOT NULL
          AND n.restore_policy <> sessions.restore_policy
     );
  `,
};
