import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { SqliteSeatQuestionStore as SeatQuestionStore } from "../src/adapters/seat-question-store.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { deriveSeatPosture } from "../src/domain/seat-posture.js";
import { describeHeld, formatHeldAge, HELD_NOTICE_AFTER_MS } from "../src/domain/seat-messaging/held-messages.js";
import { MessageStore } from "../src/domain/seat-messaging/message-store.js";
import { SeatQuestionHealthSource } from "../src/domain/seat-question-health.js";
import { attachAgentActivity } from "../src/domain/node-inventory.js";

// OF-278. A question to the human is named for what it is (question_dialog, not permission_prompt) wherever the seat's state is read,
// and the messages waiting behind it are counted. All clocks are far from the wall clock.
const T0 = Date.parse("2031-03-04T16:04:41.008Z");
const iso = (ms: number) => new Date(ms).toISOString();

describe("the activity store names a question dialog", () => {
  let db: Database.Database; let store: AgentActivityStore; let nodeId: string; let sessionName: string; let now = T0;
  beforeEach(() => {
    db = createFullTestDb();
    const rigRepo = new RigRepository(db); const sessions = new SessionRegistry(db);
    const rig = rigRepo.createRig("qrig"); const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" }); nodeId = node.id;
    sessionName = "dev-impl@qrig"; const s = sessions.registerSession(node.id, sessionName); sessions.updateStatus(s.id, "running");
    now = T0; store = new AgentActivityStore({ db, eventBus: new EventBus(db), now: () => new Date(now) });
  });
  afterEach(() => db.close());
  const hook = (hookEvent: string, subtype: string | null, generation: string | null = "g1", at = now) =>
    store.recordHookEvent({ runtime: "claude-code", sessionName, hookEvent, subtype, occurredAt: iso(at), generation });
  const latest = () => store.getLatestRecorded(nodeId)!;

  it("PermissionRequest for AskUserQuestion is needs_input with reason question_dialog", () => {
    hook("PermissionRequest", "AskUserQuestion");
    expect(latest()).toMatchObject({ state: "needs_input", reason: "question_dialog", dialog: "question", rawEvent: "PermissionRequest", rawSubtype: "AskUserQuestion" });
  });

  it("PermissionRequest for another tool is still a permission request", () => {
    hook("PermissionRequest", "Bash");
    expect(latest()).toMatchObject({ state: "needs_input", reason: "permission_request", rawSubtype: "Bash" });
    expect(latest().dialog).toBeUndefined();
  });

  it("the Notification that follows an open question keeps the reason, its own subtype, and needs_input", () => {
    hook("PermissionRequest", "AskUserQuestion"); now += 6_500;
    hook("Notification", "permission_prompt");
    expect(latest()).toMatchObject({ state: "needs_input", reason: "question_dialog", dialog: "question", rawEvent: "Notification", rawSubtype: "permission_prompt" });
  });

  it.each([
    ["a Notification with no question before it", () => {}],
    ["a Notification after another tool's permission request", () => { hook("PermissionRequest", "Bash"); }],
    ["a Notification after the question was answered", () => { hook("PermissionRequest", "AskUserQuestion"); hook("PostToolUse", "AskUserQuestion"); }],
    ["a Notification after the turn moved on", () => { hook("PermissionRequest", "AskUserQuestion"); hook("Stop", null); }],
    ["a Notification from another occupant generation", () => { hook("PermissionRequest", "AskUserQuestion", "g0"); }],
  ])("%s stays a permission_prompt", (_name, setup) => {
    setup(); now += 6_500;
    hook("Notification", "permission_prompt", "g1");
    expect(latest()).toMatchObject({ state: "needs_input", reason: "permission_prompt" });
    expect(latest().dialog).toBeUndefined();
  });

  it("a question that has waited an hour still reads as one: the stale read keeps the dialog, the recorded read keeps needs_input", () => {
    hook("PermissionRequest", "AskUserQuestion"); hook("Notification", "permission_prompt");
    now = T0 + 66 * 60_000;
    const stale = store.getLatestForNode({ nodeId, sessionName, now: new Date(now) })!;
    expect(stale).toMatchObject({ state: "unknown", reason: "stale_runtime_hook", stale: true, dialog: "question" });
    expect(latest()).toMatchObject({ state: "needs_input", dialog: "question" });
    const posture = deriveSeatPosture(stale, "claude-code", new Date(now));
    expect(posture).toMatchObject({ kind: "needs_input", line: "waiting on a question to the human since 16:04Z" });
  });

  it("the posture of a real permission prompt is unchanged", () => {
    hook("Notification", "permission_prompt");
    const p = deriveSeatPosture(store.getLatestForNode({ nodeId, sessionName, now: new Date(now) })!, "claude-code", new Date(now));
    expect(p.line).toBe("needs input: permission_prompt since 16:04Z");
  });

  it("a PostToolUse after the question is the seat moving on: nothing is recorded as asking", () => {
    hook("PermissionRequest", "AskUserQuestion"); now += 4_000; hook("PostToolUse", "AskUserQuestion");
    expect(latest()).toMatchObject({ state: "running" });
  });
});

