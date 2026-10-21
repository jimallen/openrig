import type Database from "better-sqlite3";
import type { HealthDetectorObservation, HealthObservationSource, HealthSourceCoverage } from "../health-detectors.js";
import { parseSqliteUtcMs } from "../sqlite-time.js";
import {
  RSI_BOOTSTRAP_FAILURE_CLASS,
  RSI_STARTUP_FAILURE_CLASS,
} from "./detector-ids.js";
import { rsiFingerprint } from "./fingerprint.js";
import { classifyBootstrapFailure, classifyStartupFailure, eventErrorText } from "./failure-classes.js";
import {
  anchorFor, describeAnchorEffects, isHistoricalFixed, readKnownFixes, refusalsFor, regressionClass,
  type HistoricalFixedHits, type RefusedAnchor,
} from "./known-fixes.js";
import { RsiReadBudget, type RsiReadBudgetOptions } from "./read-budget.js";
import { openRsiReadOnlyDatabase } from "./telemetry-source.js";
import {
  buildTelemetryFinding, RSI_CLASS_RECURRENCE_THRESHOLD, RSI_CLASS_WINDOW_DAYS,
  RSI_LOCAL_INSTANCE_SCOPE, sqliteUtcStamp, unavailableCoverage,
} from "./telemetry-finding.js";

/** Most events one read examines (rows past it are reported as `partial`, never as zero). */
export const RSI_EVENT_ROW_LIMIT = 5_000;

export interface EventClassDetector {
  detectorId: string;
  /** Source name shown in coverage. */
  sourceName: string;
  eventType: string;
  classify(error: string | null): string;
}

/** D1: the same normalised class of `node.startup_failed` recurs. */
export const STARTUP_FAILURE_DETECTOR: EventClassDetector = {
  detectorId: RSI_STARTUP_FAILURE_CLASS,
  sourceName: "rsi-startup-failure-class",
  eventType: "node.startup_failed",
  classify: classifyStartupFailure,
};

/** D2: the same normalised class of `bootstrap.failed` recurs. */
export const BOOTSTRAP_FAILURE_DETECTOR: EventClassDetector = {
  detectorId: RSI_BOOTSTRAP_FAILURE_CLASS,
  sourceName: "rsi-bootstrap-failure-class",
  eventType: "bootstrap.failed",
  classify: classifyBootstrapFailure,
};

interface EventRow { seq: number; created_at: string; payload: string }
interface Hit { seq: number; ms: number; createdAt: string }

export interface EventClassSourceDeps {
  dbPath: string;
  knownFixesPath: string;
  now?: () => Date;
  rowLimit?: number;
  budget?: RsiReadBudgetOptions;
}

/**
 * D1 and D2 share one shape: group the events of one type in the last 7 days by closed class,
 * and fire for a class that recurs at least three times. The class is part of the fingerprint
 * (`<detector>/class:<class>`). Known-fix anchors are applied per class, regression-only.
 */
export class EventClassHealthSource implements HealthObservationSource {
  readonly name: string;
  readonly detectors: readonly string[];
  private db: Database.Database | null = null;
  private lastCoverage: HealthSourceCoverage[] = [];
  private lastHistorical: HistoricalFixedHits[] = [];
  private lastRefused: readonly RefusedAnchor[] = [];
  private readonly budget: RsiReadBudget;

  constructor(private readonly detector: EventClassDetector, private readonly deps: EventClassSourceDeps) {
    this.name = detector.sourceName;
    this.detectors = [detector.detectorId];
    this.budget = new RsiReadBudget(deps.budget);
  }

  readonlyHandle(): Database.Database {
    return this.db ??= openRsiReadOnlyDatabase(this.deps.dbPath);
  }

  coverage(): readonly HealthSourceCoverage[] {
    return this.lastCoverage;
  }

  /** Classes whose hits all predate a known fix (`historical-fixed:<ref>`); never active. */
  historicalFixed(): readonly HistoricalFixedHits[] {
    return this.lastHistorical;
  }

  /** Anchors refused on the last read that name this detector or cannot be attributed (by index). */
  refusedAnchors(): readonly RefusedAnchor[] {
    return this.lastRefused;
  }

