import type Database from "better-sqlite3";
import type { HealthDetectorObservation, HealthObservationSource, HealthSourceCoverage } from "../health-detectors.js";
import { PARKED_OWNER_POLICY_NAME, rigFromAnchor } from "../policies/parked-owner-consumer.js";
import { parseSqliteUtcMs } from "../sqlite-time.js";
import { RSI_ORPHANED_PARKED_OWNER_JOB } from "./detector-ids.js";
import { rsiFingerprint } from "./fingerprint.js";
import {
  anchorFor, describeAnchorEffects, isHistoricalFixed, readKnownFixes, refusalsFor, regressionClass,
  type HistoricalFixedHits, type RefusedAnchor,
} from "./known-fixes.js";
import { buildTelemetryFinding, unavailableCoverage } from "./finding-builder.js";
import { RsiReadBudget, type RsiReadBudgetOptions } from "./read-budget.js";
import { openRsiReadOnlyDatabase } from "./telemetry-source.js";

export const RSI_JOB_ROW_LIMIT = 5_000;
export const ORPHANED_PARKED_OWNER_JOB_CLASS = "parked-owner-job-without-live-rig";
const SUBJECT_KEY = "parked-owner-jobs-without-live-rig";

interface JobRow { seq: number; target_session: string; registered_at: string }

/** The two controls D3 reports beside its count. */
export interface OrphanedJobControls {
  /** Active `parked-owner-consumer` jobs examined (the population). */
  activeParkedOwnerJobs: number;
  /** Of those, the jobs whose rig has an un-archived row (the negative control). */
  liveRigJobs: number;
  /** Distinct rig names across ALL rig rows, archived included. */
  distinctRigNames: number;
}

/**
 * D3: an active `parked-owner-consumer` watchdog job whose target rig has no un-archived row.
 * ONLY that policy is judged (the digest-flush jobs target `delivery-digest-*@kernel`, which
 * is not a rig). The target rig is read with the policy's own `rigFromAnchor`, not by joining
 * `sessions`. Two controls: the population of parked-owner jobs, and the identity "active
 * parked-owner jobs == distinct rig names", which holds exactly when the boot loop has
 * re-armed a job for every rig name that ever existed, archived or not.
 */
export class OrphanedParkedOwnerJobSource implements HealthObservationSource {
  readonly name = "rsi-orphaned-parked-owner-job";
  readonly detectors = [RSI_ORPHANED_PARKED_OWNER_JOB];
  private db: Database.Database | null = null;
  private lastCoverage: HealthSourceCoverage[] = [];
  private lastHistorical: HistoricalFixedHits[] = [];
  private lastRefused: readonly RefusedAnchor[] = [];
  private lastControls: OrphanedJobControls | null = null;
  private readonly budget: RsiReadBudget;

  constructor(private readonly deps: {
    dbPath: string; knownFixesPath: string; instanceId: string; now?: () => Date; rowLimit?: number; budget?: RsiReadBudgetOptions;
  }) {
    this.budget = new RsiReadBudget(deps.budget);
  }

  readonlyHandle(): Database.Database {
    return this.db ??= openRsiReadOnlyDatabase(this.deps.dbPath);
  }

  coverage(): readonly HealthSourceCoverage[] { return this.lastCoverage; }
  historicalFixed(): readonly HistoricalFixedHits[] { return this.lastHistorical; }
  refusedAnchors(): readonly RefusedAnchor[] { return this.lastRefused; }
  controls(): OrphanedJobControls | null { return this.lastControls; }

