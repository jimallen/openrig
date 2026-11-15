import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { RigSpecSchema } from "../src/domain/rigspec-schema.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import { RigSpecExporter } from "../src/domain/rigspec-exporter.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { ClaudeResumeAdapter, type ResumeResult } from "../src/adapters/claude-resume.js";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { RuntimeAdapter, NodeBinding } from "../src/domain/runtime-adapter.js";
import { existingRigRoot } from "./helpers/existing-rig-root.js";
import { probeSessionFromHasSession } from "./helpers/probe-from-has-session.js";

// `ask_in_modal: true` as a member field: the same plumbing contract as remote_control (remote-control-plumb.test.ts).
// It must survive every node-creation path, persist on the node (nodes.ask_in_modal) and land on the launch binding, so that
// fresh, resume, restore, fork and handover launches all carry the ask-in-modal Stop hook. What the binding turns into on the
// command line is pinned in ask-in-modal-guard.test.ts.

const RIG_ROOT = existingRigRoot("aim-rig");
const WORKSPACE = existingRigRoot("workspace");

const agentYaml = (name: string) => `name: ${name}\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []`;
const rawMember = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id, agent_ref: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: ".", ...over,
});
const rawSpec = (members: Record<string, unknown>[], name = "aim-rig"): Record<string, unknown> => ({
  version: "0.2", name, pods: [{ id: "dev", label: "Dev", members, edges: [] }], edges: [],
});

describe("ask_in_modal: schema validation + normalization", () => {
  it("accepts `true` on a claude-code member and normalizes it to askInModal: true", () => {
    const spec = rawSpec([rawMember("cos", { ask_in_modal: true })]);
    expect(RigSpecSchema.validate(spec)).toMatchObject({ valid: true, errors: [] });
    expect(RigSpecSchema.normalize(spec).pods[0]!.members[0]!.askInModal).toBe(true);
  });

  it("absent and `false` are legal and normalize to undefined (the launch settings are unchanged)", () => {
    for (const member of [rawMember("cos"), rawMember("cos", { ask_in_modal: false })]) {
      const spec = rawSpec([member]);
      expect(RigSpecSchema.validate(spec).valid).toBe(true);
      expect(RigSpecSchema.normalize(spec).pods[0]!.members[0]!.askInModal).toBeUndefined();
    }
  });

  it.each([["yes"], ["true"], [1], [0], [null], [{}]])("rejects the non-boolean %j", (value) => {
    const result = RigSpecSchema.validate(rawSpec([rawMember("cos", { ask_in_modal: value })]));
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toMatch(/pods\[0\]\.members\[0\]\.ask_in_modal: must be a boolean/);
  });

  it.each(["codex", "pi", "omp", "terminal"])("rejects `true` on a %s member", (runtime) => {
    const member = runtime === "terminal"
      ? { id: "t", runtime, agent_ref: "builtin:terminal", profile: "none", cwd: "/tmp", ask_in_modal: true }
      : rawMember("cos", { runtime, ask_in_modal: true });
    const result = RigSpecSchema.validate(rawSpec([member]));
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toMatch(/ask_in_modal: only valid when runtime is "claude-code"/);
  });

  it("`false` on a non-claude member stays legal", () => {
    expect(RigSpecSchema.validate(rawSpec([rawMember("cos", { runtime: "codex", ask_in_modal: false })])).valid).toBe(true);
  });

  it("the kernel rig refuses `true` on any member (kernel seats never ask in a modal); `false` stays legal there", () => {
    const refused = RigSpecSchema.validate(rawSpec([rawMember("cos"), rawMember("op", { ask_in_modal: true })], "kernel"));
    expect(refused.valid).toBe(false);
    expect(refused.errors.join("\n")).toMatch(/pods\[0\]\.members\[1\]\.ask_in_modal: not allowed in the kernel rig/);
    expect(RigSpecSchema.validate(rawSpec([rawMember("op", { ask_in_modal: false })], "kernel")).valid).toBe(true);
    // Control: the same member is accepted in a rig with another name.
    expect(RigSpecSchema.validate(rawSpec([rawMember("op", { ask_in_modal: true })], "kernel-like")).valid).toBe(true);
  });

  it("round-trips through the codec: serialize emits `ask_in_modal: true`; absent is not emitted", () => {
    const withFlag = RigSpecCodec.serialize(RigSpecSchema.normalize(rawSpec([rawMember("cos", { ask_in_modal: true })])));
    expect(withFlag).toMatch(/^\s+ask_in_modal: true$/m);
    expect(RigSpecSchema.normalize(RigSpecCodec.parse(withFlag) as Record<string, unknown>).pods[0]!.members[0]!.askInModal).toBe(true);
    const without = RigSpecCodec.serialize(RigSpecSchema.normalize(rawSpec([rawMember("cos")])));
    expect(without).not.toContain("ask_in_modal");
  });
});

