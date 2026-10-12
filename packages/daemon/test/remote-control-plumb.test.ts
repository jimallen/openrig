import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { RigSpecSchema } from "../src/domain/rigspec-schema.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import { RigSpecExporter } from "../src/domain/rigspec-exporter.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { applyProjectRig } from "../src/domain/project-rig.js";
import { parse as parseYaml } from "yaml";
import type { RuntimeAdapter, NodeBinding } from "../src/domain/runtime-adapter.js";
import type { RigSpec } from "../src/domain/types.js";

// Claude Code Remote Control as a member field: `remote_control: true`.
//
// Field name: snake_case boolean, like the neighbouring spec booleans (`non_interruptive`,
// `project_rig`) and the neighbouring member keys (`restore_policy`, `codex_config_profile`).
// Non-claude runtimes: `true` is a VALIDATION ERROR (not silently ignored) -- only claude has the
// flag, and a declaration that does nothing misleads the operator; `false` stays legal anywhere.
//
// Same shape as rigspec-role-plumb.test.ts: the field must survive EVERY node-creation path and land
// on the launch binding, so a per-path field map cannot silently drop it.

const RIG_ROOT = "/project/rigs/rc-rig";

const agentYaml = (name: string) => `name: ${name}\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []`;

const rawMember = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id, agent_ref: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: ".", ...over,
});
const rawSpec = (members: Record<string, unknown>[], name = "rc-rig"): Record<string, unknown> => ({
  version: "0.2", name, pods: [{ id: "dev", label: "Dev", members, edges: [] }], edges: [],
});

describe("remote_control: schema validation + normalization", () => {
  it("accepts `true` on a claude-code member and normalizes it to remoteControl: true", () => {
    const spec = rawSpec([rawMember("cos", { remote_control: true })]);
    expect(RigSpecSchema.validate(spec)).toMatchObject({ valid: true, errors: [] });
    expect(RigSpecSchema.normalize(spec).pods[0]!.members[0]!.remoteControl).toBe(true);
  });

  it("absent and `false` are legal and normalize to undefined (the launch command is unchanged)", () => {
    for (const member of [rawMember("cos"), rawMember("cos", { remote_control: false })]) {
      const spec = rawSpec([member]);
      expect(RigSpecSchema.validate(spec).valid).toBe(true);
      expect(RigSpecSchema.normalize(spec).pods[0]!.members[0]!.remoteControl).toBeUndefined();
    }
  });

  it.each([["yes"], ["true"], [1], [0], [null], [{}]])("rejects the non-boolean %j (never silently dropped)", (value) => {
    const result = RigSpecSchema.validate(rawSpec([rawMember("cos", { remote_control: value })]));
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toMatch(/pods\[0\]\.members\[0\]\.remote_control: must be a boolean/);
  });

  it.each(["codex", "pi", "omp", "terminal"])("rejects `true` on a %s member", (runtime) => {
    const member = runtime === "terminal"
      ? { id: "t", runtime, agent_ref: "builtin:terminal", profile: "none", cwd: "/tmp", remote_control: true }
      : rawMember("cos", { runtime, remote_control: true });
    const result = RigSpecSchema.validate(rawSpec([member]));
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toMatch(/remote_control: only valid when runtime is "claude-code"/);
  });

  it("`false` on a non-claude member stays legal", () => {
    expect(RigSpecSchema.validate(rawSpec([rawMember("cos", { runtime: "codex", remote_control: false })])).valid).toBe(true);
  });

  it("round-trips through the codec: serialize emits `remote_control: true`; absent is not emitted", () => {
    const withRc = RigSpecCodec.serialize(RigSpecSchema.normalize(rawSpec([rawMember("cos", { remote_control: true })])) as unknown as RigSpec);
    expect(withRc).toMatch(/^\s+remote_control: true$/m);
    expect(RigSpecSchema.normalize(RigSpecCodec.parse(withRc)).pods[0]!.members[0]!.remoteControl).toBe(true);
    const without = RigSpecCodec.serialize(RigSpecSchema.normalize(rawSpec([rawMember("cos")])) as unknown as RigSpec);
    expect(without).not.toContain("remote_control");
  });
});

