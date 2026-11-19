// workspaces-o9o.172 — the TUI's world, as it holds it: a bounded digest of the FleetSnapshot every topology view is rendered from (tables,
// explorer, graph). Answered on the control socket's OBSERVE verb "view", so a scenario can compare the TUI with the daemon's `ps` and
// `queue` (ROUTING R-21). Pure: no IO, no daemon calls. A WHITELIST of names and status: whatever else a snapshot row carries (pane text,
// paths, previews, tokens) is never copied out.
import type { FleetSnapshot, LoadState } from "../types.js";

/** Every variable-length field is bounded (verify-qa2 review): each list and each string, as a first pass. The bound that holds is
 *  on the ENCODED reply (verify-qa2's second review): the serialized UTF-8 bytes, which a code-unit cap does not bound (a CJK
 *  character is 3 bytes, a character JSON escapes is 6). `truncated` is true whenever anything was cut. */
export const VIEW_DIGEST_LIMITS = { rigs: 500, agentsPerRig: 200, agents: 2000, hostsDown: 100, chars: 100 } as const;
/** The whole socket reply line for "view", newline included, in UTF-8 bytes (pinned at the worst cases). */
export const VIEW_REPLY_MAX_BYTES = 1_000_000;

/** UTF-8 bytes of a JS string as written to the socket: a surrogate pair is 4 bytes, a lone surrogate 3 (TextEncoder replaces it). */
export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { bytes += 4; i++; }
    else bytes += 3;
  }
  return bytes;
}

/** The encoded size of a value as JSON.stringify writes it. */
const jsonBytes = (value: unknown): number => utf8Bytes(JSON.stringify(value));

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

/** `maxBytes` bounds the digest's own serialized UTF-8 bytes (the socket passes VIEW_REPLY_MAX_BYTES less its envelope). */
export function describeView(input: { snapshot: FleetSnapshot; load: LoadState | null }, limits = VIEW_DIGEST_LIMITS, maxBytes = VIEW_REPLY_MAX_BYTES): ViewDigest {
  const { snapshot, load } = input;
  const rigs: ViewDigestRig[] = [];
  let totalRigs = 0, totalAgents = 0, keptAgents = 0, truncated = false;
  const cap = (text: string): string => {
    if (text.length <= limits.chars) return text;
    truncated = true;
    // Never split a surrogate pair: a lone half is not text, and JSON writes it as a 6-byte escape.
    const end = (text.charCodeAt(limits.chars - 1) & 0xfc00) === 0xd800 ? limits.chars - 1 : limits.chars;
    return text.slice(0, end);
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
  const digest: ViewDigest = {
    readAt: typeof load?.lastSuccessAt === "number" ? new Date(load.lastSuccessAt).toISOString() : null,
    stale: load?.stale === true,
    settled: load?.settled === true,
    rigs,
    hostsDown: snapshot.hostsDown.slice(0, limits.hostsDown).map((h) => cap(h.hostId)),
    counts: { rigs: totalRigs, agents: totalAgents },
    truncated,
  };
  return fitEncoded(digest, maxBytes);
}

/**
 * Drops items until the digest's serialized UTF-8 bytes fit `maxBytes`, setting truncated. Agent detail goes first (from the last
 * rig back), then the down hosts, then rig rows from the end: a rig row carries the name and agentCount a scenario compares with
 * ps, and agentCount stays the rig's whole count whatever its agent list lost. Sizes are tracked per removed item (the item's
 * bytes, plus its comma unless it was the array's only element) and checked once more on the final serialization.
 */
function fitEncoded(digest: ViewDigest, maxBytes: number): ViewDigest {
  let total = jsonBytes(digest);
  if (total <= maxBytes) return digest;
  if (!digest.truncated) { digest.truncated = true; total = jsonBytes(digest); }
  const dropLast = <T>(list: T[]): void => { const item = list.pop()!; total -= jsonBytes(item) + (list.length > 0 ? 1 : 0); };
  for (let r = digest.rigs.length - 1; r >= 0 && total > maxBytes; r--) {
    const agents = digest.rigs[r]!.agents;
    while (agents.length > 0 && total > maxBytes) dropLast(agents);
  }
  while (digest.hostsDown.length > 0 && total > maxBytes) dropLast(digest.hostsDown);
  while (digest.rigs.length > 0 && total > maxBytes) dropLast(digest.rigs);
  // The tracked total is exact; this re-check is the bound's own proof, and drops rig rows if it ever is not.
  while (jsonBytes(digest) > maxBytes && digest.rigs.length > 0) digest.rigs.pop();
  return digest;
}
