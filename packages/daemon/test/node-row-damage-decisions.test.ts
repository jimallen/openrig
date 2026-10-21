// OF-45 review BLOCK (41998693): rowToNode read a damaged nodes.session_source_json / nodes.package_refs as a valid-looking
// empty value. Every reader of those two Node fields is pinned here (census: `tsc` with the two Node properties renamed
// listed exactly rigspec-exporter.ts:87 (packageRefs), rigspec-exporter.ts:171 (sessionSource) and
// rigspec-instantiator.ts:1252 (sessionSource); snapshot-capture persists whole Node objects). A damaged column is NOT a
// literal JSON null: null stays the real "none" and must keep behaving as before.

import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp, mockTmuxAdapter } from "./helpers/test-app.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import { captureSkippingUnreadable } from "../src/domain/snapshot-capture.js";
import { existingRigRoot } from "./helpers/existing-rig-root.js";

const closers: Array<() => void> = [];
afterEach(() => { for (const close of closers.splice(0)) close(); });

const DAMAGE = [
  { kind: "wrong shape [1]", text: "[1]" },
  { kind: "not JSON", text: "{not json" },
] as const;

// -- first-start retry guard (rigspec-instantiator.ts retryFirstStart) ------------------------------------------------
// Copy of retry-first-start.test.ts's failedAdd: a seat whose first start failed in projection, cleaned, ready to retry.
const root = existingRigRoot("first-start");
const skillIds = ["development-team", "systematic-debugging", "test-driven-development", "verification-before-completion"];
const member = { id: "pi", agent_ref: "local:agent", profile: "default", runtime: "pi", model: "provider/model", cwd: root };

async function failedAdd() {
  const db = createFullTestDb();
  closers.push(() => db.close());
  const files: Record<string, string> = {
    [root]: "",
    [`${root}/agent/agent.yaml`]: `name: implementer\nversion: "1.0.0"\nresources:\n  skills:\n${skillIds.map(id => `    - id: ${id}\n      path: skills/${id}`).join("\n")}\nprofiles:\n  default:\n    uses:\n      skills: [${skillIds.join(", ")}]\nstartup:\n  files:\n    - path: role.md\n      required: true\n      delivery_hint: send_text\n`,
    [`${root}/agent/role.md`]: "Read the role and preserve the existing seat.",
    ...Object.fromEntries(skillIds.flatMap(id => [[`${root}/agent/skills/${id}`, ""], [`${root}/agent/skills/${id}/SKILL.md`, `# ${id}`]])),
  };
  let projectionBlocked = true;
  const adapter: RuntimeAdapter = {
    runtime: "pi",
    listInstalled: vi.fn(async () => []),
    project: vi.fn(async () => ({ projected: [], skipped: [], failed: projectionBlocked ? skillIds.map(effectiveId => ({ effectiveId, error: "EACCES: projection ancestor" })) : [] })),
    deliverStartup: vi.fn(async () => ({ delivered: 1, failed: [] })),
    checkReady: vi.fn(async () => ({ ready: true })),
    launchHarness: vi.fn(async () => ({ ok: true })),
  };
  const tmux = mockTmuxAdapter();
  const setup = createTestApp(db, {
    tmux, adapters: { pi: adapter, "claude-code": adapter },
    podInstantiatorFsOps: { exists: path => path in files, readFile: path => { if (!(path in files)) throw new Error(`Missing ${path}`); return files[path]!; } },
  });
  const rig = setup.rigRepo.createRig("first-start");
  const seeded = await setup.rigExpansionService.expand({ rigId: rig.id, pod: { id: "dev", label: "Dev", members: [{ id: "sibling", agentRef: "builtin:terminal", profile: "none", runtime: "terminal", cwd: root }], edges: [] } });
  expect(seeded.ok).toBe(true);
  const added = await setup.podInstantiator.addMemberToPod(rig.id, "dev", member, root);
  expect(added).toMatchObject({ ok: true, result: { node: { status: "failed", logicalId: "dev.pi" } } });
  const node = setup.rigRepo.getRig(rig.id)!.nodes.find(n => n.logicalId === "dev.pi")!;
  const lifecycle = new SeatLifecycleService({ ...setup, db, tmuxAdapter: tmux });
  tmux.probeSession = vi.fn(async () => ({ state: "absent" as const }));
  const clean = await lifecycle.cleanSeat({ seatRef: "dev-pi@first-start", reason: "Projection failed before native launch; shell has exited" });
  expect(clean.ok).toBe(true);
  projectionBlocked = false;
  const setSource = (text: string | null) => db.prepare("UPDATE nodes SET session_source_json = ? WHERE id = ?").run(text, node.id);
  const request = () => setup.app.request(`/api/rigs/${rig.id}/nodes/dev.pi/launch`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ retryStartupFrom: { member, rigRoot: root } }),
  });
  return { ...setup, db, rig, node, adapter, setSource, request };
}

