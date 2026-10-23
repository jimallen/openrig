import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, closeSync, constants, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemon } from "../src/startup.js";
import { HealthProjectionService, type HealthObservationSource } from "../src/domain/health-detectors.js";
import type { HealthRecord } from "../src/domain/health-projection.js";
import { DEFAULT_HEALTH_POLICY } from "../src/domain/health-policy.js";
import { RSI_DETECTORS } from "../src/domain/rsi/detector-ids.js";
import { SlowOpFileSource } from "../src/domain/rsi/slow-op-file-source.js";
import { SlowOpRecorder } from "../src/domain/slow-op-recorder.js";

// Restated here, not imported: a changed constant must fail the pin, not move it.
const DETECTOR = "rsi.slow-op-subthreshold-flood";
const THRESHOLD_MS = 250;
const ORDER = "oldest rotated file first, newest four files";
// Fixture clock: far from wall clock (2030). Minute offsets are from T0; NOW is minute 600.
const T0 = Date.UTC(2030, 0, 1, 0, 0, 0);
const NOW = new Date(T0 + 600 * 60_000);
const FRESH = 595; // five minutes before NOW: inside the 10-minute freshness bound
const dirs: string[] = [];
const restore: (() => void)[] = [];
afterEach(() => {
  while (restore.length) restore.pop()!();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function span(site: string, durationMs: number, minute = FRESH): string {
  const ts = new Date(T0 + minute * 60_000).toISOString();
  return JSON.stringify({ v: 1, ts, spanId: `id-${site}-${minute}-${durationMs}`, phase: "end", site, durationMs, outcome: "ok" });
}
const many = (site: string, durationMs: number, n: number, minute = FRESH) =>
  Array.from({ length: n }, () => span(site, durationMs, minute));

function fixture(now: Date = NOW) {
  const dir = mkdtempSync(join(tmpdir(), "rsi-slowop-"));
  dirs.push(dir);
  mkdirSync(join(dir, "logs"));
  const logPath = join(dir, "logs", "slow-operations.jsonl");
  const write = (suffix: "" | `.${number}`, lines: string[]) => writeFileSync(logPath + suffix, lines.join("\n") + "\n");
  const source = (extra: { maxFileBytes?: number; maxSpans?: number; lastAliveAt?: () => number | null } = {}) => new SlowOpFileSource({ logPath, instanceId: "inst-1", now: () => now, ...extra });
  const records = (src: HealthObservationSource = source()): HealthRecord[] => new HealthProjectionService([src]).records();
  return { dir, logPath, write, source, records };
}

/** A well-formed record that is not an end span: the recorder's own diagnostics (event_loop_gap). */
function diagnostic(minute: number): string {
  return JSON.stringify({ v: 1, ts: new Date(T0 + minute * 60_000).toISOString(), event: "event_loop_gap", gapMs: 120000 });
}
/** An end span stamped `ageSeconds` before NOW, for the freshness edge. */
function spanAgo(site: string, ageSeconds: number): string {
  const ts = new Date(NOW.getTime() - ageSeconds * 1000).toISOString();
  return JSON.stringify({ v: 1, ts, spanId: `ago-${site}-${ageSeconds}`, phase: "end", site, durationMs: 5, outcome: "ok" });
}

function evidence(record: HealthRecord) {
  const item = record.evidence.find((e) => e.type === "telemetry-span");
  if (!item || item.type !== "telemetry-span") throw new Error("record carries no telemetry-span evidence");
  return item;
}
const fingerprints = (records: HealthRecord[]) => records.map((r) => evidence(r).fingerprint);
const fp = (site: string) => `rsi.slow-op-subthreshold-flood/site:${site}`;

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

    expect(fingerprints(records)).toEqual([fp("codex.runtime.list_processes")]);
    // 1000 flood + 5 slow + 1500 busy + 999 quiet = 3504 records; 1505 are at or over the threshold.
    expect(evidence(records[0]!)).toMatchObject({
      detectorId: DETECTOR, class: "subthreshold-span-flood", count: 1000, controlTotal: 1505, population: 3504,
    });
    expect(records[0]!.scope).toEqual({ type: "instance", instanceId: "inst-1" });
  });

  it("treats a span of exactly the threshold as slow, not as sub-threshold", () => {
    const f = fixture();
    f.write("", [...many("edge.site", THRESHOLD_MS, 1000), ...many("edge.below", THRESHOLD_MS - 0.001, 1000)]);

    expect(fingerprints(f.records())).toEqual([fp("edge.below")]);
  });

  it("counts across the rotated files and ignores diagnostics and begin records without calling the read partial", () => {
    const f = fixture();
    f.write(".2", many("a.site", 5, 400));
    f.write(".1", [...many("a.site", 5, 400), JSON.stringify({ v: 1, ts: new Date(T0 + FRESH * 60_000).toISOString(), event: "event_loop_gap", gapMs: 120000 })]);
    f.write("", [...many("a.site", 5, 200), JSON.stringify({ v: 1, ts: new Date(T0 + FRESH * 60_000).toISOString(), phase: "begin", site: "a.site", spanId: "s" })]);

    const source = f.source();
    const [record] = f.records(source);

    expect(evidence(record!)).toMatchObject({ count: 1000, population: 1000, firstSeq: 1, lastSeq: 1000 });
    expect(source.coverage()).toEqual([{
      source: "rsi-slow-op-file", evaluatedAt: NOW.toISOString(), unit: "files", limit: 4, total: 3,
      evaluated: 3, omitted: 0, partial: false, order: ORDER,
    }]);
  });

  it("numbers spans oldest first across the files, so firstSeq and lastSeq are positions in this read", () => {
    const f = fixture();
    f.write(".1", [...many("other.site", 5, 3), ...many("flood.site", 5, 1000)]);
    f.write("", many("flood.site", 5, 5));

    const [record] = f.records();

    // .1 is older: other.site is 1-3, flood.site 4-1003 there, then 1004-1008 in the live file.
    expect(evidence(record!)).toMatchObject({ firstSeq: 4, lastSeq: 1008, population: 1008 });
  });
});

