import type Database from "better-sqlite3";
import { stringify as stringifyYaml } from "yaml";
import type { HealthSourceCoverage } from "../health-detectors.js";
import type { HealthRecord } from "../health-projection.js";
import type { Policy, PolicyEvaluation, PolicyJob } from "../policies/types.js";
import type { WatchdogJob, WatchdogJobsRepository } from "../watchdog-jobs-repository.js";

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
 * Seam to Health: the wake reads the same `HealthProjectionService` that serves
 * `rig health`, so a fingerprint it calls active is one `rig health --json` shows. It never
 * reads detector tables itself.
 */

export const HEALTH_FINDING_WAKE_POLICY = "health-finding-wake" as const;
/** Quiet: nothing (re)activated since the last delivered wake. Listed in QUIET_SKIP_REASONS. */
export const RSI_NO_NEW_FINDING = "rsi_no_new_finding" as const;
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
): FindingScanResult {
  const nowIso = now.toISOString();
  const sourceOfDetector = new Map<string, string>();
  const sourceNames: string[] = [];
  for (const source of sources) {
    if (!source.name) continue;
    sourceNames.push(source.name);
    for (const detector of source.detectors ?? []) sourceOfDetector.set(detector, source.name);
  }

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

  const active = (db.prepare(
    "SELECT fingerprint, source, activated_at FROM rsi_finding_state WHERE state = 'active' ORDER BY fingerprint",
  ).all() as Array<{ fingerprint: string; source: string; activated_at: string }>)
    .map((row) => ({ fingerprint: row.fingerprint, source: row.source, activatedAt: row.activated_at }));
  return { active, carriedForward };
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
      const scan = scanFindingState(deps.db, deps.projection, deps.sources, now);
      const banked = parseWakeReceipt((deps.db.prepare(
        "SELECT last_fired_condition AS c FROM watchdog_jobs WHERE job_id = ?",
      ).get(job.jobId) as { c: string | null } | undefined)?.c);
      const fresh = scan.active.filter((finding) => banked === null || finding.activatedAt > banked.asOf);
      const notes = {
        active: scan.active.length,
        newSinceLastWake: fresh.length,
        ...(scan.carriedForward.length ? { carriedForward: scan.carriedForward } : {}),
      };
      if (fresh.length === 0) return { action: "skip", reason: RSI_NO_NEW_FINDING, notes };

      const window = latestWeeklyWindow(deps.db);
      if (window && window.percent >= RSI_BRAKE_PERCENT) {
        return { action: "skip", reason: RSI_BUDGET_BRAKE, notes: { ...notes, weeklyWindow: window, brakePercent: RSI_BRAKE_PERCENT } };
      }

      const deliveredToday = (deps.db.prepare(
        "SELECT count(*) AS n FROM watchdog_history WHERE job_id = ? AND outcome = 'sent' AND delivery_status = 'ok' AND evaluated_at >= ?",
      ).get(job.jobId, utcDayStart(now)) as { n: number }).n;
      if (deliveredToday >= RSI_WAKE_DAILY_BUDGET) {
        return { action: "skip", reason: RSI_WAKE_BUDGET_EXHAUSTED, notes: { ...notes, deliveredToday, dailyBudget: RSI_WAKE_DAILY_BUDGET } };
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
      };
    },
  };
}

export const RSI_STEWARD_UNSET_REASON = "rsi_steward_unset";
export const RSI_STEWARD_INVALID_REASON = "rsi_steward_invalid";

export type RsiStewardJobs =
  | { armed: true; wake: WatchdogJob; report: WatchdogJob }
  | { armed: false; reason: typeof RSI_STEWARD_UNSET_REASON | typeof RSI_STEWARD_INVALID_REASON; disarmed: string[] };

/**
 * Boot reconciliation of the steward's two jobs (§3.4): the hourly wake and the daily report.
 * - A canonical `<member>@<rig>` steward arms (or retargets) both, idempotently.
 * - Empty, blank or invalid (no `@`) arms nothing AND disarms every nonterminal row at the two
 *   anchors with markTerminal, so an install that unsets the key stops being woken. Terminal,
 *   not stop(): ensureAutoRegistration treats a stopped row as a durable operator opt-out and
 *   would never re-arm it; a terminal row is replaced by a fresh active one when the key is set
 *   again. The re-armed rows are new jobs, so they hold no receipt: their first scan wakes once
 *   for every fingerprint still active.
 */
export function ensureRsiStewardJobs(
  jobsRepo: Pick<WatchdogJobsRepository, "ensureAutoRegistration" | "findAutoRegistration" | "markTerminal">,
  stewardSession: string,
): RsiStewardJobs {
  const steward = stewardSession.trim();
  if (steward === "" || !steward.includes("@")) {
    const reason = steward === "" ? RSI_STEWARD_UNSET_REASON : RSI_STEWARD_INVALID_REASON;
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
  const wake = jobsRepo.ensureAutoRegistration({
    policy: HEALTH_FINDING_WAKE_POLICY,
    targetSession: RSI_WAKE_ANCHOR,
    registeredBySession: RSI_REGISTRAR,
    intervalSeconds: RSI_WAKE_INTERVAL_SECONDS,
    activeWakeIntervalSeconds: null,
    scanIntervalSeconds: null,
    specYaml: stringifyYaml({ policy: HEALTH_FINDING_WAKE_POLICY, target: { session: steward } }),
  });
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
