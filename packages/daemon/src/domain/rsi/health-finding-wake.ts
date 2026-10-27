import type Database from "better-sqlite3";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { HealthSourceCoverage } from "../health-detectors.js";
import type { HealthRecord } from "../health-projection.js";
import type { Policy, PolicyEvaluation, PolicyJob } from "../policies/types.js";
import type { WatchdogJob, WatchdogJobsRepository } from "../watchdog-jobs-repository.js";
import { RETENTION_DEFAULTS } from "../queue-retention.js";

/**
 * RSI B1 — the health-finding wake (rsi-design-9k-rev2 §3.4).
 *
 * Bounded context: Improvement. Aggregate: the finding state of each telemetry-finding
 * fingerprint (`rsi_finding_state`), owned by this policy. Invariants:
 *   1. The steward is woken if and only if some ACTIVE fingerprint has
 *      `activated_at > receipt.asOf`, where the receipt is the one banked by the last wake
 *      whose delivery was `ok` (the engine banks `conditionReceipt` only then).
 *   2. A source whose coverage is unavailable or partial makes NO transitions that scan; its
 *      fingerprints carry forward. A failed read is never a removal.
 *   3. A fingerprint that goes quiet and returns gets a new `activated_at` (a recurrence wakes).
 *   4. Removals alone never wake.
 *   5. A source that is unavailable or partial is never invisible: the hour a source goes blind,
 *      with nothing new, is a LOUD skip (`rsi_source_blind`, one history row and one event naming
 *      each source and why), and the daily report asks the steward to list those rows (OF-72).
 *      One row per blind EPISODE (a source and a reason), not per hour: while the same pairs stay
 *      blind the hour is the quiet `rsi_source_blind_ongoing`. An episode is a state row in
 *      `rsi_finding_state` under a reserved fingerprint prefix; it ends when its source is read
 *      in full again (the same pass that quiets a source's gone findings), and it never counts
 *      as an active finding, so it can neither wake the steward nor spend the budget. The row that
 *      opens an episode is whatever the opening hour writes: the blind skip, or, when another source
 *      has a new finding that hour, the wake / brake / budget row, which carries `newlyBlind` in its
 *      notes. The episode row is written only after the engine has inserted that history row
 *      (`afterRecorded`, OF-131): a throw before the insert leaves no episode, so the next hour is
 *      loud again instead of the row being lost. Episodes are global while history is per wake job,
 *      so a pair is "new" to a job until a row in ITS history names it: a re-armed wake job's first
 *      blind hour is loud for an episode an earlier job opened, and carries it in `newlyBlind`.
 *      Known limit: if the hook itself fails after the row is written, the next hour writes one more
 *      loud row for the same pair (never a lost one).
 *      Retention (OF-145): the retention sweep deletes history older than its window beyond the newest K rows per job,
 *      which can delete the row that named a long episode. For an episode older than the window, a job registered
 *      before the episode began is taken as having named it; a job registered after it still names it once.
 *   6. A fingerprint whose source is no longer registered goes quiet; it is not carried forward
 *      (carrying forward is for a source that is registered but could not be read).
 *   7. Retargeting the steward resets the receipt: the new steward is told what is active.
 * Seam to Health: the wake reads the same `HealthProjectionService` that serves
 * `rig health`, so a fingerprint it calls active is one `rig health --json` shows. It never
 * reads detector tables itself.
 */

export const HEALTH_FINDING_WAKE_POLICY = "health-finding-wake" as const;
/** Quiet: nothing (re)activated since the last delivered wake. Listed in QUIET_SKIP_REASONS. */
export const RSI_NO_NEW_FINDING = "rsi_no_new_finding" as const;
/** Loud: nothing new, but at least one RSI source was unavailable or partial this hour, so the
 * absence of findings means nothing. Not in QUIET_SKIP_REASONS: the engine writes the history row. */
export const RSI_SOURCE_BLIND = "rsi_source_blind" as const;
/** Quiet: nothing new, and every source that is blind this hour was already recorded blind (same
 * source, same reason) by an earlier loud row. Listed in QUIET_SKIP_REASONS. */
export const RSI_SOURCE_BLIND_ONGOING = "rsi_source_blind_ongoing" as const;
/** Reserved `rsi_finding_state.fingerprint` prefix of a blind-episode row. Real fingerprints are
 * `rsi.<detector>/...` (fingerprint.ts), so none begins with it. Never an active finding. */
