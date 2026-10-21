import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { createDaemon } from "../src/startup.js";
import { EventBus } from "../src/domain/event-bus.js";
import {
  HealthProjectionService,
  type HealthDetectorObservation, type HealthObservationSource, type HealthSourceCoverage,
} from "../src/domain/health-detectors.js";
import { boundHealthEvidence, deriveHealthSourceFreshness } from "../src/domain/health-projection.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { WatchdogHistoryLog } from "../src/domain/watchdog-history-log.js";
import { WatchdogPolicyEngine, type DeliveryOutcome, type WatchdogDeliverySource } from "../src/domain/watchdog-policy-engine.js";
import { RSI_ARCHIVED_RIG_LIVE_SESSION } from "../src/domain/rsi/detector-ids.js";
import { rsiFingerprint } from "../src/domain/rsi/fingerprint.js";
import {
  HEALTH_FINDING_WAKE_POLICY, RSI_BUDGET_BRAKE, RSI_DAILY_REPORT_ANCHOR, RSI_NO_NEW_FINDING,
  RSI_WAKE_ANCHOR, RSI_WAKE_BUDGET_EXHAUSTED, ensureRsiStewardJobs, makeHealthFindingWakePolicy,
  parseWakeReceipt,
} from "../src/domain/rsi/health-finding-wake.js";

// The clock is injected far from wall clock: a wall-clock reversion would land every bucket and
// every UTC day in 2026, not 2031.
const T0 = Date.parse("2031-03-04T05:06:07.000Z");
const HOUR = 3_600_000;
const STEWARD = "improve-steward@kernel";
const D = RSI_ARCHIVED_RIG_LIVE_SESSION;
const fp = (rig: string) => rsiFingerprint(D, `rig:${rig}`);

/** One D4-shaped telemetry finding for rig `rig`, as the real source builds it. */
function finding(rig: string, nowIso: string): HealthDetectorObservation {
  const fingerprint = fp(rig);
  const seen = "2031-01-01T00:00:00.000Z";
  return {
    kind: "telemetry-finding", detectorId: D, fingerprint, episodeKey: fingerprint,
    scope: { type: "rig", rigId: rig }, episodeStartedAt: seen, lastObservedAt: nowIso,
    source: boundHealthEvidence([{
      type: "telemetry-span", sourceOrder: 0, observedAt: seen, detectorId: D, class: "live-session-on-archived-rig",
      fingerprint, count: 1, controlTotal: 0, population: 1, firstSeq: 1, lastSeq: 1, firstSeen: seen, lastSeen: seen,
    }], { source: "telemetry-span", startedAt: seen, endedAt: nowIso, limit: 1, retentionSeconds: 86_400 * 365 },
    deriveHealthSourceFreshness({ evaluatedAt: nowIso, newestSourceAt: nowIso, maxAgeSeconds: 600 })),
    summary: `rig ${rig}`, threshold: "t", explanation: "e", suggestedInspection: "i",
  };
}

/** A controllable RSI source behind the REAL HealthProjectionService: findings, a failing read
 * (the projection reports it `unavailable`), or a bounded read (`partial` coverage). */
class ScriptedSource implements HealthObservationSource {
  readonly name = "rsi-telemetry";
  readonly detectors = [D];
  rigs: string[] = [];
  mode: "ok" | "throw" | "partial" = "ok";
  constructor(private readonly clock: () => Date) {}
  read(): readonly HealthDetectorObservation[] {
    if (this.mode === "throw") throw new Error("source read failed");
    const nowIso = this.clock().toISOString();
    return this.rigs.map((rig) => finding(rig, nowIso));
  }
  coverage(): readonly HealthSourceCoverage[] {
    return [{ source: this.name, evaluatedAt: this.clock().toISOString(), unit: "sessions", limit: 500,
      total: this.rigs.length + (this.mode === "partial" ? 1 : 0), evaluated: this.rigs.length,
      omitted: this.mode === "partial" ? 1 : 0, partial: this.mode === "partial", order: "rig id" }];
  }
}

type Script = (source: WatchdogDeliverySource) => DeliveryOutcome["status"];

