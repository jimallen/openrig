import { afterEach, describe, expect, it } from "vitest";
import { ContextHighWaterSource, ProviderWeeklyWindowSource, RetentionLagSource } from "../src/domain/rsi/usage-sources.js";
import { HealthProjectionService } from "../src/domain/health-detectors.js";
import { RSI_CONTEXT_HIGH_WATER, RSI_PROVIDER_WEEKLY_WINDOW, RSI_RETENTION_LAG } from "../src/domain/rsi/detector-ids.js";
import { INSTANCE, NOW, cleanupFixtures, fixture, hoursAgo, iso, span } from "./rsi-a2b-fixture.js";

afterEach(cleanupFixtures);

describe("D6 context high-water", () => {
  const source = (f: ReturnType<typeof fixture>, extra: { rowLimit?: number } = {}) => new ContextHighWaterSource(f.deps(extra));
  const ctx = (f: ReturnType<typeof fixture>, seat: string, pct: number | null, h: number) => f.usage({ lane: "context", seat, pct, hoursAgo: h });

  it("fires at exactly 90 percent and not at 89.9", () => {
    const f = fixture();
    ctx(f, "at@r", 90, 2);
    ctx(f, "below@r", 89.9, 2);

    const records = f.records(source(f));

    expect(records).toHaveLength(1);
    expect(span(records[0]!).fingerprint).toBe("rsi.context-high-water/seat:at@r");
    expect(records[0]!.scope).toEqual({ type: "instance", instanceId: INSTANCE });
  });

  it("judges the latest sample of each seat: an old high under a newer low is quiet, an old low under a newer high fires", () => {
    const f = fixture();
    ctx(f, "recovered@r", 97, 10); ctx(f, "recovered@r", 40, 2);
    ctx(f, "climbing@r", 40, 10); ctx(f, "climbing@r", 97, 2);

    const records = f.records(source(f));

    expect(records.map((r) => span(r).fingerprint)).toEqual(["rsi.context-high-water/seat:climbing@r"]);
    expect(span(records[0]!).count).toBe(1);
  });

  it("takes the latest sample per seat, not the latest sample of the whole table", () => {
    const f = fixture();
    ctx(f, "hot@r", 97, 5);
    ctx(f, "cold@r", 10, 1); // newer than the hot seat's sample, but another seat

    expect(f.records(source(f)).map((r) => span(r).fingerprint)).toEqual(["rsi.context-high-water/seat:hot@r"]);
  });

  it("looks back 7 days and no further", () => {
    const f = fixture();
    ctx(f, "inside@r", 95, 24 * 7 - 1);
    ctx(f, "outside@r", 95, 24 * 7 + 1);

    expect(f.records(source(f)).map((r) => span(r).fingerprint)).toEqual(["rsi.context-high-water/seat:inside@r"]);
  });

  it("reads only the context lane, even when another lane row carries a used percentage", () => {
    const f = fixture();
    f.db.prepare("INSERT INTO usage_samples (lane, seat_session, captured_at, used_percentage, window, window_used_percent) VALUES ('provider_window', 'leak@r', ?, 99, 'weekly', 99)").run(iso(2));

    expect(f.records(source(f))).toEqual([]);
  });

  it("reads the firing seat against the quiet seats and splits every context sample over at-or-above, below and unmeasured", () => {
    const f = fixture();
    const ids = [ctx(f, "hot@r", 80, 20), ctx(f, "hot@r", 93, 10), ctx(f, "hot@r", 97, 2)];
    ctx(f, "hot@r", 91, 1); // newest, so the seat's latest is 91
    ctx(f, "warm@r", 89, 2); ctx(f, "cool@r", 10, 2); ctx(f, "cool@r", null, 1);
    ctx(f, "gone@r", 99, 24 * 7 + 5); // outside the window

    const [record, ...rest] = f.records(source(f));

    expect(rest).toEqual([]);
    expect(span(record!)).toMatchObject({ count: 3, controlTotal: 2, population: 3, firstSeq: ids[1], lastSeq: ids[2] + 1 });
    // 5 samples at or above... 93, 97, 91 = 3; below 80, 89, 10 = 3; unmeasured 1 = 7 in the window.
    expect(record!.explanation).toContain("at or above 3, below 3, unmeasured 1 = 7");
    expect(record!.explanation).toContain("1 seat(s) fire and 2 do not, out of 3 seats");
  });

  it("names a row cap as partial coverage and keeps a read-only handle", () => {
    const f = fixture();
    ctx(f, "a@r", 95, 1); ctx(f, "b@r", 96, 1);

    const capped = source(f, { rowLimit: 1 });
    expect(capped.read()).toHaveLength(1);
    expect(capped.coverage()[0]).toMatchObject({ limit: 1, total: 2, evaluated: 1, omitted: 1, partial: true });
    expect(() => capped.readonlyHandle().exec("DELETE FROM usage_samples")).toThrowError(expect.objectContaining({ code: "SQLITE_READONLY" }));
  });
});

