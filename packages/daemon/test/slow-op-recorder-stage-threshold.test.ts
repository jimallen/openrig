import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SlowOpRecorder, SLOW_OPERATION_THRESHOLD_MS } from "../src/domain/slow-op-recorder.js";
import { SlowOpFileSource } from "../src/domain/rsi/slow-op-file-source.js";

// Production consequence these pins protect: runStage sites (codex.runtime.list_processes runs
// every few seconds per Codex seat) used to write EVERY call to the slow-operation log, so about
// 99% of the log was fast "ok" spans and the 4 x 1 MiB rotation held only ~10.7 h of history,
// evicting the real slow operations before anyone could read them. A stage now writes when it is
// slow (>= the recorder's slowThresholdMs, the same inclusive rule recordRequest uses) or when it
// did not succeed (thrown, or classified "failed").

const tempDirs: string[] = [];
function tempLog(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-slow-op-stage-"));
  tempDirs.push(dir);
  return path.join(dir, "slow-operations.jsonl");
}
function readRecords(logPath: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Run one stage whose measured duration is exactly `durationMs`. performance.now is a clock that
 * only the stage body advances, so the duration is exact, independent of wall clock, and the same
 * however many times the recorder reads it. The clock spy is removed before the caller flushes.
 */
async function stageOf<T>(
  recorder: SlowOpRecorder,
  site: string,
  durationMs: number,
  body: () => T | Promise<T>,
  classify?: (value: T) => "ok" | "failed",
): Promise<T> {
  let clock = 5_000_000;
  const spy = vi.spyOn(performance, "now").mockImplementation(() => clock);
  try {
    return await recorder.runStage(site, async () => { clock += durationMs; return body(); }, classify);
  } finally {
    spy.mockRestore();
  }
}

describe("SlowOpRecorder.runStage records only slow or unsuccessful stages", () => {
  it("writes nothing for a 10 ms ok stage and still returns its value", async () => {
    const logPath = tempLog();
    const recorder = new SlowOpRecorder({ logPath });
    expect(await stageOf(recorder, "test.stage.fast_ok", 10, () => "value")).toBe("value");
    await recorder.flush();
    expect(readRecords(logPath)).toEqual([]);
    await recorder.close();
  });

  it("writes exactly one end span for a 300 ms ok stage", async () => {
    const logPath = tempLog();
    const recorder = new SlowOpRecorder({ logPath });
    expect(await stageOf(recorder, "test.stage.slow_ok", 300, () => 7)).toBe(7);
    await recorder.flush();
    const records = readRecords(logPath);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ phase: "end", site: "test.stage.slow_ok", durationMs: 300, outcome: "ok" });
    await recorder.close();
  });

  it("writes exactly one failed span for a 10 ms stage that throws, and rethrows the same error", async () => {
    const logPath = tempLog();
    const recorder = new SlowOpRecorder({ logPath });
    const boom = new Error("boom");
    await expect(stageOf(recorder, "test.stage.fast_throw", 10, () => { throw boom; })).rejects.toBe(boom);
    await recorder.flush();
    const records = readRecords(logPath);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ phase: "end", site: "test.stage.fast_throw", durationMs: 10, outcome: "failed" });
    await recorder.close();
  });

  it("writes exactly one failed span for a 10 ms stage whose result classify() calls failed", async () => {
    const logPath = tempLog();
    const recorder = new SlowOpRecorder({ logPath });
    const result = { ok: false };
    expect(await stageOf(recorder, "test.stage.fast_classified", 10, () => result, (v) => (v.ok ? "ok" : "failed"))).toBe(result);
    await recorder.flush();
    const records = readRecords(logPath);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ phase: "end", site: "test.stage.fast_classified", durationMs: 10, outcome: "failed" });
    await recorder.close();
  });

  it("writes nothing for a 10 ms stage that classify() calls ok", async () => {
    const logPath = tempLog();
    const recorder = new SlowOpRecorder({ logPath });
    await stageOf(recorder, "test.stage.fast_classified_ok", 10, () => ({ ok: true }), (v) => (v.ok ? "ok" : "failed"));
    await recorder.flush();
    expect(readRecords(logPath)).toEqual([]);
    await recorder.close();
  });

  it("applies the threshold inclusively at the boundary: just under writes nothing, exactly at it writes one", async () => {
    expect(SLOW_OPERATION_THRESHOLD_MS).toBe(250);
    const logPath = tempLog();
    const recorder = new SlowOpRecorder({ logPath });
    await stageOf(recorder, "test.stage.under", 249.999, () => 1);
    await stageOf(recorder, "test.stage.at", 250, () => 1);
    await recorder.flush();
    const records = readRecords(logPath);
    expect(records.map((r) => r.site)).toEqual(["test.stage.at"]);
    expect(records[0]).toMatchObject({ durationMs: 250, outcome: "ok" });
    await recorder.close();
  });

  it("uses the recorder's own slowThresholdMs, not the module default", async () => {
    const logPath = tempLog();
    const recorder = new SlowOpRecorder({ logPath, slowThresholdMs: 1000 });
    await stageOf(recorder, "test.stage.custom_under", 500, () => 1);
    await stageOf(recorder, "test.stage.custom_at", 1000, () => 1);
    await recorder.flush();
    expect(readRecords(logPath).map((r) => r.site)).toEqual(["test.stage.custom_at"]);
    await recorder.close();
  });

  it("recordMeasurement stays unconditional: an explicit measurement is always written", async () => {
    const logPath = tempLog();
    const recorder = new SlowOpRecorder({ logPath });
    recorder.recordMeasurement("test.explicit.fast", 10);
    await recorder.flush();
    expect(readRecords(logPath)).toHaveLength(1);
    await recorder.close();
  });
});

describe("D13 (rsi.slow-op-subthreshold-flood) over a recorder-produced log", () => {
  const FLOOD_CALLS = 1100; // above SLOW_OP_FLOOD_MIN_SUBTHRESHOLD (1000); all inside the last hour
  const site = "test.hot.list_processes";

  function d13(logPath: string) {
    return new SlowOpFileSource({ logPath, instanceId: "test-instance" }).read();
  }

  it("reports no flood for a hot fast-ok site after the fix, and reports one for the same workload recorded unconditionally", async () => {
    // Positive control: the pre-fix behaviour (every call written) trips the detector, so a
    // quiet result below cannot be a wrong-filter zero.
    const controlLog = tempLog();
    const control = new SlowOpRecorder({ logPath: controlLog, maxBytes: 64 * 1024 * 1024 });
    for (let i = 0; i < FLOOD_CALLS; i++) control.recordMeasurement(site, 40);
    await control.flush();
    const flagged = d13(controlLog);
    expect(flagged.map((o) => o.fingerprint)).toHaveLength(1);
    await control.close();

    const logPath = tempLog();
    const recorder = new SlowOpRecorder({ logPath, maxBytes: 64 * 1024 * 1024 });
    for (let i = 0; i < FLOOD_CALLS; i++) await stageOf(recorder, site, 40, () => "ok");
    await stageOf(recorder, "test.hot.genuinely_slow", 300, () => "ok");
    await recorder.flush();
    expect(readRecords(logPath).map((r) => r.site)).toEqual(["test.hot.genuinely_slow"]);
    expect(d13(logPath)).toEqual([]);
    await recorder.close();
  }, 60_000);
});
