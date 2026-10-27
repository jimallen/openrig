import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import type { Hono } from "hono";
import type { RigRepository } from "../src/domain/rig-repository.js";
import type { RigSpecExporter } from "../src/domain/rigspec-exporter.js";
import { LegacyRigSpecCodec as RigSpecCodec } from "../src/domain/rigspec-codec.js"; // TODO: AS-T08b — migrate to pod-aware RigSpec
import { RigSpecCodec as PodRigSpecCodec } from "../src/domain/rigspec-codec.js";
import { RigSpecSchema as PodRigSpecSchema } from "../src/domain/rigspec-schema.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { migrate } from "../src/db/migrate.js";
import { workspacePrimitiveSchema } from "../src/db/migrations/038_workspace_primitive.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { createDaemon } from "../src/startup.js";
import { RigSpecExporter as RigSpecExporterClass } from "../src/domain/rigspec-exporter.js";
import { RigInstantiator } from "../src/domain/rigspec-instantiator.js";
import { RigSpecPreflight } from "../src/domain/rigspec-preflight.js";
import { RigRepository as RigRepoClass } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import type { ExecFn } from "../src/adapters/tmux.js";

const VALID_YAML = `
schema_version: 1
name: r99
version: 1.0.0
nodes:
  - id: worker
    runtime: claude-code
    role: worker
    cwd: /
edges: []
`;

const INVALID_YAML = `
name: ""
version: ""
nodes: bad
`;

