import { afterEach, describe, expect, it } from "vitest";
import {
  createCompactionStormSource, createPermissionStallSource, createWatchdogDeliveryFailureSource,
} from "../src/domain/rsi/event-sources.js";
import { RSI_COMPACTION_STORM, RSI_PERMISSION_STALL, RSI_WATCHDOG_DELIVERY_FAILURE } from "../src/domain/rsi/detector-ids.js";
import type { RsiFindingSource, RsiFindingSourceDeps } from "../src/domain/rsi/finding-builder.js";
import { INSTANCE, NOW, cleanupFixtures, fixture, span } from "./rsi-a2b-fixture.js";

afterEach(cleanupFixtures);

type F = ReturnType<typeof fixture>;

/**
 * The three event-counted detectors share one shape; this table pins each one's own predicate
 * (threshold, window, what counts as a hit, what is only in the population, the subject, the
 * event type). Every number is restated here independently of the source.
 */
interface Case {
  label: string;
  detectorId: string;
  create: (deps: RsiFindingSourceDeps) => RsiFindingSource;
  threshold: number;
  windowHours: number;
  /** A supporting event for subject `key`. */
  hit: (f: F, key: string, hoursAgo: number) => number;
  /** Events that are NOT supporting events, though some are in the judged population. */
  nearMisses: Array<[string, (f: F, key: string, hoursAgo: number) => number]>;
  /** The same supporting payload under a different event type. */
  wrongType: (f: F, key: string, hoursAgo: number) => number;
  fingerprint: (key: string) => string;
  scope: (key: string) => unknown;
}

const seatKey = "verify-ops@eztrack";
const cases: Case[] = [
  {
    label: "D5 compaction storm", detectorId: RSI_COMPACTION_STORM, create: createCompactionStormSource, threshold: 8, windowHours: 24,
    hit: (f, key, h) => f.activity({ seat: key, rawEvent: "SessionStart", rawSubtype: "compact", hoursAgo: h }),
    nearMisses: [
      ["a startup SessionStart", (f, key, h) => f.activity({ seat: key, rawEvent: "SessionStart", rawSubtype: "startup", hoursAgo: h })],
      ["a resume SessionStart", (f, key, h) => f.activity({ seat: key, rawEvent: "SessionStart", rawSubtype: "resume", hoursAgo: h })],
      ["a compact subtype under another raw event", (f, key, h) => f.activity({ seat: key, rawEvent: "PreCompact", rawSubtype: "compact", hoursAgo: h })],
    ],
    wrongType: (f, key, h) => f.activity({ seat: key, rawEvent: "SessionStart", rawSubtype: "compact", hoursAgo: h, type: "agent.session_identity" }),
    fingerprint: (key) => `rsi.compaction-storm/seat:${key}`,
    scope: (key) => ({ type: "seat", rigId: "rig-1", seatId: `node-${key}` }),
  },
  {
    label: "D9 permission-prompt stall", detectorId: RSI_PERMISSION_STALL, create: createPermissionStallSource, threshold: 8, windowHours: 24,
    hit: (f, key, h) => f.activity({ seat: key, rawEvent: "Notification", rawSubtype: null, state: "needs_input", hoursAgo: h }),
    nearMisses: [
      ["a running activity", (f, key, h) => f.activity({ seat: key, rawEvent: "Stop", rawSubtype: null, state: "running", hoursAgo: h })],
      ["an idle activity", (f, key, h) => f.activity({ seat: key, rawEvent: "Stop", rawSubtype: null, state: "idle", hoursAgo: h })],
    ],
    wrongType: (f, key, h) => f.activity({ seat: key, rawEvent: "Notification", rawSubtype: null, state: "needs_input", hoursAgo: h, type: "agent.session_identity" }),
    fingerprint: (key) => `rsi.permission-stall/seat:${key}`,
    scope: (key) => ({ type: "seat", rigId: "rig-1", seatId: `node-${key}` }),
  },
  {
    label: "D12 watchdog delivery failure", detectorId: RSI_WATCHDOG_DELIVERY_FAILURE, create: createWatchdogDeliveryFailureSource, threshold: 3, windowHours: 168,
    hit: (f, key, h) => f.fired({ jobId: key, deliveryStatus: "failed", hoursAgo: h }),
    nearMisses: [
      ["an ok delivery", (f, key, h) => f.fired({ jobId: key, deliveryStatus: "ok", hoursAgo: h })],
      ["a retained delivery", (f, key, h) => f.fired({ jobId: key, deliveryStatus: "retained", hoursAgo: h })],
    ],
    wrongType: (f, key, h) => f.fired({ jobId: key, deliveryStatus: "failed", hoursAgo: h, type: "watchdog.evaluation_skipped" }),
    fingerprint: (key) => `rsi.watchdog-delivery-failure/job:${key}`,
    scope: () => ({ type: "instance", instanceId: INSTANCE }),
  },
];

