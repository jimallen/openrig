import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
import { QueueRepository } from "../src/domain/queue-repository.js";
import {
  SeatQuestionService, activityBackedPorts, autoAnswerWaitMs, planAnswer, queueTeller, SeatQuestionRefusal, MAX_AUTO_ANSWER_MINUTES, type SeatQuestionServiceDeps,
  DEFAULT_AUTO_ANSWER_MINUTES, type SeatQuestionReply,
} from "../src/domain/seat-question-policy.js";

// OF-278. An unanswered AskUserQuestion takes its "(Recommended)" answer after the rig's wait; every answer taken is logged and told;
// a question with no safe answer is held. Dates are far from the wall clock on purpose.
const T0 = Date.parse("2031-03-04T10:00:00.000Z");
const MIN = 60_000;

const STAGING = { label: "Staging (Recommended)", description: "safe" };
const PROD = { label: "Production", description: "live" };
const single = (question = "Which target?", options: unknown[] = [STAGING, PROD], multiSelect = false) => ({ questions: [{ question, header: "T", multiSelect, options }] });

describe("planAnswer: what a dialog supports answering", () => {
  it("takes the one (Recommended) option of a single-select question", () => {
    expect(planAnswer(single())).toEqual({ kind: "answer", answers: { "Which target?": "Staging (Recommended)" }, chosen: [{ question: "Which target?", chosen: "Staging (Recommended)" }] });
  });
  it("answers every question of a multi-question dialog when each has exactly one", () => {
    const input = { questions: [single().questions[0], single("Which region?", [{ label: "eu" }, { label: "us (Recommended)" }]).questions[0]] };
    expect(planAnswer(input)).toMatchObject({ kind: "answer", answers: { "Which target?": "Staging (Recommended)", "Which region?": "us (Recommended)" } });
  });
  it.each([["__proto__"], ["constructor"], ["prototype"]])("F1: holds a dialog whose question text is %s, which cannot be a key of the answers map", (text) => {
    expect(planAnswer(single(text))).toMatchObject({ kind: "held", reason: expect.stringContaining(text) });
    expect(planAnswer({ questions: [single("Fine?").questions[0], single(text).questions[0]] }).kind).toBe("held");
  });
  it("F1: the answers it builds are own keys of an object with no prototype, so no question text can name an inherited slot", () => {
    const plan = planAnswer(single("toString"));
    expect(plan.kind).toBe("answer");
    if (plan.kind === "answer") {
      expect(Object.getPrototypeOf(plan.answers)).toBeNull();
      expect(Object.keys(plan.answers)).toEqual(["toString"]);
      expect(JSON.stringify(plan.answers)).toBe('{"toString":"Staging (Recommended)"}');
    }
  });
  it.each([
    ["no option is recommended", single("Q?", [{ label: "Red" }, { label: "Blue" }])],
    ["two options are recommended", single("Q?", [{ label: "A (Recommended)" }, { label: "B (Recommended)" }])],
    ["the question allows several answers", single("Q?", [STAGING, PROD], true)],
    ["one question of two has none", { questions: [single().questions[0], single("Other?", [{ label: "x" }, { label: "y" }]).questions[0]] }],
    ["two questions share their text", { questions: [single("Same?").questions[0], single("Same?").questions[0]] }],
    ["an option has no label", single("Q?", [{ description: "x" }, STAGING])],
    ["there are no questions", { questions: [] }],
    ["the input is not a dialog", "nonsense"],
    ["the input is null", null],
  ])("holds the whole dialog when %s", (_why, input) => {
    expect(planAnswer(input).kind).toBe("held");
  });
});

describe("autoAnswerWaitMs", () => {
  it("is 15 min when the rig names nothing, the named wait otherwise, and 0 when off", () => {
    expect(DEFAULT_AUTO_ANSWER_MINUTES).toBe(15);
    expect(autoAnswerWaitMs(null)).toBe(15 * MIN);
    expect(autoAnswerWaitMs(undefined)).toBe(15 * MIN);
    expect(autoAnswerWaitMs(7)).toBe(7 * MIN);
    expect(autoAnswerWaitMs(0)).toBe(0);
  });
});

