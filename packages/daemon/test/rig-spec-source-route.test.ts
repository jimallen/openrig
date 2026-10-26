// OF-102: an operator records the spec source of a rig that was created before OpenRig recorded one, through
// /api/rigs/:rigId/spec-source. Production consequence pinned here: rigs.spec_source_path is what a later
// `rig seat launch --fresh --startup-from spec` re-reads, so a wrong record (a spec for another rig, a path
// that no longer parses, a link replaced by its real path) sends the wrong startup files to a live seat.
// Deployed entrypoint: server.ts mounts rigSpecSourceRoutes at /api/rigs/:rigId/spec-source; the `rig spec-source`
// CLI command (index.ts) calls it. The same module the instantiator uses reads the spec (reanchor, realpath, codec, schema).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { rigSpecSourceRoutes } from "../src/routes/rig-spec-source.js";

const SPEC = (name: string, members: Record<string, string[]>) => `version: "0.2"
name: ${name}
pods:
${Object.entries(members).map(([pod, ids]) => `  - id: ${pod}
    label: ${pod}
    members:
${ids.map((id) => `      - id: ${id}
        agent_ref: "local:agents/${id}"
        profile: default
        runtime: claude-code
        cwd: .
`).join("")}    edges: []
`).join("")}edges: []
`;