const BLIND_EPISODE_PREFIX = "rsi.source-blind/";
/** Loud: a wake was due but this job already sent its daily budget. */
export const RSI_WAKE_BUDGET_EXHAUSTED = "rsi_wake_budget_exhausted" as const;
/** Loud: a wake was due but the latest weekly provider window is at or above the brake. */
export const RSI_BUDGET_BRAKE = "rsi_budget_brake" as const;

/** DELIVERED wakes per UTC day: this job's own history rows with `delivery_status = 'ok'`.
 * A failed delivery (the engine records it as outcome `sent`, status `failed`) and a retained
 * one (outcome `skipped`) spend nothing: the budget bounds steward wakes, not attempts. */
export const RSI_WAKE_DAILY_BUDGET = 4;
/** Weekly provider-window utilisation (percent) at which wakes stop. */
export const RSI_BRAKE_PERCENT = 90;
export const RSI_WAKE_INTERVAL_SECONDS = 3600;
export const RSI_DAILY_REPORT_INTERVAL_SECONDS = 86_400;
const HOUR_MS = 3_600_000;
/** Fingerprints named in one wake message; the rest are counted. */
const MESSAGE_FINGERPRINT_LIMIT = 20;

/**
 * Daemon-owned anchors used as the jobs' `target_session`. The steward is the spec's
 * `target:`, which the engine delivers to. Keying on an anchor, not on the steward, keeps
 * the boot ensure from adopting a reminder the steward registered to itself, and makes a
 * changed `rsi.steward_session` retarget the same two rows instead of arming a second pair.
 */
export const RSI_WAKE_ANCHOR = "rsi-finding-wake@kernel";
export const RSI_DAILY_REPORT_ANCHOR = "rsi-daily-report@kernel";
const RSI_REGISTRAR = "daemon@kernel";

export const RSI_DAILY_REPORT_MESSAGE = [
  "RSI daily report is due.",
  "1. Re-check declined proposals: re-propose any whose detector count has doubled or that were declined 30 or more days ago.",
  "2. List suppressed wakes (rsi_budget_brake, rsi_wake_budget_exhausted in this job's watchdog history) and every known-fix anchor added since the last report.",
  "3. List every RSI resolve with its actor_session and identity_provenance.",
  "4. List every RSI source that was unavailable or partial (rsi_source_blind rows in this wake job's watchdog history since the last report, one per blind episode, plus any wake or rsi_budget_brake / rsi_wake_budget_exhausted row whose evaluation notes carry `newlyBlind`: an episode that began in an hour with a new finding is named there; and the coverage in `rig health --json`): while a source is blind, no finding from it can be trusted to be absent.",
].join("\n");

/** The receipt banked on a delivered wake (§3.4). `bucket` is the UTC hour of the attempt:
 * it makes each hourly retry a new delivery id, so a retained wake is not retained forever. */
export interface HealthFindingWakeReceipt {
  v: 1;
  asOf: string;
  fps: string[];
  bucket: number;
}

/** The part of a health source the wake needs: its name and the detectors it declares. */
export interface RsiFindingSource {
  readonly name?: string;
  readonly detectors?: readonly string[];
}

/** The part of HealthProjectionService the wake reads. */
export interface RsiFindingProjection {
  records(): HealthRecord[];
  coverage(): HealthSourceCoverage[];
}

export interface ActiveFinding {
  fingerprint: string;
  source: string;
  activatedAt: string;
}

export interface FindingScanResult {
  /** Every fingerprint whose state is active after this scan, ordered by fingerprint. */
  active: ActiveFinding[];
  /** Sources that made no transitions this scan, with the reason. */
  carriedForward: Array<{ source: string; reason: "unavailable" | "partial" | "projection-failed" }>;
  /** The carried-forward pairs this wake job's history has not yet named: no episode is open for them, or one is open
   *  but only another (earlier) wake job named it. The row this hour writes carries them as `newlyBlind`. */
  newlyBlind: Array<{ source: string; reason: "unavailable" | "partial" | "projection-failed" }>;
  /** Open (or, for one already open, touch) the episode rows for `newlyBlind`, at the time of the history row that named
   *  them. The engine calls it only after that row is inserted; a no-op when `newlyBlind` is empty. */
  recordEpisodes(at: string): void;
}

/** Slack when matching an episode's start to a history row that names it: an episode opened by an earlier revision was stamped
 *  with the scan's clock a few milliseconds after the engine stamped the row. The scan cadence is an hour, far above this. */
