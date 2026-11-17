// workspaces-o9o.59: an earlier question's late end must not mask a follow-up question asked in the same turn.
// verify-qa round 3 of workspaces-o9o.4 at b6836f7a2 (bead text): UserPromptSubmit; AskUserQuestion A PreToolUse (id A); PermissionRequest A;
// the user answers A and the assistant asks follow-up B in the same turn, whose PermissionRequest arrives before B's async PreToolUse; A's
// delayed PostToolUse then becomes latest and the posture reads "busy: turn running" until B's PreToolUse arrives (masked for good if that
// relay is lost). The rule under test: a question is still waiting while its turn has more question asks than question ends.
// Every hook is built by the REAL relay (buildOpenRigPayload) on a 2031 clock, and read back through the real AgentActivityStore, the
// `rig ps` rows (attachAgentActivity) and the OF-278 auto-answer's own read (activityBackedPorts.stillAsking).
import { createRequire } from "node:module";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { attachAgentActivity } from "../src/domain/node-inventory.js";
import { activityBackedPorts, questionKeyOf } from "../src/domain/seat-question-policy.js";
import { activityRoutes } from "../src/routes/activity.js";

const require = createRequire(import.meta.url);
const relay = require("../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs") as {
  buildOpenRigPayload: (provider: Record<string, unknown>, env: Record<string, string>, now?: () => Date) => Record<string, unknown> | null;
};

const T0 = Date.parse("2031-05-06T09:13:27.412Z");
const SEAT = "build-impl@questions";
const WAITING = /^waiting on a question to the human/;
/** Question `q`, as Claude's AskUserQuestion tool_input.questions carries it. */
const questionsOf = (q: string) => [{ question: `Question ${q}?`, header: q, multiSelect: false,
  options: [{ label: "Yes (Recommended)", description: "yes" }, { label: "No", description: "no" }] }];

function seat() {
  const db = createDb();
  migrate(db, ALL_MIGRATIONS);
  const repo = new RigRepository(db);
  const sessions = new SessionRegistry(db);
  const rig = repo.createRig("questions");
  const node = repo.addNode(rig.id, "impl", { role: "worker", runtime: "claude-code" });
  sessions.updateStatus(sessions.registerSession(node.id, SEAT).id, "running");
  const store = new AgentActivityStore({ db, eventBus: new EventBus(db) });
  const ports = activityBackedPorts(store);
  /** What the real relay posts for a Claude hook payload, its clock reading `ms`. */
  const hook = (provider: Record<string, unknown>, ms: number) => {
    const body = relay.buildOpenRigPayload(provider, { OPENRIG_SESSION_NAME: SEAT, OPENRIG_RUNTIME: "claude-code" }, () => new Date(T0 + ms));
    expect(body).not.toBeNull();
    return store.recordHookEvent(body as never);
  };
  const prompt = (ms: number) => hook({ hook_event_name: "UserPromptSubmit" }, ms);
  /** Claude's tool_input for question `q` ("A", "B", ...); null is a relay copy from before workspaces-o9o.4 that names no questions. */
  const input = (q: string | null) => (q ? { tool_input: { questions: questionsOf(q) } } : {});
  const start = (id: string, ms: number, q: string | null = id.slice(-1)) =>
    hook({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_use_id: id, ...input(q) }, ms);
  const ask = (ms: number, q: string | null) => hook({ hook_event_name: "PermissionRequest", tool_name: "AskUserQuestion", ...input(q) }, ms);
  const end = (id: string | null, ms: number, event = "PostToolUse", q: string | null = id ? id.slice(-1) : null) =>
    hook({ hook_event_name: event, tool_name: "AskUserQuestion", ...(id ? { tool_use_id: id } : {}), ...input(q) }, ms);
  /** The PermissionRequest the question-wait hold records when the relay's has not arrived yet (seat-question-policy serve). */
  const holdRecords = (ms: number, q: string | null) =>
    ports.recordAsking({ nodeId: node.id, sessionName: SEAT, runtime: "claude-code" }, null, new Date(T0 + ms).toISOString(), q ? questionKeyOf({ questions: questionsOf(q) }) : null);
  const posture = async (ms: number) => (await attachAgentActivity(
    [{ canonicalSessionName: SEAT, runtime: "claude-code", attachmentType: "hc", logicalId: "impl", sessionStatus: "running" }] as never,
    { tmuxAdapter: {} as never, activityStore: store, now: new Date(T0 + ms) },
  ))[0]!.seatPosture!;
  const stillAsking = () => ports.stillAsking(node.id, null);
  return { store, nodeId: node.id, hook, prompt, start, ask, end, holdRecords, posture, stillAsking };
}

