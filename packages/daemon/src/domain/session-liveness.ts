import type { SessionProbe, TmuxAdapter } from "../adapters/tmux.js";
import { isShellForeground } from "./shell-classifier.js";
import { listNativeProcesses, type NativeProcessLister } from "./native-process-lineage.js";

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
 * OF-259: the runtimes whose seat is an agent that runs under the seat's terminal. A seat of any other runtime is judged on its
 * terminal alone: `terminal` (operator-human) IS a shell, so a bare shell is that seat running, and a runtime the daemon does not
 * know is never judged empty.
 */
export const AGENT_SEAT_RUNTIMES: ReadonlySet<string> = new Set(["claude-code", "codex", "pi", "omp", "pda"]);

/**
 * What runs under a seat's terminal. `program`: a non-shell foreground, or any process descending from the terminal's own pid
 * (measured on a private hc 0.1.18 core: Claude run from the pane shell shows foreground `bash` with `claude` two levels down, and
 * Codex shows foreground `sh` AT the terminal's pid with `codex` as its child, so the foreground name alone cannot say; Pi and the
 * stub `exec`, so their foreground is the program itself). `empty_shell`: positive evidence of a shell and no descendant at all,
 * which is what an idle seat shell is, and what a kept terminal becomes once its program is lost (hc `keep`; a Herdr-restored
 * shell is the reported case). `unobservable`: any read that failed, the terminal's pid or the process listing missing; never
 * read as empty.
 */
export type SeatProgramEvidence = "program" | "empty_shell" | "unobservable";

export async function seatProgramEvidence(
  tmux: Pick<TmuxAdapter, "getPaneCommand" | "getPanePid">,
  sessionName: string,
  listProcesses: NativeProcessLister = listNativeProcesses,
): Promise<SeatProgramEvidence> {
  try {
    const command = (await tmux.getPaneCommand(sessionName))?.trim().toLowerCase() ?? "";
    if (command && !isShellForeground(command)) return "program";
    const panePid = await tmux.getPanePid(sessionName);
    if (!command || !panePid) return "unobservable";
    const rows = await listProcesses();
    const byPid = new Map(rows.map((row) => [row.pid, row]));
    if (!byPid.has(panePid)) return "unobservable";
    const descends = (pid: number, ppid: number): boolean => {
      const seen = new Set<number>([pid]);
      let parent: number | undefined = ppid;
      while (parent !== undefined && !seen.has(parent)) {
        if (parent === panePid) return true;
        seen.add(parent);
        parent = byPid.get(parent)?.ppid;
      }
      return false;
    };
    return rows.some((row) => row.pid !== panePid && descends(row.pid, row.ppid)) ? "program" : "empty_shell";
  } catch { return "unobservable"; }
}

/** OF-259: a seat of an agent runtime whose terminal is positively an empty shell is not running. Anything else (a terminal-runtime
 *  seat, an unknown runtime, an unreadable terminal) is not judged. */
export async function isEmptyAgentShell(
  tmux: Pick<TmuxAdapter, "getPaneCommand" | "getPanePid">,
  sessionName: string,
  runtime: string | null | undefined,
  listProcesses?: NativeProcessLister,
): Promise<boolean> {
  if (!runtime || !AGENT_SEAT_RUNTIMES.has(runtime)) return false;
  return (await seatProgramEvidence(tmux, sessionName, listProcesses)) === "empty_shell";
}

/** What decides a seat's liveness beyond its terminal's presence. */
export interface SeatLivenessContext {
  /** The seat's runtime (nodes.runtime); with it a present but empty agent shell reads `dead`. */
  runtimeOfSession?: (sessionName: string) => string | null | undefined;
  listProcesses?: NativeProcessLister;
  /** Told the name of each present terminal read as an empty agent shell, so a caller that ends it needs no second look at a terminal the host said was gone. */
  onEmptyShell?: (sessionName: string) => void;
}

/**
 * The ONE classification of a session's liveness for restore. The restore
 * orchestrator's live/stale/unknown buckets (classifyRunningSessions) and
 * restore-check's advice both call this, so a different reading of the same
 * tmux answer cannot drift between "what restore will do" and "what we advise".
 * OF-259: with a `context`, a terminal that is present but is only an empty shell of an agent seat reads `dead`: after a reboot
 * the terminal host restores the shell with its seat label, and that is not the seat running.
 */
export function classifySessionLiveness(
  tmux: Pick<TmuxAdapter, "probeSession" | "hostKind"> & Partial<Pick<TmuxAdapter, "getPaneCommand" | "getPanePid">>,
  sessionName: string,
  deadlineMs: number = SESSION_LIVENESS_DEADLINE_MS,
  context?: SeatLivenessContext,
): Promise<SessionLiveness> {
  return new Promise<SessionLiveness>((resolve) => {
    const timer = setTimeout(() => resolve("unreadable"), deadlineMs);
    // probeSession may throw synchronously (a test double, a bad adapter) as well as reject.
    Promise.resolve().then(async (): Promise<SessionLiveness> => {
      const presence = await probePresence(tmux, sessionName);
      if (presence !== "present") return presence === "absent" ? "dead" : "unreadable";
      const runtime = context?.runtimeOfSession?.(sessionName);
      if (tmux.getPaneCommand && tmux.getPanePid && await isEmptyAgentShell(tmux as Pick<TmuxAdapter, "getPaneCommand" | "getPanePid">, sessionName, runtime, context?.listProcesses)) { context?.onEmptyShell?.(sessionName); return "dead"; }
      return "live";
    }).then(
      (liveness) => { clearTimeout(timer); resolve(liveness); },
      () => { clearTimeout(timer); resolve("unreadable"); },
    );
  });
}
