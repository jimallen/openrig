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
import { RigTeardownOrchestrator } from "../src/domain/rig-teardown.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { ClaudeResumeAdapter, type ResumeResult } from "../src/adapters/claude-resume.js";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { RuntimeAdapter, NodeBinding } from "../src/domain/runtime-adapter.js";
import { existingRigRoot } from "./helpers/existing-rig-root.js";
import { probeSessionFromHasSession } from "./helpers/probe-from-has-session.js";

// `code_mode: true` as a member field: the same plumbing contract as remote_control (remote-control-plumb.test.ts).
// It must survive every node-creation path, persist on the node (nodes.code_mode) and land on the launch binding, so that
// fresh, resume, restore, fork and handover launches all set CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1 (workspaces-o9o.123). What the binding
// turns into on the command line is pinned in claude-code-mode-launch.test.ts.

const RIG_ROOT = existingRigRoot("cm-rig");
const WORKSPACE = existingRigRoot("workspace");

const agentYaml = (name: string) => `name: ${name}\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []`;
const rawMember = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id, agent_ref: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: ".", ...over,
});
const rawSpec = (members: Record<string, unknown>[], name = "cm-rig"): Record<string, unknown> => ({
  version: "0.2", name, pods: [{ id: "dev", label: "Dev", members, edges: [] }], edges: [],
});

describe("code_mode: schema validation + normalization", () => {
  it("accepts `true` on a claude-code member and normalizes it to codeMode: true", () => {
    const spec = rawSpec([rawMember("cos", { code_mode: true })]);
    expect(RigSpecSchema.validate(spec)).toMatchObject({ valid: true, errors: [] });
    expect(RigSpecSchema.normalize(spec).pods[0]!.members[0]!.codeMode).toBe(true);
  });

  it("absent and `false` are legal and normalize to undefined (the launch settings are unchanged)", () => {
    for (const member of [rawMember("cos"), rawMember("cos", { code_mode: false })]) {
      const spec = rawSpec([member]);
      expect(RigSpecSchema.validate(spec).valid).toBe(true);
      expect(RigSpecSchema.normalize(spec).pods[0]!.members[0]!.codeMode).toBeUndefined();
    }
  });

  it.each([["yes"], ["true"], [1], [0], [null], [{}]])("rejects the non-boolean %j", (value) => {
    const result = RigSpecSchema.validate(rawSpec([rawMember("cos", { code_mode: value })]));
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toMatch(/pods\[0\]\.members\[0\]\.code_mode: must be a boolean/);
  });

  it.each(["codex", "pi", "omp", "terminal"])("rejects `true` on a %s member", (runtime) => {
    const member = runtime === "terminal"
      ? { id: "t", runtime, agent_ref: "builtin:terminal", profile: "none", cwd: "/tmp", code_mode: true }
      : rawMember("cos", { runtime, code_mode: true });
    const result = RigSpecSchema.validate(rawSpec([member]));
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toMatch(/code_mode: only valid when runtime is "claude-code"/);
  });

  it("`false` on a non-claude member stays legal", () => {
    expect(RigSpecSchema.validate(rawSpec([rawMember("cos", { runtime: "codex", code_mode: false })])).valid).toBe(true);
  });

  it("refuses `true` together with remote_control: true on the same member (Code Mode turns itself off under Remote Control)", () => {
    const refused = RigSpecSchema.validate(rawSpec([rawMember("cos", { code_mode: true, remote_control: true })]));
    expect(refused.valid).toBe(false);
    expect(refused.errors.join("\n")).toMatch(/pods\[0\]\.members\[0\]\.code_mode: cannot be combined with remote_control/);
    // Controls: either one alone is legal, and code_mode: false beside remote_control: true is legal.
    expect(RigSpecSchema.validate(rawSpec([rawMember("cos", { code_mode: true })])).valid).toBe(true);
    expect(RigSpecSchema.validate(rawSpec([rawMember("cos", { remote_control: true })])).valid).toBe(true);
    expect(RigSpecSchema.validate(rawSpec([rawMember("cos", { code_mode: false, remote_control: true })])).valid).toBe(true);
  });

  it("round-trips through the codec: serialize emits `code_mode: true`; absent is not emitted", () => {
    const withFlag = RigSpecCodec.serialize(RigSpecSchema.normalize(rawSpec([rawMember("cos", { code_mode: true })])));
    expect(withFlag).toMatch(/^\s+code_mode: true$/m);
    expect(RigSpecSchema.normalize(RigSpecCodec.parse(withFlag) as Record<string, unknown>).pods[0]!.members[0]!.codeMode).toBe(true);
    const without = RigSpecCodec.serialize(RigSpecSchema.normalize(rawSpec([rawMember("cos")])));
    expect(without).not.toContain("code_mode");
  });
});

