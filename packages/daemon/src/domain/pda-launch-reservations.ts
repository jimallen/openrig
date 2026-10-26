// OF-96: the claims that make "check that no other seat drives this pda agent, then launch onto it" one step.
//
// Ubiquitous language: a pda agent is the pair (agent name, base URL). A seat's LAUNCH claims the agent for as long as
// the launch is in flight; a launch that succeeded keeps the claim until the seat's resume token names the agent in the
// database (the token is then the durable holder, found by RigRepository.findPdaResumeTokenHolders) or the lease ends.
//
// Why memory and not a table: only the daemon process launches pda seats, a claim is meaningful for one launch (the
// runner attaches within PDA_LAUNCH_WAIT_MS), and a claim row would survive a daemon crash and hold an agent nothing
// drives. No migration, nothing persisted, nothing to roll back. Not proven: a SECOND daemon process on one database
// (OpenRig runs one per OPENRIG_HOME).
import type { PdaBinding } from "../adapters/pda-runner-protocol.js";

/** How long a successful launch keeps its claim while the database does not yet name the seat as holder. The sole
 *  production caller records the token in the same step as the launch returns; this only bounds a missed record. */
export const PDA_RESERVATION_LEASE_MS = 60_000;

export interface PdaLaunchReservation {
  /** The launch succeeded: the claim now stays until the database names the seat or the lease ends. */
  launched(): void;
  /** The launch failed or threw: the agent is free again at once. */
  failed(): void;
}

interface Claim { nodeId: string; launchedAt: number | null }

export class PdaLaunchReservations {
  private readonly claims = new Map<string, Map<string, Claim>>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  private static key(binding: PdaBinding): string {
    return `${binding.baseUrl}\u0000${binding.agent}`;
  }

  claim(binding: PdaBinding, nodeId: string): PdaLaunchReservation {
    const key = PdaLaunchReservations.key(binding);
    const byNode = this.claims.get(key) ?? new Map<string, Claim>();
    this.claims.set(key, byNode);
    const claim: Claim = { nodeId, launchedAt: null };
    byNode.set(nodeId, claim);
    return {
      launched: () => { if (byNode.get(nodeId) === claim) claim.launchedAt = this.now(); },
      failed: () => { this.release(binding, nodeId, claim); },
    };
  }

  /** Live claims on this agent: in flight, or launched and inside the lease. Expired ones are dropped here. */
  claimants(binding: PdaBinding): Array<{ nodeId: string; launched: boolean }> {
    const byNode = this.claims.get(PdaLaunchReservations.key(binding));
    if (!byNode) return [];
    const live: Array<{ nodeId: string; launched: boolean }> = [];
    for (const claim of [...byNode.values()]) {
      if (claim.launchedAt !== null && this.now() - claim.launchedAt >= PDA_RESERVATION_LEASE_MS) { this.release(binding, claim.nodeId, claim); continue; }
      live.push({ nodeId: claim.nodeId, launched: claim.launchedAt !== null });
    }
    return live;
  }

  /** Drop a launched claim the database now backs (or that no longer matters). */
  settle(binding: PdaBinding, nodeId: string): void {
    this.release(binding, nodeId);
  }

  private release(binding: PdaBinding, nodeId: string, only?: Claim): void {
    const key = PdaLaunchReservations.key(binding);
    const byNode = this.claims.get(key);
    const claim = byNode?.get(nodeId);
    if (!byNode || !claim || (only !== undefined && claim !== only)) return;
    byNode.delete(nodeId);
    if (byNode.size === 0) this.claims.delete(key);
  }
}
