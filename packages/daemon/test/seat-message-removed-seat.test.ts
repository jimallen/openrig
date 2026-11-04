// OF-209 — a message waiting for a seat that `rig remove` took out of a LIVE rig was returned to its sender as "rig <name> is archived".
//
// Measured on the live laptop daemon, 2026-11-03 (read-only): 1d1c6820, 5a7d140b and 0ffce4de (attempts 0, behind a Codex seat's long turn)
// were open on verify-ops@eztrack when `rig remove 01M5WP54... verify.ops` deleted the node at ~08:36:3x; the pump's next pass asked
// DbSeatDirectory.fate("verify-ops@eztrack"), whose seat query matches by name and, with the node gone and no binding, found only the
// unbound nodes of ten ARCHIVED rigs also named "eztrack": no live row, so { gone, "rig eztrack is archived" } and all three went back to
// exec-cos at 08:36:40.9Z, while the live rig 01M5WP54... was running and a successor was added seconds later.
//
// Jim's rule (2026-11-01): a message for a seat that is gone goes to its successor, labelled, and is returned only once its rig is archived,
// with a true reason. The pump has no time bound ("a row leaves only on a gate record, or when its seat is gone for good"), so none is added.
// Deployed entrypoint: startup.ts constructs MessagePump with DbSeatDirectory; server.ts constructs RigLifecycleService behind `rig remove`.
// Real database, directory, store and pump; the gate and the hop are stubs; no tmux adapter, so removal kills nothing.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { RigLifecycleService } from "../src/domain/rig-lifecycle-service.js";
import { Hono } from "hono";
import { TmuxAdapter, type TmuxResult } from "../src/adapters/tmux.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { transportRoutes } from "../src/routes/transport.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { MessagePump } from "../src/domain/seat-messaging/message-pump.js";
import { MessageStore } from "../src/domain/seat-messaging/message-store.js";
import { rigHadSeat } from "../src/domain/seat-messaging/seat-history.js";
import { DbSeatDirectory } from "../src/domain/seat-messaging/seat-directory.js";
import { PREVIOUS_OCCUPANT_LABEL } from "../src/domain/seat-messaging/message-label.js";
import { messageId, type GateLookup, type GateRecord, type LastHop, type MessageId, type LastHopResult, type SeatGate, type SeatMessage } from "../src/domain/seat-messaging/ports.js";
import type { HeldMessages, SenderReturn } from "../src/domain/seat-messaging/pump-ports.js";

const T0 = 7_000_000;
const MIN = 60_000;
const SEAT = "verify-ops@eztrack";
const row = (db: Database.Database, id: string) => db.prepare("SELECT * FROM outbox_entries WHERE outbox_id = ?").get(id) as Record<string, unknown>;

class StubGate implements SeatGate {
  readonly version = 3;
  readonly seen = new Map<string, GateRecord>();
  record(id: string): void { this.seen.set(id, { id: messageId(id), recordedAt: "1970-01-01T02:00:00.000Z", nonce: null }); }
  async lookup(_seat: string, id: MessageId): Promise<GateLookup> {
    const record = this.seen.get(id);
    return record ? { kind: "seen", record } : { kind: "not_seen" };
  }
}
/** Counts how often the pump asks for a seat's head: a pump that spins on a vacant seat (answers "next" forever) would hang the suite, because its loop
 *  only awaits microtasks and so no test timeout can fire. This one throws past a bound, which ends the loop, and the test asserts the count. */
class CountingStore extends MessageStore {
  headCalls = 0;
  override headOf(seat: string): ReturnType<MessageStore["headOf"]> {
    this.headCalls += 1;
    if (this.headCalls > 200) throw new Error("the pump spun on a seat that should wait");
    return super.headOf(seat);
  }
}
class StubHop implements LastHop {
  readonly calls: SeatMessage[] = [];
  async attempt(message: SeatMessage): Promise<LastHopResult> { this.calls.push(message); return { kind: "sent" }; }
}