describe("code_mode: persistence on the node (rig repository) and export", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  beforeEach(() => { db = createFullTestDb(); rigRepo = new RigRepository(db); });
  afterEach(() => { db.close(); });

  it("addNode persists a declared flag; nodes that never declared it carry no key at all", () => {
    const rig = rigRepo.createRig("r");
    const on = rigRepo.addNode(rig.id, "dev.on", { runtime: "claude-code", codeMode: true });
    const off = rigRepo.addNode(rig.id, "dev.off", { runtime: "claude-code" });
    expect(db.prepare("SELECT logical_id, code_mode FROM nodes ORDER BY logical_id").all())
      .toEqual([{ logical_id: "dev.off", code_mode: null }, { logical_id: "dev.on", code_mode: 1 }]);
    const nodes = rigRepo.getRig(rig.id)!.nodes;
    expect(nodes.find((n) => n.id === on.id)!.codeMode).toBe(true);
    // Snapshots serialize these Node objects: an undeclared seat must be byte-identical to before.
    expect("codeMode" in nodes.find((n) => n.id === off.id)!).toBe(false);
  });

  it("setNodeCodeMode declares and withdraws", () => {
    const rig = rigRepo.createRig("r");
    const node = rigRepo.addNode(rig.id, "dev.x", { runtime: "claude-code" });
    expect(rigRepo.setNodeCodeMode(node.id, true)).toBe(true);
    expect(rigRepo.getRig(rig.id)!.nodes[0]!.codeMode).toBe(true);
    expect(rigRepo.setNodeCodeMode(node.id, false)).toBe(true);
    expect("codeMode" in rigRepo.getRig(rig.id)!.nodes[0]!).toBe(false);
  });

  it("the pod-aware exporter writes the declaration back into the exported member", () => {
    const rig = rigRepo.createRig("r");
    const pod = new PodRepository(db).createPod(rig.id, "dev", "Dev", {});
    rigRepo.addNode(rig.id, "dev.cos", { runtime: "claude-code", podId: pod.id, agentRef: "local:agents/impl", profile: "default", cwd: "/w", codeMode: true });
    rigRepo.addNode(rig.id, "dev.plain", { runtime: "claude-code", podId: pod.id, agentRef: "local:agents/impl", profile: "default", cwd: "/w" });
    const spec = new RigSpecExporter({ rigRepo, sessionRegistry: new SessionRegistry(db), podRepo: new PodRepository(db) }).exportRig(rig.id);
    if (!("pods" in spec)) throw new Error("expected the pod-aware export");
    const members = spec.pods.flatMap((p) => p.members);
    expect(members.find((m) => m.id === "cos")!.codeMode).toBe(true);
    expect(members.find((m) => m.id === "plain")!.codeMode).toBeUndefined();
  });
});

