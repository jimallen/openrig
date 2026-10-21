import { createHash } from "node:crypto";
import type { QueueTransition } from "./queue-transition-log.js";
import type { WatchdogHistoryEntry } from "./watchdog-history-log.js";
import type { ContextUsage, NodeInventoryEntry } from "./types.js";
import type { OperatingPosture } from "./rig-mode/operating-posture.js";

export const HEALTH_RECORD_SCHEMA = "openrig.health/v0alpha1" as const;
export const HEALTH_CATEGORIES = ["behavioral", "process", "governance", "epistemic", "context"] as const;
export const HEALTH_SEVERITIES = ["info", "warning", "critical"] as const;
export const HEALTH_CONFIDENCE = ["high", "medium"] as const;
export const HEALTH_STATUSES = ["active", "cleared", "indeterminate"] as const;

export type HealthCategory = (typeof HEALTH_CATEGORIES)[number];
export type HealthSeverity = (typeof HEALTH_SEVERITIES)[number];
export type HealthConfidence = (typeof HEALTH_CONFIDENCE)[number];
export type HealthStatus = (typeof HEALTH_STATUSES)[number];

export type HealthScope =
  | { type: "instance"; instanceId: string }
  | { type: "rig"; rigId: string }
  | { type: "seat"; rigId: string; seatId: string }
  | { type: "mission"; projectId: string; missionId: string }
  | { type: "slice"; projectId: string; missionId: string; sliceId: string };

interface EvidenceBase {
  sourceOrder: number;
  observedAt: string | null;
}

export type HealthEvidenceReference =
  | (EvidenceBase & {
      type: "queue-transition";
      qitemId: string;
      transitionId: number;
      state: string;
      actorSession: string;
      identityProvenance: string | null;
    })
  | (EvidenceBase & {
      type: "watchdog-history";
      jobId: string;
      historyId: string;
      outcome: string;
      deliveryStatus: string | null;
    })
  | (EvidenceBase & {
      type: "work-graph";
      nodeType: "mission" | "slice";
      nodeId: string;
      missionId: string;
      stage: string | null;
      dependsOn: string[];
    })
  | (EvidenceBase & {
      type: "topology-activity";
      nodeId: string;
      sessionName: string | null;
      activity: string | null;
      activitySequence: number | null;
    })
  | (EvidenceBase & {
      type: "context-usage";
      nodeId: string;
      sessionId: string | null;
      usedPercentage: number | null;
      available: boolean;
      fresh: boolean;
    })
  | (EvidenceBase & {
      type: "occupant-model";
      nodeId: string;
      occupantGeneration: string | null;
      runtime: string | null;
      model: string | null;
    })
  | (EvidenceBase & {
      type: "lifecycle-receipt";
      receiptId: string;
      operation: string;
      outcome: string;
    })
  /** A counted span of one telemetry source. `fingerprint` is the finding's stable identity
   * (rsi/fingerprint.ts): the record id changes with every episode, the fingerprint does not.
   * `controlTotal` and `population` are the controls the count is read against; firstSeq and
   * lastSeq are the source-table ordinals of the first and last supporting row. */
  | (EvidenceBase & {
      type: "telemetry-span";
      detectorId: string;
      class: string;
      fingerprint: string;
      count: number;
      controlTotal: number;
      population: number;
      firstSeq: number;
      lastSeq: number;
      firstSeen: string;
      lastSeen: string;
    });

export interface HealthQueryBounds {
  source: HealthEvidenceReference["type"] | "mixed";
  startedAt: string;
  endedAt: string;
  limit: number;
  retentionSeconds: number;
}

export type HealthFreshnessState = "fresh" | "stale" | "unavailable" | "contradictory";

export interface HealthSourceFreshness {
  state: HealthFreshnessState;
  evaluatedAt: string;
  newestSourceAt: string | null;
  maxAgeSeconds: number;
  ageSeconds: number | null;
}

