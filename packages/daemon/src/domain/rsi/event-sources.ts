import type { HealthScope } from "../health-projection.js";
import {
  RSI_COMPACTION_STORM, RSI_PERMISSION_STALL, RSI_WATCHDOG_DELIVERY_FAILURE,
} from "./detector-ids.js";
import {
  RsiFindingSource, assertPartitionSumsToTotal, hoursBefore, partitionText, sqliteUtcStamp, toIso,
  type FindingSpec, type RsiFindingSourceDeps, type SourceContext, type SourceResult,
} from "./finding-builder.js";

/**
 * The event-counted detectors: D5 compaction storm, D9 permission-prompt stalls, D12 watchdog
 * delivery failures. All three read the `events` table (never a derived table: D12 reads events,
 * rev2 §2 F2), count supporting events per subject inside a trailing window, and fire for a
 * subject whose count reaches a threshold.
 *
 * Narrowest readings chosen where the design is silent (also listed in the PR report):
 *  - "in a day" is the trailing 24 hours, not a calendar day, so a storm does not vanish at 00:00 UTC.
 *  - D9 and D12 have no threshold in the design: D9 reuses D5's 8 per seat per 24 h; D12 reuses
 *    D1's "same class recurs" shape, 3 failed deliveries per job in 7 days.
 *  - D12 counts `deliveryStatus = 'failed'` only; `retained` and any other status are not failures.
 */
export const COMPACTION_STORM_THRESHOLD = 8;
export const COMPACTION_STORM_WINDOW_HOURS = 24;
export const PERMISSION_STALL_THRESHOLD = 8;
export const PERMISSION_STALL_WINDOW_HOURS = 24;
export const WATCHDOG_DELIVERY_FAILURE_THRESHOLD = 3;
export const WATCHDOG_DELIVERY_FAILURE_WINDOW_HOURS = 24 * 7;

/** SQL fragments over `events.payload`. Constants only; no caller text is ever interpolated. */
interface EventThresholdConfig {
  name: string;
  detectorId: string;
  className: string;
  eventType: string;
  windowHours: number;
  threshold: number;
  /** The subject the count is kept per (a seat session name, a job id). */
  subjectSql: string;
  subjectNoun: string;
  /** Which events are judged at all: the population the control is read against. */
  universeSql: string;
  /** Which judged events support a finding. */
  hitSql: string;
  /** The partition of every judged event into a closed list of classes plus `other`. */
  classSql: string;
  classLabel: string;
  scope(row: { rigId: string | null; nodeId: string | null }, instanceId: string): HealthScope;
  describe(subject: string, n: number): { summary: string; thresholdText: string; suggestedInspection: string; fixHint: string };
}

interface GroupRow { k: string; n: number; first_seq: number; last_seq: number; first_seen: string; last_seen: string; rig_id: string | null; node_id: string | null }

const seatScope = (row: { rigId: string | null; nodeId: string | null }, instanceId: string): HealthScope =>
  row.rigId && row.nodeId ? { type: "seat", rigId: row.rigId, seatId: row.nodeId } : { type: "instance", instanceId };

class EventThresholdSource extends RsiFindingSource {
  readonly name: string;
  readonly detectors: readonly string[];

  constructor(deps: RsiFindingSourceDeps, private readonly config: EventThresholdConfig) {
    super(deps);
    this.name = config.name;
    this.detectors = [config.detectorId];
  }