describe("code_mode: plumbed across the node-creation paths and onto the launch binding", () => {
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
    const row = db.prepare("SELECT code_mode FROM nodes WHERE logical_id = ?").get(logicalId) as { code_mode: number | null } | undefined;
    expect(row, `node ${logicalId} should exist`).toBeDefined();
    return row!.code_mode;
  };
  const launchedWith = (logicalId: string): NodeBinding => {
    const nodeId = (db.prepare("SELECT id FROM nodes WHERE logical_id = ?").get(logicalId) as { id: string }).id;
    const call = launchHarness.mock.calls.map((c) => c[0]).find((b) => b.nodeId === nodeId);
    expect(call, `launchHarness was called for ${logicalId}`).toBeDefined();
    return call!;
  };

  it("initial pod materialize: spec -> nodes.code_mode", async () => {
    const outcome = await setup.podInstantiator.materializeStructured(rawSpec([rawMember("cos", { code_mode: true }), rawMember("plain")]), RIG_ROOT);
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(column("dev.cos")).toBe(1);
    expect(column("dev.plain")).toBeNull();
  });

  it("rig expand (structured fragment)", async () => {
    const rig = setup.rigRepo.createRig("cm-rig");
    const expanded = await setup.rigExpansionService.expand({
      rigId: rig.id, rigRoot: RIG_ROOT,
      pod: { id: "qa", label: "QA", members: [
        { id: "asks", runtime: "claude-code", agentRef: "local:agents/impl", profile: "default", cwd: ".", codeMode: true },
        { id: "quiet", runtime: "claude-code", agentRef: "local:agents/impl", profile: "default", cwd: "." },
      ], edges: [] },
    });
    expect(expanded.ok, JSON.stringify(expanded)).toBe(true);
    expect(column("qa.asks")).toBe(1);
    expect(column("qa.quiet")).toBeNull();
    expect(launchedWith("qa.asks").codeMode).toBe(true);
    expect("codeMode" in launchedWith("qa.quiet")).toBe(false);
  });

  const expandViaRoute = (rigId: string, member: Record<string, unknown>) => setup.app.request(`/api/rigs/${rigId}/expand`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rigRoot: RIG_ROOT, pod: { id: "web", label: "Web", members: [member], edges: [] } }),
  });
  const routeMember = (over: Record<string, unknown>) => ({ id: "m", runtime: "claude-code", agent_ref: "local:agents/impl", profile: "default", cwd: ".", ...over });

  it.each([["code_mode"], ["codeMode"]])("the HTTP expand ingress carries `%s: true` through", async (key) => {
    const rig = setup.rigRepo.createRig("cm-rig");
    const res = await expandViaRoute(rig.id, routeMember({ [key]: true }));
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    expect(column("web.m")).toBe(1);
    expect(launchedWith("web.m").codeMode).toBe(true);
  });

  it("the HTTP expand ingress: a present-invalid value is a structured 400 with zero persistence", async () => {
    const rig = setup.rigRepo.createRig("cm-rig");
    const res = await expandViaRoute(rig.id, routeMember({ code_mode: "yes" }));
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/code_mode: must be a boolean/);
    expect(db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE logical_id LIKE 'web.%'").get()).toMatchObject({ c: 0 });
    expect(launchHarness).not.toHaveBeenCalled();
  });

  it("add_member: a raw `code_mode: true` fragment lands on the node and the binding", async () => {
    const outcome = await setup.podInstantiator.materializeStructured(rawSpec([rawMember("seed")]), RIG_ROOT);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const added = await setup.podInstantiator.addMemberToPod(outcome.result.rigId, "dev", rawMember("added", { code_mode: true }), RIG_ROOT);
    expect(added.ok, JSON.stringify(added)).toBe(true);
    expect(column("dev.added")).toBe(1);
    expect(launchedWith("dev.added").codeMode).toBe(true);
  });

  it.each([
    ["withdrawn: node declared it, the member no longer does", true, false],
    ["added: node had not declared it, the member now does", false, true],
  ])("a relaunch from the spec re-syncs the persisted declaration (%s)", async (_label, before, after) => {
    const outcome = await setup.podInstantiator.materializeStructured(rawSpec([rawMember("cos", before ? { code_mode: true } : {})]), RIG_ROOT);
    expect(outcome.ok).toBe(true);
    expect(column("dev.cos")).toBe(before ? 1 : null);
    const rigId = (outcome as { ok: true; result: { rigId: string } }).result.rigId;
    const nodeId = (db.prepare("SELECT id FROM nodes WHERE logical_id = 'dev.cos'").get() as { id: string }).id;
    const edited = RigSpecSchema.normalize(rawSpec([rawMember("cos", after ? { code_mode: true } : {})]));
    const pod = edited.pods[0]!;
    const launched = await setup.podInstantiator.launchBinding({ rigId, rigSpec: edited, rigRoot: RIG_ROOT, pod, member: pod.members[0]!, qualifiedId: "dev.cos", nodeId });
    expect(launched.status, JSON.stringify(launched)).toBe("launched");
    expect(column("dev.cos")).toBe(after ? 1 : null);
    const binding = launchedWith("dev.cos");
    if (after) expect(binding.codeMode).toBe(true);
    else expect("codeMode" in binding).toBe(false);
  });

  it("bootstrap instantiate-from-YAML (`rig up <spec>`): its own inline addNode persists it and the launch carries it", async () => {
    const yaml = RigSpecCodec.serialize(RigSpecSchema.normalize(rawSpec([rawMember("cos", { code_mode: true }), rawMember("plain")])));
    const outcome = await setup.podInstantiator.instantiate(yaml, RIG_ROOT);
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(column("dev.cos")).toBe(1);
    expect(column("dev.plain")).toBeNull();
    expect(launchedWith("dev.cos").codeMode).toBe(true);
    expect("codeMode" in launchedWith("dev.plain")).toBe(false);
  });
});