export interface BoundedHealthEvidence {
  query: HealthQueryBounds;
  freshness: HealthSourceFreshness;
  evidence: HealthEvidenceReference[];
  omitted: {
    outOfWindow: number;
    missingTimestamp: number;
    sourceMismatch: number;
    truncated: number;
    retentionClipped: boolean;
  };
}

/** Passive traffic is a question for an agent, not a ratio or a diagnosis. */
export interface CeremonyProgressAssessment {
  basis: string;
  conclusion: "established" | "false-positive" | "indeterminate";
  outcomes: Array<{ id: string; observedAt: string; evidenceRefs: string[] }>;
  boundedAuthority: boolean | null;
  boundary: string;
  evidenceRefs: string[];
  missingFacts: string[];
}
export interface PassiveCeremony {
  origin: "passive";
  stage: "needs-diagnosis" | "confirmed" | "cleared" | "indeterminate";
  lineageId: string;
  basis: string;
  transitionIds: number[];
  context: Array<{ path: string; state: "available" | "unavailable"; sha256?: string; role: string }>;
  workflowReceipts: Array<{ trailId: string; instanceId: string; stepId: string; qitemId: string; closureReason: string; actor: string; at: string; evidence: unknown }>;
  assessment?: { result: CeremonyProgressAssessment; actor: string; at: string; transitionId: number; identityProvenance: string | null };
  missingFacts: string[];
}

export interface HealthRecordDraft {
  episodeKey?: string;
  ceremony?: PassiveCeremony;
  detector: string;
  category: HealthCategory;
  scope: HealthScope;
  severity: HealthSeverity;
  confidence: HealthConfidence;
  status: HealthStatus;
  startedAt: string | null;
  lastObservedAt: string | null;
  summary: string;
  threshold: string;
  explanation: string;
  suggestedInspection: string;
  source: BoundedHealthEvidence;
}

export interface HealthRecord {
  operatingPosture?: OperatingPosture;
  ceremony?: PassiveCeremony;
  policyVersion?: string;
  schema: typeof HEALTH_RECORD_SCHEMA;
  id: string;
  detector: string;
  category: HealthCategory;
  scope: HealthScope;
  severity: HealthSeverity;
  confidence: HealthConfidence;
  status: HealthStatus;
  startedAt: string | null;
  lastObservedAt: string | null;
  window: HealthQueryBounds;
  freshness: HealthSourceFreshness;
  summary: string;
  evidence: HealthEvidenceReference[];
  threshold: string;
  explanation: string;
  suggestedInspection: string;
  indeterminateReason: string | null;
}

export function adaptQueueTransitionEvidence(
  transition: Pick<QueueTransition, "transitionId" | "qitemId" | "ts" | "state" | "actorSession" | "identityProvenance">,
  sourceOrder: number,
): HealthEvidenceReference {
  return {
    type: "queue-transition",
    sourceOrder: checkedSourceOrder(sourceOrder),
    observedAt: transition.ts,
    transitionId: transition.transitionId,
    qitemId: transition.qitemId,
    state: transition.state,
    actorSession: transition.actorSession,
    identityProvenance: transition.identityProvenance,
  };
}

export function adaptWatchdogHistoryEvidence(
  entry: Pick<WatchdogHistoryEntry, "jobId" | "historyId" | "evaluatedAt" | "outcome" | "deliveryStatus">,
  sourceOrder: number,
): HealthEvidenceReference {
  return {
    type: "watchdog-history",
    sourceOrder: checkedSourceOrder(sourceOrder),
    observedAt: entry.evaluatedAt,
    jobId: entry.jobId,
    historyId: entry.historyId,
    outcome: entry.outcome,
    deliveryStatus: entry.deliveryStatus,
  };
}

