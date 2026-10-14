import type Database from "better-sqlite3";
import { findSessionNameMatches, type SessionNameMatch } from "./session-name-matches.js";

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
