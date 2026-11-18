// workspaces-o9o.124: in Code Mode, Claude Code follows every code evaluation with a UserPromptSubmit whose `source` is "poll_event" and whose
// prompt is the evaluation's output (`<event kind="repl-eval" ...>`), foreground code included (measured by build-arch, o9o.122 report M10,
// Claude Code 2.1.327). Nobody typed it. Read as a prompt it closes the turn mid-turn, abandons an open AskUserQuestion row (cancelling the
// 15-minute auto-answer) and marks the seat's input point passed. The relay does not forward it, and the daemon does not record it.
// The payloads are the captured ones (test/fixtures/code-mode-user-prompt-submit.json).
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import nodePath from "node:path";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { CODE_OUTPUT_PROMPT_SOURCE } from "../src/domain/code-mode-output.js";
import { SqliteSeatQuestionStore } from "../src/adapters/seat-question-store.js";
import { settleQuestionsOnActivity } from "../src/domain/seat-question-policy.js";
import { seatInputPoint } from "../src/domain/seat-messaging/input-point.js";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";

const require = createRequire(import.meta.url);
const relay = require("../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs") as {
  CODE_OUTPUT_PROMPT_SOURCE: string;
  buildOpenRigPayload: (provider: Record<string, unknown>, env: Record<string, string>, now?: () => Date) => { hookEvent: string; subtype: string | null } | null;
};
const captured = JSON.parse(readFileSync(nodePath.join(import.meta.dirname, "fixtures", "code-mode-user-prompt-submit.json"), "utf8")) as {
  codeOutput: Record<string, unknown>;
  typedPrompt: Record<string, unknown>;
};
const ENV = { OPENRIG_SESSION_NAME: "dev-impl@r", OPENRIG_RUNTIME: "claude-code" };

describe("the relay does not forward Code Mode's code output as a prompt", () => {
  it("the captured poll_event UserPromptSubmit is not relayed", () => {
    expect(captured.codeOutput.source).toBe("poll_event");
    expect(relay.buildOpenRigPayload(captured.codeOutput, ENV)).toBeNull();
  });

  it("control: the captured typed prompt (no source) is relayed as UserPromptSubmit", () => {
    expect(captured.typedPrompt.source).toBeUndefined();
    expect(relay.buildOpenRigPayload(captured.typedPrompt, ENV)?.hookEvent).toBe("UserPromptSubmit");
  });
});

describe("one name for Code Mode's code-output source", () => {
  it("the relay's twin equals the daemon's CODE_OUTPUT_PROMPT_SOURCE, which is the captured source", () => {
    expect(relay.CODE_OUTPUT_PROMPT_SOURCE).toBe(CODE_OUTPUT_PROMPT_SOURCE);
    expect(captured.codeOutput.source).toBe(CODE_OUTPUT_PROMPT_SOURCE);
  });
});

