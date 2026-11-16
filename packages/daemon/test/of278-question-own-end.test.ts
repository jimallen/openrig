// workspaces-o9o.56 (OF-278): a question to the human is answered only by the end of ITS OWN AskUserQuestion call.
//
// Before: any AskUserQuestion PostToolUse settled every open question of the seat, so a late end of an EARLIER question (the relay
// runs PostToolUse in the background) marked a NEWER one answered_human, and the daemon then never auto-answered it.
//
// Measured on Claude Code 2.1.325 (interactive, two AskUserQuestion calls in one turn, a hook dumping stdin): the PermissionRequest that
// opens the dialog carries no tool_use_id, and tool_input.questions is the same on PreToolUse, PermissionRequest and PostToolUse
// (PostToolUse adds `answers`, and `annotations` when a human answered). So a question is tied to its own end by the content of its
// questions. Every hook below is built by the REAL scripts (activity-relay.cjs, question-wait.cjs) and goes through the REAL routes,
// on a 2031 clock far from wall clock.
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { Hono } from "hono";
import { createFullTestDb } from "./helpers/test-app.js";
import { activityRoutes } from "../src/routes/activity.js";
import { SqliteSeatQuestionStore } from "../src/adapters/seat-question-store.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { SeatQuestionService, activityBackedPorts, questionKeyOf, settleQuestionsOnActivity, type SeatQuestionState } from "../src/domain/seat-question-policy.js";

const require = createRequire(import.meta.url);
const relay = require("../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs") as {
  buildOpenRigPayload(p: Record<string, unknown>, env: Record<string, string>, now: () => Date): Record<string, unknown> | null;
  questionKeyOf(toolInput: unknown): string | null;
};
const questionHook = require("../assets/plugins/openrig-core/hooks/scripts/question-wait.cjs") as {
  buildRequest(p: Record<string, unknown>, env: Record<string, string>, requestId: string, askedAtMs: number): Record<string, unknown> | null;
};

const T0 = Date.parse("2031-03-04T10:00:00.000Z");
const MIN = 60_000;
const TOKEN = "hook-token-o9o56";

type Questions = Array<{ question: string; header: string; options: Array<{ label: string; description: string }>; multiSelect: boolean }>;
const ask = (question: string, header: string, recommended: string, other: string): Questions => [{
  question, header, multiSelect: false,
  options: [{ label: `${recommended} (Recommended)`, description: `${recommended} it is` }, { label: other, description: `${other} instead` }],
}];
const COLOUR = ask("Pick a colour", "Colour", "Red", "Blue");
const SIZE = ask("Pick a size", "Size", "Small", "Large");

