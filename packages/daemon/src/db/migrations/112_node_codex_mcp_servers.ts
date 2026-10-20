import type { Migration } from "../migrate.js";

// Per-seat Codex MCP servers (rig seat set-mcp): the servers ONE seat instance has switched on, as a JSON
// object of name -> declaration snapshot. NULL means none, which is every seat until an operator acts:
// a server declared on a spec member is off by default for every seat instance of that member.
export const nodeCodexMcpServersSchema: Migration = {
  name: "112_node_codex_mcp_servers.sql",
  sql: `
    ALTER TABLE nodes ADD COLUMN codex_mcp_servers TEXT;
  `,
};
