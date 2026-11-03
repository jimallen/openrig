import { boundHealthEvidence, deriveHealthSourceFreshness, type HealthEvidenceReference } from "./health-projection.js";
import type { HealthDetectorObservation, HealthObservationSource } from "./health-detectors.js";
import type Database from "better-sqlite3";
import { getNodeInventoryForAllRigs } from "./node-inventory.js";
import { identityVerdictConfirmsSessionMissing, type NodeInventoryEntry } from "./types.js";

const FRESH_SECONDS = 3_600;
const RETENTION_SECONDS = 30 * 86_400;

/** A seat is lost when its latest session is not at rest and its terminal is confirmed missing. `running` is a crash the daemon has just seen; `detached` is
 *  the same seat after the boot reconcile found its terminal absent and detached the row. `exited` is a supported stop (`rig down`, `rig seat stop`: it writes
 *  the row `exited` with its intent) or an exit someone else recorded, and neither is reported here; a held seat is one a restore left down on purpose. Neither is lost. This is the condition under which `rig ps` prints its advice. */
function isLost(entry: NodeInventoryEntry): boolean {
  const status = entry.storedSessionStatus;
  return (status === "running" || status === "detached")
    && !entry.heldReason
    && identityVerdictConfirmsSessionMissing(entry.identityVerdict);
}

/** The seats of every rig that is not archived: an archived rig is put away on purpose, whatever its sessions say. */
export function inventoryOfLiveRigs(db: Database.Database): NodeInventoryEntry[] {
  const archived = new Set((db.prepare("SELECT id FROM rigs WHERE archived_at IS NOT NULL").all() as Array<{ id: string }>).map((row) => row.id));
  return [...getNodeInventoryForAllRigs(db).entries()].filter(([rigId]) => !archived.has(rigId)).flatMap(([, entries]) => entries);
}

export interface SeatLostHealthDeps {
  /** Every seat of every live rig, as `rig ps` reads them (the node inventory). */
  inventory(): readonly NodeInventoryEntry[];
  /** The messages the pump holds for a seat's session, or null when none. */
  waiting(seatSession: string): { open: number; oldestId: string | null } | null;
  now?: () => Date;
}

/**
 * OF-200: a seat's agent is its terminal's own program, so an agent that crashes ends its terminal and the seat reads lost. Where a login shell stayed
 * above the agent there was a pane to look at; now `rig ps` shows `det` and nothing else did. This source makes it a finding: a session still recorded
 * `running` whose terminal the identity reconciler confirmed missing. A supported stop (`rig down`, `rig seat stop`) writes the session `exited`, so
 * it is never read as lost. Read-only: it restarts nothing, because nothing may restart a seat that a person did not ask to.
 *
 * The episode starts when this process first saw the seat lost: the reconciler rewrites its verdict's time on every poll, so that time cannot anchor
 * an id. A daemon restart starts the episode again.
 */
export class SeatLostHealthSource implements HealthObservationSource {
  readonly name = "seat-lost";
  readonly detectors = ["seat.lost"];
  private readonly firstSeen = new Map<string, string>();

  constructor(private readonly deps: SeatLostHealthDeps) {}

  read(): readonly HealthDetectorObservation[] {
    const evaluatedAt = (this.deps.now ?? (() => new Date()))().toISOString();
    const lost = this.deps.inventory().filter(isLost);
    const current = new Set<string>();
    const observations: HealthDetectorObservation[] = [];
    for (const entry of lost) {
      const verdict = entry.identityVerdict!;
      const sessionName = entry.canonicalSessionName ?? verdict.sessionName ?? entry.logicalId;
      const key = `${entry.nodeId}|${sessionName}`;
      current.add(key);
      const started = this.firstSeen.get(key) ?? (Date.parse(verdict.observedAt) <= Date.parse(evaluatedAt) ? verdict.observedAt : evaluatedAt);
      this.firstSeen.set(key, started);
      const evidence: HealthEvidenceReference = {
        type: "topology-activity", sourceOrder: 0, observedAt: verdict.observedAt,
        nodeId: entry.nodeId, sessionName, activity: "session_missing", activitySequence: null,
      };
      const windowStart = new Date(Math.min(Date.parse(evaluatedAt) - RETENTION_SECONDS * 1000, Date.parse(verdict.observedAt))).toISOString();
      observations.push({
        kind: "seat-lost",
        scope: { type: "seat", rigId: entry.rigId, seatId: entry.nodeId },
        episodeStartedAt: started,
        lastObservedAt: verdict.observedAt,
        rigId: entry.rigId, rigName: entry.rigName, logicalId: entry.logicalId, sessionName,
        waiting: this.deps.waiting(sessionName),
        source: boundHealthEvidence([evidence], { source: "topology-activity", startedAt: windowStart, endedAt: evaluatedAt, limit: 1, retentionSeconds: RETENTION_SECONDS },
          deriveHealthSourceFreshness({ evaluatedAt, newestSourceAt: verdict.observedAt, maxAgeSeconds: FRESH_SECONDS, available: true })),
      });
    }
    // A seat that came back (or was stopped on purpose) ends its episode: the next time it is lost is a new one.
    for (const key of [...this.firstSeen.keys()]) if (!current.has(key)) this.firstSeen.delete(key);
    return observations;
  }
}
