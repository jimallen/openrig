import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { MessagePump } from "../src/domain/seat-messaging/message-pump.js";
import { MessageStore } from "../src/domain/seat-messaging/message-store.js";
import { MessageLedger } from "../src/domain/seat-messaging/message-ledger.js";
import { DbSeatDirectory } from "../src/domain/seat-messaging/seat-directory.js";
import { FarSeatDirectory } from "../src/domain/seat-messaging/far-daemon.js";
import { PREVIOUS_OCCUPANT_LABEL } from "../src/domain/seat-messaging/message-label.js";
import { messageId, type GateLookup, type GateRecord, type LastHop, type LastHopResult, type MessageId, type SeatGate, type SeatMessage } from "../src/domain/seat-messaging/ports.js";
import type { HeldMessages, SenderReturn, SenderReturnResult } from "../src/domain/seat-messaging/pump-ports.js";

// Deliver, labelled (Jim, decision 65): a message that reaches a different occupant than the one it was sent to carries
// "[sent to the previous occupant of this seat]", whatever state it was in when the seat changed hands. Real proof at cbf6e1ca (Pi seat,
// `rig seat launch --fresh --stop --startup-from stored`, a message taken by the runner during a long turn): it arrived once in the
// successor with no label and message_previous_occupant null, because an ordinary message was never bound to an occupant at all, and the pump
// relabels only a row bound to an occupant generation. Claude's case 7 at 07b21ea6 had the same null. The database, directory, tenures and
// pump are real; the gate and the hop are stubs (the hops' own text is pinned in seat-hops.test.ts), and the clock is far from wall clock.
const T0 = 7_000_000;
const MIN = 60_000;
const SEAT = "dev-impl@r";

class StubGate implements SeatGate {
  readonly version = 3;
  readonly seen = new Map<string, GateRecord>();
  record(id: MessageId): void { this.seen.set(id, { id, recordedAt: "1970-01-01T02:00:00.000Z", nonce: null }); }
  async lookup(_seat: string, id: MessageId): Promise<GateLookup> {
    const record = this.seen.get(id);
    return record ? { kind: "seen", record } : { kind: "not_seen" };
  }
}
class StubHop implements LastHop {
  readonly calls: SeatMessage[] = [];
  async attempt(message: SeatMessage): Promise<LastHopResult> { this.calls.push(message); return { kind: "sent" }; }
}

type Runtime = "claude-code" | "codex" | "pi";
const RUNTIMES: readonly Runtime[] = ["claude-code", "codex", "pi"];
const row = (db: Database.Database, id: string) => db.prepare("SELECT * FROM outbox_entries WHERE outbox_id = ?").get(id) as Record<string, unknown>;