describe("SeatQuestionService", () => {
  let db: Database.Database;
  let rigId: string; let nodeId: string; let sessionName: string;
  let clock: number;
  let events: unknown[]; let told: Array<{ qitemId: string; seat: string; body: string; summary: string }>;
  let activity: AgentActivityStore; let store: SeatQuestionStore;

  const asked = (over: Record<string, unknown> = {}) => ({ requestId: "req-aaaaaaaa", sessionName, nodeId, generation: "gen-1", toolInput: single(), askedAtMs: T0, ...over });
  const build = (chunkMs = 5 * MIN, over: Partial<SeatQuestionServiceDeps> = {}) => new SeatQuestionService({
    store, now: () => new Date(clock), sleep: async (ms) => { clock += ms; },
    resolveSeat: (i) => activity.resolveSession(i), ...activityBackedPorts(activity),
    emit: (e) => { events.push(e); },
    tell: async (n) => { told.push(n); },
    howToOverride: (seat) => `rig send ${seat} "<answer>"`, chunkMs, ...over,
  });
  /** What the seat's own hooks do: the relay records PermissionRequest at the moment the dialog opens. */
  const dialogOpens = (at = clock) => activity.recordHookEvent({ runtime: "claude-code", sessionName, hookEvent: "PermissionRequest", subtype: "AskUserQuestion", occurredAt: new Date(at).toISOString(), generation: "gen-1" });
  const seatSays = (hookEvent: string, subtype?: string) => activity.recordHookEvent({ runtime: "claude-code", sessionName, hookEvent, subtype: subtype ?? null, occurredAt: new Date(clock).toISOString(), generation: "gen-1" });
  /** Asks the way the hook does, again after each `wait`, until the daemon says something else. */
  async function askUntilSettled(svc: SeatQuestionService, req = asked()): Promise<SeatQuestionReply> {
    for (let i = 0; i < 100; i++) { const r = await svc.wait(req); if (r.action !== "wait") return r; }
    throw new Error("never settled");
  }

  beforeEach(() => {
    clock = T0;
    db = createFullTestDb();
    const rigRepo = new RigRepository(db); const sessions = new SessionRegistry(db);
    const rig = rigRepo.createRig("qrig"); rigId = rig.id;
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" }); nodeId = node.id;
    sessionName = "dev-impl@qrig";
    const session = sessions.registerSession(node.id, sessionName); sessions.updateStatus(session.id, "running");
    events = []; told = [];
    store = new SeatQuestionStore(db);
    activity = new AgentActivityStore({ db, eventBus: new EventBus(db), now: () => new Date(clock), onActivityRecorded: (a, s) => { store.settleFromActivity(s.nodeId, a.rawEvent ?? null, a.rawSubtype ?? null, a.eventAt ?? new Date(clock).toISOString()); } });
  });
  afterEach(() => db.close());

  it("takes the recommended answer at the end of the default wait, logs it once and tells the human once", async () => {
    dialogOpens();
    const reply = await askUntilSettled(build());
    expect(reply).toEqual({ action: "answer", updatedInput: { ...single(), answers: { "Which target?": "Staging (Recommended)" } } });
    expect(clock - T0).toBe(15 * MIN);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "seat.question_auto_answered", sessionName, rigId, nodeId, askedAt: new Date(T0).toISOString(), takenAt: new Date(T0 + 15 * MIN).toISOString(),
      waitedMs: 15 * MIN, waitConfiguredMs: 15 * MIN, questions: [{ question: "Which target?", chosen: "Staging (Recommended)" }],
    });
    expect(told).toHaveLength(1);
    expect(told[0]!.body).toContain("dev-impl@qrig");
    expect(told[0]!.body).toContain("Which target? -> Staging (Recommended)");
    expect(told[0]!.body).toContain(new Date(T0 + 15 * MIN).toISOString());
    expect(told[0]!.body).toContain('rig send dev-impl@qrig "<answer>"');
  });

  it("counts the wait from the rig's own setting, not the default", async () => {
    db.prepare("UPDATE rigs SET question_auto_answer_minutes = 4 WHERE id = ?").run(rigId);
    dialogOpens();
    await askUntilSettled(build());
    expect(clock - T0).toBe(4 * MIN);
    expect(events[0]).toMatchObject({ waitConfiguredMs: 4 * MIN });
  });

  it("sends nothing when the rig turned the wait off", async () => {
    db.prepare("UPDATE rigs SET question_auto_answer_minutes = 0 WHERE id = ?").run(rigId);
    dialogOpens();
    expect(await build().wait(asked())).toEqual({ action: "none", why: "this rig does not auto-answer" });
    expect(events).toEqual([]); expect(told).toEqual([]);
  });

  it("does not answer a question the human answered first (the seat's PostToolUse arrived)", async () => {
    dialogOpens();
    const svc = build();
    expect((await svc.wait(asked())).action).toBe("wait");
    clock += 3 * MIN; seatSays("PostToolUse", "AskUserQuestion");
    expect(await svc.wait(asked())).toEqual({ action: "none", why: "the question is answered_human" });
    clock += 10 * MIN;
    expect((await svc.wait(asked())).action).toBe("none");
    expect(events).toEqual([]); expect(told).toEqual([]);
  });

  it("holds a question with no (Recommended) option: no answer, one held event, surfaced, never guessed", async () => {
    dialogOpens();
    const svc = build();
    const req = asked({ toolInput: single("Colour?", [{ label: "Red" }, { label: "Blue" }]) });
    expect(await svc.wait(req)).toMatchObject({ action: "none" });
    expect(await svc.wait(req)).toMatchObject({ action: "none" });  // asking again changes nothing
    clock += 10 * MIN;
    expect(await svc.wait(req)).toMatchObject({ action: "none" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "seat.question_held", sessionName, reason: expect.stringContaining("no (Recommended) option") });
    expect(told).toEqual([]);
    expect(store.openUnanswered().map((q) => q.state)).toEqual(["held"]);
  });

  it("holds a multiSelect question and a multi-question dialog where one question has no recommendation", async () => {
    dialogOpens();
    const svc = build();
    expect((await svc.wait(asked({ requestId: "req-multi-001", toolInput: single("Q?", [STAGING, PROD], true) }))).action).toBe("none");
    const mixed = { questions: [single().questions[0], single("Other?", [{ label: "x" }, { label: "y" }]).questions[0]] };
    expect((await svc.wait(asked({ requestId: "req-mixed-001", toolInput: mixed }))).action).toBe("none");
    expect(events.map((e) => (e as { type: string }).type)).toEqual(["seat.question_held", "seat.question_held"]);
  });

  it("answers a multi-question dialog with one answer per question", async () => {
    dialogOpens();
    const input = { questions: [single().questions[0], single("Which region?", [{ label: "eu" }, { label: "us (Recommended)" }]).questions[0]] };
    const reply = await askUntilSettled(build(), asked({ toolInput: input }));
    expect(reply).toMatchObject({ action: "answer", updatedInput: { answers: { "Which target?": "Staging (Recommended)", "Which region?": "us (Recommended)" } } });
    expect((events[0] as { questions: unknown[] }).questions).toHaveLength(2);
  });

  it("does not restart the wait when the daemon restarts: the due time is the original one", async () => {
    dialogOpens();
    expect((await build().wait(asked())).action).toBe("wait");   // first daemon: the hook's poll is open, then the daemon goes away
    clock = T0 + 12 * MIN;                                        // 12 min since the question, no daemon: the hook retries, the dialog stays open
    const second = build();                                       // the restarted daemon: a new service over the same database
    const reply = await askUntilSettled(second);
    expect(reply.action).toBe("answer");
    expect(clock - T0).toBe(15 * MIN);                            // 15 min after the question, not 12 + 15
    expect(events).toHaveLength(1);
  });

  it("counts the wait from when the dialog opened, even when the daemon first hears of it late (it was down when the hook first ran)", async () => {
    clock = T0 + 12 * MIN;                       // the daemon comes back 12 min into the wait; the hook's own clock says the dialog opened at T0
    dialogOpens(T0);
    const reply = await askUntilSettled(build());
    expect(reply.action).toBe("answer");
    expect(clock - T0).toBe(15 * MIN);           // 3 more minutes, not 15
    expect(events[0]).toMatchObject({ askedAt: new Date(T0).toISOString(), waitedMs: 15 * MIN });
  });

  it("does not double-answer after a restart: the hook that reconnects after the answer was sent gets the same answer, logged and told once", async () => {
    dialogOpens();
    const first = build();
    const a = await askUntilSettled(first);
    expect(a.action).toBe("answer");
    // the reply never reached the hook (the daemon restarted); the hook reconnects under its request id, and the next PermissionRequest of the
    // same seat is another request
    const restarted = build();
    expect(await restarted.wait(asked())).toEqual(a);
    expect(await restarted.wait(asked())).toEqual(a);
    expect(events).toHaveLength(1);
    expect(told).toHaveLength(1);
    expect(db.prepare("SELECT count(*) AS n FROM seat_questions WHERE state = 'answered_auto'").get()).toEqual({ n: 1 });
  });

  it("a daemon that stops after taking the answer and before writing it down writes it when the hook asks again, once", async () => {
    dialogOpens();
    let stopped = true;
    const dying = build(5 * MIN, { emit: (e) => { if (stopped) throw new Error("daemon stopped"); events.push(e); } });
    await expect(askUntilSettled(dying)).rejects.toThrow("daemon stopped");
    expect(events).toEqual([]); expect(told).toEqual([]);
    expect(db.prepare("SELECT state, logged_at FROM seat_questions").get()).toEqual({ state: "answered_auto", logged_at: null });
    stopped = false;
    const reply = await build().wait(asked());                       // the hook asks again; the restarted daemon finds the answer taken and unwritten
    expect(reply).toMatchObject({ action: "answer", updatedInput: { answers: { "Which target?": "Staging (Recommended)" } } });
    expect(events).toHaveLength(1); expect(told).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "seat.question_auto_answered", takenAt: new Date(T0 + 15 * MIN).toISOString(), waitedMs: 15 * MIN });
    await build().wait(asked()); await build().wait(asked());
    expect(events).toHaveLength(1); expect(told).toHaveLength(1);    // written, so not written again
    expect(db.prepare("SELECT logged_at IS NOT NULL AS logged FROM seat_questions").get()).toEqual({ logged: 1 });
  });

  it("two polls racing at the due time answer once", async () => {
    dialogOpens();
    const svc = build();
    expect((await svc.wait(asked())).action).toBe("wait");
    clock = T0 + 15 * MIN;
    const [a, b] = await Promise.all([svc.wait(asked()), svc.wait(asked())]);
    expect([a.action, b.action].sort()).toEqual(["answer", "answer"]);  // the second is the same answer sent again, not a second claim
    expect(events).toHaveLength(1);
    expect(told).toHaveLength(1);
  });

  it("a hook that returns after the human answered, once the daemon is back, answers nothing and logs nothing", async () => {
    dialogOpens();
    const first = build();
    expect((await first.wait(asked())).action).toBe("wait");
    seatSays("PostToolUse", "AskUserQuestion");                   // the human answered (and the seat went on)
    seatSays("Stop");
    clock += 20 * MIN;
    const reply = await build().wait(asked());
    expect(reply.action).toBe("none");
    expect(events).toEqual([]); expect(told).toEqual([]);
  });

  it("never answers a dialog the seat has moved on from, even when the daemon missed the PostToolUse", async () => {
    dialogOpens();
    const svc = build();
    expect((await svc.wait(asked())).action).toBe("wait");
    // the daemon was down: the seat's answer and everything after it were never ingested, but a later hook (the next turn) is
    clock = T0 + 14 * MIN; seatSays("UserPromptSubmit");
    db.prepare("UPDATE seat_questions SET state = 'waiting'").run();  // as if the settle from that hook had been lost too
    clock = T0 + 16 * MIN;
    expect((await svc.wait(asked())).action).toBe("none");
    expect(events).toEqual([]); expect(told).toEqual([]);
    expect(db.prepare("SELECT state FROM seat_questions").get()).toEqual({ state: "abandoned" });
  });

  it("puts the dialog on record when the daemon never saw it open", async () => {
    // no dialogOpens(): the relay's post was lost while the daemon was down
    const svc = build();
    expect((await svc.wait(asked())).action).toBe("wait");
    expect(activity.getLatestRecorded(nodeId)).toMatchObject({ state: "needs_input", reason: "question_dialog", dialog: "question", rawEvent: "PermissionRequest" });
  });

  it("a request id is the row: another seat's hook cannot ask for this seat's row", async () => {
    dialogOpens();
    const svc = build();
    await svc.wait(asked());
    const other = new RigRepository(db).addNode(rigId, "dev.qa", { runtime: "claude-code" });
    const s2 = new SessionRegistry(db).registerSession(other.id, "dev-qa@qrig"); new SessionRegistry(db).updateStatus(s2.id, "running");
    expect(SeatQuestionService.rowId(other.id, "req-aaaaaaaa")).not.toBe(SeatQuestionService.rowId(nodeId, "req-aaaaaaaa"));
  });

  it("answers nothing for a seat that is not a managed Claude seat", async () => {
    expect(await build().wait(asked({ sessionName: "nobody@qrig", nodeId: null }))).toEqual({ action: "none", why: "not a managed Claude seat" });
    const rigRepo = new RigRepository(db);
    const codex = rigRepo.addNode(rigId, "dev.cx", { runtime: "codex" });
    const sess = new SessionRegistry(db).registerSession(codex.id, "dev-cx@qrig"); new SessionRegistry(db).updateStatus(sess.id, "running");
    expect(await build().wait(asked({ sessionName: "dev-cx@qrig", nodeId: codex.id }))).toEqual({ action: "none", why: "not a managed Claude seat" });
  });

  // ---- review of 1bdf959d (Security Engineer): F2, F3, F4 and the survivors M9, M15, M16, M17
  it("F3: a note that fails is retried on the hook's next ask; the answer is sent once the note is filed; one event, one note", async () => {
    dialogOpens();
    let queueUp = false; const filed: string[] = [];
    const svc = build(5 * MIN, { tell: async (n) => { if (!queueUp) throw new Error("queue down"); filed.push(n.qitemId); } });
    await expect(askUntilSettled(svc)).rejects.toThrow("queue down");
    expect(events).toHaveLength(1);                                    // the event is written first and stays
    expect(db.prepare("SELECT state, logged_at IS NOT NULL AS l, noted_at IS NOT NULL AS n FROM seat_questions").get()).toEqual({ state: "answered_auto", l: 1, n: 0 });
    await expect(svc.wait(asked())).rejects.toThrow("queue down");     // the queue is still down: still no answer, no second event
    expect(events).toHaveLength(1);
    queueUp = true;
    const reply = await svc.wait(asked());
    expect(reply).toMatchObject({ action: "answer", updatedInput: { answers: { "Which target?": "Staging (Recommended)" } } });
    expect(events).toHaveLength(1); expect(filed).toHaveLength(1);
    await svc.wait(asked()); await build().wait(asked());
    expect(events).toHaveLength(1); expect(filed).toHaveLength(1);     // filed, so not filed again
    expect(db.prepare("SELECT noted_at IS NOT NULL AS n FROM seat_questions").get()).toEqual({ n: 1 });
  });

  it("F2: a rig that turned the policy off while a question waited answers nothing: the question is held and named", async () => {
    dialogOpens();
    const svc = build();
    expect((await svc.wait(asked())).action).toBe("wait");
    db.prepare("UPDATE rigs SET question_auto_answer_minutes = 0 WHERE id = ?").run(rigId);
    const reply = await askUntilSettled(svc);
    expect(reply.action).toBe("none");
    expect(clock - T0).toBeGreaterThanOrEqual(15 * MIN - 1);          // it waited out the original time before deciding
    expect(events.map((e) => (e as { type: string }).type)).toEqual(["seat.question_held"]);
    expect(events[0]).toMatchObject({ reason: expect.stringContaining("auto-answer off") });
    expect(told).toEqual([]);
    expect(store.get(SeatQuestionService.rowId(nodeId, "req-aaaaaaaa"))).toMatchObject({ state: "held" });
    expect((await build().wait(asked())).action).toBe("none");        // and a later ask changes nothing
    expect(events).toHaveLength(1);
  });

  it("F2: turning the policy off before the wait ends is judged at the end of it, not at every poll (a rig turned on again in time still answers)", async () => {
    dialogOpens();
    const svc = build();
    expect((await svc.wait(asked())).action).toBe("wait");
    db.prepare("UPDATE rigs SET question_auto_answer_minutes = 0 WHERE id = ?").run(rigId);
    expect((await svc.wait(asked())).action).toBe("wait");              // a poll while it is off: the wait is not over, so nothing is decided
    db.prepare("UPDATE rigs SET question_auto_answer_minutes = 15 WHERE id = ?").run(rigId);
    expect((await askUntilSettled(svc)).action).toBe("answer");
  });

  describe("F4: what a caller with the hook token can ask for", () => {
    const refusal = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);
    it.each([[0], [-1], [-86_400_000]])("refuses askedAtMs %d", async (askedAtMs) => {
      const err = await refusal(build().wait(asked({ askedAtMs })));
      expect(err).toBeInstanceOf(SeatQuestionRefusal);
      expect(err).toMatchObject({ status: 400, code: "invalid_question_request" });
      expect(db.prepare("SELECT count(*) AS n FROM seat_questions").get()).toEqual({ n: 0 });
    });
    it("refuses a start older than the longest wait plus the margin, and takes one exactly at the edge", async () => {
      const edge = (MAX_AUTO_ANSWER_MINUTES + 5) * MIN;
      dialogOpens();
      expect(await refusal(build().wait(asked({ askedAtMs: T0 - edge - 1 })))).toMatchObject({ status: 400, code: "invalid_question_request" });
      expect((await build().wait(asked({ askedAtMs: T0 - edge }))).action).not.toBe(undefined);
    });
    it("a start in the future counts from now (M9: the clamp)", async () => {
      dialogOpens();
      const reply = await askUntilSettled(build(), asked({ askedAtMs: T0 + 60 * MIN }));
      expect(reply.action).toBe("answer");
      expect(clock - T0).toBe(15 * MIN);
    });
    it("caps the held polls per seat and in all, refusing above the cap with a 429, and counts a poll out when it ends", async () => {
      const other = new RigRepository(db).addNode(rigId, "dev.qa", { runtime: "claude-code" });
      const sess = new SessionRegistry(db); sess.updateStatus(sess.registerSession(other.id, "dev-qa@qrig").id, "running");
      activity.recordHookEvent({ runtime: "claude-code", sessionName: "dev-qa@qrig", hookEvent: "PermissionRequest", subtype: "AskUserQuestion", occurredAt: new Date(clock).toISOString(), generation: "gen-1" });
      dialogOpens();
      const releases: Array<() => void> = []; let open = true;
      const svc = build(5 * MIN, { maxWaitsPerSeat: 2, maxWaitsTotal: 3, sleep: async (ms) => { if (open) await new Promise<void>((r) => releases.push(r)); clock += ms; } });
      const a1 = svc.wait(asked({ requestId: "req-00000001" })); const a2 = svc.wait(asked({ requestId: "req-00000002" }));
      expect(await refusal(svc.wait(asked({ requestId: "req-00000003" })))).toMatchObject({ status: 429, code: "too_many_question_waits" });     // per seat
      const b1 = svc.wait(asked({ requestId: "req-00000004", sessionName: "dev-qa@qrig", nodeId: other.id }));
      expect(await refusal(svc.wait(asked({ requestId: "req-00000005", sessionName: "dev-qa@qrig", nodeId: other.id })))).toMatchObject({ status: 429, code: "too_many_question_waits" });  // in all
      open = false; releases.splice(0).forEach((r) => r());
      await Promise.all([a1, a2, b1]);
      expect((await svc.wait(asked({ requestId: "req-00000006" }))).action).not.toBe(undefined);   // the polls ended: room again
    });
  });

  it("M16: a question dialog of another occupant generation is not this question: it is not answered", async () => {
    dialogOpens();
    const svc = build();
    expect((await svc.wait(asked())).action).toBe("wait");
    activity.recordHookEvent({ runtime: "claude-code", sessionName, hookEvent: "PermissionRequest", subtype: "AskUserQuestion", occurredAt: new Date(clock + 1000).toISOString(), generation: "gen-2" });
    const reply = await askUntilSettled(svc);
    expect(reply.action).toBe("none");
    expect(events).toEqual([]); expect(told).toEqual([]);
    expect(store.get(SeatQuestionService.rowId(nodeId, "req-aaaaaaaa"))).toMatchObject({ state: "abandoned" });
  });

  it("M17: a seat now waiting on something that is not a question (a permission prompt) is not answered as if it were one", async () => {
    dialogOpens();
    const svc = build();
    expect((await svc.wait(asked())).action).toBe("wait");
    activity.recordHookEvent({ runtime: "claude-code", sessionName, hookEvent: "PermissionRequest", subtype: "Bash", occurredAt: new Date(clock + 1000).toISOString(), generation: "gen-1" });
    expect((await askUntilSettled(svc)).action).toBe("none");
    expect(events).toEqual([]); expect(told).toEqual([]);
    expect(store.get(SeatQuestionService.rowId(nodeId, "req-aaaaaaaa"))).toMatchObject({ state: "abandoned" });
  });

  it("M15: a stored wait longer than the longest is capped at the service, not only by the spec validator", async () => {
    expect(MAX_AUTO_ANSWER_MINUTES).toBe(20);
    expect(autoAnswerWaitMs(600)).toBe(20 * MIN);
    db.prepare("UPDATE rigs SET question_auto_answer_minutes = 600 WHERE id = ?").run(rigId);
    dialogOpens();
    expect((await askUntilSettled(build())).action).toBe("answer");
    expect(clock - T0).toBe(20 * MIN);
  });
});

