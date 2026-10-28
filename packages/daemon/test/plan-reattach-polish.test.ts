// Unit a2 (wave 7): the restore plan and rig status around an adopted session rig down left running (OF-155/OF-163).
// - OF-171: POST /api/rigs/:id/up {plan:true} forecasts the --fresh list it restores with, as POST /api/up does.
// - z6 review F4: GET /api/rigs/:id/status carries the reattach as a field, and counts it as itself.
// - z2 review F5: a seat whose adopted session another seat's live row also names is not reattached by name: restore fails
//   it (adopted_session_contested) and starts nothing, and the plan, the startup forecast and restore-check say so.
// - z6 review F5: the reattach rule (created_at, then id) and the handover's departing row (id) pick the same row when
//   two rows share a created_at second.
// - a2 review (b94822a4) F1/F2/F5: the adopted session is told by the OpenRig marker a claim writes into it (@rigged_node_id),
//   not by pane id; F3: the plan, status, startup forecast and restore-check run restore's own probe, so none says
//   "reattach" for a seat restore refuses; F4: an `unknown` row holds a tmux name as a running one does.
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
import { PodRepository } from "../src/domain/pod-repository.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("plan and status around an adopted session rig down left running (unit a2)", () => {
  let db: Database.Database;
  afterEach(() => db?.close());

  /** As restore-plan-reattach-routes.test.ts: one seat whose adopted session rig down left running, live in tmux (or absent)
   *  and carrying this seat's OpenRig marker, another seat's, none, or one tmux cannot read. */
  function adoptedSeatAfterDown(tmux: "absent" | "present" = "present", marker: "own" | "other" | "unset" | "unreadable" = "own") {
    db = createFullTestDb();
    let nodeId = "";
    const probing = (state: "absent" | "present"): TmuxAdapter => Object.assign(mockTmuxAdapter(), {
      probeSession: async () => ({ state }),
      hasSession: async () => state === "present",
      readSessionOption: async () => marker === "unreadable" ? { ok: false as const, error: "server exited unexpectedly" }
        : { ok: true as const, value: marker === "own" ? nodeId : marker === "other" ? "node-of-another-seat" : null },
    });
    const setup = createTestApp(db, { tmux: probing(tmux) });
    const rig = setup.rigRepo.createRig("plan-adopted-rig");
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { role: "worker", runtime: "claude-code" });
    nodeId = node.id;
    const session = setup.sessionRegistry.registerSession(node.id, "dev-impl@plan-adopted-rig");
    db.prepare("UPDATE sessions SET origin = 'claimed', status = 'running' WHERE id = ?").run(session.id);
    setup.sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-impl@plan-adopted-rig", tmuxPane: "%3" });
    setup.snapshotCapture.captureSnapshot(rig.id, "auto-pre-down");
    setup.sessionRegistry.updateStatus(session.id, "detached");
    return { setup, rigId: rig.id, sessionId: session.id };
  }

  /** A seat of another rig whose live row carries the same tmux session name. */
  function otherSeatHolding(setup: ReturnType<typeof createTestApp>, status: "running" | "unknown" | "exited") {
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

  // a2 review F4: a row whose status is `unknown` may still own the tmux session, so it holds the name as a running row does.
  it("an `unknown` row of another seat holds the name: the plan forecasts the contested failure", async () => {
    const { setup, rigId } = adoptedSeatAfterDown();
    const holderId = otherSeatHolding(setup, "unknown");

    const seat = (await (await setup.app.request(`/api/rigs/${rigId}/up`, post({ plan: true }))).json()).nodes[0];

    expect(seat).toMatchObject({ restoreStatus: "failed", reason: expect.stringContaining(`is also the live session of seat dev.impl@other-rig (row ${holderId})`) });
    expect(seat.reattach).toBeUndefined();
  });

  // a2 review F3: every surface reads restore's probe, so a seat restore fails (marked as another seat's, or not told) is
  // forecast as failing everywhere, and nowhere as a reattach.
  describe("a2 review F3: every surface agrees with restore on a seat it would not reattach", () => {
    const failing = [
      ["marked as another seat's", "other", "is live, but it is marked as another seat's (@rigged_node_id=node-of-another-seat)"],
      ["carrying no marker", "unset", "it carries no OpenRig marker (@rigged_node_id): it may have been recreated since rig down"],
      ["whose marker cannot be read", "unreadable", "its OpenRig marker (@rigged_node_id) could not be read: server exited unexpectedly"],
    ] as const;

    it.each(failing)("plan routes, session %s: forecast to fail, no reattach", async (_label, marker, words) => {
      const { setup, rigId } = adoptedSeatAfterDown("present", marker);

      for (const [path, init] of [[`/api/rigs/${rigId}/up`, post({ plan: true })], [`/api/rigs/${rigId}/launch-plan`, post({})], ["/api/up", post({ sourceRef: rigId, plan: true })]] as const) {
        const seat = (await (await setup.app.request(path, init)).json()).nodes[0];
        expect(seat, path).toMatchObject({ intendedAction: "awaiting-decision", restoreStatus: "failed", reason: expect.stringContaining(words) });
        expect(seat.reattach, path).toBeUndefined();
      }
    });

    it.each(failing)("GET /api/rigs/:id/status, session %s: no reattach field, not counted as one", async (_label, marker) => {
      const { setup, rigId } = adoptedSeatAfterDown("present", marker);

      const body = await (await setup.app.request(`/api/rigs/${rigId}/status`)).json();

      expect(body.perSeat[0].reattach).toBeUndefined();
      expect(body.src.join(" ")).not.toContain("reattach");
    });

    it.each(failing)("GET /api/startup/:rigId, session %s: forecast to fail, no reattach", async (_label, marker, words) => {
      const { setup, rigId } = adoptedSeatAfterDown("present", marker);

      const seat = (await (await setup.app.request(`/api/startup/${rigId}`)).json()).seats[0];

      expect(seat).toMatchObject({ restoreStatus: "failed", reason: expect.stringContaining(words) });
      expect(seat.reattach).toBeUndefined();
    });

    it("control: the session carries this seat's marker, so every surface says reattach", async () => {
      const { setup, rigId, sessionId } = adoptedSeatAfterDown("present", "own");

      const plan = (await (await setup.app.request(`/api/rigs/${rigId}/up`, post({ plan: true }))).json()).nodes[0];
      const status = await (await setup.app.request(`/api/rigs/${rigId}/status`)).json();

      expect(plan.reattach).toEqual({ sessionId, sessionName: "dev-impl@plan-adopted-rig" });
      expect(status.perSeat[0].reattach).toEqual({ sessionId, sessionName: "dev-impl@plan-adopted-rig" });
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

      expect(reattachableAdoptedSession(db, nodeId)).toEqual({ kind: "reattach", sessionId: second, sessionName: "dev-impl@seat-rig" });
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
    await h.tmux.setSessionOption(seat.sessionName, "@rigged_node_id", seat.nodeId); // the marker a claim writes
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

// a2 review (b94822a4) F1, F2, F5: tmux names a session by name alone, so a session the person recreated under the same name
// after rig down would pass a name check. Restore reattaches only a live session that carries this seat's OpenRig marker
// (@rigged_node_id, written at claim); another seat's marker is `replaced`, none or an unreadable one is `unknown`.
describe("restore and restore-check tell the adopted session by its OpenRig marker (a2)", () => {
  let h: RestoreHarness;
  afterEach(() => h?.cleanup());
  const exists = (p: string) => fs.existsSync(p);

  /** A seat whose adopted session, under its own name and carrying the seat's marker, rig down left running. */
  async function adoptedAfterDown() {
    h = createRestoreHarness();
    const seat = await h.launchRig();
    const row = h.db.prepare("SELECT id FROM sessions WHERE node_id = ?").get(seat.nodeId) as { id: string };
    h.db.prepare("UPDATE sessions SET origin = 'claimed', resume_type = 'claude_session_id', resume_token = 'adopted-token' WHERE id = ?").run(row.id);
    await h.tmux.setSessionOption(seat.sessionName, "@rigged_node_id", seat.nodeId);
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
  /** The person ended the session and started another of the same name: tmux options go with the session. */
  const recreate = async (name: string) => { await h.tmux.killSession(name); await h.tmux.createSession(name); };

  it.each([[undefined], [["dev.impl"]]] as const)("a live session marked as another seat's is not reattached: adopted_session_replaced, nothing started or changed (fresh %s)", async (fresh) => {
    const { seat, rowId, snapshotId } = await adoptedAfterDown();
    await h.tmux.setSessionOption(seat.sessionName, "@rigged_node_id", "node-of-another-seat");

    const node = await upExisting(seat.rigId, snapshotId, fresh ? [...fresh] : undefined);

    expect(node).toEqual({
      nodeId: seat.nodeId, logicalId: "dev.impl", status: "failed", errorCode: "adopted_session_replaced",
      error: `dev.impl was not restored: its adopted session '${seat.sessionName}', which rig down left running, is live, but it is marked as another seat's (@rigged_node_id=node-of-another-seat), so it is not the session rig down left: restore neither reattaches it nor starts this seat. Release it from this seat with rig unclaim ${rowId}. Nothing was changed for this seat.`,
    });
    expect(rowStatus(rowId)).toBe("detached");
    expect(vi.mocked(h.tmux.createSession)).not.toHaveBeenCalled();
    expect(h.delivered).toEqual([]);
  });

  it.each([
    ["recreated under the same name (no marker)", async (name: string) => { await recreate(name); }, "it carries no OpenRig marker (@rigged_node_id): it may have been recreated since rig down, or the marker was never written"],
    ["its marker cannot be read", async () => { vi.mocked(h.tmux.readSessionOption).mockResolvedValue({ ok: false, error: "server exited unexpectedly" }); }, "its OpenRig marker (@rigged_node_id) could not be read: server exited unexpectedly"],
  ] as const)("a live session %s: unknown, never a match: adopted_liveness_unknown, nothing started or changed", async (_label, arrange, why) => {
    const { seat, rowId, snapshotId } = await adoptedAfterDown();
    await arrange(seat.sessionName);

    const node = await upExisting(seat.rigId, snapshotId);

    expect(node).toEqual({
      nodeId: seat.nodeId, logicalId: "dev.impl", status: "failed", errorCode: "adopted_liveness_unknown",
      error: `dev.impl was not restored: its adopted session '${seat.sessionName}', which rig down left running, is live, but it could not be told to be the session rig down left (${why}), so restore neither reattaches it nor starts a second session. Retry once tmux answers; if the session was recreated, release the seat with rig unclaim ${rowId}. Nothing was changed for this seat.`,
    });
    expect(rowStatus(rowId)).toBe("detached");
    expect(vi.mocked(h.tmux.createSession)).not.toHaveBeenCalled();
  });

  it("control: the live session carries this seat's marker, so it is reattached", async () => {
    const { seat, rowId, snapshotId } = await adoptedAfterDown();

    const node = await upExisting(seat.rigId, snapshotId);

    expect(node).toEqual({ nodeId: seat.nodeId, logicalId: "dev.impl", status: "resumed", reattached: { sessionId: rowId, sessionName: seat.sessionName } });
  });

  it("restore-check is red for a session marked as another seat's, in restore's words, and does not count it as a reattach", async () => {
    const { seat, rowId } = await adoptedAfterDown();
    await h.tmux.setSessionOption(seat.sessionName, "@rigged_node_id", "node-of-another-seat");

    const result = await check();

    expect(result.checks.find((c) => c.check === `seat.${seat.sessionName}.readiness`)).toMatchObject({
      status: "red",
      evidence: `Adopted session ${seat.sessionName}, which rig down left running, is live, but it is marked as another seat's (@rigged_node_id=node-of-another-seat)`,
      remediation: expect.stringContaining(`rig up --existing would fail this seat (adopted_session_replaced): its adopted session '${seat.sessionName}'`),
    });
    expect(JSON.stringify(result)).toContain(`rig unclaim ${rowId}`);
    expect(JSON.stringify(result)).not.toContain("It reattaches the adopted sessions");
  });

  it("restore-check: a recreated session (no marker) is unknown, red, and not counted as a reattach", async () => {
    const { seat } = await adoptedAfterDown();
    await recreate(seat.sessionName);

    const result = await check();

    expect(result.checks.find((c) => c.check === `seat.${seat.sessionName}.readiness`)).toMatchObject({
      status: "red",
      evidence: `Adopted session ${seat.sessionName}, which rig down left running, is live, but it could not be told to be the session rig down left (it carries no OpenRig marker (@rigged_node_id): it may have been recreated since rig down, or the marker was never written)`,
      remediation: expect.stringContaining("(adopted_liveness_unknown)"),
    });
    expect(JSON.stringify(result)).not.toContain("It reattaches the adopted sessions");
  });

  it("control: restore-check, the session carries this seat's marker: the reattach is predicted", async () => {
    const { seat } = await adoptedAfterDown();

    const result = await check();

    expect(result.checks.find((c) => c.check === `seat.${seat.sessionName}.readiness`)).toMatchObject({ status: "yellow" });
    expect(result.recovery.actions[0]!.reason).toContain(`It reattaches the adopted sessions rig down left running (reattached: ${seat.sessionName})`);
  });
});

// a2: self-attach adopts a session the person started (origin claimed), as a claim does, so it writes the same marker.
describe("self-attach writes the OpenRig marker a claim writes (a2)", () => {
  let db: Database.Database;
  afterEach(() => db?.close());
  const tmuxContext = { attachmentType: "tmux" as const, tmuxSession: "person-shell", tmuxWindow: "@1", tmuxPane: "%2" };

  function app() {
    db = createFullTestDb();
    const setSessionOption = vi.fn(async () => ({ ok: true as const }));
    const setup = createTestApp(db, { tmux: Object.assign(mockTmuxAdapter(), { setSessionOption }) });
    const rig = setup.rigRepo.createRig("attach-rig");
    return { setup, rig, setSessionOption };
  }

  it("attachToNode from tmux marks the session with the seat's node id", async () => {
    const { setup, rig, setSessionOption } = app();
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });

    const result = await setup.selfAttachService.attachToNode({ rigId: rig.id, logicalId: "dev.impl", context: tmuxContext });

    expect(result.ok).toBe(true);
    expect(setSessionOption).toHaveBeenCalledWith("person-shell", "@rigged_node_id", node.id);
  });

  it("attachToPod from tmux marks the session with the new seat's node id", async () => {
    const { setup, rig, setSessionOption } = app();
    const pod = new PodRepository(db).createPod(rig.id, "dev", "Dev");

    const result = await setup.selfAttachService.attachToPod({ rigId: rig.id, podNamespace: "dev", memberName: "impl", runtime: "claude-code", context: tmuxContext });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(pod.id).toBeTruthy();
    expect(setSessionOption).toHaveBeenCalledWith("person-shell", "@rigged_node_id", result.nodeId);
  });

  it("control: an external CLI attach has no tmux session to mark", async () => {
    const { setup, rig, setSessionOption } = app();
    setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });

    const result = await setup.selfAttachService.attachToNode({ rigId: rig.id, logicalId: "dev.impl", displayName: "person-cli@attach-rig" });

    expect(result.ok).toBe(true);
    expect(setSessionOption).not.toHaveBeenCalled();
  });
});
