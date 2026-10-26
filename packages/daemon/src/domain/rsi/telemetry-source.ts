import Database from "better-sqlite3";
import {
  boundHealthEvidence,
  deriveHealthSourceFreshness,
  type HealthEvidenceReference,
} from "../health-projection.js";
import type { HealthDetectorObservation, HealthObservationSource, HealthSourceCoverage } from "../health-detectors.js";
import { parseSqliteUtcMs } from "../sqlite-time.js";
import { RSI_ARCHIVED_RIG_LIVE_SESSION } from "./detector-ids.js";
import { rsiFingerprint } from "./fingerprint.js";

/** Most supporting rows one read examines. better-sqlite3 cannot interrupt a running
 * statement, so the bound is a row cap, not a time budget. Rows past it are reported as
 * `partial` coverage, never as zero. */
export const RSI_TELEMETRY_ROW_LIMIT = 500;
export const ARCHIVED_RIG_LIVE_SESSION_CLASS = "live-session-on-archived-rig";

/**
 * Open the RSI source's own connection: a separate READ-ONLY handle on the daemon database,
 * not a SELECT-only wrapper around the daemon's read-write handle. The file must exist.
 * An in-memory database cannot be opened read-only, so a file-backed path is required.
 */
export function openRsiReadOnlyDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  if (db.readonly !== true) {
    db.close();
    throw new Error("RSI telemetry source must hold a read-only database handle");
  }
  return db;
}

interface StaleSessionRow { rig_id: string; rig_name: string; seq: number; created_at: string }
interface ControlRow { population: number | null; control: number | null; stale_total: number | null }

// "Latest session per node" is the same definition SessionRegistry.getLatestLiveSessions uses.
const LATEST_SESSION_CTE = `
  WITH latest AS (
    SELECT s.rowid AS seq, s.id, s.node_id, s.status, s.created_at
    FROM sessions s
    WHERE s.id = (SELECT s2.id FROM sessions s2 WHERE s2.node_id = s.node_id ORDER BY s2.created_at DESC, s2.id DESC LIMIT 1)
  )`;

/**
 * D4: the latest session of a node is `running` or `detached` although its rig is archived.
 * One finding per archived rig; the un-archived rigs' running sessions are the control.
 */
export class TelemetryHealthSource implements HealthObservationSource {
  readonly name = "rsi-telemetry";
  readonly detectors = [RSI_ARCHIVED_RIG_LIVE_SESSION];
  private db: Database.Database | null = null;
  private lastCoverage: HealthSourceCoverage[] = [];

  constructor(private readonly deps: { dbPath: string; now?: () => Date; rowLimit?: number }) {}

  /** The source's own read-only handle (opened on first use). Exposed so a test can prove it
   * refuses writes. */
  readonlyHandle(): Database.Database {
    return this.db ??= openRsiReadOnlyDatabase(this.deps.dbPath);
  }

  coverage(): readonly HealthSourceCoverage[] {
    return this.lastCoverage;
  }