describe("D13 the flood must be current, not merely in the window", () => {
  it("goes quiet when the last flooding span is more than an hour older than the newest record", () => {
    const f = fixture();
    // The flood ended at minute 100; the log's newest record is a different site at minute 595.
    f.write("", [...many("old.flood", 5, 1000, 100), span("live.site", 900, FRESH)]);

    expect(f.records()).toEqual([]);
  });

  it("needs both the 1000 floor and 360 spans in the last hour, and 359 recent spans are not enough", () => {
    const f = fixture();
    f.write("", [
      // Rate without the floor: 400 recent, 400 in total.
      ...many("fast.short", 5, 400),
      // Floor and rate: 700 old + 360 recent.
      ...many("floor.and.rate", 5, 700, 100), ...many("floor.and.rate", 5, 360),
      // Floor, one short of the rate: 700 old + 359 recent.
      ...many("floor.no.rate", 5, 700, 100), ...many("floor.no.rate", 5, 359),
    ]);

    expect(fingerprints(f.records())).toEqual([fp("floor.and.rate")]);
  });

  it("counts a span exactly one hour before the newest record as old and one a minute later as recent", () => {
    const f = fixture();
    f.write("", [
      ...many("edge.old", 5, 700, 100), ...many("edge.old", 5, 360, FRESH - 60),
      ...many("edge.new", 5, 700, 100), ...many("edge.new", 5, 360, FRESH - 59),
      span("anchor.site", 900, FRESH),
    ]);

    expect(fingerprints(f.records())).toEqual([fp("edge.new")]);
  });

  it("measures the last hour against the newest record and not against read time, and serves a frozen log as stale", () => {
    // The whole log ended at minute 100; it is read at minute 600.
    const f = fixture();
    f.write("", many("frozen.flood", 5, 1000, 100));

    const [record] = f.records();

    expect(record).toBeDefined();
    expect(evidence(record!).fingerprint).toBe(fp("frozen.flood"));
    // The recorder died: the frozen flood must not be served as current.
    expect(record!.status).toBe("indeterminate");
    expect(record!.indeterminateReason).toMatch(/stale/);
    const fresh = fixture();
    fresh.write("", many("live.flood", 5, 1000));
    expect(fresh.records()[0]).toMatchObject({ status: "active", indeterminateReason: null });
  });
});

