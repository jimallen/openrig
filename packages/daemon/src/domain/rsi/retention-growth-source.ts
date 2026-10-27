import { RETENTION_DEFAULTS } from "../queue-retention.js";
import { RSI_RETENTION_DISABLED_GROWTH } from "./detector-ids.js";
import { RsiFindingSource, partitionText, type FindingSpec, type RsiFindingSourceDeps, type SourceContext, type SourceResult } from "./finding-builder.js";

/**
 * D15 (OF-81): the retention sweep is OFF (`retention.enabled=false`, decided once at boot) and a
 * table the sweep would have bounded has grown past a size threshold. D10 deliberately reads a
 * complete zero when the sweep is off (nothing is "lagging"); that left nothing in RSI to say the
 * tables were growing without bound. This is that signal.
 *
 * "Size" is the number of rows the sweep WOULD delete now: rows past the table's live retention
 * window (for watchdog_history, also outside the most-recent-K per job, the sweep's own keep
 * rule). It is relative to the operator's own settings, so a tuned window moves the line, and it
 * ignores the steady-state rows retention would hold anyway.
 *
 * Tables: `usage_samples` and `watchdog_history`, the two telemetry tables with a plain
 * age-delete contract. `queue_transitions` is NOT read: its sweep archives (never deletes) and is
 * gated by a terminal-state and workflow-frontier predicate this source would have to mirror; it
 * is a separate follow-up, not a silent omission.
 */

/**
 * Stale rows (past retention) at which a table fires. Measured read-only on the live fork daemon
 * at 2026-10-27: usage_samples held 36,338 rows over 14.0 days (about 2,600 a day) and
 * watchdog_history 8,703 rows over 33 days. 10,000 is therefore about four days of excess
 * usage_samples (a sweep off for a few days is already worth a person's attention) and more than
 * a whole retained watchdog_history (so it fires only on a real, sustained absence of the sweep),
 * and it is twenty default sweep batches (500), far past anything a single slow sweep leaves.
 */
export const RETENTION_DISABLED_GROWTH_ROWS = 10_000;

/** The coverage note when the sweep is on: D15 did not look, which is not the same as looking and finding nothing. */
export const RETENTION_ENABLED_NOTE = "retention enabled: not evaluated";

export interface RetentionGrowthDeps extends RsiFindingSourceDeps {
  /** False when the daemon runs no retention sweep. When true this source reads a complete zero. Default true. */
  retentionEnabled?: boolean;
  /** Live `retention.usage_samples_days`, read on every scan. */
  usageSamplesDays: () => number;
  /** Live `retention.watchdog_days` and `retention.watchdog_keep_per_job`, read on every scan. */
  watchdog: () => { days: number; keepPerJob: number };
  /** Test seam: the firing threshold. */
  thresholdRows?: number;
}

interface StaleRow { total: number; stale: number | null; first_id: number | null; last_id: number | null; first_seen: string | null; last_seen: string | null }

const nonNegative = (name: string, value: number): number => {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number, got ${value}`);
  return value;
};

export class RetentionDisabledGrowthSource extends RsiFindingSource {
  readonly name = "rsi-retention-disabled-growth";
  readonly detectors = [RSI_RETENTION_DISABLED_GROWTH];

  constructor(private readonly growthDeps: RetentionGrowthDeps) {
    super(growthDeps);
  }

  protected query({ db, now, limit }: SourceContext): SourceResult {
    if (this.growthDeps.retentionEnabled !== false) return { findings: [], total: 0, unit: "tables", order: "table name", note: RETENTION_ENABLED_NOTE };
    const threshold = this.growthDeps.thresholdRows ?? RETENTION_DISABLED_GROWTH_ROWS;
    const cutoff = (days: number): string => new Date(now.getTime() - nonNegative("retention days", days) * 24 * 3_600_000).toISOString();
    const usageDays = this.growthDeps.usageSamplesDays();
    const watchdog = this.growthDeps.watchdog();
    const keep = nonNegative("watchdog keep per job", watchdog.keepPerJob);

    // Same predicates as pruneUsageSamples / pruneWatchdogHistory (queue-retention.ts), as counts.
    const usage = db.prepare(`SELECT count(*) AS total, sum(CASE WHEN captured_at < @cutoff THEN 1 ELSE 0 END) AS stale,
        min(CASE WHEN captured_at < @cutoff THEN id END) AS first_id, max(CASE WHEN captured_at < @cutoff THEN id END) AS last_id,
        min(CASE WHEN captured_at < @cutoff THEN captured_at END) AS first_seen, max(CASE WHEN captured_at < @cutoff THEN captured_at END) AS last_seen
      FROM usage_samples`).get({ cutoff: cutoff(usageDays) }) as StaleRow;
    // "Rows strictly newer in the same job" (the sweep's `>`) is rank() - 1 over the job, newest
    // first: ties share a rank, so a tie at the keep boundary is kept, as the sweep keeps it. One
    // pass over the table. The sweep's own correlated count is quadratic per job, and this runs
    // synchronously on every health read in exactly the regime where the table is unbounded.
    const wd = db.prepare(`SELECT (SELECT count(*) FROM watchdog_history) AS total, count(*) AS stale,
        min(rid) AS first_id, max(rid) AS last_id, min(evaluated_at) AS first_seen, max(evaluated_at) AS last_seen
      FROM (SELECT rowid AS rid, evaluated_at,
              rank() OVER (PARTITION BY job_id ORDER BY evaluated_at DESC) - 1 AS newer
            FROM watchdog_history)
      WHERE evaluated_at < @cutoff AND newer >= @keep`)
      .get({ cutoff: cutoff(watchdog.days), keep }) as StaleRow;

    const defaults = RETENTION_DEFAULTS;
    const specs: FindingSpec[] = [];
    for (const [table, row, windowText] of [
      ["usage_samples", usage, `${usageDays} d`],
      ["watchdog_history", wd, `${watchdog.days} d, keeping the newest ${keep} per job`],
    ] as const) {
      const stale = row.stale ?? 0;
      if (stale < threshold) continue;
      specs.push({
        detectorId: RSI_RETENTION_DISABLED_GROWTH, className: "retained-table-unbounded", subjectKey: `table:${table}`,
        scope: { type: "instance", instanceId: this.deps.instanceId },
        count: stale, controlTotal: row.total - stale, population: row.total,
        firstSeq: row.first_id!, lastSeq: row.last_id!, firstSeen: row.first_seen!, lastSeen: row.last_seen!,
        summary: `${table} holds ${stale} rows past its retention window and nothing is deleting them: retention.enabled is false.`,
        threshold: `retention.enabled is false AND at least ${threshold} ${table} rows are past the retention window (${windowText})`,
        explanation: `${stale} of ${row.total} ${table} rows are rows the retention sweep would delete now: ${partitionText([["past retention", stale], ["within retention", row.total - stale]])}. The sweep is off, so the table grows without bound (defaults: usage_samples ${defaults.usageSamplesRetentionDays} d, watchdog_history ${defaults.watchdogRetentionDays} d).`,
        suggestedInspection: "Inspect retention.enabled and whether turning the retention sweep back on is acceptable; the setting is read once, at daemon start.",
      });
    }
    return { findings: specs.slice(0, limit), total: specs.length, unit: "tables", order: "table name" };
  }
}
