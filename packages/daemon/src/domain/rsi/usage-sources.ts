import { RETENTION_SWEEP_INTERVAL_MS } from "../queue-retention.js";
import { RSI_CONTEXT_HIGH_WATER, RSI_PROVIDER_WEEKLY_WINDOW, RSI_RETENTION_LAG } from "./detector-ids.js";
import {
  RsiFindingSource, hoursBefore, partitionText,
  type RsiFindingSourceDeps, type SourceContext, type SourceResult,
} from "./finding-builder.js";

/**
 * The `usage_samples` detectors: D6 context high-water, D7 provider weekly window, D10
 * retention lag. `captured_at` is always an ISO instant with a Z (the store writes it that
 * way), so string comparison against an ISO cutoff is exact. Each source is ONE grouped
 * statement; firing, quiet and the sample split are derived in JS.
 *
 * Readings (also listed in the PR report):
 *  - D6 (Jim's decision): a seat fires when it has at least 3 context samples >= 90 % in the
 *    trailing 7 days. The latest sample is NOT the test: a seat's context always drops after a
 *    compaction or handover, so a latest-sample reading is blind to the high-water mark.
 *  - D7 judges the provider SOURCE, not each seat (the weekly window is account-wide): the latest
 *    weekly sample of a source inside the last 24 h is >= 95 % AND its `resets_at` is still in the
 *    future (strictly: a window that resets exactly now has reset).
 */
export const CONTEXT_HIGH_WATER_PERCENT = 90;
export const CONTEXT_HIGH_WATER_MIN_SAMPLES = 3;
export const CONTEXT_HIGH_WATER_WINDOW_HOURS = 24 * 7;
export const PROVIDER_WEEKLY_WINDOW_PERCENT = 95;
export const PROVIDER_WEEKLY_WINDOW_FRESH_HOURS = 24;
/** Slack past `retention + sweep interval` before a surviving old row counts as a defect: the
 * sweep deletes in bounded batches, so one tick may take a little longer than its interval. */
export const RETENTION_LAG_SLACK_HOURS = 1;

const ISO = (date: Date): string => date.toISOString();

interface ContextRow {
  seat: string; samples: number; high_n: number; below_n: number; null_n: number; peak: number | null;
  first_id: number | null; last_id: number | null; first_seen: string | null; last_seen: string | null;
}

/** D6: a seat has at least 3 context samples at or above 90 % in the last 7 days. */
export class ContextHighWaterSource extends RsiFindingSource {
  readonly name = "rsi-context-high-water";
  readonly detectors = [RSI_CONTEXT_HIGH_WATER];

  protected query({ db, now, limit }: SourceContext): SourceResult {
    const since = ISO(hoursBefore(now, CONTEXT_HIGH_WATER_WINDOW_HOURS));
    const pct = CONTEXT_HIGH_WATER_PERCENT;
    const rows = db.prepare(`SELECT seat_session AS seat, count(*) AS samples,
        sum(CASE WHEN used_percentage >= ? THEN 1 ELSE 0 END) AS high_n,
        sum(CASE WHEN used_percentage < ? THEN 1 ELSE 0 END) AS below_n,
        sum(CASE WHEN used_percentage IS NULL THEN 1 ELSE 0 END) AS null_n,
        max(used_percentage) AS peak,
        min(CASE WHEN used_percentage >= ? THEN id END) AS first_id, max(CASE WHEN used_percentage >= ? THEN id END) AS last_id,
        min(CASE WHEN used_percentage >= ? THEN captured_at END) AS first_seen, max(CASE WHEN used_percentage >= ? THEN captured_at END) AS last_seen
      FROM usage_samples WHERE lane = 'context' AND captured_at >= ? GROUP BY seat_session`).all(pct, pct, pct, pct, pct, pct, since) as ContextRow[];

    const measured = rows.filter((row) => row.high_n + row.below_n > 0);
    const firing = measured.filter((row) => row.high_n >= CONTEXT_HIGH_WATER_MIN_SAMPLES)
      .sort((a, b) => b.high_n - a.high_n || (a.seat < b.seat ? -1 : a.seat > b.seat ? 1 : 0));
    const quiet = measured.length - firing.length;
    const sampleParts = [
      ["at or above", rows.reduce((n, row) => n + row.high_n, 0)],
      ["below", rows.reduce((n, row) => n + row.below_n, 0)],
      ["unmeasured", rows.reduce((n, row) => n + row.null_n, 0)],
    ] as const;

    return {
      total: firing.length, unit: "seats", order: "samples at or above the line desc, seat",
      findings: firing.slice(0, limit).map((row) => ({
        detectorId: RSI_CONTEXT_HIGH_WATER, className: "seat-context-high-water", subjectKey: `seat:${row.seat}`,
        scope: { type: "instance", instanceId: this.deps.instanceId },
        count: row.high_n, controlTotal: quiet, population: measured.length,
        firstSeq: row.first_id!, lastSeq: row.last_id!, firstSeen: row.first_seen!, lastSeen: row.last_seen!,
        summary: `Seat ${row.seat} had ${row.high_n} of ${row.samples} context samples at or above ${pct}% in the last ${CONTEXT_HIGH_WATER_WINDOW_HOURS / 24} days (peak ${row.peak}%).`,
        threshold: `a seat has >= ${CONTEXT_HIGH_WATER_MIN_SAMPLES} context usage samples >= ${pct}% within ${CONTEXT_HIGH_WATER_WINDOW_HOURS / 24} days`,
        explanation: `${firing.length} seat(s) fire and ${quiet} do not, out of ${measured.length} seats with a measured sample. Context samples in the window: ${partitionText(sampleParts)}. Fix lands in a persona (handover discipline).`,
        suggestedInspection: `Inspect the handover discipline and context use of seat ${row.seat}.`,
      })),
    };
  }
}

