// workspaces-o9o.172 — the TUI's world, as it holds it: a bounded digest of the FleetSnapshot every topology view is rendered from (tables,
// explorer, graph). Answered on the control socket's OBSERVE verb "view", so a scenario can compare the TUI with the daemon's `ps` and
// `queue` (ROUTING R-21). Pure: no IO, no daemon calls. A WHITELIST of names and status: whatever else a snapshot row carries (pane text,
// paths, previews, tokens) is never copied out.
import type { FleetSnapshot, LoadState } from "../types.js";

export const VIEW_DIGEST_LIMITS = { rigs: 500, agentsPerRig: 200, agents: 5000 } as const;

export interface ViewDigestAgent { name: string; session?: string; status: string }
export interface ViewDigestRig { host: string; name: string; id?: string; reachable: boolean; agents: ViewDigestAgent[] }
export interface ViewDigest {
  /** When the TUI last confirmed its read of the daemon (ISO), null before the first. */
  readAt: string | null;
  /** The read is known out of date (a change since, or contact lost). */
  stale: boolean;
  /** A first read has completed. */
  settled: boolean;
  rigs: ViewDigestRig[];
  /** Hosts the TUI could not read, by id. */
  hostsDown: string[];
  /** Totals of the whole snapshot, whatever the limits cut. */
  counts: { rigs: number; agents: number };
  truncated: boolean;
}

export function describeView(input: { snapshot: FleetSnapshot; load: LoadState | null }, limits = VIEW_DIGEST_LIMITS): ViewDigest {
  const { snapshot, load } = input;
  const rigs: ViewDigestRig[] = [];
  let totalRigs = 0, totalAgents = 0, keptAgents = 0, truncated = false;
  for (const host of snapshot.hosts) {
    for (const rig of host.rigs) {
      totalRigs++;
      const agents: ViewDigestAgent[] = [];
      for (const pod of rig.pods) {
        for (const agent of pod.agents) {
          totalAgents++;
          if (agents.length >= limits.agentsPerRig || keptAgents >= limits.agents) { truncated = true; continue; }
          agents.push({ name: agent.name, ...(agent.session ? { session: agent.session } : {}), status: agent.status });
          keptAgents++;
        }
      }
      if (rigs.length >= limits.rigs) { truncated = true; continue; }
      rigs.push({ host: host.name, name: rig.name, ...(rig.id ? { id: rig.id } : {}), reachable: host.reachable, agents });
    }
  }
  return {
    readAt: typeof load?.lastSuccessAt === "number" ? new Date(load.lastSuccessAt).toISOString() : null,
    stale: load?.stale === true,
    settled: load?.settled === true,
    rigs,
    hostsDown: snapshot.hostsDown.map((h) => h.hostId),
    counts: { rigs: totalRigs, agents: totalAgents },
    truncated,
  };
}
