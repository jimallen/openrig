import type { SessionProbe, TmuxAdapter } from "../adapters/tmux.js";

/**
 * What a seat host said about one session, for a caller that DECIDES on it (launch, refuse, adopt, mark detached).
 * `unknown` is the host not answering. It is never `absent`: OF-177, an unreachable core never reads as a seat that is gone.
 */
export type SessionPresence = "present" | "absent" | "unknown";

/**
 * The classified probe, read as a decision needs it. On hc an unreachable core is `transport_unavailable`: the holder keeps
 * every program alive through a core outage, so the seat may well be running and the answer is `unknown`. tmux's own
 * `transport_unavailable` is "no server / socket gone", where no session can be live, and has always read as `absent` (restore's
 * `rig up --existing` proceeds on it). A probe that throws is not an answer either, and propagates to the caller's own handling.
 */
export function presenceFromProbe(tmux: Pick<TmuxAdapter, "hostKind">, probe: SessionProbe): SessionPresence {
  if (probe.state === "transport_unavailable") return tmux.hostKind === "hc" ? "unknown" : "absent";
  return probe.state;
}

export async function probePresence(tmux: Pick<TmuxAdapter, "probeSession" | "hostKind">, sessionName: string): Promise<SessionPresence> {
  return presenceFromProbe(tmux, await tmux.probeSession(sessionName));
}

/**
 * What the seat host says about one session, in the restore orchestrator's own terms.
 * `dead` includes tmux's "no tmux server / socket gone": no session can be live then,
 * and `rig up --existing` proceeds on exactly that reading. `unreadable` is a probe that THROWS (or, for callers that
 * bound it, times out), and on hc a core that does not answer: its seats may be running (see presenceFromProbe).
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
  tmux: Pick<TmuxAdapter, "probeSession" | "hostKind">,
  sessionName: string,
  deadlineMs: number = SESSION_LIVENESS_DEADLINE_MS,
): Promise<SessionLiveness> {
  return new Promise<SessionLiveness>((resolve) => {
    const timer = setTimeout(() => resolve("unreadable"), deadlineMs);
    // probeSession may throw synchronously (a test double, a bad adapter) as well as reject.
    Promise.resolve().then(() => probePresence(tmux, sessionName)).then(
      (presence) => { clearTimeout(timer); resolve(presence === "present" ? "live" : presence === "absent" ? "dead" : "unreadable"); },
      () => { clearTimeout(timer); resolve("unreadable"); },
    );
  });
}
