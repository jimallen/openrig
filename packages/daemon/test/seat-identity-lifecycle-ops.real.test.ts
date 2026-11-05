// OF-235 over the real services on a private hc core: while a supported operation ends a seat's terminal and keeps going, the identity reconciler is polled four times
// (more than the two the OF-205 rule needs) and `seat.lost` must report nothing. The operation is the real RigLifecycleService.shrinkPod / removeNode, the real
// RigTeardownOrchestrator.teardown (`rig down`) and the real SeatLifecycleService.stopSeat / cleanSeat, over a real HcAdapter, the real SeatDeliveryGuard and the real reconciler;
// the only addition is that the adapter's killSession, once it has really ended the terminal, polls the reconciler before it returns (the operation then continues:
// that is "the terminal is absent for longer than two polls, inside the operation"). Each row also records whether the guard held the seat's lifecycle lease at the kill:
// that is the census of "does the guard own the seat during this operation", measured, not argued.
//
// Production entrypoint: startup.ts constructs the guard, the hc adapter, these services and the reconciler (passing `guard.lifecycleHeld`); routes/rigs.ts, routes/seat.ts call them.
// Private core: helpers/hc-scratch.ts (root, HOME, XDG and HC_SESSION inside one made directory; refuses an ambient HC_SOCKET).
import { AsyncLocalStorage } from "node:async_hooks";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { HcAdapter } from "../src/adapters/hc-adapter.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { RigLifecycleService } from "../src/domain/rig-lifecycle-service.js";
import { RigTeardownOrchestrator } from "../src/domain/rig-teardown.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { SeatIdentityReconciler } from "../src/domain/seat-identity-reconciler.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import { findHc, startHcScratch, type HcScratch } from "./helpers/hc-scratch.js";

/** The real hc adapter, except that once killSession has really ended a terminal it runs `afterKill` before returning. */
class GapAdapter extends HcAdapter {
  afterKill: ((name: string) => Promise<void>) | null = null;
  override async killSession(...a: Parameters<HcAdapter["killSession"]>): ReturnType<HcAdapter["killSession"]> {
    const result = await super.killSession(...a);
    if (result.ok) await this.afterKill?.(a[0]);
    return result;
  }
}