describe("remote_control: project_rig projection carries the member field through unchanged", () => {
  const SPEC = `version: "0.2"
name: team
project_rig: true
pods:
  - id: exec
    label: Exec
    members:
      - id: cos
        agent_ref: "local:agents/cos"
        profile: default
        runtime: claude-code
        remote_control: true
        cwd: "."
      - id: plain
        agent_ref: "local:agents/cos"
        profile: default
        runtime: claude-code
        cwd: "."
    edges: []
edges: []
`;
  it("projects cwd but leaves remote_control (and its absence) exactly as authored", () => {
    const r = applyProjectRig(SPEC, "/work/proj");
    expect(r.kind).toBe("project_rig");
    if (r.kind !== "project_rig") return;
    const out = parseYaml(r.rigSpecYaml) as { pods: Array<{ members: Array<Record<string, unknown>> }> };
    expect(out.pods[0]!.members[0]!.remote_control).toBe(true);
    expect(out.pods[0]!.members[0]!.cwd).toBe("/work/proj/.workspaces/exec-cos");
    expect("remote_control" in out.pods[0]!.members[1]!).toBe(false);
    // ...and the projected spec is still a valid spec that normalizes the flag.
    const projected = parseYaml(r.rigSpecYaml);
    expect(RigSpecSchema.validate(projected).valid).toBe(true);
    expect(RigSpecSchema.normalize(projected).pods[0]!.members[0]!.remoteControl).toBe(true);
  });
});

describe("remote_control: persistence on the node (rig repository)", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  beforeEach(() => { db = createFullTestDb(); rigRepo = new RigRepository(db); });
  afterEach(() => { db.close(); });

  it("addNode persists a declared flag; nodes that never declared it carry no key at all", () => {
    const rig = rigRepo.createRig("r");
    const on = rigRepo.addNode(rig.id, "dev.on", { runtime: "claude-code", remoteControl: true });
    const off = rigRepo.addNode(rig.id, "dev.off", { runtime: "claude-code" });
    expect(db.prepare("SELECT logical_id, remote_control FROM nodes ORDER BY logical_id").all())
      .toEqual([{ logical_id: "dev.off", remote_control: null }, { logical_id: "dev.on", remote_control: 1 }]);
    const nodes = rigRepo.getRig(rig.id)!.nodes;
    expect(nodes.find((n) => n.id === on.id)!.remoteControl).toBe(true);
    // Snapshots serialize these Node objects: an undeclared seat must be byte-identical to before.
    expect("remoteControl" in nodes.find((n) => n.id === off.id)!).toBe(false);
  });

  it("setNodeRemoteControl declares and withdraws", () => {
    const rig = rigRepo.createRig("r");
    const node = rigRepo.addNode(rig.id, "dev.x", { runtime: "claude-code" });
    expect(rigRepo.setNodeRemoteControl(node.id, true)).toBe(true);
    expect(rigRepo.getRig(rig.id)!.nodes[0]!.remoteControl).toBe(true);
    expect(rigRepo.setNodeRemoteControl(node.id, false)).toBe(true);
    expect("remoteControl" in rigRepo.getRig(rig.id)!.nodes[0]!).toBe(false);
  });

  it("the pod-aware exporter writes the declaration back into the exported member (export -> import keeps it)", () => {
    const rig = rigRepo.createRig("r");
    const pod = new PodRepository(db).createPod(rig.id, "dev", "Dev", {});
    rigRepo.addNode(rig.id, "dev.cos", { runtime: "claude-code", podId: pod.id, agentRef: "local:agents/impl", profile: "default", cwd: "/w", remoteControl: true });
    rigRepo.addNode(rig.id, "dev.plain", { runtime: "claude-code", podId: pod.id, agentRef: "local:agents/impl", profile: "default", cwd: "/w" });
    const spec = new RigSpecExporter({ rigRepo, sessionRegistry: new SessionRegistry(db), podRepo: new PodRepository(db) }).exportRig(rig.id) as unknown as RigSpec;
    const members = spec.pods.flatMap((p) => p.members);
    expect(members.find((m) => m.id === "cos")!.remoteControl).toBe(true);
    expect(members.find((m) => m.id === "plain")!.remoteControl).toBeUndefined();
  });
});

