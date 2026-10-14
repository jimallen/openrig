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
 * The distinct RIGS (by rig id, never by rig name) that answer a session name. Two live rigs may
 * share a rig name, so counting names would fold them into one and silently pick a rig.
 */
export function distinctRigIds(matches: SessionNameMatch[]): string[] {
  return Array.from(new Set(matches.map((match) => match.rig_id)));
}

/**
 * The text that names every candidate of an ambiguous session name: each rig's name, rig id and
 * node id(s). The ids are what tell two same-named rigs apart. `rig send` and transcripts have no
 * node-id selector, and `--rig` matches by name, so the way out is to archive the rig that should
 * not answer (reversible) - the message says so.
 */
export function describeAmbiguousSessionName(db: Database.Database, sessionName: string, matches: SessionNameMatch[]): string {
  const rigName = db.prepare("SELECT name FROM rigs WHERE id = ?");
  const candidates = distinctRigIds(matches).map((rigId) => {
    const name = (rigName.get(rigId) as { name: string } | undefined)?.name ?? "?";
    const nodeIds = Array.from(new Set(matches.filter((match) => match.rig_id === rigId).map((match) => match.node_id)));
    return `${name} (rig ${rigId}, node ${nodeIds.join(", ")})`;
  });
  return `Session '${sessionName}' is ambiguous — found in rigs: ${candidates.join("; ")}. `
    + "Rig names may be identical, so tell them apart by rig id; archive the one that should not answer with: rig archive <rigId>.";
}
