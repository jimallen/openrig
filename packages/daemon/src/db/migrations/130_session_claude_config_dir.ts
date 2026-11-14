import type { Migration } from "../migrate.js";

// The Claude config home a session was launched with: the seat's own (nodes.claude_config_dir) at the moment the
// session row was made, NULL for the daemon's own selection. `rig seat set-claude-home` changes the node and restarts
// nothing, so the readers of a running conversation's files (its sessions/<pid>.json, its transcript) key on this,
// the home the running process actually started on, not the seat's current choice.
export const sessionClaudeConfigDirSchema: Migration = {
  name: "130_session_claude_config_dir.sql",
  sql: `
    ALTER TABLE sessions ADD COLUMN claude_config_dir TEXT;
  `,
};
