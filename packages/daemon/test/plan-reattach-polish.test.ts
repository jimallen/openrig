// Unit a2 (wave 7): the restore plan and rig status around an adopted session rig down left running (OF-155/OF-163).
// - OF-171: POST /api/rigs/:id/up {plan:true} forecasts the --fresh list it restores with, as POST /api/up does.
// - z6 review F4: GET /api/rigs/:id/status carries the reattach as a field, and counts it as itself.
// - z2 review F5: a seat whose adopted session another seat's live row also names is not reattached by name: restore fails
//   it (adopted_session_contested) and starts nothing, and the plan, the startup forecast and restore-check say so.
// - z6 review F5: the reattach rule (created_at, then id) and the handover's departing row (id) pick the same row when
//   two rows share a created_at second.
// Deployed entrypoints: server.ts mounts routes/rigs.ts at /api/rigs, routes/startup.ts at /api/startup, routes/seat.ts at
// /api/seat and routes/restore-check.ts; startup.ts constructs RestoreOrchestrator (rig up --existing).
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp, mockTmuxAdapter } from "./helpers/test-app.js";
import { createRestoreHarness, type RestoreHarness } from "./helpers/restore-fresh-harness.js";
import { createRestoreCheckService } from "../src/routes/restore-check.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigTeardownOrchestrator } from "../src/domain/rig-teardown.js";
import { snapshotMatchesCurrentOccupants } from "../src/domain/rehydrate-eligibility.js";
import { reattachableAdoptedSession } from "../src/domain/adopted-reattach.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("plan and status around an adopted session rig down left running (unit a2)", () => {
  let db: Database.Database;
  afterEach(() => db?.close());

  /** As restore-plan-reattach-routes.test.ts: one seat whose adopted session rig down left running. */
  function adoptedSeatAfterDown(tmux?: "absent" | "present") {
    db = createFullTestDb();
    const probing = (state: "absent" | "present"): TmuxAdapter => Object.assign(mockTmuxAdapter(), { probeSession: async () => ({ state }) });
    const setup = createTestApp(db, tmux ? { tmux: probing(tmux) } : undefined);
    const rig = setup.rigRepo.createRig("plan-adopted-rig");
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { role: "worker", runtime: "claude-code" });
    const session = setup.sessionRegistry.registerSession(node.id, "dev-impl@plan-adopted-rig");
    db.prepare("UPDATE sessions SET origin = 'claimed', status = 'running' WHERE id = ?").run(session.id);
    setup.sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-impl@plan-adopted-rig", tmuxPane: "%3" });
    setup.snapshotCapture.captureSnapshot(rig.id, "auto-pre-down");
    setup.sessionRegistry.updateStatus(session.id, "detached");
    return { setup, rigId: rig.id, sessionId: session.id };
  }

  /** A seat of another rig whose live row carries the same tmux session name. */
  function otherSeatHolding(setup: ReturnType<typeof createTestApp>, status: "running" | "exited") {
    const other = setup.rigRepo.createRig("other-rig");
    const node = setup.rigRepo.addNode(other.id, "dev.impl", { role: "worker", runtime: "claude-code" });
    const session = setup.sessionRegistry.registerSession(node.id, "dev-impl@other-rig");
    db.prepare("UPDATE sessions SET session_name = 'dev-impl@plan-adopted-rig', status = ? WHERE id = ?").run(status, session.id);
    return session.id;
  }

  describe("OF-171: POST /api/rigs/:id/up {plan:true} forecasts its --fresh list", () => {
    function rigWithMissingSpec() {
      db = createFullTestDb();
      const setup = createTestApp(db, { wireRuntimeAdapters: true });
      const rig = setup.rigRepo.createRig("pred-rig");
      const node = setup.rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: "claude-code" });
      // The recorded spec source no longer exists: a seat listed with --fresh is refused, one that is not is not.
      setup.rigRepo.setRigSpecSource(rig.id, "/nonexistent-a2/rig.yaml");
      const session = setup.sessionRegistry.registerSession(node.id, "worker@pred-rig");
      db.prepare("UPDATE sessions SET resume_type = ?, resume_token = ?, status = ? WHERE id = ?").run("claude_name", "tok-1", "running", session.id);
      setup.snapshotCapture.captureSnapshot(rig.id, "auto-pre-down");
      setup.sessionRegistry.updateStatus(session.id, "detached");
      return { setup, rigId: rig.id };
    }

    it("a listed seat restore would refuse is named, and nothing is restored or changed", async () => {
      const { setup, rigId } = rigWithMissingSpec();
      const restoreSpy = vi.spyOn(setup.restoreOrchestrator, "restore");
      const sessionsBefore = db.prepare("SELECT * FROM sessions ORDER BY id").all();

      const res = await setup.app.request(`/api/rigs/${rigId}/up`, post({ plan: true, freshLogicalIds: ["worker"] }));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.mutated).toBe(false);
      expect(body.nodes[0].logicalId).toBe("worker");
      expect(body.nodes[0].wouldRefuse).toContain("/nonexistent-a2/rig.yaml");
      expect(body.refusalPredictionError).toBeUndefined();
      expect(restoreSpy).not.toHaveBeenCalled();
      expect(db.prepare("SELECT * FROM sessions ORDER BY id").all()).toEqual(sessionsBefore);
    });

    it("its forecast for the seat equals POST /api/up's for the same --fresh list", async () => {
      const { setup, rigId } = rigWithMissingSpec();

      const byId = await (await setup.app.request(`/api/rigs/${rigId}/up`, post({ plan: true, freshLogicalIds: ["worker"] }))).json();
      const byUp = await (await setup.app.request("/api/up", post({ sourceRef: rigId, plan: true, freshLogicalIds: ["worker"] }))).json();

      expect(byId.nodes).toEqual(byUp.nodes);
    });

    it("POST /api/rigs/:id/launch-plan names the same refusal for a listed seat", async () => {
      const { setup, rigId } = rigWithMissingSpec();

      const body = await (await setup.app.request(`/api/rigs/${rigId}/launch-plan`, post({ freshLogicalIds: ["worker"] }))).json();

      expect(body.mutated).toBe(false);
      expect(body.nodes[0].wouldRefuse).toContain("/nonexistent-a2/rig.yaml");
      expect(body.refusalPredictionError).toBeUndefined();
    });

    it.each([
      ["POST /api/rigs/:id/up (plan)", (id: string) => [`/api/rigs/${id}/up`, post({ plan: true, freshLogicalIds: ["worker"] })] as const],
      ["POST /api/rigs/:id/launch-plan", (id: string) => [`/api/rigs/${id}/launch-plan`, post({ freshLogicalIds: ["worker"] })] as const],
    ] as const)("%s: a prediction that fails is reported, never read as nothing refused", async (_label, request) => {
      const { setup, rigId } = rigWithMissingSpec();
      vi.spyOn(setup.rigRepo, "getRigSpecSource").mockImplementation(() => { throw new Error("spec source row unreadable"); });
      const [path, init] = request(rigId);

      const res = await setup.app.request(path, init);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.refusalPredictionError).toBe("spec source row unreadable");
      expect(body.nodes[0].wouldRefuse).toBeUndefined();
    });

    it("control: without a --fresh list no refusal is named", async () => {
      const { setup, rigId } = rigWithMissingSpec();

      const body = await (await setup.app.request(`/api/rigs/${rigId}/up`, post({ plan: true }))).json();

      expect(body.nodes[0].wouldRefuse).toBeUndefined();
    });

    it("a seat listed --fresh over an adopted session rig down left running gets restore's refusal, not the reattach", async () => {
      const { setup, rigId, sessionId } = adoptedSeatAfterDown();

      const seat = (await (await setup.app.request(`/api/rigs/${rigId}/up`, post({ plan: true, freshLogicalIds: ["dev.impl"] }))).json()).nodes[0];

      expect(seat.reattach).toBeUndefined();
      expect(seat.wouldRefuse).toContain(`would be left running untracked: restore refuses the fresh start while it is live (release it first with rig unclaim ${sessionId}`);
    });
  });

  describe("z6 review F4: rig status carries the reattach structurally", () => {
    it("GET /api/rigs/:id/status gives the seat a reattach field and counts it as a reattach", async () => {
      const { setup, rigId, sessionId } = adoptedSeatAfterDown();

      const body = await (await setup.app.request(`/api/rigs/${rigId}/status`)).json();

      expect(body.perSeat[0]).toMatchObject({ intendedAction: "resume-original", reattach: { sessionId, sessionName: "dev-impl@plan-adopted-rig" } });
      expect(body.src).toContain("restore-plan: 1 reattach");
    });

    it("control: a seat with no adopted session left running has no reattach field and is not counted as one", async () => {
      const { setup, rigId, sessionId } = adoptedSeatAfterDown();
      db.prepare("UPDATE sessions SET origin = 'launched' WHERE id = ?").run(sessionId);

      const body = await (await setup.app.request(`/api/rigs/${rigId}/status`)).json();

      expect(body.perSeat[0].reattach).toBeUndefined();
      expect(body.src.join(" ")).not.toContain("reattach");
    });
  });

  describe("z2 review F5: another seat's live row names the same tmux session (plan and startup forecast)", () => {
    const contestedReason = (sessionId: string, holderId: string) =>
      `restore would fail this seat: its adopted session 'dev-impl@plan-adopted-rig', which rig down left running, is also the live session of seat dev.impl@other-rig (row ${holderId}), so a tmux session of that name may not be the one rig down left: restore neither reattaches it nor starts this seat. Release it from this seat with rig unclaim ${sessionId}, or end the other seat's row first`;

    it.each([[undefined], [["dev.impl"]]] as const)("the plan forecasts the failure, not a reattach (fresh %s)", async (fresh) => {
      const { setup, rigId, sessionId } = adoptedSeatAfterDown();
      const holderId = otherSeatHolding(setup, "running");

      const seat = (await (await setup.app.request(`/api/rigs/${rigId}/up`, post({ plan: true, ...(fresh ? { freshLogicalIds: fresh } : {}) }))).json()).nodes[0];

      expect(seat).toMatchObject({ intendedAction: "awaiting-decision", restoreStatus: "failed", reason: contestedReason(sessionId, holderId), freshRequired: false });
      expect(seat.reattach).toBeUndefined();
      expect(seat.wouldRefuse).toBeUndefined();
    });

    it("GET /api/startup/:rigId keeps the failure forecast for a seat observed stopped (restore does not ask tmux first)", async () => {
      const { setup, rigId, sessionId } = adoptedSeatAfterDown("absent");
      const holderId = otherSeatHolding(setup, "running");

      const seat = (await (await setup.app.request(`/api/startup/${rigId}`)).json()).seats[0];

      expect(seat.observed.state).toBe("stopped");
      expect(seat).toMatchObject({ restoreStatus: "failed", reason: contestedReason(sessionId, holderId) });
    });

    it("control: the other seat's row of that name has exited, so the plan is the reattach", async () => {
      const { setup, rigId, sessionId } = adoptedSeatAfterDown();
      otherSeatHolding(setup, "exited");

      const seat = (await (await setup.app.request(`/api/rigs/${rigId}/up`, post({ plan: true }))).json()).nodes[0];

      expect(seat).toMatchObject({ intendedAction: "resume-original", reattach: { sessionId, sessionName: "dev-impl@plan-adopted-rig" } });
    });
  });

  describe("z6 review F5: the reattach rule and the handover's departing row agree on a created_at tie", () => {
    function twoRowsOneSecond() {
      db = createFullTestDb();
      const setup = createTestApp(db);
      const rig = setup.rigRepo.createRig("seat-rig");
      const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex" });
      const first = setup.sessionRegistry.registerSession(node.id, "dev-impl@seat-rig");
      const second = setup.sessionRegistry.registerSession(node.id, "dev-impl@seat-rig");
      // created_at is per second, so two rows of one seat can share it; ids are monotonic ULIDs (session-registry.ts).
      db.prepare("UPDATE sessions SET created_at = '2026-10-28 12:00:00', origin = 'claimed', status = 'detached' WHERE node_id = ?").run(node.id);
      setup.sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-impl@seat-rig" });
      expect(second.id > first.id).toBe(true);
      return { setup, nodeId: node.id, first: first.id, second: second.id };
    }

    it("the reattach rule picks the later id", () => {
      const { nodeId, second } = twoRowsOneSecond();

      expect(reattachableAdoptedSession(db, nodeId)).toEqual({ kind: "reattach", sessionId: second, sessionName: "dev-impl@seat-rig", boundPane: null });
    });

    it("the handover refuses the adopted occupant by the same row", async () => {
      const { setup, second } = twoRowsOneSecond();
      db.prepare("UPDATE sessions SET status = 'running' WHERE id = ?").run(second);

      const res = await setup.app.request("/api/seat/handover/dev-impl%40seat-rig", post({ reason: "context-wall", source: "fresh" }));

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ ok: false, code: "adopted_occupant", guidance: expect.stringContaining(`rig unclaim ${second},`) });
    });
  });
});

