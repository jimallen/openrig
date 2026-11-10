import { boundHealthEvidence, deriveHealthSourceFreshness, type HealthEvidenceReference } from "./health-projection.js";
import type { HealthDetectorObservation, HealthObservationSource } from "./health-detectors.js";
import type { PublishedModelErrorLoop } from "./seat-model-error-loop.js";
import type { NodeInventoryEntry } from "./types.js";

const FRESH_SECONDS = 900;
const RETENTION_SECONDS = 86_400;

export interface SeatModelErrorLoopHealthDeps {
  /** Every seat of every live rig, as `rig ps` reads them (the node inventory). */
  inventory(): readonly NodeInventoryEntry[];
  /** The flag the seat's runner publishes (Pi or OMP), or null. Reads the runner's sidecar only. */
  modelErrorLoop(runtime: "pi" | "omp", sessionName: string): PublishedModelErrorLoop | null;
  now?: () => Date;
}

/**
 * OF-286: one `rig health` finding per Pi or OMP seat flagged as looping on model errors (3 failed model requests within 15 minutes, answers
 * in between allowed; kept when the runtime gives up; cleared by a turn that completes with no model error). It names the seat, the failed
 * requests, the last error and since when. Read-only: it stops and restarts nothing, since a relaunch loses the seat's context and the cause
 * is usually between the runtime and the provider. The same flag marks the seat in `rig ps` and tells the rig's Chief of Staff
 * (seat-model-error-loop-notice.ts).
 */
export class SeatModelErrorLoopHealthSource implements HealthObservationSource {
  readonly name = "seat-model-error-loop";
  readonly detectors = ["seat.model-error-loop"];

  constructor(private readonly deps: SeatModelErrorLoopHealthDeps) {}

  read(): readonly HealthDetectorObservation[] {
    const evaluatedAt = (this.deps.now ?? (() => new Date()))().toISOString();
    const observations: HealthDetectorObservation[] = [];
    for (const entry of this.deps.inventory()) {
      if ((entry.runtime !== "pi" && entry.runtime !== "omp") || entry.storedSessionStatus !== "running" || !entry.canonicalSessionName) continue;
      let loop: PublishedModelErrorLoop | null;
      try { loop = this.deps.modelErrorLoop(entry.runtime, entry.canonicalSessionName); } catch { loop = null; }
      if (!loop) continue;
      const evidence: HealthEvidenceReference = {
        type: "topology-activity", sourceOrder: 0, observedAt: loop.lastAt,
        nodeId: entry.nodeId, sessionName: entry.canonicalSessionName, activity: "model_error_loop", activitySequence: null,
      };
      const windowStart = new Date(Math.min(Date.parse(evaluatedAt) - RETENTION_SECONDS * 1000, Date.parse(loop.since))).toISOString();
      observations.push({
        kind: "seat-model-error-loop",
        scope: { type: "seat", rigId: entry.rigId, seatId: entry.nodeId },
        episodeStartedAt: loop.since,
        lastObservedAt: loop.lastAt,
        rigId: entry.rigId, rigName: entry.rigName, logicalId: entry.logicalId, sessionName: entry.canonicalSessionName,
        runtime: entry.runtime, failedRequests: loop.total, lastError: loop.lastError, gaveUpAt: loop.gaveUpAt ?? null,
        source: boundHealthEvidence([evidence], { source: "topology-activity", startedAt: windowStart, endedAt: evaluatedAt, limit: 1, retentionSeconds: RETENTION_SECONDS },
          // The flag outlives the failures (it is kept until a clean turn), so its freshness is the runner's own tick, not the last failure.
          deriveHealthSourceFreshness({ evaluatedAt, newestSourceAt: evaluatedAt, maxAgeSeconds: FRESH_SECONDS, available: true })),
      });
    }
    return observations;
  }
}