describe("SeatQuestionStore.settleFromActivity", () => {
  let db: Database.Database; let store: SeatQuestionStore;
  const row = (id: string, state: "waiting" | "held") => store.insert({ id, rigId: "r", nodeId: "n1", sessionName: "s@r", generation: null, state, toolInput: {}, askedAt: "2031-03-04T10:00:00.000Z", dueAt: null, note: null });
  beforeEach(() => { db = createFullTestDb(); store = new SeatQuestionStore(db); });
  afterEach(() => db.close());

  it.each([
    ["PostToolUse", "AskUserQuestion", "answered_human"],
    ["PostToolUseFailure", "AskUserQuestion", "answered_human"],
    ["Stop", null, "abandoned"],
    ["SessionEnd", null, "abandoned"],
    ["UserPromptSubmit", null, "abandoned"],
  ])("%s %s settles a waiting question as %s", (event, subtype, state) => {
    row("q1", "waiting");
    expect(store.settleFromActivity("n1", event, subtype, "2031-03-04T10:01:00.000Z")).toBe(1);
    expect(store.get("q1")?.state).toBe(state);
  });
  it.each([["PostToolUse", "Bash"], ["PreToolUse", "AskUserQuestion"], ["Notification", "permission_prompt"], ["PermissionRequest", "AskUserQuestion"]])("%s %s settles nothing", (event, subtype) => {
    row("q1", "waiting");
    expect(store.settleFromActivity("n1", event, subtype, "2031-03-04T10:01:00.000Z")).toBe(0);
    expect(store.get("q1")?.state).toBe("waiting");
  });
  it("settles only the seat's own questions, and a held one too", () => {
    row("q1", "held");
    expect(store.settleFromActivity("another-node", "Stop", null, "2031-03-04T10:01:00.000Z")).toBe(0);
    expect(store.settleFromActivity("n1", "PostToolUse", "AskUserQuestion", "2031-03-04T10:01:00.000Z")).toBe(1);
    expect(store.get("q1")?.state).toBe("answered_human");
  });
  it("an answer the daemon sent is confirmed, never credited to the human", () => {
    row("q1", "waiting");
    expect(store.claimAutoAnswer("q1", "2031-03-04T10:02:00.000Z", { Q: "A" })).toBe(true);
    expect(store.claimAutoAnswer("q1", "2031-03-04T10:02:01.000Z", { Q: "B" })).toBe(false);
    store.settleFromActivity("n1", "PostToolUse", "AskUserQuestion", "2031-03-04T10:03:00.000Z");
    expect(store.get("q1")).toMatchObject({ state: "confirmed_auto", answers: { Q: "A" } });
  });
});

