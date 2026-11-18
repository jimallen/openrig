// workspaces-o9o.172 — the TUI's world, as it holds it: a bounded digest of the FleetSnapshot every topology view is rendered from (tables,
// explorer, graph). Answered on the control socket's OBSERVE verb "view", so a scenario can compare the TUI with the daemon's `ps` and
// `queue` (ROUTING R-21). Pure: no IO, no daemon calls. A WHITELIST of names and status: whatever else a snapshot row carries (pane text,
// paths, previews, tokens) is never copied out.
import type { FleetSnapshot, LoadState } from "../types.js";

/** Every variable-length field is bounded (verify-qa2 review): each list and each string. With all of them at their caps a reply stays under
 *  1 MB (pinned). `truncated` is true whenever anything was cut. */
export const VIEW_DIGEST_LIMITS = { rigs: 500, agentsPerRig: 200, agents: 2000, hostsDown: 100, chars: 100 } as const;

export interface ViewDigestAgent { name: string; session?: string; status: string }
/** Whether the TUI holds this rig's seats: it reads them only when its page needs them ("not-loaded"), and a failed read is
 *  "unavailable". Measured on a real TUI: an unread rig sits in the snapshot with no pods, which must never read as "no agents". */
export type ViewDigestInventory = "read" | "not-loaded" | "unavailable";
/** agentCount is the rig's whole agent count in the snapshot, whatever the agent list's caps cut (compared with ps's nodeCount);
 *  null unless inventory is "read". */
export interface ViewDigestRig {
  host: string; name: string; id?: string; reachable: boolean; inventory: ViewDigestInventory; agentCount: number | null; agents: ViewDigestAgent[];
}
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
  const cap = (text: string): string => {
    if (text.length <= limits.chars) return text;
    truncated = true;
    return text.slice(0, limits.chars);
  };
  for (const host of snapshot.hosts) {
    for (const rig of host.rigs) {
      totalRigs++;
      const agents: ViewDigestAgent[] = [];
      let agentCount = 0;
      for (const pod of rig.pods) {
        for (const agent of pod.agents) {
          totalAgents++; agentCount++;
          if (agents.length >= limits.agentsPerRig || keptAgents >= limits.agents) { truncated = true; continue; }
          agents.push({ name: cap(agent.name), ...(agent.session ? { session: cap(agent.session) } : {}), status: cap(agent.status) });
          keptAgents++;
        }
      }
      if (rigs.length >= limits.rigs) { truncated = true; continue; }
      const inventory: ViewDigestInventory = rig.inventoryNotLoaded ? "not-loaded" : rig.inventoryUnavailable ? "unavailable" : "read";
      rigs.push({
        host: cap(host.name), name: cap(rig.name), ...(rig.id ? { id: cap(rig.id) } : {}), reachable: host.reachable,
        inventory, agentCount: inventory === "read" ? agentCount : null, agents,
      });
    }
  }
  if (snapshot.hostsDown.length > limits.hostsDown) truncated = true;
  return {
    readAt: typeof load?.lastSuccessAt === "number" ? new Date(load.lastSuccessAt).toISOString() : null,
    stale: load?.stale === true,
    settled: load?.settled === true,
    rigs,
    hostsDown: snapshot.hostsDown.slice(0, limits.hostsDown).map((h) => cap(h.hostId)),
    counts: { rigs: totalRigs, agents: totalAgents },
    truncated,
  };
}