export function adaptWorkGraphEvidence(input: {
  sourceOrder: number;
  observedAt: string;
  nodeType: "mission" | "slice";
  nodeId: string;
  missionId: string;
  stage: string | null;
  dependsOn?: readonly string[];
}): HealthEvidenceReference {
  return {
    type: "work-graph",
    sourceOrder: checkedSourceOrder(input.sourceOrder),
    observedAt: input.observedAt,
    nodeType: input.nodeType,
    nodeId: input.nodeId,
    missionId: input.missionId,
    stage: input.stage,
    dependsOn: [...(input.dependsOn ?? [])],
  };
}

export function adaptTopologyActivityEvidence(
  node: Pick<NodeInventoryEntry, "logicalId" | "canonicalSessionName" | "lastActivityAt" | "agentActivity" | "activityState">,
  sourceOrder: number,
): HealthEvidenceReference {
  return {
    type: "topology-activity",
    sourceOrder: checkedSourceOrder(sourceOrder),
    observedAt: node.lastActivityAt ?? node.agentActivity?.sampledAt ?? null,
    nodeId: node.logicalId,
    sessionName: node.canonicalSessionName,
    activity: node.activityState?.activity ?? node.agentActivity?.state ?? null,
    activitySequence: node.activityState?.seq ?? null,
  };
}

export function adaptContextUsageEvidence(
  nodeId: string,
  usage: ContextUsage,
  sourceOrder: number,
): HealthEvidenceReference {
  return {
    type: "context-usage",
    sourceOrder: checkedSourceOrder(sourceOrder),
    observedAt: usage.sampledAt,
    nodeId,
    sessionId: usage.sessionId,
    usedPercentage: usage.usedPercentage,
    available: usage.availability === "known",
    fresh: usage.fresh,
  };
}

export function adaptOccupantModelEvidence(input: {
  sourceOrder: number;
  observedAt: string | null;
  nodeId: string;
  occupantGeneration: string | null;
  runtime: string | null;
  model: string | null;
}): HealthEvidenceReference {
  return {
    type: "occupant-model",
    sourceOrder: checkedSourceOrder(input.sourceOrder),
    observedAt: input.observedAt,
    nodeId: input.nodeId,
    occupantGeneration: input.occupantGeneration,
    runtime: input.runtime,
    model: input.model,
  };
}

export function adaptLifecycleReceiptEvidence(input: {
  sourceOrder: number;
  observedAt: string;
  receiptId: string;
  operation: string;
  outcome: string;
}): HealthEvidenceReference {
  return {
    type: "lifecycle-receipt",
    sourceOrder: checkedSourceOrder(input.sourceOrder),
    observedAt: input.observedAt,
    receiptId: input.receiptId,
    operation: input.operation,
    outcome: input.outcome,
  };
}

export function deriveHealthSourceFreshness(input: {
  evaluatedAt: string;
  newestSourceAt: string | null;
  maxAgeSeconds: number;
  available?: boolean;
  contradictory?: boolean;
}): HealthSourceFreshness {
  const evaluatedMs = timestampMs("evaluatedAt", input.evaluatedAt);
  if (!Number.isFinite(input.maxAgeSeconds) || input.maxAgeSeconds < 0) {
    throw new Error("maxAgeSeconds must be a finite non-negative number");
  }
  if (input.contradictory) {
    return {
      state: "contradictory",
      evaluatedAt: input.evaluatedAt,
      newestSourceAt: input.newestSourceAt,
      maxAgeSeconds: input.maxAgeSeconds,
      ageSeconds: input.newestSourceAt === null
        ? null
        : Math.max(0, (evaluatedMs - timestampMs("newestSourceAt", input.newestSourceAt)) / 1000),
    };
  }
  if (input.available === false || input.newestSourceAt === null) {
    return {
      state: "unavailable",
      evaluatedAt: input.evaluatedAt,
      newestSourceAt: input.newestSourceAt,
      maxAgeSeconds: input.maxAgeSeconds,
      ageSeconds: null,
    };
  }
  const newestSourceMs = timestampMs("newestSourceAt", input.newestSourceAt);
  if (newestSourceMs > evaluatedMs) {
    return {
      state: "contradictory",
      evaluatedAt: input.evaluatedAt,
      newestSourceAt: input.newestSourceAt,
      maxAgeSeconds: input.maxAgeSeconds,
      ageSeconds: 0,
    };
  }
  const ageSeconds = (evaluatedMs - newestSourceMs) / 1000;
  return {
    state: ageSeconds > input.maxAgeSeconds ? "stale" : "fresh",
    evaluatedAt: input.evaluatedAt,
    newestSourceAt: input.newestSourceAt,
    maxAgeSeconds: input.maxAgeSeconds,
    ageSeconds,
  };
}

