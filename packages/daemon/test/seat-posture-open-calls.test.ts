// workspaces-o9o.4, verify-qa FAIL 11:50Z (attempt 1/3): three findings, each replayed here in production terms through the real
// AgentActivityStore and attachAgentActivity (the `rig ps` rows), on a 2031 clock far from wall clock.
//  F1  a stale tool start was shown as a confirmed running tool when hc said the run was working (hc status is run-level).
//  F2  parallel calls lost an open tool: any PostToolUse cleared it (Bash start, Read start, Read end read as "turn running").
//  F3  the async relay stamps occurredAt when it RUNS, so a tool start or end stamped after a synchronous prompt outranked it and could
//      hide a question to the human. The F3 rows build their hook with the REAL relay's buildOpenRigPayload on a late clock.
// Claude Code 2.1.325 measured (bead note): PreToolUse/PostToolUse carry tool_use_id (one per call, the same on start and end); the
// PermissionRequest names the tool but carries no tool_use_id; no hook carries the time it fired.
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { attachAgentActivity } from "../src/domain/node-inventory.js";
import type { SeatTerminalStatusReader } from "../src/domain/seat-posture.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { PumpHandOff } from "../src/domain/seat-messaging/hand-off.js";
import { MessagePump } from "../src/domain/seat-messaging/message-pump.js";
import { MessageStore } from "../src/domain/seat-messaging/message-store.js";
import type { LastHop, SeatGate } from "../src/domain/seat-messaging/ports.js";
import { DbSeatDirectory } from "../src/domain/seat-messaging/seat-directory.js";
import { tmuxStub } from "./helpers/tmux-stub.js";

const require = createRequire(import.meta.url);
const relay = require("../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs") as {
  buildOpenRigPayload: (provider: Record<string, unknown>, env: Record<string, string>, now?: () => Date) => Record<string, unknown> | null;
};

const T0 = Date.parse("2031-03-04T16:04:41.008Z");
const MIN = 60_000;
const SEAT = "verify-sec@eztrack";

function seat(runtime: string) {
  const db = createDb();
  migrate(db, ALL_MIGRATIONS);
  const repo = new RigRepository(db);
  const sessions = new SessionRegistry(db);
  const rig = repo.createRig("eztrack");
  const node = repo.addNode(rig.id, "sec", { role: "worker", runtime });
  sessions.updateStatus(sessions.registerSession(node.id, SEAT).id, "running");
  const store = new AgentActivityStore({ db, eventBus: new EventBus(db) });
  const fire = (hookEvent: string, subtype: string | null, ms: number, toolCallId?: string) =>
    store.recordHookEvent({ sessionName: SEAT, runtime, hookEvent, subtype, occurredAt: new Date(T0 + ms).toISOString(), ...(toolCallId ? { toolCallId } : {}) } as never);
  /** What the real relay would post for a Claude hook payload, its clock reading `ms`: the async relay stamps the time it runs. */
  const fireViaRelay = (provider: Record<string, unknown>, ms: number) => {
    const body = relay.buildOpenRigPayload(provider, { OPENRIG_SESSION_NAME: SEAT, OPENRIG_RUNTIME: runtime }, () => new Date(T0 + ms));
    expect(body).not.toBeNull();
    return store.recordHookEvent(body as never);
  };
  /** The same, but what the relay drops is not posted: the production path for a hook the relay filters. */
  const relayed = (provider: Record<string, unknown>, ms: number) => {
    const body = relay.buildOpenRigPayload(provider, { OPENRIG_SESSION_NAME: SEAT, OPENRIG_RUNTIME: runtime }, () => new Date(T0 + ms));
    return body ? store.recordHookEvent(body as never) : null;
  };
  const row = async (ms: number, seatTerminalStatus?: SeatTerminalStatusReader) => (await attachAgentActivity(
    [{ canonicalSessionName: SEAT, runtime, attachmentType: "hc", logicalId: "verify.sec", sessionStatus: "running" }] as never,
    { tmuxAdapter: {} as never, activityStore: store, now: new Date(T0 + ms), ...(seatTerminalStatus ? { seatTerminalStatus } : {}) },
  ))[0]!;
  return { fire, fireViaRelay, relayed, row };
}