interface WeeklyRow {
  src: string; samples: number; high_n: number; below_n: number; null_n: number; latest: number | null; latest_resets: string | null;
  first_id: number | null; last_id: number | null; first_seen: string | null; last_seen: string | null;
}

/** D7: the latest weekly provider-window sample of a source is at or above 95 % and unexpired. */
export class ProviderWeeklyWindowSource extends RsiFindingSource {
  readonly name = "rsi-provider-weekly-window";
  readonly detectors = [RSI_PROVIDER_WEEKLY_WINDOW];

  protected query({ db, now, limit }: SourceContext): SourceResult {
    const since = ISO(hoursBefore(now, PROVIDER_WEEKLY_WINDOW_FRESH_HOURS));
    const nowIso = ISO(now);
    const pct = PROVIDER_WEEKLY_WINDOW_PERCENT;
    // rn = 1 is the newest MEASURED sample of the source (unmeasured samples sort last).
    const rows = db.prepare(`WITH w AS (
        SELECT id, coalesce(source, '(unattributed)') AS src, window_used_percent AS pct, captured_at, resets_at,
          row_number() OVER (PARTITION BY coalesce(source, '(unattributed)') ORDER BY (window_used_percent IS NULL), captured_at DESC, id DESC) AS rn
        FROM usage_samples WHERE lane = 'provider_window' AND window = 'weekly' AND captured_at >= ?)
      SELECT src, count(*) AS samples,
        sum(CASE WHEN pct >= ? THEN 1 ELSE 0 END) AS high_n, sum(CASE WHEN pct < ? THEN 1 ELSE 0 END) AS below_n,
        sum(CASE WHEN pct IS NULL THEN 1 ELSE 0 END) AS null_n,
        max(CASE WHEN rn = 1 THEN pct END) AS latest, max(CASE WHEN rn = 1 THEN resets_at END) AS latest_resets,
        min(CASE WHEN pct >= ? THEN id END) AS first_id, max(CASE WHEN pct >= ? THEN id END) AS last_id,
        min(CASE WHEN pct >= ? THEN captured_at END) AS first_seen, max(CASE WHEN pct >= ? THEN captured_at END) AS last_seen
      FROM w GROUP BY src`).all(since, pct, pct, pct, pct, pct, pct) as WeeklyRow[];

    const measured = rows.filter((row) => row.latest !== null);
    const firing = measured.filter((row) => row.latest! >= pct && (row.latest_resets === null || row.latest_resets > nowIso))
      .sort((a, b) => b.latest! - a.latest! || (a.src < b.src ? -1 : a.src > b.src ? 1 : 0));
    const quiet = measured.length - firing.length;
    const sampleParts = [
      ["at or above", rows.reduce((n, row) => n + row.high_n, 0)],
      ["below", rows.reduce((n, row) => n + row.below_n, 0)],
      ["unmeasured", rows.reduce((n, row) => n + row.null_n, 0)],
    ] as const;

    return {
      total: firing.length, unit: "provider sources", order: "latest weekly percentage desc, source",
      findings: firing.slice(0, limit).map((row) => ({
        detectorId: RSI_PROVIDER_WEEKLY_WINDOW, className: "provider-weekly-window-saturated", subjectKey: `source:${row.src}`,
        scope: { type: "instance", instanceId: this.deps.instanceId },
        count: row.high_n, controlTotal: quiet, population: measured.length,
        firstSeq: row.first_id!, lastSeq: row.last_id!, firstSeen: row.first_seen!, lastSeen: row.last_seen!,
        summary: `The weekly provider window of ${row.src} is at ${row.latest}%${row.latest_resets ? ` until ${row.latest_resets}` : ""}.`,
        threshold: `the latest weekly provider-window sample of a source within ${PROVIDER_WEEKLY_WINDOW_FRESH_HOURS} h is >= ${pct}% and its resets_at is in the future`,
        explanation: `${firing.length} source(s) fire and ${quiet} do not, out of ${measured.length} with a measured weekly sample. Weekly samples in the window: ${partitionText(sampleParts)}. Fix lands in a spec (runtime mix); this is also the RSI budget brake input.`,
        suggestedInspection: `Inspect which seats of ${row.src} consume the weekly window and whether the runtime mix should change.`,
      })),
    };
  }
}

