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
 * node id(s), marking archived rigs. The ids are what tell two same-named rigs apart. `rig send`
 * and transcripts have no node-id selector, and `--rig` matches by name, so the advice is about
 * which rig keeps answering: all-live candidates -> stop then archive the unwanted one; all-archived
 * candidates -> unarchive the wanted one (nothing is left to archive).
 */
export function describeAmbiguousSessionName(db: Database.Database, sessionName: string, matches: SessionNameMatch[]): string {
  const hasArchive = (db.prepare("PRAGMA table_info(rigs)").all() as Array<{ name: string }>)
    .some((column) => column.name === "archived_at");
  const rigRow = db.prepare(`SELECT name${hasArchive ? ", archived_at" : ""} FROM rigs WHERE id = ?`);
  let archivedCount = 0;
  const candidates = distinctRigIds(matches).map((rigId) => {
    const row = rigRow.get(rigId) as { name: string; archived_at?: string | null } | undefined;
    const archived = row?.archived_at != null;
    if (archived) archivedCount++;
    const nodeIds = Array.from(new Set(matches.filter((match) => match.rig_id === rigId).map((match) => match.node_id)));
    return `${row?.name ?? "?"} (rig ${rigId}, node ${nodeIds.join(", ")}${archived ? ", archived" : ""})`;
  });
  // Live rigs answer before archived ones, so the candidates are all live or all archived.
  const advice = archivedCount === candidates.length
    ? "Rig names may be identical, so tell them apart by rig id. Every candidate is already archived; "
      + "unarchive the one that should answer with: rig unarchive <rigId> (a live rig answers before archived ones)."
    // `rig archive` refuses a running or degraded rig (409) unless --force (routes/rigs.ts).
    : "Rig names may be identical, so tell them apart by rig id. To resolve it, stop the rig that should not answer with: "
      + "rig down <rigId>, then archive it with: rig archive <rigId> (or archive a running rig directly with: rig archive <rigId> --force).";
  return `Session '${sessionName}' is ambiguous — found in rigs: ${candidates.join("; ")}. ${advice}`;
}
