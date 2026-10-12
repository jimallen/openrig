import type { Migration } from "../migrate.js";

// A seat whose claude-code launch starts Claude Code Remote Control (`--remote-control <session name>`).
// Persisted on the node, like effort, so a restore after a daemon restart still knows the declaration:
// 1 = the member declared `remote_control: true`; NULL/0 = not declared (launch command unchanged).
export const nodeRemoteControlSchema: Migration = {
  name: "102_node_remote_control.sql",
  sql: `
    ALTER TABLE nodes ADD COLUMN remote_control INTEGER;
  `,
};
