// Seat Messaging S3: the pump's production answers about the fleet (rig records, the typing guard, the sender's queue), and its `rig
// health` rows. Real database, real RigRepository, real SeatDeliveryGuard, real QueueRepository. Times are far from wall clock.
import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository, QueueRepositoryError } from "../src/domain/queue-repository.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { MessageStore } from "../src/domain/seat-messaging/message-store.js";
import { MESSAGE_STUCK_AFTER_MS, SeatMessagingHealthSource } from "../src/domain/seat-messaging/message-health.js";
import { DbSeatDirectory, GuardHeldMessages, QueueSenderReturn, returnQitemId } from "../src/domain/seat-messaging/seat-directory.js";
import { messageId } from "../src/domain/seat-messaging/ports.js";
import type { SeatMessagingPorts } from "../src/domain/seat-messaging/pump-ports.js";

describe("the fleet, as the pump reads it", () => {
  let db: Database.Database;
  let rigs: RigRepository;
  beforeEach(() => { db = createDb(); migrate(db, ALL_MIGRATIONS); rigs = new RigRepository(db); });

  const seat = (rigName: string, logical = "dev") => {
    const rig = rigs.createRig(rigName);
    const node = rigs.addNode(rig.id, logical, { role: "worker", runtime: "claude-code" });
    const name = `${logical}@${rigName}`;
    const registry = new SessionRegistry(db);
    const session = registry.registerSession(node.id, name);
    registry.updateBinding(node.id, { attachmentType: "hc", tmuxSession: name });
    return { rigId: rig.id, nodeId: node.id, name, session };
  };
  const archive = (rigId: string) => db.prepare("UPDATE rigs SET archived_at = ? WHERE id = ?").run("1970-01-02T00:00:00.000Z", rigId);
  const tenure = (nodeId: string, ordinal: number, uuid: string) => db.prepare("INSERT INTO occupant_tenures (id, node_id, generation_ordinal, generation_uuid, kind) VALUES (?, ?, ?, ?, 'fresh')").run(uuid, nodeId, ordinal, uuid);

  describe("a seat's fate (decision 1)", () => {
    it("a seat of an unarchived rig is live, stopped or not, with its latest occupant", () => {
      const s = seat("r1");
      tenure(s.nodeId, 10, "g1");
      tenure(s.nodeId, 11, "g2");
      expect(new DbSeatDirectory(db).fate(s.name)).toEqual({ kind: "live", occupantGeneration: "g2" });
    });

    it("an archived rig's seat is gone for good, and the reason names the rig", () => {
      const s = seat("r1");
      archive(s.rigId);
      expect(new DbSeatDirectory(db).fate(s.name)).toEqual({ kind: "gone", reason: "rig r1 is archived" });
    });

    it("a rig recreated under the same name is that seat's successor at the same address, so the seat reads live", () => {
      const old = seat("r1");
      archive(old.rigId);
      db.prepare("UPDATE bindings SET tmux_session = ? WHERE node_id = ?").run(old.name, old.nodeId);
      const rig = rigs.createRig("r1b");
      const node = rigs.addNode(rig.id, "dev", { role: "worker", runtime: "claude-code" });
      new SessionRegistry(db).updateBinding(node.id, { attachmentType: "hc", tmuxSession: old.name });
      expect(new DbSeatDirectory(db).fate(old.name).kind).toBe("live");
    });

    it("a seat no record names is gone: a deleted rig can never be archived", () => {
      expect(new DbSeatDirectory(db).fate("ghost@none")).toEqual({ kind: "gone", reason: "no seat ghost@none exists" });
    });

    it("two live seats under one name prove nothing", () => {
      const a = seat("r1");
      const rig = rigs.createRig("r2");
      const node = rigs.addNode(rig.id, "dev", { role: "worker", runtime: "claude-code" });
      new SessionRegistry(db).updateBinding(node.id, { attachmentType: "hc", tmuxSession: a.name });
      expect(new DbSeatDirectory(db).fate(a.name)).toEqual({ kind: "unknown" });
    });
  });

  describe("a held message's guard", () => {
    const guarded = () => { const guard = new SeatDeliveryGuard(db, (t) => resolveGuardTarget(db, t)); return { guard, held: new GuardHeldMessages(guard) }; };

    it("held while the guard is on, lifted when off with the same occupant, occupant_changed with another", async () => {
      const s = seat("r1");
      tenure(s.nodeId, 10, "g1");
      const { guard, held } = guarded();
      const binding = guard.target(s.name);
      await guard.set(s.nodeId, true, "jim", "typing");
      expect(held.status(binding, s.name)).toBe("held");
      await guard.set(s.nodeId, false, "jim", "done");
      expect(held.status(binding, s.name)).toBe("lifted");
      tenure(s.nodeId, 11, "g2");
      expect(held.status(binding, s.name)).toBe("occupant_changed");
      expect(held.status(null, s.name)).toBe("occupant_changed");
      await guard.set(s.nodeId, true, "jim", "typing");
      expect(held.status(null, s.name)).toBe("held");
    });

    it("an activation still pending counts as held", () => {
      const s = seat("r1");
      const { guard, held } = guarded();
      const binding = guard.target(s.name);
      db.prepare("INSERT INTO seat_delivery_guards (node_id, desired, effective, actor, reason, changed_at) VALUES (?, 0, 1, 'a', 'r', 't')").run(s.nodeId);
      expect(held.status(binding, s.name)).toBe("held");
    });
  });

  describe("back to the sender", () => {
    const queue = () => new QueueRepository(db, new EventBus(db), { validateRig: (s: string) => s.endsWith("@ok") } as never);

    it("makes one queue item carrying the text, and a crash that repeats it finds the same item", async () => {
      seat("ok", "lead");
      const back = new QueueSenderReturn(queue());
      const message = { id: messageId("m1"), seat: "dev@gone", sender: "lead@ok", body: "the text itself" };
      const first = await back.returnToSender(message, "rig gone is archived");
      const second = await back.returnToSender(message, "rig gone is archived");
      expect(first).toEqual({ kind: "returned", qitemId: returnQitemId("m1") });
      expect(second).toEqual(first);
      const rows = db.prepare("SELECT destination_session, body FROM queue_items").all() as Array<{ destination_session: string; body: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.destination_session).toBe("lead@ok");
      expect(rows[0]!.body).toContain("the text itself");
      expect(rows[0]!.body).toContain("rig gone is archived");
    });

    it("no queue item is made for a sender with no queue", async () => {
      const back = new QueueSenderReturn({ create: async () => { throw new Error("must not be asked"); } });
      for (const sender of ["unknown", "watchdog@system", "model-monitor@system", "daemon@kernel"]) {
        const result = await back.returnToSender({ id: messageId("m1"), seat: "dev@r", sender, body: "t" }, "gone");
        expect(result).toMatchObject({ kind: "no_return_path" });
      }
      expect(await new QueueSenderReturn({ create: async () => ({}) as never }).returnToSender({ id: messageId("m1"), seat: "dev@r", sender: "human@kernel", body: "t" }, "gone")).toMatchObject({ kind: "returned" });
    });

    it("a sender no queue can admit has no return path; any other failure is 'not now'", async () => {
      const refused = new QueueSenderReturn({ create: async () => { throw new QueueRepositoryError("unknown_destination_rig", "no such rig"); } });
      const message = { id: messageId("m1"), seat: "dev@gone", sender: "x@nowhere", body: "t" };
      expect(await refused.returnToSender(message, "r")).toEqual({ kind: "no_return_path", reason: "no such rig" });
      const busy = new QueueSenderReturn({ create: async () => { throw new QueueRepositoryError("human_registry_unavailable", "registry down"); } });
      await expect(busy.returnToSender(message, "r")).rejects.toThrow("registry down");
    });
  });

  describe("rig health", () => {
    const NOW = new Date("1999-06-01T12:00:00.000Z");
        const gated: SeatMessagingPorts = { gateFor: (s) => (s === "dev@r" ? { version: 1, lookup: async () => ({ kind: "not_seen" }) } : null), hopFor: () => null };
    const source = () => new SeatMessagingHealthSource(new MessageStore(db), gated, () => NOW);
    const reasons = () => source().coverage().map((c) => (c as { reason: string }).reason);
    const age = (id: string, ms: number) => db.prepare("UPDATE outbox_entries SET ts_dispatched = ? WHERE outbox_id = ?").run(new Date(NOW.getTime() - ms).toISOString(), id);
    const accept = (id: string, s = "dev@r") => new MessageStore(db).accept({ id: messageId(id), seat: s, sender: "lead@r", body: "x" });

    it("says nothing with nothing to say", () => {
      expect(source().coverage()).toEqual([]);
      accept("fresh");
      age("fresh", MESSAGE_STUCK_AFTER_MS);
      expect(source().coverage()).toEqual([]);
    });

    it("names received and undeliverable rows of the last 24 h, and not older ones", () => {
      const store = new MessageStore(db);
      accept("r1"); accept("r2"); accept("u1"); accept("u2");
      store.recordReceived({ id: messageId("r1"), recordedAt: new Date(NOW.getTime() - 1000).toISOString(), nonce: null }, 1);
      store.recordReceived({ id: messageId("r2"), recordedAt: new Date(NOW.getTime() - 25 * 3_600_000).toISOString(), nonce: null }, 1);
      store.recordUndeliverable(messageId("u1"), "x", null, new Date(NOW.getTime() - 1000).toISOString());
      store.recordUndeliverable(messageId("u2"), "x", null, new Date(NOW.getTime() - 25 * 3_600_000).toISOString());
      const row = reasons();
      expect(row[0]).toBe("1 message(s) received and 0 returned to their senders as undeliverable, in the last 24 h.");
      expect(row[1]).toContain("1 message(s) could not be delivered and have no sender to return them to");
      expect(row[1]).toContain("u1");
      expect(row).toHaveLength(2);
      expect(source().coverage()[0]).toMatchObject({ source: "seat-messaging", status: "notice", partial: false });
      accept("u3");
      store.recordUndeliverable(messageId("u3"), "x", "q1", new Date(NOW.getTime() - 1000).toISOString());
      expect(reasons()[0]).toBe("1 message(s) received and 1 returned to their senders as undeliverable, in the last 24 h.");
      expect(reasons()[1]).toContain("1 message(s) could not");
    });

    it("names a stuck seat's oldest message, its attempts and why it is paused, one row per seat", () => {
      const store = new MessageStore(db);
      accept("old"); accept("new");
      age("old", MESSAGE_STUCK_AFTER_MS + 60_000);
      age("new", MESSAGE_STUCK_AFTER_MS + 30_000);
      store.claimAttempt(store.headOf("dev@r")!, 1);
      store.recordHopPause(messageId("old"), "busy", 2);
      store.claimAttempt(store.headOf("dev@r")!, 3);
      store.claimAttempt(store.headOf("dev@r")!, 3);
      store.recordRefusal(messageId("old"), "no");
      const row = reasons();
      expect(row).toHaveLength(1);
      expect(row[0]).toContain("2 message(s) to dev@r not received (oldest old, 16 min, 2 attempt(s), last refused: no)");
    });

    it("names a seat with no agent at once, and says trying alone will not help", () => {
      const store = new MessageStore(db);
      accept("a1");
      store.claimAttempt(store.headOf("dev@r")!, 1);
      store.recordHopPause(messageId("a1"), "agent_absent", 2);
      const row = reasons();
      expect(row).toHaveLength(1);
      expect(row[0]).toContain("its agent is not running in its terminal");
      expect(row[0]).toContain("a1");
    });

    it("names a dialog at once: nothing moves until a person answers it", () => {
      const store = new MessageStore(db);
      accept("b1");
      store.claimAttempt(store.headOf("dev@r")!, 1);
      store.recordHopPause(messageId("b1"), "blocked", 2);
      const row = reasons();
      expect(row).toHaveLength(1);
      expect(row[0]).toContain("waiting on a dialog");
      expect(row[0]).toContain("b1");
    });

    it("names a draft at once: only a person can clear it, and they may not know a message waits behind it", () => {
      const store = new MessageStore(db);
      accept("d1");
      store.claimAttempt(store.headOf("dev@r")!, 1);
      store.recordHopPause(messageId("d1"), "draft", 2);
      const row = reasons();
      expect(row).toHaveLength(1);
      expect(row[0]).toContain("wait behind a draft");
      expect(row[0]).toContain("d1");
    });

    it("says a stuck seat has no gate, so nobody thinks the pump is on it", () => {
      accept("u1", "ungated@r");
      age("u1", MESSAGE_STUCK_AFTER_MS + 60_000);
      expect(reasons()[0]).toContain("declares no gate");
    });
  });
});
