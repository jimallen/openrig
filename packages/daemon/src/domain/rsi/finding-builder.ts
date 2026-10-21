import type Database from "better-sqlite3";
import {
  boundHealthEvidence,
  deriveHealthSourceFreshness,
  type HealthEvidenceReference,
  type HealthScope,
} from "../health-projection.js";
import type { HealthDetectorObservation, HealthObservationSource, HealthSourceCoverage } from "../health-detectors.js";
import { parseSqliteUtcMs } from "../sqlite-time.js";
import { openRsiReadOnlyDatabase, RSI_TELEMETRY_ROW_LIMIT } from "./telemetry-source.js";
import { rsiFingerprint } from "./fingerprint.js";

/**
 * Shared seam for the A2b counted detectors (D5-D10, D12, D14): one lazily opened READ-ONLY
 * handle (A1's `openRsiReadOnlyDatabase`), one snapshot transaction per read, A1's coverage
 * shape, and one place that turns a counted finding into a `telemetry-finding` observation.
 *
 * COST: each source runs ONE grouped statement (plus, where named, one indexed count) and derives
 * firing / quiet / population / class split in JS, so a read is a single pass over its window.
 *
 * TIME BUDGET: every source exposes a plain `read()`, and the RSI registry (registry.ts) wraps
 * each one in A2a's `BudgetedRsiSource` (read-budget.ts). better-sqlite3 cannot interrupt a running
 * statement, so the wrapper measures the read and notes an over-budget read on its coverage; it
 * cannot cut a statement short, and a slow read that finished is not marked partial. The grouped statements are bounded by the window (and an index),
 * not by a row cap.
 *
 * This is also the ONE finding builder for every RSI counted source (A2a's D1-D3 use it too).
 */

/** One database connection shared by every A2b source, opened on first use. */
export class RsiReadOnlyConnection {
  private db: Database.Database | null = null;
  constructor(private readonly dbPath: string) {}
  get(): Database.Database {
    return this.db ??= openRsiReadOnlyDatabase(this.dbPath);
  }
}

/** The `events.created_at` form: `datetime('now')`, "YYYY-MM-DD HH:MM:SS" UTC. */
export function sqliteUtcStamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

export function hoursBefore(now: Date, hours: number): Date {
  return new Date(now.getTime() - hours * 3_600_000);
}

/** ISO instant of a stored stamp in either form (SQLite UTC stamp or ISO). */
export function toIso(stamp: string): string {
  const ms = parseSqliteUtcMs(stamp);
  if (Number.isNaN(ms)) throw new Error(`unparseable timestamp ${JSON.stringify(stamp)}`);
  return new Date(ms).toISOString();
}

/** A class split rendered for a finding's explanation: `a 2, b 3 = 5`. The total is the sum of the parts. */
export function partitionText(parts: ReadonlyArray<readonly [string, number]>): string {
  return `${parts.map(([name, n]) => `${name} ${n}`).join(", ")} = ${parts.reduce((sum, [, n]) => sum + n, 0)}`;
}

/** Counts a label map into sorted `[label, n]` parts. */
export function sortedParts(counts: ReadonlyMap<string, number>): Array<readonly [string, number]> {
  return [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, n]) => [name, n] as const);
}

/** One counted finding, before it becomes an observation. */
export interface FindingSpec {
  detectorId: string;
  className: string;
  /** What is wrong (never when or how often). A multi-class detector puts the class in it. */
  subjectKey: string;
  scope: HealthScope;
  count: number;
  /** Units that were judged and are NOT findings: the negative control. */
  controlTotal: number;
  /** All units judged. `findings (all, not only emitted) + controlTotal === population`. */
  population: number;
  firstSeq: number;
  lastSeq: number;
  firstSeen: string;
  lastSeen: string;
  summary: string;
  threshold: string;
  explanation: string;
  suggestedInspection: string;
}

