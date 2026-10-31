import { afterEach, describe, expect, it } from "vitest";
import {
  createCompactionStormSource, createPermissionStallSource, createWatchdogDeliveryFailureSource,
} from "../src/domain/rsi/event-sources.js";
import { RSI_COMPACTION_STORM, RSI_PERMISSION_STALL, RSI_WATCHDOG_DELIVERY_FAILURE } from "../src/domain/rsi/detector-ids.js";
import type { RsiFindingSource, RsiFindingSourceDeps } from "../src/domain/rsi/finding-builder.js";
import { HealthProjectionService } from "../src/domain/health-detectors.js";
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
  /** Statements one read prepares: the grouped pass, the one constant count of events whose payload is not JSON (OF-168, named on the
   *  coverage row), plus D5's identity cross-check. Still independent of the number of subjects. */
  statements: number;
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
    wrongType: (f, key, h) => f.activity({ seat: key, rawEvent: "SessionStart", rawSubtype: "compact", hoursAgo: h, type: "agent.activity_shadow" }),
    fingerprint: (key) => `rsi.compaction-storm/seat:${key}`,
    scope: (key) => ({ type: "seat", rigId: "rig-1", seatId: `node-${key}` }),
    statements: 3,
  },
  {
    label: "D9 permission-prompt stall", detectorId: RSI_PERMISSION_STALL, create: createPermissionStallSource, threshold: 8, windowHours: 24,
    hit: (f, key, h) => f.activity({ seat: key, rawEvent: "Notification", rawSubtype: null, state: "needs_input", hoursAgo: h }),
    nearMisses: [
      ["a running activity", (f, key, h) => f.activity({ seat: key, rawEvent: "Stop", rawSubtype: null, state: "running", hoursAgo: h })],
      ["an idle activity", (f, key, h) => f.activity({ seat: key, rawEvent: "Stop", rawSubtype: null, state: "idle", hoursAgo: h })],
      // OF-89: a pda runner's re-reported held message reads needs_input for rig ps; it is not a permission stall.
      // Restated, not imported: the three codes the runner reports.
      ["a pda held-message report (pda_message_held)", (f, key, h) => f.activity({ seat: key, rawEvent: "Notification", rawSubtype: "pda_message_held", state: "needs_input", hoursAgo: h })],
      ["a pda held-message report (pda_agent_missing)", (f, key, h) => f.activity({ seat: key, rawEvent: "Notification", rawSubtype: "pda_agent_missing", state: "needs_input", hoursAgo: h })],
      ["a pda held-message report (pda_unauthorized)", (f, key, h) => f.activity({ seat: key, rawEvent: "Notification", rawSubtype: "pda_unauthorized", state: "needs_input", hoursAgo: h })],
    ],
    wrongType: (f, key, h) => f.activity({ seat: key, rawEvent: "Notification", rawSubtype: null, state: "needs_input", hoursAgo: h, type: "agent.session_identity" }),
    fingerprint: (key) => `rsi.permission-stall/seat:${key}`,
    scope: (key) => ({ type: "seat", rigId: "rig-1", seatId: `node-${key}` }),
    statements: 2,
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
    statements: 2,
  },
];

describe.each(cases)("$label", (c) => {
  const key = c.detectorId === RSI_WATCHDOG_DELIVERY_FAILURE ? "job-01" : seatKey;
  const fires = (f: F) => f.records(c.create(f.deps()));
  // A source that throws is "unavailable", which reads as no records: quiet assertions read the source itself.
  const reads = (f: F) => c.create(f.deps()).read();
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
    expect(reads(below)).toEqual([]);
  });

  it.each(c.nearMisses)("does not count %s toward the threshold", (_label, miss) => {
    const f = fixture();
    seed(f, c.threshold - 1, 2);
    for (let i = 0; i < c.threshold * 2; i++) miss(f, key, 2);

    expect(reads(f)).toEqual([]);
  });

  it("does not count the same payload under another event type", () => {
    const f = fixture();
    seed(f, c.threshold - 1, 2);
    c.wrongType(f, key, 2);
    c.wrongType(f, key, 2);

    expect(reads(f)).toEqual([]);
  });

  it("counts per subject: the threshold split across two subjects fires neither", () => {
    const f = fixture();
    seed(f, c.threshold - 1, 2, `${key}-a`);
    seed(f, c.threshold - 1, 2, `${key}-b`);

    expect(reads(f)).toEqual([]);
  });

  it("keeps events inside the trailing window and drops those outside it, at the edge", () => {
    const inside = fixture();
    seed(inside, c.threshold, c.windowHours - 1);
    const outside = fixture();
    seed(outside, c.threshold - 1, 2);
    seed(outside, 1, c.windowHours + 1);

    expect(fires(inside)).toHaveLength(1);
    // One supporting event just outside the window: the count stays below the threshold.
    expect(reads(outside)).toEqual([]);
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

  it("is one grouped pass over its window: it prepares no more statements than the table says", () => {
    const f = fixture();
    seed(f, c.threshold, 2);
    seed(f, c.threshold, 2, `${key}-b`);
    const source = c.create(f.deps());
    const prepared = f.countStatements(source);

    expect(source.read()).toHaveLength(2);
    expect(prepared).toHaveLength(c.statements);
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
    f.activity({ seat: "seat-e@r", hoursAgo: 2, type: "agent.activity_shadow" });

    const [record, ...rest] = f.records(createCompactionStormSource(f.deps()));

    expect(rest).toEqual([]);
    expect(span(record!)).toMatchObject({
      count: 9, controlTotal: 2, population: 3, firstSeq: seqs[0], lastSeq: seqs[8],
      firstSeen: new Date(NOW.getTime() - 9 * 3_600_000).toISOString(), lastSeen: new Date(NOW.getTime() - 1 * 3_600_000).toISOString(),
    });
    // 12 + 6 + 1 = 19 SessionStart events: compact 12, startup 3, resume 1, clear 1, other 2.
    expect(record!.explanation).toContain("clear 1, compact 12, other 2, resume 1, startup 3 = 19");
    expect(record!.explanation).toContain("9 of 19 judged events");
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
    expect(record!.explanation).toContain("8 of 15 judged events");
  });
});