function harness(script: Script = () => "ok") {
  const db = createDb();
  migrate(db, ALL_MIGRATIONS);
  let clock = new Date(T0);
  const now = () => clock;
  const source = new ScriptedSource(now);
  const projection = new HealthProjectionService([source]);
  const jobsRepo = new WatchdogJobsRepository(db, now);
  const historyLog = new WatchdogHistoryLog(db);
  const sends: Array<{ targetSession: string; message: string; occurrenceId: string; status: string }> = [];
  const engine = new WatchdogPolicyEngine({
    jobsRepo, historyLog, eventBus: new EventBus(db), now,
    deliver: async (req, src) => {
      const status = script(src);
      sends.push({ targetSession: req.targetSession, message: req.message, occurrenceId: src.occurrenceId!, status });
      return { status };
    },
    additionalPolicies: [makeHealthFindingWakePolicy({ db, projection, sources: [source], now })],
  });
  const { wake } = ensureRsiStewardJobs(jobsRepo, STEWARD)!;
  const scan = async () => {
    const result = await engine.evaluate(jobsRepo.getByIdOrThrow(wake.jobId));
    clock = new Date(clock.getTime() + HOUR);
    return result;
  };
  const receipt = () => parseWakeReceipt((db.prepare("SELECT last_fired_condition AS c FROM watchdog_jobs WHERE job_id = ?")
    .get(wake.jobId) as { c: string | null }).c);
  const history = () => db.prepare("SELECT outcome, skip_reason FROM watchdog_history WHERE job_id = ? ORDER BY evaluated_at, history_id")
    .all(wake.jobId) as Array<{ outcome: string; skip_reason: string | null }>;
  const state = (fingerprint: string) => db.prepare("SELECT state, activated_at FROM rsi_finding_state WHERE fingerprint = ?")
    .get(fingerprint) as { state: string; activated_at: string } | undefined;
  return { db, source, sends, scan, receipt, history, state, setClock: (ms: number) => { clock = new Date(ms); } };
}

describe("RSI B1 health-finding wake (rev2 §3.4)", () => {
  it("wakes the steward once for a new finding and banks the receipt {v, asOf, fps, bucket}", async () => {
    const h = harness();
    h.source.rigs = ["r1"];
    const result = await h.scan();
    expect(result.outcome.action).toBe("send");
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]!.targetSession).toBe(STEWARD);
    expect(h.sends[0]!.message).toContain(fp("r1"));
    expect(h.receipt()).toEqual({ v: 1, asOf: new Date(T0).toISOString(), fps: [fp("r1")], bucket: Math.floor(T0 / HOUR) });
  });

  it("an unchanged hour does not wake and writes 0 history rows (quiet rsi_no_new_finding)", async () => {
    const h = harness();
    h.source.rigs = ["r1"];
    await h.scan();
    const rowsAfterWake = h.history().length;
    const second = await h.scan();
    expect(second.outcome).toMatchObject({ action: "skip", reason: RSI_NO_NEW_FINDING });
    expect(h.sends).toHaveLength(1);
    expect(h.history()).toHaveLength(rowsAfterWake);
  });

  it("removal does not wake", async () => {
    const h = harness();
    h.source.rigs = ["r1", "r2"];
    await h.scan();
    h.source.rigs = ["r1"];
    const after = await h.scan();
    expect(after.outcome).toMatchObject({ action: "skip", reason: RSI_NO_NEW_FINDING });
    expect(h.sends).toHaveLength(1);
    expect(h.state(fp("r2"))?.state).toBe("quiet");
  });

  it("recurrence wakes: a fingerprint that went quiet and returns gets a new activated_at", async () => {
    const h = harness();
    h.source.rigs = ["r1"];
    await h.scan();
    const first = h.state(fp("r1"))!.activated_at;
    h.source.rigs = [];
    await h.scan();
    expect(h.state(fp("r1"))?.state).toBe("quiet");
    h.source.rigs = ["r1"];
    const back = await h.scan();
    expect(back.outcome.action).toBe("send");
    expect(h.sends).toHaveLength(2);
    expect(h.state(fp("r1"))!.activated_at > first).toBe(true);
  });

  it.each(["throw", "partial"] as const)("source failure then recovery: 0 wakes (%s coverage carries forward)", async (mode) => {
    const h = harness();
    h.source.rigs = ["r1"];
    await h.scan();
    h.source.mode = mode;
    if (mode === "partial") h.source.rigs = [];
    const during = await h.scan();
    expect(during.outcome).toMatchObject({ action: "skip", reason: RSI_NO_NEW_FINDING });
    expect(h.state(fp("r1"))?.state).toBe("active");
    h.source.mode = "ok";
    h.source.rigs = ["r1"];
    const recovered = await h.scan();
    expect(recovered.outcome).toMatchObject({ action: "skip", reason: RSI_NO_NEW_FINDING });
    expect(h.sends).toHaveLength(1);
  });

  it("a failed delivery banks nothing and the next hour retries", async () => {
    let calls = 0;
    const h = harness(() => (++calls === 1 ? "failed" : "ok"));
    h.source.rigs = ["r1"];
    await h.scan();
    expect(h.receipt()).toBeNull();
    await h.scan();
    expect(h.sends.map((s) => s.status)).toEqual(["failed", "ok"]);
    expect(h.receipt()?.fps).toEqual([fp("r1")]);
  });

  it("a retained wake is retried under a NEW delivery id and then delivered (the bucket defeats the retained trap)", async () => {
    // The transport's readback (session-transport.ts): a delivery id already retained stays
    // retained; a new id is a new send. The first attempt is retained.
    const retained = new Set<string>();
    let first = true;
    const h = harness((src) => {
      if (retained.has(src.occurrenceId!)) return "retained";
      if (first) { first = false; retained.add(src.occurrenceId!); return "retained"; }
      return "ok";
    });
    h.source.rigs = ["r1"];
    await h.scan();
    await h.scan();
    expect(h.sends.map((s) => s.status)).toEqual(["retained", "ok"]);
    expect(new Set(h.sends.map((s) => s.occurrenceId)).size).toBe(2);
    expect(h.receipt()?.fps).toEqual([fp("r1")]);
  });

  it("the daily budget: 4 wakes in one UTC day, the 5th is a loud rsi_wake_budget_exhausted, the next day wakes", async () => {
    const h = harness();
    h.setClock(Date.parse("2031-03-04T01:00:00.000Z"));
    for (const rig of ["r1", "r2", "r3", "r4"]) {
      h.source.rigs = [...h.source.rigs, rig];
      expect((await h.scan()).outcome.action).toBe("send");
    }
    h.source.rigs = [...h.source.rigs, "r5"];
    const fifth = await h.scan();
    expect(fifth.outcome).toMatchObject({ action: "skip", reason: RSI_WAKE_BUDGET_EXHAUSTED });
    expect(h.sends).toHaveLength(4);
    expect(h.history().filter((r) => r.skip_reason === RSI_WAKE_BUDGET_EXHAUSTED)).toHaveLength(1);
    h.setClock(Date.parse("2031-03-05T00:30:00.000Z"));
    expect((await h.scan()).outcome.action).toBe("send");
    expect(h.sends).toHaveLength(5);
  });

  it("the brake: a latest weekly window at 90% is a loud rsi_budget_brake; below it, the wake is sent", async () => {
    const h = harness();
    const sample = (percent: number, capturedAt: string) => h.db.prepare(
      `INSERT INTO usage_samples (lane, seat_session, captured_at, window, window_used_percent)
       VALUES ('provider_window', 'some-seat@kernel', ?, 'weekly', ?)`,
    ).run(capturedAt, percent);
    sample(10, "2031-03-04T04:00:00.000Z");
    sample(90, "2031-03-04T05:00:00.000Z");
    h.source.rigs = ["r1"];
    const braked = await h.scan();
    expect(braked.outcome).toMatchObject({ action: "skip", reason: RSI_BUDGET_BRAKE });
    expect(h.sends).toHaveLength(0);
    expect(h.history().map((r) => r.skip_reason)).toEqual([RSI_BUDGET_BRAKE]);
    sample(89.9, "2031-03-04T05:30:00.000Z");
    expect((await h.scan()).outcome.action).toBe("send");
  });

  it("a projection that refuses the query (unreadable health policy) carries forward and never throws", async () => {
    const db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const source = new ScriptedSource(() => new Date(T0));
    const policy = makeHealthFindingWakePolicy({
      db, sources: [source], now: () => new Date(T0),
      projection: { records: () => { throw new Error("policy unreadable"); }, coverage: () => [] },
    });
    const job = { jobId: "j", target: { session: STEWARD } } as never;
    await expect(policy.evaluate(job)).resolves.toMatchObject({ action: "skip", reason: RSI_NO_NEW_FINDING });
  });
});