const EPISODE_NAMED_SLACK_MS = 60_000;

/** True when this wake job has already named the (source, reason) pair for the episode that began at `activatedAt`.
 *  Evidence, in order:
 *   1. a row in THIS job's history, evaluated at or after the episode began, names the pair in its `newlyBlind` notes;
 *   2. otherwise, when the episode is OLDER than the history retention window and this job was registered before the episode
 *      began: the row that named it may have been deleted by the retention sweep (watchdog_history keeps rows beyond the
 *      window only as the newest K per job), so it is taken as named (OF-145). A job registered before the episode was
 *      scanning when it opened and wrote its naming row then; a job registered after it (a re-armed wake job) never did, so
 *      for it the pair stays new. An episode younger than the window cannot have lost its row, so there the first rule is
 *      the whole answer.
 *  Unreadable notes or an unreadable start time count as "not named": the cost is one more loud row. */
function jobNamedEpisode(
  db: Database.Database, jobId: string, pair: { source: string; reason: string }, activatedAt: string,
  now: Date, retentionDays: number,
): boolean {
  const startMs = Date.parse(activatedAt);
  if (!Number.isFinite(startMs)) return false;
  const row = db.prepare(
    `SELECT 1 AS named FROM watchdog_history h
      WHERE h.job_id = ? AND h.evaluated_at >= ?
        AND EXISTS (
          SELECT 1 FROM json_each(CASE WHEN json_valid(h.evaluation_notes) THEN h.evaluation_notes ELSE '{}' END, '$.newlyBlind') j
           WHERE json_extract(j.value, '$.source') = ? AND json_extract(j.value, '$.reason') = ?)
      LIMIT 1`,
  ).get(jobId, new Date(startMs - EPISODE_NAMED_SLACK_MS).toISOString(), pair.source, pair.reason);
  if (row !== undefined) return true;
  if (startMs >= now.getTime() - retentionDays * 24 * 60 * 60 * 1000) return false;
  const job = db.prepare("SELECT registered_at FROM watchdog_jobs WHERE job_id = ?").get(jobId) as { registered_at: string } | undefined;
  const registeredMs = job ? Date.parse(job.registered_at) : NaN;
  return Number.isFinite(registeredMs) && registeredMs <= startMs;
}

function telemetryFingerprint(record: HealthRecord): string | null {
  for (const item of record.evidence) {
    if (item.type === "telemetry-span") return item.fingerprint;
  }
  return null;
}

/**
 * Apply one scan to `rsi_finding_state` and return the active set. Exported for tests; the
 * policy is the only production caller.
 */
