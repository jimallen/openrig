import type { DiscoveryRepository } from "../../src/domain/discovery-repository.js";
import type { RigRepository } from "../../src/domain/rig-repository.js";
import type { SessionRegistry } from "../../src/domain/session-registry.js";

/**
 * Test seam: leave a seat holding a session OpenRig did not launch (session row `origin=claimed`, binding naming the
 * session, discovery record claimed), the rows a legacy adoption wrote. Session adoption itself is gone (hc-w7); the
 * rig-lifecycle paths that still protect such rows (release, remove, stop) are what these tests exercise.
 */
export function seedClaimedSession(
  deps: { rigRepo: RigRepository; sessionRegistry: SessionRegistry; discoveryRepo: DiscoveryRepository },
  opts: { discoveredId: string; rigId: string; logicalId: string },
): { ok: true; nodeId: string; sessionId: string } {
  const discovered = deps.discoveryRepo.getDiscoveredSession(opts.discoveredId);
  if (!discovered) throw new Error(`no discovery record ${opts.discoveredId}`);
  const node = deps.rigRepo.getRig(opts.rigId)?.nodes.find((candidate) => candidate.logicalId === opts.logicalId);
  if (!node) throw new Error(`no node ${opts.logicalId} in rig ${opts.rigId}`);
  const session = deps.sessionRegistry.registerClaimedSession(node.id, discovered.tmuxSession);
  deps.sessionRegistry.updateBinding(node.id, {
    tmuxSession: discovered.tmuxSession,
    ...(discovered.tmuxWindow ? { tmuxWindow: discovered.tmuxWindow } : {}),
    ...(discovered.tmuxPane ? { tmuxPane: discovered.tmuxPane } : {}),
  });
  deps.discoveryRepo.markClaimed(discovered.id, node.id);
  return { ok: true, nodeId: node.id, sessionId: session.id };
}
