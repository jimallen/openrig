import type Database from "better-sqlite3";
import { archiveWhereClause } from "./rig-repository.js";

export interface SessionNameMatch {
  id: string;
  node_id: string;
  session_name: string;
  rig_id: string;
}

/**
 * The session rows that answer a session name, newest first. A live rig answers before an archived
 * one: an archived rig keeps its session rows, so a rig restarted fresh with the same seat names
 * would otherwise collide with its own archived predecessor. Archived rigs answer only when no live
 * rig has the name. This is the one place that rule lives; whoami, `rig send` and transcripts all
 * resolve a session name through it so they cannot drift apart.
 */
export function findSessionNameMatches(db: Database.Database, sessionName: string): SessionNameMatch[] {
  const hasArchive = (db.prepare("PRAGMA table_info(rigs)").all() as Array<{ name: string }>)
    .some((column) => column.name === "archived_at");
  const matchesWhere = (cond: string | null): SessionNameMatch[] => db
    .prepare(`
      SELECT s.id AS id, s.node_id AS node_id, s.session_name AS session_name, n.rig_id AS rig_id
      FROM sessions s
      JOIN nodes n ON n.id = s.node_id
      JOIN rigs r ON r.id = n.rig_id
      WHERE s.session_name = ?${cond ? ` AND ${cond}` : ""}
      ORDER BY s.id DESC
    `)
    .all(sessionName) as SessionNameMatch[];

  // A database from before the archive migration has no archived rigs to set aside.
  if (!hasArchive) return matchesWhere(null);
  const live = matchesWhere(archiveWhereClause("r.archived_at"));
  return live.length > 0 ? live : matchesWhere(archiveWhereClause("r.archived_at", { archivedOnly: true }));
}

/**
 * The single session row that answers a session name: the newest row of a live rig, or, when no
 * live rig has the name, the newest row of an archived one. Every name-keyed "latest row" pick
 * (`ORDER BY id DESC LIMIT 1`) goes through this so a recreated rig with the same seat names can
 * never resolve to its archived predecessor. Callers that need more columns than
 * {@link SessionNameMatch} carries read them by `id`.
 */
export function findLatestSessionNameMatch(db: Database.Database, sessionName: string): SessionNameMatch | null {
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('rigs', 'nodes')").all() as Array<{ name: string }>).map((t) => t.name));
  if (tables.has("rigs") && tables.has("nodes")) return findSessionNameMatches(db, sessionName)[0] ?? null;
  // A partial schema (no topology tables to carry an archive flag) has nothing to set aside: newest row wins,
  // as these lookups behaved before they became archive-aware.
  const row = db
    .prepare("SELECT id, node_id, session_name FROM sessions WHERE session_name = ? ORDER BY id DESC LIMIT 1")
    .get(sessionName) as { id: string; node_id: string; session_name: string } | undefined;
  return row ? { ...row, rig_id: "" } : null;
}