describe("D7 provider weekly window", () => {
  const source = (f: ReturnType<typeof fixture>) => new ProviderWeeklyWindowSource(f.deps());
  const weekly = (f: ReturnType<typeof fixture>, src: string | null, pct: number | null, h: number, resetsAt: string | null = iso(-48)) =>
    f.usage({ lane: "provider_window", window: "weekly", source: src, pct, hoursAgo: h, resetsAt });

  it("fires at exactly 95 percent and not at 94.9", () => {
    const f = fixture();
    weekly(f, "at", 95, 1);
    weekly(f, "below", 94.9, 1);

    const records = f.records(source(f));

    expect(records.map((r) => span(r).fingerprint)).toEqual(["rsi.provider-weekly-window/source:at"]);
  });

  it("reads the weekly window only: a saturated five-hour window is not a finding", () => {
    const f = fixture();
    f.usage({ lane: "provider_window", window: "five_hour", source: "src", pct: 100, hoursAgo: 1 });

    expect(f.records(source(f))).toEqual([]);
  });

  it("reads the provider_window lane only", () => {
    const f = fixture();
    f.db.prepare("INSERT INTO usage_samples (lane, seat_session, source, captured_at, used_percentage, window, window_used_percent) VALUES ('context', 'leak@r', 'leak', ?, 99, 'weekly', 99)").run(iso(1));

    expect(f.records(source(f))).toEqual([]);
  });

  it("looks back 24 hours: a saturated sample from 25 hours ago is not current", () => {
    const f = fixture();
    weekly(f, "fresh", 100, 23);
    weekly(f, "stale", 100, 25);

    expect(f.records(source(f)).map((r) => span(r).fingerprint)).toEqual(["rsi.provider-weekly-window/source:fresh"]);
  });

  it("treats a window that has already reset as not saturated, and a window with no reset time as saturated", () => {
    const f = fixture();
    weekly(f, "reset", 100, 1, iso(1));
    weekly(f, "future", 100, 1, iso(-1));
    weekly(f, "unknown-reset", 100, 1, null);

    expect(f.records(source(f)).map((r) => span(r).fingerprint).sort()).toEqual([
      "rsi.provider-weekly-window/source:future", "rsi.provider-weekly-window/source:unknown-reset",
    ]);
  });

  it("judges the latest sample of each source, not the latest sample of the table", () => {
    const f = fixture();
    weekly(f, "x", 100, 10); weekly(f, "x", 50, 2); // x recovered
    weekly(f, "y", 100, 5);
    weekly(f, "z", 20, 1); // newest overall, another source

    expect(f.records(source(f)).map((r) => span(r).fingerprint)).toEqual(["rsi.provider-weekly-window/source:y"]);
  });

  it("splits weekly samples over at-or-above, below and unmeasured and reads the saturated source against the others", () => {
    const f = fixture();
    const first = weekly(f, "hot", 96, 6); weekly(f, "hot", 98, 5); const last = weekly(f, "hot", 100, 1);
    weekly(f, "calm", 52, 1); weekly(f, "calm", null, 2);
    weekly(f, null, 10, 1); // an unattributed source
    f.usage({ lane: "provider_window", window: "five_hour", source: "hot", pct: 100, hoursAgo: 1 }); // not a weekly sample

    const [record, ...rest] = f.records(source(f));

    expect(rest).toEqual([]);
    expect(span(record!)).toMatchObject({ count: 3, controlTotal: 2, population: 3, firstSeq: first, lastSeq: last });
    // Weekly samples in the window: at or above 3, below 2, unmeasured 1 = 6.
    expect(record!.explanation).toContain("at or above 3, below 2, unmeasured 1 = 6");
    expect(record!.explanation).toContain("1 source(s) fire and 2 do not, out of 3");
  });

  it("names a row cap as partial coverage", () => {
    const f = fixture();
    weekly(f, "a", 99, 1); weekly(f, "b", 99, 1);

    const capped = new ProviderWeeklyWindowSource(f.deps({ rowLimit: 1 }));
    expect(capped.read()).toHaveLength(1);
    expect(capped.coverage()[0]).toMatchObject({ total: 2, evaluated: 1, omitted: 1, partial: true });
    expect(() => capped.readonlyHandle().exec("DELETE FROM usage_samples")).toThrowError(expect.objectContaining({ code: "SQLITE_READONLY" }));
  });
});

