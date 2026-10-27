import { afterEach, describe, expect, it } from "vitest";
import { HealthProjectionService } from "../src/domain/health-detectors.js";
import { RSI_RETENTION_DISABLED_GROWTH } from "../src/domain/rsi/detector-ids.js";
import { createRsiSources } from "../src/domain/rsi/registry.js";
import { RETENTION_DISABLED_GROWTH_ROWS, RetentionDisabledGrowthSource } from "../src/domain/rsi/retention-growth-source.js";
import { INSTANCE, NOW, cleanupFixtures, fixture, hoursAgo, iso, span } from "./rsi-a2b-fixture.js";

afterEach(cleanupFixtures);

// OF-81: retention.enabled=false and a retained table grows without bound. The window, the keep
// rule and the threshold are restated here, not read from the module under test.
const days = (n: number) => n * 24;

type Fixture = ReturnType<typeof fixture>;
const source = (
  f: Fixture,
  o: { enabled?: boolean; usageDays?: () => number; watchdog?: () => { days: number; keepPerJob: number }; threshold?: number } = {},
) => new RetentionDisabledGrowthSource({
  ...f.deps(), retentionEnabled: o.enabled ?? false, usageSamplesDays: o.usageDays ?? (() => 14),
  watchdog: o.watchdog ?? (() => ({ days: 14, keepPerJob: 50 })), thresholdRows: o.threshold ?? 3,
});
const old = (f: Fixture, n: number, hoursOld = days(20)) => { for (let i = 0; i < n; i++) f.usage({ lane: "context", pct: 10, hoursAgo: hoursOld + i * 0.001 }); };
const fresh = (f: Fixture, n: number) => { for (let i = 0; i < n; i++) f.usage({ lane: "context", pct: 10, hoursAgo: days(1) + i * 0.001 }); };
const history = (f: Fixture, jobId: string, n: number, hoursOld: number) => {
  f.db.pragma("foreign_keys = OFF");
  for (let i = 0; i < n; i++) {
    f.db.prepare("INSERT INTO watchdog_history (history_id, job_id, evaluated_at, outcome) VALUES (?, ?, ?, 'skipped')")
      .run(`${jobId}-${hoursOld}-${i}`, jobId, iso(hoursOld + i * 0.001));
  }
};