describe("D13 the recent hour is anchored at the recorder's liveness (OF-73 R1)", () => {
  const ALIVE_NOW = () => NOW.getTime();

  it("reads an idle instance quiet after the fix when the recorder is alive: the flood is hours old and the restart diagnostic is the newest record", () => {
    const f = fixture();
    // The flood ended at minute 120 (fix deployed), the restart logged one diagnostic at minute 125,
    // and the instance has logged nothing since. It is read at minute 600.
    f.write("", [...many("old.flood", 5, 1000, 100), ...many("old.flood", 5, 360, 120), diagnostic(125)]);

    const quiet = new HealthProjectionService([f.source({ lastAliveAt: ALIVE_NOW })]);

    expect(quiet.records()).toEqual([]);
    expect(quiet.coverage()).toMatchObject([{ source: "rsi-slow-op-file", partial: false, evaluated: 1, omitted: 0 }]);
    expect(quiet.coverage()[0]).not.toHaveProperty("status", "unavailable");
  });

  it("keeps a dead recorder's frozen flood indeterminate: no liveness is not quiet", () => {
    const f = fixture();
    f.write("", [...many("frozen.flood", 5, 1000, 100), ...many("frozen.flood", 5, 360, 120), diagnostic(125)]);

    const [record] = f.records(f.source({ lastAliveAt: () => null }));

    expect(evidence(record!).fingerprint).toBe(fp("frozen.flood"));
    expect(record!.status).toBe("indeterminate");
    expect(record!.indeterminateReason).toMatch(/stale/);
  });

  it("does not let an alive recorder mask a flood that is still running: it stays active and fresh", () => {
    const f = fixture();
    f.write("", many("live.flood", 5, 1000));

    const [record] = f.records(f.source({ lastAliveAt: ALIVE_NOW }));

    expect(evidence(record!).fingerprint).toBe(fp("live.flood"));
    expect(record).toMatchObject({ status: "active", indeterminateReason: null });
  });

  it("serves a flood from the last hour as active and fresh when the recorder is alive, though the newest record is 40 minutes old", () => {
    const f = fixture();
    f.write("", many("recent.flood", 5, 1000, 560));

    const [record] = f.records(f.source({ lastAliveAt: ALIVE_NOW }));

    expect(evidence(record!).fingerprint).toBe(fp("recent.flood"));
    expect(record).toMatchObject({ status: "active", indeterminateReason: null });
    // The same log with a dead recorder is stale: freshness follows the liveness, not the record alone.
    const [dead] = f.records(f.source({ lastAliveAt: () => null }));
    expect(dead).toMatchObject({ status: "indeterminate" });
  });

  it("takes the later of the newest record and the liveness: liveness older than the newest record cannot pull the hour back", () => {
    const f = fixture();
    // The flood ended at minute 100; a slow span at minute 400 is the newest record. Liveness reports minute 50.
    f.write("", [...many("old.flood", 5, 1000, 100), span("slow.site", 900, 400)]);

    const records = f.records(f.source({ lastAliveAt: () => T0 + 50 * 60_000 }));

    expect(records).toEqual([]);
  });

  it("clamps liveness stamped after read time to it, so a clock step cannot make the source contradictory", () => {
    const f = fixture();
    f.write("", many("live.flood", 5, 1000));

    const [record] = f.records(f.source({ lastAliveAt: () => NOW.getTime() + 10 * 60_000 }));

    expect(record).toMatchObject({ status: "active", indeterminateReason: null });
  });

  it("ignores a liveness that is not a finite time, as it does a recorder with none", () => {
    const f = fixture();
    f.write("", many("frozen.flood", 5, 1000, 100));

    const [record] = f.records(f.source({ lastAliveAt: () => Number.NaN }));

    expect(record).toMatchObject({ status: "indeterminate" });
  });
});

