// pda L2b: the binding must survive EVERY node-creation path and reach the launch binding, and one pda agent may be
// driven by only one seat across the daemon (pda-runtime-design-9l, "The seat spec"). Same shape as
// remote-control-plumb.test.ts.
//
// Preflight is STUBBED here: the real one refuses `runtime: pda` as unsupported until L2a registers it, and the
// paths below must be pinned before that. The stub changes nothing else (validate, normalize, persistence and the
// launch core are the real code). So this file proves persistence and refusal, not that a pda seat can launch.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp, mockTmuxAdapter } from "./helpers/test-app.js";
import { RigSpecSchema } from "../src/domain/rigspec-schema.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import type { RuntimeAdapter, NodeBinding } from "../src/domain/runtime-adapter.js";
import type { RigSpec } from "../src/domain/types.js";
import { existingRigRoot } from "./helpers/existing-rig-root.js";

vi.mock("../src/domain/rigspec-preflight.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/domain/rigspec-preflight.js")>()),
  rigPreflight: async () => ({ ready: true, errors: [], warnings: [] }),
  preflightValidatedSpec: async () => ({ ready: true, errors: [], warnings: [] }),
}));

const RIG_ROOT = existingRigRoot("pda-rig");
const agentYaml = (name: string) => `name: ${name}\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []`;

const rawMember = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id, agent_ref: "local:agents/pda-seat", profile: "default", runtime: "pda", cwd: ".", pda: { agent: "research" }, ...over,
});
const rawSpec = (members: Record<string, unknown>[], name = "pda-rig"): Record<string, unknown> => ({
  version: "0.2", name, pods: [{ id: "dev", label: "Dev", members, edges: [] }], edges: [],
});
const BOUND = '{"agent":"research","base_url":"http://127.0.0.1:8150"}';