export function scanFindingState(
  db: Database.Database,
  projection: RsiFindingProjection,
  sources: readonly RsiFindingSource[],
  now: Date,
  /** The wake job scanning. Blind episodes are global but history is per job, so it decides whether an open episode is
   *  already named in THIS job's history. Absent (a direct caller): an open episode is treated as already named. */
  jobId?: string,
  /** The history retention window in days (the sweep's own `retention.watchdog_days`); decides when a missing naming row may
   *  have been deleted rather than never written. */
  watchdogRetentionDays: number = RETENTION_DEFAULTS.watchdogRetentionDays,
): FindingScanResult {
  const nowIso = now.toISOString();
  // The SAME derivation the wake exposes as `detectorSources` (and the F3 conformance test pins):
  // one rule, one implementation.
  const sourceOfDetector = rsiDetectorSourceMap(sources);
  const sourceNames: string[] = [];
  for (const source of sources) if (source.name) sourceNames.push(source.name);

  const carriedForward: FindingScanResult["carriedForward"] = [];
  let records: HealthRecord[] | null = null;
  let coverage: HealthSourceCoverage[] = [];
  try {
    records = projection.records();
    coverage = projection.coverage();
  } catch {
    // The projection refuses the whole query when the health policy cannot be read. That is
    // every source unavailable: no transitions. Throwing here would leave last_evaluation_at
    // unwritten and re-run the job on the scheduler's next 1 s tick.
    for (const name of sourceNames) carriedForward.push({ source: name, reason: "projection-failed" });
  }

  if (records !== null) {
    const blocked = new Map<string, "unavailable" | "partial">();
    for (const entry of coverage) {
      if (entry.status === "unavailable") blocked.set(entry.source, "unavailable");
      else if (entry.partial && !blocked.has(entry.source)) blocked.set(entry.source, "partial");
    }
    const evaluated = new Map<string, Set<string>>();
    for (const name of sourceNames) {
      const reason = blocked.get(name);
      if (reason) carriedForward.push({ source: name, reason });
      else evaluated.set(name, new Set());
    }
    for (const record of records) {
      if (record.status === "cleared") continue;
      const source = sourceOfDetector.get(record.detector);
      const fingerprints = source === undefined ? undefined : evaluated.get(source);
      if (!fingerprints) continue;
      const fingerprint = telemetryFingerprint(record);
      if (fingerprint !== null) fingerprints.add(fingerprint);
    }

    const select = db.prepare("SELECT state FROM rsi_finding_state WHERE fingerprint = ?");
    const insert = db.prepare(
      "INSERT INTO rsi_finding_state (fingerprint, source, state, activated_at, last_seen_at) VALUES (?, ?, 'active', ?, ?)",
    );
    const reactivate = db.prepare(
      "UPDATE rsi_finding_state SET source = ?, state = 'active', activated_at = ?, last_seen_at = ? WHERE fingerprint = ?",
    );
    const seen = db.prepare("UPDATE rsi_finding_state SET source = ?, last_seen_at = ? WHERE fingerprint = ?");
    const activeOfSource = db.prepare("SELECT fingerprint FROM rsi_finding_state WHERE source = ? AND state = 'active'");
    const quiet = db.prepare("UPDATE rsi_finding_state SET state = 'quiet' WHERE fingerprint = ?");
    db.transaction(() => {
      for (const [source, fingerprints] of evaluated) {
        for (const fingerprint of fingerprints) {
          const row = select.get(fingerprint) as { state: string } | undefined;
          if (!row) insert.run(fingerprint, source, nowIso, nowIso);
          else if (row.state !== "active") reactivate.run(source, nowIso, nowIso, fingerprint);
          else seen.run(source, nowIso, fingerprint);
        }
        for (const { fingerprint } of activeOfSource.all(source) as Array<{ fingerprint: string }>) {
          if (!fingerprints.has(fingerprint)) quiet.run(fingerprint);
        }
      }
    })();
  }

  // Blind episodes. A source read in full above has already had its episode rows quieted by the
  // pass that quiets its gone findings; here each pair that is blind now either continues an
  // episode THIS wake job's history has already named, or is new to this job. Nothing is opened
  // here: `recordEpisodes` writes the episode rows, and the engine runs it only after it has
  // inserted the history row that names them (OF-131), so a throw in between loses no episode.
  const newlyBlind: FindingScanResult["newlyBlind"] = [];
  if (carriedForward.length > 0) {
    const episode = db.prepare("SELECT state, activated_at FROM rsi_finding_state WHERE fingerprint = ?");
    const touch = db.prepare("UPDATE rsi_finding_state SET last_seen_at = ? WHERE fingerprint = ?");
    for (const pair of carriedForward) {
      const key = `${BLIND_EPISODE_PREFIX}${pair.source}/${pair.reason}`;
      const row = episode.get(key) as { state: string; activated_at: string } | undefined;
      if (row?.state === "active") {
        touch.run(nowIso, key);
        // Episodes are global, history rows are per wake job: a re-armed wake job (a new job id) has never named an episode
        // that is already open, so for it the pair is new and its first row names it.
        if (jobId === undefined || jobNamedEpisode(db, jobId, pair, row.activated_at, now, watchdogRetentionDays)) continue;
      }
      newlyBlind.push(pair);
    }
  }
  const recordEpisodes = (at: string): void => {
    if (newlyBlind.length === 0) return;
    const episode = db.prepare("SELECT state FROM rsi_finding_state WHERE fingerprint = ?");
    const open = db.prepare(
      `INSERT INTO rsi_finding_state (fingerprint, source, state, activated_at, last_seen_at) VALUES (?, ?, 'active', ?, ?)
       ON CONFLICT(fingerprint) DO UPDATE SET source = excluded.source, state = 'active', activated_at = excluded.activated_at, last_seen_at = excluded.last_seen_at`,
    );
    const touch = db.prepare("UPDATE rsi_finding_state SET last_seen_at = ? WHERE fingerprint = ?");
    // One source blind for a new reason is a new episode of that source: close its other reasons.
    const closeOthers = db.prepare("UPDATE rsi_finding_state SET state = 'quiet' WHERE source = ? AND state = 'active' AND fingerprint LIKE ? AND fingerprint <> ?");
    db.transaction(() => {
      for (const pair of newlyBlind) {
        const key = `${BLIND_EPISODE_PREFIX}${pair.source}/${pair.reason}`;
        // Already open (another job named it first): keep its start; this job's row names it too.
        if ((episode.get(key) as { state: string } | undefined)?.state === "active") { touch.run(at, key); continue; }
        open.run(key, pair.source, at, at);
        closeOthers.run(pair.source, `${BLIND_EPISODE_PREFIX}%`, key);
      }
    })();
  };

  // A fingerprint whose source is no longer registered at all has no reader left to ever
  // clear it: quiet it. (A registered source that failed this hour is carried forward above.)
  const staleSources = (db.prepare("SELECT DISTINCT source FROM rsi_finding_state WHERE state = 'active'").all() as Array<{ source: string }>)
    .map((row) => row.source).filter((name) => !sourceNames.includes(name));
  if (staleSources.length > 0) {
    const quietSource = db.prepare("UPDATE rsi_finding_state SET state = 'quiet' WHERE source = ? AND state = 'active'");
    db.transaction(() => { for (const name of staleSources) quietSource.run(name); })();
  }

  const active = (db.prepare(
    "SELECT fingerprint, source, activated_at FROM rsi_finding_state WHERE state = 'active' AND fingerprint NOT LIKE ? ORDER BY fingerprint",
  ).all(`${BLIND_EPISODE_PREFIX}%`) as Array<{ fingerprint: string; source: string; activated_at: string }>)
    .map((row) => ({ fingerprint: row.fingerprint, source: row.source, activatedAt: row.activated_at }));
  return { active, carriedForward, newlyBlind, recordEpisodes };
}

