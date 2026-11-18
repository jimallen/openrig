// workspaces-o9o.72: consumers that judged an unreadable process table as "no such process" at base, found by the
// o9o.67 census. Each row makes the table unreadable (a lister that rejects with ProcessTableUnavailableError, or a
// hermetic `ps` that exits 1) and pins that the consumer says "unknown" instead of a false verdict or a false reason;
// each has a control row with a readable table that lacks the process, which keeps today's answer.
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { activityRoutes } from "../src/routes/activity.js";
import { mockTmuxAdapter } from "./helpers/test-app.js";
import { deriveResumeToken } from "../src/domain/resume-token-capture.js";
import { ResumeMetadataRefresher } from "../src/domain/resume-metadata-refresher.js";
import { observeClaudePaneStartedAt } from "../src/domain/native-process-lineage.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { ProcessTableUnavailableError, type NativeProcessLister } from "../src/domain/native-process-lineage.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const unreadable: NativeProcessLister = async () => { throw new ProcessTableUnavailableError("fixture", new Error("ps exited 1")); };
const readableWithoutClaude: NativeProcessLister = async () => [
  { pid: 4242, ppid: 1, pgid: 4242, tpgid: 4242, executableName: "zsh", command: "-zsh", startedAt: "Mon Nov 16 22:00:00 2026" },
];

describe("o9o.72 A: claude resume never says retry_fresh on an unreadable process table", () => {
  function resumeWith(listProcesses: NativeProcessLister) {
    const tmux: TmuxAdapter = Object.assign(mockTmuxAdapter(), {
      // Only Claude's prompt glyph under a shell foreground: the screen says returned_to_shell, so the process proof decides.
      capturePaneContent: vi.fn(async () => "❯ "),
      getPaneCommand: vi.fn(async () => "zsh"),
      getPanePid: vi.fn(async () => 4242),
    });
    return new ClaudeResumeAdapter(tmux, { listProcesses, maxWaitMs: 0, pollMs: 1, sleep: async () => {} })
      .resume("worker@rig", "claude_id", "conv-1", "/tmp");
  }

  it("a shell foreground with Claude's prompt on screen and an unreadable table retains the launch (attention_required)", async () => {
    const result = await resumeWith(unreadable);
    expect(result).toMatchObject({ ok: false, code: "attention_required" });
    expect(result.ok ? "" : result.message).toContain("process table could not be read");
  });

  it("control: the same screen with a readable table that lacks Claude is still retry_fresh", async () => {
    expect(await resumeWith(readableWithoutClaude)).toMatchObject({ ok: false, code: "retry_fresh" });
  });
});

describe("o9o.72 B: a resume hook on an unreadable process table keeps the armed launch, never clears it unrecorded", () => {
  const original = "00000000-0000-4000-8000-000000000721";
  const rotated = "00000000-0000-4000-8000-000000000722";
  async function hookWith(listProcesses: NativeProcessLister) {
    const db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const rigRepo = new RigRepository(db), registry = new SessionRegistry(db), eventBus = new EventBus(db);
    const rig = rigRepo.createRig("o9o72");
    const node = rigRepo.addNode(rig.id, "test.c", { runtime: "claude-code" });
    const name = "test-c@o9o72";
    const session = registry.registerSession(node.id, name);
    registry.updateStatus(session.id, "running");
    registry.updateBinding(node.id, { tmuxSession: name, tmuxPane: "%1" });
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("tmuxAdapter" as never, { getPanePid: async () => 100 });
      c.set("listProcesses" as never, listProcesses);
      c.set("agentActivityStore" as never, new AgentActivityStore({ db, eventBus }));
      c.set("activityHookToken" as never, "fixture" as never);
      c.set("sessionRegistry" as never, registry);
      c.set("eventBus" as never, eventBus);
      await next();
    });
    app.route("/api/activity", activityRoutes);
    const post = (body: Record<string, unknown>) => app.request("/api/activity/hooks", { method: "POST",
      headers: { "content-type": "application/json", "x-openrig-activity-token": "fixture" },
      body: JSON.stringify({ eventFamily: "session_identity", sessionName: name, runtime: "claude-code", hookPid: 111, ...body }) });
    expect((await post({ sessionId: original })).status).toBe(200);
    registry.recordResumeLaunch(session.id, original);
    const generation = registry.currentOccupantTenure(node.id)!.generationUuid;
    const response = await post({ sessionId: rotated, source: "resume", generation, resumeLaunch: original, resumeLaunchFirst: true });
    expect(response.status).toBe(200);
    const row = db.prepare("SELECT resume_token, resume_launch_token, resume_rotated_from FROM sessions WHERE id = ?").get(session.id);
    db.close();
    return row;
  }

  it("the hook's token is stored and the launch stays armed, instead of being consumed with no rotation recorded", async () => {
    expect(await hookWith(unreadable)).toEqual({ resume_token: rotated, resume_launch_token: original, resume_rotated_from: null });
  });

  it("control: a readable table that does not hold the hook's process consumes the launch, as today", async () => {
    expect(await hookWith(readableWithoutClaude)).toEqual({ resume_token: rotated, resume_launch_token: null, resume_rotated_from: null });
  });
});