describe("restore and restore-check: another seat's live row names the adopted session (z2 review F5)", () => {
  let h: RestoreHarness;
  afterEach(() => h?.cleanup());
  const exists = (p: string) => fs.existsSync(p);

  async function contestedSeat(holder: "running" | "exited") {
    h = createRestoreHarness();
    const seat = await h.launchRig();
    const row = h.db.prepare("SELECT id FROM sessions WHERE node_id = ?").get(seat.nodeId) as { id: string };
    h.db.prepare("UPDATE sessions SET origin = 'claimed', resume_type = 'claude_session_id', resume_token = 'adopted-token' WHERE id = ?").run(row.id);
    const { snapshotId } = await new RigTeardownOrchestrator({
      db: h.db, rigRepo: h.rigRepo, sessionRegistry: h.sessionRegistry, tmuxAdapter: h.tmux, snapshotCapture: h.snapshotCapture, eventBus: new EventBus(h.db),
    }).teardown(seat.rigId);
    const other = h.rigRepo.createRig("other");
    const otherNode = h.rigRepo.addNode(other.id, "dev.impl", { role: "worker", runtime: "claude-code" });
    const held = h.sessionRegistry.registerSession(otherNode.id, "dev-impl@other");
    h.db.prepare("UPDATE sessions SET session_name = ?, status = ? WHERE id = ?").run(seat.sessionName, holder, held.id);
    return { seat, rowId: row.id, snapshotId: snapshotId!, holderId: held.id };
  }
  async function upExisting(rigId: string, snapshotId: string) {
    const rig = h.rigRepo.getRig(rigId)!;
    const from = snapshotMatchesCurrentOccupants(h.db, rig, h.snapshotRepo.getSnapshot(snapshotId)!) ? snapshotId : h.snapshotCapture.captureSnapshot(rigId, "auto-rehydrate").id;
    vi.mocked(h.tmux.createSession).mockClear();
    const out = await h.restore.restore(from, { adapters: { "claude-code": h.adapter }, fsOps: { exists } });
    if (!out.ok) throw new Error(JSON.stringify(out));
    return out.result.nodes.find((n) => n.logicalId === "dev.impl");
  }
  const rowStatus = (id: string) => (h.db.prepare("SELECT status FROM sessions WHERE id = ?").get(id) as { status: string }).status;

  it("rig up --existing fails the seat with adopted_session_contested: not reattached, nothing started or changed", async () => {
    const { seat, rowId, snapshotId, holderId } = await contestedSeat("running");

    const node = await upExisting(seat.rigId, snapshotId);

    expect(node).toEqual({
      nodeId: seat.nodeId, logicalId: "dev.impl", status: "failed", errorCode: "adopted_session_contested",
      error: `dev.impl was not restored: its adopted session '${seat.sessionName}', which rig down left running, is also the live session of seat dev.impl@other (row ${holderId}), so a tmux session of that name may not be the one rig down left: restore neither reattaches it nor starts this seat. Release it from this seat with rig unclaim ${rowId}, or end the other seat's row first. Nothing was changed for this seat.`,
    });
    expect(rowStatus(rowId)).toBe("detached");
    expect(rowStatus(holderId)).toBe("running");
    expect(vi.mocked(h.tmux.createSession)).not.toHaveBeenCalled();
    expect(h.delivered).toEqual([]);
  });

  it("control: the other seat's row has exited, so the adopted session is reattached", async () => {
    const { seat, rowId, snapshotId } = await contestedSeat("exited");

    const node = await upExisting(seat.rigId, snapshotId);

    expect(node).toMatchObject({ status: "resumed", reattached: { sessionId: rowId, sessionName: seat.sessionName } });
  });

  // Restore fails a contested seat before it asks tmux, so tmux being unreadable does not make it an "adopted liveness unknown" seat.
  it("restore-check, tmux cannot answer: still the contested failure, not counted among adopted sessions it cannot check", async () => {
    const { seat, holderId } = await contestedSeat("running");
    const realProbe = vi.mocked(h.tmux.probeSession!).getMockImplementation()!;
    vi.mocked(h.tmux.probeSession!).mockImplementation(async (name: string) => {
      if (name === seat.sessionName) throw new Error("tmux probe failed (injected)");
      return realProbe(name);
    });
    const realHas = vi.mocked(h.tmux.hasSession).getMockImplementation()!;
    vi.mocked(h.tmux.hasSession).mockImplementation(async (name: string) => {
      if (name === seat.sessionName) throw new Error("tmux probe failed (injected)");
      return realHas(name);
    });

    const result = await createRestoreCheckService(h.rigRepo, h.snapshotRepo, h.tmux, { runtimeAdapters: { "claude-code": h.adapter }, specReader: h.inst })
      .checkWithLiveness({ rig: "team", noQueue: true, noHooks: true });

    expect(result.checks.find((c) => c.check === `seat.${seat.sessionName}.readiness`)).toMatchObject({
      status: "red",
      evidence: `Adopted session ${seat.sessionName}, which rig down left running, is also the live session of seat dev.impl@other (row ${holderId})`,
    });
    expect(JSON.stringify(result)).not.toContain("It also probes an adopted session rig down left running");
  });

  it("restore-check is red for the seat, in restore's words, and does not count it as a reattach", async () => {
    const { seat, rowId, holderId } = await contestedSeat("running");

    const result = await createRestoreCheckService(h.rigRepo, h.snapshotRepo, h.tmux, { runtimeAdapters: { "claude-code": h.adapter }, specReader: h.inst })
      .checkWithLiveness({ rig: "team", noQueue: true, noHooks: true });

    expect(result.checks.find((c) => c.check === `seat.${seat.sessionName}.readiness`)).toMatchObject({
      status: "red",
      evidence: `Adopted session ${seat.sessionName}, which rig down left running, is also the live session of seat dev.impl@other (row ${holderId})`,
      remediation: expect.stringContaining(`rig up --existing would fail this seat (adopted_session_contested): its adopted session '${seat.sessionName}'`),
    });
    expect(JSON.stringify(result)).toContain(`rig unclaim ${rowId}`);
    expect(JSON.stringify(result)).not.toContain("It reattaches the adopted sessions");
  });
});