  read(): readonly HealthDetectorObservation[] {
    this.lastCoverage = [];
    this.lastHistorical = [];
    this.lastRefused = [];
    const now = (this.deps.now ?? (() => new Date()))();
    const evaluatedAt = now.toISOString();
    const fixes = readKnownFixes(this.deps.knownFixesPath, now);
    if (fixes.status === "unavailable") {
      this.lastCoverage = [unavailableCoverage(this.name, evaluatedAt, fixes.reason)];
      return [];
    }
    this.lastRefused = refusalsFor(fixes, this.detector.detectorId);

    const db = this.readonlyHandle();
    const limit = this.deps.rowLimit ?? RSI_EVENT_ROW_LIMIT;
    const windowStart = sqliteUtcStamp(new Date(now.getTime() - RSI_CLASS_WINDOW_DAYS * 86_400_000));
    const byClass = new Map<string, Hit[]>();
    let total = 0;
    let evaluated = 0;
    db.transaction(() => {
      total = (db.prepare("SELECT count(*) AS n FROM events WHERE type = ? AND created_at >= ?").get(this.detector.eventType, windowStart) as { n: number }).n;
      this.budget.start();
      for (const row of db.prepare("SELECT seq, created_at, payload FROM events WHERE type = ? AND created_at >= ? ORDER BY seq DESC LIMIT ?")
        .iterate(this.detector.eventType, windowStart, limit) as IterableIterator<EventRow>) {
        if (this.budget.exceeded()) break;
        const cls = this.detector.classify(eventErrorText(row.payload));
        byClass.set(cls, [...byClass.get(cls) ?? [], { seq: row.seq, ms: parseSqliteUtcMs(row.created_at), createdAt: row.created_at }]);
        evaluated++;
      }
    })();
    const judged = [...byClass].sort(([a], [b]) => a.localeCompare(b)).map(([cls, hits]) => {
      const subjectKey = `class:${cls}`;
      const fingerprint = rsiFingerprint(this.detector.detectorId, subjectKey);
      const verdict = anchorFor(fixes, fingerprint);
      const historical = hits.filter((hit) => isHistoricalFixed(verdict, hit.ms));
      const active = hits.filter((hit) => !isHistoricalFixed(verdict, hit.ms));
      if (historical.length > 0 && verdict.anchor) {
        this.lastHistorical.push({ fingerprint, label: `historical-fixed:${verdict.anchor.ref}`, count: historical.length });
      }
      return { cls, subjectKey, verdict, historical, active };
    });
    // What the anchors did on this read, served on the coverage row (and beside every finding).
    const anchorNote = describeAnchorEffects(this.lastHistorical, this.lastRefused);
    this.lastCoverage = [{
      source: this.name, evaluatedAt, unit: "events", limit, total, evaluated,
      omitted: Math.max(0, total - evaluated), partial: evaluated < total, order: "seq, newest first",
      ...(anchorNote !== undefined ? { note: anchorNote } : {}),
    }];

    const observations: HealthDetectorObservation[] = [];
    for (const { cls, subjectKey, verdict, historical, active } of judged) {
      if (active.length < RSI_CLASS_RECURRENCE_THRESHOLD) continue;
      const seen = active.map((hit) => hit.ms);
      const findingClass = regressionClass(verdict, cls);
      const regression = verdict.anchor !== null;
      observations.push(buildTelemetryFinding({
        detectorId: this.detector.detectorId, subjectKey, scope: RSI_LOCAL_INSTANCE_SCOPE, findingClass,
        count: active.length, controlTotal: evaluated, population: total,
        firstSeq: Math.min(...active.map((hit) => hit.seq)), lastSeq: Math.max(...active.map((hit) => hit.seq)),
        firstSeen: new Date(Math.min(...seen)).toISOString(), lastSeen: new Date(Math.max(...seen)).toISOString(),
        evaluatedAt,
        summary: regression
          ? `${this.detector.eventType} class ${cls} recurred ${active.length} times after fix ${verdict.anchor!.ref} was deployed.`
          : `${this.detector.eventType} class ${cls} recurred ${active.length} times in ${RSI_CLASS_WINDOW_DAYS} days.`,
        threshold: `the same ${this.detector.eventType} class occurs at least ${RSI_CLASS_RECURRENCE_THRESHOLD} times in ${RSI_CLASS_WINDOW_DAYS} days${regression ? ", counting only events at or after the known fix's deployment" : ""}`,
        explanation: `${active.length} of ${evaluated} examined ${this.detector.eventType} events in the window are class ${cls}`
          + `${historical.length > 0 ? ` (${historical.length} older hits are historical-fixed)` : ""}; the window holds ${total} such events in all.`
          + `${anchorNote !== undefined ? ` Anchors: ${anchorNote}.` : ""}`,
        suggestedInspection: `List the ${this.detector.eventType} events of class ${cls} (seq ${Math.min(...active.map((hit) => hit.seq))}..${Math.max(...active.map((hit) => hit.seq))}) with the events route and compare their cause.`,
      }));
    }
    return observations;
  }
}
