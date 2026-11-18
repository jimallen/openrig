import type { Migration } from "../migrate.js";

// workspaces-o9o.123: Claude Code's Code Mode (CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1). Two columns, two meanings:
// - nodes.code_mode: the seat's declaration (`code_mode: true` on the member), like remote_control and ask_in_modal. It decides the
//   seat's next FRESH launch only.
// - sessions.code_mode: the mode a conversation was launched in, recorded on its session row (as migration 130 records the Claude home).
//   A Code Mode conversation resumes or forks only with the variable set (measured, o9o.122), so every resume, restore, fork and resume
//   line uses this, never the seat's current declaration: withdrawing code_mode never strands a live Code Mode conversation, and
//   declaring it never forces Code Mode onto an existing one (CoS ruling, verify-sec2's finding 4).
// 1 = Code Mode; NULL = not (launch environment unchanged).
export const nodeCodeModeSchema: Migration = {
  name: "133_node_code_mode.sql",
  sql: `
    ALTER TABLE nodes ADD COLUMN code_mode INTEGER;
    ALTER TABLE sessions ADD COLUMN code_mode INTEGER;
  `,
};