/** Apply one bounded read window without reordering or mutating source records. */
export function boundHealthEvidence(
  evidence: readonly HealthEvidenceReference[],
  query: HealthQueryBounds,
  freshness: HealthSourceFreshness,
): BoundedHealthEvidence {
  const startedMs = timestampMs("query.startedAt", query.startedAt);
  const endedMs = timestampMs("query.endedAt", query.endedAt);
  if (startedMs > endedMs) throw new Error("query.startedAt must not be after query.endedAt");
  if (!Number.isInteger(query.limit) || query.limit < 1) throw new Error("query.limit must be a positive integer");
  if (!Number.isFinite(query.retentionSeconds) || query.retentionSeconds < 1) {
    throw new Error("query.retentionSeconds must be a positive number");
  }

  const selected: HealthEvidenceReference[] = [];
  let outOfWindow = 0;
  let missingTimestamp = 0;
  let sourceMismatch = 0;
  for (const item of evidence) {
    if (query.source !== "mixed" && item.type !== query.source) {
      sourceMismatch++;
      continue;
    }
    if (item.observedAt === null) {
      missingTimestamp++;
      selected.push(cloneEvidence(item));
      continue;
    }
    const observedMs = timestampMs("evidence.observedAt", item.observedAt);
    if (observedMs < startedMs || observedMs > endedMs) {
      outOfWindow++;
      continue;
    }
    selected.push(cloneEvidence(item));
  }

  return {
    query: { ...query },
    freshness: { ...freshness },
    evidence: selected.slice(0, query.limit),
    omitted: {
      outOfWindow,
      missingTimestamp,
      sourceMismatch,
      truncated: Math.max(0, selected.length - query.limit),
      retentionClipped: (endedMs - startedMs) / 1000 > query.retentionSeconds,
    },
  };
}

/** Build one projection-neutral record. Detector policy supplies the draft; this function
 * enforces identity, bounds, freshness, and honest indeterminate semantics only. */
export function projectHealthRecord(draft: HealthRecordDraft): HealthRecord {
  const detector = requiredText("detector", draft.detector);
  requiredText("summary", draft.summary);
  requiredText("threshold", draft.threshold);
  requiredText("explanation", draft.explanation);
  requiredText("suggestedInspection", draft.suggestedInspection);
  if (draft.startedAt !== null) timestampMs("startedAt", draft.startedAt);
  if (draft.lastObservedAt !== null) timestampMs("lastObservedAt", draft.lastObservedAt);
  if (draft.startedAt && draft.lastObservedAt && Date.parse(draft.startedAt) > Date.parse(draft.lastObservedAt)) {
    throw new Error("startedAt must not be after lastObservedAt");
  }

  const indeterminateReason = projectionIndeterminateReason(draft);
  const status: HealthStatus = indeterminateReason === null ? draft.status : "indeterminate";
  const episodeStartedAt = draft.startedAt ?? draft.source.query.startedAt;
  return {
    schema: HEALTH_RECORD_SCHEMA,
    id: healthEpisodeId(detector, draft.scope, episodeStartedAt, draft.episodeKey),
    ...(draft.ceremony ? { ceremony: structuredClone(draft.ceremony) } : {}),
    detector,
    category: draft.category,
    scope: cloneScope(draft.scope),
    severity: draft.severity,
    confidence: draft.confidence,
    status,
    startedAt: draft.startedAt,
    lastObservedAt: draft.lastObservedAt,
    window: { ...draft.source.query },
    freshness: { ...draft.source.freshness },
    summary: draft.summary,
    evidence: draft.source.evidence.map(cloneEvidence),
    threshold: draft.threshold,
    explanation: draft.explanation,
    suggestedInspection: draft.suggestedInspection,
    indeterminateReason,
  };
}

