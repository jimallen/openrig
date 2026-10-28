import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { StartupOrchestrator, type StartupInput } from "../src/domain/startup-orchestrator.js";
import type { RuntimeAdapter, NodeBinding, ResolvedStartupFile, ProjectionResult, StartupDeliveryResult, ReadinessResult, HarnessLaunchResult } from "../src/domain/runtime-adapter.js";
import { resolveConcreteHint } from "../src/domain/runtime-adapter.js";
import type { ProjectionPlan } from "../src/domain/projection-planner.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { StartupAction } from "../src/domain/types.js";
import { deriveOriented, issueStartupChallenge, verifyStartupProof, STARTUP_PROOF_INSTRUCTION_LINE } from "../src/domain/startup-proof.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { AppliedLaunchObservationStore } from "../src/domain/applied-launch-observation-store.js";
import { observeClaudePermission } from "../src/domain/permission-drift.js";
import type { SettingsStore } from "../src/domain/user-settings/settings-store.js";
import { assessNativeResumeProbe } from "../src/domain/native-resume-probe.js";
import type { NativeProcessLister, NativeProcessRow } from "../src/domain/native-process-lineage.js";

// The pane is pid 100. A launcher shell (101) runs Claude (102) WITHOUT exec, so the pane's foreground name is a shell.
const T0 = "Wed Oct 28 08:00:00 2026";
const PANE_SHELL: NativeProcessRow = { pid: 100, ppid: 1, pgid: 100, tpgid: 101, executableName: "zsh", command: "-zsh", startedAt: T0 };
const LAUNCHER: NativeProcessRow = { pid: 101, ppid: 100, pgid: 101, tpgid: 101, executableName: "sh", command: "/bin/sh launch.sh", startedAt: T0 };
const CLAUDE_PROC: NativeProcessRow = { pid: 102, ppid: 101, pgid: 101, tpgid: 101, executableName: "2.1.285", command: "/home/u/.local/share/claude/versions/2.1.285 --permission-mode auto --resume tok-1", startedAt: T0 };
const PANE_WITH_CLAUDE: NativeProcessRow[] = [PANE_SHELL, LAUNCHER, CLAUDE_PROC];
const PANE_WITHOUT_CLAUDE: NativeProcessRow[] = [PANE_SHELL];

// -- Mocks --

function mockTmux(overrides?: Partial<TmuxAdapter>): TmuxAdapter {
  return {
    sendText: vi.fn(async () => ({ ok: true as const })),
    hasSession: vi.fn(async () => true),
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => []),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    getPaneCommand: vi.fn(async () => "claude"),
    getPanePid: vi.fn(async () => 100),
    capturePaneContent: vi.fn(async () => "❯ \n────────────────────\n⏵⏵ accept edits on (shift+tab to cycle)\n"),
    ...overrides,
  } as unknown as TmuxAdapter;
}

function mockAdapter(overrides?: Partial<RuntimeAdapter>): RuntimeAdapter {
  return {
    runtime: "claude-code",
    listInstalled: vi.fn(async () => []),
    project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
    deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
    checkReady: vi.fn(async () => ({ ready: true })),
    // A successful managed Claude resume returns the identity it resumed.
    launchHarness: vi.fn(async (_binding, opts) => ({ ok: true,
      ...(opts.resumeToken ? { resumeToken: opts.resumeToken, resumeType: "claude_id" } : {}) })),
    ...overrides,
  };
}

function emptyPlan(): ProjectionPlan {
  return { runtime: "claude-code", cwd: ".", entries: [], startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] };
}

function makeBinding(): NodeBinding {
  return { id: "b1", nodeId: "n1", tmuxSession: "r01-impl", tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "." };
}

function makeAction(overrides?: Partial<StartupAction>): StartupAction {
  return { type: "slash_command", value: "/test", phase: "after_ready", appliesOn: ["fresh_start", "restore"], idempotent: true, ...overrides };
}

function makeIdentityAction(overrides?: Partial<StartupAction>): StartupAction {
  return {
    type: "send_text",
    value: [
      "dev-impl@test-rig",
      "OpenRig session identity:",
      "- rig: test-rig",
      "- pod: dev",
      "- member: impl",
      "- logical_id: dev.impl",
      "- session: dev-impl@test-rig",
    ].join("\n"),
    phase: "after_ready",
    appliesOn: ["fresh_start", "restore"],
    idempotent: true,
    builtin: "session_identity",
    ...overrides,
  };
}

