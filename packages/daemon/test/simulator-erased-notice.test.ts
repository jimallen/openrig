// OF-221: when OpenRig erases simulators of a rig's seats, the rig's Chief of Staff is told, in its queue. Jim's decisions (2026-11-04): one notice per rig per erase
// run listing every device; `nudge: false` (the notice waits; the wake ladder escalates a long-pending item); nothing for `rig_deleted`; nothing when no CoS resolves.
// Real SimulatorLifecycle, real EventBus, real QueueRepository and database; simctl is a fake. Deployed entrypoint: startup.ts builds the lifecycle through
// buildSimulatorLifecycle with `notifyErased: makeSimulatorErasedNotifier({ db, queue: queueRepoInstance })`.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { BYTES_PER_GB, SimulatorLifecycle, type SimctlExec } from "../src/domain/simulator-lifecycle.js";
import { makeSimulatorErasedNotifier, simulatorNoticeId, SIMULATOR_NOTICE_SOURCE, type NoticeQueue, type SimulatorErasedNotice } from "../src/domain/simulator-erased-notice.js";

const GB = BYTES_PER_GB;
const U = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

function fakeSimctl(devices: Array<{ udid: string; name: string; state?: string; size: number }>, failErase: string[] = []) {
  const exec: SimctlExec = async (args) => {
    if (args[0] === "list") return JSON.stringify({ devices: { "com.apple.CoreSimulator.SimRuntime.iOS-27-1": devices.map((d) => ({ udid: d.udid, name: d.name, state: d.state ?? "Shutdown", isAvailable: true, dataPathSize: d.size })) } });
    if (args[0] === "erase") { if (failErase.includes(args[1]!)) throw new Error("erase failed"); return ""; }
    throw new Error(`unexpected ${args.join(" ")}`);
  };
  return exec;
}

