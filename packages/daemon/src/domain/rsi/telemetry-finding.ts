import {
  boundHealthEvidence,
  deriveHealthSourceFreshness,
  type HealthEvidenceReference,
  type HealthScope,
} from "../health-projection.js";
import type { HealthDetectorObservation, HealthSourceCoverage } from "../health-detectors.js";
import { rsiFingerprint } from "./fingerprint.js";

/** The scope of a finding about the whole OpenRig instance rather than one rig. */
export const RSI_LOCAL_INSTANCE_SCOPE: HealthScope = { type: "instance", instanceId: "local" };

/** Hits within the window needed before a recurring-class detector (D1, D2) fires. */
export const RSI_CLASS_RECURRENCE_THRESHOLD = 3;
export const RSI_CLASS_WINDOW_DAYS = 7;

export interface TelemetryFindingInput {
  detectorId: string;
  /** Subject key including the class (fingerprint.ts: multi-class detectors put the class in the key). */
  subjectKey: string;
  scope: HealthScope;
  /** Class carried in the evidence; `regression-after:<fixSha>` when an anchor governs. */
  findingClass: string;
  count: number;
  controlTotal: number;
  population: number;
  firstSeq: number;
  lastSeq: number;
  firstSeen: string;
  lastSeen: string;
  evaluatedAt: string;
  summary: string;
  threshold: string;
  explanation: string;
  suggestedInspection: string;
}

/** One `telemetry-finding` observation with its `telemetry-span` evidence. */
export function buildTelemetryFinding(input: TelemetryFindingInput): HealthDetectorObservation {
  const fingerprint = rsiFingerprint(input.detectorId, input.subjectKey);
  const evidence: HealthEvidenceReference = {
    type: "telemetry-span", sourceOrder: 0, observedAt: input.lastSeen,
    detectorId: input.detectorId, class: input.findingClass, fingerprint,
    count: input.count, controlTotal: input.controlTotal, population: input.population,
    firstSeq: input.firstSeq, lastSeq: input.lastSeq, firstSeen: input.firstSeen, lastSeen: input.lastSeen,
  };
  const windowSeconds = Math.max(1, Math.ceil((Date.parse(input.evaluatedAt) - Date.parse(input.firstSeen)) / 1000));
  return {
    kind: "telemetry-finding",
    detectorId: input.detectorId,
    fingerprint,
    episodeKey: fingerprint,
    scope: input.scope,
    episodeStartedAt: input.firstSeen,
    lastObservedAt: input.evaluatedAt,
    source: boundHealthEvidence([evidence], {
      source: "telemetry-span", startedAt: input.firstSeen, endedAt: input.evaluatedAt, limit: 1, retentionSeconds: windowSeconds,
    }, deriveHealthSourceFreshness({ evaluatedAt: input.evaluatedAt, newestSourceAt: input.evaluatedAt, maxAgeSeconds: 600 })),
    summary: input.summary,
    threshold: input.threshold,
    explanation: input.explanation,
    suggestedInspection: input.suggestedInspection,
  };
}

/** Coverage of a source that could not read an input it depends on: unavailable, never zero. */
export function unavailableCoverage(source: string, evaluatedAt: string, reason: string): HealthSourceCoverage {
  return { source, evaluatedAt, status: "unavailable", partial: true, reason };
}

/** SQLite `datetime('now')` form of an instant, for comparing against `created_at` columns. */
export function sqliteUtcStamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}
