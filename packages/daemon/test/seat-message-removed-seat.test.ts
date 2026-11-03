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
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { RigLifecycleService } from "../src/domain/rig-lifecycle-service.js";
import { MessagePump } from "../src/domain/seat-messaging/message-pump.js";
import { MessageStore } from "../src/domain/seat-messaging/message-store.js";
import { DbSeatDirectory } from "../src/domain/seat-messaging/seat-directory.js";
import { PREVIOUS_OCCUPANT_LABEL } from "../src/domain/seat-messaging/message-label.js";
import { messageId, type GateLookup, type LastHop, type LastHopResult, type SeatGate, type SeatMessage } from "../src/domain/seat-messaging/ports.js";
import type { HeldMessages, SenderReturn } from "../src/domain/seat-messaging/pump-ports.js";

const T0 = 7_000_000;
const MIN = 60_000;
const SEAT = "verify-ops@eztrack";
const row = (db: Database.Database, id: string) => db.prepare("SELECT * FROM outbox_entries WHERE outbox_id = ?").get(id) as Record<string, unknown>;

class StubGate implements SeatGate {
  readonly version = 3;
  async lookup(): Promise<GateLookup> { return { kind: "not_seen" }; }
}
class StubHop implements LastHop {
  readonly calls: SeatMessage[] = [];
  async attempt(message: SeatMessage): Promise<LastHopResult> { this.calls.push(message); return { kind: "sent" }; }
}

describe("a seat removed from a live rig (OF-209)", () => {
  let db: Database.Database;
  let rigs: RigRepository;
  let registry: SessionRegistry;
  let store: MessageStore;
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
    ports: { gateFor: () => (hasGate ? new StubGate() : null), hopFor: () => (hasGate ? hop : null) },
  });
  const send = (id: string) => store.accept({ id: messageId(id), seat: SEAT, sender: "exec-cos@eztrack", body: `body of ${id}` });
  /** What the live rig did: `rig remove`'s node deletion. */
  const removeSeat = () => rigs.deleteNode(nodeId);
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
      db.prepare("UPDATE rigs SET archived_at = '2026-10-09 07:35:58' WHERE id = ?").run(old.id);
    }
    liveRigId = rigs.createRig("eztrack").id;
    const node = rigs.addNode(liveRigId, "verify.ops", { runtime: "codex" });
    nodeId = node.id;
    registry.registerSession(nodeId, SEAT);
    registry.updateBinding(nodeId, { attachmentType: "hc", tmuxSession: SEAT });
    first = registry.mintOccupantTenure(nodeId, "initial", "native-A").generationUuid;
    store = new MessageStore(db);
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
    });
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
    });
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
    it("reports none when nothing waits", async () => {
      const result = await lifecycle.removeNode(liveRigId, "verify.ops");
      expect(result).toMatchObject({ ok: true, pendingMessageIds: [] });
    });
  });
});
