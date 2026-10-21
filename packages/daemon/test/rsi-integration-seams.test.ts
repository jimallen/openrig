import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { HealthProjectionService, type HealthObservationSource, type HealthSourceCoverage } from "../src/domain/health-detectors.js";
import {
  RSI_DETECTORS, RSI_ORPHANED_PARKED_OWNER_JOB, RSI_STARTUP_FAILURE_CLASS, RSI_WATCHDOG_DELIVERY_FAILURE,
} from "../src/domain/rsi/detector-ids.js";
import { sqliteUtcStamp } from "../src/domain/rsi/finding-builder.js";
import { scanFindingState } from "../src/domain/rsi/health-finding-wake.js";
import { readKnownFixes } from "../src/domain/rsi/known-fixes.js";
import { BudgetedRsiSource } from "../src/domain/rsi/read-budget.js";
import { createRsiSources } from "../src/domain/rsi/registry.js";

/**
 * The seams the RSI integration unified (A2a, A2b, A3 on one registry). B1's conformance test
 * (rsi-health-finding-wake.test.ts) pins the one array shared by the projection and the wake;
 * this file pins the registry's instance id, the budget around every source, D10's registration
 * with retention off, and the anchors.
 */

const dirs: string[] = [];
const open: Database.Database[] = [];
afterEach(() => {
  while (open.length) open.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** The registry's sources, by name. Restated here, not derived from the list under test. */
const REGISTRY_SOURCES = [
  "rsi-bootstrap-failure-class", "rsi-compaction-storm", "rsi-context-high-water", "rsi-orphaned-parked-owner-job",
  "rsi-outbox-unsettled", "rsi-permission-stall", "rsi-project-report", "rsi-provider-weekly-window", "rsi-retention-lag",
  "rsi-slow-op-file", "rsi-startup-failure-class", "rsi-telemetry", "rsi-watchdog-delivery-failure",
];

function home() {
  const dir = mkdtempSync(join(tmpdir(), "rsi-integ-"));
  dirs.push(dir);
  mkdirSync(join(dir, "rsi"));
  const dbPath = join(dir, "openrig.sqlite");
  const db = createDb(dbPath);
  open.push(db);
  migrate(db, ALL_MIGRATIONS);
  const event = (type: string, payload: Record<string, unknown>, at: Date) =>
    db.prepare("INSERT INTO events (type, payload, created_at) VALUES (?, ?, ?)").run(type, JSON.stringify({ type, ...payload }), sqliteUtcStamp(at));
  const failedFire = (jobId: string, at: Date) => event("watchdog.evaluation_fired", { jobId, policy: "p", targetSession: "t@r", deliveryStatus: "failed" }, at);
  return { dir, dbPath, db, event, failedFire };
}

const tickingClock = () => { let t = 0; return () => t++; };
const hoursBefore = (at: Date, hours: number) => new Date(at.getTime() - hours * 3_600_000);

describe("the one registry: instance id", () => {
  it("scopes every instance finding (A2a D1 and D3, A2b D12) to OPENRIG_HOME (the registry's openrigHome), never to a fixed 'local'", () => {
    const h = home();
    const wall = new Date();
    // The registry reads the wall clock. D1: three hits inside its 7-day window.
    for (const hours of [30, 20, 10]) h.event("node.startup_failed", { error: "pane returned to shell" }, hoursBefore(wall, hours));
    // D3: an active parked-owner job whose rig is archived.
    h.db.prepare("INSERT INTO rigs (id, name, archived_at) VALUES ('r-gone', 'gone-1', '2026-01-01 00:00:00')").run();
    h.db.prepare("INSERT INTO watchdog_jobs (job_id, policy, spec_yaml, target_session, interval_seconds, state, registered_by_session, registered_at) VALUES ('job-d3', 'parked-owner-consumer', 'y', 'parked-owner-consumer@gone-1', 120, 'active', 'daemon@kernel', '2026-01-01 00:00:00')").run();
    // D12 (A2b): one watchdog job with three failed deliveries in 7 days.
    for (const hours of [30, 20, 10]) h.failedFire("job-d12", hoursBefore(wall, hours));

    const records = new HealthProjectionService(createRsiSources({ dbPath: h.dbPath, openrigHome: h.dir })).records();

    // Positive controls: each seeded detector fired, and each is named, so the scope check below is never vacuous.
    for (const detector of [RSI_STARTUP_FAILURE_CLASS, RSI_ORPHANED_PARKED_OWNER_JOB, RSI_WATCHDOG_DELIVERY_FAILURE]) {
      const found = records.filter((r) => r.detector === detector);
      expect(found, `${detector} did not fire`).toHaveLength(1);
      expect(found[0]!.scope, `${detector} scope`).toEqual({ type: "instance", instanceId: h.dir });
    }
    const instanceScoped = records.filter((r) => r.scope.type === "instance");
    expect(instanceScoped.length).toBeGreaterThanOrEqual(3);
    for (const r of instanceScoped) expect(r.scope).toEqual({ type: "instance", instanceId: h.dir });
  });
});

describe("the one registry: the per-source time budget wraps every source", () => {
  it("registers each source exactly once, each inside the budget wrapper", () => {
    const h = home();
    const sources = createRsiSources({ dbPath: h.dbPath, openrigHome: h.dir });

    expect(sources.map((s) => s.name).sort()).toEqual(REGISTRY_SOURCES);
    for (const source of sources) expect(source, `${source.name} is not budgeted`).toBeInstanceOf(BudgetedRsiSource);
  });

  it("notes every source's over-budget read and keeps it complete: slow is not incomplete", () => {
    const h = home();
    const service = new HealthProjectionService(createRsiSources({ dbPath: h.dbPath, openrigHome: h.dir, budget: { budgetMs: 1, nowMs: tickingClock() } }));
    service.records();
    const coverage = service.coverage();

    expect(coverage.map((c) => c.source).sort()).toEqual(REGISTRY_SOURCES);
    for (const row of coverage) {
      expect(row, `${row.source} was not noted, or was marked partial`).toMatchObject({ partial: false, note: expect.stringMatching(/over budget: \d+ ms \(budget 1\)/) });
    }
  });

  it("leaves a read inside its budget unnoted (the control)", () => {
    const h = home();
    const service = new HealthProjectionService(createRsiSources({ dbPath: h.dbPath, openrigHome: h.dir, budget: { budgetMs: 1e9 } }));
    service.records();
    const coverage = service.coverage();

    expect(coverage.map((c) => c.source).sort()).toEqual(REGISTRY_SOURCES);
    for (const row of coverage) expect(JSON.stringify(row)).not.toContain("over budget");
    expect(coverage.filter((row) => row.partial === false).length).toBeGreaterThan(0);
  });

  it("B1 resolves AND activates on an over-budget read; a D1-D3 read really cut short stays partial", () => {
    const h = home();
    // Wall clock, so the same fixture reads identically at the pre-fix base (whose registry has no `now`).
    const NOW = new Date();
    let slow = false;
    let t = 0;
    // Each clock reading advances 5 s while `slow`: every read is then over its 1000 ms budget.
    const sources = createRsiSources({ dbPath: h.dbPath, openrigHome: h.dir, now: () => NOW, budget: { nowMs: () => (t += slow ? 5_000 : 0) } });
    const projection = new HealthProjectionService(sources);
    const d12 = () => (h.db.prepare("SELECT fingerprint, state FROM rsi_finding_state WHERE source = 'rsi-watchdog-delivery-failure' ORDER BY fingerprint").all() as Array<{ fingerprint: string; state: string }>);

    for (const hours of [30, 20, 10]) h.failedFire("job-a", hoursBefore(NOW, hours));
    scanFindingState(h.db, projection, sources, NOW);
    expect(d12()).toEqual([{ fingerprint: `${RSI_WATCHDOG_DELIVERY_FAILURE}/job:job-a`, state: "active" }]);

    // job-a recovers; job-b starts failing; three D1 events give D1 rows to cut short. Then one slow scan.
    h.db.prepare("DELETE FROM events WHERE type = 'watchdog.evaluation_fired'").run();
    for (const hours of [30, 20, 10]) h.failedFire("job-b", hoursBefore(NOW, hours));
    for (const hours of [30, 20, 10]) h.event("node.startup_failed", { error: "pane returned to shell" }, hoursBefore(NOW, hours));
    slow = true;
    const scan = scanFindingState(h.db, projection, sources, NOW);

    expect(d12()).toEqual([
      { fingerprint: `${RSI_WATCHDOG_DELIVERY_FAILURE}/job:job-a`, state: "quiet" },
      { fingerprint: `${RSI_WATCHDOG_DELIVERY_FAILURE}/job:job-b`, state: "active" },
    ]);
    const coverage = new Map(projection.coverage().map((c) => [c.source, c]));
    expect(coverage.get("rsi-watchdog-delivery-failure")).toMatchObject({ partial: false, note: expect.stringContaining("over budget:") });
    // D1's between-rows check stopped the read: that read is incomplete, and it stays partial and carried forward.
    expect(coverage.get("rsi-startup-failure-class")).toMatchObject({ partial: true, omitted: 3 });
    expect(scan.carriedForward).toContainEqual({ source: "rsi-startup-failure-class", reason: "partial" });
    expect(scan.carriedForward).not.toContainEqual(expect.objectContaining({ source: "rsi-watchdog-delivery-failure" }));
  });
});

describe("the one registry: D10 with retention off", () => {
  it("still registers D10, and reads it as a complete zero noted 'retention disabled', even over an old row", () => {
    const h = home();
    // Wall clock, so the same fixture reads identically at the pre-fix base (whose registry has no `now`).
    const NOW = new Date();
    h.db.prepare("INSERT INTO usage_samples (lane, seat_session, captured_at, used_percentage) VALUES ('context', 's@r', ?, 10)").run(hoursBefore(NOW, 60 * 24).toISOString());
    const sources = createRsiSources({ dbPath: h.dbPath, openrigHome: h.dir, retentionEnabled: false, now: () => NOW });
    const service = new HealthProjectionService(sources);

    expect(sources.map((s) => s.name).sort()).toEqual(REGISTRY_SOURCES);
    expect(service.records().filter((r) => r.detector === "rsi.retention-lag")).toEqual([]);
    expect(service.coverage().find((c) => c.source === "rsi-retention-lag")).toEqual({
      source: "rsi-retention-lag", evaluatedAt: NOW.toISOString(), unit: "tables", limit: expect.any(Number), total: 0, evaluated: 0, omitted: 0,
      partial: false, order: "single table", note: "retention disabled",
    });
    // Control: the same old row with retention on is a finding.
    expect(new HealthProjectionService(createRsiSources({ dbPath: h.dbPath, openrigHome: h.dir, now: () => NOW })).records()
      .filter((r) => r.detector === "rsi.retention-lag")).toHaveLength(1);
  });

  it("an active D10 finding goes quiet in B1 once retention is turned off", () => {
    const h = home();
    // Wall clock, so the same fixture reads identically at the pre-fix base (whose registry has no `now`).
    const NOW = new Date();
    h.db.prepare("INSERT INTO usage_samples (lane, seat_session, captured_at, used_percentage) VALUES ('context', 's@r', ?, 10)").run(hoursBefore(NOW, 60 * 24).toISOString());
    const state = () => h.db.prepare("SELECT state FROM rsi_finding_state WHERE source = 'rsi-retention-lag'").all();
    const on = createRsiSources({ dbPath: h.dbPath, openrigHome: h.dir, now: () => NOW });
    scanFindingState(h.db, new HealthProjectionService(on), on, NOW);
    expect(state()).toEqual([{ state: "active" }]);

    const off = createRsiSources({ dbPath: h.dbPath, openrigHome: h.dir, now: () => NOW, retentionEnabled: false });
    scanFindingState(h.db, new HealthProjectionService(off), off, NOW);
    expect(state()).toEqual([{ state: "quiet" }]);
  });
});

describe("BudgetedRsiSource", () => {
  const finding = { kind: "telemetry-finding" } as never;
  const fake = (coverage: HealthSourceCoverage[]): HealthObservationSource => ({
    name: "fake", detectors: ["rsi.fake"], read: () => [finding], coverage: () => coverage,
  });
  const available: HealthSourceCoverage = { source: "fake", evaluatedAt: "2031-01-01T00:00:00.000Z", unit: "rows", limit: 5, total: 2, evaluated: 2, omitted: 0, partial: false, order: "o", note: "anchors" };
  const cutShort: HealthSourceCoverage = { ...available, evaluated: 1, omitted: 1, partial: true, note: undefined };
  const unavailable: HealthSourceCoverage = { source: "fake", evaluatedAt: "2031-01-01T00:00:00.000Z", status: "unavailable", partial: true, reason: "r" };
  const steps = (...values: number[]) => () => values.shift()!;

  it("forwards name and detectors, so a disabled detector still skips the read", () => {
    const wrapped = new BudgetedRsiSource(fake([available]));
    expect([wrapped.name, wrapped.detectors]).toEqual(["fake", ["rsi.fake"]]);
  });

  it("over budget: keeps the findings and each row's own partial, appends the note, leaves an unavailable row alone", () => {
    const wrapped = new BudgetedRsiSource(fake([available, cutShort, unavailable]), { budgetMs: 5, nowMs: steps(0, 7) });

    expect(wrapped.read()).toEqual([finding]);
    expect(wrapped.coverage()).toEqual([
      { ...available, partial: false, note: "anchors; over budget: 7 ms (budget 5)" },
      { ...cutShort, partial: true, note: "over budget: 7 ms (budget 5)" },
      unavailable,
    ]);
  });

  it("over budget with no coverage: one complete row with the note, stamped with the source's clock", () => {
    const wrapped = new BudgetedRsiSource(fake([]), { budgetMs: 5, nowMs: steps(0, 5), now: () => new Date("2031-02-03T04:05:06.000Z") });
    wrapped.read();
    expect(wrapped.coverage()).toEqual([{ source: "fake", evaluatedAt: "2031-02-03T04:05:06.000Z", unit: "reads", limit: 1, total: 1, evaluated: 1,
      omitted: 0, partial: false, order: "single read", note: "over budget: 5 ms (budget 5)" }]);
  });

  it("under budget: the inner coverage, unchanged", () => {
    const wrapped = new BudgetedRsiSource(fake([available]), { budgetMs: 5, nowMs: steps(0, 4) });
    wrapped.read();
    expect(wrapped.coverage()).toEqual([available]);
  });
});

describe("known-fix anchors after unification", () => {
  // The A2b and A3 ids, restated: a dropped id must fail here.
  const UNIFIED_IDS = [
    "rsi.compaction-storm", "rsi.context-high-water", "rsi.provider-weekly-window", "rsi.outbox-unsettled",
    "rsi.permission-stall", "rsi.retention-lag", "rsi.watchdog-delivery-failure", "rsi.project-report",
    "rsi.slow-op-subthreshold-flood",
  ];

  it("accepts an anchor for every A2b and A3 detector id, and still refuses an unknown one", () => {
    const h = home();
    const path = join(h.dir, "rsi", "known-fixes.json");
    const anchor = (id: string) => ({ fingerprint: `${id}/subject:x`, ref: "OF-T", fixSha: "abc1234", deployedAt: "2031-03-01T00:00:00Z", recordedAt: "2031-03-02T00:00:00Z" });
    writeFileSync(path, JSON.stringify([...UNIFIED_IDS.map(anchor), anchor("rsi.not-a-detector")]));

    const read = readKnownFixes(path, new Date("2031-03-04T00:00:00Z"));

    expect(read.status).toBe("available");
    if (read.status !== "available") return;
    expect(read.anchors.map((a) => a.fingerprint.split("/")[0])).toEqual(UNIFIED_IDS);
    expect(read.refused).toEqual([{ index: UNIFIED_IDS.length, detectorId: null, fingerprint: null, ref: null, reason: "unknown-detector" }]);
    for (const id of UNIFIED_IDS) expect(RSI_DETECTORS as readonly string[]).toContain(id);
  });
});
