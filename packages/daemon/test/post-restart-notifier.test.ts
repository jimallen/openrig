// OF-182: the post-restart prompt. The send is faked and the clock is a counter; the outbox is the real handler on an
// in-memory database. Nothing here reaches a seat, a socket or tmux.
import { describe, it, expect, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import {
  PostRestartNotifier, needsPostRestartPrompt, postRestartDeliveryId, postRestartText, POST_RESTART_SENDER,
  type PostRestartDeps, type PostRestartSendResult,
} from "../src/domain/post-restart-notifier.js";
import type { RestoreNodeResult, RestoreResult } from "../src/domain/types.js";

const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

const T0 = Date.parse("2026-10-30T18:00:00.000Z");
/** The seat's session start: deliberately not the handling time, so a timestamp taken from the clock fails. */
const SEAT_START = "2026-10-30T17:59:00.000Z";

interface Sent { sessionName: string; text: string; deliveryId: string; actorSession: string; waitForIdleMs: number }

function make(opts: { script?: PostRestartSendResult[]; enabled?: boolean; sessions?: Record<string, string | null>; startedAt?: Record<string, string>; over?: Partial<PostRestartDeps> } = {}) {
  const db = createDb();
  migrate(db, ALL_MIGRATIONS);
  dbs.push(db);
  const outbox = new OutboxHandler(db);
  const clock = { t: T0 };
  const sent: Sent[] = [];
  const sleeps: number[] = [];
  const logs: string[] = [];
  const script = [...(opts.script ?? [])];
  const sessions: Record<string, string | null> = opts.sessions ?? { "node-a": "dev-a@rig1", "node-b": "dev-b@rig1", "node-c": "dev-c@rig1", "node-d": "dev-d@rig1" };
  const notifier = new PostRestartNotifier({
    enabled: () => opts.enabled ?? true,
    sessionOf: (nodeId) => (sessions[nodeId] ? { name: sessions[nodeId]!, startedAt: opts.startedAt?.[nodeId] ?? SEAT_START } : null),
    log: (line) => logs.push(line),
    rigNameOf: () => "rig1",
    send: async (sessionName, text, o) => {
      sent.push({ sessionName, text, ...o });
      return script.shift() ?? { ok: true, verified: true };
    },
    outbox,
    now: () => new Date(clock.t),
    sleep: async (ms) => { sleeps.push(ms); clock.t += ms; },
    firstDelayMs: 20_000,
    retryEveryMs: 60_000,
    windowMs: 30 * 60_000,
    waitForIdleMs: 60_000,
    ...opts.over,
  });
  return { db, outbox, notifier, sent, sleeps, clock, logs };
}

function node(nodeId: string, status: RestoreNodeResult["status"], extra: Partial<RestoreNodeResult> = {}): RestoreNodeResult {
  return { nodeId, logicalId: nodeId.replace("node-", "dev."), status, ...extra };
}

function result(nodes: RestoreNodeResult[]): RestoreResult {
  return { snapshotId: "snap-1", preRestoreSnapshotId: null, rigResult: "fully_restored", nodes, warnings: [] };
}

describe("who gets the prompt", () => {
  it.each([
    ["resumed", {}, true],
    ["resumed, reattached (OF-155: its session never stopped)", { reattached: { sessionId: "s1", sessionName: "dev-a@rig1" } }, false],
  ] as const)("%s → %s", (_label, extra, expected) => {
    expect(needsPostRestartPrompt(node("node-a", "resumed", extra))).toBe(expected);
  });

  it.each(["fresh", "fresh-primed", "rebuilt", "awaiting-decision", "failed", "attention_required", "operator_recovered"] as const)(
    "%s → no prompt (a new conversation with its own startup context, or no running session)", (status) => {
      expect(needsPostRestartPrompt(node("node-a", status))).toBe(false);
    });

  it("a restore with mixed outcomes sends exactly once, to each resumed seat that was not reattached", async () => {
    const f = make();
    const out = await f.notifier.onRestoreCompleted({ seq: 41, rigId: "rig-1", result: result([
      node("node-a", "resumed"), node("node-b", "fresh-primed"), node("node-c", "resumed", { reattached: { sessionId: "s", sessionName: "dev-c@rig1" } }),
      node("node-d", "rebuilt"),
    ]) });
    expect(f.sent.map((s) => [s.sessionName, s.deliveryId, s.actorSession])).toEqual([["dev-a@rig1", "post-restart-41-node-a", POST_RESTART_SENDER]]);
    expect(out).toEqual([{ nodeId: "node-a", sessionName: "dev-a@rig1", outcome: "delivered", attempts: 1 }]);
  });
});

describe("the prompt", () => {
  it("says the seat was restarted and when, what stopped, that a detached process may survive, and to check before restarting", () => {
    const text = postRestartText({ rigName: "eztrack", restartedAt: "2026-10-30T18:00:20.000Z" });
    for (const phrase of ["restarted at 2026-10-30T18:00:20.000Z", "rig eztrack", "stopped with it", "wake-up timer",
      "may still be running", "handover and notes", "see what is actually running", "so nothing runs twice"]) {
      expect(text).toContain(phrase);
    }
  });

  it("a control character in the rig name is removed", () => {
    expect(postRestartText({ rigName: "ez\u001b[201~track", restartedAt: "t" })).toContain("rig ez[201~track");
  });

  it("the text handed to the transport carries no C0/C1 control (OF-169), whatever the rig name holds", async () => {
    const f = make({ over: { rigNameOf: () => "ez\u001b[201~\u0007\u009b2Jtrack\u0000" } });
    await f.notifier.onRestoreCompleted({ seq: 7, rigId: "rig-1", result: result([node("node-a", "resumed")]) });
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]!.text).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/);
    expect(f.sent[0]!.text).toContain("rig ez[201~2Jtrack was restored");
  });

  it("goes out after the first delay, with an idle wait, as restore@system", async () => {
    const f = make();
    await f.notifier.onRestoreCompleted({ seq: 7, rigId: "rig-1", result: result([node("node-a", "resumed")]) });
    expect(f.sleeps[0]).toBe(20_000);
    expect(f.sent[0]).toMatchObject({ waitForIdleMs: 60_000, actorSession: "restore@system" });
    expect(f.sent[0]!.text).toBe(postRestartText({ rigName: "rig1", restartedAt: SEAT_START }));
  });

  it("OF-184: 'restarted at' is the seat's session start, not the handling time (the clock is 20 s past T0 when it is sent)", async () => {
    const f = make({ startedAt: { "node-a": "2026-10-30T17:58:12.000Z" } });
    await f.notifier.onRestoreCompleted({ seq: 7, rigId: "rig-1", result: result([node("node-a", "resumed")]) });
    expect(f.sent[0]!.text).toContain("restarted at 2026-10-30T17:58:12.000Z");
    expect(f.sent[0]!.text).not.toContain(new Date(T0 + 20_000).toISOString());
  });
});