describe("D9: a question to Jim in a modal is not a stall (Jim, 2026-10-31)", () => {
  // Shapes measured on the live daemon (exec-cos@eztrack, 7 days): Claude Code reports its AskUserQuestion modal as
  // Notification/permission_prompt; the seat's next PostToolUse names the tool. Eight of a shape reach the threshold.
  const S = "exec-cos@eztrack", G = "gen-1";
  const prompt = (f: F, seat = S, generation = G) => f.activity({ seat, rawEvent: "Notification", rawSubtype: "permission_prompt", state: "needs_input", hoursAgo: 2, generation });
  const post = (f: F, tool: string, seat = S, generation = G) => f.activity({ seat, rawEvent: "PostToolUse", rawSubtype: tool, state: "running", hoursAgo: 2, generation });
  const stop = (f: F) => f.activity({ seat: S, rawEvent: "Stop", rawSubtype: null, state: "idle", hoursAgo: 2, generation: G });
  const count = (f: F) => {
    const records = f.records(createPermissionStallSource(f.deps()));
    return records.length === 0 ? 0 : span(records[0]!).count;
  };

  it("a modal, then its PostToolUse(AskUserQuestion): not counted", () => {
    const f = fixture();
    for (let i = 0; i < 8; i++) { prompt(f); post(f, "AskUserQuestion"); stop(f); }
    expect(count(f)).toBe(0);
  });

  it("a permission prompt, then its tool's PostToolUse: counted", () => {
    const f = fixture();
    for (let i = 0; i < 8; i++) { prompt(f); post(f, "Bash"); stop(f); }
    expect(count(f)).toBe(8);
  });

  it("a denied prompt, with no PostToolUse after it: counted", () => {
    const f = fixture();
    for (let i = 0; i < 8; i++) { prompt(f); stop(f); }
    expect(count(f)).toBe(8);
  });

  it("an unanswered modal counts until it is answered", () => {
    const f = fixture();
    for (let i = 0; i < 8; i++) prompt(f);
    expect(count(f)).toBe(8);
    post(f, "AskUserQuestion");
    expect(count(f)).toBe(0);
  });

  it("chosen: another tool's PostToolUse before the AskUserQuestion one (a racing or subagent tool) counts, as ambiguous", () => {
    const f = fixture();
    for (let i = 0; i < 8; i++) { prompt(f); post(f, "Read"); post(f, "AskUserQuestion"); }
    expect(count(f)).toBe(8);
  });

  it("the answer must come from the same seat and the same generation", () => {
    const f = fixture();
    for (let i = 0; i < 8; i++) { prompt(f); post(f, "AskUserQuestion", "verify-qa@eztrack"); }
    expect(count(f)).toBe(8);
    const g = fixture();
    for (let i = 0; i < 8; i++) { prompt(g, S, `gen-${i}`); post(g, "AskUserQuestion", S, `gen-${i}-next`); }
    expect(count(g)).toBe(8);
  });

  it("only a PostToolUse answers: another event naming AskUserQuestion (a PreToolUse, should a relay send one) does not", () => {
    const f = fixture();
    for (let i = 0; i < 8; i++) { prompt(f); f.activity({ seat: S, rawEvent: "PreToolUse", rawSubtype: "AskUserQuestion", state: "running", hoursAgo: 2, generation: G }); }
    expect(count(f)).toBe(8);
  });

  it("review: a denied prompt right before an answered modal counts (it does not borrow the modal's answer)", () => {
    const f = fixture();
    for (let i = 0; i < 8; i++) { prompt(f); prompt(f); post(f, "AskUserQuestion"); }
    expect(count(f)).toBe(8);
  });

  it("review: a PermissionRequest is always a real request, even before an AskUserQuestion answer", () => {
    const f = fixture();
    for (let i = 0; i < 8; i++) {
      f.activity({ seat: S, rawEvent: "PermissionRequest", rawSubtype: "Bash", state: "needs_input", hoursAgo: 2, generation: G });
      post(f, "AskUserQuestion");
    }
    expect(count(f)).toBe(8);
  });

  it("review: the answer must come within 12 hours of the prompt", () => {
    const late = fixture();
    for (let i = 0; i < 8; i++) {
      late.activity({ seat: S, rawEvent: "Notification", rawSubtype: "permission_prompt", state: "needs_input", hoursAgo: 20, generation: `g-${i}` });
      late.activity({ seat: S, rawEvent: "PostToolUse", rawSubtype: "AskUserQuestion", state: "running", hoursAgo: 7, generation: `g-${i}` });
    }
    expect(count(late)).toBe(8);  // answered 13 h later: counted
    const inTime = fixture();
    for (let i = 0; i < 8; i++) {
      inTime.activity({ seat: S, rawEvent: "Notification", rawSubtype: "permission_prompt", state: "needs_input", hoursAgo: 20, generation: `g-${i}` });
      inTime.activity({ seat: S, rawEvent: "PostToolUse", rawSubtype: "AskUserQuestion", state: "running", hoursAgo: 9, generation: `g-${i}` });
    }
    expect(count(inTime)).toBe(0);  // answered 11 h later: not counted
  });

  it("the measured mix: eight modals and eight permission prompts count eight", () => {
    const f = fixture();
    for (let i = 0; i < 8; i++) { prompt(f); post(f, "AskUserQuestion"); prompt(f); post(f, "Bash"); }
    expect(count(f)).toBe(8);
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
    expect(record!.explanation).toContain("3 of 13 judged events");
  });

  it("reads the live stale case as quiet: failures older than 7 days do not fire, however many", () => {
    const f = fixture();
    for (let i = 0; i < 6; i++) f.fired({ jobId: "job-old", deliveryStatus: "failed", hoursAgo: 24 * 7 + 5 });

    expect(f.records(createWatchdogDeliveryFailureSource(f.deps()))).toEqual([]);
  });
});