describe("OF-45 retry guard: a damaged saved session source is refused, never read as 'no source'", () => {
  for (const damage of DAMAGE) {
    it(`session_source_json ${damage.kind}: 409 first_start_retry_refused naming the damage, nothing launched`, async () => {
      const f = await failedAdd();
      f.setSource(damage.text);
      const res = await f.request();
      const body = await res.json() as { code?: string; message?: string };
      expect({ status: res.status, code: body.code }, JSON.stringify(body)).toEqual({ status: 409, code: "first_start_retry_refused" });
      expect(body.message).toMatch(/saved session source is damaged/);
      expect(f.adapter.launchHarness).not.toHaveBeenCalled();
    });
  }

  it("control: a readable saved fork source is still refused (409, the original session-source message)", async () => {
    const f = await failedAdd();
    f.setSource(JSON.stringify({ mode: "fork", ref: { kind: "native_id", value: "abc" } }));
    const res = await f.request();
    const body = await res.json() as { code?: string; message?: string };
    expect(res.status).toBe(409);
    expect(body.message).toMatch(/session-source overrides/);
    expect(f.adapter.launchHarness).not.toHaveBeenCalled();
  });

  it("a literal JSON null is the real 'no source': the retry is accepted as before", async () => {
    const f = await failedAdd();
    f.setSource("null");
    const res = await f.request();
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    expect(f.adapter.launchHarness).toHaveBeenCalledTimes(1);
  });
});

// -- repository, exporter, snapshot, node-detail ------------------------------------------------------------------------
let db: Database.Database | null = null;
afterEach(() => { db?.close(); db = null; });

function seedRig() {
  db = createFullTestDb();
  const setup = createTestApp(db);
  const rig = setup.rigRepo.createRig("r");
  const node = setup.rigRepo.addNode(rig.id, "infra.server", { runtime: "terminal" });
  const setColumn = (column: "package_refs" | "session_source_json", text: string | null) =>
    db!.prepare(`UPDATE nodes SET ${column} = ? WHERE id = ?`).run(text, node.id);
  const readNode = () => setup.rigRepo.getRig(rig.id)!.nodes[0]!;
  return { ...setup, rig, node, setColumn, readNode };
}

describe("OF-45 rowToNode: damage carries a marker, a literal null does not", () => {
  it("session_source_json damage -> empty value plus the reason; package_refs damage likewise", () => {
    const f = seedRig();
    f.setColumn("session_source_json", "[1]");
    f.setColumn("package_refs", "{not json");
    expect(f.readNode()).toMatchObject({
      sessionSource: null, sessionSourceUnreadable: "session_source_json is not an object",
      packageRefs: [], packageRefsUnreadable: "package_refs is not JSON",
    });
  });

  it("a literal JSON null (and a NULL column) is 'none' with no marker at all", () => {
    const f = seedRig();
    f.setColumn("session_source_json", "null");
    f.setColumn("package_refs", "null");
    const node = f.readNode();
    expect(node).toMatchObject({ sessionSource: null, packageRefs: [] });
    expect("sessionSourceUnreadable" in node).toBe(false);
    expect("packageRefsUnreadable" in node).toBe(false);
  });
});