describe("OF-278 a question is settled only by the end of its own AskUserQuestion call (workspaces-o9o.56)", () => {
  let db: Database.Database;
  let clock: number;
  let app: Hono;
  let questions: SqliteSeatQuestionStore;
  let env: Record<string, string>;
  let nodeId: string;
  const sessionName = "dev-impl@qrig";
  const promptId = "prompt-o9o56-0001";

  /** What Claude Code hands a hook (fields as measured on 2.1.325). */
  const provider = (hookEvent: string, input: Questions | null, extra: Record<string, unknown> = {}) => ({
    hook_event_name: hookEvent, session_id: "claude-session-o9o56", prompt_id: promptId, permission_mode: "auto", cwd: "/work",
    ...(input ? { tool_name: "AskUserQuestion", tool_input: { questions: input, ...(extra.answers ? { answers: extra.answers } : {}) } } : {}),
    ...extra,
  });
  /** The seat's relay posts this hook now, as it would when it runs. */
  async function relayed(p: Record<string, unknown>): Promise<void> {
    const body = relay.buildOpenRigPayload(p, env, () => new Date(clock));
    expect(body, "the relay posts this hook").not.toBeNull();
    const res = await app.request("/api/activity/hooks", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) });
    expect(res.status).toBe(200);
  }
  /** One long-poll of the seat's question-wait hook, under its own request id. */
  async function poll(requestId: string, input: Questions, askedAtMs: number): Promise<{ action: string; why?: string; updatedInput?: Record<string, unknown> }> {
    const body = questionHook.buildRequest(provider("PermissionRequest", input), env, requestId, askedAtMs);
    const res = await app.request("/api/activity/question-wait", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) });
    expect(res.status).toBe(200);
    return await res.json() as { action: string; why?: string };
  }
  /** The dialog opens: Claude fires PermissionRequest (relayed synchronously) and the question-wait hook asks the daemon. */
  async function opens(requestId: string, input: Questions, callId: string) {
    await relayed(provider("PreToolUse", input, { tool_use_id: callId }));
    await relayed(provider("PermissionRequest", input));
    const askedAtMs = clock;
    expect((await poll(requestId, input, askedAtMs)).action).toBe("wait");
    return { requestId, input, askedAtMs, rowId: SeatQuestionService.rowId(nodeId, requestId) };
  }
  /** The call ends: its PostToolUse carries the answers in tool_input, as measured. */
  const ends = (input: Questions, callId: string, answers: Record<string, string>, event = "PostToolUse") =>
    relayed(provider(event, input, { tool_use_id: callId, answers, tool_response: { answers } }));
  const state = (rowId: string): SeatQuestionState | undefined => questions.get(rowId)?.state;

  beforeEach(() => {
    clock = T0;
    db = createFullTestDb();
    const rigs = new RigRepository(db); const sessions = new SessionRegistry(db);
    const rig = rigs.createRig("qrig");
    const node = rigs.addNode(rig.id, "dev.impl", { runtime: "claude-code" }); nodeId = node.id;
    const session = sessions.registerSession(node.id, sessionName); sessions.updateStatus(session.id, "running");
    env = { OPENRIG_SESSION_NAME: sessionName, OPENRIG_RUNTIME: "claude-code", OPENRIG_OCCUPANT_GENERATION: "gen-1" };
    questions = new SqliteSeatQuestionStore(db);
    // The daemon's own wiring (startup.ts): every recorded activity is offered to the question store.
    const activity = new AgentActivityStore({ db, eventBus: new EventBus(db), now: () => new Date(clock), onActivityRecorded: settleQuestionsOnActivity(questions) });
    const service = new SeatQuestionService({
      store: questions, now: () => new Date(clock), sleep: async (ms) => { clock += ms; }, chunkMs: 1_000,
      resolveSeat: (i) => activity.resolveSession(i), ...activityBackedPorts(activity),
      emit: () => {}, tell: async () => {}, howToOverride: (seat) => `rig send ${seat}`,
    });
    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("agentActivityStore" as never, activity as never);
      c.set("activityHookToken" as never, TOKEN as never);
      c.set("seatQuestions" as never, service as never);
      await next();
    });
    app.route("/api/activity", activityRoutes);
  });
  afterEach(() => db.close());

  it("RED: a late end of an earlier question leaves the newer one waiting (it was marked answered_human)", async () => {
    await relayed(provider("UserPromptSubmit", null));
    const a = await opens("req-colour-0001", COLOUR, "toolu_colour_0001");
    clock += MIN;                                         // the human answers A; A's PostToolUse is queued in the background
    const b = await opens("req-size-00001", SIZE, "toolu_size_00001");   // the model asks follow-up B in the same turn
    clock += 2_000;
    await ends(COLOUR, "toolu_colour_0001", { "Pick a colour": "Blue" });   // A's end lands only now
    expect(state(a.rowId)).toBe("answered_human");
    expect(state(b.rowId), "B was answered by nobody").toBe("waiting");
    expect((await poll(b.requestId, SIZE, b.askedAtMs)).action, "B's hook keeps waiting for its answer").toBe("wait");
  });

  it("a question's own end still settles it: answered_human, and the hook gets none", async () => {
    await relayed(provider("UserPromptSubmit", null));
    const b = await opens("req-size-00001", SIZE, "toolu_size_00001");
    clock += MIN;
    await ends(SIZE, "toolu_size_00001", { "Pick a size": "Large" });
    expect(state(b.rowId)).toBe("answered_human");
    expect(await poll(b.requestId, SIZE, b.askedAtMs)).toEqual({ ok: true, action: "none", why: "the question is answered_human" });
  });

  it("a failed end (PostToolUseFailure) of a question settles that question only", async () => {
    await relayed(provider("UserPromptSubmit", null));
    const a = await opens("req-colour-0001", COLOUR, "toolu_colour_0001");
    const b = await opens("req-size-00001", SIZE, "toolu_size_00001");
    await ends(COLOUR, "toolu_colour_0001", {}, "PostToolUseFailure");
    expect([state(a.rowId), state(b.rowId)]).toEqual(["answered_human", "waiting"]);
  });

  it("the same question asked twice: the late end of the first settles the first, not the re-ask", async () => {
    await relayed(provider("UserPromptSubmit", null));
    const first = await opens("req-colour-0001", COLOUR, "toolu_colour_0001");
    clock += MIN;
    const again = await opens("req-colour-0002", COLOUR, "toolu_colour_0002");
    await ends(COLOUR, "toolu_colour_0001", { "Pick a colour": "Blue" });
    expect([state(first.rowId), state(again.rowId)]).toEqual(["answered_human", "waiting"]);
    await ends(COLOUR, "toolu_colour_0002", { "Pick a colour": "Red (Recommended)" });
    expect(state(again.rowId)).toBe("answered_human");
  });

  it("an answer the daemon sent is confirmed by its own call's end, not by an earlier question's late end", async () => {
    await relayed(provider("UserPromptSubmit", null));
    const a = await opens("req-colour-0001", COLOUR, "toolu_colour_0001");
    const b = await opens("req-size-00001", SIZE, "toolu_size_00001");
    expect(questions.claimAutoAnswer(b.rowId, new Date(clock).toISOString(), { "Pick a size": "Small (Recommended)" })).toBe(true);
    await ends(COLOUR, "toolu_colour_0001", { "Pick a colour": "Blue" });
    expect([state(a.rowId), state(b.rowId)]).toEqual(["answered_human", "answered_auto"]);
    await ends(SIZE, "toolu_size_00001", { "Pick a size": "Small (Recommended)" });
    expect(state(b.rowId)).toBe("confirmed_auto");
  });

  it("a question with no safe answer (held) is settled by its own end only", async () => {
    await relayed(provider("UserPromptSubmit", null));
    const noPick: Questions = [{ question: "Which one?", header: "Pick", multiSelect: false, options: [{ label: "This", description: "a" }, { label: "That", description: "b" }] }];
    await relayed(provider("PermissionRequest", noPick));
    expect((await poll("req-held-00001", noPick, clock)).action).toBe("none");
    const held = SeatQuestionService.rowId(nodeId, "req-held-00001");
    expect(state(held)).toBe("held");
    await ends(COLOUR, "toolu_colour_0001", { "Pick a colour": "Blue" });
    expect(state(held)).toBe("held");
    await ends(noPick, "toolu_held_00001", { "Which one?": "That" });
    expect(state(held)).toBe("answered_human");
  });

  it("the end of the turn still settles every open question (Stop abandons what waited)", async () => {
    await relayed(provider("UserPromptSubmit", null));
    const a = await opens("req-colour-0001", COLOUR, "toolu_colour_0001");
    const b = await opens("req-size-00001", SIZE, "toolu_size_00001");
    await relayed(provider("Stop", null));
    expect([state(a.rowId), state(b.rowId)]).toEqual(["abandoned", "abandoned"]);
  });

  it("an end from a relay copy that names no questions (a seat not yet relaunched) keeps the old rule: it settles every open question", async () => {
    await relayed(provider("UserPromptSubmit", null));
    const a = await opens("req-colour-0001", COLOUR, "toolu_colour_0001");
    const b = await opens("req-size-00001", SIZE, "toolu_size_00001");
    // The relay as shipped before this change: hookEvent and subtype only.
    const res = await app.request("/api/activity/hooks", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ sessionName, runtime: "claude-code", generation: "gen-1", hookEvent: "PostToolUse", subtype: "AskUserQuestion", occurredAt: new Date(clock).toISOString() }) });
    expect(res.status).toBe(200);
    expect([state(a.rowId), state(b.rowId)]).toEqual(["answered_human", "answered_human"]);
  });
});

