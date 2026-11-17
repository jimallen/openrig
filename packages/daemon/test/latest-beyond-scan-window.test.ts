// workspaces-o9o.57: the latest-hook read looked at a seat's newest 20 activity rows only. A prompt followed by 20 or more async rows (tool
// starts and ends relayed late, stamped before the prompt) fell out of that window, and the newest async row was taken as the latest: the
// seat read busy while it waited on the human. The same 20-row rule sat in a second reader, the socket input point (seatInputPoint).
// Every hook below is built by the REAL relay (buildOpenRigPayload) where a relay posts it, on a 2031 clock, and read back through the real
// AgentActivityStore, the `rig ps` rows (attachAgentActivity), the OF-278 auto-answer's own read (activityBackedPorts.stillAsking) and
// seatInputPoint.
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
import { activityBackedPorts } from "../src/domain/seat-question-policy.js";
import { seatInputPoint } from "../src/domain/seat-messaging/input-point.js";

const require = createRequire(import.meta.url);
const relay = require("../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs") as {
  buildOpenRigPayload: (provider: Record<string, unknown>, env: Record<string, string>, now?: () => Date) => Record<string, unknown> | null;
};

const T0 = Date.parse("2031-07-08T11:12:13.141Z");
const SEAT = "build-impl@window";
const QUESTION = [{ question: "Ship it?", header: "Ship", multiSelect: false, options: [{ label: "Yes (Recommended)", description: "y" }, { label: "No", description: "n" }] }];

function seat() {
  const db = createDb();
  migrate(db, ALL_MIGRATIONS);
  const repo = new RigRepository(db);
  const sessions = new SessionRegistry(db);
  const rig = repo.createRig("window");
  const node = repo.addNode(rig.id, "impl", { role: "worker", runtime: "claude-code" });
  sessions.updateStatus(sessions.registerSession(node.id, SEAT).id, "running");
  const store = new AgentActivityStore({ db, eventBus: new EventBus(db) });
  const hook = (provider: Record<string, unknown>, ms: number) => {
    const body = relay.buildOpenRigPayload(provider, { OPENRIG_SESSION_NAME: SEAT, OPENRIG_RUNTIME: "claude-code" }, () => new Date(T0 + ms));
    expect(body).not.toBeNull();
    return store.recordHookEvent(body as never);
  };
  /** `n` parallel Read calls of the same message, each start and end relayed late: stamped at `stampedMs`, before the prompt. */
  const lateReads = (n: number, stampedMs: number) => {
    for (let i = 0; i < n; i += 1) {
      hook({ hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: `toolu_read_${i}` }, stampedMs + i);
      hook({ hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: `toolu_read_${i}` }, stampedMs + 100 + i);
    }
  };
  const posture = async (ms: number) => (await attachAgentActivity(
    [{ canonicalSessionName: SEAT, runtime: "claude-code", attachmentType: "hc", logicalId: "impl", sessionStatus: "running" }] as never,
    { tmuxAdapter: {} as never, activityStore: store, now: new Date(T0 + ms) },
  ))[0]!.seatPosture!;
  return { db, nodeId: node.id, store, hook, lateReads, posture, ports: activityBackedPorts(store) };
}