// a2 (z2 review F5, pane half): tmux names a session by name alone, so a session the person recreated under the same name
// after rig down would pass a name check. Restore reattaches only when the pane the seat's binding names is one of the live
// session's panes (pane ids are unique for the tmux server's life); an unreadable or unrecorded pane is unknown, never a match.
describe("restore and restore-check compare the binding's pane before a reattach (a2)", () => {
  let h: RestoreHarness;
  afterEach(() => h?.cleanup());
  const exists = (p: string) => fs.existsSync(p);

  /** A seat whose adopted session, under its own name, rig down left running in tmux pane %fresh (the harness's pane). */
  async function adoptedAfterDown() {
    h = createRestoreHarness();
    const seat = await h.launchRig();
    const row = h.db.prepare("SELECT id FROM sessions WHERE node_id = ?").get(seat.nodeId) as { id: string };
    h.db.prepare("UPDATE sessions SET origin = 'claimed', resume_type = 'claude_session_id', resume_token = 'adopted-token' WHERE id = ?").run(row.id);
    h.sessionRegistry.updateBinding(seat.nodeId, { tmuxSession: seat.sessionName, tmuxPane: "%fresh" });
    const { snapshotId } = await new RigTeardownOrchestrator({
      db: h.db, rigRepo: h.rigRepo, sessionRegistry: h.sessionRegistry, tmuxAdapter: h.tmux, snapshotCapture: h.snapshotCapture, eventBus: new EventBus(h.db),
    }).teardown(seat.rigId);
    return { seat, rowId: row.id, snapshotId: snapshotId! };
  }
  async function upExisting(rigId: string, snapshotId: string, freshLogicalIds?: string[]) {
    const rig = h.rigRepo.getRig(rigId)!;
    const from = snapshotMatchesCurrentOccupants(h.db, rig, h.snapshotRepo.getSnapshot(snapshotId)!) ? snapshotId : h.snapshotCapture.captureSnapshot(rigId, "auto-rehydrate").id;
    vi.mocked(h.tmux.createSession).mockClear();
    const out = await h.restore.restore(from, { adapters: { "claude-code": h.adapter }, fsOps: { exists }, ...(freshLogicalIds ? { freshLogicalIds } : {}) });
    if (!out.ok) throw new Error(JSON.stringify(out));
    return out.result.nodes.find((n) => n.logicalId === "dev.impl");
  }
  const rowStatus = (id: string) => (h.db.prepare("SELECT status FROM sessions WHERE id = ?").get(id) as { status: string }).status;
  const check = () => createRestoreCheckService(h.rigRepo, h.snapshotRepo, h.tmux, { runtimeAdapters: { "claude-code": h.adapter }, specReader: h.inst })
    .checkWithLiveness({ rig: "team", noQueue: true, noHooks: true });
  /** The binding names another pane than the live session's: as if the person recreated the session after rig down. */
  const bindOtherPane = (nodeId: string) => h.db.prepare("UPDATE bindings SET tmux_pane = '%9' WHERE node_id = ?").run(nodeId);

  it.each([[undefined], [["dev.impl"]]] as const)("a live session in another pane is not reattached: adopted_session_replaced, nothing started or changed (fresh %s)", async (fresh) => {
    const { seat, rowId, snapshotId } = await adoptedAfterDown();
    bindOtherPane(seat.nodeId);

    const node = await upExisting(seat.rigId, snapshotId, fresh ? [...fresh] : undefined);

    expect(node).toEqual({
      nodeId: seat.nodeId, logicalId: "dev.impl", status: "failed", errorCode: "adopted_session_replaced",
      error: `dev.impl was not restored: its adopted session '${seat.sessionName}', which rig down left running, is live, but the seat's binding names pane %9, which is not one of that session's panes (%fresh): the session may have been recreated since rig down, so restore neither reattaches it nor starts this seat. If it is the same conversation, release it with rig unclaim ${rowId} and claim it again; otherwise end it. Nothing was changed for this seat.`,
    });
    expect(rowStatus(rowId)).toBe("detached");
    expect(vi.mocked(h.tmux.createSession)).not.toHaveBeenCalled();
    expect(await h.tmux.hasSession(seat.sessionName)).toBe(true);
    expect(h.delivered).toEqual([]);
  });

  it.each([
    ["no pane is recorded", () => { h.db.prepare("UPDATE bindings SET tmux_pane = NULL").run(); }, "the seat's binding records no pane for it"],
    ["tmux lists no pane", () => { vi.mocked(h.tmux.listPanes).mockResolvedValue([]); }, "tmux listed no pane for it"],
    ["the pane list cannot be read", () => { vi.mocked(h.tmux.listPanes).mockRejectedValue(new Error("permission denied")); }, "its panes could not be read (permission denied)"],
  ] as const)("%s: unknown, never a match: adopted_liveness_unknown, nothing started or changed", async (_label, arrange, why) => {
    const { seat, rowId, snapshotId } = await adoptedAfterDown();
    arrange();

    const node = await upExisting(seat.rigId, snapshotId);

    expect(node).toMatchObject({ status: "failed", errorCode: "adopted_liveness_unknown" });
    expect(node?.error).toContain(`is live, but it could not be matched to the pane the seat's binding names (${why})`);
    expect(node?.error).toContain(`rig unclaim ${rowId}`);
    expect(rowStatus(rowId)).toBe("detached");
    expect(vi.mocked(h.tmux.createSession)).not.toHaveBeenCalled();
  });

  it("control: the session is in the pane the binding names, so it is reattached", async () => {
    const { seat, rowId, snapshotId } = await adoptedAfterDown();

    const node = await upExisting(seat.rigId, snapshotId);

    expect(node).toEqual({ nodeId: seat.nodeId, logicalId: "dev.impl", status: "resumed", reattached: { sessionId: rowId, sessionName: seat.sessionName } });
  });

  it("restore-check is red for a session in another pane, in restore's words, and does not count it as a reattach", async () => {
    const { seat, rowId } = await adoptedAfterDown();
    bindOtherPane(seat.nodeId);

    const result = await check();

    expect(result.checks.find((c) => c.check === `seat.${seat.sessionName}.readiness`)).toMatchObject({
      status: "red",
      evidence: `Adopted session ${seat.sessionName}, which rig down left running, is live, but the seat's binding names pane %9, which is not one of its panes (%fresh)`,
      remediation: expect.stringContaining(`rig up --existing would fail this seat (adopted_session_replaced): its adopted session '${seat.sessionName}'`),
    });
    expect(JSON.stringify(result)).toContain(`rig unclaim ${rowId}`);
    expect(JSON.stringify(result)).not.toContain("It reattaches the adopted sessions");
  });

  it("restore-check: an unrecorded pane is unknown, red, and not counted as a reattach", async () => {
    const { seat } = await adoptedAfterDown();
    h.db.prepare("UPDATE bindings SET tmux_pane = NULL").run();

    const result = await check();

    expect(result.checks.find((c) => c.check === `seat.${seat.sessionName}.readiness`)).toMatchObject({
      status: "red",
      evidence: `Adopted session ${seat.sessionName}, which rig down left running, is live, but it could not be matched to the pane the seat's binding names (the seat's binding records no pane for it)`,
      remediation: expect.stringContaining("(adopted_liveness_unknown)"),
    });
    expect(JSON.stringify(result)).not.toContain("It reattaches the adopted sessions");
  });

  it("control: restore-check, the session in the binding's pane: the reattach is predicted", async () => {
    const { seat } = await adoptedAfterDown();

    const result = await check();

    expect(result.checks.find((c) => c.check === `seat.${seat.sessionName}.readiness`)).toMatchObject({ status: "yellow" });
    expect(result.recovery.actions[0]!.reason).toContain(`It reattaches the adopted sessions rig down left running (reattached: ${seat.sessionName})`);
  });
});