describe("D13 a stuck recorder is not alive (OF-73 F1)", () => {
  it("reads a flood the stuck Worker never recorded as indeterminate and stale two hours on, not quiet on complete coverage", async () => {
    // The Worker records the flood until minute 100, then wedges (a FIFO log path): the recorder keeps
    // accepting writes and never acknowledges one. The flood goes on unrecorded. Read at minute 220.
    const f = fixture(new Date(T0 + 220 * 60_000));
    f.write("", many("wedge.flood", 5, 1000, 100));
    vi.useFakeTimers({ toFake: ["Date"] });
    restore.push(() => vi.useRealTimers());
    vi.setSystemTime(T0 + 100 * 60_000);
    const recorder = new SlowOpRecorder({ logPath: f.logPath });
    restore.push(() => { void (recorder as any).worker.terminate(); });
    (recorder as any).worker.postMessage = () => {};
    recorder.recordMeasurement("wedge.flood", 5);
    vi.setSystemTime(T0 + 220 * 60_000);

    const service = new HealthProjectionService([f.source({ lastAliveAt: () => recorder.lastAliveAt() })]);
    const [record] = service.records();

    expect(record).toBeDefined();
    expect(evidence(record!).fingerprint).toBe(fp("wedge.flood"));
    expect(record!.status).toBe("indeterminate");
    expect(record!.indeterminateReason).toMatch(/stale/);
  });
});

describe("D13 diagnostics advance the newest-record anchor (OF-73 N3)", () => {
  it("anchors the hour at a diagnostic: a flood older than an hour before the newest diagnostic is quiet", () => {
    const f = fixture();
    f.write("", [...many("old.flood", 5, 1000, 100), diagnostic(FRESH)]);

    expect(f.records()).toEqual([]);
  });

  it("takes freshness from a diagnostic: a flood last seen 40 minutes ago is fresh when a diagnostic is five minutes old", () => {
    const f = fixture();
    f.write("", [...many("recent.flood", 5, 1000, 560), diagnostic(598)]);

    const [record] = f.records();

    expect(evidence(record!).fingerprint).toBe(fp("recent.flood"));
    expect(record).toMatchObject({ status: "active", indeterminateReason: null });
  });
});