describe.each(cases)("$label", (c) => {
  const key = c.detectorId === RSI_WATCHDOG_DELIVERY_FAILURE ? "job-01" : seatKey;
  const fires = (f: F) => f.records(c.create(f.deps()));
  const seed = (f: F, n: number, hoursAgo: number, k = key) => { for (let i = 0; i < n; i++) c.hit(f, k, hoursAgo); };

  it("fires at exactly the threshold and not one below, with the subject's own fingerprint and scope", () => {
    const at = fixture();
    seed(at, c.threshold, 2);
    const below = fixture();
    seed(below, c.threshold - 1, 2);

    const [record, ...rest] = fires(at);
    expect(rest).toEqual([]);
    expect(record!.detector).toBe(c.detectorId);
    expect(record!.scope).toEqual(c.scope(key));
    expect(span(record!)).toMatchObject({ fingerprint: c.fingerprint(key), count: c.threshold });
    expect(fires(below)).toEqual([]);
  });

  it.each(c.nearMisses)("does not count %s toward the threshold", (_label, miss) => {
    const f = fixture();
    seed(f, c.threshold - 1, 2);
    for (let i = 0; i < c.threshold * 2; i++) miss(f, key, 2);

    expect(fires(f)).toEqual([]);
  });

  it("does not count the same payload under another event type", () => {
    const f = fixture();
    seed(f, c.threshold - 1, 2);
    c.wrongType(f, key, 2);
    c.wrongType(f, key, 2);

    expect(fires(f)).toEqual([]);
  });

  it("counts per subject: the threshold split across two subjects fires neither", () => {
    const f = fixture();
    seed(f, c.threshold - 1, 2, `${key}-a`);
    seed(f, c.threshold - 1, 2, `${key}-b`);

    expect(fires(f)).toEqual([]);
  });

  it("keeps events inside the trailing window and drops those outside it, at the edge", () => {
    const inside = fixture();
    seed(inside, c.threshold, c.windowHours - 1);
    const outside = fixture();
    seed(outside, c.threshold - 1, 2);
    seed(outside, 1, c.windowHours + 1);

    expect(fires(inside)).toHaveLength(1);
    // One supporting event just outside the window: the count stays below the threshold.
    expect(fires(outside)).toEqual([]);
  });

  it("names a row cap as partial coverage rather than as zero, and reports the whole firing total", () => {
    const f = fixture();
    seed(f, c.threshold, 2, `${key}-a`);
    seed(f, c.threshold, 2, `${key}-b`);

    const capped = c.create(f.deps({ rowLimit: 1 }));
    expect(capped.read()).toHaveLength(1);
    expect(capped.coverage()[0]).toMatchObject({ limit: 1, total: 2, evaluated: 1, omitted: 1, partial: true });
    const whole = c.create(f.deps());
    expect(whole.read()).toHaveLength(2);
    expect(whole.coverage()[0]).toMatchObject({ total: 2, evaluated: 2, omitted: 0, partial: false });
  });

  it("holds a read-only handle that refuses writes yet sees later commits", () => {
    const f = fixture();
    const source = c.create(f.deps());
    expect(source.read()).toEqual([]);
    expect(() => source.readonlyHandle().exec("DELETE FROM events")).toThrowError(expect.objectContaining({ code: "SQLITE_READONLY" }));
    seed(f, c.threshold, 2);
    expect(source.read()).toHaveLength(1);
  });

  it("serves a record whose episode window covers its evidence at the injected clock", () => {
    const f = fixture();
    c.hit(f, key, 5); // the episode starts at the EARLIEST supporting event, not the latest
    seed(f, c.threshold - 1, 3);

    const [record] = fires(f);

    expect(record).toMatchObject({ status: "active", category: "process", severity: "info", lastObservedAt: NOW.toISOString() });
    expect(record!.freshness.state).toBe("fresh");
    expect(record!.startedAt).toBe(new Date(NOW.getTime() - 5 * 3_600_000).toISOString());
    expect(span(record!)).toMatchObject({ firstSeen: record!.startedAt, lastSeen: new Date(NOW.getTime() - 3 * 3_600_000).toISOString() });
  });
});