describe("the note to the human, over the real queue", () => {
  // The queue refuses a human-routed item with no summary or no evidence ref; a fake `tell` cannot see that. This is the daemon's own wiring.
  let db: Database.Database; let queue: QueueRepository;
  beforeEach(() => {
    db = createDb(":memory:"); migrate(db, ALL_MIGRATIONS);   // every migration: the summary column is one the test helper's subset lacks
    db.prepare("INSERT INTO rigs(id,name) VALUES ('fixture-rig','r')").run();
    db.prepare("INSERT INTO nodes(id,rig_id,logical_id,runtime,profile) VALUES ('fixture-node','fixture-rig','worker','codex','none')").run();
    queue = new QueueRepository(db, new EventBus(db), { validateRig: () => true, loadHumanRegistry: () => ({ ok: true, entities: [] }) });
  });
  afterEach(() => db.close());
  const note = { qitemId: "qa-0123456789abcdef", seat: "dev-impl@qrig", summary: "dev-impl@qrig: unanswered question took its recommended answer", body: "dev-impl@qrig asked a question ..." };

  it("files one item from daemon@kernel to human@kernel, with the body as told", async () => {
    await queueTeller(queue)(note);
    expect(queue.getById(note.qitemId)).toMatchObject({ sourceSession: "daemon@kernel", destinationSession: "human@kernel", body: note.body, summary: note.summary, state: "pending" });
    expect(queue.getById(note.qitemId)!.tags).toContain("seat-question:auto-answered");
    expect(queue.getById(note.qitemId)!.evidenceRef).toContain(note.qitemId);
  });
  it("filing the same note again is the same item, not a second", async () => {
    await queueTeller(queue)(note); await queueTeller(queue)(note);
    expect(db.prepare("SELECT count(*) AS n FROM queue_items WHERE qitem_id = ?").get(note.qitemId)).toEqual({ n: 1 });
  });
});