describe("the hooks route answers an older relay's code output as ignored, not as an unknown seat", () => {
  it("POST /api/activity/hooks with UserPromptSubmit/poll_event is 200 {ok: true, ignored: \"code_output\"} and records nothing", async () => {
    const db = createFullTestDb();
    const { activityRoutes } = await import("../src/routes/activity.js");
    const { Hono } = await import("hono");
    const store = new AgentActivityStore({ db, eventBus: new EventBus(db) });
    const hookToken = "hook-token-" + "o9o124";
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("agentActivityStore" as never, store as never);
      c.set("activityHookToken" as never, hookToken as never);
      await next();
    });
    app.route("/api/activity", activityRoutes);
    const res = await app.request("/api/activity/hooks", { method: "POST", headers: { "content-type": "application/json", "x-openrig-activity-token": hookToken },
      body: JSON.stringify({ runtime: "claude-code", sessionName: "dev-impl@r", hookEvent: "UserPromptSubmit", subtype: "poll_event" }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: "code_output" });
    expect((db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'agent.activity'").get() as { n: number }).n).toBe(0);
    db.close();
  });
});

describe("the daemon does not read Code Mode's code output as a prompt (an older relay copy still forwards it)", () => {
  const T0 = "2026-11-18T09:00:00.000Z";
  const setup = () => {
    const db = createFullTestDb();
    const rig = new RigRepository(db).createRig("r");
    const node = new RigRepository(db).addNode(rig.id, "dev.impl", { runtime: "claude-code" });
    const reg = new SessionRegistry(db);
    reg.updateStatus(reg.registerSession(node.id, "dev-impl@r").id, "running");
    const questions = new SqliteSeatQuestionStore(db);
    const store = new AgentActivityStore({
      db, eventBus: new EventBus(db), now: () => new Date("2026-11-18T09:00:10.000Z"), onActivityRecorded: settleQuestionsOnActivity(questions),
    });
    // The seat is mid-turn: its REPL call is running, and it has a question open.
    store.recordHookEvent({ runtime: "claude-code", sessionName: "dev-impl@r", hookEvent: "PreToolUse", subtype: "REPL", toolCallId: "toolu_repl", occurredAt: T0 });
    questions.insert({ id: "q1", rigId: rig.id, nodeId: node.id, sessionName: "dev-impl@r", generation: null, state: "waiting",
      toolInput: { questions: [{ question: "Which one?" }] }, askedAt: T0, dueAt: null, note: null });
    return { db, store, questions, nodeId: node.id };
  };
  // What the relay at release-6 744ee7692 posts for the captured code output (its source becomes the subtype), as a seat still running an
  // older relay copy would post it.
  const pollEvent = { runtime: "claude-code", sessionName: "dev-impl@r", hookEvent: "UserPromptSubmit", subtype: "poll_event", occurredAt: "2026-11-18T09:00:05.000Z" };
  const typed = { runtime: "claude-code", sessionName: "dev-impl@r", hookEvent: "UserPromptSubmit", subtype: null, occurredAt: "2026-11-18T09:00:05.000Z" };

  it("a poll_event UserPromptSubmit records nothing: no activity row, and the seat's latest word is still its running call", () => {
    const { db, store, nodeId } = setup();
    const before = (db.prepare("SELECT COUNT(*) AS n FROM events WHERE node_id = ? AND type = 'agent.activity'").get(nodeId) as { n: number }).n;
    store.recordHookEvent(pollEvent);
    const after = (db.prepare("SELECT COUNT(*) AS n FROM events WHERE node_id = ? AND type = 'agent.activity'").get(nodeId) as { n: number }).n;
    expect(after).toBe(before);
    expect(store.getLatestForNode({ nodeId, sessionName: "dev-impl@r" })).toMatchObject({ state: "running", rawEvent: "PreToolUse" });
    db.close();
  });

  it("an open AskUserQuestion is not abandoned by it (the auto-answer stays armed)", () => {
    const { db, store, questions } = setup();
    store.recordHookEvent(pollEvent);
    expect(questions.get("q1")?.state).toBe("waiting");
    db.close();
  });

  it("the seat's input point is not marked passed by it", () => {
    const { db, store, nodeId } = setup();
    const writtenAt = Date.parse("2026-11-18T09:00:01.000Z");
    store.recordHookEvent(pollEvent);
    expect(seatInputPoint(db, nodeId, writtenAt)).toBe("pending");
    db.close();
  });

  // verify-sec review F2: a typed prompt that only NAMES the source (no `<event>` envelope) is relayed as a typed prompt, and the daemon
  // records what the relay posts for it.
  it("a typed prompt with a forged source poll_event is relayed as a typed prompt, and the daemon records it", () => {
    const { db, store, questions } = setup();
    const posted = relay.buildOpenRigPayload({ ...captured.typedPrompt, source: "poll_event" }, ENV, () => new Date("2026-11-18T09:00:05.000Z"));
    expect(posted).toMatchObject({ hookEvent: "UserPromptSubmit" });
    expect(posted?.subtype).not.toBe("poll_event");
    const recorded = store.recordHookEvent({ ...posted!, runtime: "claude-code", sessionName: "dev-impl@r" });
    expect(recorded.ok).toBe(true);
    expect(questions.get("q1")?.state).toBe("abandoned");
    db.close();
  });

  it("control: a typed prompt still closes the turn, abandons the open question and passes the input point", () => {
    const { db, store, questions, nodeId } = setup();
    store.recordHookEvent(typed);
    expect(questions.get("q1")?.state).toBe("abandoned");
    expect(seatInputPoint(db, nodeId, Date.parse("2026-11-18T09:00:01.000Z"))).toBe("passed");
    db.close();
  });
});
