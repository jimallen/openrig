import type Database from "better-sqlite3";
import type { Rig } from "./types.js";

/**
 * OF-135: a rig named in a command — `rig up <rig> --existing`, the `<rig>` of a `<seat>@<rig>` ref — is a rig id or a rig
 * name. Rig names are not unique; ids are. The precedence is the CLI's (cli/src/rig-handle.ts, used by `rig down`,
 * `rig add` and `rig spec-source`): an exact id first, across every rig including archived ones, then a name.
 */
export interface RigRefLookup {
  findRigById(id: string): { rig: Rig; archived: boolean } | null;
  findUnarchivedRigsByName(name: string): Rig[];
}

/** The rigs a seat ref's rig part names: the rig with that id (none if it is archived: seat refs never reach an archived
 *  rig, by id or by name), else the unarchived rigs with that name (two or more is the caller's ambiguity, as before). */
export function seatRefRigs(rigs: RigRefLookup, ref: string): Rig[] {
  const byId = rigs.findRigById(ref);
  if (byId) return byId.archived ? [] : [byId.rig];
  return rigs.findUnarchivedRigsByName(ref);
}

/**
 * What advice should print for a rig in `rig up <rig> --existing` or `<seat>@<rig>`: its name while that name reaches it
 * and only it, else its id (OF-135; the rule `rig down` advice already follows, OF-123). The name reaches it when no rig has
 * the name as its id (an id wins) and this rig is the one unarchived rig with that name. Unreadable state gives the id,
 * which is always exact. Not quoted: callers quote for the shell.
 */
export function rigAdviceHandle(rigs: RigRefLookup, rigId: string, rigName: string): string {
  try {
    if (rigs.findRigById(rigName)) return rigId;
    const named = rigs.findUnarchivedRigsByName(rigName);
    return named.length === 1 && named[0]!.id === rigId ? rigName : rigId;
  } catch {
    return rigId;
  }
}

/** The same lookup read straight from the `rigs` table, for advice built where only the database is at hand. A database
 *  without `archived_at` (before migration 042) has no archived rigs. */
export function dbRigLookup(db: Database.Database): RigRefLookup {
  const archivedColumn = () => db.prepare("SELECT 1 FROM pragma_table_info('rigs') WHERE name = 'archived_at'").get() !== undefined;
  const toRig = (row: { id: string; name: string; created_at: string; updated_at: string }): Rig =>
    ({ id: row.id, name: row.name, createdAt: row.created_at, updatedAt: row.updated_at });
  return {
    findRigById: (id) => {
      const archived = archivedColumn();
      const row = db.prepare(`SELECT id, name, created_at, updated_at${archived ? ", archived_at" : ""} FROM rigs WHERE id = ?`).get(id) as
        { id: string; name: string; created_at: string; updated_at: string; archived_at?: string | null } | undefined;
      return row ? { rig: toRig(row), archived: archived && row.archived_at != null } : null;
    },
    findUnarchivedRigsByName: (name) => (db.prepare(
      `SELECT id, name, created_at, updated_at FROM rigs WHERE name = ?${archivedColumn() ? " AND archived_at IS NULL" : ""} ORDER BY created_at`,
    ).all(name) as Array<{ id: string; name: string; created_at: string; updated_at: string }>).map(toRig),
  };
}

/** rigAdviceHandle over the database. */
export function rigAdviceHandleIn(db: Database.Database, rigId: string, rigName: string): string {
  return rigAdviceHandle(dbRigLookup(db), rigId, rigName);
}
