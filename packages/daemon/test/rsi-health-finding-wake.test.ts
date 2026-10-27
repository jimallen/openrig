import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
import { RSI_ARCHIVED_RIG_LIVE_SESSION, RSI_DETECTORS } from "../src/domain/rsi/detector-ids.js";
import { rsiFingerprint } from "../src/domain/rsi/fingerprint.js";
import {
  HEALTH_FINDING_WAKE_POLICY, RSI_BUDGET_BRAKE, RSI_DAILY_REPORT_ANCHOR, RSI_NO_NEW_FINDING,
  RSI_DAILY_REPORT_MESSAGE, RSI_SOURCE_BLIND, RSI_WAKE_ANCHOR, RSI_WAKE_BUDGET_EXHAUSTED, ensureRsiStewardJobs,
  makeHealthFindingWakePolicy, parseWakeReceipt, scanFindingState, type HealthFindingWakePolicy,
} from "../src/domain/rsi/health-finding-wake.js";

// The clock is injected far from wall clock: a wall-clock reversion would land every bucket and
// every UTC day in 2026, not 2031.
const T0 = Date.parse("2031-03-04T05:06:07.000Z");
const HOUR = 3_600_000;
const STEWARD = "improve-steward@kernel";
const D = RSI_ARCHIVED_RIG_LIVE_SESSION;
const fp = (rig: string, detector: string = D) => rsiFingerprint(detector, `rig:${rig}`);
/** A second, test-only detector id for the two-source rows. */
const D_B = "rsi.test-second-source";

/** One D4-shaped telemetry finding for rig `rig`, as the real source builds it. */
function finding(rig: string, nowIso: string, detector: string = D): HealthDetectorObservation {
  const fingerprint = fp(rig, detector);
  const seen = "2031-01-01T00:00:00.000Z";
  return {
    kind: "telemetry-finding", detectorId: detector, fingerprint, episodeKey: fingerprint,
    scope: { type: "rig", rigId: rig }, episodeStartedAt: seen, lastObservedAt: nowIso,
    source: boundHealthEvidence([{
      type: "telemetry-span", sourceOrder: 0, observedAt: seen, detectorId: detector, class: "live-session-on-archived-rig",
      fingerprint, count: 1, controlTotal: 0, population: 1, firstSeq: 1, lastSeq: 1, firstSeen: seen, lastSeen: seen,
    }], { source: "telemetry-span", startedAt: seen, endedAt: nowIso, limit: 1, retentionSeconds: 86_400 * 365 },
    deriveHealthSourceFreshness({ evaluatedAt: nowIso, newestSourceAt: nowIso, maxAgeSeconds: 600 })),
    summary: `rig ${rig}`, threshold: "t", explanation: "e", suggestedInspection: "i",
  };
}

/** A controllable RSI source behind the REAL HealthProjectionService: findings, a failing read
 * (the projection reports it `unavailable`), or a bounded read (`partial` coverage). */