export function healthEpisodeId(detector: string, scope: HealthScope, episodeStartedAt: string, episodeKey?: string): string {
  timestampMs("episodeStartedAt", episodeStartedAt);
  const digest = createHash("sha256")
    .update(stableJson({ detector: requiredText("detector", detector), scope: cloneScope(scope), episodeStartedAt, ...(episodeKey ? { episodeKey } : {}) }))
    .digest("hex")
    .slice(0, 24);
  return `health-${digest}`;
}

/** Canonical bytes for daemon, CLI, TUI, fixtures, and content-addressed tests. */
export function canonicalHealthJson(records: readonly HealthRecord[]): string {
  return stableJson([...records].sort((a, b) => {
    const idOrder = a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    if (idOrder !== 0) return idOrder;
    const aJson = stableJson(a);
    const bJson = stableJson(b);
    return aJson < bJson ? -1 : aJson > bJson ? 1 : 0;
  })) + "\n";
}

function projectionIndeterminateReason(draft: HealthRecordDraft): string | null {
  if (draft.status === "indeterminate") return "detector reported indeterminate evidence";
  if (draft.source.freshness.state !== "fresh") return `source freshness is ${draft.source.freshness.state}`;
  if (draft.source.omitted.sourceMismatch > 0) return "source evidence did not match the requested adapter";
  if (draft.source.omitted.missingTimestamp > 0) return "source evidence is missing an observation timestamp";
  if (draft.source.omitted.truncated > 0) return "source query reached its result limit";
  if (draft.source.omitted.retentionClipped) return "source retention does not cover the observation window";
  if (draft.source.evidence.length === 0) return "no source evidence falls inside the observation window";
  if (draft.startedAt === null || draft.lastObservedAt === null) return "the qualifying interval is incomplete";
  const queryStartedMs = Date.parse(draft.source.query.startedAt);
  const queryEndedMs = Date.parse(draft.source.query.endedAt);
  if (Date.parse(draft.startedAt) < queryStartedMs || Date.parse(draft.lastObservedAt) > queryEndedMs) {
    return "the qualifying interval falls outside the observation window";
  }
  return null;
}

function cloneScope(scope: HealthScope): HealthScope {
  switch (scope.type) {
    case "instance": return { type: "instance", instanceId: requiredText("scope.instanceId", scope.instanceId) };
    case "rig": return { type: "rig", rigId: requiredText("scope.rigId", scope.rigId) };
    case "seat": return {
      type: "seat",
      rigId: requiredText("scope.rigId", scope.rigId),
      seatId: requiredText("scope.seatId", scope.seatId),
    };
    case "mission": return {
      type: "mission",
      projectId: requiredText("scope.projectId", scope.projectId),
      missionId: requiredText("scope.missionId", scope.missionId),
    };
    case "slice": return {
      type: "slice",
      projectId: requiredText("scope.projectId", scope.projectId),
      missionId: requiredText("scope.missionId", scope.missionId),
      sliceId: requiredText("scope.sliceId", scope.sliceId),
    };
  }
}

function cloneEvidence(evidence: HealthEvidenceReference): HealthEvidenceReference {
  return evidence.type === "work-graph"
    ? { ...evidence, dependsOn: [...evidence.dependsOn] }
    : { ...evidence };
}

function checkedSourceOrder(value: number): number {
  if (!Number.isInteger(value) || value < 0) throw new Error("sourceOrder must be a non-negative integer");
  return value;
}

function requiredText(label: string, value: string): string {
  if (value.trim() === "") throw new Error(`${label} must be a non-empty string`);
  return value;
}

function timestampMs(label: string, value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be an ISO timestamp`);
  return parsed;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b, "en-US"))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
