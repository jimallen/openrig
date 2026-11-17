import type { Migration } from "../migrate.js";

/**
 * workspaces-o9o.25 (verify-sec review): which seat's projection still wants each file in a seat plugin copy
 * (.claude/plugins/<id>, .codex/plugins/<id>). Seats can share a cwd, and so a plugin folder; projection_manifest is keyed
 * by target_path alone, so it cannot say whose file a projected file is. One row per (file, seat): a projection by a seat
 * sets that seat's rows under the plugin folder to exactly what it projects, and a file is removed only when the seat
 * removing it claimed it before, no longer projects it, and no other seat claims it.
 *
 * Additive: a new table, nothing existing is read or changed. Files written before this table existed carry no claim and
 * are never removed.
 */
export const pluginCopyClaimsSchema: Migration = {
  name: "132_plugin_copy_claims.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS plugin_copy_claims (
      target_path   TEXT NOT NULL,
      owner_node_id TEXT NOT NULL,
      claimed_at    TEXT NOT NULL,
      PRIMARY KEY (target_path, owner_node_id)
    );
  `,
};