describe.skipIf(!findHc())("OF-235: no seat.lost while a real lifecycle operation holds the seat, on a private hc core", () => {
  let scratch: HcScratch;
  beforeAll(() => { scratch = startHcScratch(); vi.stubEnv("SHELL", "/bin/sh"); }, 60_000);
  afterAll(() => { vi.unstubAllEnvs(); scratch?.cleanup(); });

  const POLLS = 4;
  let counter = 0;

  async function lab() {
    const db: Database.Database = createDb();
    migrate(db, ALL_MIGRATIONS);
    const rigRepo = new RigRepository(db), sessionRegistry = new SessionRegistry(db), eventBus = new EventBus(db), podRepo = new PodRepository(db);
    const rigName = `ops${++counter}`;
    const rig = rigRepo.createRig(rigName), pod = podRepo.createPod(rig.id, "crew", "Crew");
    const seeder = new HcAdapter(scratch.client());
    const hc = new GapAdapter(scratch.client());
    const guard = new SeatDeliveryGuard(db, (name) => resolveGuardTarget(db, name));
    hc.deliveryGuard = guard;
    // Observation time far from wall clock, 5 s per sweep, as the daemon's timer would give.
    let tick = 0;
    const rec = new SeatIdentityReconciler({ db, tmux: hc, now: () => new Date(Date.UTC(2026, 10, 4, 12, 0, 5 * tick++)), lifecycleHeld: (id) => guard.lifecycleHeld(id) });
    const store = new SeatIdentityStore(db);
    const seats: Array<{ member: string; name: string; nodeId: string; sessionId: string }> = [];
    /** The seats whose stored identity verdict says `session_missing`: the verdict seat.lost is built on (seat-lost-health.ts isLost; the health source itself is pinned in seat-identity-lifecycle-hold.test.ts). */
    const lost = () => seats.filter((s) => store.getForNode(s.nodeId)?.reason === "session_missing").map((s) => s.name);
    for (const member of ["a", "b"]) {
      const name = `${member}@${rigName}`;
      expect(await seeder.createSession(name, scratch.root)).toEqual({ ok: true });
      const [pane] = await seeder.listPanes(name);
      const node = rigRepo.addNode(rig.id, member, { runtime: "terminal", podId: pod.id });
      const session = sessionRegistry.registerSession(node.id, name);
      sessionRegistry.updateStatus(session.id, "running");
      sessionRegistry.updateBinding(node.id, { attachmentType: "hc", tmuxSession: name, terminalAddress: pane!.id });   // an hc seat's binding: the terminal's address, no tmux pane
      seats.push({ member, name, nodeId: node.id, sessionId: session.id });
    }
    // The reconciler's timer is created outside every operation: its polls run in the context taken here, not in the operation's (where `ownsLifecycle` would pass for `lifecycleHeld`).
    const outside = AsyncLocalStorage.snapshot();
    await rec.reconcileAll();   // a verdict exists for each seat before the operation, as in a running daemon
    const kills: Array<{ name: string; held: boolean }> = [];
    const during: string[][] = [];
    hc.afterKill = async (name) => {
      const seat = seats.find((s) => s.name === name);
      kills.push({ name, held: seat ? guard.lifecycleHeld(seat.nodeId) : false });
      for (let i = 0; i < POLLS; i++) { await outside(() => rec.reconcileAll()); during.push(lost()); }
    };
    const lifecycle = new RigLifecycleService({ db, rigRepo, sessionRegistry, eventBus, discoveryRepo: new DiscoveryRepository(db), queueRepo: new QueueRepository(db, eventBus), tmuxAdapter: hc });
    const seatService = new SeatLifecycleService({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: hc });
    const snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo: new SnapshotRepository(db), checkpointStore: new CheckpointStore(db) });
    const teardown = new RigTeardownOrchestrator({ db, rigRepo, sessionRegistry, tmuxAdapter: hc, snapshotCapture, eventBus });
    return { db, rig, pod, seats, kills, during, lost, store, lifecycle, seatService, teardown, rec };
  }

  /** What every row asserts: the operation really ended a terminal, the guard held that seat at the kill, and no poll in the absence reported a loss. */
  function expectQuiet(l: Awaited<ReturnType<typeof lab>>, ended: number) {
    expect(l.kills.length, "terminals the operation really ended").toBe(ended);
    expect(l.kills.map((k) => k.held), "the guard held each seat's lifecycle lease at its kill").toEqual(Array(ended).fill(true));
    expect(l.during.length, "polls inside the absences").toBe(ended * POLLS);
    expect(l.during.flat(), "seats reading session_missing at any poll inside an absence").toEqual([]);
  }

  it("rig down (RigTeardownOrchestrator.teardown): both seats' terminals end and the polls inside stay quiet", async () => {
    const l = await lab();
    try {
      const result = await l.teardown.teardown(l.rig.id, { snapshot: false });
      expect(result.sessionsKilled, JSON.stringify(result)).toBe(2);
      expectQuiet(l, 2);
    } finally { l.db.close(); }
  }, 60_000);

  it("shrinkPod (RigLifecycleService): both seats of the pod end and the polls inside stay quiet", async () => {
    const l = await lab();
    try {
      const result = await l.lifecycle.shrinkPod(l.rig.id, l.pod.id);
      expect(result.ok && result.status, JSON.stringify(result)).toBe("ok");
      expectQuiet(l, 2);
    } finally { l.db.close(); }
  }, 60_000);

  it("removeNode (RigLifecycleService): the node's terminal ends and the polls inside stay quiet", async () => {
    const l = await lab();
    try {
      const result = await l.lifecycle.removeNode(l.rig.id, l.seats[0]!.nodeId);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expectQuiet(l, 1);
    } finally { l.db.close(); }
  }, 60_000);

  it("rig seat stop (SeatLifecycleService.stopSeat): the seat's terminal ends and the polls inside stay quiet", async () => {
    const l = await lab();
    try {
      const result = await l.seatService.stopSeat({ seatRef: l.seats[0]!.name, reason: "OF-235 row" });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expectQuiet(l, 1);
    } finally { l.db.close(); }
  }, 60_000);

  it("control: the other seat of the rig is untouched by a stop and still reads alive", async () => {
    const l = await lab();
    try {
      await l.seatService.stopSeat({ seatRef: l.seats[0]!.name, reason: "OF-235 row" });
      await l.rec.reconcileAll(); await l.rec.reconcileAll();
      expect(l.store.getForNode(l.seats[1]!.nodeId)?.reason).not.toBe("session_missing");
    } finally { l.db.close(); }
  }, 60_000);
});
