// OF-144: `rig unclaim <session>` on an adopted row that is NOT its seat's latest one. Before the fix it cleared the seat's
// binding, blanked the @rigged_* tmux options of the session that binding named, and released every discovery record the
// node had claimed: all of which belong to the seat's CURRENT occupant, not to the older row named. The advice to run it
// (rig down's warning, rig seat stop/clean/restart refusals, restore-check) points at exactly such rows.
//
// Deployed entrypoint: routes/sessions.ts POST /api/sessions/:sessionRef/unclaim -> RigLifecycleService.unclaimSession.
// Nothing here touches a real tmux: the harness tmux is an in-memory table of live session names.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRestoreHarness, type RestoreHarness } from "./helpers/restore-fresh-harness.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigLifecycleService } from "../src/domain/rig-lifecycle-service.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { RigTeardownOrchestrator } from "../src/domain/rig-teardown.js";

const ADOPTED = "dev-adopted@team";

describe("rig unclaim of an adopted row that is not its seat's latest (OF-144)", () => {
  let h: RestoreHarness;
  afterEach(() => h?.cleanup());

  function lifecycle(): RigLifecycleService {
    const eventBus = new EventBus(h.db);
    return new RigLifecycleService({
      db: h.db, rigRepo: h.rigRepo, sessionRegistry: h.sessionRegistry, discoveryRepo: new DiscoveryRepository(h.db),
      eventBus, queueRepo: new QueueRepository(h.db, eventBus), tmuxAdapter: h.tmux,
    });
  }
  /** A discovery record for one tmux session, claimed by the node (as `rig claim` leaves it). */
  function claimedRecord(tmuxSession: string, nodeId: string): string {
    const repo = new DiscoveryRepository(h.db);
    const record = repo.upsertDiscoveredSession({ tmuxSession, tmuxPane: "%9", tmuxWindow: "0", runtimeHint: "claude-code", confidence: "high", cwd: "/project" });
    repo.markClaimed(record.id, nodeId);
    return record.id;
  }
  function record(id: string): { status: string; claimed_node_id: string | null } {
    return h.db.prepare("SELECT status, claimed_node_id FROM discovered_sessions WHERE id = ?").get(id) as { status: string; claimed_node_id: string | null };
  }
  /** A launched seat (its newest row live and bound) plus an OLDER live adopted row under ADOPTED. */
  async function seatWithOlderAdoptedRow() {
    h = createRestoreHarness();
    const seat = await h.launchRig();
    const older = h.sessionRegistry.registerSession(seat.nodeId, ADOPTED);
    h.sessionRegistry.updateStatus(older.id, "running");
    h.db.prepare("UPDATE sessions SET created_at = '2020-01-01 00:00:00', origin = 'claimed' WHERE id = ?").run(older.id);
    await h.tmux.createSession(ADOPTED);
    return { seat, olderId: older.id, adoptedRecord: claimedRecord(ADOPTED, seat.nodeId), seatRecord: claimedRecord(seat.sessionName, seat.nodeId) };
  }

  it("ends only that row and frees only that session's discovery record: the seat's live occupant keeps its binding, options and record", async () => {
    const { seat, olderId, adoptedRecord, seatRecord } = await seatWithOlderAdoptedRow();
    const bindingBefore = h.sessionRegistry.getBindingForNode(seat.nodeId);
    expect(bindingBefore?.tmuxSession).toBe(seat.sessionName);

    const out = await lifecycle().unclaimSession(olderId);

    expect(out).toMatchObject({ ok: true, sessionId: olderId, sessionName: ADOPTED });
    expect(h.db.prepare("SELECT status FROM sessions WHERE id = ?").get(olderId)).toEqual({ status: "detached" });
    expect(h.sessionRegistry.getBindingForNode(seat.nodeId)).toEqual(bindingBefore);
    expect(vi.mocked(h.tmux.setSessionOption)).not.toHaveBeenCalled();
    expect(record(adoptedRecord)).toEqual({ status: "active", claimed_node_id: null }); // free to adopt again
    expect(record(seatRecord)).toEqual({ status: "claimed", claimed_node_id: seat.nodeId });
    expect(await h.tmux.hasSession(ADOPTED), "unclaim never ends the person's session").toBe(true);
    expect(await h.tmux.hasSession(seat.sessionName)).toBe(true);
  });

  it("control: the seat's LATEST adopted row is released as before: binding cleared, its session's options blanked, the node's records freed", async () => {
    h = createRestoreHarness();
    const seat = await h.launchRig();
    const latest = h.db.prepare("SELECT id FROM sessions WHERE node_id = ?").get(seat.nodeId) as { id: string };
    h.db.prepare("UPDATE sessions SET origin = 'claimed' WHERE id = ?").run(latest.id);
    const seatRecord = claimedRecord(seat.sessionName, seat.nodeId);

    const out = await lifecycle().unclaimSession(latest.id);

    expect(out).toMatchObject({ ok: true, sessionId: latest.id });
    expect(h.db.prepare("SELECT status FROM sessions WHERE id = ?").get(latest.id)).toEqual({ status: "detached" });
    expect(h.sessionRegistry.getBindingForNode(seat.nodeId)).toBeNull();
    expect(vi.mocked(h.tmux.setSessionOption).mock.calls).toEqual(
      ["@rigged_node_id", "@rigged_session_name", "@rigged_rig_id", "@rigged_rig_name", "@rigged_logical_id"].map((key) => [seat.sessionName, key, ""]),
    );
    expect(record(seatRecord)).toEqual({ status: "active", claimed_node_id: null });
  });

  it("rig down's warning names rig unclaim <id> for the older adopted row, and running it once the seat is relaunched leaves the new occupant bound", async () => {
    const { seat, olderId, adoptedRecord } = await seatWithOlderAdoptedRow();
    const down = await new RigTeardownOrchestrator({ db: h.db, rigRepo: h.rigRepo, sessionRegistry: h.sessionRegistry, tmuxAdapter: h.tmux, snapshotCapture: h.snapshotCapture, eventBus: new EventBus(h.db) }).teardown(seat.rigId);
    expect(down.warnings?.join(" ")).toContain(`Release it with: rig unclaim ${olderId}`);
    expect(h.db.prepare("SELECT status FROM sessions WHERE id = ?").get(olderId)).toEqual({ status: "detached" });
    // The seat comes back (any relaunch leaves this state: a new newest row, live and bound). The harness cannot resume a
    // conversation, so the relaunch is written as its outcome rather than driven through restore.
    const relaunched = h.sessionRegistry.registerSession(seat.nodeId, seat.sessionName);
    h.sessionRegistry.updateStatus(relaunched.id, "running");
    h.sessionRegistry.updateBinding(seat.nodeId, { tmuxSession: seat.sessionName, tmuxPane: "%2" });
    await h.tmux.createSession(seat.sessionName);
    const relaunchedBinding = h.sessionRegistry.getBindingForNode(seat.nodeId);
    expect(relaunchedBinding?.tmuxSession).toBe(seat.sessionName);
    vi.mocked(h.tmux.setSessionOption).mockClear();

    expect(await lifecycle().unclaimSession(olderId)).toMatchObject({ ok: true, sessionId: olderId });

    expect(h.sessionRegistry.getBindingForNode(seat.nodeId)).toEqual(relaunchedBinding);
    expect(vi.mocked(h.tmux.setSessionOption)).not.toHaveBeenCalled();
    expect(record(adoptedRecord)).toEqual({ status: "active", claimed_node_id: null });
  });
});