describe("ask_in_modal: persistence on the node (rig repository) and export", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  beforeEach(() => { db = createFullTestDb(); rigRepo = new RigRepository(db); });
  afterEach(() => { db.close(); });

  it("addNode persists a declared flag; nodes that never declared it carry no key at all", () => {
    const rig = rigRepo.createRig("r");
    const on = rigRepo.addNode(rig.id, "dev.on", { runtime: "claude-code", askInModal: true });
    const off = rigRepo.addNode(rig.id, "dev.off", { runtime: "claude-code" });
    expect(db.prepare("SELECT logical_id, ask_in_modal FROM nodes ORDER BY logical_id").all())
      .toEqual([{ logical_id: "dev.off", ask_in_modal: null }, { logical_id: "dev.on", ask_in_modal: 1 }]);
    const nodes = rigRepo.getRig(rig.id)!.nodes;
    expect(nodes.find((n) => n.id === on.id)!.askInModal).toBe(true);
    // Snapshots serialize these Node objects: an undeclared seat must be byte-identical to before.
    expect("askInModal" in nodes.find((n) => n.id === off.id)!).toBe(false);
  });

  it("setNodeAskInModal declares and withdraws", () => {
    const rig = rigRepo.createRig("r");
    const node = rigRepo.addNode(rig.id, "dev.x", { runtime: "claude-code" });
    expect(rigRepo.setNodeAskInModal(node.id, true)).toBe(true);
    expect(rigRepo.getRig(rig.id)!.nodes[0]!.askInModal).toBe(true);
    expect(rigRepo.setNodeAskInModal(node.id, false)).toBe(true);
    expect("askInModal" in rigRepo.getRig(rig.id)!.nodes[0]!).toBe(false);
  });

  it("the pod-aware exporter writes the declaration back into the exported member", () => {
    const rig = rigRepo.createRig("r");
    const pod = new PodRepository(db).createPod(rig.id, "dev", "Dev", {});
    rigRepo.addNode(rig.id, "dev.cos", { runtime: "claude-code", podId: pod.id, agentRef: "local:agents/impl", profile: "default", cwd: "/w", askInModal: true });
    rigRepo.addNode(rig.id, "dev.plain", { runtime: "claude-code", podId: pod.id, agentRef: "local:agents/impl", profile: "default", cwd: "/w" });
    const spec = new RigSpecExporter({ rigRepo, sessionRegistry: new SessionRegistry(db), podRepo: new PodRepository(db) }).exportRig(rig.id);
    if (!("pods" in spec)) throw new Error("expected the pod-aware export");
    const members = spec.pods.flatMap((p) => p.members);
    expect(members.find((m) => m.id === "cos")!.askInModal).toBe(true);
    expect(members.find((m) => m.id === "plain")!.askInModal).toBeUndefined();
  });
});

