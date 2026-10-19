import type { TmuxAdapter } from "../adapters/tmux.js";

/**
 * What tmux says about one session, in the restore orchestrator's own terms.
 * `dead` includes "no tmux server / socket gone": no session can be live then,
 * and `rig up --existing` proceeds on exactly that reading. `unreadable` is only
 * a probe that THROWS (or, for callers that bound it, times out).
 */
export type SessionLiveness = "live" | "dead" | "unreadable";

/**
 * The ONE classification of a session's liveness for restore. The restore
 * orchestrator's live/stale/unknown buckets (classifyRunningSessions) and
 * restore-check's advice both call this, so a different reading of the same
 * tmux answer cannot drift between "what restore will do" and "what we advise".
 */
export async function classifySessionLiveness(
  tmux: Pick<TmuxAdapter, "hasSession">,
  sessionName: string,
): Promise<SessionLiveness> {
  try {
    return (await tmux.hasSession(sessionName)) ? "live" : "dead";
  } catch {
    return "unreadable";
  }
}