/** Parse a banked receipt. Anything unreadable is "no receipt", which can only cause a wake. */
export function parseWakeReceipt(raw: string | null | undefined): HealthFindingWakeReceipt | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<HealthFindingWakeReceipt>;
    if (value.v !== 1 || typeof value.asOf !== "string" || !Array.isArray(value.fps) || typeof value.bucket !== "number") return null;
    return value as HealthFindingWakeReceipt;
  } catch {
    return null;
  }
}

/** The wake text is a function of the receipt alone: a reused delivery id with a different
 * body is refused by the transport (delivery_identity_conflict). Fingerprints only, no content. */
export function buildWakeMessage(receipt: HealthFindingWakeReceipt): string {
  const named = receipt.fps.slice(0, MESSAGE_FINGERPRINT_LIMIT);
  const more = receipt.fps.length - named.length;
  return [
    `RSI: ${receipt.fps.length} active telemetry finding(s); the newest activated at ${receipt.asOf}.`,
    ...named.map((fp) => `- ${fp}`),
    ...(more > 0 ? [`- … and ${more} more`] : []),
    "Read them with `rig health --json`. File a proposal only for a fingerprint that is active there.",
  ].join("\n");
}

function utcDayStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

/** Latest weekly provider-window sample across all seats (no account identity exists, by
 * rule, in usage_samples). null when nothing has been sampled: unmeasured is not full. */
function latestWeeklyWindow(db: Database.Database): { percent: number; capturedAt: string; seat: string } | null {
  const row = db.prepare(
    `SELECT window_used_percent AS percent, captured_at AS capturedAt, seat_session AS seat
       FROM usage_samples
      WHERE lane = 'provider_window' AND window = 'weekly'
      ORDER BY captured_at DESC, id DESC LIMIT 1`,
  ).get() as { percent: number | null; capturedAt: string; seat: string } | undefined;
  if (!row || row.percent === null) return null;
  return { percent: row.percent, capturedAt: row.capturedAt, seat: row.seat };
}

export interface HealthFindingWakeDeps {
  db: Database.Database;
  projection: RsiFindingProjection;
  sources: readonly RsiFindingSource[];
  now?: () => Date;
  /** The history retention window in days, read when a scan runs (it is a setting). Defaults to the sweep's default. */
  watchdogRetentionDays?: () => number;
}

/** Which RSI source answers for each detector id. Built from the ONE RSI source array that
 * startup also gives the health projection; a detector missing here never wakes the steward. */
export function rsiDetectorSourceMap(sources: readonly RsiFindingSource[]): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const source of sources) {
    if (!source.name) continue;
    for (const detector of source.detectors ?? []) map.set(detector, source.name);
  }
  return map;
}