  read(): readonly HealthDetectorObservation[] {
    this.lastCoverage = [];
    this.lastHistorical = [];
    this.lastRefused = [];
    this.lastControls = null;
    const now = (this.deps.now ?? (() => new Date()))();
    const evaluatedAt = now.toISOString();
    const fixes = readKnownFixes(this.deps.knownFixesPath, now);
    if (fixes.status === "unavailable") {
      this.lastCoverage = [unavailableCoverage(this.name, evaluatedAt, fixes.reason)];
      return [];
    }
    this.lastRefused = refusalsFor(fixes, RSI_ORPHANED_PARKED_OWNER_JOB);

    const db = this.readonlyHandle();
    const limit = this.deps.rowLimit ?? RSI_JOB_ROW_LIMIT;
    let total = 0;
    let evaluated = 0;
    let distinctRigNames = 0;
    const liveNames = new Set<string>();
    /** `instantMs` is when the job BECAME an orphan: its rig was archived (a job keeps its original
     * `registered_at`, because registration is idempotent), or the job was registered after that.
     * It is null, and the hit is never historical, when that instant is unknown: the name has no rig
     * row at all, or a rig was DELETED after the name's latest archive (a deleted rig leaves no row, so
     * a newer generation of the name may have been orphaned after the fix). */
    const orphans: Array<{ seq: number; instantMs: number | null; seenMs: number }> = [];
    const latestArchivedMs = new Map<string, number>();
    let liveRigJobs = 0;
    const fingerprint = rsiFingerprint(RSI_ORPHANED_PARKED_OWNER_JOB, SUBJECT_KEY);
    const verdict = anchorFor(fixes, fingerprint);
    /** Instant of the latest `rig.deleted` event. That event carries only the rig id, so it cannot be tied
     * to a name: any deletion later than a name's latest archive makes the name's instant unknown (the safe
     * direction). Read only when an anchor governs, since the instant matters only to an anchor. It is the
     * LATEST INSTANT, max(created_at), not the newest row by seq: a clock that stepped back would give a later
     * seq an earlier created_at and hide a later deletion (OF-79 N1-1). idx_events_type_created_at serves it. */
    let latestDeletedMs: number | null = null;
    db.transaction(() => {
      if (verdict.anchor !== null) {
        const deleted = db.prepare("SELECT max(created_at) AS created_at FROM events WHERE type = 'rig.deleted'").get() as { created_at: string | null };
        latestDeletedMs = deleted.created_at === null ? null : parseSqliteUtcMs(deleted.created_at);
      }
      for (const row of db.prepare("SELECT name, archived_at FROM rigs").all() as Array<{ name: string; archived_at: string | null }>) {
        if (row.archived_at === null) liveNames.add(row.name);
        else latestArchivedMs.set(row.name, Math.max(latestArchivedMs.get(row.name) ?? Number.NEGATIVE_INFINITY, parseSqliteUtcMs(row.archived_at)));
      }
      distinctRigNames = (db.prepare("SELECT count(DISTINCT name) AS n FROM rigs").get() as { n: number }).n;
      total = (db.prepare("SELECT count(*) AS n FROM watchdog_jobs WHERE state = 'active' AND policy = ?").get(PARKED_OWNER_POLICY_NAME) as { n: number }).n;
      this.budget.start();
      for (const row of db.prepare("SELECT rowid AS seq, target_session, registered_at FROM watchdog_jobs WHERE state = 'active' AND policy = ? ORDER BY rowid DESC LIMIT ?")
        .iterate(PARKED_OWNER_POLICY_NAME, limit) as IterableIterator<JobRow>) {
        if (this.budget.exceeded()) break;
        const rigName = rigFromAnchor(row.target_session);
        if (liveNames.has(rigName)) liveRigJobs++;
        else {
          const registeredMs = parseSqliteUtcMs(row.registered_at);
          const archivedMs = latestArchivedMs.get(rigName);
          const orphanedMs = archivedMs === undefined ? null : Math.max(registeredMs, archivedMs);
          const deletedAfter = archivedMs !== undefined && latestDeletedMs !== null && latestDeletedMs > archivedMs;
          orphans.push({ seq: row.seq, instantMs: deletedAfter ? null : orphanedMs, seenMs: orphanedMs ?? registeredMs });
        }
        evaluated++;
      }
    })();
    this.lastControls = { activeParkedOwnerJobs: total, liveRigJobs, distinctRigNames };

    const historical = orphans.filter((job) => isHistoricalFixed(verdict, job.instantMs));
    const active = orphans.filter((job) => !isHistoricalFixed(verdict, job.instantMs));
    if (historical.length > 0 && verdict.anchor) {
      this.lastHistorical = [{ fingerprint, label: `historical-fixed:${verdict.anchor.ref}`, count: historical.length }];
    }
    const anchorNote = describeAnchorEffects(this.lastHistorical, this.lastRefused);
    this.lastCoverage = [{
      source: this.name, evaluatedAt, unit: "watchdog jobs", limit, total, evaluated,
      omitted: Math.max(0, total - evaluated), partial: evaluated < total, order: "job rowid, newest first",
      note: [`controls: ${total} active parked-owner jobs, ${liveRigJobs} on a live rig, ${distinctRigNames} distinct rig names`, anchorNote]
        .filter((part): part is string => part !== undefined).join("; "),
    }];
    if (active.length === 0) return [];
    const times = active.map((job) => job.seenMs);
    const identity = total === distinctRigNames;
    return [buildTelemetryFinding({
      detectorId: RSI_ORPHANED_PARKED_OWNER_JOB, subjectKey: SUBJECT_KEY, scope: { type: "instance", instanceId: this.deps.instanceId },
      className: regressionClass(verdict, ORPHANED_PARKED_OWNER_JOB_CLASS),
      count: active.length, controlTotal: liveRigJobs, population: total,
      firstSeq: Math.min(...active.map((job) => job.seq)), lastSeq: Math.max(...active.map((job) => job.seq)),
      firstSeen: new Date(Math.min(...times)).toISOString(), lastSeen: new Date(Math.max(...times)).toISOString(),
      summary: `${active.length} active ${PARKED_OWNER_POLICY_NAME} job${active.length === 1 ? "" : "s"} target a rig with no un-archived row.`,
      threshold: `an active ${PARKED_OWNER_POLICY_NAME} job whose rig (rigFromAnchor of its target) has no un-archived rig row`,
      explanation: `${active.length} of ${total} active ${PARKED_OWNER_POLICY_NAME} jobs are orphaned; control: ${liveRigJobs} target a live rig. `
        + `Active parked-owner jobs ${total} ${identity ? "equal" : "differ from"} the ${distinctRigNames} distinct rig names across all rig rows`
        + `${identity ? ": every name that ever existed has an active job, which is what a boot loop that re-arms archived rigs produces" : ""}.`
        + `${anchorNote !== undefined ? ` Anchors: ${anchorNote}.` : ""}`,
      suggestedInspection: "List the active parked-owner-consumer watchdog jobs, resolve each target's rig, and check which rigs are archived.",
    }, evaluatedAt)];
  }
}