  protected query({ db, now, limit }: SourceContext): SourceResult {
    const c = this.config;
    const since = sqliteUtcStamp(hoursBefore(now, c.windowHours));
    const base = [c.eventType, since];
    const rows = `WITH rows AS (
      SELECT seq, created_at,
        coalesce(${c.subjectSql}, '(unattributed)') AS k,
        CASE WHEN ${c.hitSql} THEN 1 ELSE 0 END AS hit,
        ${c.classSql} AS cls,
        json_extract(payload, '$.rigId') AS rig_id, json_extract(payload, '$.nodeId') AS node_id
      FROM events WHERE type = ? AND created_at >= ? AND (${c.universeSql}))`;
    const groups = db.prepare(`${rows}
      SELECT k, count(*) AS n, min(seq) AS first_seq, max(seq) AS last_seq, min(created_at) AS first_seen, max(created_at) AS last_seen,
        max(rig_id) AS rig_id, max(node_id) AS node_id
      FROM rows WHERE hit = 1 GROUP BY k HAVING count(*) >= ? ORDER BY n DESC, k LIMIT ?`).all(...base, c.threshold, limit) as GroupRow[];
    const firing = (db.prepare(`${rows} SELECT count(*) AS n FROM (SELECT k FROM rows WHERE hit = 1 GROUP BY k HAVING count(*) >= ?)`).get(...base, c.threshold) as { n: number }).n;
    const quiet = (db.prepare(`${rows} SELECT count(*) AS n FROM (SELECT k FROM rows GROUP BY k HAVING sum(hit) < ?)`).get(...base, c.threshold) as { n: number }).n;
    const population = (db.prepare(`${rows} SELECT count(DISTINCT k) AS n FROM rows`).get(...base) as { n: number }).n;
    const classes = db.prepare(`${rows} SELECT cls, count(*) AS n FROM rows GROUP BY cls ORDER BY cls`).all(...base) as Array<{ cls: string; n: number }>;
    const events = (db.prepare(`${rows} SELECT count(*) AS n FROM rows`).get(...base) as { n: number }).n;

    // Two sum-to-total controls, each against an independent count: the judged subjects split
    // into firing and not firing, and the judged events split into the closed class list.
    assertPartitionSumsToTotal(`${c.detectorId} ${c.subjectNoun}s`, [["firing", firing], ["not firing", quiet]], population);
    const classParts = classes.map((row) => [row.cls, row.n] as const);
    assertPartitionSumsToTotal(`${c.detectorId} events`, classParts, events);

    const findings: FindingSpec[] = groups.map((row) => {
      const text = c.describe(row.k, row.n);
      return {
        detectorId: c.detectorId,
        className: c.className,
        subjectKey: `${c.subjectNoun}:${row.k}`,
        scope: c.scope({ rigId: row.rig_id, nodeId: row.node_id }, this.deps.instanceId),
        count: row.n,
        controlTotal: quiet,
        population,
        firstSeq: row.first_seq,
        lastSeq: row.last_seq,
        firstSeen: toIso(row.first_seen),
        lastSeen: toIso(row.last_seen),
        summary: text.summary,
        threshold: text.thresholdText,
        explanation: `${row.n} of ${events} judged events in the last ${c.windowHours} h; ${firing} ${c.subjectNoun}(s) fire and ${quiet} judged ${c.subjectNoun}(s) do not, out of ${population}. ${c.classLabel}: ${partitionText(classParts, events)}. ${text.fixHint}`,
        suggestedInspection: text.suggestedInspection,
      };
    });
    return { findings, total: firing, unit: `${c.subjectNoun}s`, order: "count desc, subject" };
  }
}

const KNOWN_SESSION_START = `('startup', 'resume', 'compact', 'clear')`;
const KNOWN_ACTIVITY_STATES = `('idle', 'running', 'needs_input', 'unknown')`;
const KNOWN_DELIVERY_STATUSES = `('ok', 'failed', 'retained')`;

/** D5: one seat records at least 8 `SessionStart/compact` activity events in 24 h. */
export function createCompactionStormSource(deps: RsiFindingSourceDeps): RsiFindingSource {
  return new EventThresholdSource(deps, {
    name: "rsi-compaction-storm",
    detectorId: RSI_COMPACTION_STORM,
    className: "seat-compaction-storm",
    eventType: "agent.activity",
    windowHours: COMPACTION_STORM_WINDOW_HOURS,
    threshold: COMPACTION_STORM_THRESHOLD,
    subjectSql: `json_extract(payload, '$.sessionName')`,
    subjectNoun: "seat",
    universeSql: `json_extract(payload, '$.activity.rawEvent') = 'SessionStart'`,
    hitSql: `json_extract(payload, '$.activity.rawSubtype') = 'compact'`,
    classSql: `CASE WHEN json_extract(payload, '$.activity.rawSubtype') IN ${KNOWN_SESSION_START} THEN json_extract(payload, '$.activity.rawSubtype') ELSE 'other' END`,
    classLabel: "SessionStart events by subtype",
    scope: seatScope,
    describe: (seat, n) => ({
      summary: `Seat ${seat} recorded ${n} context compactions in the last ${COMPACTION_STORM_WINDOW_HOURS} h.`,
      thresholdText: `a seat records >= ${COMPACTION_STORM_THRESHOLD} agent.activity events with rawEvent SessionStart and rawSubtype compact within ${COMPACTION_STORM_WINDOW_HOURS} h`,
      suggestedInspection: `Inspect the context hygiene and model window of seat ${seat}.`,
      fixHint: "Fix lands in a persona (context hygiene) or a spec (model or window).",
    }),
  });
}

