// OF-45: GET /api/rigs/:rigId/nodes/:logicalId parsed the seat's saved startup row (node_startup_context) with bare
// JSON.parse, so ONE seat's row that is not JSON made the whole node-detail route throw (HTTP 500: the seat could not
// be inspected at all, which is exactly when an operator opens it). The route now serves the node with the startup info
// marked unreadable (`startupUnreadable`), the same split OF-36 draws between "not JSON" and "parses but wrong shape".
// Real routes over a real migrated DB; the rows are written straight into the table, as a damaged row would be.

import { describe, it, expect, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

const COLUMNS = ["resolved_files_json", "startup_actions_json", "projection_entries_json"] as const;
type Column = (typeof COLUMNS)[number];

const GOOD: Record<Column, string> = {
  resolved_files_json: JSON.stringify([{ path: "role.md", deliveryHint: "send_text", required: true }]),
  startup_actions_json: JSON.stringify([{ type: "send_text", value: "npm run dev" }]),
  projection_entries_json: JSON.stringify([{ effectiveId: "guide-1", category: "guidance", target: "CLAUDE.md" }]),
};

let db: Database.Database | null = null;
afterEach(() => { db?.close(); db = null; });

async function detailWith(overrides: Partial<Record<Column, string>>) {
  db = createFullTestDb();
  const { app, rigRepo } = createTestApp(db);
  const rig = rigRepo.createRig("r");
  const node = rigRepo.addNode(rig.id, "infra.server", { runtime: "terminal" });
  const row = { ...GOOD, ...overrides };
  db.prepare(
    "INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)",
  ).run(node.id, row.projection_entries_json, row.resolved_files_json, row.startup_actions_json, "terminal");
  const res = await app.request(`/api/rigs/${rig.id}/nodes/infra.server`);
  return { res, body: res.status === 200 ? await res.json() as Record<string, unknown> : null };
}

describe("OF-45 node-detail route: an unreadable saved startup row does not fail the route", () => {
  it("control: a readable row serves its startup info and marks nothing unreadable", async () => {
    const { res, body } = await detailWith({});
    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      logicalId: "infra.server",
      startupUnreadable: null,
      startupFiles: [{ path: "role.md" }],
      startupActions: [{ type: "send_text", value: "npm run dev" }],
      installedResources: [{ id: "guide-1" }],
    });
  });

  const cases: Array<{ kind: string; text: string; reason: (column: Column) => string }> = [
    { kind: "not JSON", text: "{not json", reason: (c) => `${c} is not JSON` },
    { kind: "JSON null", text: "null", reason: (c) => `${c} is not a list` },
    { kind: "wrong shape (an object, not a list)", text: JSON.stringify({ path: "role.md" }), reason: (c) => `${c} is not a list` },
  ];
  for (const column of COLUMNS) {
    for (const bad of cases) {
      it(`${column} ${bad.kind}: 200, the node is served, startup info is empty and the reason is named`, async () => {
        const { res, body } = await detailWith({ [column]: bad.text });
        expect(res.status).toBe(200);
        expect(body).toMatchObject({
          logicalId: "infra.server",
          startupUnreadable: bad.reason(column),
          startupFiles: [],
          startupActions: [],
          installedResources: [],
          infrastructureStartupCommand: null,
        });
      });
    }
  }

  it("a list holding a null member is still readable: the member is dropped, the route does not throw", async () => {
    const { res, body } = await detailWith({
      resolved_files_json: JSON.stringify([null, { path: "role.md", deliveryHint: "send_text", required: true }]),
      startup_actions_json: JSON.stringify([null, { type: "send_text", value: "npm run dev" }]),
      projection_entries_json: JSON.stringify([null, { effectiveId: "guide-1", category: "guidance", target: "CLAUDE.md" }]),
    });
    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      startupUnreadable: null,
      startupFiles: [{ path: "role.md" }],
      infrastructureStartupCommand: "npm run dev",
      installedResources: [{ id: "guide-1" }],
    });
  });
});

// OF-45 census: the node-detail route loads the rig first (getRig -> rowToNode), which parsed two more saved columns of
// the node row bare. The same one-bad-row 500 reached through them, on this route and on every route that loads the rig.
describe("OF-45 node-detail route: a damaged saved node row (package_refs, session_source_json) does not fail the route", () => {
  const damage: Array<{ column: "package_refs" | "session_source_json"; kind: string; text: string; expected: Record<string, unknown> }> = [
    { column: "package_refs", kind: "not JSON", text: "{not json", expected: { packageRefs: [] } },
    { column: "package_refs", kind: "JSON null", text: "null", expected: { packageRefs: [] } },
    { column: "package_refs", kind: "wrong shape (a list holding a number)", text: "[1]", expected: { packageRefs: [] } },
    { column: "session_source_json", kind: "not JSON", text: "{not json", expected: { sessionSource: null } },
    { column: "session_source_json", kind: "JSON null", text: "null", expected: { sessionSource: null } },
    { column: "session_source_json", kind: "wrong shape (a list)", text: "[1]", expected: { sessionSource: null } },
  ];
  for (const bad of damage) {
    it(`${bad.column} ${bad.kind}: 200, the node is served with that field empty`, async () => {
      db = createFullTestDb();
      const { app, rigRepo } = createTestApp(db);
      const rig = rigRepo.createRig("r");
      const node = rigRepo.addNode(rig.id, "infra.server", { runtime: "terminal" });
      db.prepare(`UPDATE nodes SET ${bad.column} = ? WHERE id = ?`).run(bad.text, node.id);
      const res = await app.request(`/api/rigs/${rig.id}/nodes/infra.server`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ logicalId: "infra.server" });
      // The route serves the inventory entry, not the node row: read the repository's view of the same row too.
      expect(rigRepo.getRig(rig.id)!.nodes.find((n) => n.logicalId === "infra.server")).toMatchObject(bad.expected);
    });
  }

  it("control: a readable package_refs and session_source_json are read through unchanged", () => {
    db = createFullTestDb();
    const { rigRepo } = createTestApp(db);
    const rig = rigRepo.createRig("r");
    const node = rigRepo.addNode(rig.id, "infra.server", { runtime: "terminal" });
    db.prepare("UPDATE nodes SET package_refs = ?, session_source_json = ? WHERE id = ?")
      .run(JSON.stringify(["pkg-a"]), JSON.stringify({ mode: "fork", ref: { kind: "native_id", value: "abc" } }), node.id);
    expect(rigRepo.getRig(rig.id)!.nodes[0]).toMatchObject({ packageRefs: ["pkg-a"], sessionSource: { mode: "fork" } });
  });
});