describe("remote_control: plumbed across ALL node-creation paths and onto the launch binding", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;
  let launchHarness: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = createFullTestDb();
    launchHarness = vi.fn(async (_binding: NodeBinding) => ({ ok: true as const }));
    const adapter: RuntimeAdapter = {
      runtime: "claude-code",
      listInstalled: vi.fn(async () => []),
      project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
      checkReady: vi.fn(async () => ({ ready: true })),
      launchHarness: launchHarness as unknown as RuntimeAdapter["launchHarness"],
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
    const row = db.prepare("SELECT remote_control FROM nodes WHERE logical_id = ?").get(logicalId) as { remote_control: number | null } | undefined;
    expect(row, `node ${logicalId} should exist`).toBeDefined();
    return row!.remote_control;
  };
  // The binding handed to launchHarness for a node (looked up by its db id).
  const launchedWith = (logicalId: string): NodeBinding => {
    const nodeId = (db.prepare("SELECT id FROM nodes WHERE logical_id = ?").get(logicalId) as { id: string }).id;
    const call = launchHarness.mock.calls.map((c) => c[0] as NodeBinding).find((b) => b.nodeId === nodeId);
    expect(call, `launchHarness was called for ${logicalId}`).toBeDefined();
    return call!;
  };

  it("PATH 1 - initial pod materialize: spec -> nodes.remote_control (materialize creates nodes; launch is covered by PATHs 2-4)", async () => {
    const outcome = await setup.podInstantiator.materializeStructured(rawSpec([rawMember("cos", { remote_control: true }), rawMember("plain")]), RIG_ROOT);
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(column("dev.cos")).toBe(1);
    expect(column("dev.plain")).toBeNull();
  });

  it("PATH 2 - rig expand (structured fragment)", async () => {
    const rig = setup.rigRepo.createRig("rc-rig");
    const expanded = await setup.rigExpansionService.expand({
      rigId: rig.id, rigRoot: RIG_ROOT,
      pod: { id: "qa", label: "QA", members: [
        { id: "remote", runtime: "claude-code", agentRef: "local:agents/impl", profile: "default", cwd: ".", remoteControl: true },
        { id: "local", runtime: "claude-code", agentRef: "local:agents/impl", profile: "default", cwd: "." },
      ], edges: [] },
    });
    expect(expanded.ok, JSON.stringify(expanded)).toBe(true);
    expect(column("qa.remote")).toBe(1);
    expect(column("qa.local")).toBeNull();
    expect(launchedWith("qa.remote").remoteControl).toBe(true);
  });

  const expandViaRoute = (rigId: string, member: Record<string, unknown>) => setup.app.request(`/api/rigs/${rigId}/expand`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rigRoot: RIG_ROOT, pod: { id: "web", label: "Web", members: [member], edges: [] } }),
  });
  const routeMember = (over: Record<string, unknown>) => ({ id: "m", runtime: "claude-code", agent_ref: "local:agents/impl", profile: "default", cwd: ".", ...over });

  it("PATH 2b - the HTTP expand ingress (rigs.ts member remap) carries `remote_control: true` through, snake_case on the wire", async () => {
    const rig = setup.rigRepo.createRig("rc-rig");
    const res = await expandViaRoute(rig.id, routeMember({ remote_control: true }));
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    expect(column("web.m")).toBe(1);
    expect(launchedWith("web.m").remoteControl).toBe(true);
  });

  it("PATH 2b - the camelCase wire spelling `remoteControl: true` is accepted too (as permissionPolicy / codexConfigProfile are)", async () => {
    const rig = setup.rigRepo.createRig("rc-rig");
    const res = await expandViaRoute(rig.id, routeMember({ remoteControl: true }));
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    expect(column("web.m")).toBe(1);
  });

  it.each([["yes"], [1], [null]])("PATH 2b - a present-invalid wire value %j is a structured 400 from the canonical validator, with zero persistence", async (value) => {
    const rig = setup.rigRepo.createRig("rc-rig");
    const res = await expandViaRoute(rig.id, routeMember({ remote_control: value }));
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/remote_control: must be a boolean/);
    expect(db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE logical_id LIKE 'web.%'").get()).toMatchObject({ c: 0 });
    expect(launchHarness).not.toHaveBeenCalled();
  });

  it("PATH 2b - `true` on a non-claude member is a structured 400 with zero persistence", async () => {
    const rig = setup.rigRepo.createRig("rc-rig");
    const res = await expandViaRoute(rig.id, routeMember({ runtime: "codex", remote_control: true }));
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/only valid when runtime is \\?"claude-code\\?"/);
    expect(db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE logical_id LIKE 'web.%'").get()).toMatchObject({ c: 0 });
  });

  it("PATH 3 - add_member: a raw `remote_control: true` fragment lands on the node and the binding", async () => {
    const outcome = await setup.podInstantiator.materializeStructured(rawSpec([rawMember("seed")]), RIG_ROOT);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const added = await setup.podInstantiator.addMemberToPod(outcome.result.rigId, "dev", rawMember("added", { remote_control: true }), RIG_ROOT);
    expect(added.ok, JSON.stringify(added)).toBe(true);
    expect(column("dev.added")).toBe(1);
    expect(launchedWith("dev.added").remoteControl).toBe(true);
  });

  // A launch from the spec writes the member's CURRENT declaration, so editing the spec takes effect on
  // the next launch in BOTH directions (the same contract effort has). launchBinding is the public
  // primitive that brings an already-created node live from its member.
  it.each([
    ["withdrawn: node declared it, the member no longer does", true, false],
    ["added: node had not declared it, the member now does", false, true],
  ])("a relaunch from the spec re-syncs the persisted declaration (%s)", async (_label, before, after) => {
    const outcome = await setup.podInstantiator.materializeStructured(rawSpec([rawMember("cos", before ? { remote_control: true } : {})]), RIG_ROOT);
    expect(outcome.ok).toBe(true);
    expect(column("dev.cos")).toBe(before ? 1 : null);
    const rigId = (outcome as { ok: true; result: { rigId: string } }).result.rigId;
    const nodeId = (db.prepare("SELECT id FROM nodes WHERE logical_id = 'dev.cos'").get() as { id: string }).id;
    const edited = RigSpecSchema.normalize(rawSpec([rawMember("cos", after ? { remote_control: true } : {})]));
    const pod = edited.pods[0]!;
    const launched = await setup.podInstantiator.launchBinding({ rigId, rigSpec: edited, rigRoot: RIG_ROOT, pod, member: pod.members[0]!, qualifiedId: "dev.cos", nodeId });
    expect(launched.status, JSON.stringify(launched)).toBe("launched");
    expect(column("dev.cos")).toBe(after ? 1 : null);
    const binding = launchedWith("dev.cos");
    if (after) expect(binding.remoteControl).toBe(true);
    else expect("remoteControl" in binding).toBe(false);
  });

  it("PATH 4 - bootstrap instantiate-from-YAML (`rig up <spec>`): its OWN inline addNode persists it", async () => {
    const yaml = RigSpecCodec.serialize(RigSpecSchema.normalize(rawSpec([rawMember("cos", { remote_control: true }), rawMember("plain")])) as unknown as RigSpec);
    const outcome = await setup.podInstantiator.instantiate(yaml, RIG_ROOT);
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(column("dev.cos")).toBe(1);
    expect(column("dev.plain")).toBeNull();
    expect(launchedWith("dev.cos").remoteControl).toBe(true);
    expect("remoteControl" in launchedWith("dev.plain")).toBe(false);
  });
});