describe("workspaces-o9o.59: a follow-up question in the same turn is not masked by the earlier question's late end", () => {
  it("RED: verify-qa's round-3 sequence: A's late end, B asked and its start not yet seen, reads waiting, not 'busy: turn running'", async () => {
    const s = seat();
    s.prompt(0);
    s.start("toolu_A", 1_000);
    s.ask(1_020, "A");
    // The human answers A; the assistant asks follow-up B in the same turn. B's PermissionRequest (synchronous) arrives first.
    s.ask(40_000, "B");
    s.end("toolu_A", 40_050); // A's PostToolUse, relayed late: stamped after B's PermissionRequest
    expect((await s.posture(41_000)).line).toMatch(WAITING);
    expect(s.stillAsking()).toBe(true);
    s.start("toolu_B", 40_100); // B's own start, relayed late
    expect((await s.posture(42_000)).line).toMatch(WAITING);
    s.end("toolu_B", 90_000); // B answered
    expect((await s.posture(91_000)).kind).toBe("busy");
    expect(s.stillAsking()).toBe(false);
  });

  it("B's start relay lost for good: B stays waiting (not masked), and it is still on record as asking", async () => {
    const s = seat();
    s.prompt(0);
    s.start("toolu_A", 1_000);
    s.ask(1_020, "A");
    s.ask(40_000, "B");
    s.end("toolu_A", 40_050);
    expect((await s.posture(41_000)).line).toMatch(WAITING);
    expect(s.stillAsking()).toBe(true); // the auto-answer's read (getLatestRecorded) has no freshness window
  });

  it("a PostToolUseFailure counts as a question's end", async () => {
    const s = seat();
    s.prompt(0);
    s.start("toolu_A", 1_000);
    s.ask(1_020, "A");
    s.ask(40_000, "B");
    s.end("toolu_A", 40_050, "PostToolUseFailure");
    expect((await s.posture(41_000)).line).toMatch(WAITING);
    s.start("toolu_B", 40_100);
    s.end("toolu_B", 50_000, "PostToolUseFailure");
    expect((await s.posture(51_000)).kind).toBe("busy");
  });

  it("the same end relayed twice is one end: it does not pay for B's ask", async () => {
    const s = seat();
    s.prompt(0);
    s.start("toolu_A", 1_000);
    s.ask(1_020, "A");
    s.ask(40_000, "B");
    s.end("toolu_A", 40_050);
    s.end("toolu_A", 40_060);
    expect((await s.posture(41_000)).line).toMatch(WAITING);
  });

  it("a seat on the relay from before workspaces-o9o.4 (no call ids, no question starts): A's end does not clear B; B's does", async () => {
    const s = seat();
    s.prompt(0);
    s.ask(1_020, null);
    s.ask(40_000, null);
    s.end(null, 40_050);
    expect((await s.posture(41_000)).line).toMatch(WAITING);
    expect(s.stillAsking()).toBe(true);
    s.end(null, 90_000);
    expect((await s.posture(91_000)).kind).toBe("busy");
  });

  it("the hold's own record of a question the relay also reported is ONE ask: the question's end clears it (no stale 'waiting')", async () => {
    for (const order of ["hold first", "relay first"] as const) {
      const s = seat();
      s.prompt(0);
      s.start("toolu_A", 1_000);
      if (order === "hold first") { s.holdRecords(1_015, "A"); s.ask(1_020, "A"); } else { s.ask(1_020, "A"); s.holdRecords(1_025, "A"); }
      expect((await s.posture(2_000)).line, order).toMatch(WAITING);
      s.end("toolu_A", 30_000);
      expect((await s.posture(31_000)).kind, order).toBe("busy");
      expect(s.stillAsking(), order).toBe(false);
    }
  });

  it("two questions, each reported by both the relay and the hold: A's late end leaves B waiting; B's end clears", async () => {
    const s = seat();
    s.prompt(0);
    s.start("toolu_A", 1_000);
    s.holdRecords(1_015, "A");
    s.ask(1_020, "A");
    s.ask(40_000, "B");
    s.holdRecords(40_010, "B");
    s.end("toolu_A", 40_050);
    expect((await s.posture(41_000)).line).toMatch(WAITING);
    s.start("toolu_B", 40_100);
    s.end("toolu_B", 90_000);
    expect((await s.posture(91_000)).kind).toBe("busy");
  });

  it("both questions recorded only by the hold (the relay's PermissionRequests lost): A's late end leaves B waiting", async () => {
    const s = seat();
    s.prompt(0);
    s.start("toolu_A", 1_000);
    s.holdRecords(1_020, "A");
    s.holdRecords(40_000, "B");
    s.end("toolu_A", 40_050);
    expect((await s.posture(41_000)).line).toMatch(WAITING);
  });

  it("another tool's end is not a question's end: a Read ending in the turn does not pay for B's ask", async () => {
    const s = seat();
    s.prompt(0);
    s.start("toolu_A", 1_000);
    s.ask(1_020, "A");
    s.hook({ hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "toolu_read" }, 30_000);
    s.hook({ hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: "toolu_read" }, 30_100);
    s.ask(40_000, "B");
    s.end("toolu_A", 40_050);
    expect((await s.posture(41_000)).line).toMatch(WAITING);
  });

  // verify-qa2 FAIL of b285a5a5d: counted per source (max of relay, hold), a question only the relay saw beside a DIFFERENT one only the hold
  // recorded counted as one, and A's late end masked B. Counted per question (digest), they are two.
  it("RED (review): the relay saw A only, the hold recorded a different B only, B's start withheld: A's late end leaves B waiting", async () => {
    const s = seat();
    s.prompt(0);
    s.start("toolu_A", 1_000);
    s.ask(1_020, "A");             // the relay's report of A; the hold saw it on record, so it recorded nothing
    s.holdRecords(40_000, "B");    // B: the relay's PermissionRequest did not arrive first, so the hold put B on record
    s.end("toolu_A", 40_050);      // A's late end; B's start is withheld
    expect((await s.posture(41_000)).line).toMatch(WAITING);
    expect(s.stillAsking()).toBe(true);
    s.ask(40_060, "B");            // the relay's B arrives after all: still one B
    s.start("toolu_B", 40_100);
    s.end("toolu_B", 90_000);
    expect((await s.posture(91_000)).kind).toBe("busy");
  });

  it("a seat on a relay copy that sends no digest, beside the daemon's keyed hold record of the SAME question: one ask, its end clears it", async () => {
    for (const order of ["hold first", "relay first"] as const) {
      const s = seat();
      s.prompt(0);
      if (order === "hold first") { s.holdRecords(1_015, "A"); s.ask(1_020, null); } else { s.ask(1_020, null); s.holdRecords(1_025, "A"); }
      expect((await s.posture(2_000)).line, order).toMatch(WAITING);
      s.end(null, 30_000);
      expect((await s.posture(31_000)).kind, order).toBe("busy");
      expect(s.stillAsking(), order).toBe(false);
    }
  });

  it("a keyless relay record beyond what the hold recorded is a question of its own: A's end does not clear the keyless B", async () => {
    const s = seat();
    s.prompt(0);
    s.ask(1_020, null);
    s.holdRecords(1_025, "A");     // pairs with the first keyless record
    s.ask(40_000, null);           // B, keyless, no hold record: a second question
    s.end(null, 40_050);
    expect((await s.posture(41_000)).line).toMatch(WAITING);
  });

  it("the same question asked twice in one turn is two asks: the first's late end leaves the re-ask waiting", async () => {
    const s = seat();
    s.prompt(0);
    s.start("toolu_1A", 1_000, "A");
    s.ask(1_020, "A");
    s.ask(40_000, "A");
    s.end("toolu_1A", 40_050, "PostToolUse", "A");
    expect((await s.posture(41_000)).line).toMatch(WAITING);
  });

  it("asks of an earlier turn do not count: a new turn's single question is cleared by its own end", async () => {
    const s = seat();
    s.prompt(0);
    s.ask(1_020, "A");
    s.ask(2_000, "B");
    s.prompt(60_000); // the earlier turn ended with no question end on record
    s.start("toolu_C", 61_000);
    s.ask(61_020, "C");
    s.end("toolu_C", 70_000);
    expect((await s.posture(71_000)).kind).toBe("busy");
  });
});

