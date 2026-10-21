import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemon } from "../src/startup.js";
import { HealthProjectionService, type HealthObservationSource } from "../src/domain/health-detectors.js";
import type { HealthRecord } from "../src/domain/health-projection.js";
import { DEFAULT_HEALTH_POLICY } from "../src/domain/health-policy.js";
import { RSI_DETECTORS } from "../src/domain/rsi/detector-ids.js";
import { SlowOpFileSource } from "../src/domain/rsi/slow-op-file-source.js";

// Restated here, not imported: a changed constant must fail the pin, not move it.
const DETECTOR = "rsi.slow-op-subthreshold-flood";
const THRESHOLD_MS = 250;
const NOW = new Date("2031-03-04T05:06:07.000Z");
const ORDER = "oldest rotated file first, newest four files";
const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function span(site: string, durationMs: number, minute = 0): string {
  const ts = new Date(Date.UTC(2030, 0, 1, 0, minute, 0)).toISOString();
  return JSON.stringify({ v: 1, ts, spanId: `id-${site}-${minute}-${durationMs}`, phase: "end", site, durationMs, outcome: "ok" });
}
const many = (site: string, durationMs: number, n: number, minute = 0) =>
  Array.from({ length: n }, () => span(site, durationMs, minute));

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "rsi-slowop-"));
  dirs.push(dir);
  mkdirSync(join(dir, "logs"));
  const logPath = join(dir, "logs", "slow-operations.jsonl");
  const write = (suffix: "" | `.${number}`, lines: string[]) => writeFileSync(logPath + suffix, lines.join("\n") + "\n");
  const source = (extra: { maxFileBytes?: number } = {}) => new SlowOpFileSource({ logPath, instanceId: "inst-1", now: () => NOW, ...extra });
  const records = (src: HealthObservationSource = source()): HealthRecord[] => new HealthProjectionService([src]).records();
  return { dir, logPath, write, source, records };
}

function evidence(record: HealthRecord) {
  const item = record.evidence.find((e) => e.type === "telemetry-span");
  if (!item || item.type !== "telemetry-span") throw new Error("record carries no telemetry-span evidence");
  return item;
}
const fingerprints = (records: HealthRecord[]) => records.map((r) => evidence(r).fingerprint);

describe("D13 sub-threshold span flood", () => {
  it("reports only the site whose sub-threshold spans reach 1000, never a site that is slow by the threshold or one span short", () => {
    const f = fixture();
    f.write("", [
      ...many("codex.runtime.list_processes", 98, 1000),
      ...many("codex.runtime.list_processes", 900, 5),
      // 1,500 records at a site, every one over the threshold: busy, but the log is doing its job.
      ...many("request:GET /api/slow", 400, 1500),
      // One short of the flood size.
      ...many("quiet.site", 10, 999),
    ]);

    const records = f.records();

    expect(fingerprints(records)).toEqual(["rsi.slow-op-subthreshold-flood/site:codex.runtime.list_processes"]);
    // 1000 flood + 5 slow + 1500 busy + 999 quiet = 3504 records; 1505 are at or over the threshold.
    expect(evidence(records[0]!)).toMatchObject({
      detectorId: DETECTOR, class: "subthreshold-span-flood", count: 1000, controlTotal: 1505, population: 3504,
    });
    expect(records[0]!.scope).toEqual({ type: "instance", instanceId: "inst-1" });
  });

  it("treats a span of exactly the threshold as slow, not as sub-threshold", () => {
    const f = fixture();
    f.write("", [...many("edge.site", THRESHOLD_MS, 1000), ...many("edge.below", THRESHOLD_MS - 0.001, 1000)]);

    expect(fingerprints(f.records())).toEqual(["rsi.slow-op-subthreshold-flood/site:edge.below"]);
  });

  it("counts across the rotated files and ignores diagnostics and start records without calling the read partial", () => {
    const f = fixture();
    f.write(".2", many("a.site", 5, 400));
    f.write(".1", [...many("a.site", 5, 400), JSON.stringify({ v: 1, ts: "2030-01-01T00:00:00.000Z", event: "event_loop_gap", gapMs: 120000 })]);
    f.write("", [...many("a.site", 5, 200), JSON.stringify({ v: 1, ts: "2030-01-01T00:00:00.000Z", phase: "start", site: "a.site", spanId: "s" })]);

    const source = f.source();
    const [record] = f.records(source);

    expect(evidence(record!)).toMatchObject({ count: 1000, population: 1000, firstSeq: 1, lastSeq: 1000 });
    expect(source.coverage()).toEqual([{
      source: "rsi-slow-op-file", evaluatedAt: NOW.toISOString(), unit: "files", limit: 4, total: 3,
      evaluated: 3, omitted: 0, partial: false, order: ORDER,
    }]);
  });
});