export type HealthFindingWakePolicy = Policy & {
  /** Detector id -> source name, as this wake maps records (exposed for the wiring conformance test). */
  readonly detectorSources: ReadonlyMap<string, string>;
};

export function makeHealthFindingWakePolicy(deps: HealthFindingWakeDeps): HealthFindingWakePolicy {
  return {
    name: HEALTH_FINDING_WAKE_POLICY,
    detectorSources: rsiDetectorSourceMap(deps.sources),
    async evaluate(job: PolicyJob): Promise<PolicyEvaluation> {
      const now = (deps.now ?? (() => new Date()))();
      const scan = scanFindingState(deps.db, deps.projection, deps.sources, now, job.jobId, deps.watchdogRetentionDays?.());
      const banked = parseWakeReceipt((deps.db.prepare(
        "SELECT last_fired_condition AS c FROM watchdog_jobs WHERE job_id = ?",
      ).get(job.jobId) as { c: string | null } | undefined)?.c);
      const fresh = scan.active.filter((finding) => banked === null || finding.activatedAt > banked.asOf);
      const notes = {
        active: scan.active.length,
        newSinceLastWake: fresh.length,
        ...(scan.carriedForward.length ? { carriedForward: scan.carriedForward } : {}),
        // Whatever row this hour writes (the blind skip, the wake, the brake or the budget skip) names the pairs new to this
        // job; the engine opens their episodes only once that row is inserted (`afterRecorded`), and later hours are quiet.
        ...(scan.newlyBlind.length ? { newlyBlind: scan.newlyBlind } : {}),
      };
      const afterRecorded = scan.newlyBlind.length ? { afterRecorded: (row: { evaluatedAt: string }) => scan.recordEpisodes(row.evaluatedAt) } : {};
      if (fresh.length === 0) {
        // Nothing new is only reassuring when every source was read in full.
        // Only a blind episode that starts now is loud; one already recorded stays quiet (one row per episode).
        const reason = scan.carriedForward.length === 0 ? RSI_NO_NEW_FINDING : scan.newlyBlind.length > 0 ? RSI_SOURCE_BLIND : RSI_SOURCE_BLIND_ONGOING;
        return { action: "skip", reason, notes, ...afterRecorded };
      }

      const window = latestWeeklyWindow(deps.db);
      if (window && window.percent >= RSI_BRAKE_PERCENT) {
        return { action: "skip", reason: RSI_BUDGET_BRAKE, notes: { ...notes, weeklyWindow: window, brakePercent: RSI_BRAKE_PERCENT }, ...afterRecorded };
      }

      const deliveredToday = (deps.db.prepare(
        "SELECT count(*) AS n FROM watchdog_history WHERE job_id = ? AND outcome = 'sent' AND delivery_status = 'ok' AND evaluated_at >= ?",
      ).get(job.jobId, utcDayStart(now)) as { n: number }).n;
      if (deliveredToday >= RSI_WAKE_DAILY_BUDGET) {
        return { action: "skip", reason: RSI_WAKE_BUDGET_EXHAUSTED, notes: { ...notes, deliveredToday, dailyBudget: RSI_WAKE_DAILY_BUDGET }, ...afterRecorded };
      }

      const receipt: HealthFindingWakeReceipt = {
        v: 1,
        asOf: scan.active.reduce((max, finding) => (finding.activatedAt > max ? finding.activatedAt : max), ""),
        fps: scan.active.map((finding) => finding.fingerprint),
        bucket: Math.floor(now.getTime() / HOUR_MS),
      };
      return {
        action: "send",
        target: job.target,
        message: buildWakeMessage(receipt),
        conditionReceipt: JSON.stringify(receipt),
        notes: { ...notes, newFingerprints: fresh.map((finding) => finding.fingerprint) },
        ...afterRecorded,
      };
    },
  };
}

export const RSI_STEWARD_UNSET_REASON = "rsi_steward_unset";
export const RSI_STEWARD_INVALID_REASON = "rsi_steward_invalid";

/**
 * THE steward validity rule, shared by B1 (ensureRsiStewardJobs) and B2 (the human-gate notifier,
 * armed in startup.ts): blank is `unset`, a value without `@` is `invalid`, anything else is
 * `valid`. Only `valid` arms; an invalid value disarms both.
 */
