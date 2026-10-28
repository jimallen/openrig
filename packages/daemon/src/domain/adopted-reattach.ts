import type Database from "better-sqlite3";

/** An adopted session the shared rule found, and whether another seat holds a session of the same tmux name. */
export type AdoptedSessionLeftRunning =
  | { kind: "reattach"; sessionId: string; sessionName: string }
  | { kind: "contested"; sessionId: string; sessionName: string; heldBy: { sessionId: string; seat: string } };

/**
 * OF-155 (Jim, 2026-10-28): rig down leaves a seat's adopted (`claimed`) session running. It ends the ROW only: the row is
 * `detached` with no stop intent, and the seat's binding still names the session. `rig up --existing` brings such a seat
 * back by reattaching that session (option A), never by starting a second process on its conversation.
 *
 * The ONE reading of "this seat has an adopted session rig down left running", shared by restore (which reattaches it) and
 * restore-check (which predicts it), so the check cannot disagree with restore. Liveness and identity are tmux questions
 * (probeAdoptedSession below). `rig unclaim` clears the binding, so a released session is not reattached.
 */
export function reattachableAdoptedSession(db: Database.Database, nodeId: string): AdoptedSessionLeftRunning | null {
  const latest = db.prepare(
    "SELECT id, session_name, status, origin, intentionally_stopped FROM sessions WHERE node_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
  ).get(nodeId) as { id: string; session_name: string; status: string; origin: string | null; intentionally_stopped: number } | undefined;
  if (!latest || latest.origin !== "claimed" || latest.status !== "detached" || latest.intentionally_stopped) return null;
  const binding = db.prepare("SELECT tmux_session FROM bindings WHERE node_id = ?").get(nodeId) as { tmux_session: string | null } | undefined;
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
  return { kind: "reattach", sessionId: latest.id, sessionName: latest.session_name };
}

/**
 * a2 (review F1, F2, F5 of b94822a4): which tmux session is the one rig down left is told by the OpenRig marker every claim
 * writes into the adopted session (`@rigged_node_id`, claim-service setRiggedMetadata; self-attach and a discovered
 * handover successor write it too), never by pane id. A session option is read the same for any window layout, and a session
 * the person recreated under the same name does not carry it, on this tmux server or a fresh one (where pane ids restart at
 * %0). `rig unclaim` blanks it. Unset or unreadable is `unknown`: never a match.
 */
export const ADOPTED_MARKER_OPTION = "@rigged_node_id";

export type SessionOptionRead = { ok: true; value: string | null } | { ok: false; error: string };

export type AdoptedIdentityCheck =
  | { kind: "same" }
  | { kind: "replaced"; marker: string }
  | { kind: "unknown"; why: string };