  read(): readonly HealthDetectorObservation[] {
    this.lastCoverage = [];
    const db = this.readonlyHandle();
    const evaluatedAt = (this.deps.now ?? (() => new Date()))().toISOString();
    const limit = this.deps.rowLimit ?? RSI_TELEMETRY_ROW_LIMIT;
    const { rows, controls } = db.transaction(() => ({
      rows: db.prepare(`${LATEST_SESSION_CTE}
        SELECT r.id AS rig_id, r.name AS rig_name, l.seq, l.created_at
        FROM latest l JOIN nodes n ON n.id = l.node_id JOIN rigs r ON r.id = n.rig_id
        WHERE l.status IN ('running', 'detached') AND r.archived_at IS NOT NULL
        ORDER BY r.id, l.seq LIMIT ?`).all(limit) as StaleSessionRow[],
      controls: db.prepare(`${LATEST_SESSION_CTE}
        SELECT count(*) AS population,
          sum(CASE WHEN l.status IN ('running', 'detached') AND r.archived_at IS NULL THEN 1 ELSE 0 END) AS control,
          sum(CASE WHEN l.status IN ('running', 'detached') AND r.archived_at IS NOT NULL THEN 1 ELSE 0 END) AS stale_total
        FROM latest l JOIN nodes n ON n.id = l.node_id JOIN rigs r ON r.id = n.rig_id`).get() as ControlRow,
    }))();
    const population = controls.population ?? 0;
    const controlTotal = controls.control ?? 0;
    const total = controls.stale_total ?? 0;
    const coverage = {
      source: this.name, evaluatedAt, unit: "sessions", limit, total, evaluated: rows.length,
      omitted: Math.max(0, total - rows.length), partial: total > rows.length,
      order: "rig id, session rowid",
    };
    this.lastCoverage = [coverage];

    // OF-70: a session stamped after the daemon clock (clock skew) is clamped to the evaluation
    // time. Left raw, its episode would start after the window ends, the evidence bound would
    // refuse it, and one skewed row would make D4 unavailable for every rig. Clamping is counted
    // on the coverage row, never silent.
    const evaluatedMs = Date.parse(evaluatedAt);
    let clamped = 0;
    const seenAt = (row: StaleSessionRow): number => {
      const ms = parseSqliteUtcMs(row.created_at);
      if (ms > evaluatedMs) { clamped += 1; return evaluatedMs; }
      return ms;
    };
    const byRig = new Map<string, StaleSessionRow[]>();
    for (const row of rows) byRig.set(row.rig_id, [...byRig.get(row.rig_id) ?? [], row]);
    const observations: HealthDetectorObservation[] = [];
    for (const [rigId, group] of byRig) {
      const seen = group.map(seenAt);
      const firstSeen = new Date(Math.min(...seen)).toISOString();
      const lastSeen = new Date(Math.max(...seen)).toISOString();
      const fingerprint = rsiFingerprint(RSI_ARCHIVED_RIG_LIVE_SESSION, `rig:${rigId}`);
      const rigName = group[0]!.rig_name;
      const evidence: HealthEvidenceReference = {
        type: "telemetry-span", sourceOrder: 0, observedAt: lastSeen,
        detectorId: RSI_ARCHIVED_RIG_LIVE_SESSION, class: ARCHIVED_RIG_LIVE_SESSION_CLASS, fingerprint,
        count: group.length, controlTotal, population,
        firstSeq: Math.min(...group.map((row) => row.seq)), lastSeq: Math.max(...group.map((row) => row.seq)),
        firstSeen, lastSeen,
      };
      // The condition is a current-state fact read now; its episode starts at the earliest
      // supporting session, and the record id follows it. The fingerprint does not.
      const windowSeconds = Math.max(1, Math.ceil((Date.parse(evaluatedAt) - Date.parse(firstSeen)) / 1000));
      observations.push({
        kind: "telemetry-finding",
        detectorId: RSI_ARCHIVED_RIG_LIVE_SESSION,
        fingerprint,
        episodeKey: fingerprint,
        scope: { type: "rig", rigId },
        episodeStartedAt: firstSeen,
        lastObservedAt: evaluatedAt,
        source: boundHealthEvidence([evidence], {
          source: "telemetry-span", startedAt: firstSeen, endedAt: evaluatedAt, limit: 1, retentionSeconds: windowSeconds,
        }, deriveHealthSourceFreshness({ evaluatedAt, newestSourceAt: evaluatedAt, maxAgeSeconds: 600 })),
        summary: `Archived rig ${rigName} still has ${group.length} node${group.length === 1 ? "" : "s"} whose latest session is running or detached.`,
        threshold: "a node's latest session status is running or detached AND its rig has archived_at set",
        explanation: `${group.length} of ${total} such sessions fleet-wide; control: ${controlTotal} running or detached latest sessions on un-archived rigs, out of ${population} nodes with a session.`,
        suggestedInspection: `Inspect the latest session of each node of rig ${rigId} (${rigName}) and whether its tmux session still exists.`,
      });
    }
    if (clamped > 0) {
      this.lastCoverage = [{
        ...coverage,
        note: `${clamped} session${clamped === 1 ? "" : "s"} created_at later than the daemon clock ${clamped === 1 ? "was" : "were"} clamped to the evaluation time`,
      }];
    }
    return observations;
  }
}
