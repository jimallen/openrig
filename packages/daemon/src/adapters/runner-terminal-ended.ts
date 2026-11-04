import type { SessionProbe } from "./tmux.js";

/** The part of a seat host this reads. A fake with neither member (a unit test's minimal tmux) reads as "not an hc host". */
export interface TerminalEndedHost {
  hostKind?: "tmux" | "hc";
  probeSession?: (name: string) => Promise<SessionProbe>;
}

/** OF-200: on hc an agent is its terminal's own program, so the end of the agent (a runner, or a resumed Claude or Codex) IS the end of its terminal and
 *  readiness can no longer see "the pane is back at a shell". True only on positive evidence from an hc host (`absent`: the core answered and the terminal is
 *  finished or gone); an unreachable core, a tmux host, or a host that cannot be asked is false, so the caller keeps the answer it had. */
export async function runnerTerminalEnded(host: TerminalEndedHost, session: string): Promise<boolean> {
  if (host.hostKind !== "hc" || typeof host.probeSession !== "function") return false;
  // OF-205 (nit): no name is no evidence. An empty session name hashes to a terminal hc does not have, which probes as `absent`, so it would read as a
  // terminal that ended.
  if (!session.trim()) return false;
  try {
    return (await host.probeSession(session)).state === "absent";
  } catch {
    return false;
  }
}
