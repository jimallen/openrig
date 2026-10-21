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
 * TIME BUDGET SEAM (owned by Stage A2a, not built here): better-sqlite3 cannot interrupt a
 * running statement, so these sources bound their input by a row cap (`rowLimit`) exactly as
 * A1's D4 source does. A2a's per-source time budget is to wrap `RsiFindingSource.read()` from
 * outside; nothing in this file reads a clock to cut a query short.
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

/**
 * The sum-to-total control. A partition of a population into disjoint parts must add up to a
 * total counted by an INDEPENDENT statement; a mismatch means a predicate dropped or doubled
 * rows, and the source reports `unavailable` (it throws) rather than a count it cannot vouch for.
 */
export function assertPartitionSumsToTotal(label: string, parts: ReadonlyArray<readonly [string, number]>, total: number): void {
  const sum = parts.reduce((acc, [, n]) => acc + n, 0);
  if (sum !== total) {
    throw new Error(`${label}: parts ${parts.map(([name, n]) => `${name}=${n}`).join(", ")} sum to ${sum}, not the counted total ${total}`);
  }
}

export function partitionText(parts: ReadonlyArray<readonly [string, number]>, total: number): string {
  return `${parts.map(([name, n]) => `${name} ${n}`).join(", ")} = ${total}`;
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
      order: result.order,
    }];
    return result.findings.map((finding) => buildTelemetryFinding(finding, evaluatedAt));
  }
}