/** A seat host that ends nothing: every kill is refused, so a removal that must kill a session fails there. */
class KillRefusingHost extends TmuxAdapter {
  constructor() { super(async () => { throw new Error("stand-in: no exec"); }, undefined, async () => { throw new Error("stand-in: no exec"); }); }
  override async killSession(): Promise<TmuxResult> { return { ok: false, code: "kill_refused", message: "kill refused" }; }
}

describe("a seat removed from a live rig (OF-209)", () => {
  let db: Database.Database;
  let rigs: RigRepository;
  let registry: SessionRegistry;
  let store: CountingStore;
  let gate: StubGate;
  let liveRigId: string;
  let nodeId: string;
  let first: string;
  let now: number;
  let hop: StubHop;
  let returned: Array<{ id: string; sender: string; reason: string }>;
  let lifecycle: RigLifecycleService;

  const senders: SenderReturn = { returnToSender: async (m, reason) => { returned.push({ id: m.id, sender: m.sender, reason }); return { kind: "returned", qitemId: "qitem-back" }; } };
  const held: HeldMessages = { status: () => "held" };
  const pumpWith = (hasGate: boolean) => new MessagePump({
    store, directory: new DbSeatDirectory(db), held, senders, clock: () => now, log: () => undefined,
    ports: { gateFor: () => (hasGate ? gate : null), hopFor: () => (hasGate ? hop : null) },
  });
  const send = (id: string) => store.accept({ id: messageId(id), seat: SEAT, sender: "exec-cos@eztrack", body: `body of ${id}` });
  /** What the live rig did: `rig remove`'s node deletion. */
  const removeSeat = () => { recordHistory(liveRigId, nodeId, "verify.ops", SEAT); rigs.deleteNode(nodeId); };
  /** What the daemon's event log keeps of a node after `deleteNode` (it survives on purpose): the launch that named it, and its removal. */
  const recordHistory = (rigId: string, node: string, logicalId: string, sessionName: string) => {
    const insert = db.prepare("INSERT INTO events (rig_id, node_id, type, payload) VALUES (?, ?, ?, ?)");
    insert.run(rigId, node, "node.launched", JSON.stringify({ type: "node.launched", rigId, nodeId: node, logicalId, sessionName }));
    insert.run(rigId, node, "node.removed", JSON.stringify({ type: "node.removed", rigId, nodeId: node }));
  };
  /** The successor: `rig add` of the same logical id, bound to the same session name, a new occupant. */
  const addSuccessor = () => {
    const node = rigs.addNode(liveRigId, "verify.ops", { runtime: "pi" });
    const successorGeneration = registry.mintOccupantTenure(node.id, "initial", "native-B").generationUuid;
    registry.updateBinding(node.id, { attachmentType: "hc", tmuxSession: SEAT });
    return successorGeneration;
  };

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    rigs = new RigRepository(db);
    registry = new SessionRegistry(db);
    // The ten archived "eztrack" rigs of the live database, as two: each held a verify.ops node whose binding was never written.
    for (let i = 0; i < 2; i++) {
      const old = rigs.createRig("eztrack");
      rigs.addNode(old.id, "verify.ops", { runtime: "codex" });
      // A seat only the archived rigs ever had: one of them even removed it, so the event log names it, under THEIR rig id.
      const ghost = rigs.addNode(old.id, "dev.ghost", { runtime: "codex" });
      registry.registerSession(ghost.id, "dev-ghost@eztrack");
      recordHistory(old.id, ghost.id, "dev.ghost", "dev-ghost@eztrack");
      db.prepare("UPDATE rigs SET archived_at = '2026-10-09 07:35:58' WHERE id = ?").run(old.id);
    }
    liveRigId = rigs.createRig("eztrack").id;
    const node = rigs.addNode(liveRigId, "verify.ops", { runtime: "codex" });
    nodeId = node.id;
    registry.registerSession(nodeId, SEAT);
    registry.updateBinding(nodeId, { attachmentType: "hc", tmuxSession: SEAT });
    first = registry.mintOccupantTenure(nodeId, "initial", "native-A").generationUuid;
    store = new CountingStore(db);
    gate = new StubGate();
    now = T0; hop = new StubHop(); returned = [];
    const eventBus = new EventBus(db);
    lifecycle = new RigLifecycleService({
      db, rigRepo: rigs, sessionRegistry: registry, discoveryRepo: new DiscoveryRepository(db), eventBus,
      queueRepo: new QueueRepository(db, eventBus, { validateRig: () => true }),
    });
  });
  afterEach(() => db.close());

  describe("its fate", () => {
    it("is not 'rig eztrack is archived' while the live rig of that name runs: it is vacant, waiting for a successor", () => {
      removeSeat();
      expect(new DbSeatDirectory(db).fate(SEAT).kind).toBe("vacant");
    });
    it("reads live again the moment a successor is added", () => {
      removeSeat();
      addSuccessor();
      expect(new DbSeatDirectory(db).fate(SEAT).kind).toBe("live");
    });
    it("is gone, with the true reason, once the rig is archived", () => {
      removeSeat();
      db.prepare("UPDATE rigs SET archived_at = '2026-11-03 08:40:00' WHERE id = ?").run(liveRigId);
      expect(new DbSeatDirectory(db).fate(SEAT)).toEqual({ kind: "gone", reason: "rig eztrack is archived" });
    });
    it("is gone, 'no seat ... in rig ...', when the live rig never had the seat even though archived rigs of that name did (their history is not this rig's)", () => {
      expect(new DbSeatDirectory(db).fate("dev-ghost@eztrack")).toEqual({ kind: "gone", reason: "no seat dev-ghost@eztrack in rig eztrack" });
    });
    it("is gone, 'no seat ... in rig ...', for a seat no rig ever had, with the live rig running", () => {
      expect(new DbSeatDirectory(db).fate("typo-seat@eztrack")).toEqual({ kind: "gone", reason: "no seat typo-seat@eztrack in rig eztrack" });
    });
    it("is vacant when the seat's removal is recorded only by its logical id (a node.added event, no session name)", () => {
      const node = rigs.addNode(liveRigId, "dev.byid", { runtime: "codex" });
      db.prepare("INSERT INTO events (rig_id, node_id, type, payload) VALUES (?, ?, 'node.added', ?)").run(liveRigId, node.id, JSON.stringify({ type: "node.added", rigId: liveRigId, nodeId: node.id, logicalId: "dev.byid" }));
      db.prepare("INSERT INTO events (rig_id, node_id, type, payload) VALUES (?, ?, 'node.removed', ?)").run(liveRigId, node.id, JSON.stringify({ type: "node.removed", rigId: liveRigId, nodeId: node.id }));
      rigs.deleteNode(node.id);
      expect(new DbSeatDirectory(db).fate("dev-byid@eztrack").kind).toBe("vacant");
    });
    it("is vacant when the seat's session name is not what its logical id composes to (recorded by the session name alone)", () => {
      const node = rigs.addNode(liveRigId, "dev.aliased", { runtime: "codex" });
      recordHistory(liveRigId, node.id, "dev.aliased", "other-name@eztrack");
      rigs.deleteNode(node.id);
      expect(new DbSeatDirectory(db).fate("other-name@eztrack").kind).toBe("vacant");
    });
    it("is gone when no rig of that name exists at all", () => {
      expect(new DbSeatDirectory(db).fate("verify-ops@nowhere")).toEqual({ kind: "gone", reason: "no seat verify-ops@nowhere exists" });
    });
  });

  describe.each([["a gate the seat still declares", true], ["no gate (the node is gone)", false]] as const)("the pump, with %s", (_name, hasGate) => {
    it("returns nothing to the sender, however many passes run, while the seat is vacant", async () => {
      send("m1"); send("m2");
      removeSeat();
      const pump = pumpWith(hasGate);
      for (let i = 0; i < 3; i++) { await pump.tick(); now += 30 * MIN; }
      expect(returned).toEqual([]);
      expect(row(db, "m1")).toMatchObject({ message_state: "accepted", message_closed_reason: null });
      expect(row(db, "m2")).toMatchObject({ message_state: "accepted", message_closed_reason: null });
      expect(hop.calls).toEqual([]);
      expect(store.headCalls, "the pump looked at the head a bounded number of times: it did not spin").toBeLessThan(20);
    }, 20_000);
    it("hands them to the successor, in order, labelled, when it is added", async () => {
      send("m1"); send("m2");
      removeSeat();
      const pump = pumpWith(true);
      await pump.tick();
      expect(returned).toEqual([]);
      addSuccessor();
      now += 2 * MIN;
      await pump.tick();
      expect(hop.calls.map((c) => c.body)).toEqual([`${PREVIOUS_OCCUPANT_LABEL} body of m1`]);
      expect(row(db, "m1")).toMatchObject({ message_previous_occupant: first });
      // One open message per seat: the second goes only after the first is received, and it is labelled too, in order.
      gate.record("m1");
      await pump.tick();
      expect(hop.calls.map((c) => c.body)).toEqual([`${PREVIOUS_OCCUPANT_LABEL} body of m1`, `${PREVIOUS_OCCUPANT_LABEL} body of m2`]);
      expect(row(db, "m1").message_state).toBe("received");
      expect(row(db, "m2")).toMatchObject({ message_previous_occupant: first });
    }, 20_000);
    it("returns them to their senders, with the true reason, only when the rig is archived", async () => {
      send("m1");
      removeSeat();
      const pump = pumpWith(hasGate);
      await pump.tick();
      expect(returned).toEqual([]);
      db.prepare("UPDATE rigs SET archived_at = '2026-11-03 08:40:00' WHERE id = ?").run(liveRigId);
      await pump.tick();
      expect(returned).toEqual([{ id: "m1", sender: "exec-cos@eztrack", reason: "rig eztrack is archived" }]);
    });
  });

  describe("rig send refuses a seat the live rig never had, and queues nothing", () => {
    const route = () => {
      const transport = new SessionTransport({ db, rigRepo: rigs, sessionRegistry: registry, tmuxAdapter: new TmuxAdapter(async () => { throw new Error("no server running on /x"); }) });
      const app = new Hono();
      app.use("*", async (c, next) => { c.set("sessionTransport" as never, transport); await next(); });
      app.route("/api/transport", transportRoutes());
      return (session: string) => app.request("/api/transport/send", { method: "POST", headers: { "content-type": "application/json", "x-openrig-session": "exec-cos@eztrack" }, body: JSON.stringify({ session, text: "hello" }) });
    };
    const outboxRows = () => (db.prepare("SELECT count(*) AS n FROM outbox_entries").get() as { n: number }).n;

    it("a seat only archived rigs of that name had: 404 'no seat ... in rig ...', nothing queued", async () => {
      const res = await route()("dev-ghost@eztrack");
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: string }).error).toContain("no seat dev-ghost@eztrack in rig eztrack");
      expect(outboxRows()).toBe(0);
    });
    it("control: a live seat resolves as before", async () => {
      expect(((await (await route()(SEAT)).json()) as { error?: string }).error ?? "").not.toContain("no seat");
    });
    it("a seat the live rig had and lost is not refused at the name: it may get a successor", async () => {
      // The archived twins also hold sessions under this name, as in the live database, so the name resolves.
      for (const archived of db.prepare("SELECT n.id AS id FROM nodes n JOIN rigs r ON r.id = n.rig_id WHERE r.archived_at IS NOT NULL AND n.logical_id = 'verify.ops'").all() as Array<{ id: string }>) registry.registerSession(archived.id, SEAT);
      removeSeat();
      const res = await route()(SEAT);
      expect(res.status).not.toBe(404);
    });
  });

  describe("a schema with no event log", () => {
    it("reads as 'the rig never had the seat' instead of throwing (a curated schema keeps no history)", () => {
      const bare = createDb();  // no migrations: no events table
      try { expect(rigHadSeat(bare, "r1", "dev@r")).toBe(false); } finally { bare.close(); }
    });
  });

  describe("rig remove", () => {
    it("reports the messages still waiting for the seat it removed, and does not close them", async () => {
      send("m1"); send("m2");
      db.prepare("UPDATE outbox_entries SET message_state = 'received' WHERE outbox_id = 'm2'").run();
      const result = await lifecycle.removeNode(liveRigId, "verify.ops");
      expect(result).toMatchObject({ ok: true, pendingMessageIds: ["m1"], reroutedQitemIds: [] });
      expect(row(db, "m1")).toMatchObject({ message_state: "accepted", message_closed_reason: null });
    });
    it("finds them by the seat's logical address when the node has no session row, and by its session name when that differs", async () => {
      const bare = rigs.addNode(liveRigId, "dev.bare", { runtime: "codex" });
      store.accept({ id: messageId("b1"), seat: "dev-bare@eztrack", sender: "exec-cos@eztrack", body: "x" });
      expect(await lifecycle.removeNode(liveRigId, bare.id)).toMatchObject({ ok: true, pendingMessageIds: ["b1"] });
      const named = rigs.addNode(liveRigId, "dev.named", { runtime: "codex" });
      registry.registerSession(named.id, "dev-alias@eztrack");
      store.accept({ id: messageId("n1"), seat: "dev-alias@eztrack", sender: "exec-cos@eztrack", body: "x" });
      expect(await lifecycle.removeNode(liveRigId, named.id)).toMatchObject({ ok: true, pendingMessageIds: ["n1"] });
    });
    it("reports the messages the typing guard holds for the seat separately, and they wait too", async () => {
      new OutboxHandler(db).retain({ outboxId: "h1", senderSession: "exec-cos@eztrack", destinationSession: SEAT, body: "held" }, { nodeId, session: SEAT, occupant: first, pane: null });
      new OutboxHandler(db).retain({ outboxId: "h2", senderSession: "exec-cos@eztrack", destinationSession: SEAT, body: "released" }, { nodeId, session: SEAT, occupant: first, pane: null });
      db.prepare("UPDATE outbox_entries SET message_hold_released_at = '2026-11-03T09:00:00.000Z' WHERE outbox_id = 'h2'").run();  // the guard let it go: not held any more
      new OutboxHandler(db).retain({ outboxId: "h3", senderSession: "exec-cos@eztrack", destinationSession: SEAT, body: "/compact" }, { nodeId, session: SEAT, occupant: first, pane: null });
      db.prepare("UPDATE outbox_entries SET class = 'command' WHERE outbox_id = 'h3'").run();  // a command is the guard owner's own, not a message
      send("m1");
      const result = await lifecycle.removeNode(liveRigId, "verify.ops");
      expect(result).toMatchObject({ ok: true, pendingMessageIds: ["m1"], heldMessageIds: ["h1"] });
      await pumpWith(true).tick();
      expect(returned).toEqual([]);
    });
    it("reports none when nothing waits", async () => {
      const result = await lifecycle.removeNode(liveRigId, "verify.ops");
      expect(result).toMatchObject({ ok: true, pendingMessageIds: [] });
    });
  });

  // OF-211: `rig shrink` deletes its pod's nodes through removeNode, so it leaves their messages vacant exactly as `rig remove` does, and said nothing of them.
  // `rig release --delete` is a different path (it deletes the rig's record, not nodes through removeNode): a deleted rig has no seat for a successor, so
  // its open messages go back to their senders. Both now report the ids; the wording of what happens next is the CLI's (remove-pending-messages.test.ts).
  // Deployed entrypoints: routes/rigs.ts `DELETE /:rigId/pods/:podRef` -> RigLifecycleService.shrinkPod, `POST /:id/release` -> releaseRig.
  describe("rig shrink", () => {
    const POD_SEATS = ["dev-a@eztrack", "dev-b@eztrack"];
    const shrinkFixture = () => {
      const pod = new PodRepository(db).createPod(liveRigId, "crew", "Crew");
      for (const member of ["a", "b"]) {
        const node = rigs.addNode(liveRigId, `dev.${member}`, { runtime: "codex", podId: pod.id });
        // What the launch left in the event log (the removal itself is written by shrinkPod, through removeNode).
        db.prepare("INSERT INTO events (rig_id, node_id, type, payload) VALUES (?, ?, 'node.launched', ?)").run(liveRigId, node.id, JSON.stringify({ type: "node.launched", rigId: liveRigId, nodeId: node.id, logicalId: `dev.${member}`, sessionName: `dev-${member}@eztrack` }));
      }
      return pod;
    };
    it("reports the messages still waiting for every member it removed, and does not close them", async () => {
      const pod = shrinkFixture();
      for (const [id, seat] of [["a1", POD_SEATS[0]!], ["b1", POD_SEATS[1]!], ["a2", POD_SEATS[0]!]] as const) store.accept({ id: messageId(id), seat, sender: "exec-cos@eztrack", body: id });
      db.prepare("UPDATE outbox_entries SET message_state = 'received' WHERE outbox_id = 'a2'").run();  // delivered: not waiting
      send("keep");  // verify.ops is not in the pod
      const result = await lifecycle.shrinkPod(liveRigId, pod.id);
      expect(result).toMatchObject({ ok: true, status: "ok", removedLogicalIds: ["dev.a", "dev.b"], pendingMessageIds: ["a1", "b1"], heldMessageIds: [] });
      expect(row(db, "a1")).toMatchObject({ message_state: "accepted", message_closed_reason: null });
      expect(new DbSeatDirectory(db).fate(POD_SEATS[0]!).kind).toBe("vacant");
      await pumpWith(true).tick();
      expect(returned).toEqual([]);
    });
    it("reports the messages the typing guard holds for a removed member separately", async () => {
      const pod = shrinkFixture();
      const member = db.prepare("SELECT id FROM nodes WHERE logical_id = 'dev.a'").get() as { id: string };
      new OutboxHandler(db).retain({ outboxId: "h1", senderSession: "exec-cos@eztrack", destinationSession: POD_SEATS[0]!, body: "held" }, { nodeId: member.id, session: POD_SEATS[0]!, occupant: first, pane: null });
      const result = await lifecycle.shrinkPod(liveRigId, pod.id);
      expect(result).toMatchObject({ ok: true, pendingMessageIds: [], heldMessageIds: ["h1"] });
    });
    it("a partial shrink still reports what waits for the members it did remove", async () => {
      const pod = shrinkFixture();
      const b = db.prepare("SELECT id FROM nodes WHERE logical_id = 'dev.b'").get() as { id: string };
      registry.registerSession(b.id, POD_SEATS[1]!);  // dev.b has a session its host will not kill; dev.a (removed first) has none
      store.accept({ id: messageId("a1"), seat: POD_SEATS[0]!, sender: "exec-cos@eztrack", body: "a1" });
      store.accept({ id: messageId("b1"), seat: POD_SEATS[1]!, sender: "exec-cos@eztrack", body: "b1" });
      const stuck = new KillRefusingHost();
      const eventBus = new EventBus(db);
      const partial = new RigLifecycleService({ db, rigRepo: rigs, sessionRegistry: registry, discoveryRepo: new DiscoveryRepository(db), eventBus,
        queueRepo: new QueueRepository(db, eventBus, { validateRig: () => true }), tmuxAdapter: stuck });
      const result = await partial.shrinkPod(liveRigId, pod.id);
      expect(result).toMatchObject({ ok: true, status: "partial", removedLogicalIds: ["dev.a"], pendingMessageIds: ["a1"], heldMessageIds: [] });
    });
    it("reports none when nothing waits", async () => {
      const pod = shrinkFixture();
      expect(await lifecycle.shrinkPod(liveRigId, pod.id)).toMatchObject({ ok: true, pendingMessageIds: [], heldMessageIds: [] });
    });
  });

  describe("rig release --delete", () => {
    const releaseFixture = (name: string) => {
      const rig = rigs.createRig(name);
      const node = rigs.addNode(rig.id, "dev.a", { runtime: "codex" });
      const session = registry.registerSession(node.id, `dev-a@${name}`);
      db.prepare("UPDATE sessions SET origin = 'claimed' WHERE id = ?").run(session.id);
      return { rig, node };
    };
    it("reports the messages open for the rig's seats, which go back to their senders because the rig is gone", async () => {
      const { rig } = releaseFixture("rel");
      store.accept({ id: messageId("r1"), seat: "dev-a@rel", sender: "exec-cos@eztrack", body: "r1" });
      const result = await lifecycle.releaseRig(rig.id, { delete: true });
      expect(result).toMatchObject({ ok: true, status: "ok", deleted: true, pendingMessageIds: ["r1"], heldMessageIds: [] });
      expect(new DbSeatDirectory(db).fate("dev-a@rel")).toEqual({ kind: "gone", reason: "no seat dev-a@rel exists" });
      await pumpWith(true).tick();
      expect(returned.map((r) => r.id)).toEqual(["r1"]);
    });
    it("finds them by the seat's logical address when the node has no session row, and by its session name when that differs", async () => {
      const { rig } = releaseFixture("rel2");
      rigs.addNode(rig.id, "dev.bare", { runtime: "codex" });
      const named = rigs.addNode(rig.id, "dev.named", { runtime: "codex" });
      const s = registry.registerSession(named.id, "alias-n@rel2");
      db.prepare("UPDATE sessions SET origin = 'claimed' WHERE id = ?").run(s.id);
      store.accept({ id: messageId("b1"), seat: "dev-bare@rel2", sender: "exec-cos@eztrack", body: "b1" });
      store.accept({ id: messageId("n1"), seat: "alias-n@rel2", sender: "exec-cos@eztrack", body: "n1" });
      expect(await lifecycle.releaseRig(rig.id, { delete: true })).toMatchObject({ ok: true, deleted: true, pendingMessageIds: ["b1", "n1"] });
    });
    it("reports the messages the typing guard holds for the rig's seats separately", async () => {
      const { rig, node } = releaseFixture("rel3");
      new OutboxHandler(db).retain({ outboxId: "h1", senderSession: "exec-cos@eztrack", destinationSession: "dev-a@rel3", body: "held" }, { nodeId: node.id, session: "dev-a@rel3", occupant: first, pane: null });
      expect(await lifecycle.releaseRig(rig.id, { delete: true })).toMatchObject({ ok: true, pendingMessageIds: [], heldMessageIds: ["h1"] });
    });
    it("reports none when the rig is kept (nothing is deleted, so nothing is returned)", async () => {
      const { rig } = releaseFixture("kept");
      store.accept({ id: messageId("k1"), seat: "dev-a@kept", sender: "exec-cos@eztrack", body: "k1" });
      expect(await lifecycle.releaseRig(rig.id)).toMatchObject({ ok: true, deleted: false, pendingMessageIds: [], heldMessageIds: [] });
    });
  });
});