class ScriptedSource implements HealthObservationSource {
  readonly detectors: string[];
  rigs: string[] = [];
  mode: "ok" | "throw" | "partial" = "ok";
  constructor(private readonly clock: () => Date, readonly name = "rsi-telemetry", private readonly detector: string = D) {
    this.detectors = [detector];
  }
  read(): readonly HealthDetectorObservation[] {
    if (this.mode === "throw") throw new Error("source read failed");
    const nowIso = this.clock().toISOString();
    return this.rigs.map((rig) => finding(rig, nowIso, this.detector));
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
  const sourceB = new ScriptedSource(now, "rsi-second", D_B);
  const projection = new HealthProjectionService([source, sourceB]);
  const jobsRepo = new WatchdogJobsRepository(db, now);
  const historyLog = new WatchdogHistoryLog(db);
  const logs: string[] = [];
  const sends: Array<{ targetSession: string; message: string; occurrenceId: string; status: string }> = [];
  const engine = new WatchdogPolicyEngine({
    jobsRepo, historyLog, eventBus: new EventBus(db), now, log: (line) => { logs.push(line); },
    deliver: async (req, src) => {
      const status = script(src);
      sends.push({ targetSession: req.targetSession, message: req.message, occurrenceId: src.occurrenceId!, status });
      return { status };
    },
    additionalPolicies: [makeHealthFindingWakePolicy({ db, projection, sources: [source, sourceB], now })],
  });
  // Read `wake` structurally (not through `armed`) so this harness also runs against the
  // pre-F2 return shape when the new rows are measured red at the previous tip.
  let { wake } = ensureRsiStewardJobs(jobsRepo, STEWARD) as unknown as { wake: { jobId: string } };
  /** Unset the steward and set it again: the wake job is retired and a NEW job (new id, empty history, no receipt) takes its place. */
  const rearm = () => {
    ensureRsiStewardJobs(jobsRepo, "");
    const again = ensureRsiStewardJobs(jobsRepo, STEWARD);
    if (!again.armed) throw new Error("steward did not re-arm");
    wake = again.wake;
  };
  const scan = async () => {
    const result = await engine.evaluate(jobsRepo.getByIdOrThrow(wake.jobId));
    clock = new Date(clock.getTime() + HOUR);
    return result;
  };
  const receipt = () => parseWakeReceipt((db.prepare("SELECT last_fired_condition AS c FROM watchdog_jobs WHERE job_id = ?")
    .get(wake.jobId) as { c: string | null }).c);
  const historyNotes = () => db.prepare("SELECT skip_reason, evaluation_notes FROM watchdog_history WHERE job_id = ? ORDER BY evaluated_at, history_id")
    .all(wake.jobId) as Array<{ skip_reason: string | null; evaluation_notes: string | null }>;
  const history = () => db.prepare("SELECT outcome, skip_reason FROM watchdog_history WHERE job_id = ? ORDER BY evaluated_at, history_id")
    .all(wake.jobId) as Array<{ outcome: string; skip_reason: string | null }>;
  const state = (fingerprint: string) => db.prepare("SELECT state, activated_at FROM rsi_finding_state WHERE fingerprint = ?")
    .get(fingerprint) as { state: string; activated_at: string } | undefined;
  return { db, jobsRepo, historyLog, logs, rearm, jobId: () => wake.jobId, projection, source, sourceB, sends, scan, receipt, history, historyNotes, state, setClock: (ms: number) => { clock = new Date(ms); } };
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
    expect(during.outcome).toMatchObject({ action: "skip", reason: RSI_SOURCE_BLIND });
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

  it("a failed delivery spends no budget: 4 failed attempts, then the 5th hour of the same UTC day is delivered", async () => {
    let calls = 0;
    const h = harness(() => (++calls <= 4 ? "failed" : "ok"));
    h.setClock(Date.parse("2031-03-04T01:00:00.000Z"));
    h.source.rigs = ["r1"];
    for (let i = 0; i < 4; i++) await h.scan();
    const fifth = await h.scan();
    expect(fifth.outcome.action).toBe("send");
    expect(h.sends.map((s) => s.status)).toEqual(["failed", "failed", "failed", "failed", "ok"]);
    expect(h.history().filter((r) => r.skip_reason === RSI_WAKE_BUDGET_EXHAUSTED)).toHaveLength(0);
  });

  it("a budget-exhausted day stays quiet across an unchanged hour: 0 history rows", async () => {
    const h = harness();
    h.setClock(Date.parse("2031-03-04T01:00:00.000Z"));
    for (const rig of ["r1", "r2", "r3", "r4"]) {
      h.source.rigs = [...h.source.rigs, rig];
      await h.scan();
    }
    expect(h.sends.filter((s) => s.status === "ok")).toHaveLength(4);
    const rows = h.history().length;
    const unchanged = await h.scan();
    expect(unchanged.outcome).toMatchObject({ action: "skip", reason: RSI_NO_NEW_FINDING });
    expect(h.history()).toHaveLength(rows);
  });

  it("per-source carry-forward: a failed source keeps its fingerprints while a complete source quiets its own", async () => {
    const h = harness();
    h.source.rigs = ["a1"];
    h.sourceB.rigs = ["b1"];
    await h.scan();
    h.source.rigs = [];
    h.sourceB.mode = "throw";
    const during = await h.scan();
    expect(during.outcome).toMatchObject({ action: "skip", reason: RSI_SOURCE_BLIND });
    expect(h.state(fp("a1"))?.state).toBe("quiet");
    expect(h.state(fp("b1", D_B))?.state).toBe("active");
    h.sourceB.mode = "ok";
    const recovered = await h.scan();
    expect(recovered.outcome).toMatchObject({ action: "skip", reason: RSI_NO_NEW_FINDING });
    expect(h.sends).toHaveLength(1);
  });

  it("under the brake an unchanged hour is still quiet: 0 history rows", async () => {
    const h = harness();
    h.source.rigs = ["r1"];
    await h.scan();
    h.db.prepare(
      `INSERT INTO usage_samples (lane, seat_session, captured_at, window, window_used_percent)
       VALUES ('provider_window', 'some-seat@kernel', '2031-03-04T05:30:00.000Z', 'weekly', 95)`,
    ).run();
    const rows = h.history().length;
    const unchanged = await h.scan();
    expect(unchanged.outcome).toMatchObject({ action: "skip", reason: RSI_NO_NEW_FINDING });
    expect(h.history()).toHaveLength(rows);
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
    await expect(policy.evaluate(job)).resolves.toMatchObject({ action: "skip", reason: RSI_SOURCE_BLIND });
  });
});