describe("OF-184: a seat replaced inside the window", () => {
  const RESTORED_AT = "2026-10-30T18:00:00.000Z";

  it("a session started after the restore completed gets no 'resumed' prompt and no row", async () => {
    const f = make({ startedAt: { "node-a": "2026-10-30T18:05:00.000Z" } });
    const out = await f.notifier.onRestoreCompleted({ seq: 7, rigId: "rig-1", result: result([node("node-a", "resumed")]), createdAt: RESTORED_AT });
    expect(out[0]).toMatchObject({ outcome: "replaced", attempts: 0 });
    expect(f.sent).toHaveLength(0);
    expect(f.outbox.getById("post-restart-7-node-a")).toBeNull();
  });

  it("a seat replaced after a few busy retries stops at the replacement: nothing is sent to it", async () => {
    const startedAt: Record<string, string> = { "node-a": SEAT_START };
    const sends: string[] = [];
    const f = make({
      startedAt,
      over: {
        // the first attempt is refused (seat busy); by the next one the seat has been launched again
        send: async (sessionName) => { sends.push(sessionName); startedAt["node-a"] = "2026-10-30T18:03:00.000Z"; return { ok: false, reason: "not_idle" }; },
      },
    });
    const out = await f.notifier.onRestoreCompleted({ seq: 7, rigId: "rig-1", result: result([node("node-a", "resumed")]), createdAt: RESTORED_AT });
    expect(sends).toHaveLength(1);
    expect(out[0]).toMatchObject({ outcome: "replaced", attempts: 1 });
    expect(f.outbox.getById("post-restart-7-node-a")).toBeNull();
  });

  it("a session that started before (or at) the restore is the resumed seat and is sent to", async () => {
    const f = make({ startedAt: { "node-a": RESTORED_AT } });
    const out = await f.notifier.onRestoreCompleted({ seq: 7, rigId: "rig-1", result: result([node("node-a", "resumed")]), createdAt: RESTORED_AT });
    expect(out[0]).toMatchObject({ outcome: "delivered" });
  });

  it("the window runs from the restore, not from when a re-derived event is handled", async () => {
    const f = make({ startedAt: { "node-a": "2026-10-30T17:30:00.000Z" }, script: Array.from({ length: 100 }, () => ({ ok: false, reason: "not_idle" })) });
    // restored 25 minutes before T0: 5 minutes of window left
    const out = await f.notifier.onRestoreCompleted({ seq: 7, rigId: "rig-1", result: result([node("node-a", "resumed")]), createdAt: new Date(T0 - 25 * 60_000).toISOString() });
    expect(out[0]).toMatchObject({ outcome: "undelivered" });
    expect(f.sent.length).toBe(5);
  });
});

