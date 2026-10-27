// OF-66 — node removal (and pod shrink, which removes member by member) killed only the node's NEWEST row's tmux session.
// An older row that was still live (an older occupant that outlived a newer row) was orphaned in tmux when the node's rows
// were deleted, and nothing could end it afterwards. Removal now ends every live row of the node by the rule `rig down` and
// `rig seat stop` use: not an adopted (claimed) session, not a name another live node owns, each name once.
//
// Production consequence: a removed seat's older tmux session kept running with no node, no row and no rig command to end it.
// Deployed entrypoint: server.ts constructs RigLifecycleService, whose removeNode/shrinkPod back `rig remove` and `rig shrink`.
// Fake tmux only: no live session is touched.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { RigLifecycleService } from "../src/domain/rig-lifecycle-service.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const OLD = "dev-impl-old@team";
const NEW = "dev-impl-new@team";

describe("node removal ends every live row of the node (OF-66)", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let queueRepo: QueueRepository;
  let killSession: ReturnType<typeof vi.fn>;
  let lifecycle: RigLifecycleService;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    queueRepo = new QueueRepository(db, eventBus, { validateRig: () => true });
    killSession = vi.fn(async () => ({ ok: true as const }));
    lifecycle = new RigLifecycleService({
      db, rigRepo, sessionRegistry, discoveryRepo: new DiscoveryRepository(db), eventBus, queueRepo,
      tmuxAdapter: { killSession, hasSession: vi.fn(async () => true) } as unknown as TmuxAdapter,
    });
  });
  afterEach(() => db.close());

  /** A seat whose OLDER row (created first) is live and whose newest row has the given status. */
  function seat(rig: { id: string }, logicalId: string, opts: { olderName?: string; newerName?: string; newerStatus?: string; olderOrigin?: "claimed" | "launched"; podId?: string } = {}) {
    const node = rigRepo.addNode(rig.id, logicalId, { runtime: "claude-code", cwd: "/" });
    const older = sessionRegistry.registerSession(node.id, opts.olderName ?? OLD);
    sessionRegistry.updateStatus(older.id, "running");
    const newer = sessionRegistry.registerSession(node.id, opts.newerName ?? NEW);
    sessionRegistry.updateStatus(newer.id, opts.newerStatus ?? "exited");
    db.prepare("UPDATE sessions SET created_at = '2020-01-01 00:00:00', origin = ? WHERE id = ?").run(opts.olderOrigin ?? "launched", older.id);
    db.prepare("UPDATE sessions SET created_at = '2021-01-01 00:00:00' WHERE id = ?").run(newer.id);
    return { nodeId: node.id, olderId: older.id, newerId: newer.id };
  }
  const killed = () => killSession.mock.calls.map((c) => c[0]);
  const detachedEvents = () => (db.prepare("SELECT payload FROM events WHERE type = 'session.detached' ORDER BY seq").all() as Array<{ payload: string }>)
    .map((r) => (JSON.parse(r.payload) as { sessionName: string }).sessionName);

  it("kills the older live row's session as well as the newest row's, and records both detaches", async () => {
    const rig = rigRepo.createRig("team");
    seat(rig, "dev.impl", { newerStatus: "running" });

    const result = await lifecycle.removeNode(rig.id, "dev.impl");

    expect(result).toMatchObject({ ok: true, sessionsKilled: 2 });
    expect(killed().sort()).toEqual([NEW, OLD]);
    expect(detachedEvents().sort()).toEqual([NEW, OLD]);
    expect(rigRepo.getRig(rig.id)!.nodes).toHaveLength(0);
  });

  it("kills an older live row behind a newest row that already exited", async () => {
    const rig = rigRepo.createRig("team");
    seat(rig, "dev.impl", { newerStatus: "exited" });

    const result = await lifecycle.removeNode(rig.id, "dev.impl");

    expect(result).toMatchObject({ ok: true, sessionsKilled: 2 });
    expect(killed()).toContain(OLD);
  });

  it("does not kill an adopted (claimed) older session: it is not OpenRig's to kill", async () => {
    const rig = rigRepo.createRig("team");
    seat(rig, "dev.impl", { olderOrigin: "claimed" });

    const result = await lifecycle.removeNode(rig.id, "dev.impl");

    expect(result).toMatchObject({ ok: true, sessionsKilled: 1 });
    expect(killed()).toEqual([NEW]);
  });

  it("leaving an older adopted session running is reported as a warning (N4)", async () => {
    const rig = rigRepo.createRig("team");
    seat(rig, "dev.impl", { olderOrigin: "claimed" });

    const result = await lifecycle.removeNode(rig.id, "dev.impl");

    expect(result.ok && result.warnings?.join(" ")).toContain(`Older session '${OLD}' was adopted`);
    expect(result.ok && result.warnings?.join(" ")).toContain("rig unclaim");
  });

  it("control: no warning when no older session was adopted", async () => {
    const rig = rigRepo.createRig("team");
    seat(rig, "dev.impl");

    const result = await lifecycle.removeNode(rig.id, "dev.impl");

    expect(result.ok && result.warnings).toBeUndefined();
  });

  it("does not kill an older session whose name another live node owns", async () => {
    const rig = rigRepo.createRig("team");
    seat(rig, "dev.impl");
    const other = rigRepo.createRig("other");
    const otherNode = rigRepo.addNode(other.id, "dev.other");
    sessionRegistry.updateStatus(sessionRegistry.registerSession(otherNode.id, OLD).id, "running");

    const result = await lifecycle.removeNode(rig.id, "dev.impl");

    expect(result).toMatchObject({ ok: true, sessionsKilled: 1 });
    expect(killed()).toEqual([NEW]);
  });

  it("does not kill an older session whose name a released (detached claimed) session holds, but a detached launched row holds nothing", async () => {
    const rig = rigRepo.createRig("team");
    seat(rig, "dev.impl");
    const other = rigRepo.createRig("other");
    const otherNode = rigRepo.addNode(other.id, "human");
    const released = sessionRegistry.registerSession(otherNode.id, OLD);
    db.prepare("UPDATE sessions SET status = 'detached', origin = 'claimed' WHERE id = ?").run(released.id);

    const kept = await lifecycle.removeNode(rig.id, "dev.impl");
    expect(kept).toMatchObject({ ok: true, sessionsKilled: 1 });
    expect(killed()).toEqual([NEW]);

    killSession.mockClear();
    const rig2 = rigRepo.createRig("team2");
    seat(rig2, "dev.impl");
    db.prepare("UPDATE sessions SET origin = 'launched' WHERE id = ?").run(released.id);
    const lost = await lifecycle.removeNode(rig2.id, "dev.impl");
    expect(lost).toMatchObject({ ok: true, sessionsKilled: 2 });
    expect(killed()).toContain(OLD);
  });

  it("does not kill the NEWEST session when a released (detached claimed) session holds its name; it names the holder", async () => {
    const rig = rigRepo.createRig("team");
    seat(rig, "dev.impl", { newerStatus: "running" });
    const other = rigRepo.createRig("other");
    const otherNode = rigRepo.addNode(other.id, "human");
    const released = sessionRegistry.registerSession(otherNode.id, NEW);
    db.prepare("UPDATE sessions SET status = 'detached', origin = 'claimed' WHERE id = ?").run(released.id);

    const result = await lifecycle.removeNode(rig.id, "dev.impl");

    expect(result).toMatchObject({ ok: true, sessionKeptFor: "human@other" });
    expect(killed()).toEqual([OLD]);
  });

  it("a row sharing the newest row's name is covered by that one kill", async () => {
    const rig = rigRepo.createRig("team");
    seat(rig, "dev.impl", { olderName: NEW });

    const result = await lifecycle.removeNode(rig.id, "dev.impl");

    expect(result).toMatchObject({ ok: true, sessionsKilled: 1 });
    expect(killed()).toEqual([NEW]);
  });

  it("two older rows sharing one name are killed once", async () => {
    const rig = rigRepo.createRig("team");
    const { nodeId } = seat(rig, "dev.impl");
    const third = sessionRegistry.registerSession(nodeId, OLD);
    sessionRegistry.updateStatus(third.id, "running");
    db.prepare("UPDATE sessions SET created_at = '2020-06-01 00:00:00' WHERE id = ?").run(third.id);

    const result = await lifecycle.removeNode(rig.id, "dev.impl");

    expect(result).toMatchObject({ ok: true, sessionsKilled: 2 });
    expect(killed().filter((name) => name === OLD)).toHaveLength(1);
  });

  it("a failed kill of the older session refuses the removal, keeps the node, and names the session", async () => {
    const rig = rigRepo.createRig("team");
    seat(rig, "dev.impl");
    killSession.mockImplementation(async (name: string) => name === OLD ? { ok: false as const, code: "kill_failed", message: "boom" } : { ok: true as const });

    const result = await lifecycle.removeNode(rig.id, "dev.impl");

    expect(result).toMatchObject({ ok: false, code: "kill_failed" });
    expect(!result.ok && result.error).toContain(`older session '${OLD}'`);
    expect(!result.ok && result.error).toContain("boom");
    expect(rigRepo.getRig(rig.id)!.nodes).toHaveLength(1);
    // N2: the older sessions go first, so the failed removal leaves the seat's working newest session alive.
    expect(killed()).not.toContain(NEW);
  });


  // OF-116 R2: older sessions are killed first, so a failure of the NEWEST kill happens after they are already gone.
  it("R2: a failed kill of the newest session says the older ones were already killed, and a retry finishes", async () => {
    const rig = rigRepo.createRig("team");
    seat(rig, "dev.impl", { newerStatus: "running" });
    killSession.mockImplementation(async (name: string) => name === NEW ? { ok: false as const, code: "kill_failed", message: "boom" } : { ok: true as const });

    const result = await lifecycle.removeNode(rig.id, "dev.impl");

    expect(result).toMatchObject({ ok: false, code: "kill_failed" });
    expect(!result.ok && result.error).toContain(`Failed to kill session '${NEW}': boom`);
    expect(!result.ok && result.error).toContain(`older sessions '${OLD}' were already killed`);
    expect(rigRepo.getRig(rig.id)!.nodes).toHaveLength(1);
    killSession.mockImplementation(async (name: string) => name === OLD ? { ok: false as const, code: "session_not_found", message: "gone" } : { ok: true as const });
    expect(await lifecycle.removeNode(rig.id, "dev.impl")).toMatchObject({ ok: true });
  });

  it("R2 control: a newest-session failure with no older session killed carries no such note", async () => {
    const rig = rigRepo.createRig("team");
    seat(rig, "dev.impl", { olderOrigin: "claimed", newerStatus: "running" });
    killSession.mockImplementation(async () => ({ ok: false as const, code: "kill_failed", message: "boom" }));

    const result = await lifecycle.removeNode(rig.id, "dev.impl");

    expect(!result.ok && result.error).toBe(`Failed to kill session '${NEW}': boom`);
  });

  // OF-116 R3: an adopted older row that carries the newest row's name is the SAME tmux session the newest kill just ended.
  it("R3: an adopted older row sharing the newest row's name is not reported as left running when that kill ended it", async () => {
    const rig = rigRepo.createRig("team");
    seat(rig, "dev.impl", { olderOrigin: "claimed", olderName: NEW, newerStatus: "running" });

    const result = await lifecycle.removeNode(rig.id, "dev.impl");

    expect(result).toMatchObject({ ok: true, sessionsKilled: 1 });
    expect(killed()).toEqual([NEW]);
    expect(result.ok && result.warnings).toBeUndefined();
  });

  it("R3 control: when the newest session is KEPT (a released holder), the same adopted row is still reported as left running", async () => {
    const rig = rigRepo.createRig("team");
    seat(rig, "dev.impl", { olderOrigin: "claimed", olderName: NEW, newerStatus: "running" });
    const other = rigRepo.createRig("other");
    const released = sessionRegistry.registerSession(rigRepo.addNode(other.id, "human").id, NEW);
    db.prepare("UPDATE sessions SET status = 'detached', origin = 'claimed' WHERE id = ?").run(released.id);

    const result = await lifecycle.removeNode(rig.id, "dev.impl");

    expect(killed()).toEqual([]);
    expect(result.ok && result.warnings?.join(" ")).toContain(`Older session '${NEW}' was adopted`);
  });

  // OF-116 N3: a launched older row whose name is an adopted row's of the SAME node. findOtherSessionOwner skips the node's own
  // rows, so only the node's own rows can say the name is the person's.
  it("N3: a launched older row sharing an adopted row's name does not kill the adopted session", async () => {
    const rig = rigRepo.createRig("team");
    const { nodeId } = seat(rig, "dev.impl", { olderOrigin: "claimed" });
    const launchedTwin = sessionRegistry.registerSession(nodeId, OLD);
    sessionRegistry.updateStatus(launchedTwin.id, "running");
    db.prepare("UPDATE sessions SET created_at = '2020-06-01 00:00:00', origin = 'launched' WHERE id = ?").run(launchedTwin.id);

    const result = await lifecycle.removeNode(rig.id, "dev.impl");

    expect(killed()).not.toContain(OLD);
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.warnings?.join(" ")).toContain(`Older session '${OLD}' was adopted`);
  });

  // OF-116 V9 (review-u07 R4): the shrink pre-check counts the work addressed to each member's NEWEST session only when this
  // shrink would kill it. A name a released session holds is kept, so work addressed to it is the holder's, not a blocker.
  it("shrink: work addressed to a newest session a released (detached claimed) session holds does not block the shrink", async () => {
    const rig = rigRepo.createRig("team");
    db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES ('pod-1', ?, 'dev', 'Dev')").run(rig.id);
    const member = seat(rig, "dev.impl", { newerStatus: "running", olderOrigin: "claimed" });
    db.prepare("UPDATE nodes SET pod_id = 'pod-1' WHERE id = ?").run(member.nodeId);
    const other = rigRepo.createRig("other");
    const released = sessionRegistry.registerSession(rigRepo.addNode(other.id, "human").id, NEW);
    db.prepare("UPDATE sessions SET status = 'detached', origin = 'claimed' WHERE id = ?").run(released.id);
    const work = await queueRepo.create({ sourceSession: "orch@team", destinationSession: NEW, body: "the holder's work" });

    const shrunk = await lifecycle.shrinkPod(rig.id, "dev");

    expect(shrunk, JSON.stringify(shrunk)).toMatchObject({ ok: true });
    expect(killed()).toEqual([]);
    expect(queueRepo.getById(work.qitemId)).toMatchObject({ destinationSession: NEW, state: "pending" });
  });
  it("queue work addressed to the older session blocks the removal without a fallback, and nothing is killed", async () => {
    const rig = rigRepo.createRig("team");
    seat(rig, "dev.impl");
    const work = await queueRepo.create({ sourceSession: "orch@team", destinationSession: OLD, body: "older seat's work" });

    const result = await lifecycle.removeNode(rig.id, "dev.impl");

    expect(result).toMatchObject({ ok: false, code: "active_qitems" });
    expect(killSession).not.toHaveBeenCalled();
    expect(queueRepo.getById(work.qitemId)).toMatchObject({ destinationSession: OLD, state: "pending" });
  });

  it("shrinking a pod ends the older live session of each member, and refuses first when work is addressed to it", async () => {
    const rig = rigRepo.createRig("team");
    const pod = db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES ('pod-1', ?, 'dev', 'Dev')").run(rig.id);
    expect(pod.changes).toBe(1);
    const member = seat(rig, "dev.impl");
    db.prepare("UPDATE nodes SET pod_id = 'pod-1' WHERE id = ?").run(member.nodeId);
    const work = await queueRepo.create({ sourceSession: "orch@team", destinationSession: OLD, body: "older seat's work" });

    const refused = await lifecycle.shrinkPod(rig.id, "dev");
    expect(refused).toMatchObject({ ok: false, code: "active_qitems" });
    expect(killSession).not.toHaveBeenCalled();
    expect(rigRepo.getRig(rig.id)!.nodes).toHaveLength(1);

    db.prepare("UPDATE queue_items SET state = 'done' WHERE qitem_id = ?").run(work.qitemId);
    const shrunk = await lifecycle.shrinkPod(rig.id, "dev");
    expect(shrunk).toMatchObject({ ok: true, sessionsKilled: 2 });
    expect(killed().sort()).toEqual([NEW, OLD]);
  });
});
