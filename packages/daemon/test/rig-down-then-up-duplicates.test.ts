// OF-116 (F7, R1, N5): what `rig up --existing` does after the REAL `rig down` for a seat that has more than one live row.
// Production consequence: `rig down` took its auto-pre-down snapshot while a seat still had two running rows, so the
// snapshot recorded an ambiguous occupant and `rig up --existing` failed the seat ("Active-occupant ambiguity: 2 candidate
// session rows"); for a person's adopted session the failure was a bare "duplicate" that said nothing of what to do.
//
// Deployed entrypoint: startup.ts constructs RigTeardownOrchestrator, RestoreOrchestrator and SeatLifecycleService;
// routes/up.ts picks the snapshot `rig up --existing` restores from (the pre-down snapshot while it still matches the
// occupants). Nothing here touches a real tmux: the harness tmux is an in-memory table of live session names.
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createRestoreHarness, type RestoreHarness } from "./helpers/restore-fresh-harness.js";
import { snapshotMatchesCurrentOccupants } from "../src/domain/rehydrate-eligibility.js";
import { RigTeardownOrchestrator } from "../src/domain/rig-teardown.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import { RigLifecycleService } from "../src/domain/rig-lifecycle-service.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";

const SEAT = "dev.impl";
const ADOPTED = "dev-adopted@team";