describe("D13 the 600 second freshness edge (OF-73 N4)", () => {
  it.each([
    [599, "active"],
    [600, "active"],
    [601, "indeterminate"],
  ])("serves a flood whose newest record is %i s old as %s", (ageSeconds, status) => {
    const f = fixture();
    f.write("", Array.from({ length: 1000 }, () => spanAgo("edge.flood", ageSeconds)));

    const [record] = f.records();

    expect(record).toMatchObject({ status });
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
    const recent = many("new.site", 5, 1000);
    // 1200 old records: dropping only the one cut line must leave old.site above the flood size.
    f.write("", [...many("old.site", 5, 1200), ...recent]);
    const recentBytes = Buffer.byteLength(recent.join("\n") + "\n");

    const source = f.source({ maxFileBytes: recentBytes + 20 });
    const records = f.records(source);

    expect(fingerprints(records)).toEqual([fp("new.site")]);
    expect(evidence(records[0]!)).toMatchObject({ count: 1000, population: 1000 });
    expect(source.coverage()[0]).toMatchObject({ total: 1, evaluated: 0, omitted: 1, partial: true });
  });

  it("keeps the first record when the byte cap falls exactly on a line boundary, and still reports partial", () => {
    const f = fixture();
    const recent = many("new.site", 5, 1000);
    f.write("", [...many("old.site", 5, 1200), ...recent]);

    const source = f.source({ maxFileBytes: Buffer.byteLength(recent.join("\n") + "\n") });
    const records = f.records(source);

    expect(fingerprints(records)).toEqual([fp("new.site")]);
    expect(evidence(records[0]!)).toMatchObject({ count: 1000, population: 1000 });
    expect(source.coverage()[0]).toMatchObject({ total: 1, evaluated: 0, omitted: 1, partial: true });
  });

  it("keeps the newest spans when the span cap is reached, and reports partial with the cap named", () => {
    const f = fixture();
    // Both sites flood now. The cap keeps the newest 1000 lines: all of site.new, none of site.old.
    f.write("", [...many("site.old", 5, 1000), ...many("site.new", 5, 1000)]);

    const source = f.source({ maxSpans: 1000 });
    const records = f.records(source);

    expect(fingerprints(records)).toEqual([fp("site.new")]);
    expect(source.coverage()[0]).toMatchObject({ evaluated: 0, omitted: 1, partial: true });
    expect(source.coverage()[0]).toMatchObject({ order: expect.stringContaining("span cap 1000 reached") });
  });

  it("does not count as clamped a future-stamped span that the cap stops it reading (OF-73 clamp count at the cap)", () => {
    const f = fixture();
    // The oldest line is stamped after read time. Reading newest first, the cap is full before it is reached.
    f.write("", [span("site.old", 5, 605), ...many("site.new", 5, 1000)]);

    const source = f.source({ maxSpans: 1000 });
    f.records(source);

    const order = source.coverage()[0]!.order;
    expect(order).toContain("span cap 1000 reached");
    expect(order).not.toContain("clamped");
    expect(source.coverage()[0]).toMatchObject({ partial: true });
  });

  it("does work linear in the spans: 42,000 spans at one site cost well under a second of CPU", () => {
    const f = fixture();
    const line = (i: number) => `{"ts":"${new Date(T0 + FRESH * 60_000 + i).toISOString()}","phase":"end","site":"s","durationMs":1}`;
    for (const [suffix, from] of [["", 0], [".1", 14000], [".2", 28000]] as const) {
      f.write(suffix, Array.from({ length: 14000 }, (_, i) => line(from + i)));
    }

    const source = f.source();
    const before = process.cpuUsage();
    const found = source.read();
    const used = process.cpuUsage(before);

    expect(found).toHaveLength(1);
    expect(source.coverage()[0]).toMatchObject({ total: 3, evaluated: 3, partial: false });
    // Linear: tens of milliseconds. The quadratic grouping that read 24,000 spans in 1.7 s needs
    // several seconds here. CPU time, not wall time, so a loaded host does not move it.
    expect((used.user + used.system) / 1000).toBeLessThan(600);
  });

  it("reports an unparseable line and an unreadable file as partial, and keeps the readable data", () => {
    const f = fixture();
    f.write("", [...many("flood.site", 5, 1000), "{\"v\":1,\"ts\":\"2030-01-01T00:00:00.000Z\",\"phase\":\"end\",\"si"]);
    mkdirSync(f.logPath + ".1"); // a directory where a rotated file should be: reading it fails

    const source = f.source();
    const records = f.records(source);

    expect(fingerprints(records)).toEqual([fp("flood.site")]);
    expect(source.coverage()[0]).toMatchObject({ total: 2, evaluated: 0, omitted: 2, partial: true });
  });

  it("never opens a FIFO: it is reported unreadable and the read returns", () => {
    const f = fixture();
    f.write("", many("flood.site", 5, 1000));
    execFileSync("mkfifo", [f.logPath + ".1"]);
    // A writer held open lets an unguarded open() succeed instead of blocking the whole process.
    const writer = openSync(f.logPath + ".1", constants.O_RDWR);
    restore.push(() => closeSync(writer));

    const source = f.source();
    const records = f.records(source);

    expect(fingerprints(records)).toEqual([fp("flood.site")]);
    expect(source.coverage()[0]).toMatchObject({ total: 2, evaluated: 1, omitted: 1, partial: true });
  });

  it("clamps a span stamped after read time and reports partial, instead of making the source unavailable", () => {
    const f = fixture();
    // One span 5 minutes in the future (a clock step back is enough to produce one).
    f.write("", [...many("flood.site", 5, 1000), span("flood.site", 5, 605)]);

    const source = f.source();
    const projection = new HealthProjectionService([source]);
    const records = projection.records();

    expect(fingerprints(records)).toEqual([fp("flood.site")]);
    expect(evidence(records[0]!)).toMatchObject({ count: 1001, lastSeen: NOW.toISOString() });
    expect(projection.coverage()).toHaveLength(1);
    expect(projection.coverage()[0]).toMatchObject({
      partial: true, order: `${ORDER}; 1 record(s) stamped after read time were clamped to it`,
    });
    expect(projection.coverage()[0]).not.toHaveProperty("status", "unavailable");
  });
});

