import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HealthProjectionService } from "../src/domain/health-detectors.js";
import { DEFAULT_HEALTH_POLICY, validateHealthPolicy } from "../src/domain/health-policy.js";
import { createA2bSources } from "../src/domain/rsi/a2b-sources.js";
import { RSI_A2B_DETECTORS, RSI_DETECTORS } from "../src/domain/rsi/detector-ids.js";
import { assertPartitionSumsToTotal, partitionText } from "../src/domain/rsi/finding-builder.js";
import { RETENTION_DEFAULTS, RETENTION_SWEEP_INTERVAL_MS } from "../src/domain/queue-retention.js";
import { createDaemon } from "../src/startup.js";
import { NOW, cleanupFixtures, fixture } from "./rsi-a2b-fixture.js";

afterEach(cleanupFixtures);

const EXPECTED = [
  ["rsi-compaction-storm", "rsi.compaction-storm"],
  ["rsi-context-high-water", "rsi.context-high-water"],
  ["rsi-provider-weekly-window", "rsi.provider-weekly-window"],
  ["rsi-outbox-unsettled", "rsi.outbox-unsettled"],
  ["rsi-permission-stall", "rsi.permission-stall"],
  ["rsi-watchdog-delivery-failure", "rsi.watchdog-delivery-failure"],
  ["rsi-project-report", "rsi.project-report"],
  ["rsi-retention-lag", "rsi.retention-lag"],
] as const;

describe("the A2b registry", () => {
  it("builds one source per detector, D10 only when the retention sweep is armed", () => {
    const f = fixture();
    const armed = createA2bSources({ dbPath: f.dbPath, instanceId: "i", retentionEnabled: true });
    const unarmed = createA2bSources({ dbPath: f.dbPath, instanceId: "i", retentionEnabled: false });

    expect(armed.map((s) => [s.name, ...(s.detectors ?? [])])).toEqual(EXPECTED.map(([name, id]) => [name, id]));
    expect(unarmed.map((s) => s.name)).toEqual(EXPECTED.filter(([name]) => name !== "rsi-retention-lag").map(([name]) => name));
  });

  it("registers exactly the ids RSI_A2B_DETECTORS lists, each once", () => {
    const f = fixture();
    const ids = createA2bSources({ dbPath: f.dbPath, instanceId: "i", retentionEnabled: true }).flatMap((s) => [...(s.detectors ?? [])]);

    expect([...ids].sort()).toEqual([...RSI_A2B_DETECTORS].sort());
    expect(new Set(ids).size).toBe(ids.length);
    expect(RSI_A2B_DETECTORS).toHaveLength(8);
    for (const id of RSI_A2B_DETECTORS) expect(RSI_DETECTORS as readonly string[]).toContain(id);
  });

  it("lets a policy disable each id, and disabling one detector skips only its own read", () => {
    const f = fixture();
    // The ids are restated here, not read from the list under test: a dropped id must fail.
    for (const [, id] of EXPECTED) {
      expect(validateHealthPolicy({ ...DEFAULT_HEALTH_POLICY, disabledDetectors: [id] }).disabledDetectors).toEqual([id]);
    }
    const sources = createA2bSources({ dbPath: f.dbPath, instanceId: "i", retentionEnabled: true, now: () => NOW });
    const policy = (disabled: string[]) => () => ({ version: "t", policy: { ...DEFAULT_HEALTH_POLICY, disabledDetectors: disabled }, contextPressure: { warningPercent: 95, criticalPercent: 99 } });

    const all = new HealthProjectionService(sources, policy([]));
    all.records();
    expect(all.coverage().map((c) => c.source).sort()).toEqual(EXPECTED.map(([name]) => name).sort());

    const some = new HealthProjectionService(sources, policy(["rsi.outbox-unsettled"]));
    some.records();
    expect(some.coverage().map((c) => c.source).sort()).toEqual(EXPECTED.map(([name]) => name).filter((n) => n !== "rsi-outbox-unsettled").sort());
  });

  it("derives D10's sweep interval from the retention scheduler's own constant", () => {
    expect(RETENTION_SWEEP_INTERVAL_MS).toBe(86_400_000);
    expect(RETENTION_DEFAULTS.usageSamplesRetentionDays).toBe(14);
  });
});

describe("sum-to-total control", () => {
  it("passes a partition that adds up and names the parts when it does not", () => {
    expect(() => assertPartitionSumsToTotal("x", [["a", 2], ["b", 3]], 5)).not.toThrow();
    expect(() => assertPartitionSumsToTotal("x", [["a", 2], ["b", 3]], 6)).toThrow("x: parts a=2, b=3 sum to 5, not the counted total 6");
    expect(() => assertPartitionSumsToTotal("x", [["a", 2], ["b", 3]], 4)).toThrow(/sum to 5, not the counted total 4/);
    expect(() => assertPartitionSumsToTotal("x", [], 0)).not.toThrow();
  });

  it("renders the parts and their total", () => {
    expect(partitionText([["a", 2], ["b", 3]], 5)).toBe("a 2, b 3 = 5");
  });
});

describe("daemon wiring", () => {
  it("registers all A2b sources on a file-backed daemon and none on an in-memory one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rsi-a2b-wiring-"));
    const fileDaemon = await createDaemon({ dbPath: join(dir, "openrig.sqlite") });
    const memoryDaemon = await createDaemon({ dbPath: ":memory:" });
    try {
      const sources = (daemon: typeof fileDaemon) => (daemon.deps.healthProjection!.list().coverage ?? []).map((c) => c.source);
      for (const name of ["rsi-compaction-storm", "rsi-context-high-water", "rsi-provider-weekly-window", "rsi-outbox-unsettled",
        "rsi-permission-stall", "rsi-watchdog-delivery-failure", "rsi-project-report"]) {
        expect(sources(fileDaemon)).toContain(name);
        expect(sources(memoryDaemon)).not.toContain(name);
      }
    } finally {
      fileDaemon.db.close();
      memoryDaemon.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