/** D9: one seat records at least 8 `needs_input` activity events in 24 h. */
export function createPermissionStallSource(deps: RsiFindingSourceDeps): RsiFindingSource {
  return new EventThresholdSource(deps, {
    name: "rsi-permission-stall",
    detectorId: RSI_PERMISSION_STALL,
    className: "seat-permission-stall",
    eventType: "agent.activity",
    windowHours: PERMISSION_STALL_WINDOW_HOURS,
    threshold: PERMISSION_STALL_THRESHOLD,
    subjectSql: `json_extract(payload, '$.sessionName')`,
    subjectNoun: "seat",
    universeSql: `1`,
    hitSql: `json_extract(payload, '$.activity.state') = 'needs_input'`,
    classSql: `CASE WHEN json_extract(payload, '$.activity.state') IN ${KNOWN_ACTIVITY_STATES} THEN json_extract(payload, '$.activity.state') ELSE 'other' END`,
    classLabel: "activity events by state",
    scope: seatScope,
    describe: (seat, n) => ({
      summary: `Seat ${seat} stalled for input ${n} times in the last ${PERMISSION_STALL_WINDOW_HOURS} h.`,
      thresholdText: `a seat records >= ${PERMISSION_STALL_THRESHOLD} agent.activity events with state needs_input within ${PERMISSION_STALL_WINDOW_HOURS} h`,
      suggestedInspection: `Inspect the permission policy and prompts of seat ${seat}.`,
      fixHint: "Fix lands in a spec (permission policy) or a persona.",
    }),
  });
}

/** D12: one watchdog job records at least 3 failed deliveries in 7 days. */
export function createWatchdogDeliveryFailureSource(deps: RsiFindingSourceDeps): RsiFindingSource {
  return new EventThresholdSource(deps, {
    name: "rsi-watchdog-delivery-failure",
    detectorId: RSI_WATCHDOG_DELIVERY_FAILURE,
    className: "watchdog-job-delivery-failure",
    eventType: "watchdog.evaluation_fired",
    windowHours: WATCHDOG_DELIVERY_FAILURE_WINDOW_HOURS,
    threshold: WATCHDOG_DELIVERY_FAILURE_THRESHOLD,
    subjectSql: `json_extract(payload, '$.jobId')`,
    subjectNoun: "job",
    universeSql: `1`,
    hitSql: `json_extract(payload, '$.deliveryStatus') = 'failed'`,
    classSql: `CASE WHEN json_extract(payload, '$.deliveryStatus') IN ${KNOWN_DELIVERY_STATUSES} THEN json_extract(payload, '$.deliveryStatus') ELSE 'other' END`,
    classLabel: "sent wake-ups by delivery status",
    scope: (_row, instanceId) => ({ type: "instance", instanceId }),
    describe: (job, n) => ({
      summary: `Watchdog job ${job} failed to deliver ${n} wake-ups in the last ${WATCHDOG_DELIVERY_FAILURE_WINDOW_HOURS / 24} days.`,
      thresholdText: `a watchdog job records >= ${WATCHDOG_DELIVERY_FAILURE_THRESHOLD} watchdog.evaluation_fired events with deliveryStatus failed within ${WATCHDOG_DELIVERY_FAILURE_WINDOW_HOURS / 24} days`,
      suggestedInspection: `Inspect the watchdog history and the delivery transport of job ${job}.`,
      fixHint: "Fix lands in OpenRig code (transport).",
    }),
  });
}