describe("D13 no log yet is an honest zero, an unreadable log is unavailable", () => {
  it("serves zero findings with a no-log note when the log directory or file is missing", () => {
    const f = fixture();
    const noFile = new HealthProjectionService([f.source()]);
    expect(noFile.records()).toEqual([]);
    expect(noFile.coverage()).toEqual([{
      source: "rsi-slow-op-file", evaluatedAt: NOW.toISOString(), unit: "files", limit: 4, total: 0,
      evaluated: 0, omitted: 0, partial: false, order: "no slow-op log yet",
    }]);

    rmSync(join(f.dir, "logs"), { recursive: true });
    const noDir = new HealthProjectionService([f.source()]);
    expect(noDir.records()).toEqual([]);
    expect(noDir.coverage()).toMatchObject([{ order: "no slow-op log yet", partial: false, total: 0 }]);
  });

  it("serves unavailable coverage and no finding when the only candidate cannot be read", () => {
    const f = fixture();
    mkdirSync(f.logPath); // the only candidate is a directory
    const unreadable = new HealthProjectionService([f.source()]);
    expect(unreadable.records()).toEqual([]);
    expect(unreadable.coverage()).toMatchObject([{ source: "rsi-slow-op-file", status: "unavailable", partial: true }]);
  });

  it.skipIf(process.getuid?.() === 0)("serves unavailable coverage when the log directory is not readable, and not the no-log zero", () => {
    const f = fixture();
    f.write("", many("flood.site", 5, 1000));
    const logs = join(f.dir, "logs");
    chmodSync(logs, 0o000);
    restore.push(() => chmodSync(logs, 0o700));

    const service = new HealthProjectionService([f.source()]);

    expect(service.records()).toEqual([]);
    expect(service.coverage()).toMatchObject([{ source: "rsi-slow-op-file", status: "unavailable", partial: true }]);
  });
});

describe("D13 a logs path that is not a directory (OF-73 N5)", () => {
  it("serves unavailable coverage and not the no-log zero when logs is a regular file, as the recorder cannot write there", () => {
    const f = fixture();
    rmSync(join(f.dir, "logs"), { recursive: true });
    writeFileSync(join(f.dir, "logs"), "not a directory");

    const service = new HealthProjectionService([f.source()]);

    expect(service.records()).toEqual([]);
    expect(service.coverage()).toMatchObject([{ source: "rsi-slow-op-file", status: "unavailable", partial: true }]);
    expect(JSON.stringify(service.coverage())).not.toContain("no slow-op log yet");
  });
});