describe("OF-184: retry log noise", () => {
  it("a seat busy for the whole window logs the refusal once, plus the window-closed line", async () => {
    const f = make({ script: Array.from({ length: 100 }, () => ({ ok: false, reason: "target_needs_input" })) });
    await f.notifier.onRestoreCompleted({ seq: 9, rigId: "rig-1", result: result([node("node-a", "resumed")]) });
    expect(f.sent.length).toBe(30);
    expect(f.logs.filter((l) => l.includes("not delivered (target_needs_input)"))).toHaveLength(1);
    expect(f.logs.filter((l) => l.includes("not delivered within the window"))).toHaveLength(1);
  });

  it("a different refusal reason is logged again", async () => {
    const f = make({ script: [{ ok: false, reason: "not_idle" }, { ok: false, reason: "target_needs_input" }, { ok: false, reason: "target_needs_input" }, { ok: true }] });
    await f.notifier.onRestoreCompleted({ seq: 9, rigId: "rig-1", result: result([node("node-a", "resumed")]) });
    expect(f.logs).toHaveLength(2);
  });
});

describe("delivery and the outbox", () => {
  it("tmux: the row is recorded under the delivery id and settled delivered with the send's label", async () => {
    const f = make({ script: [{ ok: true, verified: true }] });
    await f.notifier.onRestoreCompleted({ seq: 7, rigId: "rig-1", result: result([node("node-a", "resumed")]) });
    const row = f.outbox.getById(postRestartDeliveryId(7, "node-a"));
    expect(row).toMatchObject({ senderSession: "restore@system", destinationSession: "dev-a@rig1", deliveryState: "delivered" });
    expect(f.db.prepare("SELECT delivery_path AS p, ack_evidence AS e FROM outbox_entries WHERE outbox_id = ?").get("post-restart-7-node-a")).toEqual({ p: "tmux", e: "render_verified" });
  });

  it("native: the transport's own row is the record; nothing more is written", async () => {
    const f = make({ script: [{ ok: true, path: "native" }] });
    const out = await f.notifier.onRestoreCompleted({ seq: 7, rigId: "rig-1", result: result([node("node-a", "resumed")]) });
    expect(out[0]).toMatchObject({ outcome: "native_written", attempts: 1 });
    expect(f.outbox.getById("post-restart-7-node-a")).toBeNull(); // the fake transport wrote none
  });

  it("a seat that is busy or at a prompt is not interrupted: the attempt repeats until it moves on, then lands once", async () => {
    const f = make({ script: [{ ok: false, reason: "target_needs_input" }, { ok: false, reason: "not_idle" }, { ok: true, verified: false }] });
    const out = await f.notifier.onRestoreCompleted({ seq: 9, rigId: "rig-1", result: result([node("node-a", "resumed")]) });
    expect(out[0]).toMatchObject({ outcome: "delivered", attempts: 3 });
    expect(f.sleeps).toEqual([20_000, 60_000, 60_000]);
    expect(new Set(f.sent.map((s) => s.deliveryId))).toEqual(new Set(["post-restart-9-node-a"]));
    expect(f.outbox.getById("post-restart-9-node-a")?.deliveryState).toBe("delivered");
  });

  it("held by the typing guard: left as the guard's held row, not retried", async () => {
    const f = make({ script: [{ ok: true, outcome: "retained", reason: "typing_guard_enabled" }] });
    const out = await f.notifier.onRestoreCompleted({ seq: 9, rigId: "rig-1", result: result([node("node-a", "resumed")]) });
    expect(out[0]).toMatchObject({ outcome: "retained", attempts: 1 });
    expect(f.sent).toHaveLength(1);
  });

  it("past the window: recorded failed with the last reason, and not tried again", async () => {
    const f = make({ script: Array.from({ length: 100 }, () => ({ ok: false, reason: "target_needs_input" })) });
    const out = await f.notifier.onRestoreCompleted({ seq: 9, rigId: "rig-1", result: result([node("node-a", "resumed")]) });
    expect(out[0]).toMatchObject({ outcome: "undelivered", detail: "target_needs_input" });
    expect(f.sent.length).toBe(30); // 20 s, then one attempt a minute inside 30 minutes
    expect(f.db.prepare("SELECT delivery_state AS s, ack_detail AS d FROM outbox_entries WHERE outbox_id = 'post-restart-9-node-a'").get())
      .toEqual({ s: "failed", d: "post-restart window closed: target_needs_input" });
  });

  it("no running session for the node within the window: nothing sent, no row", async () => {
    const f = make({ sessions: {} });
    const out = await f.notifier.onRestoreCompleted({ seq: 9, rigId: "rig-1", result: result([node("node-a", "resumed")]) });
    expect(out[0]).toMatchObject({ outcome: "no_session", attempts: 0 });
    expect(f.sent).toHaveLength(0);
    expect(f.outbox.getById("post-restart-9-node-a")).toBeNull();
  });
});

