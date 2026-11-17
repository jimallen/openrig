// workspaces-o9o.25 (verify-sec review): the SQLite side of the PluginCopyClaims port (table plugin_copy_claims,
// migration 132): which seats' projections still want each file in a seat plugin copy.
import type Database from "better-sqlite3";
import type { PluginCopyClaims } from "../domain/plugin-copy-prune.js";

/** `dir` plus a trailing separator, so a prefix compare (not LIKE) selects only paths strictly inside it. */
const under = (dir: string): string => (dir.endsWith("/") ? dir : `${dir}/`);

export class SqlitePluginCopyClaims implements PluginCopyClaims {
  constructor(private readonly db: Database.Database) {}

  claimedUnder(dir: string, owner: string): string[] {
    const prefix = under(dir);
    return (this.db
      .prepare(`SELECT target_path FROM plugin_copy_claims WHERE owner_node_id = ? AND substr(target_path, 1, ?) = ? ORDER BY target_path`)
      .all(owner, prefix.length, prefix) as Array<{ target_path: string }>).map((row) => row.target_path);
  }

  claimants(targetPath: string): string[] {
    return (this.db
      .prepare(`SELECT owner_node_id FROM plugin_copy_claims WHERE target_path = ? ORDER BY owner_node_id`)
      .all(targetPath) as Array<{ owner_node_id: string }>).map((row) => row.owner_node_id);
  }

  setClaims(dir: string, owner: string, targets: ReadonlySet<string>, at: string): void {
    const prefix = under(dir);
    const clear = this.db.prepare(`DELETE FROM plugin_copy_claims WHERE owner_node_id = ? AND substr(target_path, 1, ?) = ?`);
    const insert = this.db.prepare(`INSERT OR REPLACE INTO plugin_copy_claims (target_path, owner_node_id, claimed_at) VALUES (?, ?, ?)`);
    this.db.transaction(() => {
      clear.run(owner, prefix.length, prefix);
      for (const target of targets) if (target.startsWith(prefix)) insert.run(target, owner, at);
    })();
  }

  forgetClaim(targetPath: string, owner: string): void {
    this.db.prepare(`DELETE FROM plugin_copy_claims WHERE target_path = ? AND owner_node_id = ?`).run(targetPath, owner);
  }

  /** BEGIN IMMEDIATE: the database's write lock for the whole unit, so no other projection (in this daemon or in another
   *  process using the same database) can claim, write or prune in between. Nested calls become savepoints. */
  withTargetLock<T>(_dir: string, fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }
}