describe("code_mode: legacy (non-pod) restore passes the persisted declaration to the resume adapter", () => {
  const dbs: ReturnType<typeof createFullTestDb>[] = [];
  afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

  it.each([
    ["neither", false, false],
    ["code_mode only", false, true],
    ["ask_in_modal and code_mode", true, true],
  ])("%s", async (_label, askInModal, codeMode) => {
    const db = createFullTestDb(); dbs.push(db);
    const rigRepo = new RigRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    const snapshotRepo = new SnapshotRepository(db);
    const checkpointStore = new CheckpointStore(db);
    const snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });
    const rig = rigRepo.createRig("legacy-rig");
    const node = rigRepo.addNode(rig.id, "cos", { runtime: "claude-code", cwd: WORKSPACE, ...(askInModal ? { askInModal: true } : {}), ...(codeMode ? { codeMode: true } : {}) });
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
    // [effort=null, nonInterruptive=false, kernelAuthority=false, teamPermissionDefault=true]; code_mode adds slot 7 (and fills
    // slots 5 and 6 with the remote_control and ask_in_modal declarations); an undeclared seat keeps exactly today's call.
    const tail = calls[0]!.slice(8);
    const expected = codeMode ? [null, false, false, true, false, askInModal, true] : [null, false, false, true];
    expect(tail).toEqual(expected);
  });
});

describe("code_mode: the pod-aware restore's FRESH relaunch (no resume token) binds the persisted declaration", () => {
  const dbs: ReturnType<typeof createFullTestDb>[] = [];
  afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

  // The same down -> snapshot -> restore chain as remote-control-lifecycle.test.ts, with no resume token, so restore takes the
  // fresh relaunch (the startNode binding in restore-orchestrator) instead of attemptResume.
  it.each([[true], [false]])("declared=%s", async (codeMode) => {
    const db = createFullTestDb(); dbs.push(db);
    const rigRepo = new RigRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    const snapshotRepo = new SnapshotRepository(db);
    const checkpointStore = new CheckpointStore(db);
    const snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });
    const rig = rigRepo.createRig("fresh-restore");
    db.prepare("INSERT INTO pods (id, rig_id, label) VALUES (?, ?, ?)").run("restore-pod", rig.id, "Test");
    const node = rigRepo.addNode(rig.id, "exec.cos", { runtime: "claude-code", podId: "restore-pod", cwd: WORKSPACE, ...(codeMode ? { codeMode: true } : {}) });
    const name = "exec-cos@fresh-restore";
    const old = sessionRegistry.registerSession(node.id, name);
    sessionRegistry.updateStatus(old.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: name, tmuxPane: "%old" });
    db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)").run(node.id, "[]", "[]", "[]", "claude-code");
    let live = true;
    const partialTmux: Partial<TmuxAdapter> = {
      hasSession: vi.fn(async () => live),
      probeSession: vi.fn(async () => ({ state: live ? "present" as const : "absent" as const })),
      killSession: vi.fn(async () => { live = false; return { ok: true as const }; }),
      createSession: vi.fn(async () => { live = true; return { ok: true as const }; }),
      listSessions: vi.fn(async () => []),
      listWindows: vi.fn(async () => []),
      listPanes: vi.fn(async () => [{ id: "%new", index: 0, cwd: "/", width: 80, height: 24, active: true }]),
      getPaneCommand: vi.fn(async () => "claude"),
      capturePaneContent: vi.fn(async () => ""),
      sendText: vi.fn(async () => ({ ok: true as const })),
      sendKeys: vi.fn(async () => ({ ok: true as const })),
    };
    const tmux = partialTmux as TmuxAdapter;
    const down = await new RigTeardownOrchestrator({ db, rigRepo, sessionRegistry, eventBus, snapshotCapture, tmuxAdapter: tmux }).teardown(rig.id);
    expect(down.errors).toEqual([]);
    const launchHarness = vi.fn<RuntimeAdapter["launchHarness"]>(async () => ({ ok: true as const }));
    const adapter: RuntimeAdapter = {
      runtime: "claude-code",
      listInstalled: vi.fn(async () => []),
      project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
      checkReady: vi.fn(async () => ({ ready: true })),
      launchHarness,
    };
    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    const restore = new RestoreOrchestrator({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
      checkpointStore, nodeLauncher, tmuxAdapter: tmux, claudeResume: new ClaudeResumeAdapter(tmux), codexResume: new CodexResumeAdapter(tmux) });
    // `rig up --existing <rig> --fresh exec.cos`: the seat skips the resume attempt and is relaunched fresh (`fresh-primed`).
    const up = await restore.restore(down.snapshotId!, { adapters: { "claude-code": adapter }, freshLogicalIds: ["exec.cos"] });
    if (!up.ok) throw new Error(up.message);
    expect(up.result.nodes[0], JSON.stringify(up.result)).toMatchObject({ status: "fresh-primed" });
    expect(launchHarness).toHaveBeenCalledTimes(1);
    const binding = launchHarness.mock.calls[0]![0];
    if (codeMode) expect(binding.codeMode).toBe(true);
    else expect("codeMode" in binding).toBe(false);
  });
});
