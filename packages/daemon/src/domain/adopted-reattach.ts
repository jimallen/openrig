import type Database from "better-sqlite3";

/**
 * OF-155 (Jim, 2026-10-28): rig down leaves a seat's adopted (`claimed`) session running. It ends the ROW only: the row is
 * `detached` with no stop intent, and the seat's binding still names the session. `rig up --existing` brings such a seat
 * back by reattaching that session (option A), never by starting a second process on its conversation.
 *
 * The ONE reading of "this seat has an adopted session rig down left running", shared by restore (which reattaches it) and
 * restore-check (which predicts it), so the check cannot disagree with restore. Liveness is the caller's: it is a tmux
 * question. `rig unclaim` clears the binding, so a released session is not reattached.
 */
export function reattachableAdoptedSession(db: Database.Database, nodeId: string): { sessionId: string; sessionName: string } | null {
  const latest = db.prepare(
    "SELECT id, session_name, status, origin, intentionally_stopped FROM sessions WHERE node_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
  ).get(nodeId) as { id: string; session_name: string; status: string; origin: string | null; intentionally_stopped: number } | undefined;
  if (!latest || latest.origin !== "claimed" || latest.status !== "detached" || latest.intentionally_stopped) return null;
  const binding = db.prepare("SELECT tmux_session FROM bindings WHERE node_id = ?").get(nodeId) as { tmux_session: string | null } | undefined;
  if (binding?.tmux_session !== latest.session_name) return null;
  return { sessionId: latest.id, sessionName: latest.session_name };
}
