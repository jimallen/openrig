import path from "node:path";
import type Database from "better-sqlite3";

/**
 * Where a running Claude conversation's own files live (its `sessions/<pid>.json`, its `projects/` transcript): in the
 * Claude config home its process was LAUNCHED with, recorded on the session row (sessions.claude_config_dir, migration
 * 130). Not the seat's current choice: `rig seat set-claude-home` restarts nothing, so between the change and the next
 * launch the running process is still on the home it started on. A row with none ran on the daemon's own selection.
 */
export interface SeatClaudeHomeReaders {
  /** The home a session row was launched with, or null (the daemon's own selection). */
  launchedHomeOfSession(sessionId: string): string | null;
  /** The home a session's files are under: its launched home, else the daemon's own. */
  homeOfSession(sessionId: string): string;
  /** The home the seat's newest session was launched with, else the daemon's own (a seat with no session: the daemon's). */
  homeOfRunningNode(nodeId: string | null | undefined): string;
  /** Every `projects/` root a seat's conversation may be under besides the daemon's: each home a session was launched with
   *  and each seat's current choice, once each. */
  seatProjectsRoots(): string[];
}

export function seatClaudeHomeReaders(db: Database.Database, daemonHome: string): SeatClaudeHomeReaders {
  const has = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === "claude_config_dir");
  const sessionsHave = has("sessions");
  const nodesHave = has("nodes");
  const bySession = sessionsHave ? db.prepare("SELECT claude_config_dir AS dir FROM sessions WHERE id = ?") : null;
  const byNode = sessionsHave ? db.prepare("SELECT claude_config_dir AS dir FROM sessions WHERE node_id = ? ORDER BY rowid DESC LIMIT 1") : null;
  const homes = [
    ...(sessionsHave ? ["SELECT claude_config_dir AS dir FROM sessions WHERE claude_config_dir IS NOT NULL"] : []),
    ...(nodesHave ? ["SELECT claude_config_dir AS dir FROM nodes WHERE claude_config_dir IS NOT NULL"] : []),
  ];
  const allHomes = homes.length ? db.prepare(`SELECT DISTINCT dir FROM (${homes.join(" UNION ")}) ORDER BY dir`) : null;
  const launchedHomeOfSession = (sessionId: string): string | null =>
    (bySession?.get(sessionId) as { dir: string | null } | undefined)?.dir ?? null;
  return {
    launchedHomeOfSession,
    homeOfSession: (sessionId) => launchedHomeOfSession(sessionId) ?? daemonHome,
    homeOfRunningNode: (nodeId) => (nodeId ? (byNode?.get(nodeId) as { dir: string | null } | undefined)?.dir : null) ?? daemonHome,
    seatProjectsRoots: () => ((allHomes?.all() ?? []) as Array<{ dir: string }>).map((r) => path.join(r.dir, "projects")),
  };
}