describe("Rigspec export routes", () => {
  let db: Database.Database;
  let app: Hono;
  let rigRepo: RigRepository;

  beforeEach(() => {
    db = createFullTestDb();
    migrate(db, [workspacePrimitiveSchema]);
    const setup = createTestApp(db);
    app = setup.app;
    rigRepo = setup.rigRepo;
  });

  afterEach(() => {
    db.close();
  });

  it("GET /api/rigs/:rigId/spec -> 200 + YAML content-type", async () => {
    const rig = rigRepo.createRig("r99");
    rigRepo.addNode(rig.id, "worker", { runtime: "claude-code" });

    const res = await app.request(`/api/rigs/${rig.id}/spec`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/yaml");
    const text = await res.text();
    expect(text).toContain("r99");
  });

  it("GET /api/rigs/:rigId/spec.json -> 200 + JSON", async () => {
    const rig = rigRepo.createRig("r99");
    rigRepo.addNode(rig.id, "worker", { runtime: "claude-code" });

    const res = await app.request(`/api/rigs/${rig.id}/spec.json`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("r99");
    expect(body.nodes).toHaveLength(1);
  });

  it("GET /api/rigs/:rigId/spec preserves a persisted pod-aware workspace", async () => {
    const rig = rigRepo.createRig("workspace-rig");
    const pod = new PodRepository(db).createPod(rig.id, "dev", "Dev");
    rigRepo.addNode(rig.id, "dev.worker", {
      runtime: "claude-code",
      podId: pod.id,
      agentRef: "local:agents/worker",
      profile: "default",
      cwd: "/workspace/app",
    });
    const workspace: import("../src/domain/types.js").WorkspaceSpec = {
      workspaceRoot: "/workspace",
      repos: [
        { name: "app", path: "/workspace/app", kind: "project" },
        { name: "docs", path: "/workspace/docs", kind: "knowledge" },
      ],
      defaultRepo: "app",
      knowledgeRoot: "/workspace/docs",
    };
    rigRepo.setRigWorkspace(rig.id, workspace);

    const res = await app.request(`/api/rigs/${rig.id}/spec`);
    expect(res.status).toBe(200);
    const parsed = PodRigSpecCodec.parse(await res.text());
    expect(PodRigSpecSchema.validate(parsed).valid).toBe(true);
    expect(PodRigSpecSchema.normalize(parsed as Record<string, unknown>).workspace).toEqual(workspace);
  });

  it("GET nonexistent rig -> 404", async () => {
    const res = await app.request("/api/rigs/nonexistent/spec");
    expect(res.status).toBe(404);
  });

  it("export internal error for corrupted rig -> 500", async () => {
    const rig = rigRepo.createRig("r99");
    // Insert node with no runtime via raw SQL
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES (?, ?, ?)")
      .run("bad-node", rig.id, "broken");

    const res = await app.request(`/api/rigs/${rig.id}/spec`);
    expect(res.status).toBe(500);
  });
});

describe("Rigspec import routes", () => {
  let db: Database.Database;
  let app: Hono;

  beforeEach(() => {
    db = createFullTestDb();
    const setup = createTestApp(db);
    app = setup.app;
  });

  afterEach(() => {
    db.close();
  });

  it("POST /api/rigs/import valid YAML -> 201 + InstantiateResult", async () => {
    const res = await app.request("/api/rigs/import", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: VALID_YAML,
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.rigId).toBeDefined();
    expect(body.specName).toBe("r99");
    expect(body.nodes).toHaveLength(1);
  });

  it("POST /api/rigs/import invalid YAML -> 400", async () => {
    const res = await app.request("/api/rigs/import", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: INVALID_YAML,
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/rigs/import preflight failure -> 409", async () => {
    // Create name collision
    const setup = createTestApp(db);
    setup.rigRepo.createRig("r99");

    const res = await setup.app.request("/api/rigs/import", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: VALID_YAML,
    });
    expect(res.status).toBe(409);
  });

  it("POST /api/rigs/import/validate -> 200 + ValidationResult", async () => {
    const res = await app.request("/api/rigs/import/validate", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: VALID_YAML,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(true);
  });

  it("POST /api/rigs/import/validate invalid YAML -> 400", async () => {
    const res = await app.request("/api/rigs/import/validate", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "not: [valid: yaml: {{{",
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/rigs/import/preflight -> 200 + PreflightResult", async () => {
    const res = await app.request("/api/rigs/import/preflight", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: VALID_YAML,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("ready");
    expect(body).toHaveProperty("errors");
    expect(body).toHaveProperty("warnings");
  });

  it("POST /api/rigs/import/preflight invalid YAML -> 400", async () => {
    const res = await app.request("/api/rigs/import/preflight", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "not: [valid: yaml: {{{",
    });
    expect(res.status).toBe(400);
  });
});

describe("Rigspec wiring", () => {
  it("startup mounts rigspec routes (createDaemon regression)", async () => {
    const tmuxExec: ExecFn = async () => "";
    const cmuxExec: ExecFn = async () => { throw Object.assign(new Error(""), { code: "ENOENT" }); };
    const { app, db, deps } = await createDaemon({ tmuxExec, cmuxExec });
    const rig = deps.rigRepo.createRig("r99");
    deps.rigRepo.addNode(rig.id, "worker", { runtime: "claude-code" });

    const res = await app.request(`/api/rigs/${rig.id}/spec.json`);
    expect(res.status).toBe(200);
    db.close();
  });

  it("createApp throws on mismatched exporter db handle", () => {
    const db1 = createFullTestDb();
    const db2 = createFullTestDb();
    const otherRepo = new RigRepoClass(db2);
    const otherRegistry = new SessionRegistry(db2);
    const badExporter = new RigSpecExporterClass({ rigRepo: otherRepo, sessionRegistry: otherRegistry });

    expect(() => createTestApp(db1, { appDeps: { rigSpecExporter: badExporter } })).toThrow(/rigSpecExporter.*same db handle/);
    db1.close();
    db2.close();
  });

  it("createApp throws on mismatched instantiator db handle", () => {
    const db1 = createFullTestDb();
    const db2 = createFullTestDb();
    expect(() => createTestApp(db1, { appDeps: { rigInstantiator: { db: db2 } as any } })).toThrow(/rigInstantiator.*same db handle/);
    db1.close();
    db2.close();
  });

  it("createApp throws on mismatched preflight db handle", () => {
    const db1 = createFullTestDb();
    const db2 = createFullTestDb();
    expect(() => createTestApp(db1, { appDeps: { rigSpecPreflight: { db: db2 } as any } })).toThrow(/rigSpecPreflight.*same db handle/);
    db1.close();
    db2.close();
  });

  it("startup constructs all Phase 3 deps", async () => {
    const tmuxExec: ExecFn = async () => "";
    const cmuxExec: ExecFn = async () => { throw Object.assign(new Error(""), { code: "ENOENT" }); };
    const { app, db } = await createDaemon({ tmuxExec, cmuxExec });

    // Import route is mounted (proves instantiator + preflight wired)
    const res = await app.request("/api/rigs/import/validate", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: VALID_YAML,
    });
    expect(res.status).toBe(200);
    db.close();
  });

  it("round-trip: export then import produces equivalent rig", async () => {
    const db1 = createFullTestDb();
    const setup = createTestApp(db1);
    const rig = setup.rigRepo.createRig("r99");
    setup.rigRepo.addNode(rig.id, "worker", { runtime: "claude-code", role: "worker" });

    // Export
    const exportRes = await setup.app.request(`/api/rigs/${rig.id}/spec`);
    const yaml = await exportRes.text();

    // Import into fresh app
    const db2 = createFullTestDb();
    const setup2 = createTestApp(db2);
    const importRes = await setup2.app.request("/api/rigs/import", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: yaml,
    });
    expect(importRes.status).toBe(201);
    const body = await importRes.json();
    expect(body.specName).toBe("r99");
    expect(body.nodes).toHaveLength(1);

    db1.close();
    db2.close();
  });
});

const POD_AWARE_YAML = `
version: "0.2"
name: pod-rig
pods:
  - id: dev
    label: Dev
    members:
      - id: impl
        agent_ref: "local:agents/impl"
        profile: default
        runtime: claude-code
        cwd: /tmp
    edges: []
edges: []
`;

const WORKSPACE_ONLY_YAML = `
version: "0.2"
name: workspace-declaration
workspace:
  workspace_root: /workspace
  repos:
    - name: app
      path: app
      kind: project
    - name: docs
      path: /workspace/docs
      kind: knowledge
  default_repo: app
  knowledge_root: /workspace/docs
pods:
  - id: dev
    label: Dev
    members:
      - id: impl
        # Deliberately invalid unrelated topology: workspace-only apply ignores it.
        agent_ref: ""
        profile: none
        runtime: terminal
        cwd: /workspace/app
    edges: []
edges: []
`;

const INVALID_POD_YAML = `
version: "0.2"
name: bad
pods:
  - id: dev
    label: Dev
    members:
      - id: impl
        runtime: claude-code
        cwd: .
    edges: []
edges: []
`;

const MATERIALIZE_POD_YAML = `
version: "0.2"
name: live-topology
pods:
  - id: research
    label: Research
    members:
      - id: scout
        agent_ref: "builtin:terminal"
        profile: none
        runtime: terminal
        cwd: /tmp
    edges: []
edges: []
`;

const MATERIALIZE_RELATIVE_CWD_YAML = `
version: "0.2"
name: cwd-override-topology
pods:
  - id: research
    label: Research
    members:
      - id: scout
        agent_ref: "builtin:terminal"
        profile: none
        runtime: terminal
        cwd: /openrig-install-should-not-be-used
    edges: []
edges: []
`;

const MATERIALIZE_FRAGMENT_YAML = `
version: "0.2"
name: research-fragment
pods:
  - id: research
    label: Research
    members:
      - id: scout
        agent_ref: "builtin:terminal"
        profile: none
        runtime: terminal
        cwd: /tmp
    edges: []
edges:
  - kind: delegates_to
    from: orch.lead
    to: research.scout
`;

describe("Rigspec import routes (pod-aware dual-stack)", () => {
  let db: Database.Database;
  let app: Hono;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;

  beforeEach(() => {
    db = createFullTestDb();
    migrate(db, [workspacePrimitiveSchema]);
    const setup = createTestApp(db);
    app = setup.app;
    rigRepo = setup.rigRepo;
    sessionRegistry = setup.sessionRegistry;
  });

  afterEach(() => {
    db.close();
  });

  // T3: validate endpoint auto-detects pod-aware format
  it("POST /api/rigs/import/validate with pod-aware YAML returns valid:true", async () => {
    const res = await app.request("/api/rigs/import/validate", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: POD_AWARE_YAML,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(true);
  });

  it("POST /api/rigs/import/validate rejects an unknown topology key with its exact path and consequence", async () => {
    const res = await app.request("/api/rigs/import/validate", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: POD_AWARE_YAML.replace('name: pod-rig', 'name: pod-rig\noperating_mod: lab'),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(false);
    expect(body.errors).toContain(
      'operating_mod: unknown key "operating_mod"; refusing the spec because normalization would otherwise discard it and alter the requested topology',
    );
  });

  // T4: validate endpoint with invalid pod-aware YAML returns errors
  it("POST /api/rigs/import/validate with invalid pod-aware YAML returns errors", async () => {
    const res = await app.request("/api/rigs/import/validate", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: INVALID_POD_YAML,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(false);
    expect(body.errors.length).toBeGreaterThan(0);
  });

  // T5: validate still works for legacy YAML
  it("POST /api/rigs/import/validate still works for legacy YAML", async () => {
    const res = await app.request("/api/rigs/import/validate", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: VALID_YAML,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(true);
  });

  // T7: import pod-aware spec without X-Rig-Root returns 400
  it("POST /api/rigs/import with pod-aware YAML but no X-Rig-Root returns 400", async () => {
    const res = await app.request("/api/rigs/import", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: POD_AWARE_YAML,
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("missing_rig_root");
  });

  it("POST /api/rigs/import returns 409 and preserves compose project conflict guidance", async () => {
    const message = "Replacement has multiple predecessor Compose projects (old-a: project-a; old-b: project-b). Set services.project_name in the rig spec YAML to the project you intend to use, then re-run the same command. No services were started.";
    const routeApp = createTestApp(db, {
      appDeps: {
        podInstantiator: {
          db,
          instantiate: async () => ({ ok: false, code: "compose_project_conflict", message }),
        } as never,
      },
    }).app;

    const res = await routeApp.request("/api/rigs/import", {
      method: "POST",
      headers: { "Content-Type": "text/plain", "X-Rig-Root": "/tmp" },
      body: POD_AWARE_YAML,
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("compose_project_conflict");
    expect(body.error).toBe(message);
    expect(body.message).toBe(message);
  });

  // T8: preflight pod-aware spec without X-Rig-Root returns 400
  it("POST /api/rigs/import/preflight with pod-aware YAML but no X-Rig-Root returns 400", async () => {
    const res = await app.request("/api/rigs/import/preflight", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: POD_AWARE_YAML,
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ready).toBe(false);
    expect(body.errors).toContain("X-Rig-Root header required for pod-aware specs");
  });

  // A project rig is launched with `rig up <spec> --cwd <project>`; every other launch path refuses the
  // raw spec (unprojectedProjectRigError). Preflight said ready:true for it, then launch refused.
  const projectRigYaml = (flag: string) => `version: "0.2"\nname: team\n${flag}pods: [{id: dev, label: Dev, members: [{id: shell, agent_ref: "builtin:terminal", runtime: terminal, profile: none, cwd: .}], edges: []}]\nedges: []\n`;
  const preflightProjectRig = (flag: string) => app.request("/api/rigs/import/preflight", {
    method: "POST",
    headers: { "Content-Type": "text/plain", "X-Rig-Root": "/tmp" },
    body: projectRigYaml(flag),
  });

  it("POST /api/rigs/import/preflight refuses an unprojected project_rig spec, as launch does", async () => {
    const res = await preflightProjectRig("project_rig: true\n");
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ready).toBe(false);
    expect(body.errors).toEqual(["team is a project rig: launch it with rig up <spec> --cwd <project folder>."]);
  });

  it("POST /api/rigs/import/preflight still passes the same spec without project_rig (control)", async () => {
    const res = await preflightProjectRig("");
    const body = await res.json();
    expect(body.errors ?? []).toEqual([]);
    expect(body.ready).toBe(true);
  });

  // Invalid pod spec + project_rig: import reports the validation errors first; preflight must too, or the
  // user fixes the project-rig error, then meets the validation errors in a second round.
  it("POST /api/rigs/import/preflight reports an invalid project_rig spec's validation errors, as import does", async () => {
    const invalid = projectRigYaml("project_rig: true\n").replace("agent_ref: \"builtin:terminal\", ", "");
    const headers = { "Content-Type": "text/plain", "X-Rig-Root": "/tmp" };
    const pre = await app.request("/api/rigs/import/preflight", { method: "POST", headers, body: invalid });
    const imp = await app.request("/api/rigs/import", { method: "POST", headers, body: invalid });
    const preBody = await pre.json();
    const impBody = await imp.json();
    expect(imp.status).toBe(400);
    expect(impBody.errors.length).toBeGreaterThan(0);
    expect(impBody.errors.join("\n")).not.toContain("is a project rig");
    expect(preBody.ready).toBe(false);
    expect(preBody.errors).toEqual(impBody.errors);
  });

  // import with X-Cwd-Override does NOT project the spec (only `rig up --cwd` does), so it still refuses;
  // preflight must agree and not green-light the spec merely because a cwd override is present.
  it("a project_rig spec is refused by preflight AND import even with X-Cwd-Override (neither projects)", async () => {
    const headers = { "Content-Type": "text/plain", "X-Rig-Root": "/tmp", "X-Cwd-Override": "/tmp" };
    const pre = await app.request("/api/rigs/import/preflight", { method: "POST", headers, body: projectRigYaml("project_rig: true\n") });
    const preBody = await pre.json();
    expect(preBody.ready).toBe(false);
    expect(preBody.errors).toEqual(["team is a project rig: launch it with rig up <spec> --cwd <project folder>."]);
    const imp = await app.request("/api/rigs/import", { method: "POST", headers, body: projectRigYaml("project_rig: true\n") });
    expect(imp.status).toBe(400);
    expect((await imp.json()).errors).toEqual(preBody.errors);
  });

  it("the missing X-Rig-Root 400 comes before the project_rig refusal", async () => {
    const res = await app.request("/api/rigs/import/preflight", { method: "POST", headers: { "Content-Type": "text/plain" }, body: projectRigYaml("project_rig: true\n") });
    expect(res.status).toBe(400);
    expect((await res.json()).errors).toEqual(["X-Rig-Root header required for pod-aware specs"]);
  });

  // project_rig is a pod-format key (only the pod schema declares it, and only `rig up --cwd` projects it).
  // A legacy flat spec carrying it ignored the flag: preflight ready:true and import launched it unprojected.
  const flatProjectRig = VALID_YAML.replace("name: r99\n", "name: r99\nproject_rig: true\n");
  it("a legacy flat spec with project_rig is refused by preflight AND import, pointing to the pod format", async () => {
    const headers = { "Content-Type": "text/plain" };
    const pre = await app.request("/api/rigs/import/preflight", { method: "POST", headers, body: flatProjectRig });
    const preBody = await pre.json();
    expect(preBody.ready === false || pre.status === 400).toBe(true);
    const preErrors = preBody.errors as string[];
    expect(preErrors.join("\n")).toMatch(/project_rig.*pod/);
    const imp = await app.request("/api/rigs/import", { method: "POST", headers, body: flatProjectRig });
    expect(imp.status).toBe(400);
    expect((await imp.json()).errors).toEqual(preErrors);
    expect(rigRepo.findRigsByName("r99")).toHaveLength(0);
  });

  // Position of the flat check relative to normalize: an invalid flat spec reports its own error first
  // (as the pod routes report validation errors before the project-rig refusal); import and preflight agree.
  it("an invalid legacy flat spec with project_rig reports the spec's own error, not the project_rig refusal", async () => {
    const invalid = INVALID_YAML.replace("name: \"\"\n", "name: r99\nproject_rig: true\n");
    const headers = { "Content-Type": "text/plain" };
    const pre = await app.request("/api/rigs/import/preflight", { method: "POST", headers, body: invalid });
    const imp = await app.request("/api/rigs/import", { method: "POST", headers, body: invalid });
    const preBody = await pre.json();
    const impBody = await imp.json();
    expect(imp.status).toBe(400);
    expect(impBody.errors.join("\n")).not.toMatch(/project_rig/);
    expect(preBody.errors.join("\n")).not.toMatch(/project_rig/);
    expect(preBody.errors).toEqual(impBody.errors);
  });

  it("a legacy flat spec without project_rig, or with project_rig: false, still passes preflight (control)", async () => {
    for (const body of [VALID_YAML, VALID_YAML.replace("name: r99\n", "name: r99\nproject_rig: false\n")]) {
      const pre = await app.request("/api/rigs/import/preflight", { method: "POST", headers: { "Content-Type": "text/plain" }, body });
      const preBody = await pre.json();
      expect(preBody.errors ?? []).toEqual([]);
    }
  });

  // T9: legacy import still works through dual-stack
  it("POST /api/rigs/import with legacy YAML still creates rig", async () => {
    const res = await app.request("/api/rigs/import", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: VALID_YAML,
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.rigId).toBeDefined();
    expect(body.specName).toBe("r99");
  });

  it("POST /api/rigs/import/workspace changes only workspace_json and is idempotent", async () => {
    const rig = rigRepo.createRig("host-rig");
    const pod = new PodRepository(db).createPod(rig.id, "dev", "Dev");
    const node = rigRepo.addNode(rig.id, "dev.impl", {
      runtime: "terminal",
      podId: pod.id,
      agentRef: "builtin:terminal",
      profile: "none",
      cwd: "/workspace/app",
    });
    sessionRegistry.registerSession(node.id, "dev-impl@host-rig");
    sessionRegistry.updateBinding(node.id, { attachmentType: "tmux", tmuxSession: "dev-impl@host-rig" });

    const topology = () => ({
      pods: db.prepare("SELECT * FROM pods WHERE rig_id = ? ORDER BY id").all(rig.id),
      nodes: db.prepare("SELECT * FROM nodes WHERE rig_id = ? ORDER BY id").all(rig.id),
      edges: db.prepare("SELECT * FROM edges WHERE rig_id = ? ORDER BY id").all(rig.id),
      sessions: db.prepare("SELECT s.* FROM sessions s JOIN nodes n ON n.id = s.node_id WHERE n.rig_id = ? ORDER BY s.id").all(rig.id),
      bindings: db.prepare("SELECT b.* FROM bindings b JOIN nodes n ON n.id = b.node_id WHERE n.rig_id = ? ORDER BY b.id").all(rig.id),
    });
    const before = topology();

    const first = await app.request("/api/rigs/import/workspace", {
      method: "POST",
      headers: { "Content-Type": "text/yaml", "X-Target-Rig-Id": rig.id },
      body: WORKSPACE_ONLY_YAML,
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ rigId: rig.id, changed: true });
    expect(topology()).toEqual(before);
    expect(rigRepo.getRigWorkspace(rig.id)).toEqual({
      workspaceRoot: "/workspace",
      repos: [
        { name: "app", path: "/workspace/app", kind: "project" },
        { name: "docs", path: "/workspace/docs", kind: "knowledge" },
      ],
      defaultRepo: "app",
      knowledgeRoot: "/workspace/docs",
    });
    const afterFirst = db.prepare("SELECT workspace_json, updated_at FROM rigs WHERE id = ?").get(rig.id);

    const second = await app.request("/api/rigs/import/workspace", {
      method: "POST",
      headers: { "Content-Type": "text/yaml", "X-Target-Rig-Id": rig.id },
      body: WORKSPACE_ONLY_YAML,
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ rigId: rig.id, changed: false });
    expect(db.prepare("SELECT workspace_json, updated_at FROM rigs WHERE id = ?").get(rig.id)).toEqual(afterFirst);
    expect(topology()).toEqual(before);

    const exported = await app.request(`/api/rigs/${rig.id}/spec`);
    expect(exported.status).toBe(200);
    expect(PodRigSpecSchema.normalize(PodRigSpecCodec.parse(await exported.text()) as Record<string, unknown>).workspace)
      .toEqual(rigRepo.getRigWorkspace(rig.id));
  });

  it("POST /api/rigs/import/workspace fails before mutation for invalid input or target", async () => {
    const rig = rigRepo.createRig("host-rig");
    const original = {
      workspaceRoot: "/original",
      repos: [{ name: "original", path: "/original", kind: "project" as const }],
      defaultRepo: "original",
    };
    rigRepo.setRigWorkspace(rig.id, original);
    const preimage = db.prepare("SELECT workspace_json, updated_at FROM rigs WHERE id = ?").get(rig.id);

    const invalidDefault = await app.request("/api/rigs/import/workspace", {
      method: "POST",
      headers: { "Content-Type": "text/yaml", "X-Target-Rig-Id": rig.id },
      body: WORKSPACE_ONLY_YAML.replace("default_repo: app", "default_repo: missing"),
    });
    expect(invalidDefault.status).toBe(400);
    expect(await invalidDefault.json()).toMatchObject({ code: "validation_failed" });

    const invalidRepo = await app.request("/api/rigs/import/workspace", {
      method: "POST",
      headers: { "Content-Type": "text/yaml", "X-Target-Rig-Id": rig.id },
      body: WORKSPACE_ONLY_YAML.replace("kind: project", "kind: executable"),
    });
    expect(invalidRepo.status).toBe(400);
    expect(await invalidRepo.json()).toMatchObject({ code: "validation_failed" });

    const missingWorkspace = await app.request("/api/rigs/import/workspace", {
      method: "POST",
      headers: { "Content-Type": "text/yaml", "X-Target-Rig-Id": rig.id },
      body: POD_AWARE_YAML,
    });
    expect(missingWorkspace.status).toBe(400);
    expect(await missingWorkspace.json()).toMatchObject({ code: "workspace_required" });

    const missingTarget = await app.request("/api/rigs/import/workspace", {
      method: "POST",
      headers: { "Content-Type": "text/yaml" },
      body: WORKSPACE_ONLY_YAML,
    });
    expect(missingTarget.status).toBe(400);
    expect(await missingTarget.json()).toMatchObject({ code: "target_rig_required" });

    const unknownTarget = await app.request("/api/rigs/import/workspace", {
      method: "POST",
      headers: { "Content-Type": "text/yaml", "X-Target-Rig-Id": "missing" },
      body: WORKSPACE_ONLY_YAML,
    });
    expect(unknownTarget.status).toBe(404);
    expect(await unknownTarget.json()).toMatchObject({ code: "target_rig_not_found" });

    expect(db.prepare("SELECT workspace_json, updated_at FROM rigs WHERE id = ?").get(rig.id)).toEqual(preimage);
    expect(rigRepo.listRigs()).toHaveLength(1);
  });

  it("POST /api/rigs/import/materialize creates rig structure without launching", async () => {
    const res = await app.request("/api/rigs/import/materialize", {
      method: "POST",
      headers: { "Content-Type": "text/plain", "X-Rig-Root": "/tmp" },
      body: MATERIALIZE_POD_YAML,
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.rigId).toBeDefined();
    expect(body.nodes).toEqual([{ logicalId: "research.scout", status: "materialized" }]);
  });

  it("POST /api/rigs/import/materialize honors X-Cwd-Override", async () => {
    const setup = createTestApp(db);
    const res = await setup.app.request("/api/rigs/import/materialize", {
      method: "POST",
      headers: { "Content-Type": "text/plain", "X-Rig-Root": "/tmp", "X-Cwd-Override": "/tmp" },
      body: MATERIALIZE_RELATIVE_CWD_YAML,
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    const rig = setup.rigRepo.getRig(body.rigId);
    expect(rig?.nodes.find((node) => node.logicalId === "research.scout")?.cwd).toBe("/tmp");
  });

  it("POST /api/rigs/import/materialize can target an existing rig", async () => {
    const setup = createTestApp(db);
    const rig = setup.rigRepo.createRig("host-rig");
    setup.rigRepo.addNode(rig.id, "orch.lead", { runtime: "claude-code", cwd: "/tmp" });

    const res = await setup.app.request("/api/rigs/import/materialize", {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "X-Rig-Root": "/tmp",
        "X-Target-Rig-Id": rig.id,
      },
      body: MATERIALIZE_FRAGMENT_YAML,
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.rigId).toBe(rig.id);
    expect(body.nodes).toEqual([{ logicalId: "research.scout", status: "materialized" }]);
  });
});
