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

/**
 * The node a tmux session name is bound to, live rig before archived. An archived rig keeps its
 * `bindings` rows, so a bare `WHERE tmux_session = ?` can land on the archived predecessor of a
 * recreated rig. Among rows of equal archive state the newest binding wins, so the answer is
 * deterministic. Without topology tables there is no archive flag to honour and the newest binding answers.
 */
export function findBindingNodeLiveFirst(db: Database.Database, tmuxSession: string): string | null {
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('rigs', 'nodes')").all() as Array<{ name: string }>).map((t) => t.name));
  const hasArchive = tables.has("rigs") && tables.has("nodes")
    && (db.prepare("PRAGMA table_info(rigs)").all() as Array<{ name: string }>).some((column) => column.name === "archived_at");
  const row = (hasArchive
    ? db.prepare(`
        SELECT b.node_id AS node_id
        FROM bindings b
        JOIN nodes n ON n.id = b.node_id
        JOIN rigs r ON r.id = n.rig_id
        WHERE b.tmux_session = ?
        ORDER BY (r.archived_at IS NOT NULL) ASC, b.id DESC
        LIMIT 1
      `)
    : db.prepare("SELECT node_id FROM bindings WHERE tmux_session = ? ORDER BY id DESC LIMIT 1")
  ).get(tmuxSession) as { node_id: string } | undefined;
  return row?.node_id ?? null;
}

/**
 * Whether the seat that answers a session name is running: the live-first newest row's status, not
 * "any row with that name is running". An archived rig's stale `running` row must not vouch for a
 * recreated live seat that has stopped.
 */
export function isSessionNameRunning(db: Database.Database, sessionName: string): boolean {
  const latest = findLatestSessionNameMatch(db, sessionName);
  if (!latest) return false;
  const row = db.prepare("SELECT status FROM sessions WHERE id = ?").get(latest.id) as { status: string } | undefined;
  return row?.status === "running";
}

/**
 * The seat name when the seat that answers it is running, else null. The oversight seat probe
 * (startup.ts) is this, lifted out of the model-divergence monitor's dependency bag so it can be
 * tested: `createDaemon` does not expose that bag.
 */
export function resolveRunningSeat(db: Database.Database, seatName: string): string | null {
  return isSessionNameRunning(db, seatName) ? seatName : null;
}

/**
 * The nodes a canonical `<seat>@<rig>` name composes to (rig name + dash-form logical id), each marked
 * `archived`, so a caller can let archived nodes count only when no live node has the identity. Rig
 * names are not unique, and an archived rig keeps its nodes and bindings. Without an archive column
 * nothing is archived. Throws when `rigs`/`nodes` are absent, like the join it replaces; the caller
 * decides how to fail.
 */
export function findComposedSeatNodes(db: Database.Database, rigName: string, seat: string): Array<{ node_id: string; archived: boolean }> {
  const hasArchive = (db.prepare("PRAGMA table_info(rigs)").all() as Array<{ name: string }>).some((column) => column.name === "archived_at");
  const rows = db.prepare(`
    SELECT n.id AS node_id, ${hasArchive ? "(r.archived_at IS NOT NULL)" : "0"} AS archived
      FROM nodes n JOIN rigs r ON r.id = n.rig_id
     WHERE r.name = ? AND REPLACE(n.logical_id, '.', '-') = ?
  `).all(rigName, seat) as Array<{ node_id: string; archived: number }>;
  return rows.map((row) => ({ node_id: row.node_id, archived: row.archived === 1 }));
}

/** Whether a node belongs to an archived rig. A schema without topology/archive columns has none. */
export function isNodeInArchivedRig(db: Database.Database, nodeId: string): boolean {
  const hasArchive = (db.prepare("PRAGMA table_info(rigs)").all() as Array<{ name: string }>).some((column) => column.name === "archived_at");
  if (!hasArchive) return false;
  const row = db.prepare("SELECT r.archived_at AS archived_at FROM nodes n JOIN rigs r ON r.id = n.rig_id WHERE n.id = ?").get(nodeId) as { archived_at: string | null } | undefined;
  return row?.archived_at != null;
}