describe("RSI B1 boot registration (rsi.steward_session)", () => {
  const rsiJobs = (db: Database.Database) => new WatchdogJobsRepository(db).listAll()
    .filter((job) => job.targetSession === RSI_WAKE_ANCHOR || job.targetSession === RSI_DAILY_REPORT_ANCHOR
      || job.policy === HEALTH_FINDING_WAKE_POLICY);
  const specTarget = (yaml: string) => (parseYaml(yaml) as { target: { session: string } }).target.session;

  it("an empty or blank steward registers nothing; a set one registers the two jobs once, and a new steward retargets them", () => {
    const db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const repo = new WatchdogJobsRepository(db);
    expect(ensureRsiStewardJobs(repo, "")).toBeNull();
    expect(ensureRsiStewardJobs(repo, "   ")).toBeNull();
    expect(rsiJobs(db)).toHaveLength(0);

    ensureRsiStewardJobs(repo, STEWARD);
    ensureRsiStewardJobs(repo, STEWARD);
    ensureRsiStewardJobs(repo, "other-steward@kernel");
    const jobs = rsiJobs(db);
    expect(jobs.map((j) => [j.policy, j.targetSession, j.intervalSeconds, specTarget(j.specYaml)]).sort()).toEqual([
      [HEALTH_FINDING_WAKE_POLICY, RSI_WAKE_ANCHOR, 3600, "other-steward@kernel"],
      ["periodic-reminder", RSI_DAILY_REPORT_ANCHOR, 86_400, "other-steward@kernel"],
    ]);
  });

  describe("through createDaemon", () => {
    const saved = { noKernel: process.env.OPENRIG_NO_KERNEL, steward: process.env.OPENRIG_RSI_STEWARD_SESSION };
    const dirs: string[] = [];
    const dbs: Database.Database[] = [];
    beforeAll(() => { process.env.OPENRIG_NO_KERNEL = "1"; });
    afterEach(() => { while (dbs.length) dbs.pop()!.close(); });
    afterAll(() => {
      for (const [key, value] of [["OPENRIG_NO_KERNEL", saved.noKernel], ["OPENRIG_RSI_STEWARD_SESSION", saved.steward]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    });
    const boot = async (dbPath: string) => {
      const daemon = await createDaemon({ dbPath });
      dbs.push(daemon.db);
      return daemon.db;
    };

    it("with rsi.steward_session unset the daemon arms no RSI job (the digest jobs are the control)", async () => {
      delete process.env.OPENRIG_RSI_STEWARD_SESSION;
      const dir = mkdtempSync(join(tmpdir(), "rsi-b1-unset-"));
      dirs.push(dir);
      const db = await boot(join(dir, "openrig.sqlite"));
      // Positive control: the boot-registration block ran (it arms the two digest windows).
      expect(new WatchdogJobsRepository(db).listAll().filter((j) => j.policy === "delivery-digest-flush")).toHaveLength(2);
      expect(rsiJobs(db)).toHaveLength(0);
    });

    it("with rsi.steward_session set the daemon arms the wake and the report, idempotently across a restart", async () => {
      process.env.OPENRIG_RSI_STEWARD_SESSION = STEWARD;
      const dir = mkdtempSync(join(tmpdir(), "rsi-b1-set-"));
      dirs.push(dir);
      const dbPath = join(dir, "openrig.sqlite");
      const first = rsiJobs(await boot(dbPath));
      dbs.pop()!.close();
      const daemon = await createDaemon({ dbPath });
      dbs.push(daemon.db);
      const second = rsiJobs(daemon.db);
      delete process.env.OPENRIG_RSI_STEWARD_SESSION;
      expect(second.map((j) => j.jobId).sort()).toEqual(first.map((j) => j.jobId).sort());
      expect(second.map((j) => [j.policy, j.state, specTarget(j.specYaml)]).sort()).toEqual([
        [HEALTH_FINDING_WAKE_POLICY, "active", STEWARD],
        ["periodic-reminder", "active", STEWARD],
      ]);

      // The production engine carries the policy, wired to the real projection and the real D4
      // source: an archived rig with a running latest session is a finding the wake sends for.
      // (Evaluated without delivery: no transport, no tmux.) The daemon runs on the wall clock, so
      // the fixture session must be in the past: a future one makes the source refuse its window
      // (`unavailable`), and the wake then carries forward instead of sending.
      daemon.db.prepare("INSERT INTO rigs (id, name, archived_at) VALUES ('rig-dead', 'cel-track', '2020-06-01 00:00:00')").run();
      daemon.db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('n-dead', 'rig-dead', 'n-dead')").run();
      daemon.db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES ('s-dead', 'n-dead', 's@x', 'running', '2020-01-02 03:04:05')").run();
      const wakeJob = second.find((j) => j.policy === HEALTH_FINDING_WAKE_POLICY)!;
      const policy = daemon.deps.watchdogPolicyEngine!.resolvePolicy(HEALTH_FINDING_WAKE_POLICY);
      expect(policy).toBeDefined();
      const outcome = await policy!.evaluate({ jobId: wakeJob.jobId, target: { session: STEWARD } } as never);
      expect(outcome).toMatchObject({ action: "send", target: { session: STEWARD } });
      expect(outcome.action === "send" ? outcome.message : "").toContain(fp("rig-dead"));
    });
  });
});

describe("RSI migration 113: the two tables B1 and B2 share", () => {
  it("creates rsi_finding_state and rsi_notifications with exactly the design's columns", () => {
    const db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const columns = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; pk: number }>)
      .map((c) => `${c.name}${c.pk ? ":pk" : ""}`);
    expect(columns("rsi_finding_state")).toEqual(["fingerprint:pk", "source", "state", "activated_at", "last_seen_at"]);
    expect(columns("rsi_notifications")).toEqual(["qitem_id:pk", "first_notified_at", "last_notified_at"]);
    expect(() => db.prepare(
      "INSERT INTO rsi_finding_state (fingerprint, source, state, activated_at, last_seen_at) VALUES ('f', 's', 'gone', 'a', 'b')",
    ).run()).toThrow(/CHECK/);
  });
});