/** D10 dependencies: the live retention setting, read on every scan so a tuned value moves the line. */
export interface RetentionLagDeps extends RsiFindingSourceDeps {
  retentionDays: () => number;
}

/** D10: `usage_samples` rows older than retention + one sweep interval + slack still exist. */
export class RetentionLagSource extends RsiFindingSource {
  readonly name = "rsi-retention-lag";
  readonly detectors = [RSI_RETENTION_LAG];

  constructor(private readonly lagDeps: RetentionLagDeps) {
    super(lagDeps);
  }

  protected query({ db, now }: SourceContext): SourceResult {
    const retentionDays = this.lagDeps.retentionDays();
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) throw new Error(`retention days must be a positive number, got ${retentionDays}`);
    const retentionMs = retentionDays * 24 * 3_600_000;
    const retentionCutoff = ISO(new Date(now.getTime() - retentionMs));
    const lineMs = retentionMs + RETENTION_SWEEP_INTERVAL_MS + RETENTION_LAG_SLACK_HOURS * 3_600_000;
    const line = ISO(new Date(now.getTime() - lineMs));
    const r = db.prepare(`SELECT count(*) AS total,
        sum(CASE WHEN captured_at < ? THEN 1 ELSE 0 END) AS past, sum(CASE WHEN captured_at < ? AND captured_at >= ? THEN 1 ELSE 0 END) AS lag,
        min(CASE WHEN captured_at < ? THEN id END) AS first_id, max(CASE WHEN captured_at < ? THEN id END) AS last_id,
        min(CASE WHEN captured_at < ? THEN captured_at END) AS first_seen, max(CASE WHEN captured_at < ? THEN captured_at END) AS last_seen
      FROM usage_samples`).get(line, retentionCutoff, line, line, line, line, line) as {
      total: number; past: number | null; lag: number | null; first_id: number | null; last_id: number | null; first_seen: string | null; last_seen: string | null;
    };
    const past = r.past ?? 0;
    if (past === 0) return { findings: [], total: 0, unit: "tables", order: "single table" };
    const lag = r.lag ?? 0;
    const parts = [["past the line", past], ["expected lag", lag], ["within retention", r.total - past - lag]] as const;

    return {
      total: 1, unit: "tables", order: "single table",
      findings: [{
        detectorId: RSI_RETENTION_LAG, className: "usage-samples-retention-lag", subjectKey: "table:usage_samples",
        scope: { type: "instance", instanceId: this.deps.instanceId },
        count: past, controlTotal: r.total - past, population: r.total,
        firstSeq: r.first_id!, lastSeq: r.last_id!, firstSeen: r.first_seen!, lastSeen: r.last_seen!,
        summary: `${past} usage_samples rows are older than the retention sweep should leave (line ${line}).`,
        threshold: `usage_samples.captured_at is older than retention (${retentionDays} d) + sweep interval (${RETENTION_SWEEP_INTERVAL_MS / 3_600_000} h) + slack (${RETENTION_LAG_SLACK_HOURS} h)`,
        explanation: `${past} of ${r.total} rows are past the line; the rows between retention and the line are the sweep's expected lag. usage_samples rows: ${partitionText(parts)}. Fix lands in OpenRig code (the retention sweep).`,
        suggestedInspection: "Inspect whether the daily retention sweep ran, errored, or is disabled (retention.enabled).",
      }],
    };
  }
}