describe("OF-72: RSI blindness is recorded, reported, and does not outlive its cause", () => {
  it("an unavailable source with nothing new is a LOUD skip: one history row names the source and the reason", async () => {
    const h = harness();
    h.source.rigs = ["r1"];
    await h.scan();
    const rows = h.history().length;
    h.source.mode = "throw";

    const blind = await h.scan();

    expect(blind.outcome).toMatchObject({ action: "skip", reason: RSI_SOURCE_BLIND });
    expect(h.history()).toHaveLength(rows + 1);
    const last = h.historyNotes().at(-1)!;
    expect(last.skip_reason).toBe(RSI_SOURCE_BLIND);
    expect(JSON.parse(last.evaluation_notes!)).toMatchObject({ carriedForward: [{ source: "rsi-telemetry", reason: "unavailable" }] });
    // The fingerprint was carried forward, not removed.
    expect(h.state(fp("r1"))?.state).toBe("active");
  });

  it("a partial source is recorded the same way, with reason partial; a healthy hour afterwards is quiet again", async () => {
    const h = harness();
    h.source.rigs = ["r1"];
    await h.scan();
    h.source.mode = "partial";
    expect((await h.scan()).outcome).toMatchObject({ action: "skip", reason: RSI_SOURCE_BLIND });
    expect(JSON.parse(h.historyNotes().at(-1)!.evaluation_notes!).carriedForward).toEqual([{ source: "rsi-telemetry", reason: "partial" }]);
    const rows = h.history().length;
    h.source.mode = "ok";
    expect((await h.scan()).outcome).toMatchObject({ action: "skip", reason: RSI_NO_NEW_FINDING });
    expect(h.history()).toHaveLength(rows);
  });

  it("a projection that refuses the query is recorded as blindness too (every source projection-failed)", async () => {
    const db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const source = new ScriptedSource(() => new Date(T0));
    const policy = makeHealthFindingWakePolicy({
      db, sources: [source], now: () => new Date(T0),
      projection: { records: () => { throw new Error("policy unreadable"); }, coverage: () => [] },
    });
    await expect(policy.evaluate({ jobId: "j", target: { session: STEWARD } } as never)).resolves.toMatchObject({
      action: "skip", reason: RSI_SOURCE_BLIND, notes: { carriedForward: [{ source: "rsi-telemetry", reason: "projection-failed" }] },
    });
  });

  describe("one history row and one event per blind episode (OF-118), not one per hour", () => {
    const skippedEvents = (h: ReturnType<typeof harness>) =>
      (h.db.prepare("SELECT count(*) AS n FROM events WHERE type = 'watchdog.evaluation_skipped'").get() as { n: number }).n;
    const blindRows = (h: ReturnType<typeof harness>) => h.history().filter((r) => r.skip_reason === RSI_SOURCE_BLIND).length;

    it("twelve blind hours of one source and reason write exactly one row and one event, and wake nobody", async () => {
      const h = harness();
      h.source.rigs = ["r1"];
      await h.scan();
      const rows = h.history().length;
      const events = skippedEvents(h);
      h.source.mode = "throw";

      const reasons: Array<string> = [];
      for (let hour = 0; hour < 12; hour++) reasons.push(((await h.scan()).outcome as { reason: string }).reason);

      expect(reasons).toEqual([RSI_SOURCE_BLIND, ...Array(11).fill("rsi_source_blind_ongoing")]);
      expect(h.history()).toHaveLength(rows + 1);
      expect(skippedEvents(h)).toBe(events + 1);
      expect(h.sends).toHaveLength(1);                         // only the original wake
      expect(h.state(fp("r1"))?.state).toBe("active");         // carried forward all along
    });

    it("the episode ends when the source reads in full again: the next blindness is a new episode with its own row", async () => {
      const h = harness();
      h.source.rigs = ["r1"];
      await h.scan();
      h.source.mode = "throw";
      await h.scan(); await h.scan();
      h.source.mode = "ok";
      expect((await h.scan()).outcome).toMatchObject({ reason: RSI_NO_NEW_FINDING });
      expect(blindRows(h)).toBe(1);
      h.source.mode = "throw";
      expect((await h.scan()).outcome).toMatchObject({ reason: RSI_SOURCE_BLIND });
      expect(blindRows(h)).toBe(2);
    });

    it("a new reason for the same source, and a second source going blind, each open a new episode; the first stays quiet", async () => {
      const h = harness();
      h.source.rigs = ["r1"];
      await h.scan();
      h.source.mode = "throw";
      await h.scan();                                          // rsi-telemetry unavailable: row 1
      h.source.mode = "partial";
      expect((await h.scan()).outcome).toMatchObject({ reason: RSI_SOURCE_BLIND }); // same source, reason partial: row 2
      h.sourceB.mode = "throw";
      expect((await h.scan()).outcome).toMatchObject({ reason: RSI_SOURCE_BLIND }); // rsi-second joins: row 3
      expect((await h.scan()).outcome).toMatchObject({ reason: "rsi_source_blind_ongoing" });
      expect(blindRows(h)).toBe(3);
      // Back to the first reason after the partial episode closed it: a new episode again.
      h.source.mode = "throw";
      expect((await h.scan()).outcome).toMatchObject({ reason: RSI_SOURCE_BLIND });
      expect(blindRows(h)).toBe(4);
    });

    // Review B1: the episode opens in the scan, but the nothing-new hour is the only one whose outcome is
    // rsi_source_blind. An episode that starts in an hour another source sends (or the brake or the budget
    // skips) must still leave a row the report can find: the outcome's own row names it in notes.newlyBlind.
    it.each(["send", "brake", "budget"] as const)("a source that goes blind in an hour the wake is %s still leaves a row naming the episode, and later hours stay quiet", async (kind) => {
      const h = harness();
      if (kind === "brake") {
        h.db.prepare(`INSERT INTO usage_samples (lane, seat_session, captured_at, window, window_used_percent)
          VALUES ('provider_window', 'some-seat@kernel', '2031-03-04T05:00:00.000Z', 'weekly', 95)`).run();
      }
      if (kind === "budget") {
        const jobId = (h.db.prepare("SELECT job_id AS id FROM watchdog_jobs WHERE policy = 'health-finding-wake'").get() as { id: string }).id;
        const evaluatedAt = new Date(T0 - 60_000).toISOString();
        for (let i = 0; i < 4; i++) {
          h.db.prepare("INSERT INTO watchdog_history (history_id, job_id, evaluated_at, outcome, delivery_status) VALUES (?, ?, ?, 'sent', 'ok')").run(`sent-${i}`, jobId, evaluatedAt);
        }
      }
      h.source.mode = "throw";                                   // rsi-telemetry goes blind ...
      h.sourceB.rigs = ["r2"];                                   // ... in the hour rsi-second reports a new finding
      const first = await h.scan();
      expect(first.outcome.action).toBe(kind === "send" ? "send" : "skip");

      const later: string[] = [];
      for (let hour = 0; hour < 3; hour++) later.push(((await h.scan()).outcome as { reason: string }).reason);

      expect(later.every((reason) => reason !== RSI_SOURCE_BLIND)).toBe(true);
      const episodeRows = h.historyNotes().filter((r) => r.evaluation_notes !== null
        && (JSON.parse(r.evaluation_notes).newlyBlind ?? []).some((p: { source: string; reason: string }) => p.source === "rsi-telemetry" && p.reason === "unavailable"));
      expect(episodeRows).toHaveLength(1);                       // exactly one row opens the episode, whatever the hour's outcome
    });

    it("no detector id can collide with the reserved episode prefix (its real fingerprints would be filtered out of the active set)", () => {
      expect(RSI_DETECTORS.length).toBeGreaterThan(10);          // positive control: the population checked
      expect(RSI_DETECTORS.filter((id) => `${id}/`.startsWith("rsi.source-blind") || "rsi.source-blind/".startsWith(`${id}/`))).toEqual([]);
    });

    // OF-131 (review-v9 N1): an episode lives in rsi_finding_state, which has no job id, while the loud row is in a wake job's
    // history. A wake job re-armed as a NEW job (steward unset, then set) never showed an episode that was already open.
    describe("a re-armed wake job names an episode an earlier job opened (OF-131)", () => {
      const namedBy = (h: ReturnType<typeof harness>, jobId: string) => (h.db.prepare("SELECT evaluation_notes FROM watchdog_history WHERE job_id = ?")
        .all(jobId) as Array<{ evaluation_notes: string | null }>)
        .filter((r) => r.evaluation_notes !== null && (JSON.parse(r.evaluation_notes).newlyBlind ?? [])
          .some((p: { source: string; reason: string }) => p.source === "rsi-telemetry" && p.reason === "unavailable"));

      it("the new job's first blind hour is loud and names the open episode; its later hours are quiet; the episode keeps its start", async () => {
        const h = harness();
        const first = h.jobId();
        h.source.mode = "throw";
        await h.scan();                                          // job 1 opens the episode
        const started = h.state("rsi.source-blind/rsi-telemetry/unavailable")!.activated_at;
        expect(namedBy(h, first)).toHaveLength(1);

        h.rearm();
        expect(h.jobId()).not.toBe(first);                       // positive control: a different job
        expect((await h.scan()).outcome).toMatchObject({ action: "skip", reason: RSI_SOURCE_BLIND });
        expect(namedBy(h, h.jobId())).toHaveLength(1);           // the new job's own history names it
        for (let hour = 0; hour < 3; hour++) expect((await h.scan()).outcome).toMatchObject({ reason: "rsi_source_blind_ongoing" });
        expect(namedBy(h, h.jobId())).toHaveLength(1);
        expect(namedBy(h, first)).toHaveLength(1);               // the retired job's history is untouched
        expect(h.state("rsi.source-blind/rsi-telemetry/unavailable")).toEqual({ state: "active", activated_at: started });
      });

      it("adds no wake: a re-armed job's blind hour with nothing new sends nothing and spends no budget", async () => {
        const h = harness();
        h.source.mode = "throw";
        await h.scan();
        h.rearm();
        await h.scan(); await h.scan();
        expect(h.sends).toHaveLength(0);
        expect(h.history().filter((r) => r.outcome === "sent")).toHaveLength(0);
      });

      it("an episode opened by the previous revision (stamped a few ms after its row) is still recognised as named", async () => {
        const h = harness();
        h.source.mode = "throw";
        await h.scan();
        const key = "rsi.source-blind/rsi-telemetry/unavailable";
        const rowAt = (h.db.prepare("SELECT evaluated_at AS at FROM watchdog_history WHERE job_id = ?").get(h.jobId()) as { at: string }).at;
        h.db.prepare("UPDATE rsi_finding_state SET activated_at = ? WHERE fingerprint = ?").run(new Date(Date.parse(rowAt) + 7).toISOString(), key);
        expect((await h.scan()).outcome).toMatchObject({ reason: "rsi_source_blind_ongoing" });
        expect(h.history().filter((r) => r.skip_reason === RSI_SOURCE_BLIND)).toHaveLength(1);
      });

      it("a history row naming an EARLIER episode of the same pair does not count: a reopened episode is loud again", async () => {
        const h = harness();
        h.source.mode = "throw";
        await h.scan();
        h.source.mode = "ok";
        await h.scan();                                          // read in full: the episode closes
        h.source.mode = "throw";
        expect((await h.scan()).outcome).toMatchObject({ reason: RSI_SOURCE_BLIND });
        h.rearm();
        expect((await h.scan()).outcome).toMatchObject({ reason: RSI_SOURCE_BLIND });
        expect(namedBy(h, h.jobId())).toHaveLength(1);
      });

      // The next two rows stand in an episode that ANOTHER job opened by writing its state row directly: a retired job never resumes,
      // so the job's own history cannot otherwise hold a row for a different or earlier episode while one is open.
      it("a row of this job that names a DIFFERENT reason of the same source does not count", async () => {
        const h = harness();
        h.source.mode = "throw";
        await h.scan();                                          // this job names rsi-telemetry/unavailable
        h.db.prepare("UPDATE rsi_finding_state SET state = 'quiet'").run();
        const startedLater = new Date(T0 + 30_000).toISOString();
        h.db.prepare("INSERT INTO rsi_finding_state (fingerprint, source, state, activated_at, last_seen_at) VALUES ('rsi.source-blind/rsi-telemetry/partial', 'rsi-telemetry', 'active', ?, ?)").run(startedLater, startedLater);
        h.source.mode = "partial";
        expect((await h.scan()).outcome).toMatchObject({ reason: RSI_SOURCE_BLIND });
      });

      it("a row of this job that names the same reason of ANOTHER source does not count", async () => {
        const h = harness();
        h.source.mode = "throw";
        await h.scan();                                          // rsi-telemetry/unavailable: named by this job and still open
        const startedLater = new Date(T0 + 30_000).toISOString();
        h.db.prepare("INSERT INTO rsi_finding_state (fingerprint, source, state, activated_at, last_seen_at) VALUES ('rsi.source-blind/rsi-second/unavailable', 'rsi-second', 'active', ?, ?)").run(startedLater, startedLater);
        h.sourceB.mode = "throw";
        expect((await h.scan()).outcome).toMatchObject({ reason: RSI_SOURCE_BLIND });
      });

      it("a row older than the open episode does not name it (an episode another job opened after this job's earlier episode closed)", async () => {
        const h = harness();
        h.source.mode = "throw";
        await h.scan();                                          // this job names episode 1 at T0
        h.db.prepare("UPDATE rsi_finding_state SET activated_at = ?, last_seen_at = ?").run(new Date(T0 + 2 * HOUR).toISOString(), new Date(T0 + 2 * HOUR).toISOString());
        expect((await h.scan()).outcome).toMatchObject({ reason: RSI_SOURCE_BLIND });
      });

      it("unreadable history notes count as not named: one more loud row, never a crash", async () => {
        const h = harness();
        h.source.mode = "throw";
        await h.scan();
        h.db.prepare("UPDATE watchdog_history SET evaluation_notes = 'not json {' WHERE job_id = ?").run(h.jobId());
        expect((await h.scan()).outcome).toMatchObject({ reason: RSI_SOURCE_BLIND });
        expect((await h.scan()).outcome).toMatchObject({ reason: "rsi_source_blind_ongoing" });
      });
    });

    // OF-131 (review-v9 B1 remainder): the episode used to commit in the scan, before the engine inserted its history row.
    describe("an episode is recorded only once its history row is written (OF-131)", () => {
      const episodes = (h: ReturnType<typeof harness>) => h.db.prepare("SELECT fingerprint FROM rsi_finding_state WHERE fingerprint LIKE 'rsi.source-blind/%'").all();

      it("a history insert that throws leaves no episode, so the next hour writes the loud row instead of losing it", async () => {
        const h = harness();
        h.source.mode = "throw";
        vi.spyOn(h.historyLog, "record").mockImplementationOnce(() => { throw new Error("history insert failed"); });
        await expect(h.scan()).rejects.toThrow("history insert failed");
        expect(episodes(h)).toEqual([]);                         // the lost-row hour opened nothing
        expect(h.history()).toHaveLength(0);

        h.setClock(T0 + HOUR);
        expect((await h.scan()).outcome).toMatchObject({ action: "skip", reason: RSI_SOURCE_BLIND });
        expect(h.history().filter((r) => r.skip_reason === RSI_SOURCE_BLIND)).toHaveLength(1);
        expect(episodes(h)).toHaveLength(1);
        expect((await h.scan()).outcome).toMatchObject({ reason: "rsi_source_blind_ongoing" });
      });

      it("a delivery that throws in the hour an episode opens leaves no episode either", async () => {
        const h = harness(() => { throw new Error("transport down"); });
        h.source.mode = "throw";
        h.sourceB.rigs = ["r2"];                                 // rsi-second reports a new finding, so the hour is a send
        await expect(h.scan()).rejects.toThrow("transport down");
        expect(episodes(h)).toEqual([]);
        expect(h.history()).toHaveLength(0);
      });

      it("a hook that fails after the row is written does not undo the wake or its receipt; the next hour is loud once more", async () => {
        const h = harness();
        h.source.mode = "throw";
        h.sourceB.rigs = ["r2"];
        h.db.exec("CREATE TRIGGER w5_refuse_episode BEFORE INSERT ON rsi_finding_state WHEN NEW.fingerprint LIKE 'rsi.source-blind/%' BEGIN SELECT RAISE(ABORT, 'episode write refused'); END");
        const first = await h.scan();
        expect(first.outcome.action).toBe("send");
        expect(h.sends).toHaveLength(1);
        expect(h.receipt()).not.toBeNull();                      // the engine still banked the receipt: no second wake next hour
        expect(h.history().map((r) => r.outcome)).toEqual(["sent"]);
        expect(episodes(h)).toEqual([]);

        h.db.exec("DROP TRIGGER w5_refuse_episode");
        expect((await h.scan()).outcome).toMatchObject({ action: "skip", reason: RSI_SOURCE_BLIND });
        expect(h.sends).toHaveLength(1);                         // still only the original wake
        expect(episodes(h)).toHaveLength(1);
      });

      it("a hook that fails is named in the log (policy, job id, error) and writes nothing a wake or the budget counts; a healthy hook logs nothing", async () => {
        const h = harness();
        h.source.mode = "throw";
        h.sourceB.rigs = ["r2"];
        const events = () => (h.db.prepare("SELECT count(*) AS n FROM events").get() as { n: number }).n;
        await h.scan();                                          // healthy hook: positive control, nothing logged
        expect(h.logs).toEqual([]);
        h.db.prepare("UPDATE rsi_finding_state SET state = 'quiet' WHERE fingerprint LIKE 'rsi.source-blind/%'").run(); // the episode only, not r2's finding
        h.db.exec("CREATE TRIGGER w5_refuse_episode BEFORE INSERT ON rsi_finding_state WHEN NEW.fingerprint LIKE 'rsi.source-blind/%' BEGIN SELECT RAISE(ABORT, 'episode write refused'); END");
        const rowsBefore = h.history().length;
        const eventsBefore = events();
        await h.scan();                                          // the blind skip row is written, the hook fails
        expect(h.logs).toHaveLength(1);
        expect(h.logs[0]).toContain("afterRecorded hook failed");
        expect(h.logs[0]).toContain(`policy ${HEALTH_FINDING_WAKE_POLICY}`);
        expect(h.logs[0]).toContain(`job ${h.jobId()}`);
        expect(h.logs[0]).toContain("episode write refused");
        expect(h.history()).toHaveLength(rowsBefore + 1);        // only the engine's own loud row; the log adds none
        expect(events()).toBe(eventsBefore + 1);                 // and only its own evaluation_skipped event
        expect(h.sends).toHaveLength(1);                         // no wake
      });

      it("the scan alone opens nothing (an evaluation that writes no row, such as a throttled send, leaves no episode); recordEpisodes opens it", () => {
        const h = harness();
        h.source.mode = "throw";
        const scan = scanFindingState(h.db, h.projection, [h.source, h.sourceB], new Date(T0));
        expect(scan.newlyBlind).toEqual([{ source: "rsi-telemetry", reason: "unavailable" }]);
        expect(episodes(h)).toEqual([]);                         // the scan alone opens nothing
        scan.recordEpisodes(new Date(T0).toISOString());
        expect(episodes(h)).toHaveLength(1);
      });
    });

    it("the daily report names the rows that open an episode in an hour with a new finding", () => {
      expect(RSI_DAILY_REPORT_MESSAGE).toContain("newlyBlind");
    });

    it("a blind episode is never an active finding: it is absent from the active set, the receipt and the wake message", async () => {
      const h = harness();
      h.source.mode = "throw";
      await h.scan();
      const episode = h.db.prepare("SELECT fingerprint, state FROM rsi_finding_state WHERE fingerprint LIKE 'rsi.source-blind/%'").all();
      expect(episode).toEqual([{ fingerprint: "rsi.source-blind/rsi-telemetry/unavailable", state: "active" }]);
      expect(scanFindingState(h.db, h.projection, [h.source, h.sourceB], new Date(T0 + 2 * HOUR)).active).toEqual([]);
      h.source.mode = "ok";
      h.source.rigs = ["r1"];
      await h.scan();                                          // a real finding wakes once, naming only itself
      expect(h.sends).toHaveLength(1);
      expect(h.sends[0]!.message).not.toContain("source-blind");
      expect(h.receipt()!.fps).toEqual([fp("r1")]);
    });
  });

  it("the daily report asks the steward to list the unavailable or partial sources", () => {
    expect(RSI_DAILY_REPORT_MESSAGE).toContain(RSI_SOURCE_BLIND);
  });

  it("an active finding of a source that is no longer registered goes quiet; a source still registered keeps its own", async () => {
    const h = harness();
    h.source.rigs = ["a1"];
    h.sourceB.rigs = ["b1"];
    await h.scan();
    expect(h.state(fp("a1"))?.state).toBe("active");

    // The deployment now registers only the second source.
    const scan = scanFindingState(h.db, h.projection, [h.sourceB], new Date(T0 + HOUR));

    expect(h.state(fp("a1"))?.state).toBe("quiet");
    expect(h.state(fp("b1", D_B))?.state).toBe("active");
    expect(scan.active.map((a) => a.fingerprint)).toEqual([fp("b1", D_B)]);
  });

  it("a retargeted steward does not inherit the old steward's receipt, so it is told every active finding once", async () => {
    const h = harness();
    h.source.rigs = ["r1"];
    await h.scan();
    expect(h.receipt()).not.toBeNull();

    ensureRsiStewardJobs(h.jobsRepo, STEWARD); // same steward: the receipt stays
    expect(h.receipt()).not.toBeNull();
    ensureRsiStewardJobs(h.jobsRepo, "new-steward@kernel");
    expect(h.receipt()).toBeNull();

    const after = await h.scan();
    expect(after.outcome.action).toBe("send");
    expect(h.sends.at(-1)).toMatchObject({ targetSession: "new-steward@kernel" });
    expect(h.sends.at(-1)!.message).toContain(fp("r1"));
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
    expect(ensureRsiStewardJobs(repo, "")).toEqual({ armed: false, reason: "rsi_steward_unset", disarmed: [] });
    expect(ensureRsiStewardJobs(repo, "   ")).toEqual({ armed: false, reason: "rsi_steward_unset", disarmed: [] });
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

  it("unset and invalid disarm both anchors (terminal, not stopped), and setting the key again re-arms them", () => {
    const db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const repo = new WatchdogJobsRepository(db);
    const active = () => rsiJobs(db).filter((j) => j.state === "active");
    const first = ensureRsiStewardJobs(repo, STEWARD);
    expect(active()).toHaveLength(2);

    const unset = ensureRsiStewardJobs(repo, "");
    expect(unset).toMatchObject({ armed: false, reason: "rsi_steward_unset" });
    expect(active()).toHaveLength(0);
    expect(rsiJobs(db).map((j) => [j.state, j.terminalReason])).toEqual([["terminal", "rsi_steward_unset"], ["terminal", "rsi_steward_unset"]]);

    const again = ensureRsiStewardJobs(repo, STEWARD);
    expect(again.armed).toBe(true);
    expect(active()).toHaveLength(2);
    expect(active().map((j) => j.jobId)).not.toContain(first.armed ? first.wake.jobId : "");

    const invalid = ensureRsiStewardJobs(repo, "no-at-sign");
    expect(invalid).toMatchObject({ armed: false, reason: "rsi_steward_invalid" });
    expect(active()).toHaveLength(0);
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

    it("boot reconciles the key: set arms, unset disarms, set again re-arms, invalid disarms and still boots", async () => {
      const dir = mkdtempSync(join(tmpdir(), "rsi-b1-cycle-"));
      dirs.push(dir);
      const dbPath = join(dir, "openrig.sqlite");
      const bootWith = async (value: string | undefined) => {
        if (value === undefined) delete process.env.OPENRIG_RSI_STEWARD_SESSION;
        else process.env.OPENRIG_RSI_STEWARD_SESSION = value;
        const db = await boot(dbPath);
        const jobs = new WatchdogJobsRepository(db).listAll();
        const counts = {
          digests: jobs.filter((j) => j.policy === "delivery-digest-flush" && j.state === "active").length,
          rsiActive: rsiJobs(db).filter((j) => j.state === "active").length,
        };
        dbs.pop()!.close();
        return counts;
      };
      try {
        expect(await bootWith(STEWARD)).toEqual({ digests: 2, rsiActive: 2 });
        expect(await bootWith(undefined)).toEqual({ digests: 2, rsiActive: 0 });
        expect(await bootWith(STEWARD)).toEqual({ digests: 2, rsiActive: 2 });
        expect(await bootWith("no-at-sign")).toEqual({ digests: 2, rsiActive: 0 });
      } finally {
        delete process.env.OPENRIG_RSI_STEWARD_SESSION;
      }
    });

    it("a registration that throws (ambiguous anchor rows) is logged and never stops the daemon booting", async () => {
      const dir = mkdtempSync(join(tmpdir(), "rsi-b1-ambiguous-"));
      dirs.push(dir);
      const dbPath = join(dir, "openrig.sqlite");
      const seed = createDb(dbPath);
      migrate(seed, ALL_MIGRATIONS);
      const repo = new WatchdogJobsRepository(seed);
      for (let i = 0; i < 2; i++) {
        repo.register({ policy: HEALTH_FINDING_WAKE_POLICY, targetSession: RSI_WAKE_ANCHOR, registeredBySession: "daemon@kernel",
          intervalSeconds: 3600, specYaml: `policy: ${HEALTH_FINDING_WAKE_POLICY}\ntarget:\n  session: ${STEWARD}\n` });
      }
      seed.close();
      process.env.OPENRIG_RSI_STEWARD_SESSION = STEWARD;
      try {
        const db = await boot(dbPath);
        expect(new WatchdogJobsRepository(db).listAll().filter((j) => j.policy === "delivery-digest-flush")).toHaveLength(2);
      } finally {
        delete process.env.OPENRIG_RSI_STEWARD_SESSION;
      }
    });

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
      // ONE RSI source array: every RSI detector id resolves to a source in the wake's map, and every
      // such source is one the health projection serves. A detector whose source is given only to
      // the projection (or to nothing) would be shown by `rig health` and never wake the steward.
      const detectorSources = (policy as HealthFindingWakePolicy).detectorSources;
      const projectionSources = new Set((daemon.deps.healthProjection!.list().coverage ?? []).map((c) => c.source));
      expect(RSI_DETECTORS.length).toBeGreaterThan(0);
      for (const id of RSI_DETECTORS) {
        expect(detectorSources.get(id), `RSI detector ${id} has no source in the wake`).toBeDefined();
        expect(projectionSources.has(detectorSources.get(id)!), `wake source for ${id} is not in the projection`).toBe(true);
      }
      const outcome = await policy!.evaluate({ jobId: wakeJob.jobId, target: { session: STEWARD } } as never);
      expect(outcome).toMatchObject({ action: "send", target: { session: STEWARD } });
      expect(outcome.action === "send" ? outcome.message : "").toContain(fp("rig-dead"));
    });

    it("ONE RSI source array with retention OFF too: every RSI detector id still maps to a wake source the projection serves", async () => {
      process.env.OPENRIG_RSI_STEWARD_SESSION = STEWARD;
      const savedRetention = process.env.OPENRIG_RETENTION_ENABLED;
      process.env.OPENRIG_RETENTION_ENABLED = "false";
      try {
        const dir = mkdtempSync(join(tmpdir(), "rsi-b1-retention-off-"));
        dirs.push(dir);
        const daemon = await createDaemon({ dbPath: join(dir, "openrig.sqlite") });
        dbs.push(daemon.db);
        const policy = daemon.deps.watchdogPolicyEngine!.resolvePolicy(HEALTH_FINDING_WAKE_POLICY);
        const detectorSources = (policy as HealthFindingWakePolicy).detectorSources;
        const coverage = daemon.deps.healthProjection!.list().coverage ?? [];
        const projectionSources = new Set(coverage.map((c) => c.source));
        expect(RSI_DETECTORS.length).toBeGreaterThan(0);
        for (const id of RSI_DETECTORS) {
          expect(detectorSources.get(id), `RSI detector ${id} has no source in the wake`).toBeDefined();
          expect(projectionSources.has(detectorSources.get(id)!), `wake source for ${id} is not in the projection`).toBe(true);
        }
        // Positive control that the setting took: D10 reads as the complete "retention disabled" zero.
        expect(coverage.find((c) => c.source === "rsi-retention-lag")).toMatchObject({ partial: false, total: 0, note: "retention disabled at daemon start; a change to retention.enabled takes effect at the next daemon start" });
      } finally {
        if (savedRetention === undefined) delete process.env.OPENRIG_RETENTION_ENABLED;
        else process.env.OPENRIG_RETENTION_ENABLED = savedRetention;
        delete process.env.OPENRIG_RSI_STEWARD_SESSION;
      }
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
    expect(columns("rsi_notification_banners")).toEqual(["id:pk", "sent_at", "item_count", "ok"]);
    expect((db.prepare("PRAGMA index_list(rsi_notification_banners)").all() as Array<{ name: string }>).map((i) => i.name))
      .toContain("idx_rsi_notification_banners_sent_at");
    expect(() => db.prepare(
      "INSERT INTO rsi_finding_state (fingerprint, source, state, activated_at, last_seen_at) VALUES ('f', 's', 'gone', 'a', 'b')",
    ).run()).toThrow(/CHECK/);
  });
});