describe("o9o.72 E: a Claude sidecar is not captured as current while the process table is unreadable", () => {
  const token = "00000000-0000-4000-8000-000000000725";
  const store = { readSidecar: () => ({ ok: true as const, data: { session_id: token, sampled_at: "2026-11-17T01:00:00.000Z" } }) };
  const unreadableStart = async (): Promise<string | null> => { throw new ProcessTableUnavailableError("fixture", new Error("ps exited 1")); };
  const unknownStart = async (): Promise<string | null> => null;

  it("observeClaudePaneStartedAt rejects as unavailable on an unreadable table, and answers null when the table lacks Claude", async () => {
    const tmux = { getPanePid: async () => 4242 };
    await expect(observeClaudePaneStartedAt({ target: "%1", tmux, listProcesses: unreadable })).rejects.toBeInstanceOf(ProcessTableUnavailableError);
    expect(await observeClaudePaneStartedAt({ target: "%1", tmux, listProcesses: readableWithoutClaude })).toBeNull();
  });

  it("capture skips this cycle with process_table_unavailable", async () => {
    expect(await deriveResumeToken({ runtime: "claude-code", sessionName: "seat@rig" },
      { contextUsageStore: store, claudeProcessStartedAt: unreadableStart })).toEqual({ outcome: "skipped", reason: "process_table_unavailable" });
  });

  it("control: any other unknown start time still captures, as today", async () => {
    expect(await deriveResumeToken({ runtime: "claude-code", sessionName: "seat@rig" },
      { contextUsageStore: store, claudeProcessStartedAt: unknownStart })).toMatchObject({ outcome: "captured", token });
  });

  it.each([["unreadable", unreadableStart, false], ["unknown", unknownStart, true]] as const)(
    "the snapshot refresher's null-fill on an %s start time (writes only when merely unknown)", async (_label, claudeProcessStartedAt, writes) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const updateResumeToken = vi.fn();
      const refresher = new ResumeMetadataRefresher({
        sessionRegistry: { isForkClaimingHeldToken: () => false, updateResumeToken, clearResumeToken: vi.fn() },
        tmuxAdapter: {}, contextUsageStore: store, claudeProcessStartedAt,
      } as never);
      await refresher.refresh([{ sessionId: "s", sessionName: "seat@rig", runtime: "claude-code", resumeType: null, resumeToken: null }]);
      expect(updateResumeToken.mock.calls.length > 0).toBe(writes);
      vi.restoreAllMocks();
    });

  it.each([["unreadable", unreadableStart, false], ["unknown", unknownStart, true]] as const)(
    "the snapshot refresher's freshness re-stamp on an %s start time (stamps only when merely unknown)", async (_label, claudeProcessStartedAt, stamps) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const markResumeProbeResult = vi.fn();
      const refresher = new ResumeMetadataRefresher({
        sessionRegistry: { isForkClaimingHeldToken: () => false, updateResumeToken: vi.fn(), clearResumeToken: vi.fn(), markResumeProbeResult },
        tmuxAdapter: {}, contextUsageStore: store, claudeProcessStartedAt,
      } as never);
      await refresher.refresh([{ sessionId: "s", sessionName: "seat@rig", runtime: "claude-code", resumeType: "claude_id", resumeToken: token }], { fillNullOnly: true });
      expect(markResumeProbeResult.mock.calls.length > 0).toBe(stamps);
      vi.restoreAllMocks();
    });
});
