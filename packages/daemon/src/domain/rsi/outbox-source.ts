import { OUTBOX_DELIVERY_STATES, OUTBOX_ORIGIN_MANUAL_RECORD_TAG } from "../outbox-handler.js";
import { RSI_OUTBOX_UNSETTLED } from "./detector-ids.js";
import {
  RsiFindingSource, hoursBefore, partitionText, sortedParts,
  type SourceContext, type SourceResult,
} from "./finding-builder.js";

/**
 * D8: outbox state never settles. Rev1 names the symptom (10,302 `transport:v1` rows `pending`)
 * but no threshold, so the narrowest reading is used (listed in the PR report): per
 * `identity_provenance`, at least 10 un-retired rows dispatched in the trailing 7 days are still
 * `pending` more than 24 h after dispatch. A retired row was deliberately taken out of play and
 * is not judged at all. Neither is a manual audit row (`POST /outbox/record`, daemon-stamped with
 * OUTBOX_ORIGIN_MANUAL_RECORD_TAG): it records an event and has no delivery to settle (OF-77).
 *
 * The 7-day lower bound (Jim's decision) lets the detector go quiet once the send path is fixed:
 * the outbox has no retention, so legacy `pending` rows would otherwise fire forever. Rows older
 * than the bound are reported as context (`legacy`), never counted.
 *
 * One grouped statement over the table (index outbox_entries.delivery_state is not needed: the
 * table is small and the cost is a single pass).
 */
export const OUTBOX_UNSETTLED_MIN_AGE_HOURS = 24;
export const OUTBOX_UNSETTLED_LOOKBACK_HOURS = 24 * 7;
export const OUTBOX_UNSETTLED_MIN_ROWS = 10;

interface OutboxRow { prov: string; state: string; band: string; n: number; first_id: number; last_id: number; first_seen: string; last_seen: string }
interface Provenance { hits: number; legacyPending: number; firstId: number; lastId: number; firstSeen: string; lastSeen: string }

export class OutboxUnsettledSource extends RsiFindingSource {
  readonly name = "rsi-outbox-unsettled";
  readonly detectors = [RSI_OUTBOX_UNSETTLED];

  protected query({ db, now, limit }: SourceContext): SourceResult {
    const stale = hoursBefore(now, OUTBOX_UNSETTLED_MIN_AGE_HOURS).toISOString();
    const lookback = hoursBefore(now, OUTBOX_UNSETTLED_LOOKBACK_HOURS).toISOString();
    const known = OUTBOX_DELIVERY_STATES.map((state) => `'${state}'`).join(", ");
    const rows = db.prepare(`SELECT coalesce(identity_provenance, '(unattributed)') AS prov,
        CASE WHEN delivery_state IN (${known}) THEN delivery_state ELSE 'other' END AS state,
        CASE WHEN ts_dispatched >= ? THEN CASE WHEN ts_dispatched < ? THEN 'window' ELSE 'young' END ELSE 'legacy' END AS band,
        count(*) AS n, min(rowid) AS first_id, max(rowid) AS last_id, min(ts_dispatched) AS first_seen, max(ts_dispatched) AS last_seen
      FROM outbox_entries WHERE retired_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(tags) THEN tags ELSE '[]' END) WHERE value = ?)
      GROUP BY prov, state, band`).all(lookback, stale, OUTBOX_ORIGIN_MANUAL_RECORD_TAG) as OutboxRow[];

    const provenances = new Map<string, Provenance>();
    const states = new Map<string, number>();
    for (const row of rows) {
      states.set(row.state, (states.get(row.state) ?? 0) + row.n);
      const p = provenances.get(row.prov) ?? { hits: 0, legacyPending: 0, firstId: Infinity, lastId: -Infinity, firstSeen: "", lastSeen: "" };
      if (row.state === "pending" && row.band === "window") {
        p.hits += row.n;
        p.firstId = Math.min(p.firstId, row.first_id);
        p.lastId = Math.max(p.lastId, row.last_id);
        if (p.firstSeen === "" || row.first_seen < p.firstSeen) p.firstSeen = row.first_seen;
        if (row.last_seen > p.lastSeen) p.lastSeen = row.last_seen;
      }
      if (row.state === "pending" && row.band === "legacy") p.legacyPending += row.n;
      provenances.set(row.prov, p);
    }
    const firing = [...provenances.entries()].filter(([, p]) => p.hits >= OUTBOX_UNSETTLED_MIN_ROWS)
      .sort(([ka, a], [kb, b]) => b.hits - a.hits || (ka < kb ? -1 : ka > kb ? 1 : 0));
    const quiet = provenances.size - firing.length;
    const stateParts = sortedParts(states);

    return {
      total: firing.length, unit: "identity provenances", order: "stale pending rows desc, provenance",
      findings: firing.slice(0, limit).map(([prov, p]) => ({
        detectorId: RSI_OUTBOX_UNSETTLED, className: "outbox-pending-never-settles", subjectKey: `provenance:${prov}`,
        scope: { type: "instance", instanceId: this.deps.instanceId },
        count: p.hits, controlTotal: quiet, population: provenances.size,
        firstSeq: p.firstId, lastSeq: p.lastId, firstSeen: p.firstSeen, lastSeen: p.lastSeen,
        summary: `${p.hits} outbox rows from ${prov} dispatched in the last ${OUTBOX_UNSETTLED_LOOKBACK_HOURS / 24} days are still pending more than ${OUTBOX_UNSETTLED_MIN_AGE_HOURS} h after dispatch.`,
        threshold: `at least ${OUTBOX_UNSETTLED_MIN_ROWS} un-retired outbox rows of one identity_provenance, dispatched within ${OUTBOX_UNSETTLED_LOOKBACK_HOURS / 24} days, are pending more than ${OUTBOX_UNSETTLED_MIN_AGE_HOURS} h after ts_dispatched`,
        explanation: `${firing.length} provenance(s) fire and ${quiet} do not, out of ${provenances.size}. ${p.legacyPending} older pending row(s) of this provenance are outside the window and not counted. Un-retired outbox entries by delivery state: ${partitionText(stateParts)}. Fix lands in OpenRig code (a send path that never settles its row).`,
        suggestedInspection: `Inspect the send path that writes ${prov} outbox rows and whether it ever calls markDelivered or markFailed.`,
      })),
    };
  }
}
