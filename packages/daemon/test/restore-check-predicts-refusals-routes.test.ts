// The route wiring of the refusal prediction: `POST /api/up` with plan:true and `GET /api/restore-check?fresh=...` ask
// the functions RestoreOrchestrator calls (the agreement table in restore-check-predicts-refusals.test.ts proves they
// agree with a real restore; this file proves the deployed routes actually use them).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

describe("refusal prediction through the routes", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    db = createFullTestDb();
    setup = createTestApp(db, { wireRuntimeAdapters: true });
    const rig = setup.rigRepo.createRig("pred-rig");
    const node = setup.rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: "claude-code" });
    // A rig whose recorded spec source no longer exists: a seat listed with --fresh is refused, one that is not is not.
    setup.rigRepo.setRigSpecSource(rig.id, "/nonexistent-of32/rig.yaml");
    const session = setup.sessionRegistry.registerSession(node.id, "worker@pred-rig");
    db.prepare("UPDATE sessions SET resume_type = ?, resume_token = ?, status = ? WHERE id = ?").run("claude_name", "tok-1", "running", session.id);
    setup.snapshotCapture.captureSnapshot(rig.id, "auto-pre-down");
    setup.sessionRegistry.updateStatus(session.id, "detached");
  });

  afterEach(() => db.close());

  const plan = (extra: Record<string, unknown>) => setup.app.request("/api/up", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourceRef: "pred-rig", plan: true, ...extra }),
  });

  it("`rig up --existing --fresh <seat> --plan` names the refusal restore would give, and mutates nothing", async () => {
    const restoreSpy = vi.spyOn(setup.restoreOrchestrator, "restore");
    const sessionsBefore = db.prepare("SELECT * FROM sessions ORDER BY id").all();

    const res = await plan({ freshLogicalIds: ["worker"] });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mutated).toBe(false);
    expect(body.nodes[0].logicalId).toBe("worker");
    expect(body.nodes[0].wouldRefuse).toContain("/nonexistent-of32/rig.yaml");
    expect(body.nodes[0].wouldRefuse).toContain("the file (or a link on its path) no longer exists");
    expect(body.refusalPredictionError).toBeUndefined();
    expect(restoreSpy).not.toHaveBeenCalled();
    expect(db.prepare("SELECT * FROM sessions ORDER BY id").all()).toEqual(sessionsBefore);
  });

  it("the same plan with `--startup-from stored` names no refusal: the seat has no spec read to fail", async () => {
    // The seat has no saved startup context in this fixture, so the stored source falls back to the snapshot's copy.
    const body = await (await plan({ freshLogicalIds: ["worker"], startupFrom: "stored" })).json();

    expect(body.nodes[0].wouldRefuse).toBeUndefined();
  });

  it("a plan that lists no seat names no refusal", async () => {
    const body = await (await plan({})).json();

    expect(body.nodes[0].wouldRefuse).toBeUndefined();
  });

  it("GET /api/restore-check?fresh=<seat> is red with the refusal; without fresh it is not", async () => {
    const listed = await (await setup.app.request("/api/restore-check?rig=pred-rig&noQueue=true&noHooks=true&fresh=worker")).json();
    const plain = await (await setup.app.request("/api/restore-check?rig=pred-rig&noQueue=true&noHooks=true")).json();

    const pre = (result: { checks: Array<{ check: string; status: string; evidence: string }> }) => result.checks.find((c) => c.check === "rig.pred-rig.restore-preconditions")!;
    expect(pre(listed).status).toBe("red");
    expect(pre(listed).evidence).toContain("fresh_start_refused: Fresh start refused for worker:");
    expect(pre(listed).evidence).toContain("the file (or a link on its path) no longer exists");
    expect(pre(plain).evidence).not.toContain("fresh_start_refused");
  });

  it("GET /api/restore-check rejects a --startup-from it does not know", async () => {
    const res = await setup.app.request("/api/restore-check?fresh=worker&startupFrom=latest");

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invalid_startup_from" });
  });
});
