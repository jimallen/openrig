import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { SelfAttachService } from "../src/domain/self-attach-service.js";
import { TranscriptStore } from "../src/domain/transcript-store.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";


describe("SelfAttachService", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let podRepo: PodRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let selfAttachService: SelfAttachService;
  let tmuxAdapter: TmuxAdapter;
  let startPipePaneSpy: ReturnType<typeof vi.fn>;
  let ensureContextCollectorSpy: ReturnType<typeof vi.fn>;
  let transcriptStore: TranscriptStore;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    rigRepo = new RigRepository(db);
    podRepo = new PodRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    startPipePaneSpy = vi.fn(async () => ({ ok: true as const }));
    ensureContextCollectorSpy = vi.fn();
    tmuxAdapter = {
      startPipePane: startPipePaneSpy,
    } as unknown as TmuxAdapter;
    transcriptStore = new TranscriptStore({ transcriptsRoot: "/tmp/openrig-self-attach-transcripts", enabled: true });
    selfAttachService = new SelfAttachService({
      db,
      rigRepo,
      podRepo,
      sessionRegistry,
      eventBus,
      tmuxAdapter,
      transcriptStore,
      claudeContextProvisioner: {
        ensureContextCollector: ensureContextCollectorSpy,
      },
    });
  });

  afterEach(() => {
    db.close();
  });

  it("attachToNode binds the current raw agent as external_cli", async () => {
    const rig = rigRepo.createRig("rigged-buildout");
    const node = rigRepo.addNode(rig.id, "orch1.lead", {
      runtime: "claude-code",
      cwd: "/Users/example/code/openrig",
    });

    const result = await selfAttachService.attachToNode({
      rigId: rig.id,
      logicalId: "orch1.lead",
      displayName: "orch1-lead@rigged-buildout",
      cwd: "/Users/example/code/openrig",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.nodeId).toBe(node.id);
    expect(result.logicalId).toBe("orch1.lead");
    expect(result.sessionName).toBe("orch1-lead@rigged-buildout");
    expect(result.attachmentType).toBe("external_cli");
    expect(result.env.OPENRIG_NODE_ID).toBe(node.id);
    expect(result.env.OPENRIG_SESSION_NAME).toBe("orch1-lead@rigged-buildout");

    const binding = sessionRegistry.getBindingForNode(node.id);
    expect(binding?.attachmentType).toBe("external_cli");
    expect(binding?.externalSessionName).toBe("orch1-lead@rigged-buildout");
    expect(binding?.tmuxSession).toBeNull();

    const sessions = sessionRegistry.getSessionsForRig(rig.id).filter((session) => session.nodeId === node.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.origin).toBe("claimed");
    expect(sessions[0]?.sessionName).toBe("orch1-lead@rigged-buildout");
  });

  // OF-75: a session name the registry refuses is refused before any write, with its own code.
  describe("a session name outside the claimed-name character set", () => {
    const counts = (nodeId: string) => ({
      bindings: (db.prepare("SELECT COUNT(*) AS n FROM bindings WHERE node_id = ?").get(nodeId) as { n: number }).n,
      sessions: (db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE node_id = ?").get(nodeId) as { n: number }).n,
      events: (db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'binding.updated'").get() as { n: number }).n,
    });

    it.each(["bad name", "x;touch-y@rig", "a'b@rig", "$(x)@rig", "bad:seat@rig"])("attachToNode (display name %j) leaves no binding, session or event", async (displayName) => {
      const rig = rigRepo.createRig("rig");
      const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
      const result = await selfAttachService.attachToNode({ rigId: rig.id, logicalId: "dev.impl", displayName });
      expect(result).toMatchObject({ ok: false, code: "invalid_session_name" });
      expect(counts(node.id)).toEqual({ bindings: 0, sessions: 0, events: 0 });
    });

    // OF-108: the cap is restated here (200), not imported.
    it("attachToNode refuses a 201-character name with its own message, and a 200-character name attaches", async () => {
      const rig = rigRepo.createRig("rig");
      const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
      const tooLong = await selfAttachService.attachToNode({ rigId: rig.id, logicalId: "dev.impl", displayName: `${"a".repeat(199)}@r` });
      expect(tooLong).toMatchObject({ ok: false, code: "invalid_session_name" });
      expect(!tooLong.ok && tooLong.error).toContain("at most 200 characters");
      expect(counts(node.id)).toEqual({ bindings: 0, sessions: 0, events: 0 });
      expect((await selfAttachService.attachToNode({ rigId: rig.id, logicalId: "dev.impl", displayName: `${"a".repeat(198)}@r` })).ok).toBe(true);
    });

    it("attachToNode with a tmux context holding such a name leaves no binding, session or event", async () => {
      const rig = rigRepo.createRig("rig");
      const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
      const result = await selfAttachService.attachToNode({
        rigId: rig.id, logicalId: "dev.impl",
        context: { attachmentType: "tmux", tmuxSession: "my session;x", tmuxWindow: "0", tmuxPane: "%1" },
      });
      expect(result).toMatchObject({ ok: false, code: "invalid_session_name" });
      expect(counts(node.id)).toEqual({ bindings: 0, sessions: 0, events: 0 });
    });

    it("attachToPod creates no member node for such a name", async () => {
      const rig = rigRepo.createRig("rig");
      const pod = podRepo.createPod(rig.id, "dev", "Dev");
      const before = rigRepo.getRig(rig.id)!.nodes.length;
      const result = await selfAttachService.attachToPod({
        rigId: rig.id, podNamespace: pod.namespace, memberName: "impl", runtime: "claude-code", displayName: "bad name",
      });
      expect(result).toMatchObject({ ok: false, code: "invalid_session_name" });
      expect(rigRepo.getRig(rig.id)!.nodes.length).toBe(before);
    });

    it("control: an ordinary display name still attaches", async () => {
      const rig = rigRepo.createRig("rig");
      rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
      const result = await selfAttachService.attachToNode({ rigId: rig.id, logicalId: "dev.impl", displayName: "dev-impl@rig" });
      expect(result.ok).toBe(true);
    });
  });

  it("attachToNode rejects runtime mismatch for an existing node", async () => {
    const rig = rigRepo.createRig("rigged-buildout");
    rigRepo.addNode(rig.id, "orch1.lead", { runtime: "claude-code" });

    const result = await selfAttachService.attachToNode({
      rigId: rig.id,
      logicalId: "orch1.lead",
      runtime: "codex",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("runtime_mismatch");
  });

  it("attachToPod creates a new pod member with an external_cli binding", async () => {
    const rig = rigRepo.createRig("rigged-buildout");
    const pod = podRepo.createPod(rig.id, "orch1", "Orchestrator");

    const result = await selfAttachService.attachToPod({
      rigId: rig.id,
      podNamespace: pod.namespace,
      memberName: "lead",
      runtime: "claude-code",
      displayName: "orch1-lead@rigged-buildout",
      cwd: "/Users/example/code/openrig",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rigAfter = rigRepo.getRig(rig.id);
    const node = rigAfter?.nodes.find((candidate) => candidate.logicalId === "orch1.lead");
    expect(node).toBeDefined();
    expect(node?.podId).toBe(pod.id);
    expect(node?.runtime).toBe("claude-code");

    const binding = sessionRegistry.getBindingForNode(result.nodeId);
    expect(binding?.attachmentType).toBe("external_cli");
    expect(binding?.externalSessionName).toBe("orch1-lead@rigged-buildout");
  });

  it("attachToNode can self-attach from tmux without discovery", async () => {
    const rig = rigRepo.createRig("rigged-buildout");
    const node = rigRepo.addNode(rig.id, "dev1.impl2", {
      runtime: "claude-code",
    });

    const result = await selfAttachService.attachToNode({
      rigId: rig.id,
      logicalId: "dev1.impl2",
      context: {
        attachmentType: "tmux",
        tmuxSession: "dev1-impl2@rigged-buildout",
        tmuxWindow: "@12",
        tmuxPane: "%34",
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.attachmentType).toBe("tmux");
    expect(result.sessionName).toBe("dev1-impl2@rigged-buildout");

    const binding = sessionRegistry.getBindingForNode(node.id);
    expect(binding?.attachmentType).toBe("tmux");
    expect(binding?.tmuxSession).toBe("dev1-impl2@rigged-buildout");
    expect(binding?.tmuxWindow).toBe("@12");
    expect(binding?.tmuxPane).toBe("%34");
    expect(binding?.externalSessionName).toBeNull();
  });

  it("attachToNode starts transcript capture when self-attaching from tmux", async () => {
    const rig = rigRepo.createRig("rigged-buildout");
    rigRepo.addNode(rig.id, "dev1.impl2", {
      runtime: "claude-code",
    });
    vi.spyOn(transcriptStore, "ensureTranscriptDir").mockReturnValue(true);

    const result = await selfAttachService.attachToNode({
      rigId: rig.id,
      logicalId: "dev1.impl2",
      context: {
        attachmentType: "tmux",
        tmuxSession: "dev1-impl2@rigged-buildout",
        tmuxWindow: "@12",
        tmuxPane: "%34",
      },
    });

    expect(result.ok).toBe(true);
    // V1 pre-release Item 1: transcript capture path now starts a
    // rotation timer (capture-pane overwrite) instead of pipe-pane.
    // The rotation module's first tick calls capturePaneContent on the
    // adapter; with capturePaneContent unstubbed in the smoke harness,
    // the call is best-effort silent. Test the integration boundary
    // via getActiveRotationCount.
    const { getActiveRotationCount, clearAllTranscriptRotationsForTest } =
      await import("../src/domain/transcript-rotation.js");
    expect(getActiveRotationCount()).toBeGreaterThan(0);
    clearAllTranscriptRotationsForTest();
  });

  it("attachToNode provisions Claude context collection when self-attaching from tmux", async () => {
    const rig = rigRepo.createRig("rigged-buildout");
    rigRepo.addNode(rig.id, "dev1.impl2", {
      runtime: "claude-code",
      cwd: "/Users/example/code/openrig",
    });

    const result = await selfAttachService.attachToNode({
      rigId: rig.id,
      logicalId: "dev1.impl2",
      context: {
        attachmentType: "tmux",
        tmuxSession: "dev1-impl2@rigged-buildout",
      },
    });

    expect(result.ok).toBe(true);
    expect(ensureContextCollectorSpy).toHaveBeenCalledWith({
      cwd: "/Users/example/code/openrig",
      tmuxSession: "dev1-impl2@rigged-buildout",
    });
  });
});