describe("D15 retention-disabled growth (OF-81)", () => {
  it("fires for a table with stale rows when retention is off, and reads a complete zero over the same rows when it is on", () => {
    const f = fixture();
    old(f, 3);

    const off = source(f, { enabled: false });
    const records = f.records(off);
    const on = source(f, { enabled: true });

    expect(records).toHaveLength(1);
    expect(records[0]!.detector).toBe(RSI_RETENTION_DISABLED_GROWTH);
    expect(records[0]!.scope).toEqual({ type: "instance", instanceId: INSTANCE });
    expect(span(records[0]!)).toMatchObject({ fingerprint: "rsi.retention-disabled-growth/table:usage_samples", count: 3, controlTotal: 0, population: 3 });
    // The control: same data, sweep on => nothing to say, and the coverage says it evaluated.
    expect(on.read()).toEqual([]);
    // N3: a complete zero that says why it did not look (D10 does the same: "retention disabled").
    expect(on.coverage()[0]).toMatchObject({ unit: "tables", total: 0, evaluated: 0, partial: false, note: "retention enabled: not evaluated" });
  });

  it("is a threshold: one stale row under it is quiet, the row that reaches it fires", () => {
    const below = fixture();
    old(below, 2);
    const at = fixture();
    old(at, 3);

    expect(source(below).read()).toEqual([]);
    expect(source(at).read()).toHaveLength(1);
  });

  it("counts only rows past the retention window: rows inside it are the control and never reach the threshold", () => {
    const f = fixture();
    fresh(f, 50);
    old(f, 2);
    expect(source(f).read()).toEqual([]);

    old(f, 1);
    const [record] = f.records(source(f));
    expect(span(record!)).toMatchObject({ count: 3, controlTotal: 50, population: 53 });
    expect(record!.explanation).toContain("past retention 3, within retention 50 = 53");
  });

  it("moves the line with the live retention window", () => {
    const f = fixture();
    for (let i = 0; i < 3; i++) f.usage({ lane: "context", pct: 10, hoursAgo: days(5) + i });

    expect(source(f, { usageDays: () => 14 }).read()).toEqual([]);
    expect(source(f, { usageDays: () => 3 }).read()).toHaveLength(1);
  });

  it("judges watchdog_history by the sweep's own keep rule: the newest K rows of a job are never stale, however old", () => {
    const f = fixture();
    history(f, "job-a", 6, days(30)); // all older than 14 d; keep 2 => 4 stale
    const wd = (keepPerJob: number) => source(f, { watchdog: () => ({ days: 14, keepPerJob }), threshold: 4 });

    const [record, ...rest] = f.records(wd(2));

    expect(rest).toEqual([]);
    expect(span(record!)).toMatchObject({ fingerprint: "rsi.retention-disabled-growth/table:watchdog_history", count: 4, controlTotal: 2, population: 6 });
    expect(wd(3).read()).toEqual([]); // 3 stale < 4
    // The keep rule is per job: a second job keeps its own newest rows.
    history(f, "job-b", 2, days(30));
    expect(f.records(wd(2)).map((r) => span(r).count)).toEqual([4]);
  });

  it("counts rows strictly newer within the job, so a tie at the keep boundary is kept (the sweep's `>`), and the count is exact", () => {
    const f = fixture();
    f.db.pragma("foreign_keys = OFF");
    const add = (id: string, hoursOld: number) => f.db.prepare("INSERT INTO watchdog_history (history_id, job_id, evaluated_at, outcome) VALUES (?, 'job-t', ?, 'skipped')").run(id, iso(hoursOld));
    // Newest first: t1, then a tie (t2, t2), then t3. Strictly-newer counts: 0, 1, 1, 3. All older than 14 d.
    add("t1", days(20)); add("t2a", days(21)); add("t2b", days(21)); add("t3", days(22));
    const wd = (keepPerJob: number) => source(f, { watchdog: () => ({ days: 14, keepPerJob }), threshold: 1 });

    expect(f.records(wd(2)).map((r) => span(r).count)).toEqual([1]); // only t3 has >= 2 newer
    expect(f.records(wd(1)).map((r) => span(r).count)).toEqual([3]); // t2a, t2b, t3
    expect(f.records(wd(4))).toEqual([]);                            // nothing has 4 newer
  });

  it("stays linear: 50,000 stale rows in ONE job read well inside a bound a quadratic count would miss by an order of magnitude", () => {
    const f = fixture();
    f.db.pragma("foreign_keys = OFF");
    const stmt = f.db.prepare("INSERT INTO watchdog_history (history_id, job_id, evaluated_at, outcome) VALUES (?, 'job-big', ?, 'skipped')");
    const start = hoursAgo(days(20)).getTime();
    f.db.transaction(() => { for (let i = 0; i < 50_000; i++) stmt.run(`b-${i}`, new Date(start - i * 1000).toISOString()); })();
    const big = source(f, { watchdog: () => ({ days: 14, keepPerJob: 50 }), threshold: 10_000 });

    const began = Date.now();
    const records = f.records(big);
    const elapsedMs = Date.now() - began;

    expect(records.map((r) => span(r).count)).toEqual([49_950]);
    // Measured: the rank form ~0.05 s here; the correlated form is ~25 s at this size (quadratic).
    expect(elapsedMs).toBeLessThan(5_000);
  }, 60_000);

  it("reports each table on its own fingerprint, so one table going quiet leaves the other's finding", () => {
    const f = fixture();
    old(f, 3);
    history(f, "job-a", 5, days(30));
    const both = f.records(source(f, { watchdog: () => ({ days: 14, keepPerJob: 2 }) }));

    expect(both.map((r) => span(r).fingerprint).sort()).toEqual([
      "rsi.retention-disabled-growth/table:usage_samples", "rsi.retention-disabled-growth/table:watchdog_history",
    ]);
    const usageOnly = f.records(source(f, { watchdog: () => ({ days: 14, keepPerJob: 5 }) }));
    expect(usageOnly.map((r) => span(r).fingerprint)).toEqual(["rsi.retention-disabled-growth/table:usage_samples"]);
  });

  it("is unavailable, never zero, for a retention setting it cannot use", () => {
    const f = fixture();
    old(f, 5);
    for (const bad of [Number.NaN, -1]) {
      const service = new HealthProjectionService([source(f, { usageDays: () => bad })]);
      expect(service.records()).toEqual([]);
      expect(service.coverage()).toEqual([expect.objectContaining({ source: "rsi-retention-disabled-growth", status: "unavailable", partial: true })]);
    }
  });

  it("fires at the shipped threshold of 10,000 stale rows through the one registry, and not at 9,999", () => {
    expect(RETENTION_DISABLED_GROWTH_ROWS).toBe(10_000);
    const insert = (f: Fixture, n: number) => {
      const stmt = f.db.prepare("INSERT INTO usage_samples (lane, seat_session, source, captured_at, used_percentage) VALUES ('context', 'seat@rig', 'src', ?, 10)");
      f.db.transaction(() => { for (let i = 0; i < n; i++) stmt.run(new Date(hoursAgo(days(20)).getTime() - i * 1000).toISOString()); })();
    };
    const run = (f: Fixture, retentionEnabled: boolean) => new HealthProjectionService(
      createRsiSources({ dbPath: f.dbPath, openrigHome: f.dir, retentionEnabled, now: () => NOW }),
    ).records().filter((r) => r.detector === RSI_RETENTION_DISABLED_GROWTH);

    const at = fixture();
    insert(at, 10_000);
    const under = fixture();
    insert(under, 9_999);

    expect(run(at, false).map((r) => span(r).count)).toEqual([10_000]);
    expect(run(under, false)).toEqual([]);
    expect(run(at, true)).toEqual([]); // sweep on: the same table is the sweep's backlog, not this finding
  });
});
