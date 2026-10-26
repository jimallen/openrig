// OF-95: the creating doors (rig up, materialize, add member, expand) and the unarchive door must see a pda agent
// that another seat holds ONLY through its resume token, exactly as the launch check (OF-92) does.
//
// Production consequence these rows pin: a rig naming an agent held only by another seat's token used to be created
// (200, nodes and sessions written, launch attempted) and only then refused at launch; an archived rig holding such a
// name used to come back with a 200 and refuse at its first restore. The refusal belongs at the door, before anything
// is created.
//
// Census of the production call sites of the holder check at 18f46db6 (instrument: graph search + rg for
// findPdaBindingHolders, findPdaBindingConflictsForRig, pdaBindingConflict), classified, one row per door:
//   D1 materialize (createMemberNode)                       rigspec-instantiator pdaBindingConflict  -> "D1 materialize"
//   D2 rig up validation (instantiate)                      pdaBindingConflict                       -> "D2 rig up"
//   D3 add_member / expand (createMemberNode)               pdaBindingConflict                       -> "D3 add member", "D3 expand"
//   D4 rig up same-name replacement (excludeRigIds)         pdaBindingConflict                       -> "D4"
//   D5 unarchive route + rollback of a replacement          unarchiveRigUnlessPdaConflict            -> "D5 ..."
// Preflight is stubbed exactly as in pda-spec-binding-paths.test.ts (persistence and refusal paths, not a launch).
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
const PORT = "http://127.0.0.1:8150";
const rawMember = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id, agent_ref: "local:agents/pda-seat", profile: "default", runtime: "pda", cwd: ".", pda: { agent: "research" }, ...over,
});
const rawSpec = (members: Record<string, unknown>[], name: string): Record<string, unknown> => ({
  version: "0.2", name, pods: [{ id: "dev", label: "Dev", members, edges: [] }], edges: [],
});
const yamlOf = (members: Record<string, unknown>[], name: string) =>
  RigSpecCodec.serialize(RigSpecSchema.normalize(rawSpec(members, name)) as unknown as RigSpec);