describe("D10 retention lag (a moving line: retention + sweep interval + slack)", () => {
  const days = (n: number) => n * 24;
  const source = (f: ReturnType<typeof fixture>, retentionDays: () => number = () => 14) =>
    new RetentionLagSource({ ...f.deps(), retentionDays });
  const row = (f: ReturnType<typeof fixture>, h: number) => f.usage({ lane: "context", pct: 10, hoursAgo: h });

  it("does not fire for rows inside the sweep's expected lag (past retention, inside retention + 1 day + 1 hour)", () => {
    const f = fixture();
    row(f, days(14) + 12);
    row(f, days(15) + 0.5); // 30 minutes past one sweep interval: inside the slack
    row(f, days(2));

    expect(f.records(source(f))).toEqual([]);
  });

  it("fires for a row older than retention + sweep interval + slack, and counts exactly the rows past the line", () => {
    const f = fixture();
    const old1 = row(f, days(15) + 2);
    const old2 = row(f, days(20));
    row(f, days(14) + 12); // expected lag
    row(f, days(1));

    const [record, ...rest] = f.records(source(f));

    expect(rest).toEqual([]);
    expect(record!.detector).toBe(RSI_RETENTION_LAG);
    expect(span(record!)).toMatchObject({
      fingerprint: "rsi.retention-lag/table:usage_samples", count: 2, controlTotal: 2, population: 4, firstSeq: old1, lastSeq: old2,
    });
    expect(record!.scope).toEqual({ type: "instance", instanceId: INSTANCE });
    // 4 rows: past the line 2, expected lag 1, within retention 1.
    expect(record!.explanation).toContain("expected lag 1, past the line 2, within retention 1 = 4");
  });

  it("keeps a row exactly on the line, as the sweep does (strictly older fires, equal does not)", () => {
    const f = fixture();
    const onLine = fixture();
    row(onLine, days(15) + 1); // line = retention 14 d + sweep 24 h + slack 1 h
    row(f, days(15) + 1 + 1 / 3600); // one second past it

    expect(onLine.records(source(onLine))).toEqual([]);
    expect(f.records(source(f))).toHaveLength(1);
  });

  it("holds a read-only handle that refuses writes", () => {
    const f = fixture();
    const lag = source(f);
    lag.read();

    expect(() => lag.readonlyHandle().exec("DELETE FROM usage_samples")).toThrowError(expect.objectContaining({ code: "SQLITE_READONLY" }));
  });

  it("moves the line with the live retention setting", () => {
    const f = fixture();
    row(f, days(5));

    expect(f.records(source(f, () => 14))).toEqual([]);
    expect(f.records(source(f, () => 3))).toHaveLength(1);
    expect(f.records(source(f, () => 4))).toEqual([]); // 4 d + 1 d + 1 h = 5 d 1 h: a 5 d row is still inside it
  });

  it("is unavailable, never zero, for a retention setting it cannot use", () => {
    const f = fixture();
    row(f, days(30));
    for (const bad of [0, -1, Number.NaN]) {
      const service = new HealthProjectionService([source(f, () => bad)]);
      expect(service.records()).toEqual([]);
      expect(service.coverage()).toEqual([expect.objectContaining({ source: "rsi-retention-lag", status: "unavailable", partial: true })]);
    }
  });

  it("reads quiet on an empty table with a coverage entry that says it evaluated the table", () => {
    const f = fixture();
    const quiet = source(f);

    expect(quiet.read()).toEqual([]);
    expect(quiet.coverage()[0]).toMatchObject({ unit: "tables", total: 0, evaluated: 0, partial: false });
  });

  it("evaluates at the injected clock, far from the wall clock", () => {
    const f = fixture();
    row(f, days(16));
    expect(hoursAgo(days(16)).getFullYear()).toBe(2031);

    expect(f.records(source(f))).toHaveLength(1);
    expect(NOW.getFullYear()).toBe(2031);
  });
});
