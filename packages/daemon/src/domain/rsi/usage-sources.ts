import { RETENTION_SWEEP_INTERVAL_MS } from "../queue-retention.js";
import { RSI_CONTEXT_HIGH_WATER, RSI_PROVIDER_WEEKLY_WINDOW, RSI_RETENTION_LAG } from "./detector-ids.js";
import {
  RsiFindingSource, assertPartitionSumsToTotal, hoursBefore, partitionText,
  type RsiFindingSourceDeps, type SourceContext, type SourceResult,
} from "./finding-builder.js";

/**
 * The `usage_samples` detectors: D6 context high-water, D7 provider weekly window, D10
 * retention lag. `captured_at` is always an ISO instant with a Z (the store writes it that
 * way), so string comparison against an ISO cutoff is exact.
 *
 * Narrowest readings chosen where the design is silent (also listed in the PR report):
 *  - D6 fires for a seat only when its LATEST context sample in the trailing 7 days is >= 90 %
 *    (rev1's "44 in the last 7 days" counts samples; the count is evidence, the latest sample decides).
 *    A seat that came back down is not a finding.
 *  - D7 judges the provider SOURCE, not each seat (the weekly window is account-wide): the latest
 *    weekly sample of a source inside the last 24 h is >= 95 % AND its `resets_at` is still in the future.
 */
export const CONTEXT_HIGH_WATER_PERCENT = 90;
export const CONTEXT_HIGH_WATER_WINDOW_HOURS = 24 * 7;
export const PROVIDER_WEEKLY_WINDOW_PERCENT = 95;
export const PROVIDER_WEEKLY_WINDOW_FRESH_HOURS = 24;
/** Slack past `retention + sweep interval` before a surviving old row counts as a defect: the
 * sweep deletes in bounded batches, so one tick may take a little longer than its interval. */
export const RETENTION_LAG_SLACK_HOURS = 1;

const ISO = (date: Date): string => date.toISOString();

interface ContextRow {
  seat: string; high_n: number; samples: number; latest: number;
  first_id: number; last_id: number; first_seen: string; last_seen: string;
}

/** D6: a seat's latest context sample in the last 7 days is at or above 90 %. */
export class ContextHighWaterSource extends RsiFindingSource {
  readonly name = "rsi-context-high-water";
  readonly detectors = [RSI_CONTEXT_HIGH_WATER];

  protected query({ db, now, limit }: SourceContext): SourceResult {
    const since = ISO(hoursBefore(now, CONTEXT_HIGH_WATER_WINDOW_HOURS));
    const win = `WITH win AS (
      SELECT id, seat_session, used_percentage, captured_at,
        row_number() OVER (PARTITION BY seat_session ORDER BY captured_at DESC, id DESC) AS rn
      FROM usage_samples WHERE lane = 'context' AND captured_at >= ? AND used_percentage IS NOT NULL)`;
    const pct = CONTEXT_HIGH_WATER_PERCENT;
    const rows = db.prepare(`${win}
      SELECT seat_session AS seat,
        sum(CASE WHEN used_percentage >= ? THEN 1 ELSE 0 END) AS high_n, count(*) AS samples,
        max(CASE WHEN rn = 1 THEN used_percentage END) AS latest,
        min(CASE WHEN used_percentage >= ? THEN id END) AS first_id, max(CASE WHEN used_percentage >= ? THEN id END) AS last_id,
        min(CASE WHEN used_percentage >= ? THEN captured_at END) AS first_seen, max(CASE WHEN used_percentage >= ? THEN captured_at END) AS last_seen
      FROM win GROUP BY seat_session HAVING latest >= ? ORDER BY latest DESC, seat LIMIT ?`).all(since, pct, pct, pct, pct, pct, pct, limit) as ContextRow[];
    const firing = (db.prepare(`${win} SELECT count(*) AS n FROM (SELECT seat_session FROM win GROUP BY seat_session HAVING max(CASE WHEN rn = 1 THEN used_percentage END) >= ?)`).get(since, pct) as { n: number }).n;
    const quiet = (db.prepare(`${win} SELECT count(*) AS n FROM (SELECT seat_session FROM win GROUP BY seat_session HAVING max(CASE WHEN rn = 1 THEN used_percentage END) < ?)`).get(since, pct) as { n: number }).n;
    const seats = (db.prepare(`${win} SELECT count(DISTINCT seat_session) AS n FROM win`).get(since) as { n: number }).n;
    const parts = db.prepare(`SELECT CASE WHEN used_percentage IS NULL THEN 'unmeasured' WHEN used_percentage >= ? THEN 'at or above' ELSE 'below' END AS part, count(*) AS n
      FROM usage_samples WHERE lane = 'context' AND captured_at >= ? GROUP BY part ORDER BY part`).all(pct, since) as Array<{ part: string; n: number }>;
    const samples = (db.prepare(`SELECT count(*) AS n FROM usage_samples WHERE lane = 'context' AND captured_at >= ?`).get(since) as { n: number }).n;

    assertPartitionSumsToTotal(`${RSI_CONTEXT_HIGH_WATER} seats`, [["firing", firing], ["not firing", quiet]], seats);
    const sampleParts = parts.map((row) => [row.part, row.n] as const);
    assertPartitionSumsToTotal(`${RSI_CONTEXT_HIGH_WATER} samples`, sampleParts, samples);

    return {
      total: firing, unit: "seats", order: "latest context percentage desc, seat",
      findings: rows.map((row) => ({
        detectorId: RSI_CONTEXT_HIGH_WATER, className: "seat-context-high-water", subjectKey: `seat:${row.seat}`,
        scope: { type: "instance", instanceId: this.deps.instanceId },
        count: row.high_n, controlTotal: quiet, population: seats,
        firstSeq: row.first_id, lastSeq: row.last_id, firstSeen: row.first_seen, lastSeen: row.last_seen,
        summary: `Seat ${row.seat}'s latest context sample is ${row.latest}% (${row.high_n} of its ${row.samples} samples in the last 7 days are at or above ${pct}%).`,
        threshold: `the latest context usage sample of a seat within ${CONTEXT_HIGH_WATER_WINDOW_HOURS / 24} days is >= ${pct}%`,
        explanation: `${firing} seat(s) fire and ${quiet} do not, out of ${seats} seats with a sample. Context samples in the window: ${partitionText(sampleParts, samples)}. Fix lands in a persona (handover discipline).`,
        suggestedInspection: `Inspect the handover discipline and context use of seat ${row.seat}.`,
      })),
    };
  }
}