describe("OF-95: a pda agent held only by another seat's resume token is refused at the door", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    db = createFullTestDb();
    const adapter: RuntimeAdapter = {
      runtime: "pda",
      listInstalled: vi.fn(async () => []),
      project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
      checkReady: vi.fn(async () => ({ ready: true })),
      launchHarness: vi.fn(async (_b: NodeBinding) => ({ ok: true as const })) as unknown as RuntimeAdapter["launchHarness"],
    };
    const tmux = mockTmuxAdapter();
    (tmux as unknown as { probeSession: unknown }).probeSession = vi.fn(async () => ({ state: "absent" as const }));
    setup = createTestApp(db, {
      tmux, adapters: { pda: adapter },
      podInstantiatorFsOps: {
        readFile: (p: string) => { if (p.includes("agents/pda-seat")) return agentYaml("pda-seat"); throw new Error(`Not found: ${p}`); },
        exists: (p: string) => p.includes("agents/pda-seat"),
      },
    });
  });
  afterEach(() => { db.close(); });

  const rigCount = (): number => (db.prepare("SELECT COUNT(*) AS c FROM rigs").get() as { c: number }).c;
  const nodeCount = (): number => (db.prepare("SELECT COUNT(*) AS c FROM nodes").get() as { c: number }).c;
  const archivedCount = (): number => (db.prepare("SELECT COUNT(*) AS c FROM rigs WHERE archived_at IS NOT NULL").get() as { c: number }).c;

  /** A rig whose seat is SAVED on `parked` but whose resume token names `research`: the token is its only claim. */
  async function tokenOnlyHolder(rigName: string, tokenAgent = "research") {
    const made = await setup.podInstantiator.materializeStructured(rawSpec([rawMember("holder", { pda: { agent: "parked" } })], rigName), RIG_ROOT);
    expect(made.ok, JSON.stringify(made)).toBe(true);
    const rigId = (made as { ok: true; result: { rigId: string } }).result.rigId;
    const nodeId = (db.prepare("SELECT id FROM nodes WHERE rig_id = ?").get(rigId) as { id: string }).id;
    const session = setup.sessionRegistry.registerSession(nodeId, `holder@${rigName}`);
    setup.sessionRegistry.updateResumeToken(session.id, "pda_agent", `${PORT}/agents/${tokenAgent}`, "operator");
    return { rigId, nodeId };
  }
  const HOLDER_TEXT = (rig: string) => `pda agent \\"research\\" at ${PORT} is already driven by seat \\"dev.holder\\" in rig \\"${rig}\\" (that seat's resume token names it)`;

  it("control: the holder is token-only (its saved binding names another agent), so the binding check alone does not see it", async () => {
    const { rigId } = await tokenOnlyHolder("rig-one");
    expect(setup.rigRepo.getRig(rigId)!.nodes[0]!.pda).toEqual({ agent: "parked", baseUrl: PORT });
    expect(setup.rigRepo.findPdaBindingHolders({ agent: "research", baseUrl: PORT })).toEqual([]);
    expect(setup.rigRepo.findPdaResumeTokenHolders({ agent: "research", baseUrl: PORT })).toHaveLength(1);
  });

  it("D1 materialize: refused as materialize_conflict, naming the holder, creating nothing", async () => {
    await tokenOnlyHolder("rig-one");
    const rigs = rigCount(); const nodes = nodeCount();
    const out = await setup.podInstantiator.materializeStructured(rawSpec([rawMember("copy")], "rig-two"), RIG_ROOT);
    expect(out).toMatchObject({ ok: false, code: "materialize_conflict" });
    expect(JSON.stringify(out)).toContain(HOLDER_TEXT("rig-one"));
    expect(rigCount()).toBe(rigs); expect(nodeCount()).toBe(nodes);
  });

  it("D2 rig up <spec>: refused at validation, naming the holder, before anything is created", async () => {
    await tokenOnlyHolder("rig-one");
    const rigs = rigCount();
    const out = await setup.podInstantiator.instantiate(yamlOf([rawMember("copy")], "rig-two"), RIG_ROOT);
    expect(out).toMatchObject({ ok: false, code: "validation_failed" });
    expect(JSON.stringify(out)).toContain("dev.copy: pda agent");
    expect(JSON.stringify(out)).toContain("that seat's resume token names it");
    expect(rigCount()).toBe(rigs);
  });

  it("D3 add member: member_conflict, nothing added; a free agent is still added", async () => {
    await tokenOnlyHolder("rig-one");
    const other = await setup.podInstantiator.materializeStructured(rawSpec([rawMember("seed", { pda: { agent: "seed-agent" } })], "rig-two"), RIG_ROOT);
    const rigId = (other as { ok: true; result: { rigId: string } }).result.rigId;
    const before = nodeCount();
    const dup = await setup.podInstantiator.addMemberToPod(rigId, "dev", rawMember("dup"), RIG_ROOT);
    expect(dup).toMatchObject({ ok: false, code: "member_conflict" });
    expect(nodeCount()).toBe(before);
    expect((await setup.podInstantiator.addMemberToPod(rigId, "dev", rawMember("free", { pda: { agent: "free-one" } }), RIG_ROOT)).ok).toBe(true);
  });

  it("D3 expand: materialize_conflict, nothing added", async () => {
    await tokenOnlyHolder("rig-one");
    const rig = setup.rigRepo.createRig("rig-two");
    const out = await setup.rigExpansionService.expand({
      rigId: rig.id, rigRoot: RIG_ROOT,
      pod: { id: "qa", label: "QA", members: [{ id: "dup", runtime: "pda", agentRef: "local:agents/pda-seat", profile: "default", cwd: ".", pda: { agent: "research" } }], edges: [] },
    });
    expect(out).toMatchObject({ ok: false, code: "materialize_conflict" });
    expect(setup.rigRepo.getRig(rig.id)!.nodes).toHaveLength(0);
  });

  it("D4 rig up under the SAME name: the replaced generation's own token holds nothing against its replacement", async () => {
    const yaml = yamlOf([rawMember("research")], "pda-rig");
    expect((await setup.podInstantiator.instantiate(yaml, RIG_ROOT)).ok).toBe(true);
    const nodeId = (db.prepare("SELECT id FROM nodes").get() as { id: string }).id;
    const session = setup.sessionRegistry.registerSession(nodeId, "dev-research@pda-rig");
    setup.sessionRegistry.updateResumeToken(session.id, "pda_agent", `${PORT}/agents/research`, "scrape");
    db.prepare("UPDATE sessions SET status = 'exited'").run();
    const again = await setup.podInstantiator.instantiate(yaml, RIG_ROOT);
    expect(again.ok, JSON.stringify(again)).toBe(true);
    expect(archivedCount()).toBe(1);
  });

  it("D5 unarchive: 409 naming the token holder, the rig stays archived, no event", async () => {
    const first = await setup.podInstantiator.materializeStructured(rawSpec([rawMember("research")], "rig-a"), RIG_ROOT);
    const aId = (first as { ok: true; result: { rigId: string } }).result.rigId;
    expect(setup.rigRepo.archiveRig(aId)).toBe(true);
    await tokenOnlyHolder("rig-b");
    const res = await setup.app.request(`/api/rigs/${aId}/unarchive`, { method: "POST" });
    const body = await res.json() as { error: string; conflicts: Array<Record<string, unknown>> };
    expect(res.status).toBe(409);
    expect(body.error).toContain('Cannot unarchive rig "rig-a"');
    expect(body.error).toContain(`pda agent "research" at ${PORT} is already driven by seat "dev.holder" in rig "rig-b" (that seat's resume token names it)`);
    expect(body.conflicts).toEqual([{ seat: "dev.research", agent: "research", baseUrl: PORT, heldBySeat: "dev.holder", heldByRig: "rig-b" }]);
    expect(archivedCount()).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS c FROM events WHERE type = 'rig.unarchived'").get() as { c: number }).c).toBe(0);
  });

  it("D5 unarchive control: the rig's OWN seat token names the agent and nothing else does, so it comes back", async () => {
    const first = await setup.podInstantiator.materializeStructured(rawSpec([rawMember("research")], "rig-a"), RIG_ROOT);
    const aId = (first as { ok: true; result: { rigId: string } }).result.rigId;
    const nodeId = (db.prepare("SELECT id FROM nodes WHERE rig_id = ?").get(aId) as { id: string }).id;
    const session = setup.sessionRegistry.registerSession(nodeId, "dev-research@rig-a");
    setup.sessionRegistry.updateResumeToken(session.id, "pda_agent", `${PORT}/agents/research`, "scrape");
    setup.rigRepo.archiveRig(aId);
    expect((await setup.app.request(`/api/rigs/${aId}/unarchive`, { method: "POST" })).status).toBe(200);
  });

  it("D5 rollback of a failed same-name replacement: not unarchived when another rig's token took the agent meanwhile", async () => {
    const yaml = yamlOf([rawMember("research")], "pda-rig");
    expect((await setup.podInstantiator.instantiate(yaml, RIG_ROOT)).ok).toBe(true);
    db.prepare("UPDATE sessions SET status = 'exited'").run();
    const outcome = await setup.podInstantiator.instantiate(yaml, RIG_ROOT, {
      prelaunchHook: async () => {
        await tokenOnlyHolder("rig-two");
        return { ok: false, code: "service_boot_failed", message: "boom" };
      },
    });
    expect(outcome).toMatchObject({ ok: false, code: "service_boot_failed" });
    expect((outcome as { message: string }).message).toContain("(that seat's resume token names it)");
    expect(archivedCount()).toBe(1);
  });

  it("a token on another port, and a damaged token, block nothing", async () => {
    await tokenOnlyHolder("rig-one", "other-name");
    const nodeId = (db.prepare("SELECT id FROM nodes").get() as { id: string }).id;
    const s = setup.sessionRegistry.registerSession(nodeId, "holder2@rig-one");
    setup.sessionRegistry.updateResumeToken(s.id, "pda_agent", "http://127.0.0.1:8151/agents/research", "operator");
    const out = await setup.podInstantiator.materializeStructured(rawSpec([rawMember("copy")], "rig-two"), RIG_ROOT);
    expect(out.ok, JSON.stringify(out)).toBe(true);
  });

  it("launch check (OF-92 order kept): a damaged binding in the asking seat's OWN rig is ignored, but that same seat still counts through its resume token", async () => {
    const mine = await setup.podInstantiator.materializeStructured(rawSpec([rawMember("asker", { pda: { agent: "asker-own" } }), rawMember("sibling", { pda: { agent: "sibling-own" } })], "rig-mine"), RIG_ROOT);
    const rigId = (mine as { ok: true; result: { rigId: string } }).result.rigId;
    const ids = Object.fromEntries((db.prepare("SELECT id, logical_id AS l FROM nodes WHERE rig_id = ?").all(rigId) as Array<{ id: string; l: string }>).map((r) => [r.l, r.id]));
    db.prepare("UPDATE nodes SET pda_binding = '{bad' WHERE id = ?").run(ids["dev.sibling"]);
    const target = { agent: "research", baseUrl: PORT };
    expect(setup.rigRepo.findPdaLaunchConflicts(target, ids["dev.asker"]!)).toEqual([]); // damaged sibling of the own rig: not a hostage-taker
    const session = setup.sessionRegistry.registerSession(ids["dev.sibling"]!, "sibling@rig-mine");
    setup.sessionRegistry.updateResumeToken(session.id, "pda_agent", `${PORT}/agents/research`, "operator");
    const conflicts = setup.rigRepo.findPdaLaunchConflicts(target, ids["dev.asker"]!);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toContain("that seat's resume token names it"); // the sibling counts via its token, not as "unreadable"
  });
});
