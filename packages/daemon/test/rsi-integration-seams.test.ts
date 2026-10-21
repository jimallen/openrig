import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { HealthProjectionService, type HealthObservationSource, type HealthSourceCoverage } from "../src/domain/health-detectors.js";
import { RSI_DETECTORS, RSI_STARTUP_FAILURE_CLASS } from "../src/domain/rsi/detector-ids.js";
import { sqliteUtcStamp } from "../src/domain/rsi/finding-builder.js";
import { readKnownFixes } from "../src/domain/rsi/known-fixes.js";
import { BudgetedRsiSource } from "../src/domain/rsi/read-budget.js";
import { createRsiSources } from "../src/domain/rsi/registry.js";

/**
 * The seams the RSI integration unified (A2a, A2b, A3 on one registry). B1's conformance test
 * (rsi-health-finding-wake.test.ts) pins the one array shared by the projection and the wake;
 * this file pins the registry's instance id, the budget around every source, and the anchors.
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
  return { dir, dbPath, db };
}

const tickingClock = () => { let t = 0; return () => t++; };

describe("the one registry: instance id", () => {
  it("scopes an instance finding to OPENRIG_HOME (the registry's openrigHome), never to a fixed 'local'", () => {
    const h = home();
    // The registry reads the wall clock: three D1 hits inside its 7-day window.
    for (const hoursAgo of [30, 20, 10]) {
      h.db.prepare("INSERT INTO events (type, payload, created_at) VALUES ('node.startup_failed', ?, ?)")
        .run(JSON.stringify({ type: "node.startup_failed", error: "pane returned to shell" }), sqliteUtcStamp(new Date(Date.now() - hoursAgo * 3_600_000)));
    }
    const records = new HealthProjectionService(createRsiSources({ dbPath: h.dbPath, openrigHome: h.dir })).records();

    const d1 = records.filter((r) => r.detector === RSI_STARTUP_FAILURE_CLASS);
    expect(d1).toHaveLength(1); // positive control: the finding exists
    expect(d1[0]!.scope).toEqual({ type: "instance", instanceId: h.dir });
    // Every instance-scoped RSI record carries the same home.
    const instanceScoped = records.filter((r) => r.scope.type === "instance");
    expect(instanceScoped.length).toBeGreaterThan(0);
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

  it("marks every source's read partial and over-budget when the budget is spent, and keeps the findings", () => {
    const h = home();
    const service = new HealthProjectionService(createRsiSources({ dbPath: h.dbPath, openrigHome: h.dir, budget: { budgetMs: 1, nowMs: tickingClock() } }));
    service.records();
    const coverage = service.coverage();

    expect(coverage.map((c) => c.source).sort()).toEqual(REGISTRY_SOURCES);
    for (const row of coverage) {
      expect(row, `${row.source} was not marked`).toMatchObject({ partial: true, note: expect.stringContaining("over-budget") });
    }
  });

  it("leaves a read inside its budget unmarked (the control)", () => {
    const h = home();
    const service = new HealthProjectionService(createRsiSources({ dbPath: h.dbPath, openrigHome: h.dir, budget: { budgetMs: 1e9 } }));
    service.records();
    const coverage = service.coverage();

    expect(coverage.map((c) => c.source).sort()).toEqual(REGISTRY_SOURCES);
    for (const row of coverage) expect(JSON.stringify(row)).not.toContain("over-budget");
    expect(coverage.filter((row) => row.partial === false).length).toBeGreaterThan(0);
  });
});

describe("BudgetedRsiSource", () => {
  const finding = { kind: "telemetry-finding" } as never;
  const fake = (coverage: HealthSourceCoverage[]): HealthObservationSource => ({
    name: "fake", detectors: ["rsi.fake"], read: () => [finding], coverage: () => coverage,
  });
  const available: HealthSourceCoverage = { source: "fake", evaluatedAt: "2031-01-01T00:00:00.000Z", unit: "rows", limit: 5, total: 2, evaluated: 2, omitted: 0, partial: false, order: "o", note: "anchors" };
  const unavailable: HealthSourceCoverage = { source: "fake", evaluatedAt: "2031-01-01T00:00:00.000Z", status: "unavailable", partial: true, reason: "r" };

  it("forwards name and detectors, so a disabled detector still skips the read", () => {
    const wrapped = new BudgetedRsiSource(fake([available]));
    expect([wrapped.name, wrapped.detectors]).toEqual(["fake", ["rsi.fake"]]);
  });

  it("over budget: keeps the findings, marks an available row partial and appends the note, leaves an unavailable row alone", () => {
    const wrapped = new BudgetedRsiSource(fake([available, unavailable]), { budgetMs: 5, nowMs: (() => { const t = [0, 7]; return () => t.shift()!; })() });

    expect(wrapped.read()).toEqual([finding]);
    expect(wrapped.coverage()).toEqual([
      { ...available, partial: true, note: "anchors; over-budget: the read took 7 ms of a 5 ms budget; a running statement cannot be interrupted, so it ran to completion" },
      unavailable,
    ]);
  });

  it("over budget with no coverage: reports one partial row rather than nothing", () => {
    const wrapped = new BudgetedRsiSource(fake([]), { budgetMs: 5, nowMs: (() => { const t = [0, 5]; return () => t.shift()!; })() });
    wrapped.read();
    expect(wrapped.coverage()).toEqual([expect.objectContaining({ source: "fake", partial: true, note: expect.stringContaining("over-budget") })]);
  });

  it("under budget: the inner coverage, unchanged", () => {
    const wrapped = new BudgetedRsiSource(fake([available]), { budgetMs: 5, nowMs: (() => { const t = [0, 4]; return () => t.shift()!; })() });
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
