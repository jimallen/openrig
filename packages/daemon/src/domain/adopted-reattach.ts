import type Database from "better-sqlite3";

/** An adopted session the shared rule found, and whether another seat holds a session of the same tmux name. */
export type AdoptedSessionLeftRunning =
  | { kind: "reattach"; sessionId: string; sessionName: string; boundPane: string | null }
  | { kind: "contested"; sessionId: string; sessionName: string; heldBy: { sessionId: string; seat: string } };

/**
 * OF-155 (Jim, 2026-10-28): rig down leaves a seat's adopted (`claimed`) session running. It ends the ROW only: the row is
 * `detached` with no stop intent, and the seat's binding still names the session. `rig up --existing` brings such a seat
 * back by reattaching that session (option A), never by starting a second process on its conversation.
 *
 * The ONE reading of "this seat has an adopted session rig down left running", shared by restore (which reattaches it) and
 * restore-check (which predicts it), so the check cannot disagree with restore. Liveness is the caller's: it is a tmux
 * question. `rig unclaim` clears the binding, so a released session is not reattached.
 */
export function reattachableAdoptedSession(db: Database.Database, nodeId: string): AdoptedSessionLeftRunning | null {
  const latest = db.prepare(
    "SELECT id, session_name, status, origin, intentionally_stopped FROM sessions WHERE node_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
  ).get(nodeId) as { id: string; session_name: string; status: string; origin: string | null; intentionally_stopped: number } | undefined;
  if (!latest || latest.origin !== "claimed" || latest.status !== "detached" || latest.intentionally_stopped) return null;
  const binding = db.prepare("SELECT tmux_session, tmux_pane FROM bindings WHERE node_id = ?").get(nodeId) as { tmux_session: string | null; tmux_pane: string | null } | undefined;
  if (binding?.tmux_session !== latest.session_name) return null;
  // z2 review F5: tmux names a session by name alone, host-wide. When another seat (of this rig or another) has a live
  // row of the same name, a live tmux session of that name may be that seat's, not the one rig down left: reattaching it
  // would bind two seats to one session. Restore refuses such a seat and starts nothing; the plan and the check say so.
  const holder = db.prepare(
    `SELECT s.id, n.logical_id, r.name AS rig_name FROM sessions s JOIN nodes n ON n.id = s.node_id JOIN rigs r ON r.id = n.rig_id
     WHERE s.session_name = ? AND s.node_id != ? AND s.status IN ('running', 'idle', 'unknown')
     ORDER BY s.created_at DESC, s.id DESC LIMIT 1`,
  ).get(latest.session_name, nodeId) as { id: string; logical_id: string; rig_name: string } | undefined;
  if (holder) {
    return { kind: "contested", sessionId: latest.id, sessionName: latest.session_name, heldBy: { sessionId: holder.id, seat: `${holder.logical_id}@${holder.rig_name}` } };
  }
  return { kind: "reattach", sessionId: latest.id, sessionName: latest.session_name, boundPane: binding.tmux_pane };
}

/** Whether a live tmux session of the adopted session's name is the one rig down left: the pane the seat's binding names
 *  is one of its panes. tmux pane ids are unique for the server's life, so a session the person recreated under the same
 *  name has other panes. `unknown` when no pane is recorded or tmux does not list the session's panes: never a match. */
export type AdoptedPaneCheck =
  | { kind: "same" }
  | { kind: "replaced"; boundPane: string; panes: string[] }
  | { kind: "unknown"; why: string };

export async function checkAdoptedPane(
  adopted: { sessionName: string; boundPane: string | null },
  listPanes: (target: string) => Promise<Array<{ id: string }>>,
): Promise<AdoptedPaneCheck> {
  if (!adopted.boundPane) return { kind: "unknown", why: "the seat's binding records no pane for it" };
  let panes: string[];
  try {
    panes = (await listPanes(adopted.sessionName)).map((pane) => pane.id);
  } catch (err) {
    return { kind: "unknown", why: `its panes could not be read (${err instanceof Error ? err.message : String(err)})` };
  }
  if (panes.length === 0) return { kind: "unknown", why: "tmux listed no pane for it" };
  return panes.includes(adopted.boundPane) ? { kind: "same" } : { kind: "replaced", boundPane: adopted.boundPane, panes };
}

/** Restore's words for a seat whose adopted session is live but not in the pane its binding names (kind `replaced`). */
export function replacedAdoptedSessionReason(adopted: { sessionId: string; sessionName: string }, pane: { boundPane: string; panes: string[] }): string {
  return `its adopted session '${adopted.sessionName}', which rig down left running, is live, but the seat's binding names pane ${pane.boundPane}, which is not one of that session's panes (${pane.panes.join(", ")}): the session may have been recreated since rig down, so restore neither reattaches it nor starts this seat. If it is the same conversation, release it with rig unclaim ${adopted.sessionId} and claim it again; otherwise end it`;
}

/** z2 review F5: restore's words for a seat whose adopted session another seat's live row also names (kind `contested`). */
export function contestedAdoptedSessionReason(adopted: { sessionId: string; sessionName: string; heldBy: { sessionId: string; seat: string } }): string {
  return `its adopted session '${adopted.sessionName}', which rig down left running, is also the live session of seat ${adopted.heldBy.seat} (row ${adopted.heldBy.sessionId}), so a tmux session of that name may not be the one rig down left: restore neither reattaches it nor starts this seat. Release it from this seat with rig unclaim ${adopted.sessionId}, or end the other seat's row first`;
}
