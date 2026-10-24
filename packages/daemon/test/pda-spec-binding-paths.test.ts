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

  describe("review round 2 (architect probes P1-P3): the gaps in the daemon-wide rule", () => {
    const yamlOf = (members: Record<string, unknown>[], name: string) =>
      RigSpecCodec.serialize(RigSpecSchema.normalize(rawSpec(members, name)) as unknown as RigSpec);
    const holders = (agent = "research") => setup.rigRepo.findPdaBindingHolders({ agent, baseUrl: "http://127.0.0.1:8150" });
    const archivedCount = (): number => (db.prepare("SELECT COUNT(*) AS c FROM rigs WHERE archived_at IS NOT NULL").get() as { c: number }).c;

    // P1. `rig up` checks up front, then awaits (preflight, stop confirmation, the prelaunch hook, other launches)
    // before it creates each seat. A rig that takes the agent in that window used to leave two holders.
    it("P1 - rig up: a rig that takes the agent AFTER the up-front check is refused at seat creation, leaving one holder", async () => {
      let inner: Awaited<ReturnType<typeof setup.podInstantiator.materializeStructured>> | undefined;
      const outcome = await setup.podInstantiator.instantiate(yamlOf([rawMember("research")], "rig-one"), RIG_ROOT, {
        prelaunchHook: async () => {
          inner = await setup.podInstantiator.materializeStructured(rawSpec([rawMember("copy")], "rig-two"), RIG_ROOT);
          return { ok: true };
        },
      });
      expect(inner?.ok, "the interleaved rig takes the agent first").toBe(true);
      expect(outcome.ok).toBe(false);
      expect(JSON.stringify(outcome)).toContain('already driven by seat \\"dev.copy\\" in rig \\"rig-two\\"');
      expect(holders().map((h) => h.rigName)).toEqual(["rig-two"]);
    });

    it("P1-control - without the interleave the same rig up succeeds and holds the agent", async () => {
      const outcome = await setup.podInstantiator.instantiate(yamlOf([rawMember("research")], "rig-one"), RIG_ROOT, { prelaunchHook: async () => ({ ok: true }) });
      expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
      expect(holders().map((h) => h.rigName)).toEqual(["rig-one"]);
    });

    it("P1 - only the contested seat fails: a sibling seat on a free agent is still created (partial success is the existing contract)", async () => {
      const spec2 = yamlOf([rawMember("a", { pda: { agent: "taken-late" } }), rawMember("b", { pda: { agent: "free" } })], "rig-three");
      let first = true;
      const outcome = await setup.podInstantiator.instantiate(spec2, RIG_ROOT, {
        prelaunchHook: async () => {
          if (first) { first = false; await setup.podInstantiator.materializeStructured(rawSpec([rawMember("x", { pda: { agent: "taken-late" } })], "rig-four"), RIG_ROOT); }
          return { ok: true };
        },
      });
      expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
      const names = (db.prepare("SELECT n.logical_id AS l, r.name AS r FROM nodes n JOIN rigs r ON r.id = n.rig_id WHERE r.name = 'rig-three'").all() as Array<{ l: string }>).map((x) => x.l);
      expect(names).toEqual(["dev.b"]);
    });

    // P2. Bringing an archived rig back used to create the second holder with a 200.
    const archivedRigHoldingResearch = async (name: string) => {
      const first = await setup.podInstantiator.materializeStructured(rawSpec([rawMember("research")], name), RIG_ROOT);
      const id = (first as { ok: true; result: { rigId: string } }).result.rigId;
      expect(setup.rigRepo.archiveRig(id)).toBe(true);
      return id;
    };

    it("P2 - POST /api/rigs/:id/unarchive is refused with 409 naming the holder, and the rig stays archived", async () => {
      const aId = await archivedRigHoldingResearch("rig-a");
      expect((await setup.podInstantiator.materializeStructured(rawSpec([rawMember("copy")], "rig-b"), RIG_ROOT)).ok).toBe(true);
      const eventsBefore = (db.prepare("SELECT COUNT(*) AS c FROM events WHERE type = 'rig.unarchived'").get() as { c: number }).c;
      const res = await setup.app.request(`/api/rigs/${aId}/unarchive`, { method: "POST" });
      const body = await res.json() as { error: string; conflicts: Array<Record<string, unknown>> };
      expect(res.status).toBe(409);
      expect(body.error).toContain('Cannot unarchive rig "rig-a"');
      expect(body.error).toContain('pda agent "research" at http://127.0.0.1:8150 is already driven by seat "dev.copy" in rig "rig-b"');
      expect(body.conflicts).toEqual([{ seat: "dev.research", agent: "research", baseUrl: "http://127.0.0.1:8150", heldBySeat: "dev.copy", heldByRig: "rig-b" }]);
      expect(holders()).toHaveLength(1);
      expect(archivedCount()).toBe(1);
      expect((db.prepare("SELECT COUNT(*) AS c FROM events WHERE type = 'rig.unarchived'").get() as { c: number }).c).toBe(eventsBefore);
    });

    it("P2-control - unarchive succeeds when the agent is free, and then holds it", async () => {
      const aId = await archivedRigHoldingResearch("rig-a");
      const res = await setup.app.request(`/api/rigs/${aId}/unarchive`, { method: "POST" });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, unarchived: true });
      expect(holders().map((h) => h.rigName)).toEqual(["rig-a"]);
    });

    it("P2 - a rig with no pda seat unarchives as before, even while pda agents are held elsewhere", async () => {
      const plain = await setup.podInstantiator.materializeStructured(rawSpec([rawMember("p", { runtime: "terminal", agent_ref: "builtin:terminal", profile: "none", pda: undefined })], "rig-plain"), RIG_ROOT);
      const plainId = (plain as { ok: true; result: { rigId: string } }).result.rigId;
      setup.rigRepo.archiveRig(plainId);
      await setup.podInstantiator.materializeStructured(rawSpec([rawMember("research")], "rig-holder"), RIG_ROOT);
      const res = await setup.app.request(`/api/rigs/${plainId}/unarchive`, { method: "POST" });
      expect(res.status).toBe(200);
    });

    // The rollback of a failed same-name replacement unarchives the prior generation after deleting the new rig.
    it("P2 - the rollback of a failed rig up replacement does not unarchive a generation whose agent another rig took meanwhile", async () => {
      const yaml = yamlOf([rawMember("research")], "pda-rig");
      expect((await setup.podInstantiator.instantiate(yaml, RIG_ROOT)).ok).toBe(true);
      db.prepare("UPDATE sessions SET status = 'exited'").run(); // stopped, so the replacement may archive it
      const outcome = await setup.podInstantiator.instantiate(yaml, RIG_ROOT, {
        prelaunchHook: async () => {
          const taken = await setup.podInstantiator.materializeStructured(rawSpec([rawMember("copy")], "rig-two"), RIG_ROOT);
          expect(taken.ok, "the prior generation was archived by the replacement, so rig-two may take the agent").toBe(true);
          return { ok: false, code: "service_boot_failed", message: "boom" };
        },
      });
      expect(outcome).toMatchObject({ ok: false, code: "service_boot_failed" });
      expect((outcome as { message: string }).message).toContain("boom The earlier generation ");
      expect((outcome as { message: string }).message).toContain('was left archived: pda agent "research" at http://127.0.0.1:8150 is already driven by seat "dev.copy" in rig "rig-two"');
      expect(holders().map((h) => h.rigName)).toEqual(["rig-two"]);
      expect(archivedCount()).toBe(1);
    });

    it("P2-control - the same failed replacement WITHOUT a rival restores the prior generation, and the message is unchanged", async () => {
      const yaml = yamlOf([rawMember("research")], "pda-rig");
      expect((await setup.podInstantiator.instantiate(yaml, RIG_ROOT)).ok).toBe(true);
      db.prepare("UPDATE sessions SET status = 'exited'").run();
      const outcome = await setup.podInstantiator.instantiate(yaml, RIG_ROOT, { prelaunchHook: async () => ({ ok: false, code: "service_boot_failed", message: "boom" }) });
      expect(outcome).toMatchObject({ ok: false, message: "boom" });
      expect(archivedCount()).toBe(0);
      expect(holders().map((h) => h.rigName)).toEqual(["pda-rig"]);
    });

    // P3. A damaged binding used to be invisible to the check.
    const damageEveryBinding = () => db.prepare("UPDATE nodes SET pda_binding = ? WHERE pda_binding IS NOT NULL").run('{"agent":"research","base_url":"http://127.0.0.1:8150","x":1}');

    it("P3 - a live rig's damaged binding refuses a new seat on ANY agent, in materialize and in rig up, naming the damaged seat", async () => {
      expect((await setup.podInstantiator.materializeStructured(rawSpec([rawMember("research")], "rig-a"), RIG_ROOT)).ok).toBe(true);
      damageEveryBinding();
      const viaMaterialize = await setup.podInstantiator.materializeStructured(rawSpec([rawMember("copy", { pda: { agent: "unrelated" } })], "rig-b"), RIG_ROOT);
      expect(viaMaterialize).toMatchObject({ ok: false, code: "materialize_conflict" });
      expect(JSON.stringify(viaMaterialize)).toContain('seat \\"dev.research\\" in rig \\"rig-a\\" has an unreadable pda binding');
      const viaUp = await setup.podInstantiator.instantiate(yamlOf([rawMember("copy", { pda: { agent: "unrelated" } })], "rig-c"), RIG_ROOT);
      expect(viaUp).toMatchObject({ ok: false, code: "validation_failed" });
      expect(JSON.stringify(viaUp)).toContain("has an unreadable pda binding");
    });

    it("P3 - unarchive is refused while another live rig's binding is damaged; archiving that rig frees it", async () => {
      const aId = await archivedRigHoldingResearch("rig-a");
      expect((await setup.podInstantiator.materializeStructured(rawSpec([rawMember("copy", { pda: { agent: "other" } })], "rig-b"), RIG_ROOT)).ok).toBe(true);
      db.prepare("UPDATE nodes SET pda_binding = '{bad' WHERE logical_id = 'dev.copy'").run();
      const refused = await setup.app.request(`/api/rigs/${aId}/unarchive`, { method: "POST" });
      expect(refused.status).toBe(409);
      expect(JSON.stringify(await refused.json())).toContain("has an unreadable pda binding (pda_binding is not JSON)");
      const bId = (db.prepare("SELECT id FROM rigs WHERE name = 'rig-b'").get() as { id: string }).id;
      setup.rigRepo.archiveRig(bId);
      expect((await setup.app.request(`/api/rigs/${aId}/unarchive`, { method: "POST" })).status).toBe(200);
    });

    // Review nit N1: a falsy raw `pda` must reach the canonical validator through the expansion service; truthiness
    // would erase `null` into absence and let a non-pda member through with its declaration silently dropped.
    it.each([["pda", "must be a mapping"], ["codex", 'pda: only valid when runtime is \\"pda\\"']])("N1 - expand with a null pda block on a %s member is refused by the validator, not dropped", async (runtime, expected) => {
      const rig = setup.rigRepo.createRig("pda-rig");
      const expanded = await setup.rigExpansionService.expand({
        rigId: rig.id, rigRoot: RIG_ROOT,
        pod: { id: "qa", label: "QA", members: [{ id: "m", runtime, agentRef: "local:agents/pda-seat", profile: "default", cwd: ".", pda: null }], edges: [] },
      });
      expect(expanded).toMatchObject({ ok: false, code: "validation_failed" });
      expect(JSON.stringify(expanded)).toContain(expected);
      expect(nodeCount()).toBe(0);
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