describe("describeHeld", () => {
  const accepted = iso(T0);
  it("says nothing for no messages, and for one still in flight", () => {
    expect(describeHeld(null, T0)).toBeNull();
    expect(describeHeld({ open: 0, oldestAcceptedAt: accepted }, T0 + 3_600_000)).toBeNull();
    expect(describeHeld({ open: 3, oldestAcceptedAt: accepted }, T0 + HELD_NOTICE_AFTER_MS - 1)).toBeNull();
  });
  it("counts the messages and ages the oldest from when it was accepted", () => {
    expect(describeHeld({ open: 3, oldestAcceptedAt: accepted }, T0 + HELD_NOTICE_AFTER_MS)).toEqual({ count: 3, oldestAt: accepted, line: "3 held, oldest 1m" });
    expect(describeHeld({ open: 7, oldestAcceptedAt: accepted }, T0 + 381 * 60_000)?.line).toBe("7 held, oldest 6h21m");
  });
  it("reads a SQLite datetime (no zone) as UTC", () => {
    expect(describeHeld({ open: 1, oldestAcceptedAt: "2031-03-04 16:04:41" }, Date.parse("2031-03-04T16:19:41Z"))?.line).toBe("1 held, oldest 15m");
  });
  it("ages in minutes under two hours and hours-and-minutes after", () => {
    expect(formatHeldAge(119 * 60_000)).toBe("119m");
    expect(formatHeldAge(120 * 60_000)).toBe("2h00m");
    expect(formatHeldAge(125 * 60_000)).toBe("2h05m");
  });
});

describe("MessageStore.openFor counts what waits for one seat, oldest by time", () => {
  it("counts only open rows of that seat, and takes the oldest accepted", () => {
    const db = createDb(":memory:"); migrate(db, ALL_MIGRATIONS);
    const insert = (id: string, seat: string, state: string | null, delivery: string, ts: string) => db.prepare(
      "INSERT INTO outbox_entries (outbox_id, sender_session, destination_session, body, delivery_state, ts_dispatched, message_state) VALUES (?, 'a@r', ?, 'b', ?, ?, ?)").run(id, seat, delivery, ts, state);
    insert("m1", "s@r", "attempting", "pending", "2031-03-04T10:00:00.000Z");
    insert("m2", "s@r", "accepted", "pending", "2031-03-04T09:00:00.000Z");
    insert("m3", "s@r", "received", "delivered", "2031-03-04T08:00:00.000Z");
    insert("m4", "other@r", "accepted", "pending", "2031-03-04T07:00:00.000Z");
    insert("m5", "s@r", null, "delivered", "2031-03-04T06:00:00.000Z");
    const store = new MessageStore(db);
    expect(store.openFor("s@r")).toEqual({ open: 2, oldestAcceptedAt: "2031-03-04T09:00:00.000Z" });
    expect(store.openFor("other@r")).toEqual({ open: 1, oldestAcceptedAt: "2031-03-04T07:00:00.000Z" });
    expect(store.openFor("nobody@r")).toBeNull();
    db.close();
  });
});

