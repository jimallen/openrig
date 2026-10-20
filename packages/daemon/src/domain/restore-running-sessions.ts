// OF-40 review (N2): the ONE reading of "would restore refuse this rig because a seat is still running", shared by
// restore (RestoreOrchestrator.restore -> rig_not_stopped) and restore-check (whether the next restore would run at
// all, so whether seat-gate predictions and snapshot blockers are what recovery should report).
//
// Restore reads EVERY session row of the rig whose raw DB status is `running` (not one row per seat, and not a status an
// identity verdict has relabelled) and asks tmux about each row's own session name. A live row refuses the restore, a
// row whose liveness cannot be read refuses it too (fail closed), and a dead row is stale and does not.
import type { SessionLiveness } from "./session-liveness.js";

export interface RunningSessionClassification {
  live: string[];
  stale: string[];
  unknown: string[];
}

/**
 * Classify ALL DB-running sessions against tmux reality without mutating the DB. Scans every session (not just
 * latest-per-node) to catch older live sessions behind newer detached rows. Probing stops at the first live or
 * unreadable session: either one already refuses the restore, and on a wedged tmux every further probe would cost another
 * full deadline. The buckets are therefore complete only when the restore may proceed (no live, no unknown).
 * A probe that throws fails closed: classified unknown so restore blocks.
 */
export async function classifyRunningSessions(
  sessions: ReadonlyArray<{ id: string; sessionName: string; status: string }>,
  probe: (sessionName: string) => Promise<SessionLiveness>,
): Promise<RunningSessionClassification> {
  const live: string[] = [];
  const stale: string[] = [];
  const unknown: string[] = [];

  for (const session of sessions) {
    if (session.status !== "running") continue;
    let liveness: SessionLiveness;
    try { liveness = await probe(session.sessionName); } catch { liveness = "unreadable"; }
    if (liveness === "live") { live.push(session.id); break; }
    else if (liveness === "dead") stale.push(session.id);
    else { unknown.push(session.id); break; }
  }

  return { live, stale, unknown };
}

/** Restore refuses the whole rig (`rig_not_stopped`, 409) when any running row is live or unreadable. */
export function restoreRefusesRig(classification: RunningSessionClassification): boolean {
  return classification.live.length > 0 || classification.unknown.length > 0;
}