describe("D5 cross-check: SessionStart activity events must equal agent.session_identity events", () => {
  const compactions = (f: ReturnType<typeof fixture>, n: number) => {
    for (let i = 0; i < n; i++) f.activity({ seat: seatKey, rawEvent: "SessionStart", rawSubtype: "compact", hoursAgo: 2 });
  };

  it("serves the finding while the two series agree", () => {
    const f = fixture();
    compactions(f, 8);

    expect(f.records(createCompactionStormSource(f.deps()))).toHaveLength(1);
  });

  it("reports the source unavailable, never a count, when a SessionStart has no identity event", () => {
    const f = fixture();
    compactions(f, 8);
    f.activity({ seat: seatKey, rawEvent: "SessionStart", rawSubtype: "compact", hoursAgo: 2, identity: false });
    const service = new HealthProjectionService([createCompactionStormSource(f.deps())]);

    expect(service.records()).toEqual([]);
    expect(service.coverage()).toEqual([expect.objectContaining({ source: "rsi-compaction-storm", status: "unavailable", partial: true, reason: expect.stringContaining("disagree") })]);
  });

  it("is not disturbed by a Pi or OMP identity event: provenance rpc has no SessionStart and is not compared", () => {
    const f = fixture();
    compactions(f, 8);
    f.event("agent.session_identity", { type: "agent.session_identity", runtime: "pi", provenance: "rpc", sessionName: "pi-seat@r" }, "2031-03-04 03:00:00");
    f.event("agent.session_identity", { type: "agent.session_identity", runtime: "omp", provenance: "rpc", sessionName: "omp-seat@r" }, "2031-03-04 04:00:00");
    f.event("agent.session_identity", { type: "agent.session_identity", sessionName: "no-provenance@r" }, "2031-03-04 04:30:00");
    const service = new HealthProjectionService([createCompactionStormSource(f.deps())]);

    expect(service.records()).toHaveLength(1);
    expect(service.coverage()).toEqual([expect.objectContaining({ source: "rsi-compaction-storm", partial: false, total: 1 })]);
  });

  it("reports the source unavailable when a HOOK identity event has no SessionStart", () => {
    const f = fixture();
    compactions(f, 8);
    f.event("agent.session_identity", { type: "agent.session_identity", provenance: "hook", sessionName: seatKey }, "2031-03-04 03:00:00");
    const service = new HealthProjectionService([createCompactionStormSource(f.deps())]);

    expect(service.records()).toEqual([]);
    expect(service.coverage()).toEqual([expect.objectContaining({ status: "unavailable", reason: expect.stringContaining("hook agent.session_identity") })]);
  });

  it("reads both series from one snapshot: a pair committed between the two statements cannot desynchronise them", () => {
    const f = fixture();
    compactions(f, 8);
    const source = createCompactionStormSource(f.deps());
    // After the grouped statement returns, a writer commits another SessionStart and its identity event.
    f.afterFirstStatement(source, () => f.activity({ seat: seatKey, rawEvent: "SessionStart", rawSubtype: "compact", hoursAgo: 1 }));

    const observations = source.read();

    expect(observations).toHaveLength(1);
    expect(JSON.stringify(observations)).toContain('"count":8'); // the snapshot predates the writer's commit
    expect(createCompactionStormSource(f.deps()).read()).toHaveLength(1);
    expect(JSON.stringify(createCompactionStormSource(f.deps()).read())).toContain('"count":9'); // a fresh read sees all nine
  });
});

