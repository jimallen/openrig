import type { Migration } from "../migrate.js";

// workspaces-o9o.123: a Claude Code seat that runs Code Mode (CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1). Persisted on the node like
// remote_control and ask_in_modal, because a Code Mode session resumes or forks only with the variable set (measured, o9o.122):
// restore, handover and the resumability probe read the node, so they must know it.
// 1 = the member declared `code_mode: true`; NULL/0 = not declared (launch environment unchanged).
export const nodeCodeModeSchema: Migration = {
  name: "133_node_code_mode.sql",
  sql: `
    ALTER TABLE nodes ADD COLUMN code_mode INTEGER;
  `,
};