/** A coverage row of any status carries a `reason`; the union only says so in the notice and unavailable shapes. */
const reasonOf = (c: object): string => ("reason" in c && typeof c.reason === "string" ? c.reason : "");

describe("SeatQuestionHealthSource", () => {
  let db: Database.Database; let store: SeatQuestionStore;
  beforeEach(() => { db = createFullTestDb(); store = new SeatQuestionStore(db); });
  afterEach(() => db.close());
  const ask = (id: string, seat: string, state: "waiting" | "held", askedAtMs: number, note: string | null = null) =>
    store.insert({ id, rigId: "r", nodeId: `n-${seat}`, sessionName: seat, generation: null, state, toolInput: {}, askedAt: iso(askedAtMs), dueAt: state === "waiting" ? iso(askedAtMs + 15 * 60_000) : null, note });
  const source = (nowMs: number, held: (s: string) => ReturnType<typeof describeHeld> = () => null) => new SeatQuestionHealthSource(store, (s) => held(s), () => new Date(nowMs));

  it("names a held question, why it is held, that only the human can answer, and the messages behind it", () => {
    ask("q1", "exec-cos@eztrack", "held", T0, '"Colour?" has no (Recommended) option');
    const rows = source(T0 + 381 * 60_000, () => ({ count: 7, oldestAt: iso(T0), line: "7 held, oldest 6h21m" })).coverage();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "seat-questions", status: "notice" });
    expect(reasonOf(rows[0]!)).toBe('exec-cos@eztrack has asked you a question for 6h21m that cannot take a recommended answer ("Colour?" has no (Recommended) option). Only you can answer it. 7 message(s) wait behind it, oldest 6h21m.');
  });
  it("names a waiting question and when it takes its answer", () => {
    ask("q1", "s@r", "waiting", T0);
    expect(reasonOf(source(T0 + 5 * 60_000).coverage()[0]!)).toBe(`s@r has asked you a question for 5m; it takes its (Recommended) answer at ${iso(T0 + 15 * 60_000)} if nobody answers.`);
  });
  it("says nothing of a question asked a moment ago, or of one already settled", () => {
    ask("q1", "s@r", "waiting", T0);
    ask("q2", "t@r", "waiting", T0 - 3_600_000);
    store.settle("q2", ["waiting"], "answered_human", iso(T0));
    expect(source(T0 + 10_000).coverage()).toEqual([]);
  });
  it("says an answer took only when the seat reported it landed; one sent and not yet seen is said so; one withheld by the queue is said so", () => {
    for (const [id, seat] of [["q1", "s@r"], ["q2", "t@r"], ["q3", "u@r"], ["q4", "v@r"]] as const) ask(id, seat, "waiting", T0 - 3_600_000);
    ask("q5", "w@r", "waiting", T0 - 30 * 3_600_000);
    store.claimAutoAnswer("q1", iso(T0 - 600_000), { Q: "A" }); store.markLogged("q1", iso(T0 - 590_000)); store.markNoted("q1", iso(T0 - 590_000));   // sent
    store.claimAutoAnswer("q2", iso(T0 - 500_000), { Q: "A" }); store.markLogged("q2", iso(T0 - 490_000)); store.markNoted("q2", iso(T0 - 490_000));   // sent, then landed
    store.settleFromActivity("n-t@r", "PostToolUse", "AskUserQuestion", iso(T0 - 400_000));
    store.claimAutoAnswer("q3", iso(T0 - 300_000), { Q: "A" });                                                                                       // taken, the queue never took the note
    store.claimAutoAnswer("q4", iso(T0 - 200_000), { Q: "A" }); store.markNoted("q4", iso(T0 - 190_000));                                             // note filed, event not yet written
    store.claimAutoAnswer("q5", iso(T0 - 29 * 3_600_000), { Q: "A" });                                                                                // older than 24 h
    const text = source(T0).coverage().map(reasonOf);
    expect(text).toEqual([
      "1 unanswered question(s) took their (Recommended) answer in the last 24 h (t@r). Each is on a queue item to human@kernel.",
      "1 answer(s) were sent and the seat has not yet reported them landed (s@r). Each is on a queue item to human@kernel.",
      "2 answer(s) are withheld, because the event or the note to human@kernel could not be written yet (u@r, v@r); the question stays open for the human and the hook is retrying.",
    ]);
  });
});