export async function checkAdoptedIdentity(
  nodeId: string,
  sessionName: string,
  readSessionOption: (session: string, key: string) => Promise<SessionOptionRead>,
): Promise<AdoptedIdentityCheck> {
  let read: SessionOptionRead;
  try {
    read = await readSessionOption(sessionName, ADOPTED_MARKER_OPTION);
  } catch (err) {
    read = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (!read.ok) return { kind: "unknown", why: `its OpenRig marker (${ADOPTED_MARKER_OPTION}) could not be read: ${read.error}` };
  if (!read.value) return { kind: "unknown", why: `it carries no OpenRig marker (${ADOPTED_MARKER_OPTION}): it may have been recreated since rig down, or the marker was never written` };
  return read.value === nodeId ? { kind: "same" } : { kind: "replaced", marker: read.value };
}

/** The adopted session rig down left running, as restore finds it at apply time: the shared rule (DB), then tmux. */
export type AdoptedSessionProbe =
  | { kind: "none" }
  | { kind: "gone" }
  | { kind: "live"; sessionId: string; sessionName: string }
  | { kind: "unknown"; sessionId: string; sessionName: string; why?: string }
  | { kind: "replaced"; sessionId: string; sessionName: string; marker: string }
  | { kind: "contested"; sessionId: string; sessionName: string; heldBy: { sessionId: string; seat: string } };

/** The one probe restore, its plan and its forecasts run, so none of them can say "reattach" for a seat restore refuses.
 *  `contested` is decided before tmux is asked. No tmux to ask is `unknown`. Read-only. */
export async function probeAdoptedSession(
  db: Database.Database,
  nodeId: string,
  tmux: { hasSession(name: string): Promise<boolean>; readSessionOption(session: string, key: string): Promise<SessionOptionRead> } | null | undefined,
): Promise<AdoptedSessionProbe> {
  const adopted = reattachableAdoptedSession(db, nodeId);
  if (!adopted) return { kind: "none" };
  if (adopted.kind === "contested") return adopted;
  const { sessionId, sessionName } = adopted;
  if (!tmux) return { kind: "unknown", sessionId, sessionName, why: "tmux is not available to this check" };
  let alive: boolean;
  try {
    alive = await tmux.hasSession(sessionName);
  } catch {
    return { kind: "unknown", sessionId, sessionName };
  }
  if (!alive) return { kind: "gone" };
  const identity = await checkAdoptedIdentity(nodeId, sessionName, (session, key) => tmux.readSessionOption(session, key));
  if (identity.kind === "replaced") return { kind: "replaced", sessionId, sessionName, marker: identity.marker };
  if (identity.kind === "unknown") return { kind: "unknown", sessionId, sessionName, why: identity.why };
  return { kind: "live", sessionId, sessionName };
}

/** a2: best-effort, write the OpenRig marker into a session the person started that a seat adopts (claim-service does it in
 *  setRiggedMetadata). A failed write leaves the marker unset, which restore later reads as unknown, never as a match. */
export async function writeAdoptedMarker(tmux: { setSessionOption(session: string, key: string, value: string): Promise<unknown> } | null | undefined, sessionName: string, nodeId: string): Promise<void> {
  if (!tmux) return;
  try {
    await tmux.setSessionOption(sessionName, ADOPTED_MARKER_OPTION, nodeId);
  } catch { /* best-effort */ }
}

/** Restore's words for a live adopted session marked as another seat's (kind `replaced`). */
export function replacedAdoptedSessionReason(adopted: { sessionId: string; sessionName: string }, marker: string): string {
  return `its adopted session '${adopted.sessionName}', which rig down left running, is live, but it is marked as another seat's (${ADOPTED_MARKER_OPTION}=${marker}), so it is not the session rig down left: restore neither reattaches it nor starts this seat. Release it from this seat with rig unclaim ${adopted.sessionId}`;
}

/** Restore's words for an adopted session it cannot tell (kind `unknown`): tmux did not answer, or the session is live but
 *  its marker is unset or unreadable. */
export function unknownAdoptedSessionReason(adopted: { sessionId: string; sessionName: string; why?: string }): string {
  return adopted.why
    ? `its adopted session '${adopted.sessionName}', which rig down left running, is live, but it could not be told to be the session rig down left (${adopted.why}), so restore neither reattaches it nor starts a second session. Retry once tmux answers; if the session was recreated, release the seat with rig unclaim ${adopted.sessionId}`
    : `its adopted session '${adopted.sessionName}', which rig down left running, could not be checked in tmux, so restore neither reattached it nor started a second session`;
}

/** z2 review F5: restore's words for a seat whose adopted session another seat's live row also names (kind `contested`). */
export function contestedAdoptedSessionReason(adopted: { sessionId: string; sessionName: string; heldBy: { sessionId: string; seat: string } }): string {
  return `its adopted session '${adopted.sessionName}', which rig down left running, is also the live session of seat ${adopted.heldBy.seat} (row ${adopted.heldBy.sessionId}), so a tmux session of that name may not be the one rig down left: restore neither reattaches it nor starts this seat. Release it from this seat with rig unclaim ${adopted.sessionId}, or end the other seat's row first`;
}