describe("ask_in_modal: plumbed across the node-creation paths and onto the launch binding", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;
  let launchHarness: Mock<RuntimeAdapter["launchHarness"]>;

  beforeEach(() => {
    db = createFullTestDb();
    launchHarness = vi.fn<RuntimeAdapter["launchHarness"]>(async () => ({ ok: true as const }));
    const adapter: RuntimeAdapter = {
      runtime: "claude-code",
      listInstalled: vi.fn(async () => []),
      project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
      checkReady: vi.fn(async () => ({ ready: true })),
      launchHarness,
    };
    setup = createTestApp(db, {
      adapters: { "claude-code": adapter },
      podInstantiatorFsOps: {
        readFile: (p: string) => { if (p.includes("agents/impl")) return agentYaml("impl"); throw new Error(`Not found: ${p}`); },
        exists: (p: string) => p.includes("agents/impl"),
      },
    });
  });
  afterEach(() => { db.close(); });

  const column = (logicalId: string): number | null => {
    const row = db.prepare("SELECT ask_in_modal FROM nodes WHERE logical_id = ?").get(logicalId) as { ask_in_modal: number | null } | undefined;
    expect(row, `node ${logicalId} should exist`).toBeDefined();
    return row!.ask_in_modal;
  };
  const launchedWith = (logicalId: string): NodeBinding => {
    const nodeId = (db.prepare("SELECT id FROM nodes WHERE logical_id = ?").get(logicalId) as { id: string }).id;
    const call = launchHarness.mock.calls.map((c) => c[0]).find((b) => b.nodeId === nodeId);
    expect(call, `launchHarness was called for ${logicalId}`).toBeDefined();
    return call!;
  };

  it("initial pod materialize: spec -> nodes.ask_in_modal", async () => {
    const outcome = await setup.podInstantiator.materializeStructured(rawSpec([rawMember("cos", { ask_in_modal: true }), rawMember("plain")]), RIG_ROOT);
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(column("dev.cos")).toBe(1);
    expect(column("dev.plain")).toBeNull();
  });

  it("rig expand (structured fragment)", async () => {
    const rig = setup.rigRepo.createRig("aim-rig");
    const expanded = await setup.rigExpansionService.expand({
      rigId: rig.id, rigRoot: RIG_ROOT,
      pod: { id: "qa", label: "QA", members: [
        { id: "asks", runtime: "claude-code", agentRef: "local:agents/impl", profile: "default", cwd: ".", askInModal: true },
        { id: "quiet", runtime: "claude-code", agentRef: "local:agents/impl", profile: "default", cwd: "." },
      ], edges: [] },
    });
    expect(expanded.ok, JSON.stringify(expanded)).toBe(true);
    expect(column("qa.asks")).toBe(1);
    expect(column("qa.quiet")).toBeNull();
    expect(launchedWith("qa.asks").askInModal).toBe(true);
    expect("askInModal" in launchedWith("qa.quiet")).toBe(false);
  });

  const expandViaRoute = (rigId: string, member: Record<string, unknown>) => setup.app.request(`/api/rigs/${rigId}/expand`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rigRoot: RIG_ROOT, pod: { id: "web", label: "Web", members: [member], edges: [] } }),
  });
  const routeMember = (over: Record<string, unknown>) => ({ id: "m", runtime: "claude-code", agent_ref: "local:agents/impl", profile: "default", cwd: ".", ...over });

  it.each([["ask_in_modal"], ["askInModal"]])("the HTTP expand ingress carries `%s: true` through", async (key) => {
    const rig = setup.rigRepo.createRig("aim-rig");
    const res = await expandViaRoute(rig.id, routeMember({ [key]: true }));
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    expect(column("web.m")).toBe(1);
    expect(launchedWith("web.m").askInModal).toBe(true);
  });

  it("the HTTP expand ingress: a present-invalid value is a structured 400 with zero persistence", async () => {
    const rig = setup.rigRepo.createRig("aim-rig");
    const res = await expandViaRoute(rig.id, routeMember({ ask_in_modal: "yes" }));
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/ask_in_modal: must be a boolean/);
    expect(db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE logical_id LIKE 'web.%'").get()).toMatchObject({ c: 0 });
    expect(launchHarness).not.toHaveBeenCalled();
  });

  it("add_member: a raw `ask_in_modal: true` fragment lands on the node and the binding", async () => {
    const outcome = await setup.podInstantiator.materializeStructured(rawSpec([rawMember("seed")]), RIG_ROOT);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const added = await setup.podInstantiator.addMemberToPod(outcome.result.rigId, "dev", rawMember("added", { ask_in_modal: true }), RIG_ROOT);
    expect(added.ok, JSON.stringify(added)).toBe(true);
    expect(column("dev.added")).toBe(1);
    expect(launchedWith("dev.added").askInModal).toBe(true);
  });

  it.each([
    ["withdrawn: node declared it, the member no longer does", true, false],
    ["added: node had not declared it, the member now does", false, true],
  ])("a relaunch from the spec re-syncs the persisted declaration (%s)", async (_label, before, after) => {
    const outcome = await setup.podInstantiator.materializeStructured(rawSpec([rawMember("cos", before ? { ask_in_modal: true } : {})]), RIG_ROOT);
    expect(outcome.ok).toBe(true);
    expect(column("dev.cos")).toBe(before ? 1 : null);
    const rigId = (outcome as { ok: true; result: { rigId: string } }).result.rigId;
    const nodeId = (db.prepare("SELECT id FROM nodes WHERE logical_id = 'dev.cos'").get() as { id: string }).id;
    const edited = RigSpecSchema.normalize(rawSpec([rawMember("cos", after ? { ask_in_modal: true } : {})]));
    const pod = edited.pods[0]!;
    const launched = await setup.podInstantiator.launchBinding({ rigId, rigSpec: edited, rigRoot: RIG_ROOT, pod, member: pod.members[0]!, qualifiedId: "dev.cos", nodeId });
    expect(launched.status, JSON.stringify(launched)).toBe("launched");
    expect(column("dev.cos")).toBe(after ? 1 : null);
    const binding = launchedWith("dev.cos");
    if (after) expect(binding.askInModal).toBe(true);
    else expect("askInModal" in binding).toBe(false);
  });

  it("bootstrap instantiate-from-YAML (`rig up <spec>`): its own inline addNode persists it and the launch carries it", async () => {
    const yaml = RigSpecCodec.serialize(RigSpecSchema.normalize(rawSpec([rawMember("cos", { ask_in_modal: true }), rawMember("plain")])));
    const outcome = await setup.podInstantiator.instantiate(yaml, RIG_ROOT);
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(column("dev.cos")).toBe(1);
    expect(column("dev.plain")).toBeNull();
    expect(launchedWith("dev.cos").askInModal).toBe(true);
    expect("askInModal" in launchedWith("dev.plain")).toBe(false);
  });
});