describe("D5 controls: the judged population and the sum-to-total partitions", () => {
  it("reads the firing seat against the quiet seats and splits every SessionStart event over the closed subtype list", () => {
    const f = fixture();
    const sessionStart = (seat: string, rawSubtype: string | null, hoursAgo: number) => f.activity({ seat, rawEvent: "SessionStart", rawSubtype, hoursAgo });
    // Seat A fires: 9 compactions, oldest first so the seq order follows time.
    const seqs: number[] = [];
    for (let h = 9; h >= 1; h--) seqs.push(sessionStart("seat-a@r", "compact", h));
    sessionStart("seat-a@r", "startup", 3); sessionStart("seat-a@r", "startup", 3); sessionStart("seat-a@r", "resume", 3);
    // Seat B does not: 3 compactions, plus a clear, an unknown subtype and a missing subtype.
    for (let i = 0; i < 3; i++) sessionStart("seat-b@r", "compact", 4);
    sessionStart("seat-b@r", "clear", 4); sessionStart("seat-b@r", "bogus", 4); sessionStart("seat-b@r", null, 4);
    sessionStart("seat-c@r", "startup", 4);
    // Outside the population: another raw event, an old event, another event type.
    f.activity({ seat: "seat-d@r", rawEvent: "PreCompact", rawSubtype: "compact", hoursAgo: 2 });
    sessionStart("seat-a@r", "compact", 30);
    f.activity({ seat: "seat-e@r", hoursAgo: 2, type: "agent.session_identity" });

    const [record, ...rest] = f.records(createCompactionStormSource(f.deps()));

    expect(rest).toEqual([]);
    expect(span(record!)).toMatchObject({
      count: 9, controlTotal: 2, population: 3, firstSeq: seqs[0], lastSeq: seqs[8],
      firstSeen: new Date(NOW.getTime() - 9 * 3_600_000).toISOString(), lastSeen: new Date(NOW.getTime() - 1 * 3_600_000).toISOString(),
    });
    // 12 + 6 + 1 = 19 SessionStart events: compact 12, startup 3, resume 1, clear 1, other 2.
    expect(record!.explanation).toContain("clear 1, compact 12, other 2, resume 1, startup 3 = 19");
    expect(record!.explanation).toContain("1 seat(s) fire and 2 judged seat(s) do not, out of 3");
  });
});

describe("D9 controls", () => {
  it("splits every activity event over the closed state list and reads the stalled seat against the others", () => {
    const f = fixture();
    const act = (seat: string, state: string, hoursAgo: number) => f.activity({ seat, rawEvent: "Notification", rawSubtype: null, state, hoursAgo });
    for (let i = 0; i < 8; i++) act("seat-a@r", "needs_input", 3);
    act("seat-a@r", "running", 3); act("seat-a@r", "running", 3); act("seat-a@r", "idle", 3);
    act("seat-b@r", "needs_input", 3); act("seat-b@r", "needs_input", 3); act("seat-b@r", "unknown", 3); act("seat-b@r", "weird", 3);

    const [record, ...rest] = f.records(createPermissionStallSource(f.deps()));

    expect(rest).toEqual([]);
    expect(span(record!)).toMatchObject({ count: 8, controlTotal: 1, population: 2 });
    // 11 + 4 = 15 activity events: idle 1, needs_input 10, other 1, running 2, unknown 1.
    expect(record!.explanation).toContain("idle 1, needs_input 10, other 1, running 2, unknown 1 = 15");
  });
});

describe("D12 controls", () => {
  it("splits every sent wake-up over the closed delivery-status list and reads the failing job against the others", () => {
    const f = fixture();
    const send = (jobId: string, deliveryStatus: string, hoursAgo: number) => f.fired({ jobId, deliveryStatus, hoursAgo });
    for (let i = 0; i < 3; i++) send("job-a", "failed", 100);
    send("job-a", "ok", 100); send("job-a", "ok", 100); send("job-a", "retained", 100); send("job-a", "odd", 100);
    send("job-b", "failed", 100); send("job-b", "failed", 100);
    for (let i = 0; i < 4; i++) send("job-b", "ok", 100);

    const [record, ...rest] = f.records(createWatchdogDeliveryFailureSource(f.deps()));

    expect(rest).toEqual([]);
    expect(span(record!)).toMatchObject({ count: 3, controlTotal: 1, population: 2 });
    // 7 + 6 = 13 wake-ups: failed 5, ok 6, other 1, retained 1.
    expect(record!.explanation).toContain("failed 5, ok 6, other 1, retained 1 = 13");
  });

  it("reads the live stale case as quiet: failures older than 7 days do not fire, however many", () => {
    const f = fixture();
    for (let i = 0; i < 6; i++) f.fired({ jobId: "job-old", deliveryStatus: "failed", hoursAgo: 24 * 7 + 5 });

    expect(f.records(createWatchdogDeliveryFailureSource(f.deps()))).toEqual([]);
  });
});
