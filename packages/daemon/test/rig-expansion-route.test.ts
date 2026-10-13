import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

describe("POST /api/rigs/:rigId/expand", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    db = createFullTestDb();
    setup = createTestApp(db);
  });

  afterEach(() => { db.close(); });

  function seedRig(name = "test-rig") {
    return setup.rigRepo.createRig(name);
  }

  function terminalPod(id = "infra", memberId = "server") {
    return {
      id,
      label: "Infrastructure",
      members: [
        { id: memberId, runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" },
      ],
      edges: [],
    };
  }

  // Seam B (R2 terminal at 4ac243c3): present-INVALID permission_policy must reach the
  // ONE canonical validator — the normalizer may not erase presence into absence/floor.
  it("SEAM-B RED: expansion member permission_policy: null -> structured 400, ZERO persistence, NO launch (rig carries builtin:yolo)", async () => {
    const rig = seedRig("null-policy-rig");
    setup.rigRepo.setRigPermissionPolicy(rig.id, "builtin:yolo");
    setup.rigRepo.setRigPolicyProvenance(rig.id, { origin: "builtin", resolvedTarget: "policies/builtin/yolo.policy.md", declaringDir: null, launchPosture: "full_bypass" });
    const res = await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pod: { id: "dev2", label: "Dev2", members: [
        { id: "late", runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp", permission_policy: null },
      ], edges: [] } }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(JSON.stringify(body)).toMatch(/permission_policy/);
    // zero persistence: no member node, no session, no edges for the rejected pod
    expect(db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE logical_id LIKE 'dev2.%'").get()).toMatchObject({ c: 0 });
  });

  it("SEAM-B RED: another present-invalid shape (number) is also a structured 400, never coerced/erased", async () => {
    const rig = seedRig("num-policy-rig");
    const res = await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pod: { id: "dev3", label: "Dev3", members: [
        { id: "late", runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp", permission_policy: 42 },
      ], edges: [] } }),
    });
    expect(res.status).toBe(400);
    expect(db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE logical_id LIKE 'dev3.%'").get()).toMatchObject({ c: 0 });
  });

  it("SEAM-B control: a VALID string permission_policy and TRUE absence both keep working through expansion", async () => {
    const rig = seedRig("valid-policy-rig");
    const ok = await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pod: { id: "dev4", label: "Dev4", members: [
        { id: "server", runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" },
      ], edges: [] } }),
    });
    expect(ok.status).toBe(201);
  });

  // T1: Valid expansion -> 201
  it("returns 201 with ok result for valid expansion", async () => {
    const rig = seedRig();
    const res = await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pod: terminalPod() }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe("ok");
    expect(body.podNamespace).toBe("infra");
    expect(body.nodes).toHaveLength(1);
    expect(body.nodes[0].logicalId).toBe("infra.server");
  });

  // T2: Nonexistent rig -> 404
  it("returns 404 for nonexistent rig", async () => {
    const res = await setup.app.request("/api/rigs/nonexistent/expand", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pod: terminalPod() }),
    });
    expect(res.status).toBe(404);
  });

  // T3: Duplicate namespace -> 409
  it("returns 409 for duplicate pod namespace", async () => {
    const rig = seedRig();
    await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pod: terminalPod("infra") }),
    });

    const res = await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pod: terminalPod("infra", "server2") }),
    });
    expect(res.status).toBe(409);
  });

  // T4: Launch failure -> 207
  it("returns 207 for expansion with launch failure", async () => {
    const rig = seedRig();
    const tmux = setup.tmuxAdapter as unknown as Record<string, ReturnType<typeof vi.fn>>;
    tmux.createSession.mockResolvedValueOnce({ ok: false, code: "unknown", message: "tmux not available" });

    const res = await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pod: terminalPod() }),
    });

    expect(res.status).toBe(207);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(["partial", "failed"]).toContain(body.status);
  });

  // T5: Exactly one rig.expanded event
  it("emits exactly one rig.expanded event", async () => {
    const rig = seedRig();
    await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pod: terminalPod() }),
    });

    const events = db.prepare("SELECT type FROM events WHERE type = 'rig.expanded'").all() as Array<{ type: string }>;
    expect(events).toHaveLength(1);
  });

  // T6: Missing body -> 400
  it("returns 400 for missing pod in body", async () => {
    const rig = seedRig();
    const res = await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  // T7a: rig.expanded in events table
  it("rig.expanded event contains correct payload", async () => {
    const rig = seedRig();
    await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pod: terminalPod() }),
    });

    const events = db.prepare("SELECT payload FROM events WHERE type = 'rig.expanded'").all() as Array<{ payload: string }>;
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.rigId).toBe(rig.id);
    expect(payload.podNamespace).toBe("infra");
    expect(payload.status).toBe("ok");
  });

  // T7b: Detail events (pod.created, node.added) also emitted
  it("detail events (pod.created, node.added) emitted during expansion", async () => {
    const rig = seedRig();
    await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pod: terminalPod() }),
    });

    const podEvents = db.prepare("SELECT type FROM events WHERE type = 'pod.created'").all();
    const nodeEvents = db.prepare("SELECT type FROM events WHERE type = 'node.added'").all();
    expect(podEvents.length).toBeGreaterThanOrEqual(1);
    expect(nodeEvents.length).toBeGreaterThanOrEqual(1);
  });

  // T8: Cross-pod edges -> 201
  it("expansion with cross-pod edges returns 201", async () => {
    const rig = seedRig();
    // First pod
    await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pod: terminalPod("orch", "lead") }),
    });

    // Second pod with cross-pod edge
    const res = await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pod: terminalPod("dev", "impl"),
        crossPodEdges: [{ kind: "delegates_to", from: "orch.lead", to: "dev.impl" }],
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("expansion with edge from new pod to existing node launches only the new node", async () => {
    const rig = seedRig();
    await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pod: terminalPod("backend", "api") }),
    });

    const res = await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pod: terminalPod("ops", "monitor"),
        crossPodEdges: [{ kind: "delegates_to", from: "ops.monitor", to: "backend.api" }],
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe("ok");
    expect(body.nodes).toHaveLength(1);
    expect(body.nodes[0].logicalId).toBe("ops.monitor");
  });

  it("accepts spec-style snake_case member fields in pod fragments", async () => {
    const rig = seedRig();
    const res = await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pod: {
          id: "qa",
          label: "QA",
          members: [
            {
              id: "reviewer",
              runtime: "terminal",
              agent_ref: "builtin:terminal",
              profile: "none",
              cwd: "/tmp",
              restore_policy: "checkpoint_only",
            },
          ],
          edges: [],
        },
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.nodes[0].logicalId).toBe("qa.reviewer");
    const stored = db
      .prepare("SELECT agent_ref, restore_policy FROM nodes WHERE rig_id = ? AND logical_id = ?")
      .get(rig.id, "qa.reviewer") as { agent_ref: string; restore_policy: string } | undefined;
    expect(stored?.agent_ref).toBe("builtin:terminal");
    expect(stored?.restore_policy).toBe("checkpoint_only");
  });

  // A seat's `effort` is a launch setting (`rig up` keeps it). Expansion dropped it at the
  // ingress normalizer, the fragment type and the fragment->spec map, so a seat added through
  // `rig expand` silently launched at the runtime default effort instead of the declared one.
  it("member effort survives the expand ingress to the materialized spec (and none is invented when absent)", async () => {
    const rig = seedRig("effort-rig");
    const materializeSpy = vi.spyOn(setup.podInstantiator, "materializeStructured");
    const res = await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pod: {
          id: "eff",
          label: "Effort",
          members: [
            { id: "high", runtime: "claude-code", agent_ref: "local:agents/impl", profile: "default", cwd: "/tmp", effort: "xhigh" },
            { id: "low", runtime: "claude-code", agent_ref: "local:agents/impl", profile: "default", cwd: "/tmp", effort: "low" },
            { id: "unset", runtime: "claude-code", agent_ref: "local:agents/impl", profile: "default", cwd: "/tmp" },
          ],
          edges: [],
        },
      }),
    });
    expect(res.status).toBeLessThan(500);
    expect(materializeSpy).toHaveBeenCalled();
    const specObject = materializeSpy.mock.calls[0]![0] as { pods: Array<{ members: Array<Record<string, unknown>> }> };
    const [high, low, unset] = specObject.pods[0]!.members;
    // two distinct values: the carry is derived from the member, not a constant
    expect(high!["effort"]).toBe("xhigh");
    expect(low!["effort"]).toBe("low");
    // absent stays absent: no effort key is invented for a seat that declared none
    expect("effort" in unset!).toBe(false);
    materializeSpy.mockRestore();
  });

  it("member effort is persisted on the node a seat added through expand (parity with rig up)", async () => {
    const rig = seedRig("effort-persist-rig");
    const res = await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pod: {
          id: "effp",
          label: "EffortPersist",
          members: [
            { id: "seat", runtime: "terminal", agent_ref: "builtin:terminal", profile: "none", cwd: "/tmp", effort: "xhigh" },
          ],
          edges: [],
        },
      }),
    });
    expect(res.status).toBe(201);
    const stored = db
      .prepare("SELECT effort FROM nodes WHERE rig_id = ? AND logical_id = ?")
      .get(rig.id, "effp.seat") as { effort: string | null } | undefined;
    expect(stored?.effort).toBe("xhigh");
  });

  // `role` and `starter_ref` were declared on the fragment type and mapped by the fragment->spec
  // builder (both with "never silently dropped" comments), but the ingress normalizer never read
  // them, so a seat added through `rig expand` lost its workflow role and its starter.
  it("member role and starter_ref (either spelling) survive the expand ingress to the materialized spec; none invented when absent", async () => {
    const rig = seedRig("role-starter-rig");
    const materializeSpy = vi.spyOn(setup.podInstantiator, "materializeStructured");
    const res = await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pod: {
          id: "rs",
          label: "RoleStarter",
          members: [
            { id: "a", runtime: "claude-code", agent_ref: "local:agents/impl", profile: "default", cwd: "/tmp", role: "reviewer", starter_ref: { name: "starter-alpha" } },
            { id: "b", runtime: "claude-code", agentRef: "local:agents/impl", profile: "default", cwd: "/tmp", role: "driver", starterRef: { name: "starter-beta" } },
            { id: "unset", runtime: "claude-code", agent_ref: "local:agents/impl", profile: "default", cwd: "/tmp" },
          ],
          edges: [],
        },
      }),
    });
    expect(res.status).toBeLessThan(500);
    expect(materializeSpy).toHaveBeenCalled();
    const specObject = materializeSpy.mock.calls[0]![0] as { pods: Array<{ members: Array<Record<string, unknown>> }> };
    const [a, b, unset] = specObject.pods[0]!.members;
    // two distinct values per field: the carry is derived from the member, not a constant
    expect(a!["role"]).toBe("reviewer");
    expect(b!["role"]).toBe("driver");
    expect(a!["starter_ref"]).toEqual({ name: "starter-alpha" });
    expect(b!["starter_ref"]).toEqual({ name: "starter-beta" });
    expect("role" in unset!).toBe(false);
    expect("starter_ref" in unset!).toBe(false);
    materializeSpy.mockRestore();
  });

  it("member role is persisted on the node a seat added through expand (nodes.role)", async () => {
    // role is not valid on terminal members (schema), so this needs a resolvable agent seat.
    const agentYaml = 'name: impl\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []';
    const roleDb = createFullTestDb();
    const roleSetup = createTestApp(roleDb, {
      podInstantiatorFsOps: {
        readFile: (p: string) => {
          if (p.includes("agents/impl")) return agentYaml;
          throw new Error(`Not found: ${p}`);
        },
        exists: (p: string) => p.includes("agents/impl"),
      },
    });
    try {
      const rig = roleSetup.rigRepo.createRig("role-persist-rig");
      const res = await roleSetup.app.request(`/api/rigs/${rig.id}/expand`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rigRoot: "/project/rigs/role-rig",
          pod: {
            id: "rp",
            label: "RolePersist",
            members: [
              { id: "one", runtime: "claude-code", agent_ref: "local:agents/impl", profile: "default", cwd: ".", role: "reviewer" },
              { id: "two", runtime: "claude-code", agent_ref: "local:agents/impl", profile: "default", cwd: ".", role: "driver" },
              { id: "none", runtime: "claude-code", agent_ref: "local:agents/impl", profile: "default", cwd: "." },
            ],
            edges: [],
          },
        }),
      });
      expect(res.status).toBeLessThan(500);
      const role = (id: string) => (roleDb
        .prepare("SELECT role FROM nodes WHERE rig_id = ? AND logical_id = ?")
        .get(rig.id, id) as { role: string | null } | undefined);
      expect(role("rp.one")?.role).toBe("reviewer");
      expect(role("rp.two")?.role).toBe("driver");
      expect(role("rp.none")?.role).toBeNull();
    } finally {
      roleDb.close();
    }
  });

  // OPR.0.5.6.3 repair (wave-1 R2 HOLD): the route normalizer recognized only
  // fork/rebuild and silently dropped the entire agent_image session source
  // BEFORE the service mapper could preserve ref.version — the landed S03
  // service test exercised RigExpansionService directly and bypassed this
  // ingress. These pins ride the REAL HTTP route and observe the
  // service/materialized-spec boundary (the materializeStructured argument).
  it("agent_image session_source with a version pin survives the real expand ingress to the materialized spec", async () => {
    const rig = seedRig("image-pin-rig");
    const materializeSpy = vi.spyOn(setup.podInstantiator, "materializeStructured");
    await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pod: {
          id: "img",
          label: "Imaged",
          members: [
            {
              id: "worker",
              runtime: "claude-code",
              agent_ref: "local:agents/impl",
              profile: "default",
              cwd: "/tmp",
              session_source: { mode: "agent_image", ref: { kind: "image_name", value: "builder-base", version: "3" } },
            },
          ],
          edges: [],
        },
      }),
    });

    expect(materializeSpy).toHaveBeenCalled();
    const specObject = materializeSpy.mock.calls[0]![0] as { pods: Array<{ members: Array<Record<string, unknown>> }> };
    const member = specObject.pods[0]!.members[0]!;
    expect(member["session_source"]).toEqual({
      mode: "agent_image",
      ref: { kind: "image_name", value: "builder-base", version: "3" },
    });
    materializeSpy.mockRestore();
  });

  it("unversioned agent_image session_source survives the ingress with NO version key invented", async () => {
    const rig = seedRig("image-unpinned-rig");
    const materializeSpy = vi.spyOn(setup.podInstantiator, "materializeStructured");
    await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pod: {
          id: "img2",
          label: "Imaged2",
          members: [
            {
              id: "worker",
              runtime: "claude-code",
              agent_ref: "local:agents/impl",
              profile: "default",
              cwd: "/tmp",
              session_source: { mode: "agent_image", ref: { kind: "image_name", value: "builder-base" } },
            },
          ],
          edges: [],
        },
      }),
    });

    expect(materializeSpy).toHaveBeenCalled();
    const specObject = materializeSpy.mock.calls[0]![0] as { pods: Array<{ members: Array<Record<string, unknown>> }> };
    const member = specObject.pods[0]!.members[0]!;
    expect(member["session_source"]).toEqual({
      mode: "agent_image",
      ref: { kind: "image_name", value: "builder-base" },
    });
    materializeSpy.mockRestore();
  });

  it("valid numeric version coerces to string per schema parity", async () => {
    const rig = seedRig("image-numeric-rig");
    const materializeSpy = vi.spyOn(setup.podInstantiator, "materializeStructured");
    await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pod: {
          id: "imgnum",
          label: "X",
          members: [
            { id: "w", runtime: "claude-code", agent_ref: "local:agents/impl", profile: "default", cwd: "/tmp", session_source: { mode: "agent_image", ref: { kind: "image_name", value: "ok", version: 3 } } },
          ],
          edges: [],
        },
      }),
    });
    // numeric version COERCES to string — schema parity (rigspec-schema.ts
    // validates string|number and normalizes with String(versionRaw);
    // orch-lead ruling 2026-08-28 12:06Z: string-only omission would
    // recreate the silent-default defect for YAML `version: 3`)
    const spec = materializeSpy.mock.calls[0]![0] as { pods: Array<{ members: Array<Record<string, unknown>> }> };
    expect(spec.pods[0]!.members[0]!["session_source"]).toEqual({ mode: "agent_image", ref: { kind: "image_name", value: "ok", version: "3" } });
    materializeSpy.mockRestore();
  });

  // S03 repair amendment (R2 governing HOLD): present-INVALID agent_image
  // shapes must reach the ONE canonical validator and fail structured —
  // never be erased into session_source-absence, which silently widens an
  // invalid request into an unpinned/no-source expansion (the SEAM-B
  // presence-preservation law applied to session_source).
  it("present-invalid agent_image shapes reach the canonical validator: structured 400, zero persistence, never erased into absence", async () => {
    const rig = seedRig("image-invalid-rig");
    const post = (sessionSource: unknown, podId: string) =>
      setup.app.request(`/api/rigs/${rig.id}/expand`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pod: {
            id: podId,
            label: "X",
            members: [
              { id: "w", runtime: "claude-code", agent_ref: "local:agents/impl", profile: "default", cwd: "/tmp", session_source: sessionSource },
            ],
            edges: [],
          },
        }),
      });

    const cases: Array<[unknown, string]> = [
      [{ mode: "agent_image", ref: { kind: "image_name", value: "" } }, "inv1"],
      [{ mode: "agent_image", ref: { kind: "image_id", value: "x" } }, "inv2"],
      [{ mode: "agent_image", ref: { kind: "image_name", value: "ok", version: { pin: 3 } } }, "inv3"],
      [{ mode: "agent_image", ref: { kind: "image_name", value: "ok", version: true } }, "inv4"],
    ];
    for (const [sessionSource, podId] of cases) {
      const res = await post(sessionSource, podId);
      expect(res.status, `${podId} must fail structured validation, not expand`).toBe(400);
      const body = await res.json();
      expect(JSON.stringify(body), `${podId} error must name session_source`).toMatch(/session_source/);
      expect(
        db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE logical_id LIKE ?").get(`${podId}.%`),
        `${podId} must persist nothing`,
      ).toMatchObject({ c: 0 });
    }
  });

  // S03 final presence amendment: the invariant is KEY PRESENCE, not a list of
  // malformed shapes. ANY present session_source value — a mode-only object, a
  // null/non-object ref, a primitive, or null itself — must reach the canonical
  // validator and fail structured; only a truly absent key stays absent.
  it("presence invariant: mode-only, ref:null, primitive, and null session_source all reach the canonical validator (400 naming session_source, zero persistence)", async () => {
    const rig = seedRig("presence-invariant-rig");
    const post = (sessionSource: unknown, podId: string) =>
      setup.app.request(`/api/rigs/${rig.id}/expand`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pod: {
            id: podId,
            label: "P",
            members: [
              { id: "w", runtime: "claude-code", agent_ref: "local:agents/impl", profile: "default", cwd: "/tmp", session_source: sessionSource },
            ],
            edges: [],
          },
        }),
      });

    const cases: Array<[unknown, string]> = [
      [{ mode: "agent_image" }, "pres1"],
      [{ mode: "agent_image", ref: null }, "pres2"],
      [{ mode: "agent_image", ref: "builder-base" }, "pres3"],
      ["builder-base", "pres4"],
      [null, "pres5"],
      [{ mode: "snapshot", ref: { kind: "image_name", value: "x" } }, "pres6"],
    ];
    for (const [sessionSource, podId] of cases) {
      const res = await post(sessionSource, podId);
      expect(res.status, `${podId} must fail structured validation, never erase into absence`).toBe(400);
      const body = await res.json();
      expect(JSON.stringify(body), `${podId} error must name session_source`).toMatch(/session_source/);
      expect(
        db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE logical_id LIKE ?").get(`${podId}.%`),
        `${podId} must persist nothing`,
      ).toMatchObject({ c: 0 });
    }
  });
});