describe("F1: a tool start past the freshness window is never shown as a confirmed running tool", () => {
  it("a Pi seat 66 min after a bash start, its hc status working: busy for the run, the tool unconfirmed and not 'running'", async () => {
    const { fire, row } = seat("pi");
    fire("active", "agent_start", -1_000);
    fire("PreToolUse", "bash", 0, "call-1");
    const working: SeatTerminalStatusReader = async () => ({ live: true, status: "working", sinceMs: T0 - 1_000 });
    const posture = (await row(66 * MIN, working)).seatPosture!;
    expect(posture).toMatchObject({ kind: "busy", source: "hc_status", tool: "bash", toolConfirmed: false });
    expect(posture.line).toBe("busy: working since 16:04Z (hc status); bash started 16:04Z, 66 min ago, no end recorded");
    expect(posture.line).not.toMatch(/running bash/);
  });

  it("a fresh hook for ANOTHER call does not confirm an old open one", async () => {
    const { fire, row } = seat("claude-code");
    fire("UserPromptSubmit", null, 0);
    fire("PreToolUse", "Bash", 1_000, "toolu_bash");
    fire("PreToolUse", "Read", 20 * MIN, "toolu_read");
    fire("PostToolUse", "Read", 20 * MIN + 2_000, "toolu_read");
    const posture = (await row(21 * MIN)).seatPosture!;
    expect(posture).toMatchObject({ kind: "busy", tool: "Bash", toolConfirmed: false });
    expect(posture.line).toBe("busy: turn running; Bash started 16:04Z, 20 min ago, no end recorded");
  });

  it("control: a call started inside the window is confirmed", async () => {
    const { fire, row } = seat("claude-code");
    fire("UserPromptSubmit", null, 0);
    fire("PreToolUse", "Bash", MIN, "toolu_bash");
    const posture = (await row(4 * MIN)).seatPosture!;
    expect(posture).toMatchObject({ kind: "busy", tool: "Bash", toolConfirmed: true, line: "busy: running Bash for 3 min (since 16:05Z)" });
  });
});

describe("F2: parallel calls: the open-call set, keyed by the call id", () => {
  it("Bash start, Read start, Read end: Bash is still open and named", async () => {
    const { fire, row } = seat("claude-code");
    fire("UserPromptSubmit", null, 0);
    fire("PreToolUse", "Bash", MIN, "toolu_bash");
    fire("PreToolUse", "Read", MIN + 5_000, "toolu_read");
    fire("PostToolUse", "Read", MIN + 10_000, "toolu_read");
    const posture = (await row(2 * MIN)).seatPosture!;
    expect(posture).toMatchObject({ kind: "busy", tool: "Bash", toolConfirmed: true, line: "busy: running Bash for 1 min (since 16:05Z)" });
  });

  it("two calls open: the oldest is named, with +1 more; when it ends the other is named", async () => {
    const { fire, row } = seat("claude-code");
    fire("UserPromptSubmit", null, 0);
    fire("PreToolUse", "Bash", MIN, "toolu_bash");
    fire("PreToolUse", "Grep", MIN + 5_000, "toolu_grep");
    expect((await row(2 * MIN)).seatPosture).toMatchObject({ tool: "Bash", otherOpenCalls: 1, line: "busy: running Bash for 1 min (since 16:05Z) +1 more" });
    fire("PostToolUse", "Bash", 2 * MIN + 1_000, "toolu_bash");
    expect((await row(2 * MIN + 2_000)).seatPosture).toMatchObject({ tool: "Grep", otherOpenCalls: 0, line: "busy: running Grep for 57 s (since 16:05Z)" });
  });

  it("a failed end closes its call too", async () => {
    const { fire, row } = seat("claude-code");
    fire("UserPromptSubmit", null, 0);
    fire("PreToolUse", "Bash", MIN, "toolu_bash");
    fire("PostToolUseFailure", "Bash", MIN + 3_000, "toolu_bash");
    expect((await row(2 * MIN)).seatPosture).toMatchObject({ tool: null });
  });

  it("a turn boundary closes what the last turn left open (an interrupted call ends no hook)", async () => {
    const { fire, row } = seat("claude-code");
    fire("UserPromptSubmit", null, 0);
    fire("PreToolUse", "Bash", MIN, "toolu_old");
    fire("UserPromptSubmit", null, 2 * MIN);
    expect((await row(3 * MIN)).seatPosture).toMatchObject({ tool: null });
  });

  it("rows with no call id keep the old rule: only a newest tool start names a tool", async () => {
    const { fire, row } = seat("claude-code");
    fire("UserPromptSubmit", null, 0);
    fire("PreToolUse", "Bash", MIN);
    expect((await row(2 * MIN)).seatPosture).toMatchObject({ tool: "Bash", line: "busy: running Bash for 1 min (since 16:05Z)" });
    fire("PreToolUse", "Read", MIN + 5_000);
    fire("PostToolUse", "Read", MIN + 10_000);
    expect((await row(2 * MIN)).seatPosture).toMatchObject({ tool: null, line: "busy: turn running, last hook PostToolUse 16:05Z" });
  });
});