describe("StartupOrchestrator", () => {
  let db: Database.Database;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let rigRepo: RigRepository;
  let tmux: TmuxAdapter;

  beforeEach(() => {
    db = createFullTestDb();
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    rigRepo = new RigRepository(db);
    tmux = mockTmux();
  });

  afterEach(() => { db.close(); });

  function createOrchestrator(
    opts?: TmuxAdapter | { tmux?: TmuxAdapter; readFile?: (path: string) => string; readinessSettings?: Pick<SettingsStore, "resolveOne">; sleep?: (ms: number) => Promise<void>; listProcesses?: NativeProcessLister; now?: () => number },
  ): StartupOrchestrator {
    const normalized = opts && "sendText" in opts
      ? { tmux: opts as TmuxAdapter }
      : (opts ?? {});
    return new StartupOrchestrator({
      db,
      sessionRegistry,
      eventBus,
      tmuxAdapter: normalized.tmux ?? tmux,
      readFile: normalized.readFile,
      readinessSettings: normalized.readinessSettings ?? ({
        resolveOne: () => ({ value: 30, source: "default", defaultValue: 30 }),
      } as unknown as Pick<SettingsStore, "resolveOne">),
      sleep: normalized.sleep ?? (async () => {}),
      listProcesses: normalized.listProcesses ?? (async () => PANE_WITH_CLAUDE),
      ...(normalized.now ? { now: normalized.now } : {}),
    });
  }

  function seedSession(): { rigId: string; nodeId: string; sessionId: string } {
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "impl", { runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "r01-impl");
    sessionRegistry.updateStatus(session.id, "running");
    return { rigId: rig.id, nodeId: node.id, sessionId: session.id };
  }

  function makeInput(seed: { rigId: string; nodeId: string; sessionId: string }, overrides?: Partial<StartupInput>): StartupInput {
    return {
      rigId: seed.rigId,
      nodeId: seed.nodeId,
      sessionId: seed.sessionId,
      binding: makeBinding(),
      adapter: mockAdapter(),
      plan: emptyPlan(),
      resolvedStartupFiles: [],
      startupActions: [],
      isRestore: false,
      ...overrides,
    };
  }

  it.each([false, true])("returns projection and delivery warnings on launch outcomes (fails=%s)", async fails => {
    const seed = seedSession();
    const adapter = mockAdapter({
      project: vi.fn(async () => ({ projected: ["core"], skipped: [], failed: [], warnings: ["AGENTS.md is untracked"] })),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [], warnings: ["plugin exclude skipped"] })),
      launchHarness: vi.fn(async () => fails ? { ok: false, error: "controlled launch failure" } : { ok: true }),
    });
    const result = await createOrchestrator().startNode(makeInput(seed, { adapter }));
    expect(result.ok).toBe(!fails);
    expect(result.warnings).toEqual(["AGENTS.md is untracked", "plugin exclude skipped"]);
  });

  it("keeps a challenge-only transport failure best-effort", async () => {
    const seed = seedSession();
    const tmux = mockTmux({ sendText: vi.fn(async () => ({ ok: false as const, message: "fixture transport failure" })) });
    const result = await createOrchestrator(tmux).startNode(makeInput(seed, {
      startupActions: [makeAction({ type: "startup_proof", value: "authenticated" })],
    }));
    expect(result).toMatchObject({ ok: true, startupStatus: "ready" });
    expect(tmux.sendKeys).not.toHaveBeenCalled();
  });

  it("deliberate fresh replacement appends the named durable obligation read without an extra message", async () => {
    const seed = seedSession();
    await createOrchestrator().startNode(makeInput(seed, { startupActions: [makeIdentityAction()], includeDurableObligations: true }));
    expect(tmux.sendText).toHaveBeenCalledTimes(1);
    expect(tmux.sendText).toHaveBeenCalledWith("r01-impl", expect.stringContaining("rig queue list --destination r01-impl --state pending,in-progress,blocked"));
    expect(tmux.sendText).toHaveBeenCalledWith("r01-impl", expect.stringContaining(makeIdentityAction().value));
  });

  it("persists the authored context before a native gate and exposes only the matching continuation", async () => {
    const seed = seedSession(); const orch = createOrchestrator();
    const action = makeAction({ type: "send_text", value: "configured role and durable queue instructions" });
    const adapter = mockAdapter({ launchHarness: vi.fn(async () => ({ ok: false, recovery: "attention_required", error: "Hook review" })) });
    const result = await orch.startNode(makeInput(seed, { adapter, startupActions: [action] }));
    expect(result.startupStatus).toBe("attention_required");
    expect(JSON.parse((db.prepare("SELECT startup_actions_json FROM node_startup_context WHERE node_id=?").get(seed.nodeId) as {startup_actions_json:string}).startup_actions_json)).toEqual([action]);
    expect(orch.canContinueFresh(seed.nodeId, seed.sessionId)).toBe(true);
    expect(orch.canContinueFresh(seed.nodeId, "other-occupant")).toBe(false);
    eventBus.emit({ type: "node.startup_pending", rigId: seed.rigId, nodeId: seed.nodeId });
    expect(orch.canContinueFresh(seed.nodeId, seed.sessionId)).toBe(false);
  });

  it("records a role binding before launch succeeds and preserves it on exact resume", async () => {
    const seed = seedSession();
    const orch = createOrchestrator();
    const role: ResolvedStartupFile = { path: "role.md", absolutePath: "/fixture/role.md", ownerRoot: "/fixture", orientation: "role", deliveryHint: "send_text", required: true, appliesOn: ["fresh_start"] };
    const read = () => db.prepare("SELECT * FROM node_startup_context WHERE node_id=?").get(seed.nodeId) as { resolved_files_json: string; created_at: string };
    const adapter = mockAdapter({ launchHarness: vi.fn(async () => {
      expect(JSON.parse(read().resolved_files_json)).toEqual([role]);
      return { ok: false, recovery: "attention_required", error: "Native gate" };
    }) });
    expect((await orch.startNode(makeInput(seed, { adapter, resolvedStartupFiles: [role] }))).ok).toBe(false);
    const before = read();
    expect(before.created_at).toBeTruthy();
    await orch.startNode(makeInput(seed, { isRestore: true, resumeToken: "original", preserveStartupContext: true }));
    expect(read()).toEqual(before);
  });

  it("exact resume retains configured fresh context while sending no replay", async () => {
    const seed = seedSession(); const orch = createOrchestrator();
    const action = makeAction({ type: "send_text", value: "configured context" });
    await orch.startNode(makeInput(seed, { startupActions: [action] }));
    const before = db.prepare("SELECT * FROM node_startup_context WHERE node_id=?").get(seed.nodeId);
    const adapter = mockAdapter();
    const result = await orch.startNode(makeInput(seed, { adapter, isRestore: true, resumeToken: "native-original", preserveStartupContext: true }));
    expect(result.ok).toBe(true);
    expect(db.prepare("SELECT * FROM node_startup_context WHERE node_id=?").get(seed.nodeId)).toEqual(before);
    expect(adapter.deliverStartup).toHaveBeenCalledWith([], expect.anything());
  });

  it.each([
    { preserve: true, populated: false, calls: 0 },
    { preserve: true, populated: true, calls: 1 },
    { preserve: false, populated: false, calls: 1 },
  ])("projects resources only outside an empty preserved Claude plan: %j", async ({ preserve, populated, calls }) => {
    const adapter = mockAdapter();
    const plan = emptyPlan();
    if (populated) plan.entries.push({
      category: "runtime_resource", resourceType: "claude_activity_hooks", effectiveId: "activity",
      sourceSpec: "saved", sourcePath: "/fixture", resourcePath: "activity", absolutePath: "/fixture/activity",
      classification: "safe_projection",
    });
    const result = await createOrchestrator().startNode(makeInput(seedSession(), {
      adapter, plan, preserveStartupContext: preserve, isRestore: true, resumeToken: "native-original",
    }));
    expect(result.ok).toBe(true);
    expect(adapter.project).toHaveBeenCalledTimes(calls);
    if (calls) expect(adapter.project).toHaveBeenCalledWith(plan, expect.anything());
    expect(tmux.sendText).not.toHaveBeenCalled();
  });

  it.each([undefined, "claude_id", "claude_name", "codex_id"])("managed Claude resume agrees with the requested type: %s", async (resumeType) => {
    const seed = seedSession();
    const adapter = mockAdapter();
    const orch = createOrchestrator();
    const result = await orch.startNode(makeInput(seed, {
      adapter, isRestore: true, resumeToken: "requested-native", resumeType,
    }));
    const compatible = resumeType !== "codex_id";
    expect(result).toMatchObject(compatible
      ? { ok: true, startupStatus: "ready", continuityOutcome: "resumed" }
      : { ok: false, startupStatus: "attention_required" });
    expect(db.prepare("SELECT status, startup_status, resume_type, resume_token, resume_provenance FROM sessions WHERE id = ?").get(seed.sessionId))
      .toEqual({ status: "running", startup_status: compatible ? "ready" : "attention_required",
        resume_type: "claude_id", resume_token: "requested-native", resume_provenance: "scrape" });
    expect(adapter.launchHarness).toHaveBeenCalledOnce();
    expect(tmux.killSession).not.toHaveBeenCalled();
    expect(tmux.sendText).not.toHaveBeenCalled();
    if (!compatible) expect(orch.canContinueFresh(seed.nodeId, seed.sessionId)).toBe(false);
  });

  it.each(["missing", "late-hook"])("managed Claude resume checks final row agreement: %s", async (mode) => {
    const seed = seedSession();
    const token = "requested-native";
    const adapter = mockAdapter(mode === "missing"
      ? { launchHarness: vi.fn(async () => ({ ok: true })) } : {});
    const t = mockTmux({ sendText: vi.fn(async () => {
      sessionRegistry.updateResumeToken(seed.sessionId, "claude_id", "other-native", "hook");
      return { ok: true as const };
    }) });
    const orch = createOrchestrator({ tmux: t });
    const result = await orch.startNode(makeInput(seed, {
      adapter, resumeToken: token, isRestore: true,
      startupActions: mode === "late-hook" ? [makeAction()] : [],
    }));
    expect(result).toMatchObject({ ok: false, startupStatus: "attention_required" });
    expect(db.prepare("SELECT status, startup_status, resume_token, resume_provenance FROM sessions WHERE id = ?").get(seed.sessionId))
      .toEqual({ status: "running", startup_status: "attention_required",
        resume_token: mode === "late-hook" ? "other-native" : null, resume_provenance: mode === "late-hook" ? "hook" : null });
    expect(orch.canContinueFresh(seed.nodeId, seed.sessionId)).toBe(false);
    expect(adapter.launchHarness).toHaveBeenCalledOnce();
    expect(t.killSession).not.toHaveBeenCalled();
    expect(db.prepare("SELECT type FROM events WHERE node_id = ? AND type = 'node.startup_ready'").all(seed.nodeId)).toEqual([]);
  });

  it.each(["launch", "readiness"])("pod-aware exact resume cannot continue fresh context after a %s gate", async (gate) => {
    const seed = seedSession(); const orch = createOrchestrator();
    await orch.startNode(makeInput(seed, { startupActions: [makeIdentityAction()], includeDurableObligations: true }));
    const before = db.prepare("SELECT * FROM node_startup_context WHERE node_id=?").get(seed.nodeId);
    vi.mocked(tmux.sendText).mockClear();
    const adapter = mockAdapter(gate === "launch"
      ? { launchHarness: vi.fn(async () => ({ ok: false, recovery: "attention_required", error: "Hook review" })) }
      : { checkReady: vi.fn(async () => ({ ready: false, code: "hook_trust_gate", reason: "Hook review" })) });
    // RestoreOrchestrator's pod-aware exact-resume path contains replay via
    // empty files/actions, but uses isRestore:false to launch the native harness.
    const input = makeInput(seed, { adapter, isRestore: false, resumeToken: "native-original",
      resumeType: "claude_id", preserveStartupContext: true, allowFreshFallback: false });
    expect((await orch.startNode(input)).startupStatus).toBe("attention_required");
    expect(orch.canContinueFresh(seed.nodeId, seed.sessionId)).toBe(false);
    expect(createOrchestrator().canContinueFresh(seed.nodeId, seed.sessionId)).toBe(false);
    expect(db.prepare("SELECT * FROM node_startup_context WHERE node_id=?").get(seed.nodeId)).toEqual(before);
    expect(tmux.sendText).not.toHaveBeenCalled();
    const retry = await createOrchestrator().startNode({ ...input, adapter: mockAdapter() });
    expect(retry).toMatchObject({ ok: true, continuityOutcome: "resumed" });
    expect(tmux.sendText).not.toHaveBeenCalled();
  });

  // T1: fresh launch enters pending before startup delivery
  it("marks pending before delivery", async () => {
    const seed = seedSession();
    const adapter = mockAdapter();
    let statusDuringProject = "";
    (adapter.project as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      const row = db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(seed.sessionId) as { startup_status: string };
      statusDuringProject = row.startup_status;
      return { projected: [], skipped: [], failed: [] };
    });

    const orch = createOrchestrator();
    await orch.startNode(makeInput(seed, { adapter }));
    expect(statusDuringProject).toBe("pending");
  });

  // T2: successful startup transitions to ready
  it("successful startup transitions to ready", async () => {
    const seed = seedSession();
    const orch = createOrchestrator();
    const result = await orch.startNode(makeInput(seed));
    expect(result.ok).toBe(true);
    expect(result.startupStatus).toBe("ready");

    const row = db.prepare("SELECT startup_status, startup_completed_at FROM sessions WHERE id = ?").get(seed.sessionId) as { startup_status: string; startup_completed_at: string | null };
    expect(row.startup_status).toBe("ready");
    expect(row.startup_completed_at).not.toBeNull();
  });
  it.each(["codex_client_incompatible", "hook_trust_gate"])("does not mark ready when context delivery exposes %s", async (code) => {
    const seed = seedSession();
    let delivered = false;
    const adapter = mockAdapter({
      runtime: "codex",
      deliverStartup: vi.fn(async (files) => { if (files.some((file) => file.deliveryHint === "send_text")) delivered = true; return { delivered: files.length, failed: [] }; }),
      checkReady: vi.fn(async () => delivered
        ? { ready: false, code, reason: "The native runtime requires attention" }
        : { ready: true }),
    });
    const result = await createOrchestrator().startNode(makeInput(seed, { adapter,
      resolvedStartupFiles: [{ path: "role.md", absolutePath: "/tmp/role.md", ownerRoot: "/tmp",
        deliveryHint: "send_text", required: true, appliesOn: ["fresh_start"] }] }));
    expect(result).toMatchObject({ ok: false, startupStatus: "attention_required" });
    expect(db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(seed.sessionId)).toEqual({ startup_status: "attention_required" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM node_startup_context WHERE node_id = ?").get(seed.nodeId)).toEqual({ n: 1 });
  });

  it.each(["initial_identity", "restore_preload", "after_ready"])("reports a trust dialog after %s instead of startup ready", async (source) => {
    const seed = seedSession();
    let delivered = false;
    // Claude 2.1.220's observed trust panel, with the project path replaced.
    const trust = "Accessing workspace:\n/fixture/project\nQuick safety check: Is this a project you created or one you trust?\n❯ 1. Yes, I trust this folder\n  2. No, exit\nEnter to confirm · Esc to cancel";
    const t = mockTmux({ sendText: vi.fn(async () => { delivered = true; return { ok: true as const }; }),
      capturePaneContent: vi.fn(async () => trust) });
    const adapter = mockAdapter({ checkReady: vi.fn(async () => {
      const probe = assessNativeResumeProbe({ runtime: "claude-code", paneCommand: "claude",
        paneContent: delivered ? trust : "Claude Code v2.1.220\n❯ \n? for shortcuts" });
      return { ready: probe.status === "resumed", code: probe.code, reason: probe.detail };
    }) });
    const result = await createOrchestrator({ tmux: t, readFile: () => "Read the project instructions." }).startNode(makeInput(seed, {
      adapter, isRestore: source === "restore_preload",
      ...(source === "restore_preload" ? { resumeToken: "native-original", resumeType: "claude_id" } : {}),
      resolvedStartupFiles: source === "after_ready" ? [] : [{ path: "role.md", absolutePath: "/fixture/role.md",
        ownerRoot: "/fixture", deliveryHint: "send_text", required: true, appliesOn: ["fresh_start", "restore"] }],
      startupActions: [source === "initial_identity" ? makeIdentityAction() : makeAction({ type: "send_text", value: "Read the project instructions." })],
    }));
    expect(result).toMatchObject({ ok: false, startupStatus: "attention_required",
      errors: [expect.stringContaining("workspace trust approval")] });
    // Launch readiness, the post-delivery read, and (OF-161) one more read after a resume has had time to exit.
    expect(adapter.checkReady).toHaveBeenCalledTimes(source === "restore_preload" ? 3 : 2);
    expect(t.sendText).toHaveBeenCalledTimes(1);
    expect(t.sendKeys).toHaveBeenCalledTimes(1); // no extra Enter into the trust menu
    expect(t.killSession).not.toHaveBeenCalled();
    expect(db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(seed.sessionId)).toEqual({ startup_status: "attention_required" });
    expect(db.prepare("SELECT type FROM events WHERE node_id = ? AND type = 'node.startup_ready'").all(seed.nodeId)).toEqual([]);
  });

  it.each(["bundled", "file"])("keeps an unavailable post-%s observation unverified without failing startup", async (delivery) => {
    const seed = seedSession();
    const adapter = mockAdapter({ checkReady: vi.fn().mockResolvedValueOnce({ ready: true })
      .mockRejectedValueOnce(new Error("fixture capture unavailable")) });
    const result = await createOrchestrator({ readFile: () => "Read the project instructions." }).startNode(makeInput(seed, {
      adapter, resolvedStartupFiles: [{ path: "role.md", absolutePath: "/fixture/role.md", ownerRoot: "/fixture",
        deliveryHint: "send_text", required: true, appliesOn: ["fresh_start"] }],
      startupActions: delivery === "bundled" ? [makeIdentityAction()] : [],
    }));
    expect(result).toMatchObject({ ok: true, startupStatus: "ready", submission: { status: "unverified",
      reasons: ["Post-delivery runtime state is unverified: fixture capture unavailable"] } });
    expect(adapter.checkReady).toHaveBeenCalledTimes(2);
    const event = db.prepare("SELECT payload FROM events WHERE node_id = ? AND type = 'node.startup_ready'").get(seed.nodeId) as { payload: string };
    expect(JSON.parse(event.payload).submission).toMatchObject({ status: "unverified" });
    expect(tmux.killSession).not.toHaveBeenCalled();
  });

  it("records the exact adapter-returned launch effect only after successful managed launch", async () => {
    const seed = seedSession();
    const appliedLaunch = observeClaudePermission("--permission-mode acceptEdits");
    const adapter = mockAdapter({ launchHarness: vi.fn(async () => ({ ok: true, appliedLaunch })) });
    const result = await createOrchestrator().startNode(makeInput(seed, { adapter }));
    expect(result.ok).toBe(true);
    expect(new AppliedLaunchObservationStore(db).readCurrent(seed.nodeId)).toMatchObject(appliedLaunch);
  });

  it("binds a delayed launch observation to the generation that actually launched", async () => {
    const seed = seedSession();
    const launchedGeneration = sessionRegistry.currentOccupantTenure(seed.nodeId)!.generationUuid;
    let releaseLaunch!: () => void;
    const launchGate = new Promise<void>((resolve) => { releaseLaunch = resolve; });
    const adapter = mockAdapter({
      launchHarness: vi.fn(async () => {
        await launchGate;
        return { ok: true as const, appliedLaunch: observeClaudePermission("--permission-mode acceptEdits") };
      }),
    });

    const pending = createOrchestrator().startNode(makeInput(seed, { adapter }));
    await vi.waitFor(() => expect(adapter.launchHarness).toHaveBeenCalledTimes(1));
    sessionRegistry.mintOccupantTenure(seed.nodeId, "handover");
    releaseLaunch();
    expect((await pending).ok).toBe(true);

    expect(new AppliedLaunchObservationStore(db).readCurrent(seed.nodeId)).toBeNull();
    expect(db.prepare("SELECT generation_uuid FROM applied_launch_observations").get()).toEqual({
      generation_uuid: launchedGeneration,
    });
  });

  it("never resurrects an invalidated generation when delayed readiness completes", async () => {
    const seed = seedSession();
    const generation = sessionRegistry.currentOccupantTenure(seed.nodeId)!.generationUuid;
    let releaseReady!: () => void;
    const readyGate = new Promise<void>((resolve) => { releaseReady = resolve; });
    const adapter = mockAdapter({
      launchHarness: vi.fn(async () => ({ ok: true as const, appliedLaunch: observeClaudePermission("--permission-mode acceptEdits") })),
      checkReady: vi.fn(async () => {
        await readyGate;
        return { ready: true as const };
      }),
    });

    const pending = createOrchestrator().startNode(makeInput(seed, { adapter }));
    await vi.waitFor(() => expect(adapter.checkReady).toHaveBeenCalledTimes(1));
    expect(new AppliedLaunchObservationStore(db).invalidateGeneration(generation)).toBe(true);
    releaseReady();
    expect((await pending).ok).toBe(true);

    expect(new AppliedLaunchObservationStore(db).readCurrent(seed.nodeId)).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM applied_launch_observations WHERE generation_uuid = ?").get(generation)).toEqual({ n: 0 });
  });

  it("does not record an attempted effect when the managed launch fails", async () => {
    const seed = seedSession();
    const adapter = mockAdapter({ launchHarness: vi.fn(async () => ({ ok: false, error: "provider refused" })) });
    const result = await createOrchestrator().startNode(makeInput(seed, { adapter }));
    expect(result.ok).toBe(false);
    expect(new AppliedLaunchObservationStore(db).readCurrent(seed.nodeId)).toBeNull();
  });

  it("keeps a successful provider launch successful when observation persistence is unavailable", async () => {
    const seed = seedSession();
    db.exec("DROP TABLE applied_launch_observations");
    const adapter = mockAdapter({
      launchHarness: vi.fn(async () => ({ ok: true, appliedLaunch: observeClaudePermission("--permission-mode acceptEdits") })),
    });
    const result = await createOrchestrator().startNode(makeInput(seed, { adapter }));
    expect(result.ok).toBe(true);
    expect(result.startupStatus).toBe("ready");
  });

  // T3: delivery failure transitions to failed
  it("delivery failure transitions to failed", async () => {
    const seed = seedSession();
    const adapter = mockAdapter({
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [{ path: "startup.md", error: "disk full" }] })),
    });
    const orch = createOrchestrator();
    const result = await orch.startNode(makeInput(seed, {
      adapter,
      resolvedStartupFiles: [{ path: "startup.md", absolutePath: "/tmp/startup.md", ownerRoot: "/tmp", deliveryHint: "guidance_merge", required: true, appliesOn: ["fresh_start", "restore"] }],
    }));
    expect(result.ok).toBe(false);
    expect(result.startupStatus).toBe("failed");

    const row = db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(seed.sessionId) as { startup_status: string };
    expect(row.startup_status).toBe("failed");
  });

  // T4: action failure transitions to failed
  it("action failure transitions to failed", async () => {
    const seed = seedSession();
    const failTmux = mockTmux({ sendText: vi.fn(async () => ({ ok: false as const, message: "session gone" })) });
    const orch = createOrchestrator({ tmux: failTmux });
    const actions: StartupAction[] = [makeAction({ phase: "after_ready" })];
    const result = await orch.startNode(makeInput(seed, { startupActions: actions }));
    expect(result.ok).toBe(false);
    expect(result.startupStatus).toBe("failed");
  });

  // T5: new startup sequence: project → pre-launch deliver → launchHarness → checkReady → post-launch deliver → after_files → after_ready
  it("startup sequence: pre-launch deliver before launchHarness; after_files after post-launch; after_ready last", async () => {
    const seed = seedSession();
    const callOrder: string[] = [];

    const adapter = mockAdapter({
      project: vi.fn(async () => { callOrder.push("project"); return { projected: [], skipped: [], failed: [] }; }),
      deliverStartup: vi.fn(async () => { callOrder.push("deliver"); return { delivered: 1, failed: [] }; }),
      launchHarness: vi.fn(async () => { callOrder.push("launchHarness"); return { ok: true }; }),
      checkReady: vi.fn(async () => { callOrder.push("checkReady"); return { ready: true }; }),
    });

    const t = mockTmux({
      sendText: vi.fn(async (target: string, text: string) => {
        callOrder.push(`action:${text}`);
        return { ok: true as const };
      }),
    });

    const orch = createOrchestrator({ tmux: t });
    const actions: StartupAction[] = [
      makeAction({ phase: "after_files", value: "/after-files-cmd" }),
      makeAction({ phase: "after_ready", value: "/after-ready-cmd" }),
    ];
    const files = [
      { path: "culture.md", absolutePath: "/tmp/culture.md", ownerRoot: "/tmp", deliveryHint: "guidance_merge" as const, required: true, appliesOn: ["fresh_start" as const, "restore" as const] },
      { path: "priming.txt", absolutePath: "/tmp/priming.txt", ownerRoot: "/tmp", deliveryHint: "send_text" as const, required: false, appliesOn: ["fresh_start" as const] },
    ];
    await orch.startNode(makeInput(seed, { adapter, startupActions: actions, resolvedStartupFiles: files }));

    const projectIdx = callOrder.indexOf("project");
    const launchIdx = callOrder.indexOf("launchHarness");
    const checkReadyIdx = callOrder.indexOf("checkReady");
    const afterFilesIdx = callOrder.indexOf("action:/after-files-cmd");
    const afterReadyIdx = callOrder.indexOf("action:/after-ready-cmd");

    // deliver is called twice (pre-launch + post-launch), but we verify order via launchHarness position
    expect(launchIdx).toBeGreaterThan(projectIdx);
    expect(checkReadyIdx).toBeGreaterThan(launchIdx);
    expect(afterFilesIdx).toBeGreaterThan(checkReadyIdx);
    expect(afterReadyIdx).toBeGreaterThan(afterFilesIdx);
  });

  // Slice 51-01 stub-runtime — TEST-ONLY RED (undisputed mechanical FACT 3): the REAL StubRuntimeAdapter,
  // driven through the REAL StartupOrchestrator, must ride the ordered sequence project → pre-launch
  // deliver → launchHarness → checkReady → post-launch deliver and reach `ready`. Dynamic import keeps
  // this file's other tests green; RED now because the adapter module is absent. Fully executable after
  // the import: a BARE `StubRuntimeAdapter` export fails (methods absent/wrong ⇒ startNode never reaches
  // ready and deliver is not invoked twice). A send_text-hinted file forces the post-launch phase.
  // Requires the stub's hermetic testability (a determinism/hermetic design property of the shape).
  // Encodes NO disputed hook/usage_limit/compaction/packaging surface. Construction deps are
  // provisional-to-design, finalized when the adapter ships (post fresh Guard CLEAR).
  it("FACT3: real stub adapter rides ordered project→pre-deliver→launch→ready→post-deliver to ready", async () => {
    const { StubRuntimeAdapter } = await import("../src/adapters/stub-runtime-adapter.js") as { StubRuntimeAdapter: new (deps: unknown) => RuntimeAdapter }; // RED now: module absent
    const seed = seedSession();
    const t = mockTmux();
    const adapter = new StubRuntimeAdapter({ tmux: t, runtime: "stub" });
    const projectSpy = vi.spyOn(adapter, "project");
    const deliverSpy = vi.spyOn(adapter, "deliverStartup");
    const launchSpy = vi.spyOn(adapter, "launchHarness");
    const readySpy = vi.spyOn(adapter, "checkReady");
    const files = [
      { path: "priming.txt", absolutePath: "/tmp/priming.txt", ownerRoot: "/tmp", deliveryHint: "send_text" as const, required: false, appliesOn: ["fresh_start" as const] },
    ];
    const result = await createOrchestrator({ tmux: t }).startNode(makeInput(seed, { adapter, resolvedStartupFiles: files }));
    expect(result.startupStatus, "the real stub must reach ready through the real orchestrator").toBe("ready");
    expect(deliverSpy, "deliverStartup must run on BOTH sides of launch").toHaveBeenCalledTimes(2);
    const pIdx = projectSpy.mock.invocationCallOrder[0]!;
    const preDeliver = deliverSpy.mock.invocationCallOrder[0]!;
    const lIdx = launchSpy.mock.invocationCallOrder[0]!;
    const rIdx = readySpy.mock.invocationCallOrder[0]!;
    const postDeliver = deliverSpy.mock.invocationCallOrder[1]!;
    expect(pIdx).toBeLessThan(preDeliver);
    expect(preDeliver).toBeLessThan(lIdx);
    expect(lIdx).toBeLessThan(rIdx);
    expect(rIdx).toBeLessThan(postDeliver);
  });

  // T6: non-idempotent restore action is skipped
  it("non-idempotent action skipped on restore", async () => {
    const seed = seedSession();
    const orch = createOrchestrator();
    const actions: StartupAction[] = [
      makeAction({ value: "/setup-once", idempotent: false, appliesOn: ["fresh_start"] }),
    ];
    const result = await orch.startNode(makeInput(seed, { startupActions: actions, isRestore: true }));
    expect(result.ok).toBe(true);
    // Neither an inapplicable action nor an unselected proof is sent.
    const calls = (tmux.sendText as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1]);
    expect(calls).toEqual([]);
  });

  // T7: idempotent restore action replays safely
  it("idempotent action replays on restore", async () => {
    const seed = seedSession();
    const orch = createOrchestrator();
    const actions: StartupAction[] = [
      makeAction({ value: "/rename impl", idempotent: true, appliesOn: ["fresh_start", "restore"] }),
    ];
    const result = await orch.startNode(makeInput(seed, { startupActions: actions, isRestore: true }));
    expect(result.ok).toBe(true);
    expect(tmux.sendText).toHaveBeenCalledWith("r01-impl", "/rename impl");
  });

  it("submits startup actions after sending text", async () => {
    const seed = seedSession();
    const orch = createOrchestrator();
    const actions: StartupAction[] = [makeAction({ value: "/rename impl" })];

    const result = await orch.startNode(makeInput(seed, { startupActions: actions }));

    expect(result.ok).toBe(true);
    expect(tmux.sendText).toHaveBeenCalledWith("r01-impl", "/rename impl");
    expect(tmux.sendKeys).toHaveBeenCalledWith("r01-impl", ["Enter"]);
  });

  // T8: operator debug append executes after resolved startup
  it("operator debug actions execute in startup sequence", async () => {
    const seed = seedSession();
    const orch = createOrchestrator();
    // Operator debug actions are just regular actions added last by the startup resolver
    const actions: StartupAction[] = [
      makeAction({ value: "/debug-overlay", phase: "after_ready" }),
    ];
    const result = await orch.startNode(makeInput(seed, { startupActions: actions }));
    expect(result.ok).toBe(true);
    expect(tmux.sendText).toHaveBeenCalledWith("r01-impl", "/debug-overlay");
  });

  // T9: reconciler reports failed startup state
  it("failed startup visible in session query", async () => {
    const seed = seedSession();
    const adapter = mockAdapter({
      checkReady: vi.fn(async () => ({ ready: false, reason: "not responding" })),
    });
    const orch = createOrchestrator();
    await orch.startNode(makeInput(seed, { adapter, readinessTimeoutMs: 100 }));

    // Session should show failed startup
    const sessions = sessionRegistry.getSessionsForRig(seed.rigId);
    const session = sessions.find((s) => s.id === seed.sessionId);
    expect(session).toBeDefined();
    expect(session!.startupStatus).toBe("failed");
  });

  it("recoverable interactive startup blockers become attention_required", async () => {
    const seed = seedSession();
    const adapter = mockAdapter({
      checkReady: vi.fn(async () => ({
        ready: false,
        code: "trust_gate",
        reason: "Claude is waiting for workspace trust approval before the session can become interactive.",
      })),
    });
    const orch = createOrchestrator();
    const result = await orch.startNode(makeInput(seed, { adapter }));

    expect(result.ok).toBe(false);
    expect(result.startupStatus).toBe("attention_required");

    const row = db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(seed.sessionId) as { startup_status: string };
    expect(row.startup_status).toBe("attention_required");
  });

  it("Claude MCP approval blockers become attention_required", async () => {
    const seed = seedSession();
    const adapter = mockAdapter({
      checkReady: vi.fn(async () => ({
        ready: false,
        code: "mcp_gate",
        reason: "Claude is waiting for project MCP server approval before the session can become interactive.",
      })),
    });
    const orch = createOrchestrator();
    const result = await orch.startNode(makeInput(seed, { adapter }));

    expect(result.ok).toBe(false);
    expect(result.startupStatus).toBe("attention_required");

    const row = db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(seed.sessionId) as { startup_status: string };
    expect(row.startup_status).toBe("attention_required");
  });

  it("injects the session identity into the first fresh send_text prompt", async () => {
    const seed = seedSession();
    const deliverStartup = vi.fn(async (_files: ResolvedStartupFile[]) => ({ delivered: 0, failed: [] }));
    const adapter = mockAdapter({
      deliverStartup,
    });
    const sendText = vi.fn(async (...args: unknown[]) => ({ ok: true as const }));
    const tmuxOverride = mockTmux({ sendText });
    const orch = createOrchestrator({
      tmux: tmuxOverride,
      readFile: (path) => path === "/tmp/role.md" ? "Role instructions go here." : "",
    });

    const result = await orch.startNode(makeInput(seed, {
      adapter,
      resolvedStartupFiles: [{
        path: "guidance/role.md",
        absolutePath: "/tmp/role.md",
        ownerRoot: "/tmp",
        deliveryHint: "send_text",
        required: true,
        appliesOn: ["fresh_start"],
      }],
      startupActions: [
        makeIdentityAction(),
        makeAction({ value: "/rename impl" }),
      ],
    }));

    expect(result).toEqual({
      ok: true,
      startupStatus: "ready",
      continuityOutcome: "fresh",
    });
    expect(sendText).toHaveBeenNthCalledWith(1, "r01-impl", expect.any(String));
    const firstPrompt = sendText.mock.calls[0]?.[1];
    expect(firstPrompt).toContain("dev-impl@test-rig");
    expect(firstPrompt).toContain("OpenRig session identity:");
    expect(firstPrompt).toContain("Role instructions go here.");
    expect(sendText).toHaveBeenNthCalledWith(2, "r01-impl", "/rename impl");
    expect(deliverStartup).toHaveBeenCalledTimes(1);
  });

  it("does not replay the session identity on a resumed restore", async () => {
    const seed = seedSession();
    const sendText = vi.fn(async () => ({ ok: true as const }));
    const tmuxOverride = mockTmux({ sendText });
    const orch = createOrchestrator({ tmux: tmuxOverride });

    const result = await orch.startNode(makeInput(seed, {
      startupActions: [
        makeIdentityAction(),
        makeAction({ value: "/rename impl" }),
      ],
      isRestore: true,
      resumeToken: "claude-session-123",
    }));

    expect(result).toEqual({
      ok: true,
      startupStatus: "ready",
      continuityOutcome: "resumed",
    });
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith("r01-impl", "/rename impl");
  });

  // OPR.0.4.7.17 restore-order-correction (qitem-e99624f7). On a real automatic
  // Codex restore the daemon delivered the work-triggering guidance/role.md FIRST
  // (its turn ran skill-metadata checks + `rig whoami`), and the after_ready
  // "BEFORE you do anything else" preload action landed only afterwards — so
  // non-skill work preceded the action, breaking the locked action-before-work
  // contract. The fix must be CAUSAL (sequence the preload ahead of the
  // role-triggered turn), not a larger send delay. This pin asserts the contract
  // shape-agnostically: across the ordered provider inputs (send_text sends AND
  // post-launch send_text file deliveries), the preload text is delivered no
  // later than the role.md work-trigger content, and when bundled into one input
  // the preload text precedes the role content.
  it("restore: the after_ready preload action is sequenced before the role.md work-trigger", async () => {
    const seed = seedSession();
    const ROLE = "# Role: QA\nload your named skills: using-superpowers, test-driven-development";
    const PRELOAD = "A task is coming. BEFORE you do anything else, load and invoke your process skills NOW: using-superpowers, test-driven-development. Load them first, then begin the work.";

    // Unified ordered list of provider inputs (what actually reaches the pane).
    const inputs: string[] = [];
    const deliverStartup = vi.fn(async (files: ResolvedStartupFile[]) => {
      for (const f of files) {
        if (f.deliveryHint === "send_text") inputs.push(f.absolutePath === "/tmp/role.md" ? ROLE : "");
      }
      return { delivered: 0, failed: [] };
    });
    const adapter = mockAdapter({ deliverStartup });
    const sendText = vi.fn(async (_session: string, text: string) => { inputs.push(text); return { ok: true as const }; });
    const tmuxOverride = mockTmux({ sendText });
    const orch = createOrchestrator({
      tmux: tmuxOverride,
      readFile: (path) => path === "/tmp/role.md" ? ROLE : "",
    });

    const result = await orch.startNode(makeInput(seed, {
      adapter,
      resolvedStartupFiles: [{
        path: "guidance/role.md",
        absolutePath: "/tmp/role.md",
        ownerRoot: "/tmp",
        deliveryHint: "send_text",
        required: true,
        appliesOn: ["fresh_start", "restore"],
      }],
      startupActions: [
        makeAction({ type: "send_text", value: PRELOAD, phase: "after_ready", appliesOn: ["fresh_start", "restore"], idempotent: true }),
      ],
      isRestore: true,
      resumeToken: "codex-session-abc",
    }));

    expect(result.ok).toBe(true);

    const preloadIdx = inputs.findIndex((t) => t.includes("BEFORE you do anything else"));
    const roleIdx = inputs.findIndex((t) => t.includes("# Role: QA"));
    expect(preloadIdx).toBeGreaterThanOrEqual(0); // the preload action reached the provider
    expect(roleIdx).toBeGreaterThanOrEqual(0);    // the role.md work-trigger reached the provider

    // CONTRACT: the preload must not land after the role.md work-trigger.
    expect(preloadIdx).toBeLessThanOrEqual(roleIdx);
    // If bundled into a single input, the preload text must precede the role content.
    if (preloadIdx === roleIdx) {
      const payload = inputs[preloadIdx]!;
      expect(payload.indexOf("BEFORE you do anything else")).toBeLessThan(payload.indexOf("# Role: QA"));
    }
    // And the preload must not be re-sent as a duplicate separate turn.
    const preloadDeliveries = inputs.filter((t) => t.includes("BEFORE you do anything else")).length;
    expect(preloadDeliveries).toBe(1);
  });

  it("sends the identity prompt first when restore falls back to a fresh launch", async () => {
    const seed = seedSession();
    const sendText = vi.fn(async () => ({ ok: true as const }));
    const tmuxOverride = mockTmux({ sendText });
    const adapter = mockAdapter({
      runtime: "codex",
      launchHarness: vi.fn()
        .mockResolvedValueOnce({ ok: false as const, error: "saved session missing", recovery: "retry_fresh" })
        .mockResolvedValueOnce({ ok: true as const, resumeToken: "fresh-token", resumeType: "codex_id" }),
    });
    const orch = createOrchestrator({ tmux: tmuxOverride });

    const result = await orch.startNode(makeInput(seed, {
      adapter,
      isRestore: true,
      resumeToken: "stale-token",
      startupActions: [
        makeIdentityAction(),
        makeAction({ value: "/rename impl" }),
      ],
    }));

    expect(result).toEqual({
      ok: true,
      startupStatus: "ready",
      continuityOutcome: "fresh",
    });
    expect(sendText).toHaveBeenNthCalledWith(
      1,
      "r01-impl",
      expect.stringContaining("dev-impl@test-rig"),
    );
    expect(sendText).toHaveBeenNthCalledWith(2, "r01-impl", "/rename impl");
  });

  // OF-75: a resume token an adapter reports is stored only when it is well-formed for the runtime. The stored
  // token is later typed into a pane by restore and by the resume probe, so a hostile one must never be recorded.
  it.each([
    ["a shell separator", "tok;touch-x"],
    ["a space", "tok en"],
    ["a quote", "tok'x"],
    ["a command substitution", "$(touch-x)"],
    ["a newline", "tok\nx"],
  ])("does not store a reported claude token holding %s", async (_label, token) => {
    const seed = seedSession();
    const adapter = mockAdapter({ launchHarness: vi.fn(async () => ({ ok: true as const, resumeToken: token, resumeType: "claude_id" })) });
    const result = await createOrchestrator().startNode(makeInput(seed, { adapter }));
    expect(result.ok).toBe(true);
    expect(db.prepare("SELECT resume_token, resume_type FROM sessions WHERE id = ?").get(seed.sessionId)).toEqual({ resume_token: null, resume_type: null });
  });

  it.each(["abc-123", "0f8fad5b-d9cb-469f-a165-70867728950e", "a.b_c-1"])("control: stores a well-formed reported claude token (%s)", async (token) => {
    const seed = seedSession();
    const adapter = mockAdapter({ launchHarness: vi.fn(async () => ({ ok: true as const, resumeToken: `  ${token}  `, resumeType: "claude_id" })) });
    await createOrchestrator().startNode(makeInput(seed, { adapter }));
    expect(db.prepare("SELECT resume_token, resume_type FROM sessions WHERE id = ?").get(seed.sessionId)).toEqual({ resume_token: token, resume_type: "claude_id" });
  });

  // KNOWN GAP (OF-75, by decision): a runtime with no resume type (terminal, unknown) has no token format to check,
  // so a token its adapter reports is stored trimmed as before. Nothing types such a token: the resume probe and the
  // restore launch lines are built only for claude-code and codex. A format for these runtimes is a separate decision.
  it("KNOWN GAP: a token reported by a runtime with no resume type is still stored, trimmed", async () => {
    const seed = seedSession();
    const adapter = mockAdapter({ runtime: "terminal", launchHarness: vi.fn(async () => ({ ok: true as const, resumeToken: "  tok;x  ", resumeType: "terminal_id" })) });
    await createOrchestrator().startNode(makeInput(seed, { adapter }));
    expect(db.prepare("SELECT resume_token FROM sessions WHERE id = ?").get(seed.sessionId)).toEqual({ resume_token: "tok;x" });
  });

  it("issues a selected startup challenge (oriented=missing, challenge in prompt)", async () => {
    const seed = seedSession();
    const sendText = vi.fn(async (...args: unknown[]) => ({ ok: true as const }));
    const orch = createOrchestrator({ tmux: mockTmux({ sendText }) });

    await orch.startNode(makeInput(seed, {
      resolvedStartupFiles: [{ path: "role.md", absolutePath: "/tmp/role.md", ownerRoot: "/tmp", deliveryHint: "guidance_merge", required: true, appliesOn: ["fresh_start"] }],
      startupActions: [makeAction({ type: "startup_proof", value: "authenticated" }), makeIdentityAction()],
    }));

    const challenged = db.prepare("SELECT COUNT(*) AS n FROM events WHERE node_id = ? AND type = 'node.startup_challenged'").get(seed.nodeId) as { n: number };
    expect(challenged.n).toBe(1);
    expect(deriveOriented(db, seed.nodeId)).toBe("missing");
    // The challenge instruction is embedded in the first delivered prompt.
    expect(sendText.mock.calls[0]?.[1]).toContain("startup orientation challenge");
  });

  // Claude shows the long startup paste as pasted content and won't act on an instruction found only
  // there; one short line in the person's turn asks it to run the challenge's own command.
  describe("the Claude startup-proof line", () => {
    const challengeAndIdentity = () => [makeAction({ type: "startup_proof", value: "authenticated" }), makeIdentityAction()];

    it("follows a Claude seat's challenged prompt with the short line, as its own submission", async () => {
      const seed = seedSession();
      const sendText = vi.fn(async (_session: string, _text: string) => ({ ok: true as const }));
      const result = await createOrchestrator({ tmux: mockTmux({ sendText }) }).startNode(makeInput(seed, { startupActions: challengeAndIdentity() }));
      expect(result).toMatchObject({ ok: true, startupStatus: "ready" });
      expect(sendText.mock.calls.map((c) => c[1])).toHaveLength(2);
      expect(sendText.mock.calls[0]![1]).toContain("startup orientation challenge");
      expect(sendText.mock.calls[1]![1]).toBe(STARTUP_PROOF_INSTRUCTION_LINE);
      expect(deriveOriented(db, seed.nodeId)).toBe("missing");
    });

    it("sends no line to a Codex seat, which already acts on the pasted challenge", async () => {
      const seed = seedSession();
      const sendText = vi.fn(async (_session: string, _text: string) => ({ ok: true as const }));
      await createOrchestrator({ tmux: mockTmux({ sendText }) }).startNode(makeInput(seed, {
        adapter: mockAdapter({ runtime: "codex" }), startupActions: challengeAndIdentity(),
      }));
      expect(sendText.mock.calls.map((c) => c[1])).not.toContain(STARTUP_PROOF_INSTRUCTION_LINE);
    });

    it("sends no line when no challenge was issued", async () => {
      const seed = seedSession();
      const sendText = vi.fn(async (_session: string, _text: string) => ({ ok: true as const }));
      await createOrchestrator({ tmux: mockTmux({ sendText }) }).startNode(makeInput(seed, { startupActions: [makeIdentityAction()] }));
      expect(sendText.mock.calls.map((c) => c[1])).not.toContain(STARTUP_PROOF_INSTRUCTION_LINE);
    });

    it("a line that fails to send is a submission warning; the seat is still ready", async () => {
      const seed = seedSession();
      const sendText = vi.fn(async (_session: string, text: string) => text === STARTUP_PROOF_INSTRUCTION_LINE
        ? { ok: false as const, message: "fixture send failure" }
        : { ok: true as const });
      const result = await createOrchestrator({ tmux: mockTmux({ sendText } as unknown as Partial<TmuxAdapter>) }).startNode(makeInput(seed, { startupActions: challengeAndIdentity() }));
      expect(result).toMatchObject({ ok: true, startupStatus: "ready" });
      expect(result.ok && result.submission?.reasons).toContain("Startup proof instruction was not delivered: fixture send failure");
    });
  });

  // OPR.0.4.3.06 — a resumed restore is NOT re-challenged (oriented stays n-a).
  it("runs a terminal startup command without sending agent-orientation prose to its shell", async () => {
    const seed = seedSession();
    const sendText = vi.fn(async () => ({ ok: true as const }));
    const orch = createOrchestrator({ tmux: mockTmux({ sendText }) });
    await orch.startNode(makeInput(seed, {
      adapter: mockAdapter({ runtime: "terminal" }),
      startupActions: [makeAction({ type: "startup_proof", value: "authenticated" }), makeAction({ type: "send_text", value: "rig tui" })],
    }));
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith("r01-impl", "rig tui");
    expect(deriveOriented(db, seed.nodeId)).toBe("n-a");
  });

  it("does NOT challenge a resumed restore (oriented=n-a)", async () => {
    const seed = seedSession();
    const orch = createOrchestrator();
    await orch.startNode(makeInput(seed, {
      startupActions: [makeAction({ type: "startup_proof", value: "authenticated" }), makeIdentityAction()],
      isRestore: true,
      resumeToken: "claude-session-123",
    }));
    const challenged = db.prepare("SELECT COUNT(*) AS n FROM events WHERE node_id = ? AND type = 'node.startup_challenged'").get(seed.nodeId) as { n: number };
    expect(challenged.n).toBe(0);
    expect(deriveOriented(db, seed.nodeId)).toBe("n-a");
  });

  it.each([false, true])("omission delivers authored identity with files=%s and adds no exercise", async (withFiles) => {
    const seed = seedSession();
    const adapter = mockAdapter();
    const result = await createOrchestrator().startNode(makeInput(seed, {
      adapter,
      startupActions: [makeIdentityAction()],
      resolvedStartupFiles: withFiles ? [{ path: "role.md", absolutePath: "/tmp/role.md", ownerRoot: "/tmp", deliveryHint: "guidance_merge", required: true, appliesOn: ["fresh_start"] }] : [],
    }));
    expect(result).toMatchObject({ ok: true, startupStatus: "ready" });
    expect(adapter.project).toHaveBeenCalledOnce();
    expect(adapter.checkReady).toHaveBeenCalledTimes(2);
    expect(tmux.sendText).toHaveBeenCalledExactlyOnceWith("r01-impl", makeIdentityAction().value);
    expect(deriveOriented(db, seed.nodeId)).toBe("n-a");
    const row = db.prepare("SELECT payload FROM events WHERE type='node.startup_pending'").get() as { payload: string };
    expect(JSON.parse(row.payload).startupProof).toEqual({ mode: "none", source: "default" });
  });

  function seedVerifiedProof() {
    const seed = seedSession();
    const store = new AgentActivityStore({ db, eventBus });
    const challenge = issueStartupChallenge(eventBus, { ...seed, contractSource: "prior occupant" });
    const submit = () => verifyStartupProof({ store, eventBus }, {
      nodeId: seed.nodeId, challengeId: challenge.challengeId, answer: challenge.expectedAnswer,
    });
    expect(submit().ok).toBe(true);
    expect(deriveOriented(db, seed.nodeId)).toBe("verified");
    return { seed, submit };
  }

  describe.each(["fresh", "fresh-fallback"] as const)("%s lean proof boundary", (mode) => {
    const launchInput = mode === "fresh-fallback"
      ? { isRestore: true, resumeToken: "stale-token", allowFreshFallback: true }
      : {};
    function launchAdapter() {
      const launch = vi.fn<RuntimeAdapter["launchHarness"]>().mockResolvedValue({ ok: true });
      if (mode === "fresh-fallback") {
        launch.mockResolvedValueOnce({ ok: false, recovery: "retry_fresh", error: "stale resume" });
      }
      return launch;
    }

    it.each(["ready", "attention", "timeout", "throws"] as const)("retires verified proof before readiness %s", async (readiness) => {
      const { seed, submit } = seedVerifiedProof();
      const observedAtReadiness: string[] = [];
      const adapter = mockAdapter({
        launchHarness: launchAdapter(),
        checkReady: vi.fn(async () => {
          observedAtReadiness.push(deriveOriented(db, seed.nodeId));
          if (readiness === "throws") throw new Error("fixture readiness error");
          if (readiness === "attention") return { ready: false, code: "login_required", reason: "fixture login" };
          return { ready: readiness === "ready", reason: "fixture timeout" };
        }),
      });
      const result = await createOrchestrator().startNode(makeInput(seed, {
        ...launchInput, adapter, readinessTimeoutMs: 0,
        startupActions: [makeAction({ type: "startup_proof", value: "none" })],
      }));
      expect(result.startupStatus).toBe(readiness === "ready" ? "ready" : readiness === "attention" ? "attention_required" : "failed");
      expect(adapter.launchHarness).toHaveBeenCalledTimes(mode === "fresh-fallback" ? 2 : 1);
      expect(observedAtReadiness.length).toBeGreaterThan(0);
      expect(observedAtReadiness.every(value => value === "n-a")).toBe(true);
      expect(deriveOriented(db, seed.nodeId)).toBe("n-a");
      expect(submit()).toMatchObject({ ok: false, code: "challenge_stale" });
      expect(db.prepare("SELECT count(*) AS n FROM events WHERE type='node.startup_proof_skipped'").get()).toEqual({ n: 1 });
      expect(db.prepare("SELECT count(*) AS n FROM events WHERE type='node.startup_proof_verified'").get()).toEqual({ n: 1 });
    });

    it.each(["failed", "throws"] as const)("preserves verified proof when replacement launch %s", async (failure) => {
      const { seed, submit } = seedVerifiedProof();
      const launch = launchAdapter();
      if (failure === "throws") launch.mockRejectedValue(new Error("fixture launch error"));
      else launch.mockResolvedValue({ ok: false, error: "fixture launch failed" });
      const adapter = mockAdapter({ launchHarness: launch });
      const result = await createOrchestrator().startNode(makeInput(seed, { ...launchInput, adapter }));
      expect(result.startupStatus).toBe("failed");
      expect(launch).toHaveBeenCalledTimes(mode === "fresh-fallback" ? 2 : 1);
      expect(adapter.checkReady).not.toHaveBeenCalled();
      expect(deriveOriented(db, seed.nodeId)).toBe("verified");
      expect(submit().ok).toBe(true);
      expect(db.prepare("SELECT count(*) AS n FROM events WHERE type='node.startup_proof_skipped'").get()).toEqual({ n: 0 });
    });
  });

  it.each(["resume", "adopt"] as const)("preserves verified proof when %s needs readiness attention", async (mode) => {
    const { seed, submit } = seedVerifiedProof();
    const adapter = mockAdapter({ checkReady: vi.fn(async () => ({ ready: false, code: "login_required" })) });
    const result = await createOrchestrator().startNode(makeInput(seed, {
      adapter, isRestore: true,
      ...(mode === "resume" ? { resumeToken: "existing-token" } : { skipHarnessLaunch: true }),
      startupActions: [makeAction({ type: "startup_proof", value: "none" })],
    }));
    expect(result.startupStatus).toBe("attention_required");
    expect(deriveOriented(db, seed.nodeId)).toBe("verified");
    expect(submit().ok).toBe(true);
    expect(db.prepare("SELECT count(*) AS n FROM events WHERE type='node.startup_proof_skipped'").get()).toEqual({ n: 0 });
  });

  it("rejects unknown persisted proof selection before projection or launch", async () => {
    const seed = seedSession();
    const adapter = mockAdapter();
    const result = await createOrchestrator().startNode(makeInput(seed, {
      adapter, startupActions: [makeAction({ type: "startup_proof", value: "quiz" })],
    }));
    expect(result).toMatchObject({ ok: false, startupStatus: "failed" });
    expect(adapter.project).not.toHaveBeenCalled();
    expect(adapter.launchHarness).not.toHaveBeenCalled();
    expect(tmux.sendText).not.toHaveBeenCalled();
  });

  // T10: launcher does not mark ready before actions complete
  it("startup_status stays pending until orchestrator completes", async () => {
    const seed = seedSession();
    // After NodeLauncher creates session, startupStatus is pending (default from AS-T00)
    const row = db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(seed.sessionId) as { startup_status: string };
    expect(row.startup_status).toBe("pending"); // launcher left it as default

    // Only after orchestrator.startNode completes does it become ready
    const orch = createOrchestrator();
    await orch.startNode(makeInput(seed));
    const afterRow = db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(seed.sessionId) as { startup_status: string };
    expect(afterRow.startup_status).toBe("ready");
  });

  // T11: retrying failed startup does not duplicate irreversible work
  it("retry-as-restore skips non-idempotent fresh_start actions", async () => {
    const seed = seedSession();

    // First attempt: fails during action (non-idempotent action executes then something else fails)
    const failAdapter = mockAdapter({
      checkReady: vi.fn()
        .mockResolvedValueOnce({ ready: true }) // first attempt: ready
        .mockResolvedValueOnce({ ready: true }), // retry: ready
    });
    // OPR.0.4.3.06 — text-aware mock (robust to the extra orientation-challenge
    // send on fresh continuity): everything succeeds except the FIRST /configure
    // (attempt 1's second action), which fails as before.
    let configureSeen = 0;
    const failTmux = mockTmux({
      sendText: vi.fn(async (_target: string, text: string) => {
        if (text === "/configure") {
          configureSeen++;
          if (configureSeen === 1) return { ok: false as const, message: "second action fails" };
        }
        return { ok: true as const };
      }),
    });

    const orch = createOrchestrator(failTmux);
    const actions: StartupAction[] = [
      makeAction({ value: "/setup-once", idempotent: false, phase: "after_ready", appliesOn: ["fresh_start"] }),
      makeAction({ value: "/configure", idempotent: true, phase: "after_ready", appliesOn: ["fresh_start", "restore"] }),
    ];

    // First attempt fails on second action
    const r1 = await orch.startNode(makeInput(seed, { adapter: failAdapter, startupActions: actions, isRestore: false }));
    expect(r1.ok).toBe(false);

    // Retry as restore — non-idempotent /setup-once should be skipped
    const r2 = await orch.startNode(makeInput(seed, { adapter: failAdapter, startupActions: actions, isRestore: true }));
    expect(r2.ok).toBe(true);

    // /setup-once was called once (first attempt only), /configure called in retry
    const calls = (failTmux.sendText as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1]);
    expect(calls.filter((c: string) => c === "/setup-once")).toHaveLength(1);
  });

  // T12a: fresh-start-only startup files skipped on restore
  it("fresh-start-only startup files skipped on restore", async () => {
    const seed = seedSession();
    const adapter = mockAdapter();
    const files: ResolvedStartupFile[] = [
      { path: "fresh.md", absolutePath: "/rig/fresh.md", ownerRoot: "/rig", deliveryHint: "auto", required: true, appliesOn: ["fresh_start"] },
      { path: "always.md", absolutePath: "/rig/always.md", ownerRoot: "/rig", deliveryHint: "auto", required: true, appliesOn: ["fresh_start", "restore"] },
    ];
    const orch = createOrchestrator();
    await orch.startNode(makeInput(seed, { adapter, resolvedStartupFiles: files, isRestore: true }));

    // Only "always.md" should be delivered, not "fresh.md"
    const deliverCalls = (adapter.deliverStartup as ReturnType<typeof vi.fn>).mock.calls;
    expect(deliverCalls).toHaveLength(1);
    const deliveredFiles = deliverCalls[0]![0] as ResolvedStartupFile[];
    expect(deliveredFiles).toHaveLength(1);
    expect(deliveredFiles[0]!.path).toBe("always.md");
  });

  // T12b: emits correct lifecycle events
  it("emits startup_pending and startup_ready events", async () => {
    const seed = seedSession();
    const events: string[] = [];
    eventBus.subscribe((e) => events.push(e.type));

    const orch = createOrchestrator();
    await orch.startNode(makeInput(seed));

    expect(events).toContain("node.startup_pending");
    expect(events).toContain("node.startup_ready");
    expect(events.indexOf("node.startup_pending")).toBeLessThan(events.indexOf("node.startup_ready"));
  });

  // NS-T04: resolveConcreteHint shared resolver
  it("resolveConcreteHint: SKILL.md path → skill_install", () => {
    expect(resolveConcreteHint("skills/my-skill/SKILL.md", "some content")).toBe("skill_install");
  });

  it("resolveConcreteHint: content starting with # SKILL → skill_install", () => {
    expect(resolveConcreteHint("custom.txt", "# SKILL Some tool")).toBe("skill_install");
  });

  it("resolveConcreteHint: .md file → guidance_merge", () => {
    expect(resolveConcreteHint("role.md", "You are a developer")).toBe("guidance_merge");
  });

  it("resolveConcreteHint: non-.md file → send_text", () => {
    expect(resolveConcreteHint("config.yaml", "key: value")).toBe("send_text");
  });

  // NS-T04: skipHarnessLaunch
  it("skipHarnessLaunch: true skips launchHarness entirely", async () => {
    const seed = seedSession();
    const launchSpy = vi.fn(async () => ({ ok: true as const }));
    const adapter = mockAdapter({ launchHarness: launchSpy });
    const orch = createOrchestrator();
    const result = await orch.startNode(makeInput(seed, { adapter, skipHarnessLaunch: true }));
    expect(result.ok).toBe(true);
    expect(launchSpy).not.toHaveBeenCalled();
  });

  // NS-T04: launchHarness failure → startup_failed
  it("launchHarness failure transitions to startup_failed", async () => {
    const seed = seedSession();
    const adapter = mockAdapter({
      launchHarness: vi.fn(async () => ({ ok: false as const, error: "harness crash" })),
    });
    const orch = createOrchestrator();
    const result = await orch.startNode(makeInput(seed, { adapter }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("harness crash"))).toBe(true);
    }
  });

  // NS-T04: launchHarness persists resume token
  it("launchHarness resume token persisted to session", async () => {
    const seed = seedSession();
    const adapter = mockAdapter({
      launchHarness: vi.fn(async () => ({ ok: true as const, resumeToken: "sess-xyz", resumeType: "claude_id" })),
    });
    const orch = createOrchestrator();
    await orch.startNode(makeInput(seed, { adapter }));

    const sessions = sessionRegistry.getSessionsForRig(seed.rigId);
    const session = sessions.find((s) => s.id === seed.sessionId);
    expect(session!.resumeToken).toBe("sess-xyz");
    expect(session!.resumeType).toBe("claude_id");
  });

  it("launchHarness does not persist empty resume token as restoreable state", async () => {
    const seed = seedSession();
    const adapter = mockAdapter({
      launchHarness: vi.fn(async () => ({ ok: true as const, resumeToken: "", resumeType: "claude_id" })),
    });
    const orch = createOrchestrator();
    await orch.startNode(makeInput(seed, { adapter }));

    const sessions = sessionRegistry.getSessionsForRig(seed.rigId);
    const session = sessions.find((s) => s.id === seed.sessionId);
    expect(session!.resumeToken).toBeNull();
    expect(session!.resumeType).toBeNull();
  });

  it("retries restore once as fresh when launchHarness reports resume recovery can safely fall back", async () => {
    const seed = seedSession();
    const launchHarness = vi.fn()
      .mockResolvedValueOnce({ ok: false as const, error: "saved session missing", recovery: "retry_fresh" })
      .mockResolvedValueOnce({ ok: true as const, resumeToken: "fresh-token", resumeType: "codex_id" });
    const adapter = mockAdapter({
      runtime: "codex",
      launchHarness,
    });
    const orch = createOrchestrator();

    const result = await orch.startNode(makeInput(seed, {
      adapter,
      isRestore: true,
      resumeToken: "stale-token",
      resumeType: "codex_id",
    }));

    expect(result).toEqual({
      ok: true,
      startupStatus: "ready",
      continuityOutcome: "fresh",
    });
    expect(launchHarness).toHaveBeenCalledTimes(2);
    expect(launchHarness.mock.calls[0]![1]).toEqual({
      name: "r01-impl",
      resumeToken: "stale-token",
    });
    expect(launchHarness.mock.calls[1]![1]).toEqual({
      name: "r01-impl",
      resumeToken: undefined,
    });

    const sessions = sessionRegistry.getSessionsForRig(seed.rigId);
    const session = sessions.find((s) => s.id === seed.sessionId);
    expect(session!.resumeToken).toBe("fresh-token");
    expect(session!.resumeType).toBe("codex_id");
    expect(session!.startupStatus).toBe("ready");
  });

  // Pod-aware Codex auth-refusal: when launchHarness reports
  // recovery: "attention_required" with evidence, the orchestrator must
  // surface startup_status: "attention_required" with the evidence preserved
  // (NOT fall back to fresh launch — that would lose continuity for a state
  // the operator can resolve by re-running `codex login`).
  it("propagates attention_required recovery without falling back to fresh", async () => {
    const seed = seedSession();
    const refusalEvidence = [
      "$ codex resume stale-token",
      "Error: Your access token could not be refreshed because you have since",
      "logged out or signed in to another account. Please sign in again.",
    ].join("\n");
    const launchHarness = vi.fn().mockResolvedValueOnce({
      ok: false as const,
      error: "Codex auth-refusal: please sign in again",
      recovery: "attention_required",
      evidence: refusalEvidence,
    });
    const adapter = mockAdapter({ runtime: "codex", launchHarness });
    const orch = createOrchestrator();

    const result = await orch.startNode(makeInput(seed, {
      adapter,
      isRestore: true,
      resumeToken: "stale-token",
      resumeType: "codex_id",
    }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.startupStatus).toBe("attention_required");
      // Evidence is preserved on the StartupResult so restore-orchestrator
      // can populate attentionEvidence on RestoreNodeResult.
      expect(result.evidence).toBe(refusalEvidence);
      expect(result.errors.some((e) => e.includes("requires attention"))).toBe(true);
    }
    // Critical: launchHarness called ONCE — no fresh-fallback retry.
    // Auth-refusal is operator-recoverable, not a stale-token signal.
    expect(launchHarness).toHaveBeenCalledTimes(1);

    const sessions = sessionRegistry.getSessionsForRig(seed.rigId);
    const session = sessions.find((s) => s.id === seed.sessionId);
    expect(session!.startupStatus).toBe("attention_required");
    expect(session!.resumeType).toBe("codex_id");
    expect(session!.resumeToken).toBe("stale-token");
    expect(session!.resumeProvenance).toBeNull();
    expect(session!.resumeLastVerified).toBeNull();
    expect(session!.resumeLastProbeStatus).toBeNull();
  });

  it.each([
    "runner exited (code 1)",
    "readiness timed out before the runtime became interactive",
  ])("preserves attempted lineage without certifying attention outcome: %s", async (error) => {
    const seed = seedSession();
    const adapter = mockAdapter({
      runtime: "pi",
      launchHarness: vi.fn(async () => ({
        ok: false as const,
        error,
        recovery: "attention_required" as const,
      })),
    });

    const result = await createOrchestrator().startNode(makeInput(seed, {
      adapter,
      isRestore: true,
      resumeToken: "attempted-pi-token",
      resumeType: "pi_session_file",
    }));

    expect(result.ok).toBe(false);
    expect(result.startupStatus).toBe("attention_required");
    const session = sessionRegistry.getSessionsForRig(seed.rigId).find((s) => s.id === seed.sessionId)!;
    expect(session.resumeType).toBe("pi_session_file");
    expect(session.resumeToken).toBe("attempted-pi-token");
    expect(session.resumeProvenance).toBeNull();
    expect(session.resumeLastVerified).toBeNull();
    expect(session.resumeLastProbeStatus).toBeNull();
  });

  // NS-T05: readiness retry loop
  describe("readiness deadline", () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it("uses the configured launch window when the caller has no override", async () => {
      const seed = seedSession();
      const started = Date.now();
      const adapter = mockAdapter({ checkReady: vi.fn(async () => ({ ready: Date.now() - started >= 40_000 })) });
      const readinessSettings = {
        resolveOne: () => ({ value: 45, source: "file", defaultValue: 30 }),
      } as unknown as Pick<SettingsStore, "resolveOne">;
      const pending = createOrchestrator({ readinessSettings }).startNode(makeInput(seed, { adapter }));

      await vi.advanceTimersByTimeAsync(45_000);
      expect(await pending).toMatchObject({ ok: true, startupStatus: "ready" });
    });

    it("falls back to the 30-second window with a warning when the settings read throws", async () => {
      const seed = seedSession();
      const started = Date.now();
      const adapter = mockAdapter({ checkReady: vi.fn(async () => ({ ready: Date.now() - started >= 20_000 })) });
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const readinessSettings = {
        resolveOne: () => { throw new Error("config.json is not valid JSON"); },
      } as unknown as Pick<SettingsStore, "resolveOne">;

      try {
        const pending = createOrchestrator({ readinessSettings }).startNode(makeInput(seed, { adapter }));
        await vi.advanceTimersByTimeAsync(30_000);

        expect(await pending).toMatchObject({ ok: true, startupStatus: "ready" });
        expect(stderr).toHaveBeenCalledWith(expect.stringContaining("falling back to 30s default"));
      } finally {
        stderr.mockRestore();
      }
    });

    it.each([20_000, 30_000])("accepts readiness at %i ms within the 30-second budget", async (readyAfterMs) => {
      const seed = seedSession();
      const started = Date.now();
      const adapter = mockAdapter({
        checkReady: vi.fn(async () => ({ ready: Date.now() - started >= readyAfterMs })),
      });
      let settled = false;
      const pending = createOrchestrator().startNode(makeInput(seed, { adapter }))
        .then((result) => { settled = true; return result; });

      await vi.advanceTimersByTimeAsync(15_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(14_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      expect(await pending).toMatchObject({ ok: true, startupStatus: "ready" });
      expect(sessionRegistry.getSessionsForRig(seed.rigId).find((s) => s.id === seed.sessionId)?.startupStatus).toBe("ready");
    });

    it.each([500, 30_000])("does not time out before the %i ms budget expires", async (timeoutMs) => {
      const seed = seedSession();
      const started = Date.now();
      const adapter = mockAdapter({
        checkReady: vi.fn(async () => ({ ready: false, reason: `not ready at ${Date.now() - started}ms` })),
      });
      let settled = false;
      const pending = createOrchestrator().startNode(makeInput(seed, { adapter, readinessTimeoutMs: timeoutMs }))
        .then((result) => { settled = true; return result; });

      await vi.advanceTimersByTimeAsync(timeoutMs - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      expect(await pending).toMatchObject({
        ok: false,
        startupStatus: "failed",
        errors: [expect.stringContaining(`not ready at ${timeoutMs}ms`)],
      });
      expect(vi.getTimerCount()).toBe(0);
    });

    it("preserves an attention blocker observed at the deadline", async () => {
      const seed = seedSession();
      const started = Date.now();
      const adapter = mockAdapter({
        checkReady: vi.fn(async () => Date.now() - started >= 30_000
          ? { ready: false, code: "trust_gate", reason: "workspace trust required" }
          : { ready: false, reason: "starting" }),
      });
      const pending = createOrchestrator().startNode(makeInput(seed, { adapter }));
      await vi.advanceTimersByTimeAsync(30_000);

      expect(await pending).toMatchObject({
        ok: false,
        startupStatus: "attention_required",
        errors: ["Startup requires attention: workspace trust required", expect.stringContaining("rig seat continue")],
      });
    });
  });

  it("readiness retries until ready", async () => {
    const seed = seedSession();
    let callCount = 0;
    const adapter = mockAdapter({
      checkReady: vi.fn(async () => {
        callCount++;
        // Ready on 3rd attempt
        return callCount >= 3 ? { ready: true } : { ready: false, reason: "not yet" };
      }),
    });
    const orch = createOrchestrator();
    const result = await orch.startNode(makeInput(seed, { adapter, readinessTimeoutMs: 10_000 }));
    expect(result.ok).toBe(true);
    expect(callCount).toBeGreaterThanOrEqual(3);
  });

  it("readiness timeout → startup_failed with timeout message", async () => {
    const seed = seedSession();
    const adapter = mockAdapter({
      checkReady: vi.fn(async () => ({ ready: false, reason: "harness not interactive" })),
    });
    const orch = createOrchestrator();
    const result = await orch.startNode(makeInput(seed, { adapter, readinessTimeoutMs: 100 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("timeout") || e.includes("Readiness timeout"))).toBe(true);
      expect(result.errors).toEqual([expect.stringContaining("after 0.1s")]);
    }
  });

  it("readiness blocker fails immediately with the blocker reason instead of a timeout", async () => {
    const seed = seedSession();
    const adapter = mockAdapter({
      checkReady: vi.fn(async () => ({
        ready: false,
        reason: "Codex is waiting for workspace trust approval before the session can become interactive.",
        code: "trust_gate",
      })),
    });
    const orch = createOrchestrator();
    const result = await orch.startNode(makeInput(seed, { adapter, readinessTimeoutMs: 10_000 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.startupStatus).toBe("attention_required");
      expect(result.errors.some((e) => e.includes("Startup requires attention"))).toBe(true);
      expect(result.errors.some((e) => e.includes("timeout"))).toBe(false);
    }
  });

  it("delivers openrig-start.md overlay alongside agent role guidance (append, not replace)", async () => {
    const seed = seedSession();
    const deliveredFiles: string[] = [];
    const adapter = mockAdapter({
      deliverStartup: vi.fn(async (files) => {
        for (const f of files) deliveredFiles.push(f.path);
        return { delivered: files.length, failed: [] };
      }),
    });
    const roleFile: ResolvedStartupFile = {
      path: "guidance/role.md",
      absolutePath: "/agents/impl/guidance/role.md",
      ownerRoot: "/agents/impl",
      deliveryHint: "guidance_merge",
      required: true,
      appliesOn: ["fresh_start", "restore"],
    };
    const onboardingFile: ResolvedStartupFile = {
      path: "openrig-start.md",
      absolutePath: "/assets/guidance/openrig-start.md",
      ownerRoot: "/assets",
      deliveryHint: "guidance_merge",
      required: false,
      appliesOn: ["fresh_start", "restore"],
    };

    const orch = createOrchestrator();
    const result = await orch.startNode(makeInput(seed, {
      adapter,
      resolvedStartupFiles: [roleFile, onboardingFile],
    }));

    expect(result.ok).toBe(true);
    // Both files were delivered — overlay appended, not replacing role guidance
    expect(deliveredFiles).toContain("guidance/role.md");
    expect(deliveredFiles).toContain("openrig-start.md");
  });
  // OF-161 (measured live 2026-10-28, improve-engineer@kernel, restore attempt 96253): `claude --resume <id>` is the pane's
  // foreground process for the first moments, so every one-shot readiness read said "resumed" and the seat was reported
  // resumed while Claude printed "No conversation found with session ID ..." and exited to the shell. These rows model
  // that clock: Claude is in the foreground until `claudeExitsAtMs`, then the pane shows `exitedPane`. The orchestrator's
  // injected `sleep` is the only thing that advances the clock, so a check that never waits cannot see the exit.
  describe("OF-161: a resumed Claude must still be in the foreground after it has had time to exit", () => {
    const NATIVE_MESSAGE = "No conversation found with session ID fe08b428-e2c5-49da-ad48-ea8d604e99c3";
    // `survives`: Claude stays up (its UI just repaints text that mentions the phrase). The foreground NAME is whatever
    // `exitedCommand` says once the clock passes `claudeExitsAtMs`; the process tree says whether Claude is really there.
    function exitingClaude(exitedPane: string, claudeExitsAtMs = 1000, exitedCommand = "zsh", survives = false) {
      let elapsed = 0;
      const sleeps: number[] = [];
      const exited = () => elapsed >= claudeExitsAtMs;
      const pane = () => !exited()
        ? { command: "zsh", content: "" }
        : { command: exitedCommand, content: exitedPane };
      const t = mockTmux({ capturePaneContent: vi.fn(async () => pane().content), getPaneCommand: vi.fn(async () => pane().command) });
      const adapter = mockAdapter({
        checkReady: vi.fn(async () => {
          // The adapter's own probe reads the name and the text; before the exit Claude is the foreground.
          const probe = assessNativeResumeProbe({ runtime: "claude-code", paneCommand: exited() ? pane().command : "claude", paneContent: pane().content });
          return { ready: probe.status === "resumed", code: probe.code, reason: probe.detail };
        }),
      });
      const orch = createOrchestrator({ tmux: t, sleep: async (ms) => { sleeps.push(ms); elapsed += ms; },
        listProcesses: async () => (survives || !exited() ? PANE_WITH_CLAUDE : PANE_WITHOUT_CLAUDE) });
      return { t, adapter, orch, sleeps };
    }
    const readyEvents = (nodeId: string) => db.prepare("SELECT type FROM events WHERE node_id = ? AND type = 'node.startup_ready'").all(nodeId);

    it("reports a resume whose conversation is missing as failed with Claude's own message, never ready", async () => {
      const seed = seedSession();
      const { t, adapter, orch } = exitingClaude(`${NATIVE_MESSAGE}\n$ `);
      const result = await orch.startNode(makeInput(seed, { adapter, isRestore: true, resumeToken: "fe08b428-e2c5-49da-ad48-ea8d604e99c3",
        resumeType: "claude_id", allowFreshFallback: false, startupActions: [makeAction()] }));
      expect(result).toMatchObject({ ok: false, startupStatus: "failed", recovery: "retry_fresh", missingConversation: true });
      if (result.ok) throw new Error("unreachable");
      expect(result.errors.join("\n")).toContain(NATIVE_MESSAGE);
      expect(db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(seed.sessionId)).toEqual({ startup_status: "failed" });
      expect(readyEvents(seed.nodeId)).toEqual([]);
      // Nothing was typed into the shell the pane fell back to.
      expect(t.sendText).not.toHaveBeenCalled();
    });

    it("reports a pane that fell back to its shell without a native message as failed, keeping the pane output", async () => {
      const seed = seedSession();
      const { adapter, orch } = exitingClaude("claude: command crashed\n$ ");
      const result = await orch.startNode(makeInput(seed, { adapter, isRestore: true, resumeToken: "tok-1", resumeType: "claude_id", allowFreshFallback: false }));
      expect(result).toMatchObject({ ok: false, startupStatus: "failed", recovery: "retry_fresh" });
      if (result.ok) throw new Error("unreachable");
      expect(result.missingConversation).toBeUndefined();
      expect(result.errors.join("\n")).toContain("claude: command crashed");
      expect(readyEvents(seed.nodeId)).toEqual([]);
    });

    // F1 (review) + measured live: Claude runs under a launcher shell without exec, so the foreground name is
    // usually zsh/bash/sh. A healthy resumed pane can repaint history that mentions the phrase; the probe reads the
    // phrase first. The process tree, not the name, says Claude is still there.
    it.each(["claude", "zsh", "bash", "sh"])("a resumed Claude (foreground %s) is NOT failed because its repainted history contains the phrase", async (foreground) => {
      const seed = seedSession();
      const history = `Claude Code v2.1.220\n> we saw: ${NATIVE_MESSAGE}\n❯ \n? for shortcuts`;
      const { t, adapter, orch } = exitingClaude(history, 1000, foreground, true);
      expect(assessNativeResumeProbe({ runtime: "claude-code", paneCommand: foreground, paneContent: history })).toMatchObject({ code: "no_conversation_found" });
      const result = await orch.startNode(makeInput(seed, { adapter, isRestore: true, resumeToken: "tok-1", resumeType: "claude_id", allowFreshFallback: false, startupActions: [makeAction()] }));
      expect(result).toMatchObject({ ok: true, continuityOutcome: "resumed" });
      expect(readyEvents(seed.nodeId)).toHaveLength(1);
      expect(t.killSession).not.toHaveBeenCalled();
    });

    const TUI = "Claude Code v2.1.220\n❯ \n? for shortcuts";
    // Headerless: looksLikeClaudeTui (needs "Claude Code v" or "accept edits on") does not recognise this screen.
    const AUTO_SCREEN = "❯ \n⏵⏵ auto mode on (shift+tab to cycle)\n";
    const resumeInput = (seed: ReturnType<typeof seedSession>, extra: Partial<StartupInput> = {}) => makeInput(seed, { adapter: mockAdapter(), isRestore: true,
      resumeToken: "tok-1", resumeType: "claude_id", allowFreshFallback: false, startupActions: [makeAction()], ...extra });

    // F2 (review): the settle window is a heuristic, so typing re-checks that Claude is still in the pane.
    it("types nothing into a pane whose Claude exited after the settle read", async () => {
      const seed = seedSession();
      const t = mockTmux({ getPaneCommand: vi.fn(async () => "zsh"), capturePaneContent: vi.fn(async () => "$ ") });
      const result = await createOrchestrator({ tmux: t, listProcesses: async () => PANE_WITHOUT_CLAUDE }).startNode(resumeInput(seed));
      expect(result).toMatchObject({ ok: false });
      if (result.ok) throw new Error("unreachable");
      expect(result.errors.join("\n")).toContain("no longer in the foreground");
      expect(t.sendText).not.toHaveBeenCalled();
      expect(readyEvents(seed.nodeId)).toEqual([]);
    });

    // The screen is not evidence: an exited Claude leaves its last screen (UI, auto-mode bar) on the pane.
    it.each([["its TUI", TUI], ["its auto-mode screen", AUTO_SCREEN]])("types nothing when %s is still drawn but no Claude process is left under the pane", async (_name, screen) => {
      const seed = seedSession();
      const t = mockTmux({ getPaneCommand: vi.fn(async () => "sh"), capturePaneContent: vi.fn(async () => `${screen}Resume this session with:\nclaude --resume tok-1\n$ `) });
      const result = await createOrchestrator({ tmux: t, listProcesses: async () => PANE_WITHOUT_CLAUDE }).startNode(resumeInput(seed));
      expect(result).toMatchObject({ ok: false });
      expect(t.sendText).not.toHaveBeenCalled();
    });

    // The live shape (measured 2026-10-28): the pane's foreground is `zsh`, with `claude` (ucomm claude, argv0 claude)
    // beneath it and its MCP / caffeinate / pyright children.
    const LIVE_CLAUDE: NativeProcessRow = { pid: 102, ppid: 100, pgid: 100, tpgid: 100, executableName: "claude", command: "claude --permission-mode auto --resume tok-1", startedAt: T0 };
    const LIVE_CHILDREN: NativeProcessRow[] = [
      { pid: 103, ppid: 102, pgid: 100, tpgid: 100, executableName: "codebase-memory-m", command: "/u/.local/bin/codebase-memory-mcp", startedAt: T0 },
      { pid: 104, ppid: 102, pgid: 100, tpgid: 100, executableName: "caffeinate", command: "caffeinate -i -t 3600", startedAt: T0 },
      { pid: 105, ppid: 102, pgid: 100, tpgid: 100, executableName: "node", command: "node /u/.npm/_npx/x/node_modules/.bin/pyright-langserver --stdio", startedAt: T0 },
    ];
    it("live tree under a zsh foreground: both sends are typed and nothing says the foreground could not be read", async () => {
      const seed = seedSession();
      const t = mockTmux({ getPaneCommand: vi.fn(async () => "zsh"), capturePaneContent: vi.fn(async () => "") });
      const result = await createOrchestrator({ tmux: t, listProcesses: async () => [PANE_SHELL, LIVE_CLAUDE, ...LIVE_CHILDREN] })
        .startNode(resumeInput(seed, { startupActions: [makeAction(), makeAction({ value: "/second" })] }));
      expect(result).toMatchObject({ ok: true });
      expect(t.sendText).toHaveBeenCalledTimes(2);
      expect((result.warnings ?? []).filter((w) => w.includes("could not be read"))).toEqual([]);
    });

    it("the same live tree without the claude row: nothing is typed", async () => {
      const seed = seedSession();
      const t = mockTmux({ getPaneCommand: vi.fn(async () => "zsh"), capturePaneContent: vi.fn(async () => "") });
      const result = await createOrchestrator({ tmux: t, listProcesses: async () => [PANE_SHELL, ...LIVE_CHILDREN] }).startNode(resumeInput(seed));
      expect(result).toMatchObject({ ok: false });
      expect(t.sendText).not.toHaveBeenCalled();
    });

    it("a Claude running elsewhere on the machine is not this pane's Claude: nothing is typed", async () => {
      const seed = seedSession();
      const elsewhere: NativeProcessRow = { ...CLAUDE_PROC, pid: 900, ppid: 1, pgid: 900, tpgid: 900 };
      const t = mockTmux({ getPaneCommand: vi.fn(async () => "zsh"), capturePaneContent: vi.fn(async () => "$ ") });
      const result = await createOrchestrator({ tmux: t, listProcesses: async () => [PANE_SHELL, elsewhere] }).startNode(resumeInput(seed));
      expect(result).toMatchObject({ ok: false });
      expect(t.sendText).not.toHaveBeenCalled();
    });

    it("a native Claude whose argv never says `claude` (versioned binary name only) still counts as running under the pane", async () => {
      const seed = seedSession();
      const bare: NativeProcessRow = { ...CLAUDE_PROC, command: "/opt/x/2.1.285 --permission-mode auto" };
      const t = mockTmux({ getPaneCommand: vi.fn(async () => "zsh"), capturePaneContent: vi.fn(async () => "") });
      expect(await createOrchestrator({ tmux: t, listProcesses: async () => [PANE_SHELL, LAUNCHER, bare] }).startNode(resumeInput(seed))).toMatchObject({ ok: true });
      expect(t.sendText).toHaveBeenCalled();
    });

    it("control: with Claude in the foreground the startup action is typed", async () => {
      const seed = seedSession();
      const t = mockTmux({ getPaneCommand: vi.fn(async () => "claude") });
      const result = await createOrchestrator({ tmux: t }).startNode(resumeInput(seed));
      expect(result).toMatchObject({ ok: true });
      expect(t.sendText).toHaveBeenCalled();
    });

    // Measured live: Claude under a launcher shell shows the shell as the foreground (zsh, bash; sh in fixtures).
    it.each([["zsh", TUI], ["bash", TUI], ["sh", AUTO_SCREEN], ["zsh", AUTO_SCREEN], ["bash", ""]])("types when the foreground is %s but Claude runs under the pane (screen %j)", async (foreground, screen) => {
      const seed = seedSession();
      const t = mockTmux({ getPaneCommand: vi.fn(async () => foreground), capturePaneContent: vi.fn(async () => screen) });
      expect(await createOrchestrator({ tmux: t }).startNode(resumeInput(seed))).toMatchObject({ ok: true, continuityOutcome: "resumed" });
      expect(t.sendText).toHaveBeenCalled();
    });

    // Unreadable foreground: never a silent pass.
    it("an unreadable foreground at the settle read does not fail the resume but is recorded as a warning", async () => {
      const seed = seedSession();
      const adapter = mockAdapter({ checkReady: vi.fn().mockResolvedValueOnce({ ready: true })
        .mockResolvedValue({ ready: false, code: "no_conversation_found", reason: "phrase" }) });
      const t = mockTmux({ getPaneCommand: vi.fn(async () => { throw new Error("tmux gone"); }) });
      const result = await createOrchestrator({ tmux: t }).startNode(resumeInput(seed, { adapter, startupActions: [] }));
      expect(result).toMatchObject({ ok: true, continuityOutcome: "resumed" });
      expect(result.warnings?.join("\n")).toContain("could not be read at the settle check");
    });

    it.each([
      ["a listing that lacks the pane's own pid", async () => [LAUNCHER, CLAUDE_PROC]],
      ["a listing that cannot be read", async (): Promise<NativeProcessRow[]> => { throw new Error("ps unavailable"); }],
      ["an empty listing", async (): Promise<NativeProcessRow[]> => []],
    ])("%s is unreadable, not proof that Claude is gone: warn and type", async (_name, listProcesses) => {
      const seed = seedSession();
      const t = mockTmux({ getPaneCommand: vi.fn(async () => "zsh"), capturePaneContent: vi.fn(async () => "$ ") });
      const result = await createOrchestrator({ tmux: t, listProcesses }).startNode(resumeInput(seed));
      expect(result).toMatchObject({ ok: true });
      expect(t.sendText).toHaveBeenCalledTimes(1);
      expect(result.warnings?.join("\n")).toContain("could not be read before typing");
    });

    it("one unreadable foreground before typing proceeds with a warning", async () => {
      const seed = seedSession();
      const t = mockTmux({ getPaneCommand: vi.fn(async () => { throw new Error("tmux gone"); }) });
      const result = await createOrchestrator({ tmux: t }).startNode(resumeInput(seed));
      expect(result).toMatchObject({ ok: true });
      expect(t.sendText).toHaveBeenCalledTimes(1);
      expect(result.warnings?.join("\n")).toContain("could not be read before typing");
    });

    it("two unreadable foreground reads in a row stop the typing: attention_required with the pane tail", async () => {
      const seed = seedSession();
      const t = mockTmux({ getPaneCommand: vi.fn(async () => { throw new Error("tmux gone"); }), capturePaneContent: vi.fn(async () => "last pane line") });
      const result = await createOrchestrator({ tmux: t }).startNode(resumeInput(seed, { startupActions: [makeAction(), makeAction({ value: "/second" })] }));
      expect(result).toMatchObject({ ok: false, startupStatus: "attention_required" });
      if (result.ok) throw new Error("unreachable");
      expect(result.errors.join("\n")).toContain("twice in a row");
      expect(result.errors.join("\n")).toContain("last pane line");
      expect(t.sendText).toHaveBeenCalledTimes(1);
      expect(readyEvents(seed.nodeId)).toEqual([]);
      expect(db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(seed.sessionId)).toEqual({ startup_status: "attention_required" });
    });

    it("a readable foreground between two unreadable ones resets the count", async () => {
      const seed = seedSession();
      const reads = vi.fn().mockRejectedValueOnce(new Error("x")).mockResolvedValueOnce("claude").mockRejectedValueOnce(new Error("x")).mockResolvedValue("claude");
      const t = mockTmux({ getPaneCommand: reads });
      const result = await createOrchestrator({ tmux: t }).startNode(resumeInput(seed, { startupActions: [makeAction(), makeAction({ value: "/b" }), makeAction({ value: "/c" })] }));
      expect(result).toMatchObject({ ok: true });
      expect(t.sendText).toHaveBeenCalledTimes(3);
    });

    it("control: a FRESH launch types even while its pane still shows the shell (the launch command is typed from it)", async () => {
      const seed = seedSession();
      const t = mockTmux({ getPaneCommand: vi.fn(async () => "zsh") });
      const result = await createOrchestrator({ tmux: t }).startNode(makeInput(seed, { adapter: mockAdapter(), startupActions: [makeAction()] }));
      expect(result).toMatchObject({ ok: true, continuityOutcome: "fresh" });
      expect(t.sendText).toHaveBeenCalled();
    });

    // F5 (review): the settle read's attention branch.
    it("a provider gate seen at the settle read is attention_required, not ready, and nothing is typed", async () => {
      const seed = seedSession();
      const adapter = mockAdapter({ checkReady: vi.fn().mockResolvedValueOnce({ ready: true })
        .mockResolvedValueOnce({ ready: false, code: "trust_gate", reason: "workspace trust approval" }) });
      const t = mockTmux();
      const result = await createOrchestrator({ tmux: t }).startNode(makeInput(seed, { adapter, isRestore: true, resumeToken: "tok-1",
        resumeType: "claude_id", allowFreshFallback: false, startupActions: [makeAction()] }));
      expect(result).toMatchObject({ ok: false, startupStatus: "attention_required", errors: [expect.stringContaining("workspace trust approval")] });
      expect(t.sendText).not.toHaveBeenCalled();
      expect(readyEvents(seed.nodeId)).toEqual([]);
    });

    // F5 (review): after a failed resume falls back to a fresh launch, input.resumeToken is still set but nothing resumed.
    it("a fresh fallback after a failed resume takes no resume wait", async () => {
      const seed = seedSession();
      const { adapter, orch, sleeps } = exitingClaude("never reached", 60_000);
      const launchHarness = vi.fn()
        .mockResolvedValueOnce({ ok: false, error: "no conversation", recovery: "retry_fresh", missingConversation: true })
        .mockResolvedValueOnce({ ok: true });
      const result = await orch.startNode(makeInput(seed, { adapter: { ...adapter, launchHarness }, isRestore: true, resumeToken: "tok-1", resumeType: "claude_id", allowFreshFallback: true }));
      expect(launchHarness).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({ ok: true, continuityOutcome: "fresh" });
      expect(sleeps).toEqual([]);
    });

    it("control: a resumed Claude that is still in the foreground after the wait is ready and resumed", async () => {
      const seed = seedSession();
      const { adapter, orch, sleeps } = exitingClaude("never reached", 60_000);
      const result = await orch.startNode(makeInput(seed, { adapter, isRestore: true, resumeToken: "tok-1", resumeType: "claude_id", allowFreshFallback: false }));
      expect(result).toMatchObject({ ok: true, continuityOutcome: "resumed" });
      expect(sleeps.length).toBeGreaterThan(0);
      expect(readyEvents(seed.nodeId)).toHaveLength(1);
    });

    it("control: a fresh launch takes no resume wait", async () => {
      const seed = seedSession();
      const { adapter, orch, sleeps } = exitingClaude("never reached", 60_000);
      const result = await orch.startNode(makeInput(seed, { adapter }));
      expect(result).toMatchObject({ ok: true, continuityOutcome: "fresh" });
      expect(sleeps).toEqual([]);
    });
  });
  // OF-167: the pod-aware Codex resume has the same first-read race as Claude had (OF-161). Fixtures are the shape measured
  // on Sparky: the pane shell -> `sh /tmp/openrig-tmux-send-....txt` -> `node .../codex` -> `codex`, so the foreground NAME
  // is `sh`/`bash` and proves nothing. Codex's message for a missing session is "No saved session found".
  describe("OF-167: a resumed Codex must still be under the pane after it has had time to exit", () => {
    const CODEX_PANE: NativeProcessRow = { pid: 100, ppid: 1, pgid: 100, tpgid: 101, executableName: "bash", command: "-bash", startedAt: T0 };
    const CODEX_LAUNCHER: NativeProcessRow = { pid: 101, ppid: 100, pgid: 101, tpgid: 101, executableName: "sh", command: "sh /tmp/openrig-tmux-send-4242-0b8c9d3e-1111-4222-8333-444455556666.txt", startedAt: T0 };
    const CODEX_NODE: NativeProcessRow = { pid: 102, ppid: 101, pgid: 101, tpgid: 101, executableName: "node", command: "node /home/u/.nvm/versions/node/v22/bin/codex resume tok-1", startedAt: T0 };
    const CODEX_BIN: NativeProcessRow = { pid: 103, ppid: 102, pgid: 101, tpgid: 101, executableName: "codex", command: "/home/u/lib/node_modules/@openai/codex/vendor/codex/codex resume tok-1", startedAt: T0 };
    const CODEX_LIVE = [CODEX_PANE, CODEX_LAUNCHER, CODEX_NODE, CODEX_BIN];
    const CODEX_GONE = [CODEX_PANE, CODEX_LAUNCHER];
    const MISSING = "No saved session found with ID 019a-tok";
    const CODEX_TUI = "OpenAI Codex (v0.0.0)\n› Ask Codex to do anything";
    const readyEvents = (nodeId: string) => db.prepare("SELECT type FROM events WHERE node_id = ? AND type = 'node.startup_ready'").all(nodeId);
    const codexAdapter = (t: TmuxAdapter, extra: Partial<RuntimeAdapter> = {}) => mockAdapter({ runtime: "codex",
      checkReady: vi.fn(async () => {
        const probe = assessNativeResumeProbe({ runtime: "codex", paneCommand: await t.getPaneCommand("r01-impl"), paneContent: (await t.capturePaneContent("r01-impl", 40)) ?? "" });
        return { ready: probe.status === "resumed", code: probe.code, reason: probe.detail };
      }), ...extra });
    const resumeInput = (seed: ReturnType<typeof seedSession>, adapter: RuntimeAdapter, extra: Partial<StartupInput> = {}) => makeInput(seed, { adapter, isRestore: true,
      resumeToken: "tok-1", resumeType: "codex_id", allowFreshFallback: false, startupActions: [makeAction()], ...extra });
    /** Codex is up (foreground `node`, TUI) until `exitsAtMs`, then the pane shows `afterPane` under `afterCommand`. */
    function exitingCodex(afterPane: string, exitsAtMs = 1000, afterCommand = "bash", survives = false) {
      let elapsed = 0; const sleeps: number[] = [];
      const up = () => elapsed < exitsAtMs;
      const t = mockTmux({ getPaneCommand: vi.fn(async () => up() ? "node" : afterCommand), capturePaneContent: vi.fn(async () => up() ? CODEX_TUI : afterPane) });
      const orch = createOrchestrator({ tmux: t, sleep: async (ms) => { sleeps.push(ms); elapsed += ms; }, listProcesses: async () => survives || up() ? CODEX_LIVE : CODEX_GONE });
      return { t, orch, sleeps, adapter: codexAdapter(t) };
    }

    it("a resume whose session is missing is failed with Codex's own message, never ready, and nothing is typed", async () => {
      const seed = seedSession();
      const { t, orch, adapter } = exitingCodex(`${MISSING}\n$ `);
      const result = await orch.startNode(resumeInput(seed, adapter));
      expect(result).toMatchObject({ ok: false, startupStatus: "failed", recovery: "retry_fresh", missingConversation: true });
      if (result.ok) throw new Error("unreachable");
      expect(result.errors.join("\n")).toContain(MISSING);
      expect(result.errors.join("\n")).toContain("Codex resume failed");
      expect(readyEvents(seed.nodeId)).toEqual([]);
      expect(t.sendText).not.toHaveBeenCalled();
    });

    it("a pane that fell back to its shell without a message is failed (retry_fresh), keeping the pane output, not marked missing", async () => {
      const seed = seedSession();
      const { orch, adapter } = exitingCodex("codex: segfault\n$ ");
      const result = await orch.startNode(resumeInput(seed, adapter));
      expect(result).toMatchObject({ ok: false, startupStatus: "failed", recovery: "retry_fresh" });
      if (result.ok) throw new Error("unreachable");
      expect(result.missingConversation).toBeUndefined();
      expect(result.errors.join("\n")).toContain("codex: segfault");
      expect(result.errors.join("\n")).toContain("returned to its shell");
    });

    // Foreground names measured/modelled: the launcher shell (sh, bash), Codex's node wrapper, and codex itself.
    it.each(["sh", "bash", "node", "codex"])("a live Codex (foreground %s) whose repainted history contains the phrase is NOT failed", async (foreground) => {
      const seed = seedSession();
      const history = `${CODEX_TUI}\n> we saw: ${MISSING}`;
      const { t, orch, adapter } = exitingCodex(history, 1000, foreground, true);
      expect(assessNativeResumeProbe({ runtime: "codex", paneCommand: foreground, paneContent: history })).toMatchObject({ code: "no_saved_session" });
      const result = await orch.startNode(resumeInput(seed, adapter));
      expect(result).toMatchObject({ ok: true, continuityOutcome: "resumed" });
      expect(readyEvents(seed.nodeId)).toHaveLength(1);
      expect(t.killSession).not.toHaveBeenCalled();
    });

    it("the measured live tree under an sh foreground: both sends are typed and nothing says the foreground could not be read", async () => {
      const seed = seedSession();
      const t = mockTmux({ getPaneCommand: vi.fn(async () => "sh"), capturePaneContent: vi.fn(async () => CODEX_TUI) });
      const result = await createOrchestrator({ tmux: t, listProcesses: async () => CODEX_LIVE })
        .startNode(resumeInput(seed, codexAdapter(t), { startupActions: [makeAction(), makeAction({ value: "/second" })] }));
      expect(result).toMatchObject({ ok: true, continuityOutcome: "resumed" });
      expect(t.sendText).toHaveBeenCalledTimes(2);
      expect((result.warnings ?? []).filter((w) => w.includes("could not be read"))).toEqual([]);
    });

    it("types nothing into a pane whose Codex exited after the settle read", async () => {
      const seed = seedSession();
      const t = mockTmux({ getPaneCommand: vi.fn(async () => "bash"), capturePaneContent: vi.fn(async () => CODEX_TUI) });
      const result = await createOrchestrator({ tmux: t, listProcesses: async () => CODEX_GONE }).startNode(resumeInput(seed, mockAdapter({ runtime: "codex" })));
      expect(result).toMatchObject({ ok: false });
      if (result.ok) throw new Error("unreachable");
      expect(result.errors.join("\n")).toContain("Codex is no longer in the foreground");
      expect(t.sendText).not.toHaveBeenCalled();
    });

    it("a Claude beneath the pane is not the Codex this seat resumed", async () => {
      const seed = seedSession();
      const t = mockTmux({ getPaneCommand: vi.fn(async () => "bash"), capturePaneContent: vi.fn(async () => "") });
      const result = await createOrchestrator({ tmux: t, listProcesses: async () => [CODEX_PANE, CODEX_LAUNCHER, CLAUDE_PROC] }).startNode(resumeInput(seed, mockAdapter({ runtime: "codex" })));
      expect(result).toMatchObject({ ok: false });
      expect(t.sendText).not.toHaveBeenCalled();
    });

    it("an unreadable foreground at the settle read does not fail the Codex resume but is recorded as a warning", async () => {
      const seed = seedSession();
      const adapter = mockAdapter({ runtime: "codex", checkReady: vi.fn().mockResolvedValueOnce({ ready: true })
        .mockResolvedValue({ ready: false, code: "no_saved_session", reason: "phrase" }) });
      const t = mockTmux({ getPaneCommand: vi.fn(async () => { throw new Error("tmux gone"); }) });
      const result = await createOrchestrator({ tmux: t }).startNode(resumeInput(seed, adapter, { startupActions: [] }));
      expect(result).toMatchObject({ ok: true, continuityOutcome: "resumed" });
      expect(result.warnings?.join("\n")).toContain("Codex's pane foreground could not be read at the settle check");
    });

    it("control: a Codex that is still under the pane after the wait is ready and resumed", async () => {
      const seed = seedSession();
      const { orch, adapter, sleeps } = exitingCodex("never reached", 60_000);
      expect(await orch.startNode(resumeInput(seed, adapter))).toMatchObject({ ok: true, continuityOutcome: "resumed" });
      expect(sleeps.length).toBeGreaterThan(0);
    });

    it("control: a fresh Codex launch takes no resume wait and is not guarded", async () => {
      const seed = seedSession();
      const { t, orch, adapter, sleeps } = exitingCodex("never reached", 60_000);
      const result = await orch.startNode(makeInput(seed, { adapter, startupActions: [makeAction()] }));
      expect(result).toMatchObject({ ok: true, continuityOutcome: "fresh" });
      expect(sleeps).not.toContain(2500);
      expect(t.sendText).toHaveBeenCalled();
    });
  });

  describe("OF-161 follow-ups: unreadable strikes, stale stops, process listings per send", () => {
    const resumeInput = (seed: ReturnType<typeof seedSession>, extra: Partial<StartupInput> = {}) => makeInput(seed, { adapter: mockAdapter(), isRestore: true,
      resumeToken: "tok-1", resumeType: "claude_id", allowFreshFallback: false, startupActions: [makeAction()], ...extra });
    const readyEvents = (nodeId: string) => db.prepare("SELECT type FROM events WHERE node_id = ? AND type = 'node.startup_ready'").all(nodeId);
    const missingAfterReady = () => vi.fn().mockResolvedValueOnce({ ready: true }).mockResolvedValue({ ready: false, code: "no_conversation_found", reason: "phrase" });
    const unreadable = () => mockTmux({ getPaneCommand: vi.fn(async () => { throw new Error("tmux gone"); }), capturePaneContent: vi.fn(async () => "last pane line") });

    // R3 (z1 review): the unreadable settle read and the first unreadable send are two unreadable reads in a row.
    it("R3: an unreadable settle read counts as the first strike, so the first unreadable send stops the typing", async () => {
      const seed = seedSession();
      const t = unreadable();
      const result = await createOrchestrator({ tmux: t }).startNode(resumeInput(seed, { adapter: mockAdapter({ checkReady: missingAfterReady() }) }));
      expect(result).toMatchObject({ ok: false, startupStatus: "attention_required" });
      if (result.ok) throw new Error("unreadable");
      expect(result.errors.join("\n")).toContain("twice in a row");
      expect(t.sendText).not.toHaveBeenCalled();
      expect(readyEvents(seed.nodeId)).toEqual([]);
    });

    it("R3: a settle read that threw counts as the first strike too", async () => {
      const seed = seedSession();
      const t = unreadable();
      const adapter = mockAdapter({ checkReady: vi.fn().mockResolvedValueOnce({ ready: true }).mockRejectedValue(new Error("capture failed")) });
      const result = await createOrchestrator({ tmux: t }).startNode(resumeInput(seed, { adapter }));
      expect(result).toMatchObject({ ok: false, startupStatus: "attention_required" });
      expect(t.sendText).not.toHaveBeenCalled();
    });

    it("R3 control: a readable foreground at the first send after an unreadable settle read types, and resets the count", async () => {
      const seed = seedSession();
      const reads = vi.fn().mockRejectedValueOnce(new Error("x")).mockResolvedValue("claude");
      const t = mockTmux({ getPaneCommand: reads });
      const result = await createOrchestrator({ tmux: t }).startNode(resumeInput(seed, { adapter: mockAdapter({ checkReady: missingAfterReady() }),
        startupActions: [makeAction(), makeAction({ value: "/b" }), makeAction({ value: "/c" })] }));
      expect(result).toMatchObject({ ok: true });
      expect(t.sendText).toHaveBeenCalledTimes(3);
    });

    // R4 (z1 review): the Claude adapter turns an OPTIONAL file's failed send into nothing; the stop that send recorded
    // went with it and must not turn a later, unrelated failure into attention_required.
    function swallowingAdapter() {
      return mockAdapter({ deliverStartup: vi.fn(async (_files, _binding, send) => {
        for (const _ of [0, 1]) { try { await send?.("optional file"); } catch { /* an optional file's failure is dropped by the adapter */ } }
        return { delivered: 0, failed: [] };
      }) });
    }
    const optionalFile: ResolvedStartupFile = { path: "optional.md", absolutePath: "/fixture/optional.md", ownerRoot: "/fixture", deliveryHint: "send_text", required: false, appliesOn: ["restore"] };
    it("R4: a stop recorded by a swallowed optional-file send does not turn a later plain failure into attention_required", async () => {
      const seed = seedSession();
      // reads: two unreadable (both swallowed sends; the second records the stop), then readable for the action.
      const reads = vi.fn().mockRejectedValueOnce(new Error("x")).mockRejectedValueOnce(new Error("x")).mockResolvedValue("claude");
      const t = mockTmux({ getPaneCommand: reads, sendText: vi.fn(async () => ({ ok: false as const, code: "send_failed", message: "fixture transport failure" })), capturePaneContent: vi.fn(async () => "pane") });
      const result = await createOrchestrator({ tmux: t, readFile: () => "x" }).startNode(resumeInput(seed, { adapter: swallowingAdapter(), resolvedStartupFiles: [optionalFile] }));
      expect(result).toMatchObject({ ok: false, startupStatus: "failed" });
      if (result.ok) throw new Error("unreachable");
      expect(result.errors.join("\n")).toContain("fixture transport failure");
      expect(result.errors.join("\n")).not.toContain("twice in a row");
      expect(db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(seed.sessionId)).toEqual({ startup_status: "failed" });
    });

    it("R4 control: a stop on a send whose failure is NOT swallowed still ends as attention_required", async () => {
      const seed = seedSession();
      const t = unreadable();
      const result = await createOrchestrator({ tmux: t }).startNode(resumeInput(seed, { startupActions: [makeAction(), makeAction({ value: "/second" })] }));
      expect(result).toMatchObject({ ok: false, startupStatus: "attention_required" });
    });

    it("R4 control: a stop on a REQUIRED file's send, which the adapter does report, still ends as attention_required", async () => {
      const seed = seedSession();
      const t = unreadable();
      const adapter = mockAdapter({ deliverStartup: vi.fn(async (_files, _binding, send) => {
        const failed: Array<{ path: string; error: string }> = [];
        for (const _ of [0, 1]) { try { await send?.("required file"); } catch (error) { failed.push({ path: "required.md", error: (error as Error).message }); } }
        return { delivered: 0, failed };
      }) });
      const result = await createOrchestrator({ tmux: t, readFile: () => "x" }).startNode(resumeInput(seed, { adapter, resolvedStartupFiles: [{ ...optionalFile, required: true }], startupActions: [] }));
      expect(result).toMatchObject({ ok: false, startupStatus: "attention_required" });
      if (result.ok) throw new Error("unreachable");
      expect(result.errors.join("\n")).toContain("twice in a row");
    });

    // R5 (z1 review): a guarded send under a shell-named foreground lists every process. One listing serves a short burst.
    // The adapter reports the process it launched, so the launch lists nothing: every listing counted here is a guarded send's.
    const LIVE_TREE: NativeProcessRow[] = [PANE_SHELL, LAUNCHER, CLAUDE_PROC];
    const threeActions = [makeAction(), makeAction({ value: "/b" }), makeAction({ value: "/c" })];
    const launchedAdapter = () => mockAdapter({ launchHarness: vi.fn(async (_binding, opts): Promise<HarnessLaunchResult> => ({ ok: true, resumeToken: opts.resumeToken, resumeType: "claude_id",
      launchedProcess: { pid: 102, startedAt: T0 } })) });
    async function guardedSends(actions: StartupAction[], o: { foreground?: string; now?: () => number; lists?: (call: number) => Promise<NativeProcessRow[]>; twice?: boolean } = {}) {
      const seed = seedSession();
      let calls = 0;
      const listProcesses = vi.fn(async () => (o.lists ?? (async () => LIVE_TREE))(calls++));
      const t = mockTmux({ getPaneCommand: vi.fn(async () => o.foreground ?? "zsh"), capturePaneContent: vi.fn(async () => "") });
      const orch = createOrchestrator({ tmux: t, listProcesses, now: o.now ?? (() => 1_000_000) });
      const result = await orch.startNode(resumeInput(seed, { adapter: launchedAdapter(), startupActions: actions }));
      if (o.twice) await orch.startNode(resumeInput(seed, { adapter: launchedAdapter(), startupActions: actions }));
      return { listings: listProcesses.mock.calls.length, t, result };
    }
    it("R5: a burst of guarded sends within the window lists processes once", async () => {
      const { listings, result, t } = await guardedSends(threeActions);
      expect(result).toMatchObject({ ok: true });
      expect(t.sendText).toHaveBeenCalledTimes(3);
      expect(listings).toBe(1);
    });

    it("R5: the remembered answer expires, so sends further apart than the window each list again", async () => {
      let clock = 1_000_000;
      const { listings, result } = await guardedSends(threeActions, { now: () => (clock += 10_000) });
      expect(result).toMatchObject({ ok: true });
      expect(listings).toBe(3);
    });

    it("R5: the memo is per startup, not shared between two startups of the same seat", async () => {
      expect((await guardedSends([makeAction()], { twice: true })).listings).toBe(2);
    });

    it("R5: only a positive answer is remembered; an unreadable one is re-read by the next send", async () => {
      // The first listing lacks the pane pid (unreadable); every later one shows no Claude under the pane (gone).
      const { result, t, listings } = await guardedSends([makeAction(), makeAction({ value: "/b" })], {
        lists: async (call) => call === 0 ? [LAUNCHER, CLAUDE_PROC] : [PANE_SHELL] });
      expect(result).toMatchObject({ ok: false });
      if (result.ok) throw new Error("unreachable");
      expect(result.errors.join("\n")).toContain("no longer in the foreground");
      expect(t.sendText).toHaveBeenCalledTimes(1);
      expect(listings).toBe(2);
    });

    it("R5: a non-shell foreground never lists processes for a send", async () => {
      const { listings, t } = await guardedSends(threeActions, { foreground: "claude" });
      expect(t.sendText).toHaveBeenCalledTimes(3);
      expect(listings).toBe(0);
    });
  });
});