describe("the question digest: the relay's and the daemon's are one function (workspaces-o9o.56)", () => {
  const corpus: unknown[] = [
    { questions: COLOUR }, { questions: SIZE }, { questions: [...COLOUR, ...SIZE] }, { questions: COLOUR, answers: { "Pick a colour": "Blue" } },
    { questions: [{ question: "Ünïcode — “quotes” and \\ backslash\nnewline?", header: "U", multiSelect: true, options: [{ label: "ja (Recommended)", description: "日本" }] }] },
    { questions: [] }, { questions: "not a list" }, {}, null, "text", 7,
  ];
  it("gives the same key on every input, null where there are no questions", () => {
    for (const input of corpus) expect(relay.questionKeyOf(input), JSON.stringify(input)).toBe(questionKeyOf(input));
    expect(corpus.map((i) => questionKeyOf(i) === null)).toEqual([false, false, false, false, false, true, true, true, true, true, true]);
  });
  it("ignores the answers an end adds, and tells different questions apart", () => {
    expect(questionKeyOf({ questions: COLOUR, answers: { "Pick a colour": "Blue" }, annotations: {} })).toBe(questionKeyOf({ questions: COLOUR }));
    expect(questionKeyOf({ questions: COLOUR })).not.toBe(questionKeyOf({ questions: SIZE }));
    expect(questionKeyOf({ questions: COLOUR })).toMatch(/^[0-9a-f]{32}$/);
  });
  it("is sent on an AskUserQuestion end only", () => {
    const env = { OPENRIG_SESSION_NAME: "s@r", OPENRIG_RUNTIME: "claude-code" };
    const at = () => new Date(T0);
    const key = (p: Record<string, unknown>) => relay.buildOpenRigPayload(p, env, at)?.questionKey;
    const input = { questions: COLOUR, answers: { "Pick a colour": "Blue" } };
    expect(key({ hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", tool_input: input })).toBe(questionKeyOf(input));
    expect(key({ hook_event_name: "PostToolUseFailure", tool_name: "AskUserQuestion", tool_input: input })).toBe(questionKeyOf(input));
    expect(key({ hook_event_name: "PermissionRequest", tool_name: "AskUserQuestion", tool_input: input })).toBeUndefined();
    expect(key({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: input })).toBeUndefined();
    expect(key({ hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", tool_input: { questions: [] } })).toBeUndefined();
  });
});