describe.each(RUNTIMES)("a message waiting across an occupant change: %s seat", (runtime) => {
  let db: Database.Database;
  let registry: SessionRegistry;
  let store: MessageStore;
  let nodeId: string;
  let now: number;
  let gate: StubGate;
  let hop: StubHop;
  let returned: Array<{ id: string; sender: string; reason: string }>;
  let returnResult: SenderReturnResult;
  let pump: MessagePump;
  let first: string;

  const senders: SenderReturn = { returnToSender: async (m, reason) => { returned.push({ id: m.id, sender: m.sender, reason }); return returnResult; } };
  const held: HeldMessages = { status: () => "held" };
  const bodies = () => hop.calls.map((c) => c.body);
  /** A new occupant: another native session, so the tenure ledger mints the next generation (a fresh launch). */
  const newOccupant = (native = "native-B") => registry.mintOccupantTenure(nodeId, "initial", native).generationUuid;
  const send = (id: string, body = `body of ${id}`) => store.accept({ id: messageId(id), seat: SEAT, sender: "lead@r", body });
  const tick = async () => { await pump.tick(); };

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    registry = new SessionRegistry(db);
    const rig = new RigRepository(db).createRig("r");
    nodeId = new RigRepository(db).addNode(rig.id, "dev.impl", { runtime }).id;
    first = registry.mintOccupantTenure(nodeId, "initial", "native-A").generationUuid;
    store = new MessageStore(db);
    now = T0; gate = new StubGate(); hop = new StubHop(); returned = []; returnResult = { kind: "returned", qitemId: "qitem-back" };
    pump = new MessagePump({
      store, directory: new DbSeatDirectory(db), held, senders, clock: () => now, log: () => undefined,
      ports: { gateFor: () => gate, hopFor: () => hop },
    });
  });
  afterEach(() => db.close());

  describe("the row is bound to the occupant it was sent to", () => {
    it("by the pump's accept", () => {
      send("m1");
      expect(row(db, "m1").occupant_generation).toBe(first);
    });
    it("by the ledger's accept (a seat the pump does not serve)", () => {
      new MessageLedger(db).accept({ id: "l1", seat: SEAT, body: "x", sender: "lead@r", identityProvenance: "transport:v1" });
      expect(row(db, "l1").occupant_generation).toBe(first);
    });
    it("by a wake or nudge written straight to the outbox", () => {
      new OutboxHandler(db).record({ outboxId: "w1", senderSession: "daemon@kernel", destinationSession: SEAT, body: "wake", messageClass: "nudge" });
      expect(row(db, "w1").occupant_generation).toBe(first);
    });
    it("by a message the typing guard holds", () => {
      new OutboxHandler(db).retain({ outboxId: "h1", senderSession: "lead@r", destinationSession: SEAT, body: "held" }, { nodeId, session: SEAT, occupant: first, pane: null });
      expect(row(db, "h1").occupant_generation).toBe(first);
    });
    it("not when the seat has no occupant yet, or is not a seat here", () => {
      store.accept({ id: messageId("nobody"), seat: "ghost@nowhere", sender: "lead@r", body: "x" });
      expect(row(db, "nobody").occupant_generation).toBeNull();
    });
    it("never for a seat on another host: its own daemon binds its own row", () => {
      store.accept({ id: messageId("far1"), seat: "far:h2:dev-impl@r", sender: "lead@r", body: "x" });
      expect(row(db, "far1").occupant_generation).toBeNull();
    });
    it("never for a Command, which the pump does not carry, nor for an audit row recorded by hand", () => {
      const outbox = new OutboxHandler(db);
      outbox.record({ outboxId: "c1", senderSession: "lead@r", destinationSession: SEAT, body: "/compact", messageClass: "command" });
      outbox.record({ outboxId: "a1", senderSession: "lead@r", destinationSession: SEAT, body: "audit", origin: "manual-record" });
      expect(row(db, "c1").occupant_generation).toBeNull();
      expect(row(db, "a1").occupant_generation).toBeNull();
    });
    it("not for a seat in an archived rig", () => {
      db.prepare("UPDATE rigs SET archived_at = '2026-01-01 00:00:00' WHERE name = 'r'").run();
      store.accept({ id: messageId("arch1"), seat: SEAT, sender: "lead@r", body: "x" });
      expect(row(db, "arch1").occupant_generation).toBeNull();
    });
    it("a lifecycle row keeps what its producer bound, or nothing: it is for the occupant that asked, never the latest by default", () => {
      store.accept({ id: messageId("life1"), seat: SEAT, sender: "lead@r", body: "x", messageClass: "lifecycle" });
      expect(row(db, "life1").occupant_generation).toBeNull();
      store.accept({ id: messageId("life2"), seat: SEAT, sender: "lead@r", body: "x", messageClass: "lifecycle", occupantGeneration: "g-explicit" });
      expect(row(db, "life2").occupant_generation).toBe("g-explicit");
    });
  });

  describe("every state a row can be in when the seat changes hands, then arrives once, labelled, with the stored body untouched", () => {
    const labelled = (id: string, n = 1) => {
      expect(bodies().filter((b) => b === `${PREVIOUS_OCCUPANT_LABEL} body of ${id}`)).toHaveLength(n);
      expect(row(db, id)).toMatchObject({ body: `body of ${id}`, message_previous_occupant: first, occupant_generation: null });
    };

    it("accepted, never attempted", async () => {
      send("m1");
      newOccupant();
      await tick();
      labelled("m1");
      expect(returned).toEqual([]);
    });
    it("attempting, attempts 1: the old occupant's runner took it during a long turn, no gate record (the Pi proof)", async () => {
      send("m1");
      await tick();
      expect(bodies()).toEqual(["body of m1"]);
      expect(row(db, "m1")).toMatchObject({ message_state: "attempting", attempts: 1 });
      newOccupant();
      now += 2 * MIN;
      await tick();
      expect(bodies()).toEqual(["body of m1", `${PREVIOUS_OCCUPANT_LABEL} body of m1`]);
      expect(row(db, "m1")).toMatchObject({ attempts: 2, message_previous_occupant: first });
    });
    it("attempting, attempts 0, paused by the typing guard", async () => {
      send("m1");
      db.prepare("UPDATE outbox_entries SET message_state = 'attempting', attempts = 0, message_pause_reason = 'guard_held' WHERE outbox_id = 'm1'").run();
      newOccupant();
      await tick();
      labelled("m1");
    });
    it("attempting after several attempts, backed off", async () => {
      send("m1");
      for (let i = 0; i < 3; i++) { await tick(); now += 30 * MIN; }
      expect(row(db, "m1").attempts).toBe(3);
      newOccupant();
      await tick();
      expect(bodies().at(-1)).toBe(`${PREVIOUS_OCCUPANT_LABEL} body of m1`);
      expect(bodies().slice(0, 3)).toEqual(["body of m1", "body of m1", "body of m1"]);
    });
    it("a long message with its first part already received by the old occupant: the rest goes labelled", async () => {
      send("m1");
      db.prepare("UPDATE outbox_entries SET message_state = 'attempting', attempts = 1, message_parts = 3, message_parts_done = 1 WHERE outbox_id = 'm1'").run();
      newOccupant();
      await tick();
      expect(bodies()).toEqual([`${PREVIOUS_OCCUPANT_LABEL} body of m1`]);
      expect(row(db, "m1")).toMatchObject({ message_parts_done: 1, message_previous_occupant: first });
    });
    it("held by the typing guard, and the guard lifts on the successor", async () => {
      new OutboxHandler(db).retain({ outboxId: "h1", senderSession: "lead@r", destinationSession: SEAT, body: "body of h1" }, { nodeId, session: SEAT, occupant: first, pane: null });
      const changed: HeldMessages = { status: () => "occupant_changed" };
      const heldPump = new MessagePump({ store, directory: new DbSeatDirectory(db), held: changed, senders, clock: () => now, log: () => undefined, ports: { gateFor: () => gate, hopFor: () => hop } });
      newOccupant();
      await heldPump.tick();
      await heldPump.tick();
      expect(bodies()).toEqual([`${PREVIOUS_OCCUPANT_LABEL} body of h1`]);
      expect(row(db, "h1").message_previous_occupant).not.toBeNull();
      expect(row(db, "h1").occupant_generation, "labelled, it is no longer bound to the occupant it was sent to (the pump's rebind)").toBeNull();
    });
    it("a wake or nudge the drain wrote and the pump adopted", async () => {
      new OutboxHandler(db).record({ outboxId: "w1", senderSession: "daemon@kernel", destinationSession: SEAT, body: "body of w1", messageClass: "nudge" });
      store.adoptClaimed([messageId("w1")]);
      newOccupant();
      await tick();
      labelled("w1");
    });
    it("a far seat's row on this daemon: not stopped by the missing local occupant, and not labelled here", async () => {
      store.accept({ id: messageId("f1"), seat: "far:h2:dev-impl@r", sender: "lead@r", body: "body of f1" });
      const farPump = new MessagePump({ store, directory: new FarSeatDirectory(new DbSeatDirectory(db)), held, senders, clock: () => now, log: () => undefined, ports: { gateFor: () => gate, hopFor: () => hop } });
      await farPump.tick();
      newOccupant();
      now += 2 * MIN;
      await farPump.tick();
      expect(bodies()).toEqual(["body of f1", "body of f1"]);
    });
  });

  describe("no over-labelling", () => {
    it("a retry on the same occupant carries no label, at any attempt", async () => {
      send("m1");
      for (let i = 0; i < 3; i++) { await tick(); now += 30 * MIN; }
      expect(bodies()).toEqual(["body of m1", "body of m1", "body of m1"]);
      expect(row(db, "m1").message_previous_occupant).toBeNull();
    });
    it("a relaunch that continues the same native session is the same occupant", async () => {
      send("m1");
      await tick();
      expect(newOccupant("native-A")).toBe(first);
      now += 2 * MIN;
      await tick();
      expect(bodies()).toEqual(["body of m1", "body of m1"]);
      expect(row(db, "m1")).toMatchObject({ message_previous_occupant: null, occupant_generation: first });
    });
    it("a message sent to the new occupant is not labelled by the change before it", async () => {
      newOccupant();
      send("m2");
      await tick();
      expect(bodies()).toEqual(["body of m2"]);
    });
    it("one change labels a message once, and a second change does not unlabel or double it", async () => {
      send("m1");
      newOccupant("native-B");
      await tick();
      newOccupant("native-C");
      now += 2 * MIN;
      await tick();
      expect(bodies()).toEqual([`${PREVIOUS_OCCUPANT_LABEL} body of m1`, `${PREVIOUS_OCCUPANT_LABEL} body of m1`]);
      expect(row(db, "m1").message_previous_occupant).toBe(first);
    });
    it("a message the successor received is not touched by a later change", async () => {
      send("m1");
      await tick();
      gate.record(messageId("m1"));
      await tick();
      expect(row(db, "m1").message_state).toBe("received");
      newOccupant();
      await tick();
      expect(row(db, "m1")).toMatchObject({ message_state: "received", message_previous_occupant: null });
      expect(bodies()).toEqual(["body of m1"]);
    });
  });

  describe("a lifecycle row's return, in each state", () => {
    const lifecycle = (id: string, sender: string) => store.accept({ id: messageId(id), seat: SEAT, sender, body: `body of ${id}`, messageClass: "lifecycle", occupantGeneration: first });
    it("accepted: it never reaches the successor, and goes back to its sender", async () => {
      lifecycle("life1", "lead@r");
      newOccupant();
      await tick();
      expect(bodies()).toEqual([]);
      expect(returned.map((r) => [r.id, r.sender])).toEqual([["life1", "lead@r"]]);
      expect(row(db, "life1")).toMatchObject({ message_state: "undeliverable", delivery_state: "failed" });
      expect(row(db, "life1").message_previous_occupant, "it was never labelled for delivery: it ends, it does not go on").toBeNull();
    });
    it("attempting: the same", async () => {
      lifecycle("life1", "lead@r");
      await tick();
      expect(bodies()).toEqual(["body of life1"]);
      newOccupant();
      now += 2 * MIN;
      await tick();
      expect(bodies()).toEqual(["body of life1"]);
      expect(returned.map((r) => r.id)).toEqual(["life1"]);
    });
    it("from a sender no queue can reach (the compaction enforcer sends as `unknown`): never delivered, ended with the reason, not returned", async () => {
      returnResult = { kind: "no_return_path", reason: "no sender a queue can reach (unknown)" };
      lifecycle("life1", "unknown");
      newOccupant();
      await tick();
      expect(bodies()).toEqual([]);
      expect(row(db, "life1")).toMatchObject({ message_state: "undeliverable" });
      expect(String(row(db, "life1").message_end_reason ?? row(db, "life1").failure_reason ?? JSON.stringify(row(db, "life1")))).toContain("not returned");
    });
    it("content ahead of it still goes labelled while the lifecycle row ends: Jim's rule is per class", async () => {
      send("m1");
      lifecycle("life1", "lead@r");
      newOccupant();
      await tick();
      await tick();
      expect(bodies()).toEqual([`${PREVIOUS_OCCUPANT_LABEL} body of m1`]);
      expect(returned.map((r) => r.id)).toEqual(["life1"]);
    });
  });
});