// a2: a reconcile adopts a live session onto the seat's EXISTING binding, and updateBinding keeps a pane it is not given.
// When the live pane cannot be observed, the previous occupant's pane must not stay on the binding: restore would read it as
// "replaced" (a false refusal). It is cleared, so restore reads the pane as unknown (adopted_liveness_unknown, with advice).
describe("reconcile keeps the binding's pane honest (a2)", () => {
  let db: Database.Database;
  afterEach(() => db?.close());

  async function reconcileWithPanes(panes: Array<{ id: string }>) {
    db = createFullTestDb();
    const tmux: TmuxAdapter = Object.assign(mockTmuxAdapter(), {
      hasSession: async () => true,
      listPanes: async () => panes.map((pane) => ({ ...pane, index: 0, cwd: "/tmp", width: 80, height: 24, active: true })),
      getPanePid: async () => 4242,
      getPaneCommand: async () => "zsh",
    });
    const setup = createTestApp(db, { tmux });
    const rig = setup.rigRepo.createRig("rec-rig");
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "terminal" });
    const old = setup.sessionRegistry.registerSession(node.id, "dev-impl@rec-rig");
    setup.sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-impl@rec-rig", tmuxPane: "%7" });
    setup.sessionRegistry.markDetached(old.id);

    const result = await setup.claimService.reconcileSession({ sessionName: "dev-impl@rec-rig" });

    expect(result.ok).toBe(true);
    return setup.sessionRegistry.getBindingForNode(node.id);
  }

  it("the live pane cannot be observed: the previous occupant's pane is cleared, not kept", async () => {
    expect(await reconcileWithPanes([])).toMatchObject({ tmuxSession: "dev-impl@rec-rig", tmuxPane: null });
  });

  it("the live pane is observed: it is recorded in place of the previous occupant's", async () => {
    expect(await reconcileWithPanes([{ id: "%4" }])).toMatchObject({ tmuxSession: "dev-impl@rec-rig", tmuxPane: "%4" });
  });
});