describe("workspaces-o9o.57: a prompt followed by 20+ async rows is still the latest", () => {
  it("RED: a question followed by 13 late parallel Reads (26 async rows) reads waiting on the human, not busy", async () => {
    const s = seat();
    s.hook({ hook_event_name: "UserPromptSubmit" }, 0);
    s.hook({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_use_id: "toolu_ask", tool_input: { questions: QUESTION } }, 900);
    s.hook({ hook_event_name: "PermissionRequest", tool_name: "AskUserQuestion", tool_input: { questions: QUESTION } }, 2_000);
    s.lateReads(13, 1_000);                                // 26 rows arrive after the dialog, all stamped before it
    expect((await s.posture(3_000)).line).toMatch(/^waiting on a question to the human/);
    expect(s.ports.stillAsking(s.nodeId, null)).toBe(true);
  });

  it("RED: a permission prompt followed by 26 late async rows still reads needs_input", async () => {
    const s = seat();
    s.hook({ hook_event_name: "UserPromptSubmit" }, 0);
    s.hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_bash" }, 500);
    s.hook({ hook_event_name: "Notification", notification_type: "permission_prompt" }, 2_000);
    s.lateReads(13, 1_000);
    expect((await s.posture(3_000)).kind).toBe("needs_input");
  });

  /** A Stop, then 26 late tool starts stamped before it. Only starts: an end stamped after the write is itself an input point. */
  const stoppedThenLateStarts = () => {
    const s = seat();
    s.hook({ hook_event_name: "UserPromptSubmit" }, 0);
    s.hook({ hook_event_name: "Stop" }, 2_000);
    for (let i = 0; i < 26; i += 1) s.hook({ hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: `toolu_read_${i}` }, 1_000 + i);
    return s;
  };
  it("RED: a Stop followed by 26 late async rows reads idle", async () => {
    expect((await stoppedThenLateStarts().posture(3_000)).kind).toBe("idle");
  });
  it("RED (second reader): the socket input point sees the Stop past 26 late rows: a line written after it has been passed", () => {
    const s = stoppedThenLateStarts();
    expect(seatInputPoint(s.db, s.nodeId, T0 + 2_500)).toBe("passed");
  });

  // verify-qa FAIL of e68d2c94a: the question's own Notification/permission_prompt lands ~6.5 s after its PermissionRequest (measured, 2.1.319).
  // It was taken as part of the question only when the row just before it was the question; 26 late rows between made it a plain permission
  // prompt, so the auto-answer's read said the seat was not asking, and a later unrelated tool end cleared it.
  it("RED (review): the question's delayed Notification, 26 late rows after its PermissionRequest, is still the question", async () => {
    const s = seat();
    s.hook({ hook_event_name: "UserPromptSubmit" }, 0);
    s.hook({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_use_id: "toolu_ask", tool_input: { questions: QUESTION } }, 900);
    s.hook({ hook_event_name: "PermissionRequest", tool_name: "AskUserQuestion", tool_input: { questions: QUESTION } }, 2_000);
    s.lateReads(13, 1_000);
    s.hook({ hook_event_name: "Notification", notification_type: "permission_prompt" }, 8_500);   // the dialog's own notification
    expect(s.store.getLatestRecorded(s.nodeId)).toMatchObject({ rawEvent: "Notification", dialog: "question" });
    expect(s.ports.stillAsking(s.nodeId, null)).toBe(true);
    s.hook({ hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: "toolu_read_late" }, 20_000);   // an unrelated end, > 2 s later
    expect((await s.posture(21_000)).line).toMatch(/^waiting on a question to the human/);
    expect(s.ports.stillAsking(s.nodeId, null)).toBe(true);
  });

  it("a Notification after the question was answered is a plain permission prompt, not the question", async () => {
    const s = seat();
    s.hook({ hook_event_name: "UserPromptSubmit" }, 0);
    s.hook({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_use_id: "toolu_ask", tool_input: { questions: QUESTION } }, 900);
    s.hook({ hook_event_name: "PermissionRequest", tool_name: "AskUserQuestion", tool_input: { questions: QUESTION } }, 2_000);
    s.lateReads(13, 1_000);
    s.hook({ hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", tool_use_id: "toolu_ask", tool_input: { questions: QUESTION } }, 5_000);   // answered
    s.hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_bash" }, 6_000);
    s.hook({ hook_event_name: "Notification", notification_type: "permission_prompt" }, 8_500);   // Bash's own approval prompt
    expect(s.store.getLatestRecorded(s.nodeId)).toMatchObject({ rawEvent: "Notification", state: "needs_input" });
    expect(s.store.getLatestRecorded(s.nodeId)!.dialog).toBeUndefined();
    expect(s.ports.stillAsking(s.nodeId, null)).toBe(false);
  });

  it("the question's own start, relayed async and stamped just after its dialog, is not the turn going on", async () => {
    const s = seat();
    s.hook({ hook_event_name: "UserPromptSubmit" }, 0);
    s.hook({ hook_event_name: "PermissionRequest", tool_name: "AskUserQuestion", tool_input: { questions: QUESTION } }, 2_000);
    s.hook({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_use_id: "toolu_ask", tool_input: { questions: QUESTION } }, 2_020);
    s.lateReads(13, 1_000);
    s.hook({ hook_event_name: "Notification", notification_type: "permission_prompt" }, 8_500);
    expect(s.store.getLatestRecorded(s.nodeId)).toMatchObject({ rawEvent: "Notification", dialog: "question" });
  });

  it("a tool started after the question's dialog (the question's end still in flight): the Notification is that tool's prompt", async () => {
    const s = seat();
    s.hook({ hook_event_name: "UserPromptSubmit" }, 0);
    s.hook({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_use_id: "toolu_ask", tool_input: { questions: QUESTION } }, 900);
    s.hook({ hook_event_name: "PermissionRequest", tool_name: "AskUserQuestion", tool_input: { questions: QUESTION } }, 2_000);
    s.lateReads(13, 1_000);
    s.hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_bash" }, 30_000);   // answered; the model went on
    s.hook({ hook_event_name: "Notification", notification_type: "permission_prompt" }, 31_000);       // Bash needs approval
    expect(s.store.getLatestRecorded(s.nodeId)!.dialog).toBeUndefined();
    expect(s.ports.stillAsking(s.nodeId, null)).toBe(false);
  });

  it("the window still applies the clearing rules: the question's own end, 26 rows on, clears it", async () => {
    const s = seat();
    s.hook({ hook_event_name: "UserPromptSubmit" }, 0);
    s.hook({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_use_id: "toolu_ask", tool_input: { questions: QUESTION } }, 900);
    s.hook({ hook_event_name: "PermissionRequest", tool_name: "AskUserQuestion", tool_input: { questions: QUESTION } }, 2_000);
    s.lateReads(13, 1_000);
    s.hook({ hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", tool_use_id: "toolu_ask", tool_input: { questions: QUESTION } }, 30_000);
    expect((await s.posture(31_000)).kind).toBe("busy");
    expect(s.ports.stillAsking(s.nodeId, null)).toBe(false);
  });

  it("a later async row stamped after a plain permission prompt still clears it, 26 rows on", async () => {
    const s = seat();
    s.hook({ hook_event_name: "UserPromptSubmit" }, 0);
    s.hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_bash" }, 500);
    s.hook({ hook_event_name: "Notification", notification_type: "permission_prompt" }, 2_000);
    s.lateReads(13, 1_000);
    s.hook({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "toolu_bash" }, 30_000); // approved and ran
    expect((await s.posture(31_000)).kind).toBe("busy");
  });

  it("with only async rows on record (no synchronous row in reach), the newest-stamped one is the latest, as before", async () => {
    const s = seat();
    for (let i = 0; i < 30; i += 1) s.hook({ hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: `toolu_read_${i}` }, 1_000 + i * 10);
    expect((await s.posture(2_000)).line).toMatch(/Read/);
  });
});