describe("OF-221 the Chief of Staff is told when simulators are erased", () => {
  let db: Database.Database;
  let rigs: RigRepository;
  let sessions: SessionRegistry;
  let eventBus: EventBus;
  let queue: QueueRepository;
  let log: string[];
  let created: Array<Parameters<NoticeQueue["create"]>[0]>;

  beforeEach(() => {
    db = createFullTestDb();
    rigs = new RigRepository(db); sessions = new SessionRegistry(db); eventBus = new EventBus(db);
    // The destination check (`validateRig`) is the daemon's topology-backed one: member@rig of a rig that exists.
    queue = new QueueRepository(db, eventBus, { validateRig: (d: string) => /^[^@]+@[^@]+$/.test(d) && !!db.prepare("SELECT 1 FROM rigs WHERE name = ? AND archived_at IS NULL").get(d.split("@")[1]) });
    log = []; created = [];
  });
  afterEach(() => db.close());

  const recording: NoticeQueue = { create: async (input) => { created.push(input); return queue.create(input); } };
  const lifecycle = (devices: Parameters<typeof fakeSimctl>[0], capGb = 20) =>
    new SimulatorLifecycle({ db, eventBus, simctl: fakeSimctl(devices), capGb: () => capGb, platform: "darwin", log: (l) => log.push(l),
      notifyErased: makeSimulatorErasedNotifier({ db, queue: recording, log: (l) => log.push(l) }) });

  /** eztrack's shape: exec.cos delegates to every other seat. */
  function eztrack(name = "eztrack", seats = ["build.impl", "verify.qa", "build.ux"]) {
    const rig = rigs.createRig(name);
    const cos = rigs.addNode(rig.id, "exec.cos", { runtime: "claude-code" });
    sessions.registerSession(cos.id, `exec-cos@${name}`);
    const nodes: Record<string, { id: string }> = {};
    for (const id of seats) { nodes[id] = rigs.addNode(rig.id, id, { runtime: "terminal" }); rigs.addEdge(rig.id, cos.id, nodes[id]!.id, "delegates_to"); }
    return { rig, nodes };
  }
  const items = () => db.prepare("SELECT qitem_id, source_session, destination_session, body, priority, tags, last_nudge_attempt FROM queue_items ORDER BY qitem_id").all() as Array<Record<string, string | null>>;

  it("a sweep that erases several devices of one rig sends the Chief of Staff ONE notice listing every device, routine, no wake", async () => {
    eztrack();
    const sim = lifecycle([
      { udid: U(1), name: "qa-duo-271", size: 30 * GB }, { udid: U(2), name: "impl-duo-1", size: 25 * GB }, { udid: U(3), name: "ux-duo-1", size: 5 * GB },
    ]);
    await sim.sweepOverCap();
    const rows = items();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source_session: SIMULATOR_NOTICE_SOURCE, destination_session: "exec-cos@eztrack", priority: "routine" });
    expect(created[0]!.summary).toBe("2 simulators erased in eztrack");
    expect(JSON.parse(rows[0]!["tags"]!)).toEqual(["simulator-erased", "rig:eztrack", "reason:over_size_cap"]);
    const body = rows[0]!["body"]!;
    expect(body).toContain("qa-duo-271");
    expect(body).toContain("impl-duo-1");
    expect(body, "a device that was not erased is not listed").not.toContain("ux-duo-1");
    expect(body).toContain(U(1));
    expect(body).toContain("30.0 GB");
    expect(body).toContain("slow");
    expect(created[0]!.nudge, "the notice waits in the queue; it does not wake the seat").toBe(false);
    expect(rows[0]!["last_nudge_attempt"], "no wake was attempted").toBeNull();
  });

  it("two rigs erased in one run get one notice each, each to its own Chief of Staff", async () => {
    eztrack("eztrack", ["verify.qa"]);
    eztrack("other", ["build.impl"]);
    const sim = lifecycle([{ udid: U(1), name: "qa-duo-1", size: 30 * GB }, { udid: U(2), name: "impl-duo-1", size: 30 * GB }]);
    await sim.sweepOverCap();
    const rows = items();
    expect(rows.map((r) => r["destination_session"]).sort()).toEqual(["exec-cos@eztrack", "exec-cos@other"]);
    const byRig = Object.fromEntries(rows.map((r) => [r["destination_session"]!, r["body"]!]));
    expect(byRig["exec-cos@eztrack"]).toContain("qa-duo-1");
    expect(byRig["exec-cos@eztrack"]).not.toContain("impl-duo-1");
    expect(byRig["exec-cos@other"]).toContain("impl-duo-1");
    expect(byRig["exec-cos@other"]).not.toContain("qa-duo-1");
  });

  it("a seat removal tells the rig's Chief of Staff, with the removal as the reason", async () => {
    const { rig, nodes } = eztrack();
    const sim = lifecycle([{ udid: U(1), name: "qa-duo-271", size: 8 * GB }]);
    const removed = sim.seatsForRemoval(rig.id, nodes["verify.qa"]!.id);
    rigs.deleteNode(nodes["verify.qa"]!.id);
    await sim.eraseForRemovedSeats(removed, "seat_removed");
    const rows = items();
    expect(rows).toHaveLength(1);
    expect(rows[0]!["destination_session"]).toBe("exec-cos@eztrack");
    expect(JSON.parse(rows[0]!["tags"]!)).toContain("reason:seat_removed");
    expect(rows[0]!["body"]).toContain("seat that owned it was removed");
    expect(rows[0]!["body"]).toContain("seat verify.qa");
  });

  it("a rig deletion sends nothing: the rig and its Chief of Staff are gone", async () => {
    const { rig } = eztrack();
    const sim = lifecycle([{ udid: U(1), name: "qa-duo-271", size: 8 * GB }]);
    const removed = sim.seatsForRemoval(rig.id);
    rigs.deleteRig(rig.id);
    const res = await sim.eraseForRemovedSeats(removed, "rig_deleted");
    expect(res.outcomes.map((o) => o.action)).toEqual(["erased"]);
    expect(items()).toEqual([]);
    expect(created).toEqual([]);
  });

  it("a device whose erase failed is not in the notice (only what was erased is reported)", async () => {
    eztrack();
    const sim = new SimulatorLifecycle({ db, eventBus, simctl: fakeSimctl([{ udid: U(1), name: "qa-duo-1", size: 30 * GB }, { udid: U(2), name: "qa-duo-2", size: 30 * GB }], [U(2)]), capGb: () => 20, platform: "darwin", log: (l) => log.push(l),
      notifyErased: makeSimulatorErasedNotifier({ db, queue: recording, log: (l) => log.push(l) }) });
    await sim.sweepOverCap();
    const rows = items();
    expect(rows).toHaveLength(1);
    expect(rows[0]!["body"]).toContain("qa-duo-1");
    expect(rows[0]!["body"]).not.toContain("qa-duo-2");
  });

  // The notifier's own guards, independent of what the resolver says: a rig_deleted notice for a rig that still resolves (a stale or replayed run) and a notice with
  // no device are never sent.
  it("the notifier itself refuses a rig_deleted notice, even for a rig that still has a Chief of Staff, and a notice with no device", async () => {
    eztrack();
    const rigId = (db.prepare("SELECT id FROM rigs WHERE name = 'eztrack'").get() as { id: string }).id;
    const notify = makeSimulatorErasedNotifier({ db, queue: recording, log: (l) => log.push(l) });
    const device = { seat: "verify.qa", udid: U(1), name: "qa-duo-1", sizeBytes: GB };
    await notify({ rigId, reason: "rig_deleted", at: "2026-11-04T17:30:00.000Z", devices: [device] });
    await notify({ rigId, reason: "over_size_cap", at: "2026-11-04T17:30:00.000Z", devices: [] });
    expect(created).toEqual([]);
    await notify({ rigId, reason: "over_size_cap", at: "2026-11-04T17:30:00.000Z", devices: [device] });  // positive control: the same rig and time, with a device, is sent
    expect(created).toHaveLength(1);
  });

  it("a rig with no resolvable Chief of Staff gets nothing, and the reason and the devices are logged", async () => {
    const rig = rigs.createRig("flat");
    rigs.addNode(rig.id, "verify.qa", { runtime: "terminal" });
    await lifecycle([{ udid: U(1), name: "qa-duo-271", size: 30 * GB }]).sweepOverCap();
    expect(items()).toEqual([]);
    expect(log.join("\n")).toContain("no Chief of Staff (no_delegates_to_root)");
    expect(log.join("\n")).toContain(U(1));
  });

  it("a run that erased nothing sends nothing", async () => {
    eztrack();
    await lifecycle([{ udid: U(1), name: "qa-duo-271", size: 1 * GB }]).sweepOverCap();
    expect(items()).toEqual([]);
  });

  it("the same run repeated (same rig, devices and minute) is one item: the id is derived, not minted", async () => {
    const notice: SimulatorErasedNotice = { rigId: "r1", reason: "over_size_cap", at: "2026-11-04T17:30:12.000Z", devices: [
      { seat: "verify.qa", udid: U(2), name: "b", sizeBytes: 1 }, { seat: "verify.qa", udid: U(1), name: "a", sizeBytes: 1 }] };
    expect(simulatorNoticeId(notice)).toBe(simulatorNoticeId({ ...notice, at: "2026-11-04T17:30:59.000Z", devices: [...notice.devices].reverse() }));
    expect(simulatorNoticeId(notice)).not.toBe(simulatorNoticeId({ ...notice, at: "2026-11-04T17:31:00.000Z" }));
    expect(simulatorNoticeId(notice)).not.toBe(simulatorNoticeId({ ...notice, rigId: "r2" }));
    expect(simulatorNoticeId(notice)).not.toBe(simulatorNoticeId({ ...notice, reason: "seat_removed" }));
    expect(simulatorNoticeId(notice)).not.toBe(simulatorNoticeId({ ...notice, devices: [notice.devices[0]!] }));
    eztrack();
    const notify = makeSimulatorErasedNotifier({ db, queue: recording, log: (l) => log.push(l) });
    const rigId = (db.prepare("SELECT id FROM rigs WHERE name = 'eztrack'").get() as { id: string }).id;
    const real = { ...notice, rigId };
    await notify(real); await notify(real);
    expect(items()).toHaveLength(1);
  });

  it("a queue that refuses the item is logged, never thrown into the erase run", async () => {
    eztrack();
    const sim = new SimulatorLifecycle({ db, eventBus, simctl: fakeSimctl([{ udid: U(1), name: "qa-duo-271", size: 30 * GB }]), capGb: () => 20, platform: "darwin", log: (l) => log.push(l),
      notifyErased: makeSimulatorErasedNotifier({ db, queue: { create: async () => { throw new Error("queue closed"); } }, log: (l) => log.push(l) }) });
    const res = await sim.sweepOverCap();
    expect(res.outcomes.map((o) => o.action)).toEqual(["erased"]);
    expect(log.join("\n"), "the notifier's own line, not the run's").toContain("[simulators] notice for rig");
    expect(log.join("\n")).toContain("queue closed");
  });

  it("a notifier that throws is logged by the run and does not fail it", async () => {
    eztrack();
    const sim = new SimulatorLifecycle({ db, eventBus, simctl: fakeSimctl([{ udid: U(1), name: "qa-duo-271", size: 30 * GB }]), capGb: () => 20, platform: "darwin", log: (l) => log.push(l),
      notifyErased: async () => { throw new Error("notifier broke"); } });
    const res = await sim.sweepOverCap();
    expect(res.status).toBe("ok");
    expect(log.join("\n")).toContain("notifier broke");
  });

  it("startup wires it: buildSimulatorLifecycle is given the notifier over the daemon's own queue repository", () => {
    const src = fs.readFileSync(path.join(import.meta.dirname, "../src/startup.ts"), "utf8");
    expect(src).toMatch(/buildSimulatorLifecycle\(\{[^}]*notifyErased: makeSimulatorErasedNotifier\(\{ db, queue: queueRepoInstance \}\)/);
  });
});