describe("OF-102 rig spec-source route", () => {
  let root: string;
  let db: Database.Database;
  let rigRepo: RigRepository;
  let app: Hono;
  let rigId: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "of102-")));
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    const eventBus = new EventBus(db);
    app = new Hono();
    app.use("*", async (c, next) => { c.set("rigRepo" as never, rigRepo as never); c.set("eventBus" as never, eventBus as never); await next(); });
    app.route("/api/rigs/:rigId/spec-source", rigSpecSourceRoutes);
    rigId = rigRepo.createRig("team").id;
    const impl = rigRepo.addNode(rigId, "dev.impl", { runtime: "claude-code" });
    rigRepo.addNode(rigId, "dev.qa", { runtime: "claude-code" });
    // A seat with a saved startup context and a session: the rows the command must leave alone.
    db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, '[]', ?, '[]', 'claude-code')")
      .run(impl.id, JSON.stringify([{ path: "guidance/role.md", absolutePath: "/rel/a/agents/impl/guidance/role.md" }]));
    new SessionRegistry(db).registerSession(impl.id, "dev-impl@team");
  });
  afterEach(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

  const write = (rel: string, text: string) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
  const GOOD = SPEC("team", { dev: ["impl", "qa"] });
  const set = (body: Record<string, unknown>, id = rigId, headers: Record<string, string> = {}) =>
    app.request(`/api/rigs/${id}/spec-source`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const show = (id = rigId) => app.request(`/api/rigs/${id}/spec-source`);
  const events = () => (db.prepare("SELECT payload FROM events WHERE type = 'rig.spec_source_changed' ORDER BY seq").all() as Array<{ payload: string }>).map((r) => JSON.parse(r.payload));
  const seatState = () => JSON.stringify(["nodes", "sessions", "node_startup_context", "bindings"].map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()));

  it("records the path as typed: a link spelling stays a link, with who changed it, from what and to what", async () => {
    const real = write("rel-a/rigs/team/rig.yaml", GOOD);
    fs.mkdirSync(path.join(root, "library"));
    fs.symlinkSync(path.dirname(real), path.join(root, "library", "team"));
    const typed = path.join(root, "library", "team", "rig.yaml");
    const before = seatState();
    expect(before).toContain("dev-impl@team");   // the instrument sees a session and a saved startup context
    expect(before).toContain("guidance/role.md");

    const res = await set({ path: typed, operator: "jim@ops" });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, from: null, to: typed, changed: true, resolvedPath: real });
    expect(rigRepo.getRigSpecSource(rigId)).toBe(typed);
    expect(events()).toEqual([{ type: "rig.spec_source_changed", rigId, from: null, to: typed, operator: "jim@ops" }]);
    // Never changes any node, session or startup context by itself.
    expect(seatState()).toBe(before);
  });

  it("a later move of the link leads show to the new file; the record stays as typed", async () => {
    const real = write("rel-a/rigs/team/rig.yaml", GOOD);
    fs.mkdirSync(path.join(root, "library"));
    fs.symlinkSync(path.dirname(real), path.join(root, "library", "team"));
    const typed = path.join(root, "library", "team", "rig.yaml");
    await set({ path: typed, operator: "jim@ops" });
    expect(await (await show()).json()).toMatchObject({ specSource: typed, resolvedPath: real });
    fs.rmSync(path.join(root, "library", "team"));
    const other = write("rel-b/rigs/team/rig.yaml", GOOD);
    fs.symlinkSync(path.dirname(other), path.join(root, "library", "team"));
    expect(await (await show()).json()).toMatchObject({ ok: true, specSource: typed, resolvedPath: other, unavailable: null });
  });

  it("replacing a recorded source audits the old and the new value", async () => {
    const a = write("a/rig.yaml", GOOD);
    const b = write("b/rig.yaml", GOOD);
    await set({ path: a, operator: "jim@ops" });
    expect((await set({ path: b, operator: "orch@ops" })).status).toBe(200);
    expect(rigRepo.getRigSpecSource(rigId)).toBe(b);
    expect(events().map((e) => [e.from, e.to, e.operator])).toEqual([[null, a, "jim@ops"], [a, b, "orch@ops"]]);
  });

  it("recording the same path again changes nothing and writes no second event", async () => {
    const a = write("a/rig.yaml", GOOD);
    await set({ path: a, operator: "jim@ops" });
    const again = await (await set({ path: a, operator: "jim@ops" })).json();
    expect(again).toMatchObject({ ok: true, changed: false });
    expect(events()).toHaveLength(1);
  });

  it("the operator is the transport session when there is one, else the named operator", async () => {
    const a = write("a/rig.yaml", GOOD);
    await set({ path: a, operator: "claimed@ops" }, rigId, { "x-openrig-session": "dev-impl@team" });
    expect(events()[0]!.operator).toBe("dev-impl@team");
  });

  describe("refusals leave the record and the audit trail untouched", () => {
    const refused = async (res: Response, status: number, code: string) => {
      expect(res.status).toBe(status);
      const body = await res.json() as { ok: boolean; code: string; message: string; mismatches?: string[] };
      expect(body).toMatchObject({ ok: false, code });
      expect(rigRepo.getRigSpecSource(rigId)).toBeNull();
      expect(events()).toEqual([]);
      return body;
    };

    it("a path that does not exist", async () => {
      const body = await refused(await set({ path: path.join(root, "nope", "rig.yaml"), operator: "jim@ops" }), 409, "spec_unreadable");
      expect(body.message).toContain("does not exist");
    });

    it("a link that leads nowhere", async () => {
      fs.symlinkSync(path.join(root, "gone"), path.join(root, "dangling.yaml"));
      await refused(await set({ path: path.join(root, "dangling.yaml"), operator: "jim@ops" }), 409, "spec_unreadable");
    });

    it("a file that is not YAML", async () => {
      await refused(await set({ path: write("bad.yaml", "pods: [unclosed\n  - : :"), operator: "jim@ops" }), 409, "spec_invalid");
    });

    it("YAML that is not a rig spec", async () => {
      const body = await refused(await set({ path: write("other.yaml", "hello: world\n"), operator: "jim@ops" }), 409, "spec_invalid");
      expect(body.message).toContain("not a valid rig spec");
    });

    it("a spec for another rig: the name differs", async () => {
      const body = await refused(await set({ path: write("x/rig.yaml", SPEC("other", { dev: ["impl", "qa"] })), operator: "jim@ops" }), 409, "spec_mismatch");
      expect(body.mismatches).toEqual(["the spec is named 'other', this rig is 'team'"]);
    });

    it("a spec that does not declare every live seat: each missing seat is reported", async () => {
      rigRepo.addNode(rigId, "ops.extra", { runtime: "claude-code" });
      rigRepo.addNode(rigId, "ops.more", { runtime: "claude-code" });
      const body = await refused(await set({ path: write("y/rig.yaml", SPEC("team", { dev: ["impl"] })), operator: "jim@ops" }), 409, "spec_mismatch");
      expect(body.mismatches).toEqual([
        "seat dev.qa is not declared in the spec's pods",
        "seat ops.extra is not declared in the spec's pods",
        "seat ops.more is not declared in the spec's pods",
      ]);
    });

    it("name and seats both wrong: both are reported", async () => {
      const body = await refused(await set({ path: write("z/rig.yaml", SPEC("other", { dev: ["impl"] })), operator: "jim@ops" }), 409, "spec_mismatch");
      expect(body.mismatches).toHaveLength(2);
    });

    it("a relative path (it would depend on the daemon's directory)", async () => {
      write("rel/rig.yaml", GOOD);
      await refused(await set({ path: "rel/rig.yaml", operator: "jim@ops" }), 400, "path_not_absolute");
    });

    it("no operator: the change cannot be audited", async () => {
      await refused(await set({ path: write("a/rig.yaml", GOOD) }), 400, "missing_operator");
    });

    it("an unknown rig", async () => {
      const res = await set({ path: write("a/rig.yaml", GOOD), operator: "jim@ops" }, "no-such-rig");
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ ok: false, code: "rig_not_found" });
    });
  });

  it("control: a spec that declares MORE seats than the rig has is accepted (a seat the rig has not grown yet)", async () => {
    const a = write("a/rig.yaml", SPEC("team", { dev: ["impl", "qa", "extra"], ops: ["lead"] }));
    expect((await set({ path: a, operator: "jim@ops" })).status).toBe(200);
  });

  describe("show", () => {
    it("a rig that records nothing says so", async () => {
      expect(await (await show()).json()).toEqual({ ok: true, rigId, rigName: "team", specSource: null, resolvedPath: null, unavailable: null });
    });

    it("a recorded source that no longer exists is reported unusable, with the recorded spelling kept", async () => {
      const a = write("a/rig.yaml", GOOD);
      await set({ path: a, operator: "jim@ops" });
      fs.rmSync(a);
      const body = await (await show()).json() as Record<string, unknown>;
      expect(body).toMatchObject({ specSource: a, resolvedPath: null });
      expect(String(body["unavailable"])).toContain("does not exist");
    });

    it("an unknown rig is 404", async () => {
      expect((await show("no-such-rig")).status).toBe(404);
    });
  });
});