describe("D13 read bounds", () => {
  it("reads at most 4 files and names the rest as partial coverage rather than as clean", () => {
    const f = fixture();
    for (const suffix of ["", ".1", ".2", ".3"] as const) f.write(suffix, many("live.site", 5, 3));
    // Files 4 and 5 hold a flood. A reader that follows the directory instead of the cap sees it.
    f.write(".4", many("beyond.cap", 5, 1000));
    f.write(".5", many("beyond.cap", 5, 1000));

    const source = f.source();

    expect(f.records(source)).toEqual([]);
    expect(source.coverage()).toEqual([{
      source: "rsi-slow-op-file", evaluatedAt: NOW.toISOString(), unit: "files", limit: 4, total: 6,
      evaluated: 4, omitted: 2, partial: true, order: ORDER,
    }]);
  });

  it("reads only the newest bytes of an oversized file, ignores the record it cut through, and reports partial", () => {
    const f = fixture();
    const recent = many("new.site", 5, 1000, 2);
    // 1200 old records: dropping only the one cut line must leave old.site above the flood size.
    f.write("", [...many("old.site", 5, 1200, 1), ...recent]);
    const recentBytes = Buffer.byteLength(recent.join("\n") + "\n");

    const source = f.source({ maxFileBytes: recentBytes + 20 });
    const records = f.records(source);

    expect(fingerprints(records)).toEqual(["rsi.slow-op-subthreshold-flood/site:new.site"]);
    expect(evidence(records[0]!)).toMatchObject({ count: 1000, population: 1000 });
    expect(source.coverage()[0]).toMatchObject({ total: 1, evaluated: 0, omitted: 1, partial: true });
  });

  it("keeps the first record when the byte cap falls exactly on a line boundary, and still reports partial", () => {
    const f = fixture();
    const recent = many("new.site", 5, 1000, 2);
    f.write("", [...many("old.site", 5, 1200, 1), ...recent]);

    const source = f.source({ maxFileBytes: Buffer.byteLength(recent.join("\n") + "\n") });
    const records = f.records(source);

    expect(fingerprints(records)).toEqual(["rsi.slow-op-subthreshold-flood/site:new.site"]);
    expect(evidence(records[0]!)).toMatchObject({ count: 1000, population: 1000 });
    expect(source.coverage()[0]).toMatchObject({ total: 1, evaluated: 0, omitted: 1, partial: true });
  });

  it("reports an unparseable line and an unreadable file as partial, and keeps the readable data", () => {
    const f = fixture();
    f.write("", [...many("flood.site", 5, 1000), "{\"v\":1,\"ts\":\"2030-01-01T00:00:00.000Z\",\"phase\":\"end\",\"si"]);
    mkdirSync(f.logPath + ".1"); // a directory where a rotated file should be: reading it fails

    const source = f.source();
    const records = f.records(source);

    expect(fingerprints(records)).toEqual(["rsi.slow-op-subthreshold-flood/site:flood.site"]);
    expect(source.coverage()[0]).toMatchObject({ total: 2, evaluated: 0, omitted: 2, partial: true });
  });
});

describe("D13 unavailable, never zero", () => {
  it("serves unavailable coverage and no finding when there is no log, and when no file can be read", () => {
    const f = fixture();
    const missing = new HealthProjectionService([f.source()]);
    expect(missing.records()).toEqual([]);
    expect(missing.coverage()).toMatchObject([{ source: "rsi-slow-op-file", status: "unavailable", partial: true }]);

    mkdirSync(f.logPath); // the only candidate is a directory
    const unreadable = new HealthProjectionService([f.source()]);
    expect(unreadable.records()).toEqual([]);
    expect(unreadable.coverage()).toMatchObject([{ source: "rsi-slow-op-file", status: "unavailable", partial: true }]);
  });
});

describe("D13 as a health record", () => {
  it("is category process and severity info, so it stays out of the Attention view", () => {
    const f = fixture();
    f.write("", many("codex.runtime.list_processes", 5, 1000));
    expect(f.records()[0]).toMatchObject({ detector: DETECTOR, category: "process", severity: "info", status: "active" });
  });

  it("is a disableable RSI id, and a policy that disables it stops the file being read", () => {
    const f = fixture();
    f.write("", many("codex.runtime.list_processes", 5, 1000));
    expect(RSI_DETECTORS as readonly string[]).toContain(DETECTOR);
    const policy = (disabled: string[]) => () => ({ version: "t", policy: { ...DEFAULT_HEALTH_POLICY, disabledDetectors: disabled }, contextPressure: { warningPercent: 95, criticalPercent: 99 } });

    expect(new HealthProjectionService([f.source()], policy([])).records()).toHaveLength(1);
    const disabled = new HealthProjectionService([f.source()], policy([DETECTOR]));
    expect(disabled.records()).toEqual([]);
    expect(disabled.coverage()).toEqual([]);
  });
});

describe("daemon wiring", () => {
  it("registers the slow-op source on a file-backed daemon and not on an in-memory one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rsi-slowop-wiring-"));
    dirs.push(dir);
    const fileDaemon = await createDaemon({ dbPath: join(dir, "openrig.sqlite"), slowOpLogPath: join(dir, "logs", "slow-operations.jsonl") });
    const memoryDaemon = await createDaemon({ dbPath: ":memory:" });
    try {
      const sources = (daemon: typeof fileDaemon) => (daemon.deps.healthProjection!.list().coverage ?? []).map((c) => c.source);
      expect(sources(fileDaemon)).toContain("rsi-slow-op-file");
      expect(sources(memoryDaemon)).not.toContain("rsi-slow-op-file");
    } finally {
      fileDaemon.db.close();
      memoryDaemon.db.close();
    }
  });
});
