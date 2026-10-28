// OF-155 (Jim, 2026-10-28): rig down LEAVES a seat's latest adopted (`claimed`) session running, as rig seat stop refuses
// to kill it: the row is ended (`detached`, no stop intent), the binding still names it, and a warning says how to stop or
// release it. rig remove leaves it running too. Option A: rig up --existing brings the seat back by REATTACHING that
// session (row running again), never by starting a second process on its conversation, and restore-check predicts it.
//
// Deployed entrypoints: startup.ts constructs RigTeardownOrchestrator (rig down), RigLifecycleService (rig remove) and
// RestoreOrchestrator (rig up --existing); server.ts mounts routes/restore-check.ts. The harness tmux is an in-memory table.
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRestoreHarness, type RestoreHarness } from "./helpers/restore-fresh-harness.js";
import { createRestoreCheckService } from "../src/routes/restore-check.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigTeardownOrchestrator } from "../src/domain/rig-teardown.js";
import { RigLifecycleService } from "../src/domain/rig-lifecycle-service.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { snapshotMatchesCurrentOccupants } from "../src/domain/rehydrate-eligibility.js";

describe("a seat's adopted session across rig down, rig remove and rig up --existing (OF-155)", () => {
  let h: RestoreHarness;
  afterEach(() => h?.cleanup());
  const exists = (p: string) => fs.existsSync(p);

  /** A seat whose LATEST row is adopted, live in tmux under `name` (the seat's own name, or another). */
  async function adoptedSeat(name?: string) {
    h = createRestoreHarness();
    const seat = await h.launchRig();
    const row = h.db.prepare("SELECT id FROM sessions WHERE node_id = ?").get(seat.nodeId) as { id: string };
    const sessionName = name ?? seat.sessionName;
    if (sessionName !== seat.sessionName) {
      await h.tmux.killSession(seat.sessionName);
      h.db.prepare("UPDATE sessions SET session_name = ? WHERE id = ?").run(sessionName, row.id);
      // a2: the pane the harness tmux gives the session, as a claim records it (restore reattaches only in that pane).
      h.sessionRegistry.updateBinding(seat.nodeId, { tmuxSession: sessionName, tmuxPane: "%fresh" });
      await h.tmux.createSession(sessionName);
    }
    h.db.prepare("UPDATE sessions SET origin = 'claimed', resume_type = 'claude_session_id', resume_token = 'adopted-token' WHERE id = ?").run(row.id);
    return { seat, rowId: row.id, sessionName };
  }
  const down = (rigId: string, opts?: { delete?: boolean }) => new RigTeardownOrchestrator({
    db: h.db, rigRepo: h.rigRepo, sessionRegistry: h.sessionRegistry, tmuxAdapter: h.tmux, snapshotCapture: h.snapshotCapture, eventBus: new EventBus(h.db),
  }).teardown(rigId, opts);
  const row = (id: string) => h.db.prepare("SELECT status, intentionally_stopped AS stopped FROM sessions WHERE id = ?").get(id);
  /** `rig up --existing`: the snapshot routes/up.ts picks (the pre-down one while it matches the occupants). */
  async function upExisting(rigId: string, snapshotId: string, freshLogicalIds?: string[]) {
    const rig = h.rigRepo.getRig(rigId)!;
    const from = snapshotMatchesCurrentOccupants(h.db, rig, h.snapshotRepo.getSnapshot(snapshotId)!) ? snapshotId : h.snapshotCapture.captureSnapshot(rigId, "auto-rehydrate").id;
    vi.mocked(h.tmux.createSession).mockClear();
    const out = await h.restore.restore(from, { adapters: { "claude-code": h.adapter }, fsOps: { exists }, ...(freshLogicalIds ? { freshLogicalIds } : {}) });
    if (!out.ok) throw new Error(JSON.stringify(out));
    return out.result.nodes.find((n) => n.logicalId === "dev.impl");
  }

  it("rig down leaves the latest adopted session running: row detached with no stop intent, binding kept, and says how to stop or release it", async () => {
    const { seat, rowId, sessionName } = await adoptedSeat();

    const result = await down(seat.rigId);

    expect(result.errors).toEqual([]);
    expect(result.sessionsKilled).toBe(0);
    expect(await h.tmux.hasSession(sessionName), "an adopted session is not OpenRig's to kill").toBe(true);
    expect(row(rowId)).toEqual({ status: "detached", stopped: 0 });
    expect(h.sessionRegistry.getBindingForNode(seat.nodeId)?.tmuxSession).toBe(sessionName);
    expect(result.warnings).toEqual([`Session '${sessionName}' was adopted (origin=claimed), not launched by OpenRig: rig down ended its row and left its tmux session running, as rig seat stop would. It is yours to stop: end it yourself if it is no longer wanted. rig up --existing reattaches it; to release it from this seat instead: rig unclaim ${rowId}`]);
  });

  it("rig down --delete leaves it running too, and names no row to release (the rows go with the rig)", async () => {
    const { seat, sessionName } = await adoptedSeat();

    const result = await down(seat.rigId, { delete: true });

    expect(result.deleted).toBe(true);
    expect(await h.tmux.hasSession(sessionName)).toBe(true);
    expect(result.warnings?.join(" ")).toContain("The rig is deleted, so nothing of OpenRig's holds it any more.");
    expect(result.warnings?.join(" ")).not.toContain("rig unclaim");
  });

  it.each([
    ["under the seat's own name", undefined],
    ["under another name", "person-shell"],
  ] as const)("rig up --existing reattaches the adopted session %s: the seat comes back as it was, nothing is started", async (_label, name) => {
    const { seat, rowId, sessionName } = await adoptedSeat(name);
    const { snapshotId } = await down(seat.rigId);

    const node = await upExisting(seat.rigId, snapshotId!);

    expect(node).toEqual({ nodeId: seat.nodeId, logicalId: "dev.impl", status: "resumed", reattached: { sessionId: rowId, sessionName } });
    expect(row(rowId)).toEqual({ status: "running", stopped: 0 });
    expect(vi.mocked(h.tmux.createSession), "no second session is started on the live conversation").not.toHaveBeenCalled();
    expect(h.delivered).toEqual([]);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE node_id = ?").get(seat.nodeId)).toEqual({ n: 1 });
    expect(h.sessionRegistry.getBindingForNode(seat.nodeId)?.tmuxSession).toBe(sessionName);
  });

  it("control: an adopted session that ended after rig down is not reattached; the seat is restored like every other seat", async () => {
    const { seat, rowId, sessionName } = await adoptedSeat("person-shell");
    const { snapshotId } = await down(seat.rigId);
    await h.tmux.killSession(sessionName);

    const node = await upExisting(seat.rigId, snapshotId!);

    expect(node?.reattached).toBeUndefined();
    expect(row(rowId), "the ordinary restore path superseded the old row").toMatchObject({ status: "superseded" });
  });

  it("control: a session released with rig unclaim (binding cleared) is the person's: not reattached", async () => {
    const { seat, rowId } = await adoptedSeat("person-shell");
    const { snapshotId } = await down(seat.rigId);
    const eventBus = new EventBus(h.db);
    await new RigLifecycleService({ db: h.db, rigRepo: h.rigRepo, sessionRegistry: h.sessionRegistry, discoveryRepo: new DiscoveryRepository(h.db), eventBus, queueRepo: new QueueRepository(h.db, eventBus), tmuxAdapter: h.tmux }).unclaimSession(rowId);

    const node = await upExisting(seat.rigId, snapshotId!);

    expect(node?.reattached).toBeUndefined();
    expect(row(rowId), "the ordinary restore path superseded the old row").toMatchObject({ status: "superseded" });
  });

  // Review F4: --fresh would start a new conversation and leave the person's live session running untracked. Refused with
  // advice instead; once the adopted session has ended, --fresh goes ahead.
  it("a seat listed --fresh whose adopted session is still live is refused with advice: nothing started, nothing changed", async () => {
    const { seat, rowId, sessionName } = await adoptedSeat("person-shell");
    const { snapshotId } = await down(seat.rigId);

    const node = await upExisting(seat.rigId, snapshotId!, ["dev.impl"]);

    expect(node).toMatchObject({ status: "failed", errorCode: "adopted_session_live" });
    expect(node?.error).toBe(`dev.impl was not started fresh: its adopted session '${sessionName}', which rig down left running, is still live, and a fresh start would leave the person's session running untracked. Release it from the seat first (rig unclaim ${rowId}) or end it yourself, then rerun; or leave the seat out of --fresh to reattach it. Nothing was changed for this seat.`);
    expect(vi.mocked(h.tmux.createSession)).not.toHaveBeenCalled();
    expect(row(rowId)).toEqual({ status: "detached", stopped: 0 });
    expect(await h.tmux.hasSession(sessionName)).toBe(true);
  });

  // z2 delta review G1: tmux cannot say whether the adopted session is live and the seat is listed --fresh. Restore cannot tell
  // whether a fresh start would leave the person's session running untracked, so it fails the seat and starts nothing.
  it("a seat listed --fresh whose adopted session tmux cannot check fails the same way, and nothing is started", async () => {
    const { seat, rowId, sessionName } = await adoptedSeat("person-shell");
    const { snapshotId } = await down(seat.rigId);
    const real = vi.mocked(h.tmux.hasSession).getMockImplementation()!;
    vi.mocked(h.tmux.hasSession).mockImplementation(async (name: string) => {
      if (name === sessionName) throw new Error("tmux probe failed (injected)");
      return real(name);
    });

    const node = await upExisting(seat.rigId, snapshotId!, ["dev.impl"]);

    expect(node).toMatchObject({ status: "failed", errorCode: "adopted_liveness_unknown" });
    expect(vi.mocked(h.tmux.createSession)).not.toHaveBeenCalled();
    expect(row(rowId)).toMatchObject({ status: "detached" });
  });

  it("control: a seat listed --fresh whose adopted session has ended is started fresh", async () => {
    const { seat, rowId, sessionName } = await adoptedSeat("person-shell");
    const { snapshotId } = await down(seat.rigId);
    await h.tmux.killSession(sessionName);

    const node = await upExisting(seat.rigId, snapshotId!, ["dev.impl"]);

    expect(node?.errorCode).toBeUndefined();
    expect(node?.reattached).toBeUndefined();
    expect(row(rowId), "the ordinary restore path superseded the old row").toMatchObject({ status: "superseded" });
  });

  // The rule's every condition (adopted-reattach.ts): only a row rig down detached from an adopted session is reattached.
  // Each shape below is the same live session and binding with one condition false; reattaching it would attach a session
  // that is not this seat's adopted one (a launched seat's name now held by someone else, or a session someone stopped).
  it.each([
    ["the row is not adopted (a launched seat's detached row)", "UPDATE sessions SET origin = 'launched' WHERE id = ?"],
    ["the row is not detached (it ended)", "UPDATE sessions SET status = 'exited' WHERE id = ?"],
    ["the row carries a stop intent", "UPDATE sessions SET intentionally_stopped = 1 WHERE id = ?"],
  ] as const)("not reattached when %s", async (_label, shape) => {
    const { seat, rowId } = await adoptedSeat("person-shell");
    const { snapshotId } = await down(seat.rigId);
    h.db.prepare(shape).run(rowId);

    const node = await upExisting(seat.rigId, snapshotId!);

    expect(node?.reattached).toBeUndefined();
    expect(row(rowId)).not.toMatchObject({ status: "running" });
  });

  it("tmux cannot say whether the adopted session is live: the seat fails, neither reattached nor started", async () => {
    const { seat, rowId, sessionName } = await adoptedSeat("person-shell");
    const { snapshotId } = await down(seat.rigId);
    const real = vi.mocked(h.tmux.hasSession).getMockImplementation()!;
    vi.mocked(h.tmux.hasSession).mockImplementation(async (name: string) => {
      if (name === sessionName) throw new Error("tmux probe failed (injected)");
      return real(name);
    });

    const node = await upExisting(seat.rigId, snapshotId!);

    expect(node).toMatchObject({ status: "failed", errorCode: "adopted_liveness_unknown" });
    expect(node?.error).toContain(`its adopted session '${sessionName}', which rig down left running, could not be checked in tmux`);
    expect(vi.mocked(h.tmux.createSession)).not.toHaveBeenCalled();
    expect(row(rowId)).toMatchObject({ status: "detached" });
  });

  it("restore-check predicts the reattach: the seat check names it, recovery advises rig up --existing, and no 'out of step' text", async () => {
    const { seat, rowId, sessionName } = await adoptedSeat("person-shell");
    await down(seat.rigId);

    const result = await createRestoreCheckService(h.rigRepo, h.snapshotRepo, h.tmux, { runtimeAdapters: { "claude-code": h.adapter }, specReader: h.inst })
      .checkWithLiveness({ rig: "team", noQueue: true, noHooks: true });

    const readiness = result.checks.find((c) => c.check === `seat.${sessionName}.readiness`);
    expect(readiness).toMatchObject({
      status: "yellow",
      evidence: `Adopted session ${sessionName} was left running by rig down (its row is detached and the seat's binding still names it)`,
      remediation: `rig up --existing reattaches it (reattached: ${sessionName}); nothing is started. To release it from this seat instead: rig unclaim ${rowId}`,
    });
    expect(result.recovery.status).toBe("actionable");
    expect(result.recovery.actions.map((a) => a.command)).toEqual(["rig up --existing team"]);
    expect(result.recovery.actions[0]!.reason).toContain(`It reattaches the adopted sessions rig down left running (reattached: ${sessionName}); nothing is started for them.`);
    const all = JSON.stringify(result);
    expect(all).not.toContain("out of step");
    expect(all).not.toContain("would be refused");
  });

  const check = () => createRestoreCheckService(h.rigRepo, h.snapshotRepo, h.tmux, { runtimeAdapters: { "claude-code": h.adapter }, specReader: h.inst })
    .checkWithLiveness({ rig: "team", noQueue: true, noHooks: true });

  // Review F1: restore fails such a seat (adopted_liveness_unknown) and starts nothing; the check says the same.
  it("restore-check, tmux cannot answer for the adopted session: says restore would neither reattach nor start it", async () => {
    const { seat, sessionName } = await adoptedSeat("person-shell");
    await down(seat.rigId);
    const realHas = vi.mocked(h.tmux.hasSession).getMockImplementation()!;
    vi.mocked(h.tmux.hasSession).mockImplementation(async (name: string) => {
      if (name === sessionName) throw new Error("tmux probe failed (injected)");
      return realHas(name);
    });
    const realProbe = vi.mocked(h.tmux.probeSession!).getMockImplementation()!;
    vi.mocked(h.tmux.probeSession!).mockImplementation(async (name: string) => {
      if (name === sessionName) throw new Error("tmux probe failed (injected)");
      return realProbe(name);
    });

    const result = await check();

    expect(result.checks.find((c) => c.check === `seat.${sessionName}.readiness`)).toMatchObject({
      status: "red",
      evidence: `Adopted session ${sessionName}, which rig down left running, could not be checked in tmux`,
      remediation: "rig up --existing would neither reattach it nor start this seat (adopted_liveness_unknown). Check that tmux is reachable, then rerun rig restore-check",
    });
    expect(result.recovery.status).toBe("unknown");
    const reasons = JSON.stringify(result.recovery.unknown.map((r) => r.reason));
    expect(reasons).toContain(`It also probes an adopted session rig down left running (${sessionName}): one it cannot check fails that seat (adopted_liveness_unknown), neither reattached nor started.`);
    expect(reasons).not.toContain("only probes seats the DB shows running");
    expect(JSON.stringify(result)).not.toContain("resumes its conversation");
  });

  // Review F2: a session that ended after rig down is not predicted as a reattach (restore does not reattach it either).
  it("restore-check, the adopted session ended after rig down: no reattach is predicted", async () => {
    const { seat, sessionName } = await adoptedSeat("person-shell");
    await down(seat.rigId);
    await h.tmux.killSession(sessionName);

    const result = await check();

    const readiness = result.checks.find((c) => c.check === `seat.${sessionName}.readiness`);
    expect(readiness, "the population: the seat is checked").toBeDefined();
    expect(JSON.stringify(readiness)).not.toContain("reattach");
    expect(JSON.stringify(result.recovery)).not.toContain("reattached");
  });

  it.each(["running", "idle", "unknown"] as const)("rig remove leaves a live latest adopted session (%s) running and says so", async (status) => {
    const { seat, rowId, sessionName } = await adoptedSeat("person-shell");
    h.db.prepare("UPDATE sessions SET status = ? WHERE id = ?").run(status, rowId);
    const eventBus = new EventBus(h.db);
    const lifecycle = new RigLifecycleService({ db: h.db, rigRepo: h.rigRepo, sessionRegistry: h.sessionRegistry, discoveryRepo: new DiscoveryRepository(h.db), eventBus, queueRepo: new QueueRepository(h.db, eventBus), tmuxAdapter: h.tmux });

    const result = await lifecycle.removeNode(seat.rigId, "dev.impl");

    expect(result).toMatchObject({ ok: true, sessionsKilled: 0 });
    expect(await h.tmux.hasSession(sessionName)).toBe(true);
    expect(result.ok && result.warnings).toEqual([`Session '${sessionName}' was adopted (origin=claimed), not launched by OpenRig: the node was removed and its tmux session was left running. It is yours to stop: end it yourself if it is no longer wanted.`]);
  });
});
