import type { Migration } from "../migrate.js";

// A seat whose claude-code launch carries the ask-in-modal Stop hook (ask-in-modal-guard.cjs), which sends a turn back
// when it ends with a question to the human in prose. Persisted on the node like remote_control, so a restore after a
// daemon restart and a handover successor still know the declaration:
// 1 = the member declared `ask_in_modal: true`; NULL/0 = not declared (launch settings unchanged).
export const nodeAskInModalSchema: Migration = {
  name: "131_node_ask_in_modal.sql",
  sql: `
    ALTER TABLE nodes ADD COLUMN ask_in_modal INTEGER;
  `,
};