export function rsiStewardValidity(stewardSession: string): "unset" | "invalid" | "valid" {
  const steward = stewardSession.trim();
  if (steward === "") return "unset";
  return steward.includes("@") ? "valid" : "invalid";
}

/** The `target.session` of a registered spec; null when the spec is unreadable (treated as a different steward). */
function specTargetSession(specYaml: string): string | null {
  try {
    const target = (parseYaml(specYaml) as { target?: { session?: unknown } } | null)?.target?.session;
    return typeof target === "string" ? target : null;
  } catch {
    return null;
  }
}

export type RsiStewardJobs =
  | { armed: true; wake: WatchdogJob; report: WatchdogJob }
  | { armed: false; reason: typeof RSI_STEWARD_UNSET_REASON | typeof RSI_STEWARD_INVALID_REASON; disarmed: string[] };

/**
 * Boot reconciliation of the steward's two jobs (§3.4): the hourly wake and the daily report.
 * - A canonical `<member>@<rig>` steward arms (or retargets) both, idempotently.
 * - Empty, blank or invalid (no `@`, see `rsiStewardValidity`) arms nothing AND disarms every
 *   nonterminal row at the two anchors with markTerminal, so an install that unsets the key stops
 *   being woken. Terminal, not stop(): ensureAutoRegistration treats a stopped row as a durable
 *   operator opt-out and would never re-arm it; a terminal row is replaced by a fresh active one
 *   when the key is set again. The re-armed rows are new jobs, so they hold no receipt: their
 *   first scan sends ONE wake, and that one wake names every fingerprint still active.
 * - CONSEQUENCE (accepted; B1 review R4): a wake or report job an operator STOPPED is a nonterminal
 *   row, so unsetting the key turns it terminal as well, and setting the key again arms a fresh,
 *   active job. Unset-then-set therefore re-arms a job an operator had stopped. To keep the steward
 *   quiet, leave the key unset, or stop the job again after setting the key.
 */
export function ensureRsiStewardJobs(
  jobsRepo: Pick<WatchdogJobsRepository, "ensureAutoRegistration" | "findAutoRegistration" | "markTerminal" | "clearConditionReceipt">,
  stewardSession: string,
): RsiStewardJobs {
  const validity = rsiStewardValidity(stewardSession);
  const steward = stewardSession.trim();
  if (validity !== "valid") {
    const reason = validity === "unset" ? RSI_STEWARD_UNSET_REASON : RSI_STEWARD_INVALID_REASON;
    const disarmed: string[] = [];
    for (const [policy, anchor] of [[HEALTH_FINDING_WAKE_POLICY, RSI_WAKE_ANCHOR], ["periodic-reminder", RSI_DAILY_REPORT_ANCHOR]] as const) {
      const row = jobsRepo.findAutoRegistration(policy, anchor, null);
      if (row) {
        jobsRepo.markTerminal(row.jobId, reason);
        disarmed.push(row.jobId);
      }
    }
    return { armed: false, reason, disarmed };
  }
  // A different steward has been told nothing: drop the receipt the previous one banked.
  const previous = jobsRepo.findAutoRegistration(HEALTH_FINDING_WAKE_POLICY, RSI_WAKE_ANCHOR, null);
  const retargeted = previous !== null && specTargetSession(previous.specYaml) !== steward;
  const wake = jobsRepo.ensureAutoRegistration({
    policy: HEALTH_FINDING_WAKE_POLICY,
    targetSession: RSI_WAKE_ANCHOR,
    registeredBySession: RSI_REGISTRAR,
    intervalSeconds: RSI_WAKE_INTERVAL_SECONDS,
    activeWakeIntervalSeconds: null,
    scanIntervalSeconds: null,
    specYaml: stringifyYaml({ policy: HEALTH_FINDING_WAKE_POLICY, target: { session: steward } }),
  });
  if (retargeted) jobsRepo.clearConditionReceipt(wake.jobId);
  const report = jobsRepo.ensureAutoRegistration({
    policy: "periodic-reminder",
    targetSession: RSI_DAILY_REPORT_ANCHOR,
    registeredBySession: RSI_REGISTRAR,
    intervalSeconds: RSI_DAILY_REPORT_INTERVAL_SECONDS,
    activeWakeIntervalSeconds: null,
    scanIntervalSeconds: null,
    specYaml: stringifyYaml({ policy: "periodic-reminder", target: { session: steward }, message: RSI_DAILY_REPORT_MESSAGE }),
  });
  return { armed: true, wake, report };
}
