import type { Migration } from "../migrate.js";

// A seat's own Claude Code config home (spec `claude_config_dir`, or `rig seat set-claude-home`). Every launch, resume,
// restore and handover successor of the seat runs with CLAUDE_CONFIG_DIR set to this exact canonical absolute path
// (Claude names its keychain login after the exact string). NULL = the daemon's own selection, unchanged: OpenRig
// exports nothing, so the seat reads whatever the daemon and its terminal already select.
export const nodeClaudeConfigDirSchema: Migration = {
  name: "129_node_claude_config_dir.sql",
  sql: `
    ALTER TABLE nodes ADD COLUMN claude_config_dir TEXT;
  `,
};