describe("OF-45 exporter: a damaged saved column is refused (409), never exported as missing", () => {
  for (const damage of DAMAGE) {
    it(`GET /spec and /spec.json, session_source_json ${damage.kind} (pod-aware export path, rigspec-exporter.ts:171)`, async () => {
      const f = seedRig();
      f.setColumn("session_source_json", damage.text);
      for (const path of ["spec", "spec.json"]) {
        const res = await f.app.request(`/api/rigs/${f.rig.id}/${path}`);
        const body = await res.json() as { error?: string };
        expect({ path, status: res.status }, JSON.stringify(body)).toEqual({ path, status: 409 });
        expect(body.error).toMatch(/infra\.server.*saved row is damaged.*session_source_json/);
      }
    });
  }

  it("GET /spec, package_refs wrong shape (legacy export path, rigspec-exporter.ts:87)", async () => {
    const f = seedRig();
    f.setColumn("package_refs", "[1]");
    const res = await f.app.request(`/api/rigs/${f.rig.id}/spec`);
    const body = await res.json() as { error?: string };
    expect({ status: res.status }, JSON.stringify(body)).toEqual({ status: 409 });
    expect(body.error).toMatch(/package_refs/);
  });

  it("control: a literal JSON null in both columns exports normally (200)", async () => {
    const f = seedRig();
    f.setColumn("session_source_json", "null");
    f.setColumn("package_refs", "null");
    expect((await f.app.request(`/api/rigs/${f.rig.id}/spec`)).status).toBe(200);
    expect((await f.app.request(`/api/rigs/${f.rig.id}/spec.json`)).status).toBe(200);
  });
});

describe("OF-45 snapshot capture: a damaged saved column is never persisted as a quiet empty value", () => {
  it("manual capture refuses, naming the seat and the column", () => {
    const f = seedRig();
    f.setColumn("session_source_json", "[1]");
    expect(() => f.snapshotCapture.captureSnapshot(f.rig.id, "manual")).toThrow(/infra\.server.*saved row is damaged.*session_source_json/);
  });

  it("an automatic capture (captureSkippingUnreadable) warns and keeps the damage on the seat in the snapshot", () => {
    const f = seedRig();
    f.setColumn("session_source_json", "{not json");
    f.setColumn("package_refs", "[1]");
    const { snapshot, warnings } = captureSkippingUnreadable(f.snapshotCapture, f.rig.id, "auto-pre-down");
    expect(warnings).toHaveLength(1); // one warning per seat, naming every damaged column
    expect(warnings.join("\n")).toMatch(/infra\.server's saved row is damaged \(session_source_json is not JSON; package_refs/);
    expect(warnings.join("\n")).toMatch(/package_refs is not a list of strings/);
    expect(snapshot.data.nodes[0]).toMatchObject({
      sessionSource: null, sessionSourceUnreadable: "session_source_json is not JSON",
      packageRefs: [], packageRefsUnreadable: "package_refs is not a list of strings",
    });
    // The persisted copy carries the marker too, not only the returned object.
    const stored = f.snapshotRepo.getSnapshot(snapshot.id)!;
    expect(stored.data.nodes[0]).toMatchObject({ sessionSourceUnreadable: "session_source_json is not JSON" });
  });

  it("control: a literal JSON null captures with no warning and no marker", () => {
    const f = seedRig();
    f.setColumn("session_source_json", "null");
    f.setColumn("package_refs", "null");
    const { snapshot, warnings } = captureSkippingUnreadable(f.snapshotCapture, f.rig.id, "auto-pre-down");
    expect(warnings).toEqual([]);
    expect("sessionSourceUnreadable" in snapshot.data.nodes[0]!).toBe(false);
  });
});

describe("OF-45 node-detail: still renders, with the node row's damage surfaced", () => {
  it("200 with sessionSourceUnreadable and packageRefsUnreadable set", async () => {
    const f = seedRig();
    f.setColumn("session_source_json", "{not json");
    f.setColumn("package_refs", "[1]");
    const res = await f.app.request(`/api/rigs/${f.rig.id}/nodes/infra.server`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      logicalId: "infra.server",
      sessionSourceUnreadable: "session_source_json is not JSON",
      packageRefsUnreadable: "package_refs is not a list of strings",
    });
  });

  it("control: readable and literal-null columns surface nothing", async () => {
    const f = seedRig();
    f.setColumn("session_source_json", "null");
    f.setColumn("package_refs", JSON.stringify(["pkg-a"]));
    const res = await f.app.request(`/api/rigs/${f.rig.id}/nodes/infra.server`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sessionSourceUnreadable: null, packageRefsUnreadable: null });
  });
});