describe("workspaces-o9o.59: only the daemon's own hold marks an ask as its record", () => {
  it("a hook body that claims recordedBy is stored without it: the route never takes the mark from a hook", async () => {
    const s = seat();
    const TOKEN = "hook-token-o9o59";
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("agentActivityStore" as never, s.store as never);
      c.set("activityHookToken" as never, TOKEN as never);
      await next();
    });
    app.route("/api/activity", activityRoutes);
    const body = relay.buildOpenRigPayload({ hook_event_name: "PermissionRequest", tool_name: "AskUserQuestion" },
      { OPENRIG_SESSION_NAME: SEAT, OPENRIG_RUNTIME: "claude-code" }, () => new Date(T0 + 1_000));
    const res = await app.request("/api/activity/hooks", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ ...body, recordedBy: "question_hold" }),
    });
    expect(res.status).toBe(200);
    const latest = s.store.getLatestRecorded(s.nodeId)!;
    expect(latest).toMatchObject({ rawEvent: "PermissionRequest", dialog: "question" });
    expect(latest.recordedBy).toBeUndefined();
  });

  it("the hold's mark is kept on its question PermissionRequest and nowhere else", () => {
    const s = seat();
    s.holdRecords(1_000, "A");
    expect(s.store.getLatestRecorded(s.nodeId)!.recordedBy).toBe("question_hold");
    s.store.recordHookEvent({ runtime: "claude-code", sessionName: SEAT, hookEvent: "Stop", occurredAt: new Date(T0 + 2_000).toISOString(), recordedBy: "question_hold" });
    expect(s.store.getLatestRecorded(s.nodeId)!.recordedBy).toBeUndefined();
  });
});
