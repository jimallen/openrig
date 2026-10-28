// OF-163: every route that shows a restore plan forecasts a seat whose adopted session rig down left running as the reattach
// restore does (adopted-reattach.ts, through readPreviewReattach). Each row goes through the route's own wiring.
// Deployed entrypoint: server.ts mounts routes/rigs.ts at /api/rigs and routes/startup.ts at /api/startup.
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

describe("plan routes forecast the reattach of an adopted session rig down left running (OF-163)", () => {
  let db: Database.Database;
  afterEach(() => db?.close());

  function adoptedSeatAfterDown() {
    db = createFullTestDb();
    const setup = createTestApp(db);
    const rig = setup.rigRepo.createRig("plan-adopted-rig");
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { role: "worker", runtime: "claude-code" });
    const session = setup.sessionRegistry.registerSession(node.id, "dev-impl@plan-adopted-rig");
    db.prepare("UPDATE sessions SET origin = 'claimed', status = 'running' WHERE id = ?").run(session.id);
    setup.sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-impl@plan-adopted-rig", tmuxPane: "%3" });
    setup.snapshotCapture.captureSnapshot(rig.id, "auto-pre-down");
    setup.sessionRegistry.updateStatus(session.id, "detached"); // as rig down leaves an adopted session (OF-155)
    return { setup, rigId: rig.id, sessionId: session.id };
  }
  const REASON = "reattaches its adopted session dev-impl@plan-adopted-rig, which rig down left running; nothing is started (if that session has ended by then, restore goes the ordinary way)";
  const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  it.each([
    ["POST /api/rigs/:id/up (plan)", (id: string) => [`/api/rigs/${id}/up`, post({ plan: true })] as const, (body: { nodes: unknown[] }) => body.nodes[0]],
    ["POST /api/rigs/:id/launch-plan", (id: string) => [`/api/rigs/${id}/launch-plan`, post({ logicalIds: ["dev.impl"] })] as const, (body: { nodes: unknown[] }) => body.nodes[0]],
    ["GET /api/startup/:rigId", (id: string) => [`/api/startup/${id}`, undefined] as const, (body: { seats: unknown[] }) => body.seats[0]],
  ] as const)("%s names the reattach", async (_label, request, seatOf) => {
    const { setup, rigId, sessionId } = adoptedSeatAfterDown();
    const [path, init] = request(rigId);

    const res = await setup.app.request(path, init);

    expect(res.status).toBe(200);
    expect(seatOf(await res.json())).toMatchObject({ intendedAction: "resume-original", reattach: { sessionId, sessionName: "dev-impl@plan-adopted-rig" }, reason: REASON, freshRequired: false });
  });

  it("GET /api/rigs/:id/status words the seat as the reattach", async () => {
    const { setup, rigId } = adoptedSeatAfterDown();

    const res = await setup.app.request(`/api/rigs/${rigId}/status`);

    expect(res.status).toBe(200);
    expect((await res.json()).perSeat[0]).toMatchObject({ intendedAction: "resume-original", reason: REASON, freshRequired: false });
  });
});