export function buildTelemetryFinding(spec: FindingSpec, evaluatedAt: string): HealthDetectorObservation {
  const fingerprint = rsiFingerprint(spec.detectorId, spec.subjectKey);
  const evidence: HealthEvidenceReference = {
    type: "telemetry-span", sourceOrder: 0, observedAt: spec.lastSeen,
    detectorId: spec.detectorId, class: spec.className, fingerprint,
    count: spec.count, controlTotal: spec.controlTotal, population: spec.population,
    firstSeq: spec.firstSeq, lastSeq: spec.lastSeq, firstSeen: spec.firstSeen, lastSeen: spec.lastSeen,
  };
  // The episode starts at the earliest supporting row and the record id follows it; for a
  // sliding window that start moves as old rows age out. The fingerprint does not move.
  const windowSeconds = Math.max(1, Math.ceil((Date.parse(evaluatedAt) - Date.parse(spec.firstSeen)) / 1000));
  return {
    kind: "telemetry-finding",
    detectorId: spec.detectorId,
    fingerprint,
    episodeKey: fingerprint,
    scope: spec.scope,
    episodeStartedAt: spec.firstSeen,
    lastObservedAt: evaluatedAt,
    source: boundHealthEvidence([evidence], {
      source: "telemetry-span", startedAt: spec.firstSeen, endedAt: evaluatedAt, limit: 1, retentionSeconds: windowSeconds,
    }, deriveHealthSourceFreshness({ evaluatedAt, newestSourceAt: evaluatedAt, maxAgeSeconds: 600 })),
    summary: spec.summary,
    threshold: spec.threshold,
    explanation: spec.explanation,
    suggestedInspection: spec.suggestedInspection,
  };
}

/** Coverage of a source that could not read an input it depends on: unavailable, never zero. */
export function unavailableCoverage(source: string, evaluatedAt: string, reason: string): HealthSourceCoverage {
  return { source, evaluatedAt, status: "unavailable", partial: true, reason };
}

export interface SourceContext {
  db: Database.Database;
  now: Date;
  /** Most findings this read may emit. */
  limit: number;
}

export interface SourceResult {
  /** At most `ctx.limit` findings. */
  findings: FindingSpec[];
  /** ALL firing findings, counted without the cap. */
  total: number;
  unit: string;
  order: string;
  /** Served verbatim on the coverage row (daemon-authored text only). */
  note?: string;
}

export interface RsiFindingSourceDeps {
  connection: RsiReadOnlyConnection;
  /** The daemon instance id: the scope of a finding that belongs to no single rig or seat. */
  instanceId: string;
  now?: () => Date;
  rowLimit?: number;
}

/** A source with one detector. Disabling that detector skips the read (health-detectors.ts). */
export abstract class RsiFindingSource implements HealthObservationSource {
  abstract readonly name: string;
  abstract readonly detectors: readonly string[];
  private lastCoverage: HealthSourceCoverage[] = [];

  constructor(protected readonly deps: RsiFindingSourceDeps) {}

  /** Runs inside ONE deferred read transaction, so counts and controls share a snapshot. */
  protected abstract query(ctx: SourceContext): SourceResult;

  /** The source's read-only handle. Exposed so a test can prove it refuses writes. */
  readonlyHandle(): Database.Database {
    return this.deps.connection.get();
  }

  coverage(): readonly HealthSourceCoverage[] {
    return this.lastCoverage;
  }

  read(): readonly HealthDetectorObservation[] {
    this.lastCoverage = [];
    const db = this.readonlyHandle();
    const now = (this.deps.now ?? (() => new Date()))();
    const evaluatedAt = now.toISOString();
    const limit = this.deps.rowLimit ?? RSI_TELEMETRY_ROW_LIMIT;
    const result = db.transaction(() => this.query({ db, now, limit }))();
    this.lastCoverage = [{
      source: this.name, evaluatedAt, unit: result.unit, limit, total: result.total, evaluated: result.findings.length,
      omitted: Math.max(0, result.total - result.findings.length), partial: result.total > result.findings.length,
      order: result.order, ...(result.note !== undefined ? { note: result.note } : {}),
    }];
    return result.findings.map((finding) => buildTelemetryFinding(finding, evaluatedAt));
  }
}
