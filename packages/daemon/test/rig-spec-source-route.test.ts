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
import { mcpSpecRoots, type PathJudgeIo } from "../src/domain/codex-mcp-servers.js";

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

// A stand-in for the daemon's OPENRIG_AUTH_BEARER_TOKEN; not a secret.
const OPERATOR_TOKEN = "of102-operator-token";

/** The real file system, judged without owner, temp-folder and writable-bit rules (test fixtures live in the temp folder). */
const PERMISSIVE_IO: PathJudgeIo = {
  lstat: (p) => fs.lstatSync(p), stat: (p) => fs.statSync(p), realpath: (p) => fs.realpathSync(p),
  uid: () => undefined, tempRoots: () => [],
};

describe("OF-102 rig spec-source route", () => {
  let root: string;
  let db: Database.Database;
  let rigRepo: RigRepository;
  let app: Hono;
  let rigId: string;
  let eventBus: EventBus;
  let trusted: string;
  let home: string;
  let sharedDocsRigs: string;

  /** The route, mounted as server.ts mounts it: the MCP trust roots (released copies under <home>, the library) reach it
   *  as `mcpTrust`; the shared-docs rigs folder is the route's own. */
  function mount(opts: { bearerToken: string | null; io?: PathJudgeIo; extraRoots?: string[] }): Hono {
    const a = new Hono();
    a.use("*", async (c, next) => {
      c.set("rigRepo" as never, rigRepo as never);
      c.set("eventBus" as never, eventBus as never);
      c.set("mcpTrust" as never, { specRoots: () => [...mcpSpecRoots({ home, specLibraryRoots: [trusted] }), ...(opts.extraRoots ?? [])], ...(opts.io ? { io: opts.io } : {}) } as never);
      await next();
    });
    a.route("/api/rigs/:rigId/spec-source", rigSpecSourceRoutes({ bearerToken: opts.bearerToken, sharedDocsRigsRoot: sharedDocsRigs }));
    return a;
  }

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "of102-")));
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    eventBus = new EventBus(db);
    trusted = path.join(root, "trusted");           // stands in for the spec library root
    home = path.join(root, "home");                 // stands in for the daemon's home (released copies: <home>/.agents-release)
    sharedDocsRigs = path.join(root, "openrig-home", "shared-docs", "rigs");
    for (const dir of [trusted, home, sharedDocsRigs]) fs.mkdirSync(dir, { recursive: true });
    // The fixtures live under the temp folder, which the real judge refuses, so the main app judges with the real
    // file system but no owner, temp-folder or writable-bit rules; the trusted-root anchoring, one-link and
    // real-location rules are the real ones. `realJudge` (below) is the production judge, used where a row needs it.
    app = mount({ bearerToken: OPERATOR_TOKEN, io: PERMISSIVE_IO });
    rigId = rigRepo.createRig("team").id;
    const impl = rigRepo.addNode(rigId, "dev.impl", { runtime: "claude-code", agentRef: "local:agents/impl", profile: "default" });
    rigRepo.addNode(rigId, "dev.qa", { runtime: "claude-code", agentRef: "local:agents/qa", profile: "default" });
    // A seat with a saved startup context and a session: the rows the command must leave alone.
    db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, '[]', ?, '[]', 'claude-code')")
      .run(impl.id, JSON.stringify([{ path: "guidance/role.md", absolutePath: "/rel/a/agents/impl/guidance/role.md" }]));
    new SessionRegistry(db).registerSession(impl.id, "dev-impl@team");
  });
  afterEach(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

  /** Write a spec file under the trusted library root (or under `base`). */
  const write = (rel: string, text: string, base = trusted) => { const p = path.join(base, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
  const GOOD = SPEC("team", { dev: ["impl", "qa"] });
  /** POST as the operator (bearer token) unless `headers` says otherwise. */
  const set = (body: Record<string, unknown>, id = rigId, headers: Record<string, string> = { authorization: `Bearer ${OPERATOR_TOKEN}` }, target: Hono = app) =>
    target.request(`/api/rigs/${id}/spec-source`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const show = (id = rigId) => app.request(`/api/rigs/${id}/spec-source`);
  const events = () => (db.prepare("SELECT payload FROM events WHERE type = 'rig.spec_source_changed' ORDER BY seq").all() as Array<{ payload: string }>).map((r) => JSON.parse(r.payload));
  const seatState = () => JSON.stringify(["nodes", "sessions", "node_startup_context", "bindings"].map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()));

  it("records the path as typed: a link spelling stays a link, with who changed it, from what and to what", async () => {
    const real = write("rel-a/rigs/team/rig.yaml", GOOD);
    fs.mkdirSync(path.join(trusted, "library"));
    fs.symlinkSync(path.dirname(real), path.join(trusted, "library", "team"));
    const typed = path.join(trusted, "library", "team", "rig.yaml");
    const before = seatState();
    expect(before).toContain("dev-impl@team");   // the instrument sees a session and a saved startup context
    expect(before).toContain("guidance/role.md");

    const res = await set({ path: typed, operator: "jim@ops" });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, from: null, to: typed, changed: true, resolvedPath: real });
    expect(rigRepo.getRigSpecSource(rigId)).toBe(typed);
    // The audit says the write passed the operator token, and that the operator name was only claimed (no session header).
    expect(events()).toEqual([{ type: "rig.spec_source_changed", rigId, from: null, to: typed, operator: "jim@ops", operatorIdentity: "claimed:v1", authorizedBy: "operator_bearer" }]);
    // The message names what changes for the operator: plain --fresh launches and --fresh restores now re-read the spec.
    expect(String(body["effect"])).toContain("a plain `rig seat launch --fresh`");
    expect(String(body["effect"])).toContain("restore");
    expect(String(body["effect"])).toContain("--startup-from stored");
    expect(body["warnings"]).toEqual([]);
    // Never changes any node, session or startup context by itself.
    expect(seatState()).toBe(before);
  });

  it("a later move of the link leads show to the new file; the record stays as typed", async () => {
    const real = write("rel-a/rigs/team/rig.yaml", GOOD);
    fs.mkdirSync(path.join(trusted, "library"));
    fs.symlinkSync(path.dirname(real), path.join(trusted, "library", "team"));
    const typed = path.join(trusted, "library", "team", "rig.yaml");
    await set({ path: typed, operator: "jim@ops" });
    expect(await (await show()).json()).toMatchObject({ specSource: typed, resolvedPath: real });
    fs.rmSync(path.join(trusted, "library", "team"));
    const other = write("rel-b/rigs/team/rig.yaml", GOOD);
    fs.symlinkSync(path.dirname(other), path.join(trusted, "library", "team"));
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
    await set({ path: a, operator: "claimed@ops" }, rigId, { authorization: `Bearer ${OPERATOR_TOKEN}`, "x-openrig-session": "dev-impl@team" });
    expect(events()[0]).toMatchObject({ operator: "dev-impl@team", operatorIdentity: "transport:v1", authorizedBy: "operator_bearer" });
  });

  // F1 of the review of 27ffebc8: what is recorded decides which startup files, culture and local: personas a later
  // plain --fresh launch or --fresh restore delivers into a live seat, so only the operator bearer may record it.
  describe("the write needs the operator bearer token", () => {
    const nothingRecorded = () => { expect(rigRepo.getRigSpecSource(rigId)).toBeNull(); expect(events()).toEqual([]); };

    it("a seat session header with no token is refused when the daemon has a token, nothing is recorded", async () => {
      const res = await set({ path: write("a/rig.yaml", GOOD), operator: "dev-impl@team" }, rigId, { "x-openrig-session": "dev-impl@team" });
      expect(res.status).toBe(401);
      nothingRecorded();
    });

    it("a wrong token is refused, even beside a seat session header", async () => {
      const res = await set({ path: write("a/rig.yaml", GOOD), operator: "jim@ops" }, rigId, { authorization: "Bearer not-the-token", "x-openrig-session": "dev-impl@team" });
      expect(res.status).toBe(401);
      nothingRecorded();
    });

    it("a token sent in a form that is not 'Bearer <token>' is refused", async () => {
      const res = await set({ path: write("a/rig.yaml", GOOD), operator: "jim@ops" }, rigId, { authorization: OPERATOR_TOKEN });
      expect(res.status).toBe(401);
      nothingRecorded();
    });

    it("the operator token is accepted", async () => {
      const res = await set({ path: write("a/rig.yaml", GOOD), operator: "jim@ops" });
      expect(res.status).toBe(200);
      expect(events()).toHaveLength(1);
    });

    it("a daemon with no token configured is gated by the trusted-root rule alone: a trusted spec is accepted without a token", async () => {
      const open = mount({ bearerToken: null, io: PERMISSIVE_IO });
      const a = write("a/rig.yaml", GOOD);
      const res = await set({ path: a, operator: "jim@ops" }, rigId, {}, open);
      expect(res.status).toBe(200);
      expect(events()).toMatchObject([{ to: a, authorizedBy: "trusted_spec_root" }]);
    });

    it("reading stays open: show needs no token", async () => {
      expect((await show()).status).toBe(200);
    });
  });

  // Jim, 2026-10-26, "Trusted folders instead": the spec must be one a seat could not have written. The anchor is the
  // spec's REAL location under a trusted root; the same check `rig seat set-mcp --spec` applies, plus this route's own
  // root <OPENRIG_HOME>/shared-docs/rigs. Whoever asks, a spec outside the roots is refused.
  describe("the spec must lie under a trusted spec root", () => {
    const nothingRecorded = () => { expect(rigRepo.getRigSpecSource(rigId)).toBeNull(); expect(events()).toEqual([]); };
    const KERNEL = (name: string) => `version: "0.2"
name: ${name}
permission_policy: builtin:yolo
summary: >
  A kernel-shaped spec: absolute path: agent refs, startup actions, an mcp_servers block and an improve pod.
culture_file: culture/CULTURE.md
pods:
  - id: advisor
    label: Advisor
    members:
      - id: lead
        agent_ref: "path:/opt/homebrew/lib/node_modules/@openrig/cli/daemon/specs/rigs/launch/kernel/agents/advisor/lead"
        runtime: claude-code
        profile: default
        cwd: "/Users/jima/.workspaces/advisor-lead"
  - id: operator
    label: Operator
    members:
      - id: human
        agent_ref: "builtin:terminal"
        runtime: terminal
        profile: none
        cwd: "/Users/jima/.workspaces/operator-human"
        startup:
          actions:
            - type: send_text
              value: rig tui
              phase: after_ready
              applies_on: [fresh_start]
              idempotent: true
      - id: agent
        agent_ref: "path:/opt/homebrew/lib/node_modules/@openrig/cli/daemon/specs/rigs/launch/kernel/agents/operator/agent"
        runtime: codex
        profile: default
        cwd: "/Users/jima/.workspaces/operator-agent"
        mcp_servers:
          lsp:
            command: /Users/jima/.local/opt/mcpls-0.8.0/bin/mcpls
            args: ["--config", "/Users/jima/.agents-release/current/rigs/kernel/mcpls.toml"]
            startup_timeout_sec: 30
            tool_timeout_sec: 60
            enabled_tools: [get_definition, get_references]
    edges:
      - kind: collaborates_with
        from: agent
        to: human
  - id: queue
    label: Queue
    members:
      - id: worker
        agent_ref: "path:/opt/homebrew/lib/node_modules/@openrig/cli/daemon/specs/rigs/launch/kernel/agents/queue/worker"
        runtime: codex
        profile: default
        cwd: "/Users/jima/.workspaces/queue-worker"
  - id: improve
    label: Improve
    members:
      - id: steward
        agent_ref: "path:/Users/jima/.agents-release/current/agents/rsi-steward"
        runtime: claude-code
        profile: default
        permission_policy: builtin:yolo
        cwd: "/Users/jima/.workspaces/improve-steward"
edges:
  - kind: delegates_to
    from: advisor.lead
    to: operator.agent
`;
    const kernelRig = () => {
      const id = rigRepo.createRig("kernel").id;
      for (const logicalId of ["advisor.lead", "operator.human", "operator.agent", "queue.worker", "improve.steward"]) rigRepo.addNode(id, logicalId, { runtime: "claude-code" });
      return id;
    };

    it("the reviewer's scenario: a spec a seat wrote itself under the temp folder is refused with no token configured, whoever asks", async () => {
      const evil = write("seat-wrote-this/rig.yaml", GOOD, root);          // outside every trusted root
      const production = mount({ bearerToken: null });                     // no token; the production judge
      const res = await set({ path: evil, operator: "dev-impl@team" }, rigId, { "x-openrig-session": "dev-impl@team" }, production);
      expect(res.status).toBe(409);
      const body = await res.json() as { code: string; message: string };
      expect(body.code).toBe("spec_untrusted");
      expect(body.message).toContain("not under a trusted spec root");
      nothingRecorded();
    });

    it("the operator token does not make an untrusted spec acceptable", async () => {
      const evil = write("seat-wrote-this/rig.yaml", GOOD, root);
      const res = await set({ path: evil, operator: "jim@ops" });          // main app: token configured, valid token sent
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: "spec_untrusted" });
      nothingRecorded();
    });

    it("a link under a trusted root that points outside it is refused: the real location decides", async () => {
      const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "of102-outside-")));
      try {
        fs.writeFileSync(path.join(outside, "rig.yaml"), GOOD);
        fs.symlinkSync(outside, path.join(trusted, "escape"));
        const res = await set({ path: path.join(trusted, "escape", "rig.yaml"), operator: "jim@ops" });
        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({ code: "spec_untrusted" });
        nothingRecorded();
      } finally { fs.rmSync(outside, { recursive: true, force: true }); }
    });

    it("a kernel-shaped spec under <OPENRIG_HOME>/shared-docs/rigs is accepted, recorded as typed", async () => {
      const id = kernelRig();
      const typed = write("kernel/rig.yaml", KERNEL("kernel"), sharedDocsRigs);
      const res = await set({ path: typed, operator: "jim@ops" }, id);
      expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
      expect(rigRepo.getRigSpecSource(id)).toBe(typed);
    });

    it("a release-root spec reached through ~/.agents-release/current is accepted, recorded as typed (the link stays a link)", async () => {
      write("rel1/rigs/team/rig.yaml", GOOD, path.join(home, ".agents-release"));
      fs.symlinkSync(path.join(home, ".agents-release", "rel1"), path.join(home, ".agents-release", "current"));
      const typed = path.join(home, ".agents-release", "current", "rigs", "team", "rig.yaml");
      const res = await set({ path: typed, operator: "jim@ops" });
      expect(res.status).toBe(200);
      expect(rigRepo.getRigSpecSource(rigId)).toBe(typed);
    });

    // Review L1: the recorded value is the TYPED spelling, read again at every launch, restore and MCP read with no re-check.
    // A link kept in a folder a seat can write could be retargeted to the seat's own file after it was recorded, so the typed
    // path itself must qualify as well as where it leads: lexically under a general trusted root, or exactly
    // <shared-docs rigs>/<name>/rig.yaml.
    describe("the path as typed must qualify too", () => {
      it("the reviewer's link in a seat-writable state folder (<root>/team/state/queue/rig.yaml -> the real <root>/team/rig.yaml) is refused", async () => {
        const real = write("team/rig.yaml", GOOD, sharedDocsRigs);
        fs.mkdirSync(path.join(sharedDocsRigs, "team", "state", "queue"), { recursive: true });
        const link = path.join(sharedDocsRigs, "team", "state", "queue", "rig.yaml");
        fs.symlinkSync(real, link);
        const res = await set({ path: link, operator: "jim@ops" });
        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({ code: "spec_untrusted" });
        nothingRecorded();
        // control: the real path itself is fine, so it is the typed spelling that was refused
        expect((await set({ path: real, operator: "jim@ops" })).status).toBe(200);
      });
      it("a link outside every root that leads to a trusted spec is refused", async () => {
        const real = write("a/rig.yaml", GOOD);
        fs.mkdirSync(path.join(root, "elsewhere"));
        const link = path.join(root, "elsewhere", "rig.yaml");
        fs.symlinkSync(real, link);
        const res = await set({ path: link, operator: "jim@ops" });
        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({ code: "spec_untrusted" });
        nothingRecorded();
        // control: the real path itself is fine
        expect((await set({ path: real, operator: "jim@ops" })).status).toBe(200);
      });
      it("the same link inside a trusted root is accepted (the link's own folder is protected), recorded as typed", async () => {
        const real = write("a/rig.yaml", GOOD);
        fs.mkdirSync(path.join(trusted, "links"));
        const link = path.join(trusted, "links", "rig.yaml");
        fs.symlinkSync(real, link);
        const res = await set({ path: link, operator: "jim@ops" });
        expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
        expect(rigRepo.getRigSpecSource(rigId)).toBe(link);
      });
      it("the typed path's own folders get the ownership and mode checks too: a link kept in a group-writable folder is refused", async () => {
        const real = write("a/rig.yaml", GOOD);
        fs.mkdirSync(path.join(trusted, "ldir"));
        const link = path.join(trusted, "ldir", "rig.yaml");
        fs.symlinkSync(real, link);
        // `ldir` is on the typed chain only; the link's target never passes through it.
        const present = (bits: number): PathJudgeIo => {
          const mask = (p: string, st: fs.Stats): fs.Stats => Object.create(st, { mode: { value: (st.mode & ~0o022) | (p === path.join(trusted, "ldir") ? bits : 0) } }) as fs.Stats;
          return { ...PERMISSIVE_IO, uid: () => process.getuid?.(), lstat: (p) => mask(p, fs.lstatSync(p)), stat: (p) => mask(p, fs.statSync(p)) };
        };
        const accepted = await set({ path: link, operator: "jim@ops" }, rigId, undefined, mount({ bearerToken: null, io: present(0) }));
        expect(accepted.status, JSON.stringify(await accepted.clone().json())).toBe(200);
        db.prepare("UPDATE rigs SET spec_source_path = NULL WHERE id = ?").run(rigId);
        db.prepare("DELETE FROM events").run();
        const refused = await set({ path: link, operator: "jim@ops" }, rigId, undefined, mount({ bearerToken: null, io: present(0o020) }));
        expect(refused.status).toBe(409);
        nothingRecorded();
      });
    });

    // Review R6: sandboxed Codex seats get <shared-docs>/rigs/<rig>/state/<pod> as a WRITABLE folder, and it sits inside the
    // route's own root, which spans every rig. That root therefore takes exactly <root>/<name>/rig.yaml, by real location.
    describe("the shared-docs rigs folder takes exactly <name>/rig.yaml", () => {
      it("the reviewer's spec in a seat-writable state folder (<root>/eztrack/state/verify/rig.yaml) is refused, for another rig", async () => {
        const evil = write("eztrack/state/verify/rig.yaml", GOOD, sharedDocsRigs);
        const res = await set({ path: evil, operator: "verify-qa@eztrack" }, rigId, { "x-openrig-session": "verify-qa@eztrack" }, mount({ bearerToken: null, io: PERMISSIVE_IO }));
        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({ code: "spec_untrusted" });
        nothingRecorded();
      });
      it("even for the rig it belongs to: a state subfolder never qualifies", async () => {
        const evil = write("team/state/verify/rig.yaml", GOOD, sharedDocsRigs);
        expect((await set({ path: evil, operator: "jim@ops" })).status).toBe(409);
        nothingRecorded();
      });
      it("a deeper path under the rig's own folder is refused", async () => {
        expect((await set({ path: write("team/sub/rig.yaml", GOOD, sharedDocsRigs), operator: "jim@ops" })).status).toBe(409);
        nothingRecorded();
      });
      it("another filename in the rig's folder is refused", async () => {
        expect((await set({ path: write("team/other.yaml", GOOD, sharedDocsRigs), operator: "jim@ops" })).status).toBe(409);
        nothingRecorded();
      });
      it("another rig's <name>/rig.yaml is refused (the folder names neither this rig nor its spec)", async () => {
        const res = await set({ path: write("other/rig.yaml", GOOD, sharedDocsRigs), operator: "jim@ops" });
        expect(res.status).toBe(409);
        const body = await res.json() as { code: string; message: string };
        expect(body.code).toBe("spec_untrusted");
        expect(body.message).toContain("neither this rig's name");
        nothingRecorded();
      });
      it("a folder link to another rig's folder is judged by the real location: refused", async () => {
        write("other/rig.yaml", GOOD, sharedDocsRigs);
        fs.symlinkSync(path.join(sharedDocsRigs, "other"), path.join(sharedDocsRigs, "team"));
        expect((await set({ path: path.join(sharedDocsRigs, "team", "rig.yaml"), operator: "jim@ops" })).status).toBe(409);
        nothingRecorded();
      });
      it("this rig's own <name>/rig.yaml is accepted, recorded as typed", async () => {
        const typed = write("team/rig.yaml", GOOD, sharedDocsRigs);
        const res = await set({ path: typed, operator: "jim@ops" });
        expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
        expect(rigRepo.getRigSpecSource(rigId)).toBe(typed);
      });
      it("a link inside the root typed as <root>/current/rig.yaml is refused: the typed folder must be this rig's or its spec's name", async () => {
        write("team/rig.yaml", GOOD, sharedDocsRigs);
        fs.symlinkSync(path.join(sharedDocsRigs, "team"), path.join(sharedDocsRigs, "current"));
        const res = await set({ path: path.join(sharedDocsRigs, "current", "rig.yaml"), operator: "jim@ops" });
        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({ code: "spec_untrusted" });
        nothingRecorded();
      });
      it("a project rig's spec sits in a folder named for the rig or for the spec: both accepted", async () => {
        const spec = `version: "0.2"\nname: jims-team\nproject_rig: true\npods:\n  - id: dev\n    label: dev\n    members:\n      - id: impl\n        agent_ref: "local:agents/impl"\n        profile: default\n        runtime: claude-code\n        cwd: .\n    edges: []\nedges: []\n`;
        const proj = path.join(root, "myproj", ".workspaces", "dev-impl");
        for (const folder of ["myproj", "jims-team"]) {
          // one rig per folder, each in its own transaction-free fresh row; both are the project rig "myproj"
          const id = rigRepo.createRig("myproj").id;
          rigRepo.addNode(id, "dev.impl", { runtime: "claude-code", agentRef: "local:agents/impl", profile: "default", cwd: proj });
          const typed = write(`${folder}/rig.yaml`, spec, sharedDocsRigs);
          const res = await set({ path: typed, operator: "jim@ops" }, id);
          expect(res.status, `${folder}: ${JSON.stringify(await res.clone().json())}`).toBe(200);
        }
      });
    });

    it("a typed path into an install that is gone is judged where the read goes (re-anchored), not skipped", async () => {
      // /gone/…/@openrig/cli/daemon/specs/… re-anchors to the running install's bundled specs. Here the typed spelling lies
      // under a trusted root (/gone/node_modules) but the file the read uses does not: the check must judge the re-anchored
      // file instead of waving an unresolvable path through to the read.
      const typed = "/gone/node_modules/@openrig/cli/daemon/specs/rigs/launch/kernel/rig.yaml";
      const res = await set({ path: typed, operator: "jim@ops" }, rigId, undefined, mount({ bearerToken: null, io: PERMISSIVE_IO, extraRoots: ["/gone/node_modules"] }));
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: "spec_untrusted" });
      nothingRecorded();
    });

    // The ownership and protection rules of the existing check, shown with the production judge's own rules switched
    // on (the owner rule and the writable-bits rule) over a file system that presents the bits: group- or
    // other-writable folders and files are refused; the same tree without those bits is accepted.
    describe("the existing protection rules apply", () => {
      const presenting = (bits: { dir?: number; file?: number }): PathJudgeIo => {
        const present = (p: string, st: fs.Stats): fs.Stats => {
          const mode = (st.mode & ~0o022) | (p === trusted ? (bits.dir ?? 0) : p.endsWith("rig.yaml") ? (bits.file ?? 0) : 0);
          return Object.create(st, { mode: { value: mode } }) as fs.Stats;
        };
        return { ...PERMISSIVE_IO, uid: () => process.getuid?.(), lstat: (p) => present(p, fs.lstatSync(p)), stat: (p) => present(p, fs.statSync(p)) };
      };
      it("control: the tree without writable bits is accepted", async () => {
        const res = await set({ path: write("a/rig.yaml", GOOD), operator: "jim@ops" }, rigId, undefined, mount({ bearerToken: null, io: presenting({}) }));
        expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
      });
      it.each([["the spec's folder is writable by group", { dir: 0o020 }], ["the spec file is writable by others", { file: 0o002 }]] as const)("%s: refused", async (_name, bits) => {
        const res = await set({ path: write("a/rig.yaml", GOOD), operator: "jim@ops" }, rigId, undefined, mount({ bearerToken: null, io: presenting(bits) }));
        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({ code: "spec_untrusted" });
        nothingRecorded();
      });
    });
  });

  describe("a project rig is named after its project folder, not its spec", () => {
    const projectSpec = (extra = "project_rig: true\n") => `version: "0.2"\nname: jims-team\n${extra}pods:\n  - id: dev\n    label: dev\n    members:\n      - id: impl\n        agent_ref: "local:agents/impl"\n        profile: default\n        runtime: claude-code\n        cwd: .\n    edges: []\nedges: []\n`;
    const projectRig = (name: string, cwd: string) => {
      const id = rigRepo.createRig(name).id;
      rigRepo.addNode(id, "dev.impl", { runtime: "claude-code", agentRef: "local:agents/impl", profile: "default", cwd });
      return id;
    };

    it("a project rig spec repoints a project rig whose seat folder is <project>/.workspaces/<seat>", async () => {
      const id = projectRig("myproj", path.join(root, "myproj", ".workspaces", "dev-impl"));
      const spec = write("p/rig.yaml", projectSpec());
      const res = await set({ path: spec, operator: "jim@ops" }, id);
      expect(res.status).toBe(200);
      expect(rigRepo.getRigSpecSource(id)).toBe(spec);
    });

    it("the same spec is refused for a rig that is not that project's (the seat folder names another project)", async () => {
      const id = projectRig("myproj", path.join(root, "otherproj", ".workspaces", "dev-impl"));
      const res = await set({ path: write("p/rig.yaml", projectSpec()), operator: "jim@ops" }, id);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: "spec_mismatch" });
      expect(rigRepo.getRigSpecSource(id)).toBeNull();
    });

    it("a spec that is not a project rig spec is still refused on its name", async () => {
      const id = projectRig("myproj", path.join(root, "myproj", ".workspaces", "dev-impl"));
      const res = await set({ path: write("p/rig.yaml", projectSpec("")), operator: "jim@ops" }, id);
      expect(res.status).toBe(409);
      expect(rigRepo.getRigSpecSource(id)).toBeNull();
    });
  });

  describe("warnings: seats a fresh launch from this spec would refuse", () => {
    it("a seat whose agent_ref differs is named; the spec is still recorded", async () => {
      const a = write("a/rig.yaml", GOOD.replace('"local:agents/qa"', '"local:agents/qa-v2"'));
      const body = await (await set({ path: a, operator: "jim@ops" })).json() as { ok: boolean; warnings: string[] };
      expect(body.ok).toBe(true);
      expect(body.warnings).toHaveLength(1);
      expect(body.warnings[0]).toContain("dev.qa");
      expect(body.warnings[0]).toContain("agent_ref local:agents/qa-v2 (seat: local:agents/qa)");
      expect(rigRepo.getRigSpecSource(rigId)).toBe(a);
    });

    it("a seat whose runtime or profile differs is named with each difference", async () => {
      const a = write("a/rig.yaml", GOOD.replace("runtime: claude-code", "runtime: codex").replace("profile: default", "profile: other"));
      const body = await (await set({ path: a, operator: "jim@ops" })).json() as { warnings: string[] };
      expect(body.warnings.join("\n")).toContain("runtime codex (seat: claude-code)");
      expect(body.warnings.join("\n")).toContain("profile other (seat: default)");
    });
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
