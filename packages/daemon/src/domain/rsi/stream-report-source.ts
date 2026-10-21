import { RSI_PROJECT_REPORT } from "./detector-ids.js";
import {
  RsiFindingSource, assertPartitionSumsToTotal, hoursBefore, partitionText,
  type SourceContext, type SourceResult,
} from "./finding-builder.js";

/**
 * D14: project-rig reports (rev2 §5.4, R5). A project rig emits
 * `rig stream emit --hint-tags rsi-report,rsi-class:<class> --body <pointer>`. This detector
 * counts those stream items per (reporting rig, class). It NEVER selects the body: a report is
 * a number, and its text cannot become a proposal.
 *
 * Narrowest readings chosen where the design is silent (listed in the PR report):
 *  - A report is live while it is un-archived and emitted in the last 7 days; one report is enough
 *    (a deliberate act by a project rig has no volume threshold to reach).
 *  - The reporting rig is the part of `source_session` after the first `@`; no `@` means `(unattributed)`.
 *  - The class list is closed; any other or missing `rsi-class:` tag counts as `other`.
 */
export const PROJECT_REPORT_WINDOW_HOURS = 24 * 7;
export const PROJECT_REPORT_TAG = "rsi-report";
export const PROJECT_REPORT_CLASS_PREFIX = "rsi-class:";
export const PROJECT_REPORT_CLASSES = [
  "compaction-storm", "context-high-water", "permission-stall", "outbox-unsettled", "delivery-failure",
] as const;

const classList = PROJECT_REPORT_CLASSES.map((name) => `'${name}'`).join(", ");

interface ReportGroup { rig: string; cls: string; n: number; first_id: number; last_id: number; first_seen: string; last_seen: string }

export class ProjectReportSource extends RsiFindingSource {
  readonly name = "rsi-project-report";
  readonly detectors = [RSI_PROJECT_REPORT];

  protected query({ db, now, limit }: SourceContext): SourceResult {
    const since = hoursBefore(now, PROJECT_REPORT_WINDOW_HOURS).toISOString();
    // No body column is selected anywhere in this source.
    const items = `WITH items AS (
        SELECT rowid AS rid, ts_emitted, source_session,
          CASE WHEN json_valid(hint_tags) THEN hint_tags ELSE '[]' END AS tags
        FROM stream_items WHERE archived_at IS NULL AND ts_emitted >= ?),
      reports AS (
        SELECT rid, ts_emitted,
          CASE WHEN instr(source_session, '@') > 0 THEN substr(source_session, instr(source_session, '@') + 1) ELSE '(unattributed)' END AS rig,
          coalesce((SELECT substr(value, ${PROJECT_REPORT_CLASS_PREFIX.length + 1}) FROM json_each(items.tags)
            WHERE typeof(value) = 'text' AND substr(value, 1, ${PROJECT_REPORT_CLASS_PREFIX.length}) = '${PROJECT_REPORT_CLASS_PREFIX}' ORDER BY key LIMIT 1), '') AS raw_class
        FROM items WHERE EXISTS (SELECT 1 FROM json_each(items.tags) WHERE typeof(value) = 'text' AND value = '${PROJECT_REPORT_TAG}')),
      classed AS (
        SELECT rid, ts_emitted, rig, CASE WHEN raw_class IN (${classList}) THEN raw_class ELSE 'other' END AS cls FROM reports)`;
    const groups = db.prepare(`${items}
      SELECT rig, cls, count(*) AS n, min(rid) AS first_id, max(rid) AS last_id, min(ts_emitted) AS first_seen, max(ts_emitted) AS last_seen
      FROM classed GROUP BY rig, cls ORDER BY n DESC, rig, cls LIMIT ?`).all(since, limit) as ReportGroup[];
    const firing = (db.prepare(`${items} SELECT count(*) AS n FROM (SELECT 1 FROM classed GROUP BY rig, cls)`).get(since) as { n: number }).n;
    const reports = (db.prepare(`${items} SELECT count(*) AS n FROM reports`).get(since) as { n: number }).n;
    const population = (db.prepare(`${items} SELECT count(*) AS n FROM items`).get(since) as { n: number }).n;
    const ordinary = (db.prepare(`${items} SELECT count(*) AS n FROM items WHERE rid NOT IN (SELECT rid FROM reports)`).get(since) as { n: number }).n;
    const classes = db.prepare(`${items} SELECT cls, count(*) AS n FROM classed GROUP BY cls ORDER BY cls`).all(since) as Array<{ cls: string; n: number }>;

    // Sum-to-total controls: stream items split into reports and ordinary traffic, and the
    // reports split over the closed class list plus `other`.
    assertPartitionSumsToTotal(`${RSI_PROJECT_REPORT} stream items`, [["reports", reports], ["ordinary", ordinary]], population);
    const classParts = classes.map((row) => [row.cls, row.n] as const);
    assertPartitionSumsToTotal(`${RSI_PROJECT_REPORT} reports`, classParts, reports);

    return {
      total: firing, unit: "rig and class pairs", order: "reports desc, rig, class",
      findings: groups.map((row) => ({
        detectorId: RSI_PROJECT_REPORT, className: `project-report:${row.cls}`, subjectKey: `rig:${row.rig}:class:${row.cls}`,
        scope: { type: "instance", instanceId: this.deps.instanceId },
        count: row.n, controlTotal: ordinary, population,
        firstSeq: row.first_id, lastSeq: row.last_id, firstSeen: row.first_seen, lastSeen: row.last_seen,
        summary: `Project rig ${row.rig} filed ${row.n} ${PROJECT_REPORT_TAG} report${row.n === 1 ? "" : "s"} of class ${row.cls} in the last ${PROJECT_REPORT_WINDOW_HOURS / 24} days.`,
        threshold: `at least 1 un-archived stream item tagged ${PROJECT_REPORT_TAG} from a rig, emitted within ${PROJECT_REPORT_WINDOW_HOURS / 24} days, per ${PROJECT_REPORT_CLASS_PREFIX}<class>`,
        explanation: `${firing} rig and class pair(s) report; ${reports} report(s) among ${population} stream items, ${ordinary} of them ordinary traffic. Reports by class: ${partitionText(classParts, reports)}. The report body is never read; open the stream item by id.`,
        suggestedInspection: `List the ${PROJECT_REPORT_TAG} stream items from rig ${row.rig} and read the pointer they carry.`,
      })),
    };
  }
}