describe("D13 as a health record", () => {
  it("is category process and severity info, so it stays out of the Attention view", () => {
    const f = fixture();
    f.write("", many("codex.runtime.list_processes", 5, 1000));
    expect(f.records()[0]).toMatchObject({ detector: DETECTOR, category: "process", severity: "info", status: "active" });
  });

  it("names the liveness anchor in the explanation, not only in the threshold (OF-73 N1)", () => {
    const f = fixture();
    f.write("", many("flood.site", 5, 1000));

    const [record] = f.records();

    expect(record!.explanation).toContain("in the hour ending at the newest log record or the recorder's last-alive time");
    expect(record!.explanation).not.toContain("last hour of the log");
  });

  it("names the inspection without claiming which recorder path leaks", () => {
    const f = fixture();
    f.write("", many("codex.runtime.list_processes", 5, 1000));
    const [record] = f.records();
    expect(record!.suggestedInspection).toContain("codex.runtime.list_processes");
    expect(record!.suggestedInspection).not.toMatch(/recordMeasurement|recordRequest/);
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
  async function wiredDaemon(lastAliveAt: (() => number | null) | undefined) {
    const dir = mkdtempSync(join(tmpdir(), "rsi-slowop-alive-"));
    dirs.push(dir);
    mkdirSync(join(dir, "logs"));
    const logPath = join(dir, "logs", "slow-operations.jsonl");
    // A flood that ended three hours ago, read on the daemon's own wall clock.
    const then = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    const lines = Array.from({ length: 1000 }, (_, i) => JSON.stringify({ v: 1, ts: then, spanId: `a${i}`, phase: "end", site: "wiring.flood", durationMs: 5, outcome: "ok" }));
    writeFileSync(logPath, lines.join("\n") + "\n");
    const recorder = { snapshot: () => ({ healthy: true }), ...(lastAliveAt ? { lastAliveAt } : {}) };
    const daemon = await createDaemon({ dbPath: join(dir, "openrig.sqlite"), slowOpLogPath: logPath, slowOpRecorder: recorder } as never);
    const records = daemon.deps.healthProjection!.list().records.filter((record) => record.detector === DETECTOR);
    daemon.db.close();
    return records;
  }

  it("hands the daemon's slow-op recorder liveness to D13: an alive recorder reads the three-hour-old flood quiet, a recorder without liveness leaves it indeterminate", async () => {
    expect(await wiredDaemon(() => Date.now())).toEqual([]);
    const dead = await wiredDaemon(() => null);
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({ status: "indeterminate" });
    expect(await wiredDaemon(undefined)).toHaveLength(1);
  });

  it("reads the configured slow-op log on a file-backed daemon, and registers nothing on an in-memory one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rsi-slowop-wiring-"));
    dirs.push(dir);
    mkdirSync(join(dir, "logs"));
    const logPath = join(dir, "logs", "slow-operations.jsonl");
    // A flood written now, so the daemon's own clock sees a current log.
    const now = new Date().toISOString();
    const lines = Array.from({ length: 1000 }, (_, i) => JSON.stringify({ v: 1, ts: now, spanId: `w${i}`, phase: "end", site: "wiring.flood", durationMs: 5, outcome: "ok" }));
    writeFileSync(logPath, lines.join("\n") + "\n");
    const fileDaemon = await createDaemon({ dbPath: join(dir, "openrig.sqlite"), slowOpLogPath: logPath });
    const memoryDaemon = await createDaemon({ dbPath: ":memory:" });
    try {
      const listed = fileDaemon.deps.healthProjection!.list();
      const detectors = listed.records.map((record) => record.detector);
      expect(detectors).toContain(DETECTOR);
      expect(listed.coverage?.find((c) => c.source === "rsi-slow-op-file")).not.toHaveProperty("status", "unavailable");
      expect((memoryDaemon.deps.healthProjection!.list().coverage ?? []).map((c) => c.source)).not.toContain("rsi-slow-op-file");
    } finally {
      fileDaemon.db.close();
      memoryDaemon.db.close();
    }
  });
});