describe("rig up --existing after rig down, for a seat with more than one live row (OF-116)", () => {
  let h: RestoreHarness;
  afterEach(() => h?.cleanup());
  const exists = (p: string) => fs.existsSync(p);

  /** The seat's launched row (live in tmux) plus an OLDER row of the given origin, live in tmux under ADOPTED. */
  async function seatWithOlderRow(origin: "claimed" | "launched", newest: "running" | "exited") {
    h = createRestoreHarness();
    const seat = await h.launchRig();
    const launched = h.db.prepare("SELECT id FROM sessions WHERE node_id = ?").get(seat.nodeId) as { id: string };
    h.db.prepare("UPDATE sessions SET created_at = '2021-01-01 00:00:00', status = ? WHERE id = ?").run(newest, launched.id);
    const older = h.sessionRegistry.registerSession(seat.nodeId, ADOPTED);
    h.sessionRegistry.updateStatus(older.id, "running");
    h.db.prepare("UPDATE sessions SET created_at = '2020-01-01 00:00:00', origin = ?, resume_token = 'older-token', resume_type = 'claude_session_id' WHERE id = ?").run(origin, older.id);
    await h.tmux.createSession(ADOPTED);
    // A newest row that is exited has no live session.
    if (newest === "exited") await h.tmux.killSession(seat.sessionName);
    return { seat, olderId: older.id, launchedId: launched.id };
  }
  /** `rig down`, then the restore `rig up --existing` runs (routes/up.ts selection). */
  async function downThenUp(rigId: string) {
    const down = await new RigTeardownOrchestrator({ db: h.db, rigRepo: h.rigRepo, sessionRegistry: h.sessionRegistry, tmuxAdapter: h.tmux, snapshotCapture: h.snapshotCapture, eventBus: new EventBus(h.db) }).teardown(rigId);
    const afterDown = new Map((h.db.prepare("SELECT id, status, intentionally_stopped AS stopped FROM sessions").all() as Array<{ id: string; status: string; stopped: number }>).map((r) => [r.id, { status: r.status, stopped: r.stopped }]));
    const rig = h.rigRepo.getRig(rigId)!;
    const downSnap = h.snapshotRepo.getSnapshot(down.snapshotId!)!;
    const from = snapshotMatchesCurrentOccupants(h.db, rig, downSnap) ? down.snapshotId! : (h.snapshotCapture.captureSnapshot(rigId, "auto-rehydrate") as { id: string }).id;
    const up: any = await h.restore.restore(from, { adapters: { "claude-code": h.adapter }, fsOps: { exists } } as never);
    return { down, up, afterDown, node: up.result?.nodes.find((n: { logicalId: string }) => n.logicalId === SEAT) };
  }

  it("F7: a seat with an older launched duplicate comes back from its newest row, not as an active-occupant ambiguity", async () => {
    const { seat, olderId } = await seatWithOlderRow("launched", "running");

    const { down, up, node, afterDown } = await downThenUp(seat.rigId);

    expect(down.errors).toEqual([]);
    expect(up.ok, JSON.stringify(up)).toBe(true);
    expect(node.status, JSON.stringify(node)).not.toBe("failed");
    expect(JSON.stringify(node)).not.toContain("Active-occupant ambiguity");
    expect(afterDown.get(olderId)).toEqual({ status: "exited", stopped: 1 });
    expect(await h.tmux.hasSession(ADOPTED), "rig down ended the older duplicate's session").toBe(false);
  });

  it("F7: an older ADOPTED duplicate is detached by rig down, its session left running, and the seat comes back from its newest row", async () => {
    const { seat, olderId } = await seatWithOlderRow("claimed", "running");

    const { down, node, afterDown } = await downThenUp(seat.rigId);

    expect(down.warnings?.join(" ")).toContain(ADOPTED);
    expect(node.status, JSON.stringify(node)).not.toBe("failed");
    expect(JSON.stringify(node)).not.toContain("Active-occupant ambiguity");
    expect(afterDown.get(olderId)).toEqual({ status: "detached", stopped: 0 });
    expect(await h.tmux.hasSession(ADOPTED), "an adopted session is not OpenRig's to kill").toBe(true);
  });

  // R1 (review-u07): the adopted older row was thought to make `rig up --existing` fail a seat with a bare "duplicate". The
  // shape that really produced it (an adopted older row beside a running newest one) is the F7 case above: before F7 the
  // snapshot recorded both rows, restore took the adopted one as the occupant and tried to start a session under a name its
  // person still held. What is left is the same collision from any cause, such as a person's own tmux session that holds the
  // seat's name: restore must not kill it, and the failure must say what holds the name and what to do.
  it("R1: a session OpenRig did not start that holds the seat's name fails the seat with a message that says why, not a bare 'duplicate'", async () => {
    h = createRestoreHarness();
    const seat = await h.launchRig();
    const snapshotId = await h.down(seat.rigId);
    await h.tmux.createSession(seat.sessionName); // the person's own session, started after rig down

    const out: any = await h.restore.restore(snapshotId, { adapters: { "claude-code": h.adapter }, fsOps: { exists } } as never);
    const node = out.result.nodes.find((n: { logicalId: string }) => n.logicalId === SEAT);

    expect(node).toMatchObject({ status: "failed", errorCode: "duplicate_session" });
    expect(node.error).toContain(`a tmux session named '${seat.sessionName}' is already running`);
    expect(node.error).toContain("OpenRig does not kill a session it did not start");
    // OF-133: the advice does not send the person to a command that cannot free the name (pinned in the next row).
    expect(node.error).not.toContain("release it with: rig unclaim");
    expect(node.error).toContain("rig unclaim does not free the name");
    expect(node.error).toContain("end it yourself, or rename it");
    expect(node.error).toContain("keeps running the conversation this restore will resume");
    expect(node.error).not.toBe("duplicate");
    expect(await h.tmux.hasSession(seat.sessionName), "restore did not touch the person's session").toBe(true);
  });

  // OF-133 (review-v4 nit): R1 once told the person to `rig unclaim` the adopted session that holds the seat's name. Measured here
  // on the seat state `rig down` leaves for an adopted session (its row `detached`, its tmux session left running): `rig unclaim`
  // reports ok and changes nothing that matters: the row stays `detached`, the tmux session stays, and the next `rig up --existing`
  // meets the same duplicate_session. The advice must therefore not offer it as the way to free the name.
  it("OF-133: rig unclaim on the adopted session that holds the seat's name leaves the name held, so restore still refuses", async () => {
    h = createRestoreHarness();
    const seat = await h.launchRig();
    const snapshotId = await h.down(seat.rigId);
    const adopted = h.sessionRegistry.registerSession(seat.nodeId, seat.sessionName);
    h.db.prepare("UPDATE sessions SET origin = 'claimed', status = 'detached' WHERE id = ?").run(adopted.id); // as rig down leaves an adopted row
    await h.tmux.createSession(seat.sessionName); // the person's adopted session, still running

    const eventBus = new EventBus(h.db);
    const lifecycle = new RigLifecycleService({
      db: h.db, rigRepo: h.rigRepo, sessionRegistry: h.sessionRegistry, discoveryRepo: new DiscoveryRepository(h.db),
      eventBus, queueRepo: new QueueRepository(h.db, eventBus), tmuxAdapter: h.tmux,
    } as never);
    const unclaimed = await lifecycle.unclaimSession(adopted.id);
    expect(unclaimed.ok, JSON.stringify(unclaimed)).toBe(true);
    expect(h.db.prepare("SELECT status FROM sessions WHERE id = ?").get(adopted.id)).toEqual({ status: "detached" });
    expect(await h.tmux.hasSession(seat.sessionName), "unclaim does not end the person's session").toBe(true);

    const out: any = await h.restore.restore(snapshotId, { adapters: { "claude-code": h.adapter }, fsOps: { exists } } as never);
    const node = out.result.nodes.find((n: { logicalId: string }) => n.logicalId === SEAT);
    expect(node).toMatchObject({ status: "failed", errorCode: "duplicate_session" });
  });

  // N5 (review-u07): the command restore-check's T6 advice and restore's own stop-for-decision message name,
  // `rig seat launch <seat> --fresh`, was only ever quoted. Here it is run, after a real rig down and a real rig up --existing.
  it("N5: the rig seat launch --fresh a stopped T6 seat is told to run brings it back", async () => {
    // T6: two running rows on the seat, the older one live and holding the token, the newer one dead with none.
    const { seat, launchedId } = await seatWithOlderRow("launched", "running");
    h.db.prepare("UPDATE sessions SET resume_token = NULL, resume_type = NULL WHERE id = ?").run(launchedId);
    await h.tmux.killSession(seat.sessionName);
    const { node } = await downThenUp(seat.rigId);
    expect(node.status, JSON.stringify(node)).toBe("awaiting-decision");
    expect(node.error).toContain(`rig seat launch 'dev.impl@team' --fresh --reason "<why>"`);

    const eventBus = new EventBus(h.db);
    const nodeLauncher = new NodeLauncher({ db: h.db, rigRepo: h.rigRepo, sessionRegistry: h.sessionRegistry, eventBus, tmuxAdapter: h.tmux });
    const startupOrchestrator = new StartupOrchestrator({ db: h.db, sessionRegistry: h.sessionRegistry, eventBus, tmuxAdapter: h.tmux, sleep: async () => undefined });
    const service = new SeatLifecycleService({
      db: h.db, rigRepo: h.rigRepo, sessionRegistry: h.sessionRegistry, eventBus, tmuxAdapter: h.tmux, nodeLauncher, startupOrchestrator,
      runtimeAdapters: { "claude-code": h.adapter }, listProcesses: async () => [], seatStartupSource: h.inst,
    } as never);

    // The command in the message, quoting removed: rig seat launch 'dev.impl@team' --fresh --reason "<why>".
    const fresh = await service.launchFresh({ seatRef: "dev.impl@team", fresh: true, reason: "OF-116 N5 follows the advice" });

    expect(fresh.ok, JSON.stringify(fresh)).toBe(true);
    expect(await h.tmux.hasSession(seat.sessionName), "the seat is running again on its canonical session").toBe(true);
  });
});
