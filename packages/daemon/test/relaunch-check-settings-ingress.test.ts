// workspaces-o9o.64 (verify-qa FAIL 1): a seat's relaunch_checks are read at launch from the rig's RECORDED spec source, so a route that
// takes a member fragment and never records it (expansion, add-member) would accept the field and drop it in silence. Those routes refuse
// it instead, by name, saying where it goes, as expansion already refuses mcp_servers; nothing is created.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

describe("o9o.64: a fragment-only member route refuses relaunch_checks", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;
  beforeEach(() => { db = createFullTestDb(); setup = createTestApp(db); });
  afterEach(() => { db.close(); });

  const member = (id: string, extra: Record<string, unknown> = {}) => ({ id, runtime: "terminal", agent_ref: "builtin:terminal", profile: "none", cwd: "/tmp", ...extra });
  const expand = (rigId: string, members: Array<Record<string, unknown>>) => setup.app.request(`/api/rigs/${rigId}/expand`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rigRoot: ".", pod: { id: "infra", label: "Infra", edges: [], members } }),
  });
  const nodesOf = (rigId: string) => (db.prepare("SELECT logical_id FROM nodes WHERE rig_id = ?").all(rigId) as Array<{ logical_id: string }>).map((r) => r.logical_id);

  it.each([["relaunch_checks"], ["relaunchChecks"]])("expansion refuses %s by name, says where it goes, and creates nothing", async (key) => {
    const rig = setup.rigRepo.createRig(`expand-${key}`);
    const res = await expand(rig.id, [member("server", { [key]: { ignore_children: ["sccache"] } })]);
    const body: { ok?: boolean; code?: string; error?: string } = await res.json();
    expect(res.status).toBe(400);
    expect(body).toMatchObject({ ok: false, code: "validation_failed" });
    expect(body.error).toContain("relaunch_checks");
    expect(body.error).toContain("server");
    expect(body.error).toContain("recorded spec");
    expect(nodesOf(rig.id)).toEqual([]);
  });

  it("add-member refuses relaunch_checks by name, says where it goes, and adds nothing", async () => {
    const rig = setup.rigRepo.createRig("add-member-rig");
    expect((await expand(rig.id, [member("server")])).status).toBe(201);
    const res = await setup.app.request(`/api/rigs/${rig.id}/pods/infra/members`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rigRoot: ".", member: member("worker", { relaunch_checks: { handover_file: "NOTES-*.md" } }) }),
    });
    const body: { ok?: boolean; code?: string; error?: string; errors?: string[] } = await res.json();
    expect(res.status).toBe(400);
    expect(body).toMatchObject({ ok: false, code: "validation_failed" });
    expect(JSON.stringify(body)).toContain("relaunch_checks");
    expect(JSON.stringify(body)).toContain("recorded spec");
    expect(nodesOf(rig.id)).toEqual(["infra.server"]);
  });

  it("control: the same expansion without the field is accepted", async () => {
    const rig = setup.rigRepo.createRig("expand-control");
    expect((await expand(rig.id, [member("server")])).status).toBe(201);
    expect(nodesOf(rig.id)).toEqual(["infra.server"]);
  });
});