describe("the rig ps rows carry the held count beside the activity", () => {
  // Production path: the node-inventory route calls attachAgentActivity with the daemon's AgentActivityStore, which startup.ts builds with
  // `heldMessages` reading the MessageStore. Here the same wiring is over a real database.
  function build(withHeld: boolean) {
    const db = createDb(":memory:"); migrate(db, ALL_MIGRATIONS);
    const rigRepo = new RigRepository(db); const sessions = new SessionRegistry(db);
    const rig = rigRepo.createRig("eztrack"); const node = rigRepo.addNode(rig.id, "cos", { role: "worker", runtime: "claude-code" });
    sessions.updateStatus(sessions.registerSession(node.id, "exec-cos@eztrack").id, "running");
    const messages = new MessageStore(db);
    const store = new AgentActivityStore({ db, eventBus: new EventBus(db), ...(withHeld ? { heldMessages: (seat: string, now: Date) => describeHeld(messages.openFor(seat), now.getTime()) } : {}) });
    store.recordHookEvent({ sessionName: "exec-cos@eztrack", runtime: "claude-code", hookEvent: "PermissionRequest", subtype: "AskUserQuestion", occurredAt: iso(T0) });
    const put = (id: string, ts: string) => db.prepare("INSERT INTO outbox_entries (outbox_id, sender_session, destination_session, body, delivery_state, ts_dispatched, message_state) VALUES (?, 'b@eztrack', 'exec-cos@eztrack', 'x', 'pending', ?, 'attempting')").run(id, ts);
    return { db, store, put };
  }
  const entry = [{ canonicalSessionName: "exec-cos@eztrack", runtime: "claude-code", attachmentType: "tmux", logicalId: "exec.cos", sessionStatus: "running" }] as never;

  it("names the waiting messages and their oldest on the seat that waits on a question", async () => {
    const { db, store, put } = build(true);
    put("m1", iso(T0 + 60_000)); put("m2", iso(T0 + 120_000)); put("m3", iso(T0 + 200_000));
    const rows = await attachAgentActivity(entry, { tmuxAdapter: {} as never, activityStore: store, now: new Date(T0 + 381 * 60_000) });
    expect(rows[0]!.heldMessages).toEqual({ count: 3, oldestAt: iso(T0 + 60_000), line: "3 held, oldest 6h20m" });
    expect(rows[0]!.seatPosture).toMatchObject({ kind: "needs_input" });
    expect(rows[0]!.seatPosture!.line).toMatch(/^waiting on a question to the human since /);
    db.close();
  });
  it("leaves the field off a seat with nothing waiting, and off a daemon built without the reader", async () => {
    const quiet = build(true);
    expect((await attachAgentActivity(entry, { tmuxAdapter: {} as never, activityStore: quiet.store, now: new Date(T0 + 3_600_000) }))[0]).not.toHaveProperty("heldMessages");
    const none = build(false); none.put("m1", iso(T0));
    expect((await attachAgentActivity(entry, { tmuxAdapter: {} as never, activityStore: none.store, now: new Date(T0 + 3_600_000) }))[0]).not.toHaveProperty("heldMessages");
    quiet.db.close(); none.db.close();
  });
});