describe("ask_in_modal: legacy (non-pod) restore passes the persisted declaration to the resume adapter", () => {
  const dbs: ReturnType<typeof createFullTestDb>[] = [];
  afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

  it.each([
    ["neither", false, false],
    ["ask_in_modal only", false, true],
    ["remote_control and ask_in_modal", true, true],
  ])("%s", async (_label, remoteControl, askInModal) => {
    const db = createFullTestDb(); dbs.push(db);
    const rigRepo = new RigRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    const snapshotRepo = new SnapshotRepository(db);
    const checkpointStore = new CheckpointStore(db);
    const snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });
    const rig = rigRepo.createRig("legacy-rig");
    const node = rigRepo.addNode(rig.id, "cos", { runtime: "claude-code", cwd: WORKSPACE, ...(remoteControl ? { remoteControl: true } : {}), ...(askInModal ? { askInModal: true } : {}) });
    const session = sessionRegistry.registerSession(node.id, "cos@legacy-rig");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateStartupStatus(session.id, "ready", new Date().toISOString());
    db.prepare("UPDATE sessions SET resume_type = 'claude_name', resume_token = 'tok-1' WHERE id = ?").run(session.id);
    const snapshot = snapshotCapture.captureSnapshot(rig.id, "manual");
    const partialTmux: Partial<TmuxAdapter> = {
      createSession: vi.fn(async () => ({ ok: true as const })), killSession: vi.fn(async () => ({ ok: true as const })), listSessions: vi.fn(async () => []),
      probeSession: probeSessionFromHasSession, hasSession: vi.fn(async () => false), sendText: vi.fn(async () => ({ ok: true as const })), sendKeys: vi.fn(async () => ({ ok: true as const })),
      listWindows: vi.fn(async () => []), listPanes: vi.fn(async () => []), getPaneCommand: vi.fn(async () => "claude"),
    };
    const tmux = partialTmux as TmuxAdapter;
    // The resume adapters as recorders: the claude one takes every token and records its arguments; the codex one takes none.
    const calls: unknown[][] = [];
    class RecordingClaudeResume extends ClaudeResumeAdapter {
      override canResume(): boolean { return true; }
      override async resume(...args: Parameters<ClaudeResumeAdapter["resume"]>): Promise<ResumeResult> { calls.push(args); return { ok: true }; }
    }
    class NoCodexResume extends CodexResumeAdapter {
      override canResume(): boolean { return false; }
    }
    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    const restore = new RestoreOrchestrator({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture, checkpointStore,
      nodeLauncher, tmuxAdapter: tmux, claudeResume: new RecordingClaudeResume(tmux), codexResume: new NoCodexResume(tmux) });
    expect((await restore.restore(snapshot.id)).ok).toBe(true);
    expect(calls).toHaveLength(1);
    // (sessionName, resumeType, resumeToken, cwd, posture, model, permissionMode, nodeId, ...tail). Today's tail for this seat is
    // [effort=null, nonInterruptive=false, kernelAuthority=false, teamPermissionDefault=true]; ask_in_modal adds slot 6 (and fills
    // slot 5 with the remote_control declaration); an undeclared seat keeps exactly today's call.
    const tail = calls[0]!.slice(8);
    const expected = askInModal ? [null, false, false, true, remoteControl, true] : [null, false, false, true];
    expect(tail).toEqual(expected);
  });
});