describe("migration 114: the events and usage_samples indexes serve the grouped passes", () => {
  it("exists, and the query plan searches it instead of scanning the table", () => {
    const f = fixture();
    const indexes = (f.db.prepare("PRAGMA index_list(events)").all() as Array<{ name: string }>).map((row) => row.name);
    const plan = (f.db.prepare("EXPLAIN QUERY PLAN SELECT count(*) FROM events WHERE type = ? AND created_at >= ?").all("agent.activity", "2031-01-01 00:00:00") as Array<{ detail: string }>).map((row) => row.detail).join(" | ");

    expect(indexes).toContain("idx_events_type_created_at");
    expect(plan).toContain("idx_events_type_created_at");
  });

  it("also indexes usage_samples(lane, captured_at), which the context and provider-window reads search", () => {
    const f = fixture();
    const indexes = (f.db.prepare("PRAGMA index_list(usage_samples)").all() as Array<{ name: string }>).map((row) => row.name);
    const plan = (f.db.prepare("EXPLAIN QUERY PLAN SELECT count(*) FROM usage_samples WHERE lane = ? AND captured_at >= ?").all("context", "2031-01-01T00:00:00.000Z") as Array<{ detail: string }>).map((row) => row.detail).join(" | ");

    expect(indexes).toContain("idx_usage_samples_lane_captured_at");
    expect(plan).toContain("idx_usage_samples_lane_captured_at");
  });
});

// OF-117: the three event-counted sources parse event payloads with SQLite json_extract inside one grouped pass. One event
// whose payload is not JSON (a hand edit, a truncated write) made json_extract throw "malformed JSON" and the whole pass
// failed: no finding for ANY seat or job while the row existed. A damaged payload is not a supporting event (the event-bus
// replay leaves it out the same way); the readable events still count, and the D5 cross-check counts both series alike.
describe("OF-117: an event whose payload is not JSON is left out of the count, not the end of the pass", () => {
  it.each([
    ["D5 compaction storm", createCompactionStormSource, "agent.activity"],
    ["D9 permission stall", createPermissionStallSource, "agent.activity"],
    ["D12 watchdog delivery failure", createWatchdogDeliveryFailureSource, "watchdog.evaluation_fired"],
  ] as const)("%s: the threshold is still met by the readable events beside a damaged one", (_label, create, eventType) => {
    const f = fixture();
    for (let i = 0; i < 8; i++) {
      if (eventType === "agent.activity") {
        if (create === createCompactionStormSource) f.activity({ seat: "seat-a@r", rawEvent: "SessionStart", rawSubtype: "compact", hoursAgo: 2 });
        else f.activity({ seat: "seat-a@r", rawEvent: "Notification", rawSubtype: null, state: "needs_input", hoursAgo: 2 });
      } else {
        f.fired({ jobId: "job-a", deliveryStatus: "failed", hoursAgo: 2 });
      }
    }
    f.event(eventType, "{not json", "2031-03-04 03:06:07");
    // D5's cross-check counts the paired agent.session_identity events by the same json_extract: a damaged one is left out too.
    f.event("agent.session_identity", "{not json", "2031-03-04 03:06:07");
    const source = create(f.deps());
    expect(() => source.read()).not.toThrow();
    expect(source.read()).toHaveLength(1);
  });
});