describe("pda binding: persisted on every node-creation path, carried onto the launch binding, unique per daemon", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;
  let launchHarness: ReturnType<typeof vi.fn>;
  let tmux: ReturnType<typeof mockTmuxAdapter>;

  beforeEach(() => {
    db = createFullTestDb();
    launchHarness = vi.fn(async (_binding: NodeBinding) => ({ ok: true as const }));
    const adapter: RuntimeAdapter = {
      runtime: "pda",
      listInstalled: vi.fn(async () => []),
      project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
      checkReady: vi.fn(async () => ({ ready: true })),
      launchHarness: launchHarness as unknown as RuntimeAdapter["launchHarness"],
    };
    tmux = mockTmuxAdapter();
    // Lets `rig up` replace a same-name rig: its prior generation is confirmed stopped, then archived.
    (tmux as unknown as { probeSession: unknown }).probeSession = vi.fn(async () => ({ state: "absent" as const }));
    setup = createTestApp(db, {
      tmux,
      adapters: { pda: adapter },
      podInstantiatorFsOps: {
        readFile: (p: string) => { if (p.includes("agents/pda-seat")) return agentYaml("pda-seat"); throw new Error(`Not found: ${p}`); },
        exists: (p: string) => p.includes("agents/pda-seat"),
      },
    });
  });
  afterEach(() => { db.close(); });

  const column = (logicalId: string): string | null => {
    const row = db.prepare("SELECT pda_binding FROM nodes WHERE logical_id = ?").get(logicalId) as { pda_binding: string | null } | undefined;
    expect(row, `node ${logicalId} should exist`).toBeDefined();
    return row!.pda_binding;
  };
  const rigCount = (): number => (db.prepare("SELECT COUNT(*) AS c FROM rigs").get() as { c: number }).c;
  const nodeCount = (): number => (db.prepare("SELECT COUNT(*) AS c FROM nodes").get() as { c: number }).c;
  const launchedWith = (logicalId: string): NodeBinding => {
    const nodeId = (db.prepare("SELECT id FROM nodes WHERE logical_id = ?").get(logicalId) as { id: string }).id;
    const call = launchHarness.mock.calls.map((c) => c[0] as NodeBinding).find((b) => b.nodeId === nodeId);
    expect(call, `launchHarness was called for ${logicalId}`).toBeDefined();
    return call!;
  };

  it("PATH 1 - materialize: spec -> nodes.pda_binding, with the default address filled in", async () => {
    const outcome = await setup.podInstantiator.materializeStructured(rawSpec([rawMember("research"), rawMember("plain", { runtime: "pda", pda: { agent: "other", base_url: "http://127.0.0.1:9001" } })]), RIG_ROOT);
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(column("dev.research")).toBe(BOUND);
    expect(column("dev.plain")).toBe('{"agent":"other","base_url":"http://127.0.0.1:9001"}');
  });

  it("PATH 1 - the reading side: the stored binding comes back on the node", async () => {
    const outcome = await setup.podInstantiator.materializeStructured(rawSpec([rawMember("research")]), RIG_ROOT);
    expect(outcome.ok).toBe(true);
    const rigId = (outcome as { ok: true; result: { rigId: string } }).result.rigId;
    expect(setup.rigRepo.getRig(rigId)!.nodes[0]!.pda).toEqual({ agent: "research", baseUrl: "http://127.0.0.1:8150" });
  });

  describe("one pda agent, one seat, across the daemon", () => {
    it("a second rig that names an agent another rig drives is refused, naming the holder, and creates nothing", async () => {
      expect((await setup.podInstantiator.materializeStructured(rawSpec([rawMember("research")], "rig-one"), RIG_ROOT)).ok).toBe(true);
      const rigsBefore = rigCount();
      const nodesBefore = nodeCount();
      const second = await setup.podInstantiator.materializeStructured(rawSpec([rawMember("copy")], "rig-two"), RIG_ROOT);
      expect(second).toMatchObject({ ok: false, code: "materialize_conflict" });
      expect(JSON.stringify(second)).toContain('pda agent \\"research\\" at http://127.0.0.1:8150 is already driven by seat \\"dev.research\\" in rig \\"rig-one\\"');
      expect(rigCount()).toBe(rigsBefore);
      expect(nodeCount()).toBe(nodesBefore);
    });

    it("the same name on another port, and another name on the same port, are free", async () => {
      expect((await setup.podInstantiator.materializeStructured(rawSpec([rawMember("research")], "rig-one"), RIG_ROOT)).ok).toBe(true);
      expect((await setup.podInstantiator.materializeStructured(rawSpec([rawMember("copy", { pda: { agent: "research", base_url: "http://127.0.0.1:8151" } })], "rig-two"), RIG_ROOT)).ok).toBe(true);
      expect((await setup.podInstantiator.materializeStructured(rawSpec([rawMember("copy", { pda: { agent: "other" } })], "rig-three"), RIG_ROOT)).ok).toBe(true);
    });

    it("an archived rig holds nothing, so its agent can be driven again", async () => {
      const first = await setup.podInstantiator.materializeStructured(rawSpec([rawMember("research")], "rig-one"), RIG_ROOT);
      const rigId = (first as { ok: true; result: { rigId: string } }).result.rigId;
      expect(setup.rigRepo.archiveRig(rigId)).toBe(true);
      expect((await setup.podInstantiator.materializeStructured(rawSpec([rawMember("copy")], "rig-two"), RIG_ROOT)).ok).toBe(true);
    });

    it("the creating door itself refuses a second seat in one spec that validation was never asked about", async () => {
      // materializeValidatedSpec takes a normalized spec and does not validate, so only createMemberNode's own check
      // can stop the second member; the first member's row is already visible to it inside the transaction.
      const normalized = RigSpecSchema.normalize(rawSpec([rawMember("a"), rawMember("b")]));
      const outcome = await setup.podInstantiator.materializeValidatedSpec(normalized, RIG_ROOT, []);
      expect(outcome).toMatchObject({ ok: false, code: "materialize_conflict" });
      expect(JSON.stringify(outcome)).toContain('dev.b: pda agent');
      expect(rigCount()).toBe(0);
      expect(nodeCount()).toBe(0);
    });

    it("PATH 2 - rig expand into a rig whose seat already drives the agent: refused with nothing added", async () => {
      const first = await setup.podInstantiator.materializeStructured(rawSpec([rawMember("research")], "rig-one"), RIG_ROOT);
      const rigId = (first as { ok: true; result: { rigId: string } }).result.rigId;
      const before = nodeCount();
      const expanded = await setup.rigExpansionService.expand({
        rigId, rigRoot: RIG_ROOT,
        pod: { id: "qa", label: "QA", members: [{ id: "dup", runtime: "pda", agentRef: "local:agents/pda-seat", profile: "default", cwd: ".", pda: { agent: "research" } }], edges: [] },
      });
      expect(expanded).toMatchObject({ ok: false, code: "materialize_conflict" });
      expect(nodeCount()).toBe(before);
    });

    it("PATH 3 - add_member of a seat that names a driven agent is a member_conflict; a free agent is added", async () => {
      const first = await setup.podInstantiator.materializeStructured(rawSpec([rawMember("research")], "rig-one"), RIG_ROOT);
      const rigId = (first as { ok: true; result: { rigId: string } }).result.rigId;
      const dup = await setup.podInstantiator.addMemberToPod(rigId, "dev", rawMember("dup"), RIG_ROOT);
      expect(dup).toMatchObject({ ok: false, code: "member_conflict" });
      expect(nodeCount()).toBe(1);
      const free = await setup.podInstantiator.addMemberToPod(rigId, "dev", rawMember("free", { pda: { agent: "free-one" } }), RIG_ROOT);
      expect(free.ok, JSON.stringify(free)).toBe(true);
      expect(column("dev.free")).toBe('{"agent":"free-one","base_url":"http://127.0.0.1:8150"}');
      expect(launchedWith("dev.free").pda).toEqual({ agent: "free-one", baseUrl: "http://127.0.0.1:8150" });
    });

    it("PATH 4 - rig up <spec>: a name another rig drives is refused before anything is created", async () => {
      const first = await setup.podInstantiator.instantiate(RigSpecCodec.serialize(RigSpecSchema.normalize(rawSpec([rawMember("research")], "rig-one")) as unknown as RigSpec), RIG_ROOT);
      expect(first.ok, JSON.stringify(first)).toBe(true);
      const rigsBefore = rigCount();
      const second = await setup.podInstantiator.instantiate(RigSpecCodec.serialize(RigSpecSchema.normalize(rawSpec([rawMember("copy")], "rig-two")) as unknown as RigSpec), RIG_ROOT);
      expect(second).toMatchObject({ ok: false, code: "validation_failed" });
      expect(JSON.stringify(second)).toContain('dev.copy: pda agent');
      expect(JSON.stringify(second)).toContain('in rig \\"rig-one\\"');
      expect(rigCount()).toBe(rigsBefore);
    });

    it("PATH 4 - rig up <spec> again under the SAME rig name replaces the stopped generation, which does not count as a holder", async () => {
      const yaml = RigSpecCodec.serialize(RigSpecSchema.normalize(rawSpec([rawMember("research")])) as unknown as RigSpec);
      expect((await setup.podInstantiator.instantiate(yaml, RIG_ROOT)).ok).toBe(true);
      // The first generation is stopped (the running-name guard refuses to replace a running one).
      db.prepare("UPDATE sessions SET status = 'exited'").run();
      const again = await setup.podInstantiator.instantiate(yaml, RIG_ROOT);
      expect(db.prepare("SELECT COUNT(*) AS c FROM rigs WHERE archived_at IS NOT NULL").get()).toMatchObject({ c: 1 }); // the old generation was archived, not left as a holder
      expect(again.ok, JSON.stringify(again)).toBe(true);
    });
  });

  it("PATH 2 - rig expand (structured fragment): persisted and carried onto the binding", async () => {
    const rig = setup.rigRepo.createRig("pda-rig");
    const expanded = await setup.rigExpansionService.expand({
      rigId: rig.id, rigRoot: RIG_ROOT,
      pod: { id: "qa", label: "QA", members: [{ id: "research", runtime: "pda", agentRef: "local:agents/pda-seat", profile: "default", cwd: ".", pda: { agent: "research", base_url: "http://127.0.0.1:9001" } }], edges: [] },
    });
    expect(expanded.ok, JSON.stringify(expanded)).toBe(true);
    expect(column("qa.research")).toBe('{"agent":"research","base_url":"http://127.0.0.1:9001"}');
    expect(launchedWith("qa.research").pda).toEqual({ agent: "research", baseUrl: "http://127.0.0.1:9001" });
  });

  const expandViaRoute = (rigId: string, member: Record<string, unknown>) => setup.app.request(`/api/rigs/${rigId}/expand`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rigRoot: RIG_ROOT, pod: { id: "web", label: "Web", members: [member], edges: [] } }),
  });
  const routeMember = (over: Record<string, unknown>) => ({ id: "m", runtime: "pda", agent_ref: "local:agents/pda-seat", profile: "default", cwd: ".", pda: { agent: "research" }, ...over });

  it("PATH 2b - the HTTP expand ingress carries the block through", async () => {
    const rig = setup.rigRepo.createRig("pda-rig");
    const res = await expandViaRoute(rig.id, routeMember({}));
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    expect(column("web.m")).toBe(BOUND);
    expect(launchedWith("web.m").pda).toEqual({ agent: "research", baseUrl: "http://127.0.0.1:8150" });
  });

  it("PATH 2b - a block on a non-pda member is a structured 400, never silently dropped, with zero persistence", async () => {
    const rig = setup.rigRepo.createRig("pda-rig");
    const res = await expandViaRoute(rig.id, routeMember({ runtime: "codex" }));
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/pda: only valid when runtime is \\?"pda\\?"/);
    expect(nodeCount()).toBe(0);
  });

  it.each([[null], ["research"], [{ agent: "main" }], [{ agent: "research", base_url: "http://localhost:8150" }]])("PATH 2b - the present-invalid wire value %j is a structured 400 from the canonical validator", async (value) => {
    const rig = setup.rigRepo.createRig("pda-rig");
    const res = await expandViaRoute(rig.id, routeMember({ pda: value }));
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/members\[0\]\.pda/);
    expect(nodeCount()).toBe(0);
  });

  it("PATH 2b - a pda member with no block is a structured 400", async () => {
    const rig = setup.rigRepo.createRig("pda-rig");
    const { pda: _omit, ...withoutBlock } = routeMember({});
    const res = await expandViaRoute(rig.id, withoutBlock);
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/pda: required when runtime is \\?"pda\\?"/);
  });

  it("PATH 4 - bootstrap instantiate (`rig up <spec>`): its OWN inline addNode persists the binding, and the launch binding carries it", async () => {
    const yaml = RigSpecCodec.serialize(RigSpecSchema.normalize(rawSpec([rawMember("research"), rawMember("plain", { runtime: "pda", pda: { agent: "other" } })])) as unknown as RigSpec);
    const outcome = await setup.podInstantiator.instantiate(yaml, RIG_ROOT);
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(column("dev.research")).toBe(BOUND);
    expect(launchedWith("dev.research").pda).toEqual({ agent: "research", baseUrl: "http://127.0.0.1:8150" });
    expect(launchedWith("dev.plain").pda).toEqual({ agent: "other", baseUrl: "http://127.0.0.1:8150" });
  });

  it("a seat that is not a pda seat carries no pda key on its launch binding", async () => {
    const adapter: RuntimeAdapter = {
      runtime: "codex",
      listInstalled: vi.fn(async () => []),
      project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
      checkReady: vi.fn(async () => ({ ready: true })),
      launchHarness: launchHarness as unknown as RuntimeAdapter["launchHarness"],
    };
    const local = createTestApp(db, {
      tmux, adapters: { codex: adapter },
      podInstantiatorFsOps: { readFile: () => agentYaml("pda-seat"), exists: (p: string) => p.includes("agents/pda-seat") },
    });
    const outcome = await local.podInstantiator.instantiate(RigSpecCodec.serialize(RigSpecSchema.normalize(rawSpec([rawMember("plain", { runtime: "codex", pda: undefined })], "plain-rig")) as unknown as RigSpec), RIG_ROOT);
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(launchedWith("dev.plain")).not.toHaveProperty("pda");
    expect(column("dev.plain")).toBeNull();
  });
});
