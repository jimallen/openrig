import type { TmuxAdapter } from "../adapters/tmux.js";

/**
 * What tmux says about one session, in the restore orchestrator's own terms.
 * `dead` includes "no tmux server / socket gone": no session can be live then,
 * and `rig up --existing` proceeds on exactly that reading. `unreadable` is only
 * a probe that THROWS (or, for callers that bound it, times out).
 */
export type SessionLiveness = "live" | "dead" | "unreadable";

/**
 * Per-probe deadline. tmux's exec has no timeout of its own, so a wedged tmux server would otherwise
 * leave `has-session` (and everything awaiting it: the polled status route, restore-check, restore)
 * pending forever. An answer that has not arrived by then is read as `unreadable`, never guessed.
 */
export const SESSION_LIVENESS_DEADLINE_MS = 2000;

/**
 * The ONE classification of a session's liveness for restore. The restore
 * orchestrator's live/stale/unknown buckets (classifyRunningSessions) and
 * restore-check's advice both call this, so a different reading of the same
 * tmux answer cannot drift between "what restore will do" and "what we advise".
 */
export function classifySessionLiveness(
  tmux: Pick<TmuxAdapter, "hasSession">,
  sessionName: string,
  deadlineMs: number = SESSION_LIVENESS_DEADLINE_MS,
): Promise<SessionLiveness> {
  return new Promise<SessionLiveness>((resolve) => {
    const timer = setTimeout(() => resolve("unreadable"), deadlineMs);
    // hasSession may throw synchronously (a test double, a bad adapter) as well as reject.
    Promise.resolve().then(() => tmux.hasSession(sessionName)).then(
      (present) => { clearTimeout(timer); resolve(present ? "live" : "dead"); },
      () => { clearTimeout(timer); resolve("unreadable"); },
    );
  });
}