describe("F3: a late-stamped async hook never hides a prompt; the real relay stamps the time it runs", () => {
  it("a tool start stamped after a permission prompt (its async relay ran late) leaves the seat needing input", async () => {
    const { fire, fireViaRelay, row } = seat("claude-code");
    fire("UserPromptSubmit", null, 0);
    fire("Notification", "permission_prompt", MIN); // synchronous: recorded first
    fireViaRelay({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_bash" }, MIN + 50); // fired before it, stamped after it
    expect((await row(MIN + 5_000)).seatPosture).toMatchObject({ kind: "needs_input" });
  });

  it("the same start stamped long after the prompt (a relay that ran seconds late under load) still leaves the seat needing input", async () => {
    const { fire, fireViaRelay, row } = seat("claude-code");
    fire("UserPromptSubmit", null, 0);
    fire("Notification", "permission_prompt", MIN);
    fireViaRelay({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_bash" }, MIN + 10_000); // far past the 2 s window
    expect((await row(MIN + 15_000)).seatPosture).toMatchObject({ kind: "needs_input" });
  });

  it("a question to the human is cleared by its own tool's end only, never another call's late end", async () => {
    const { fire, fireViaRelay, relayed, row } = seat("claude-code");
    fire("UserPromptSubmit", null, 0);
    relayed({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_use_id: "toolu_ask" }, MIN - 20);
    fire("PermissionRequest", "AskUserQuestion", MIN);
    fireViaRelay({ hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: "toolu_read" }, MIN + 30_000); // another call, much later
    expect((await row(MIN + 40_000)).seatPosture).toMatchObject({ kind: "needs_input", line: expect.stringMatching(/^waiting on a question to the human/) });
    fireViaRelay({ hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", tool_use_id: "toolu_ask" }, MIN + 60_000); // answered
    expect((await row(MIN + 65_000)).seatPosture?.kind).toBe("busy");
  });

  // verify-qa re-review of 08ab4d1c8 (F3 remaining case), its exact sequence through the real relay: the previous question's end, relayed
  // late, must not answer the question asked after it.
  it("a delayed end of an EARLIER question does not clear a newer question; the newer question's own end does", async () => {
    const { fire, fireViaRelay, relayed, row } = seat("claude-code");
    fire("UserPromptSubmit", null, 0);
    relayed({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_use_id: "toolu_previous_question" }, 5_000);
    fire("PermissionRequest", "AskUserQuestion", 5_020);
    fire("UserPromptSubmit", null, MIN); // the next turn: the previous question's end has not arrived
    relayed({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_use_id: "toolu_new_question" }, MIN + 5_000);
    fire("PermissionRequest", "AskUserQuestion", MIN + 5_020);
    fireViaRelay({ hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", tool_use_id: "toolu_previous_question" }, MIN + 10_000);
    expect((await row(MIN + 12_000)).seatPosture).toMatchObject({ kind: "needs_input", line: expect.stringMatching(/^waiting on a question to the human/) });
    fireViaRelay({ hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", tool_use_id: "toolu_new_question" }, MIN + 60_000); // answered
    expect((await row(MIN + 61_000)).seatPosture?.kind).toBe("busy");
  });

  it("a question stays open while any AskUserQuestion call of the turn is open: one call's end does not clear it", async () => {
    const { fire, fireViaRelay, relayed, row } = seat("claude-code");
    fire("UserPromptSubmit", null, 0);
    relayed({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_use_id: "toolu_q1" }, 1_000);
    relayed({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_use_id: "toolu_q2" }, 1_010);
    fire("PermissionRequest", "AskUserQuestion", 1_030);
    fireViaRelay({ hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", tool_use_id: "toolu_q1" }, 30_000);
    expect((await row(31_000)).seatPosture?.kind).toBe("needs_input");
    fireViaRelay({ hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", tool_use_id: "toolu_q2" }, 40_000);
    expect((await row(41_000)).seatPosture?.kind).toBe("busy");
  });

  it("an AskUserQuestion call is never shown as the running tool, open or not", async () => {
    const { fire, fireViaRelay, relayed, row } = seat("claude-code");
    fire("UserPromptSubmit", null, 0);
    fireViaRelay({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_bash" }, 1_000);
    relayed({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_use_id: "toolu_ask" }, 2_000);
    // Before its PermissionRequest lands the question's start is the newest hook: the seat is busy, and no tool line names the question.
    const before = (await row(2_010)).seatPosture!;
    expect(before).toMatchObject({ kind: "busy", tool: "Bash", otherOpenCalls: 0 });
    expect(before.line).not.toMatch(/AskUserQuestion/);
    const only = seat("claude-code");
    only.fire("UserPromptSubmit", null, 0);
    only.relayed({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_use_id: "toolu_ask" }, 2_000);
    const alone = (await only.row(2_010)).seatPosture!;
    expect(alone.tool ?? null).toBeNull();
    // The hook is named as evidence; no tool clause claims the question runs.
    expect(alone.line).toMatch(/^busy: turn running, last hook PreToolUse AskUserQuestion \S+$/);
  });

  it("a question answered while another tool call is still open clears: only AskUserQuestion calls hold it", async () => {
    const { fire, fireViaRelay, relayed, row } = seat("claude-code");
    fire("UserPromptSubmit", null, 0);
    fireViaRelay({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_bash" }, 1_000);
    relayed({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_use_id: "toolu_ask" }, 2_000);
    fire("PermissionRequest", "AskUserQuestion", 2_020);
    fireViaRelay({ hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", tool_use_id: "toolu_ask" }, 30_000);
    expect((await row(31_000)).seatPosture).toMatchObject({ kind: "busy", tool: "Bash" });
  });

  // The latest read looks at the newest 20 rows; the question's calls are read from the whole turn (up to 200 rows).
  it("the question's own start more than 20 rows back (other calls' hooks arrived between it and the dialog) still lets its end clear it", async () => {
    const { fire, fireViaRelay, relayed, row } = seat("claude-code");
    fire("UserPromptSubmit", null, 0);
    relayed({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_use_id: "toolu_ask" }, 1_000);
    for (let i = 0; i < 12; i += 1) { // parallel Read calls of the same message, relayed before the dialog's PermissionRequest
      fireViaRelay({ hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: `toolu_read_${i}` }, 1_100 + i);
      fireViaRelay({ hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: `toolu_read_${i}` }, 1_200 + i);
    }
    fire("PermissionRequest", "AskUserQuestion", 1_500);
    expect((await row(10_000)).seatPosture?.kind).toBe("needs_input");
    fireViaRelay({ hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", tool_use_id: "toolu_ask" }, 30_000);
    expect((await row(31_000)).seatPosture?.kind).toBe("busy");
  });

  it("an end with no call id (a seat on the relay from before workspaces-o9o.4, until relaunch) keeps the old rule: any AskUserQuestion end clears", async () => {
    const { fire, fireViaRelay, row } = seat("claude-code");
    fire("UserPromptSubmit", null, 0);
    fire("PermissionRequest", "AskUserQuestion", MIN);
    fireViaRelay({ hook_event_name: "PostToolUse", tool_name: "Read" }, MIN + 30_000);
    expect((await row(MIN + 31_000)).seatPosture?.kind).toBe("needs_input");
    fireViaRelay({ hook_event_name: "PostToolUse", tool_name: "AskUserQuestion" }, MIN + 40_000);
    expect((await row(MIN + 41_000)).seatPosture?.kind).toBe("busy");
  });

  it("a permission prompt (it names no tool): a tool end stamped within 2 s of it does not clear it; one well after it does", async () => {
    const { fire, fireViaRelay, row } = seat("claude-code");
    fire("UserPromptSubmit", null, 0);
    fire("Notification", "permission_prompt", MIN);
    fireViaRelay({ hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: "toolu_read" }, MIN + 1_500);
    expect((await row(MIN + 3_000)).seatPosture?.kind).toBe("needs_input");
    fireViaRelay({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "toolu_bash" }, MIN + 20_000); // approved, ran, ended
    expect((await row(MIN + 21_000)).seatPosture?.kind).toBe("busy");
  });

  it("the relay carries the hook's tool_use_id as the call id", () => {
    const body = relay.buildOpenRigPayload({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_x" }, { OPENRIG_SESSION_NAME: SEAT, OPENRIG_RUNTIME: "claude-code" });
    expect(body).toMatchObject({ hookEvent: "PreToolUse", subtype: "Bash", toolCallId: "toolu_x" });
  });
});

// The two production call sites of the open-call read, end to end: hooks posted the way the relay posts them, through the real
// /api/activity/hooks route; the `rig ps` rows read through GET /api/rigs/:id/nodes; the `rig send` answer through SessionTransport.
describe("the open-call set through the production paths (workspaces-o9o.4)", () => {
  const relayBody = (provider: Record<string, unknown>, ms: number, generation: string | null) =>
    relay.buildOpenRigPayload(provider, { OPENRIG_SESSION_NAME: SEAT, OPENRIG_RUNTIME: "claude-code", ...(generation ? { OPENRIG_OCCUPANT_GENERATION: generation } : {}) }, () => new Date(T0 + ms));

  it("hooks posted to /api/activity/hooks keep their call ids, and GET /nodes names the call still open", async () => {
    const db = createFullTestDb();
    try {
      const rigRepo = new RigRepository(db);
      const rig = rigRepo.createRig("eztrack");
      const node = rigRepo.addNode(rig.id, "verify.sec", { runtime: "claude-code" });
      const reg = new SessionRegistry(db);
      reg.updateStatus(reg.registerSession(node.id, SEAT).id, "running");
      const generation = reg.currentOccupantTenure(node.id)?.generationUuid ?? null;
      const { app } = createTestApp(db, { activityHookToken: "tok" });
      const post = async (body: unknown) => {
        const res = await app.request("/api/activity/hooks", { method: "POST", headers: { "content-type": "application/json", "x-openrig-activity-token": "tok" }, body: JSON.stringify(body) });
        expect(res.status).toBe(200);
      };
      const now = Date.now(); // the route reads on wall clock: this test's hooks are dated relative to it
      const at = (ms: number) => now - T0 + ms;
      await post(relayBody({ hook_event_name: "UserPromptSubmit", prompt: "go" }, at(-90_000), generation));
      await post(relayBody({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_bash" }, at(-60_000), generation));
      await post(relayBody({ hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "toolu_read" }, at(-50_000), generation));
      await post(relayBody({ hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: "toolu_read" }, at(-40_000), generation));
      const nodes = (await (await app.request(`/api/rigs/${rig.id}/nodes`)).json()) as Array<Record<string, any>>;
      const posture = nodes.find((n) => n.canonicalSessionName === SEAT)?.seatPosture;
      expect(posture).toMatchObject({ kind: "busy", tool: "Bash", toolConfirmed: true, otherOpenCalls: 0 });
      expect(posture.line).toMatch(/^busy: running Bash for 1 min \(since \d\d:\d\dZ\)$/);
    } finally {
      db.close();
    }
  });

  it("the rig send answer (SessionTransport) names the call still open, not the newest hook", async () => {
    const db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const rigRepo = new RigRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    const rig = rigRepo.createRig("eztrack");
    const node = rigRepo.addNode(rig.id, "sec", { role: "worker", runtime: "claude-code" });
    sessionRegistry.updateStatus(sessionRegistry.registerSession(node.id, SEAT).id, "running");
    sessionRegistry.updateBinding(node.id, { attachmentType: "tmux", tmuxSession: SEAT, tmuxPane: "%1" });
    const gate: SeatGate = { version: 1, lookup: async () => ({ kind: "not_seen" }) };
    const hop: LastHop = { attempt: async () => ({ kind: "sent" }) };
    const ports = { gateFor: () => gate, hopFor: () => hop };
    const store = new MessageStore(db);
    const pump = new MessagePump({ store, ports, directory: new DbSeatDirectory(db), held: { status: () => "held" }, senders: { returnToSender: async () => ({ kind: "returned", qitemId: "q" }) } });
    const tmuxAdapter = tmuxStub({
      hasSession: async () => true, probeSession: async () => ({ state: "present" as const }), capturePaneContent: async () => "idle\n❯ ",
      listSessions: async () => [], listWindows: async () => [], listPanes: async () => [], getPanePid: async () => null, getPaneCommand: async () => null,
      sendText: async () => ({ ok: true as const }), sendKeys: async () => ({ ok: true as const }),
    });
    tmuxAdapter.messageHandOff = new PumpHandOff(store, pump, ports);
    const activityStore = new AgentActivityStore({ db, eventBus });
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, agentActivityStore: activityStore, eventBus, tmuxAdapter, sleep: async () => undefined, now: () => new Date(T0 + 2 * MIN) });
    for (const [provider, ms] of [
      [{ hook_event_name: "UserPromptSubmit", prompt: "go" }, 0],
      [{ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_bash" }, MIN],
      [{ hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "toolu_read" }, MIN + 5_000],
      [{ hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: "toolu_read" }, MIN + 10_000],
    ] as Array<[Record<string, unknown>, number]>) {
      expect(activityStore.recordHookEvent(relayBody(provider, ms, null) as never).ok).toBe(true);
    }
    const result = await transport.send(SEAT, "hello", { deliveryId: "m1", actorSession: "lead@eztrack" });
    expect(result.seatPosture).toMatchObject({ kind: "busy", tool: "Bash", toolConfirmed: true, line: "busy: running Bash for 1 min (since 16:05Z)" });
    db.close();
  });
});