describe("idempotent per restore; an off switch", () => {
  it("the same restore event again sends nothing (the row exists)", async () => {
    const f = make();
    const ev = { seq: 12, rigId: "rig-1", result: result([node("node-a", "resumed")]) };
    await f.notifier.onRestoreCompleted(ev);
    const sleepsBefore = f.sleeps.length;
    const again = await f.notifier.onRestoreCompleted(ev);
    expect(f.sent).toHaveLength(1);
    expect(f.sleeps.length).toBe(sleepsBefore); // settled at once: no first delay for a prompt already sent
    expect(again).toEqual([{ nodeId: "node-a", sessionName: null, outcome: "already_sent", attempts: 0 }]);
  });

  it("the same restore delivered twice at once (a retry while the first still waits): one send", async () => {
    const f = make();
    const ev = { seq: 12, rigId: "rig-1", result: result([node("node-a", "resumed")]) };
    const [a, b] = await Promise.all([f.notifier.onRestoreCompleted(ev), f.notifier.onRestoreCompleted(ev)]);
    expect(f.sent).toHaveLength(1);
    expect([a[0]!.outcome, b[0]!.outcome].sort()).toEqual(["already_sent", "delivered"]);
  });

  it("a later restore of the same seat is a new prompt", async () => {
    const f = make();
    await f.notifier.onRestoreCompleted({ seq: 12, rigId: "rig-1", result: result([node("node-a", "resumed")]) });
    await f.notifier.onRestoreCompleted({ seq: 30, rigId: "rig-1", result: result([node("node-a", "resumed")]) });
    expect(f.sent.map((s) => s.deliveryId)).toEqual(["post-restart-12-node-a", "post-restart-30-node-a"]);
  });

  it("recovery.post_restart_prompt off: nothing is sent", async () => {
    const f = make({ enabled: false });
    expect(await f.notifier.onRestoreCompleted({ seq: 12, rigId: "rig-1", result: result([node("node-a", "resumed")]) })).toEqual([]);
    expect(f.sent).toHaveLength(0);
  });
});
