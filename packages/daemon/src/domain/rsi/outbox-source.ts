import { RSI_OUTBOX_UNSETTLED } from "./detector-ids.js";
import {
  RsiFindingSource, assertPartitionSumsToTotal, hoursBefore, partitionText,
  type SourceContext, type SourceResult,
} from "./finding-builder.js";

/**
 * D8: outbox state never settles. Rev1 names the symptom (10,302 `transport:v1` rows `pending`)
 * but no threshold, so the narrowest reading is used (listed in the PR report): per
 * `identity_provenance`, at least 10 un-retired rows are still `pending` more than 24 h after
 * dispatch. A retired row was deliberately taken out of play and is not judged at all.
 */
export const OUTBOX_UNSETTLED_MIN_AGE_HOURS = 24;
export const OUTBOX_UNSETTLED_MIN_ROWS = 10;

const KNOWN_DELIVERY_STATES = `('pending', 'delivered', 'indeterminate', 'failed', 'retained')`;

interface OutboxGroup { prov: string; n: number; first_id: number; last_id: number; first_seen: string; last_seen: string }

export class OutboxUnsettledSource extends RsiFindingSource {
  readonly name = "rsi-outbox-unsettled";
  readonly detectors = [RSI_OUTBOX_UNSETTLED];

  protected query({ db, now, limit }: SourceContext): SourceResult {
    const before = hoursBefore(now, OUTBOX_UNSETTLED_MIN_AGE_HOURS).toISOString();
    const min = OUTBOX_UNSETTLED_MIN_ROWS;
    const live = `WITH live AS (
      SELECT rowid AS rid, coalesce(identity_provenance, '(unattributed)') AS prov, ts_dispatched,
        CASE WHEN delivery_state = 'pending' AND ts_dispatched < ? THEN 1 ELSE 0 END AS hit,
        CASE WHEN delivery_state IN ${KNOWN_DELIVERY_STATES} THEN delivery_state ELSE 'other' END AS cls
      FROM outbox_entries WHERE retired_at IS NULL)`;
    const rows = db.prepare(`${live}
      SELECT prov, count(*) AS n, min(rid) AS first_id, max(rid) AS last_id, min(ts_dispatched) AS first_seen, max(ts_dispatched) AS last_seen
      FROM live WHERE hit = 1 GROUP BY prov HAVING count(*) >= ? ORDER BY n DESC, prov LIMIT ?`).all(before, min, limit) as OutboxGroup[];
    const firing = (db.prepare(`${live} SELECT count(*) AS n FROM (SELECT prov FROM live WHERE hit = 1 GROUP BY prov HAVING count(*) >= ?)`).get(before, min) as { n: number }).n;
    const quiet = (db.prepare(`${live} SELECT count(*) AS n FROM (SELECT prov FROM live GROUP BY prov HAVING sum(hit) < ?)`).get(before, min) as { n: number }).n;
    const provenances = (db.prepare(`${live} SELECT count(DISTINCT prov) AS n FROM live`).get(before) as { n: number }).n;
    const states = db.prepare(`${live} SELECT cls, count(*) AS n FROM live GROUP BY cls ORDER BY cls`).all(before) as Array<{ cls: string; n: number }>;
    const entries = (db.prepare(`${live} SELECT count(*) AS n FROM live`).get(before) as { n: number }).n;

    assertPartitionSumsToTotal(`${RSI_OUTBOX_UNSETTLED} provenances`, [["firing", firing], ["not firing", quiet]], provenances);
    const stateParts = states.map((row) => [row.cls, row.n] as const);
    assertPartitionSumsToTotal(`${RSI_OUTBOX_UNSETTLED} entries`, stateParts, entries);

    return {
      total: firing, unit: "identity provenances", order: "stale pending rows desc, provenance",
      findings: rows.map((row) => ({
        detectorId: RSI_OUTBOX_UNSETTLED, className: "outbox-pending-never-settles", subjectKey: `provenance:${row.prov}`,
        scope: { type: "instance", instanceId: this.deps.instanceId },
        count: row.n, controlTotal: quiet, population: provenances,
        firstSeq: row.first_id, lastSeq: row.last_id, firstSeen: row.first_seen, lastSeen: row.last_seen,
        summary: `${row.n} outbox rows from ${row.prov} are still pending more than ${OUTBOX_UNSETTLED_MIN_AGE_HOURS} h after dispatch.`,
        threshold: `at least ${min} un-retired outbox rows of one identity_provenance are pending more than ${OUTBOX_UNSETTLED_MIN_AGE_HOURS} h after ts_dispatched`,
        explanation: `${firing} provenance(s) fire and ${quiet} do not, out of ${provenances}. Un-retired outbox entries by delivery state: ${partitionText(stateParts, entries)}. Fix lands in OpenRig code (a send path that never settles its row).`,
        suggestedInspection: `Inspect the send path that writes ${row.prov} outbox rows and whether it ever calls markDelivered or markFailed.`,
      })),
    };
  }
}