interface WeeklyRow { src: string; high_n: number; latest: number; resets_at: string | null; first_id: number; last_id: number; first_seen: string; last_seen: string }

/** D7: the latest weekly provider-window sample of a source is at or above 95 % and unexpired. */
export class ProviderWeeklyWindowSource extends RsiFindingSource {
  readonly name = "rsi-provider-weekly-window";
  readonly detectors = [RSI_PROVIDER_WEEKLY_WINDOW];

  protected query({ db, now, limit }: SourceContext): SourceResult {
    const since = ISO(hoursBefore(now, PROVIDER_WEEKLY_WINDOW_FRESH_HOURS));
    const nowIso = ISO(now);
    const pct = PROVIDER_WEEKLY_WINDOW_PERCENT;
    const win = `WITH win AS (
      SELECT id, coalesce(source, '(unattributed)') AS src, window_used_percent AS pct, captured_at, resets_at,
        row_number() OVER (PARTITION BY coalesce(source, '(unattributed)') ORDER BY captured_at DESC, id DESC) AS rn
      FROM usage_samples WHERE lane = 'provider_window' AND window = 'weekly' AND captured_at >= ? AND window_used_percent IS NOT NULL)`;
    // A source fires when its newest sample is saturated and its window has not reset yet.
    const latestFires = `max(CASE WHEN rn = 1 AND pct >= ? AND (resets_at IS NULL OR resets_at > ?) THEN 1 ELSE 0 END) = 1`;
    const rows = db.prepare(`${win}
      SELECT src, sum(CASE WHEN pct >= ? THEN 1 ELSE 0 END) AS high_n, max(CASE WHEN rn = 1 THEN pct END) AS latest,
        max(CASE WHEN rn = 1 THEN resets_at END) AS resets_at,
        min(CASE WHEN pct >= ? THEN id END) AS first_id, max(CASE WHEN pct >= ? THEN id END) AS last_id,
        min(CASE WHEN pct >= ? THEN captured_at END) AS first_seen, max(CASE WHEN pct >= ? THEN captured_at END) AS last_seen
      FROM win GROUP BY src HAVING ${latestFires} ORDER BY latest DESC, src LIMIT ?`).all(since, pct, pct, pct, pct, pct, pct, nowIso, limit) as WeeklyRow[];
    const firing = (db.prepare(`${win} SELECT count(*) AS n FROM (SELECT src FROM win GROUP BY src HAVING ${latestFires})`).get(since, pct, nowIso) as { n: number }).n;
    const quiet = (db.prepare(`${win} SELECT count(*) AS n FROM (SELECT src FROM win GROUP BY src HAVING NOT (${latestFires}))`).get(since, pct, nowIso) as { n: number }).n;
    const sources = (db.prepare(`${win} SELECT count(DISTINCT src) AS n FROM win`).get(since) as { n: number }).n;
    const parts = db.prepare(`SELECT CASE WHEN window_used_percent IS NULL THEN 'unmeasured' WHEN window_used_percent >= ? THEN 'at or above' ELSE 'below' END AS part, count(*) AS n
      FROM usage_samples WHERE lane = 'provider_window' AND window = 'weekly' AND captured_at >= ? GROUP BY part ORDER BY part`).all(pct, since) as Array<{ part: string; n: number }>;
    const samples = (db.prepare(`SELECT count(*) AS n FROM usage_samples WHERE lane = 'provider_window' AND window = 'weekly' AND captured_at >= ?`).get(since) as { n: number }).n;

    assertPartitionSumsToTotal(`${RSI_PROVIDER_WEEKLY_WINDOW} sources`, [["firing", firing], ["not firing", quiet]], sources);
    const sampleParts = parts.map((row) => [row.part, row.n] as const);
    assertPartitionSumsToTotal(`${RSI_PROVIDER_WEEKLY_WINDOW} samples`, sampleParts, samples);

    return {
      total: firing, unit: "provider sources", order: "latest weekly percentage desc, source",
      findings: rows.map((row) => ({
        detectorId: RSI_PROVIDER_WEEKLY_WINDOW, className: "provider-weekly-window-saturated", subjectKey: `source:${row.src}`,
        scope: { type: "instance", instanceId: this.deps.instanceId },
        count: row.high_n, controlTotal: quiet, population: sources,
        firstSeq: row.first_id, lastSeq: row.last_id, firstSeen: row.first_seen, lastSeen: row.last_seen,
        summary: `The weekly provider window of ${row.src} is at ${row.latest}%${row.resets_at ? ` until ${row.resets_at}` : ""}.`,
        threshold: `the latest weekly provider-window sample of a source within ${PROVIDER_WEEKLY_WINDOW_FRESH_HOURS} h is >= ${pct}% and its resets_at is in the future`,
        explanation: `${firing} source(s) fire and ${quiet} do not, out of ${sources} with a weekly sample. Weekly samples in the window: ${partitionText(sampleParts, samples)}. Fix lands in a spec (runtime mix); this is also the RSI budget brake input.`,
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
    const stale = db.prepare(`SELECT count(*) AS n, min(id) AS first_id, max(id) AS last_id, min(captured_at) AS first_seen, max(captured_at) AS last_seen
      FROM usage_samples WHERE captured_at < ?`).get(line) as { n: number; first_id: number | null; last_id: number | null; first_seen: string | null; last_seen: string | null };
    const parts = db.prepare(`SELECT CASE WHEN captured_at < ? THEN 'past the line' WHEN captured_at < ? THEN 'expected lag' ELSE 'within retention' END AS part, count(*) AS n
      FROM usage_samples GROUP BY part ORDER BY part`).all(line, retentionCutoff) as Array<{ part: string; n: number }>;
    const rowsTotal = (db.prepare(`SELECT count(*) AS n FROM usage_samples`).get() as { n: number }).n;
    const partList = parts.map((row) => [row.part, row.n] as const);
    assertPartitionSumsToTotal(`${RSI_RETENTION_LAG} rows`, partList, rowsTotal);
    if (stale.n === 0) return { findings: [], total: 0, unit: "tables", order: "single table" };

    return {
      total: 1, unit: "tables", order: "single table",
      findings: [{
        detectorId: RSI_RETENTION_LAG, className: "usage-samples-retention-lag", subjectKey: "table:usage_samples",
        scope: { type: "instance", instanceId: this.deps.instanceId },
        count: stale.n, controlTotal: rowsTotal - stale.n, population: rowsTotal,
        firstSeq: stale.first_id!, lastSeq: stale.last_id!, firstSeen: stale.first_seen!, lastSeen: stale.last_seen!,
        summary: `${stale.n} usage_samples rows are older than the retention sweep should leave (line ${line}).`,
        threshold: `usage_samples.captured_at is older than retention (${retentionDays} d) + sweep interval (${RETENTION_SWEEP_INTERVAL_MS / 3_600_000} h) + slack (${RETENTION_LAG_SLACK_HOURS} h)`,
        explanation: `${stale.n} of ${rowsTotal} rows are past the line; the rows between retention and the line are the sweep's expected lag. usage_samples rows: ${partitionText(partList, rowsTotal)}. Fix lands in OpenRig code (the retention sweep).`,
        suggestedInspection: "Inspect whether the daily retention sweep ran, errored, or is disabled (retention.enabled).",
      }],
    };
  }
}
