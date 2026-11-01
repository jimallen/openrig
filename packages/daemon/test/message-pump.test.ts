// Seat Messaging S3, the pump core, against a stub gate (census-delivery-guarantees-20261101, part 2, "The pump"). A database is real;
// the gate and the hop are stubs, because which runtimes have a real gate waits on M1-M10. Clocks start far from wall clock, so a pump
// that read Date.now() instead of its clock would attempt or skip on the wrong schedule and fail here.
import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { ATTEMPT_BACKOFF_MS, MessagePump, PUMP_PAUSE_RECHECK_MS, nextAttemptDelayMs, type MessagePumpDeps } from "../src/domain/seat-messaging/message-pump.js";
import { MESSAGE_LANES, MessageStore } from "../src/domain/seat-messaging/message-store.js";
import { messageId, type GateLookup, type GateRecord, type LastHop, type LastHopResult, type MessageId, type SeatGate, type SeatMessage } from "../src/domain/seat-messaging/ports.js";
import type { HeldMessages, HoldStatus, SeatDirectory, SeatFate, SenderReturn, SenderReturnResult } from "../src/domain/seat-messaging/pump-ports.js";

const T0 = 7_000_000;  // 1970: far from wall clock on purpose
const MIN = 60_000;

class StubGate implements SeatGate {
  readonly version = 3;
  readonly seen = new Map<string, GateRecord>();
  lookups = 0;
  answer: GateLookup | "throw" | null = null;
  record(id: MessageId, nonce: string | null = null): void { this.seen.set(id, { id, recordedAt: "1970-01-01T02:00:00.000Z", nonce }); }
  async lookup(_seat: string, id: MessageId): Promise<GateLookup> {
    this.lookups++;
    if (this.answer === "throw") throw new Error("gate read blew up");
    if (this.answer) return this.answer;
    const record = this.seen.get(id);
    return record ? { kind: "seen", record } : { kind: "not_seen" };
  }
}

class StubHop implements LastHop {
  readonly calls: SeatMessage[] = [];
  result: LastHopResult | "throw" | Promise<LastHopResult> = { kind: "sent" };
  async attempt(message: SeatMessage): Promise<LastHopResult> {
    this.calls.push(message);
    if (this.result === "throw") throw new Error("hop blew up");
    return this.result;
  }
}

class World {
  now = T0;
  readonly gate = new StubGate();
  readonly hop = new StubHop();
  readonly fates = new Map<string, SeatFate>();
  readonly holds = new Map<string, HoldStatus>();
  readonly returned: Array<{ id: string; sender: string; reason: string }> = [];
  returnResult: SenderReturnResult | "throw" = { kind: "returned", qitemId: "qitem-back" };
  ungated = new Set<string>();
  readonly directory: SeatDirectory = { fate: (seat) => this.fates.get(seat) ?? { kind: "live", occupantGeneration: null } };
  readonly held: HeldMessages = { status: (binding) => this.holds.get(binding.nodeId) ?? "held" };
  readonly senders: SenderReturn = {
    returnToSender: async (m, reason) => {
      if (this.returnResult === "throw") throw new Error("queue busy");
      this.returned.push({ id: m.id, sender: m.sender, reason });
      return this.returnResult;
    },
  };
  deps(store: MessageStore): MessagePumpDeps {
    return {
      store, directory: this.directory, held: this.held, senders: this.senders, clock: () => this.now, log: () => undefined,
      ports: { gateFor: (s) => (this.ungated.has(s) ? null : this.gate), hopFor: (s) => (this.ungated.has(s) ? null : this.hop) },
    };
  }
}

const row = (db: Database.Database, id: string) => db.prepare("SELECT * FROM outbox_entries WHERE outbox_id = ?").get(id) as Record<string, unknown>;

describe("the message pump", () => {
  let db: Database.Database;
  let store: MessageStore;
  let w: World;
  let pump: MessagePump;
  const SEAT = "dev@r";
  const accept = (id: string, seat = SEAT, extra: { occupantGeneration?: string; sender?: string } = {}) =>
    store.accept({ id: messageId(id), seat, sender: extra.sender ?? "lead@r", body: `body of ${id}`, occupantGeneration: extra.occupantGeneration });
  const hold = (id: string, nodeId = "n1", seat = SEAT) => new OutboxHandler(db).retain(
    { outboxId: id, senderSession: "lead@r", destinationSession: seat, body: `held ${id}` }, { nodeId, session: seat, occupant: "g1", pane: null });

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    store = new MessageStore(db);
    w = new World();
    pump = new MessagePump(w.deps(store));
  });

  describe("attempts", () => {
    it("attempts a new message at once, and sending alone settles nothing: only a gate record moves it to received", async () => {
      accept("m1");
      await pump.tick();
      expect(w.hop.calls.map((c) => [c.ids, c.seat, c.body, c.messageClass, c.lane])).toEqual([[["m1"], SEAT, "body of m1", "content", 2]]);
      expect(row(db, "m1")).toMatchObject({ message_state: "attempting", attempts: 1, delivery_state: "pending" });

      w.gate.record(messageId("m1"), "nonce-1");
      await pump.tick();
      expect(row(db, "m1")).toMatchObject({ message_state: "received", delivery_state: "delivered", ack_evidence: "gate_seen", message_gate_version: 3, message_gate_nonce: "nonce-1" });
      expect(row(db, "m1").delivered_at).toBe("1970-01-01T02:00:00.000Z");
      expect(w.hop.calls).toHaveLength(1);
    });

    it("a record that names another id is not this message's record", async () => {
      accept("m1");
      await pump.tick();
      w.gate.answer = { kind: "seen", record: { id: messageId("other"), recordedAt: "1970-01-01T02:00:00.000Z", nonce: null } };
      await pump.tick();
      expect(row(db, "m1").message_state).toBe("attempting");
    });

    it("a repeat carries the same id and body", async () => {
      accept("m1");
      await pump.tick();
      w.now += ATTEMPT_BACKOFF_MS[0];
      await pump.tick();
      expect(w.hop.calls.map((c) => [c.ids[0], c.body])).toEqual([["m1", "body of m1"], ["m1", "body of m1"]]);
    });

    it("backs off 2, 5, then 15 minutes, and stays capped at 15", async () => {
      expect(ATTEMPT_BACKOFF_MS).toEqual([2 * MIN, 5 * MIN, 15 * MIN]);
      expect([1, 2, 3, 4, 50].map((n) => nextAttemptDelayMs(n))).toEqual([2 * MIN, 5 * MIN, 15 * MIN, 15 * MIN, 15 * MIN]);
      accept("m1");
      await pump.tick();
      let attempts = 1;
      for (const wait of [2 * MIN, 5 * MIN, 15 * MIN, 15 * MIN]) {
        w.now += wait - 1;
        await pump.tick();
        expect(w.hop.calls, `one ms before ${wait}`).toHaveLength(attempts);
        w.now += 1;
        await pump.tick();
        attempts++;
        expect(w.hop.calls, `at ${wait}`).toHaveLength(attempts);
      }
    });

    it("keeps one attempt in flight per seat, while another seat goes on", async () => {
      accept("m1");
      accept("o1", "qa@r");
      let finish!: (r: LastHopResult) => void;
      const hop = new StubHop();
      hop.result = new Promise<LastHopResult>((r) => { finish = r; });
      const other = new StubHop();
      pump = new MessagePump({ ...w.deps(store), ports: { gateFor: () => w.gate, hopFor: (s) => (s === SEAT ? hop : other) } });
      const first = pump.tick();
      await Promise.resolve();
      await new Promise((r) => setImmediate(r));
      w.now += 60 * MIN;
      await pump.tick();  // m1's attempt has not returned, and its next time has passed
      expect(hop.calls).toHaveLength(1);
      expect(other.calls.map((c) => c.ids[0])).toEqual(["o1", "o1"]);
      finish({ kind: "sent" });
      await first;
      await pump.tick();
      expect(hop.calls).toHaveLength(2);
    });

    it("is FIFO per seat: the next message waits for the head's record, and goes in the same pass once it comes", async () => {
      accept("m1");
      accept("m2");
      await pump.tick();
      w.now += 60 * MIN;
      await pump.tick();
      expect(w.hop.calls.map((c) => c.ids[0])).toEqual(["m1", "m1"]);
      expect(row(db, "m2")).toMatchObject({ message_state: "accepted", attempts: 0 });
      w.gate.record(messageId("m1"));
      await pump.tick();
      expect(w.hop.calls.map((c) => c.ids[0])).toEqual(["m1", "m1", "m2"]);
    });

    it("leaves a row that is not a message alone, and a seat with no gate alone", async () => {
      new OutboxHandler(db).record({ outboxId: "plain", senderSession: "a@r", destinationSession: SEAT, body: "x" });
      w.ungated.add("ungated@r");
      accept("u1", "ungated@r");
      await pump.tick();
      expect(w.hop.calls).toEqual([]);
      expect(row(db, "plain").message_state).toBeNull();
      expect(row(db, "u1")).toMatchObject({ message_state: "accepted", attempts: 0, message_next_attempt_ms: null });
    });
  });

  describe("FIFO per seat per lane", () => {
    const inLane = (id: string, lane: 0 | 1 | 2) => store.accept({ id: messageId(id), seat: SEAT, sender: "lead@r", body: id, lane });

    it("the lowest open lane goes first, whatever was accepted first, and each lane is FIFO in itself", async () => {
      inLane("c1", MESSAGE_LANES.content);
      inLane("p1", MESSAGE_LANES.compaction);
      inLane("s1", MESSAGE_LANES.startup);
      inLane("s2", MESSAGE_LANES.startup);
      await pump.tick();
      for (const id of ["s1", "s2", "p1"]) {
        w.gate.record(messageId(id));
        await pump.tick();
      }
      expect(w.hop.calls.map((c) => c.ids[0])).toEqual(["s1", "s2", "p1", "c1"]);
    });

    it("content waits while a startup message is open, for as long as it takes", async () => {
      inLane("c1", MESSAGE_LANES.content);
      inLane("s1", MESSAGE_LANES.startup);
      await pump.tick();
      w.now += 600 * MIN;
      await pump.tick();
      expect(w.hop.calls.map((c) => c.ids[0])).toEqual(["s1", "s1"]);
      expect(row(db, "c1").attempts).toBe(0);
    });

    it("a row defaults to the content lane", () => {
      accept("m1");
      expect(row(db, "m1").lane).toBe(2);
    });
  });

  describe("the pump's API (S4 design)", () => {
    it("accept returns the id, commits before any attempt, and attempts at once", async () => {
      const id = pump.accept({ id: messageId("m1"), seat: SEAT, sender: "lead@r", body: "x" });
      expect(id).toBe("m1");
      expect(row(db, "m1").message_state).not.toBeNull();
      await new Promise((r) => setImmediate(r));
      expect(w.hop.calls.map((c) => c.ids[0])).toEqual(["m1"]);
    });

    it("accept can name a first attempt later than now, kept across a restart", async () => {
      pump.accept({ id: messageId("m1"), seat: SEAT, sender: "lead@r", body: "x", firstAttemptAtMs: T0 + 20_000 });
      await new MessagePump(w.deps(store)).tick();
      expect(w.hop.calls).toEqual([]);
      w.now += 20_000;
      await new MessagePump(w.deps(store)).tick();
      expect(w.hop.calls).toHaveLength(1);
    });

    it("awaitReceived says received once the gate records, open at its deadline, and unknown for no message", async () => {
      accept("m1");
      await pump.tick();
      expect(await pump.awaitReceived(messageId("m1"), 0)).toBe("open");
      expect(await pump.awaitReceived(messageId("nope"), 0)).toBe("unknown");
      const waiter = pump.awaitReceived(messageId("m1"), 60 * MIN);
      w.gate.record(messageId("m1"));
      await pump.tick();
      expect(await waiter).toBe("received");
    });

    it("awaitReceived ends on undeliverable", async () => {
      accept("m1");
      w.fates.set(SEAT, { kind: "gone", reason: "archived" });
      await pump.tick();
      expect(await pump.awaitReceived(messageId("m1"), 60 * MIN)).toBe("undeliverable");
    });

    it("cancel ends an open row with no notice, and a late record changes nothing", async () => {
      accept("m1");
      await pump.tick();
      expect(pump.cancel(messageId("m1"), "handover unwound")).toBe(true);
      expect(row(db, "m1")).toMatchObject({ message_state: "undeliverable", delivery_state: "failed", ack_evidence: "superseded", message_closed_reason: "handover unwound" });
      expect(w.returned).toEqual([]);
      w.gate.record(messageId("m1"));
      w.now += 60 * MIN;
      await pump.tick();
      expect(row(db, "m1").message_state).toBe("undeliverable");
      expect(w.hop.calls).toHaveLength(1);
      expect(pump.cancel(messageId("m1"), "again")).toBe(false);
    });

    it("never carries a command: /compact stays with the enforcer", async () => {
      expect(() => accept2({ messageClass: "command" })).toThrow(/stays with its owner/);
      expect(store.seatsWithOpenMessages()).toEqual([]);
    });
    const accept2 = (extra: { messageClass: string }) => store.accept({ id: messageId("cmd"), seat: SEAT, sender: "lead@r", body: "/compact", ...extra });

    it("a lifecycle message waits when the seat's occupant cannot be read: it never guesses it is the same one", async () => {
      accept("m1", SEAT, { occupantGeneration: "g1" });
      w.fates.set(SEAT, { kind: "live", occupantGeneration: null });
      await pump.tick();
      expect(w.hop.calls).toEqual([]);
      expect(row(db, "m1").message_state).toBe("accepted");
    });
  });

  describe("one driver per row", () => {
    it("a wake row the pump owns is not in the boot drain's list; a legacy one still is", () => {
      const outbox = new OutboxHandler(db);
      outbox.record({ outboxId: "wake-intent-legacy", senderSession: "a@r", destinationSession: SEAT, body: "x" });
      accept("wake-intent-pumped");
      expect(outbox.listPending("wake-intent-").map((e) => e.outboxId)).toEqual(["wake-intent-legacy"]);
    });
  });

  describe("pauses are reasons on attempting, not states", () => {
    for (const reason of ["busy", "blocked", "guard_held", "seat_stopped"] as const) {
      it(`${reason}: the row stays attempting with the reason, spends no backoff, and is back after the recheck`, async () => {
        accept("m1");
        w.hop.result = { kind: "paused", reason };
        await pump.tick();
        expect(row(db, "m1")).toMatchObject({ message_state: "attempting", message_pause_reason: reason, attempts: 0, delivery_state: "pending" });
        w.now += PUMP_PAUSE_RECHECK_MS - 1;
        await pump.tick();
        expect(w.hop.calls).toHaveLength(1);
        w.now += 1;
        w.hop.result = { kind: "sent" };
        await pump.tick();
        expect(w.hop.calls).toHaveLength(2);
        expect(row(db, "m1")).toMatchObject({ message_state: "attempting", message_pause_reason: null, attempts: 1, message_next_attempt_ms: w.now + 2 * MIN });
      });
    }

    it("a gate that cannot be read proves nothing: no attempt, and the reason shows", async () => {
      accept("m1");
      w.gate.answer = { kind: "unavailable", cause: "seat down" };
      await pump.tick();
      expect(w.hop.calls).toEqual([]);
      expect(row(db, "m1")).toMatchObject({ message_state: "attempting", message_pause_reason: "gate_unavailable", attempts: 0 });
    });

    it("a gate read that throws is the same as one that cannot be read", async () => {
      accept("m1");
      w.gate.answer = "throw";
      await pump.tick();
      expect(w.hop.calls).toEqual([]);
      expect(row(db, "m1")).toMatchObject({ message_pause_reason: "gate_unavailable", message_state: "attempting" });
    });

    it("a refused or thrown hop stays attempting and retries on the backoff: no state needs a person", async () => {
      accept("m1");
      w.hop.result = { kind: "refused", reason: "core refused" };
      await pump.tick();
      expect(row(db, "m1")).toMatchObject({ message_state: "attempting", attempts: 1, message_last_refusal: "core refused", delivery_state: "pending" });
      w.now += 2 * MIN;
      w.hop.result = "throw";
      await pump.tick();
      expect(row(db, "m1")).toMatchObject({ message_state: "attempting", attempts: 2 });
      expect(String(row(db, "m1").message_last_refusal)).toContain("hop blew up");
      w.now += 5 * MIN;
      w.hop.result = { kind: "sent" };
      await pump.tick();
      expect(row(db, "m1").message_last_refusal).toBeNull();
    });
  });

  describe("driven by the database", () => {
    it("a new pump on the same database keeps the schedule a crashed one committed before its attempt", async () => {
      const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pump-"));
      try {
        const path = join(dir, "d.sqlite");
        const a = createDb(path);
        migrate(a, ALL_MIGRATIONS);
        const first = new MessageStore(a);
        first.accept({ id: messageId("m1"), seat: SEAT, sender: "lead@r", body: "x" });
        const hung = new StubHop();
        hung.result = new Promise<LastHopResult>(() => undefined);  // the crash: this attempt never reports back
        void new MessagePump({ ...w.deps(first), ports: { gateFor: () => w.gate, hopFor: () => hung } }).tick();
        await new Promise((r) => setImmediate(r));
        expect(hung.calls).toHaveLength(1);
        a.close();

        const b = createDb(path);
        const second = new MessageStore(b);
        const restarted = new MessagePump(w.deps(second));
        await restarted.tick();
        expect(w.hop.calls).toEqual([]);  // the row's own time, not an in-memory one, says when
        expect(row(b, "m1")).toMatchObject({ message_state: "attempting", attempts: 1, message_next_attempt_ms: T0 + 2 * MIN });
        w.now += 2 * MIN;
        await restarted.tick();
        expect(w.hop.calls.map((c) => c.ids[0])).toEqual(["m1"]);
        expect(row(b, "m1").attempts).toBe(2);
        b.close();
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    it("a gate record that arrived while the daemon was down settles the row with no attempt", async () => {
      accept("m1");
      await pump.tick();
      w.gate.record(messageId("m1"));
      w.now += 60 * MIN;
      await new MessagePump(w.deps(store)).tick();
      expect(row(db, "m1").message_state).toBe("received");
      expect(w.hop.calls).toHaveLength(1);
    });

    it("start ticks at once and stop ends the timer", async () => {
      accept("m1");
      pump = new MessagePump({ ...w.deps(store), timing: { tickMs: 3_600_000 } });
      pump.start();  // no timer fires in this test: only the pass at start can have attempted
      await new Promise((r) => setTimeout(r, 30));
      pump.stop();
      expect(w.hop.calls).toHaveLength(1);
    });

    it("the timer keeps it going, and stop ends the timer and any pass", async () => {
      accept("m1");
      pump = new MessagePump({ ...w.deps(store), timing: { tickMs: 5 } });
      pump.start();
      await new Promise((r) => setTimeout(r, 30));
      w.gate.record(messageId("m1"));
      await new Promise((r) => setTimeout(r, 30));
      expect(row(db, "m1").message_state).toBe("received");
      pump.stop();
      accept("m2");
      await new Promise((r) => setTimeout(r, 30));
      await pump.tick();
      expect(w.hop.calls.map((c) => c.ids[0])).toEqual(["m1"]);
      expect(row(db, "m2").message_state).toBe("accepted");
    });
  });

  describe("held messages (decision 4)", () => {
    it("stay held while the guard is on, and rejoin ahead of anything newer when it lifts", async () => {
      hold("h1");
      accept("m2");
      await pump.tick();
      expect(row(db, "h1")).toMatchObject({ delivery_state: "retained", message_state: null });
      expect(w.hop.calls.map((c) => c.ids[0])).toEqual(["m2"]);
      w.gate.record(messageId("m2"));
      accept("m3");

      w.holds.set("n1", "lifted");
      await pump.tick();
      expect(w.hop.calls.map((c) => c.ids[0])).toEqual(["m2", "h1"]);
      expect(w.hop.calls[1]!.body).toBe("held h1");
      expect(row(db, "h1")).toMatchObject({ delivery_state: "retained", message_state: "attempting" });
      expect(row(db, "m3").attempts).toBe(0);

      w.gate.record(messageId("h1"));
      await pump.tick();
      expect(row(db, "h1")).toMatchObject({ delivery_state: "delivered", message_state: "received" });
      expect(w.hop.calls.map((c) => c.ids[0])).toEqual(["m2", "h1", "m3"]);
    });

    it("are not replayed to an occupant that did not hold them", async () => {
      hold("h1");
      w.holds.set("n1", "occupant_changed");
      await pump.tick();
      expect(w.hop.calls).toEqual([]);
      expect(row(db, "h1")).toMatchObject({ delivery_state: "retained", message_state: null });
    });

    it("are not taken for a seat with no gate", async () => {
      hold("h1");
      w.ungated.add(SEAT);
      w.holds.set("n1", "lifted");
      await pump.tick();
      expect(row(db, "h1")).toMatchObject({ delivery_state: "retained", message_state: null });
    });

    it("a held message an operator retires leaves the pump and frees the head", async () => {
      hold("h1");
      accept("m2");
      w.holds.set("n1", "lifted");
      await pump.tick();
      expect(w.hop.calls.map((c) => c.ids[0])).toEqual(["h1"]);
      new OutboxHandler(db).retire("h1", "jim", "not needed");
      w.now += 60 * MIN;
      await pump.tick();
      expect(w.hop.calls.map((c) => c.ids[0])).toEqual(["h1", "m2"]);
      expect(row(db, "h1").delivery_state).toBe("retired");
    });

    it("a row with an unreadable binding is left to retire", async () => {
      hold("h1");
      db.prepare("UPDATE outbox_entries SET guard_binding = '{broken' WHERE outbox_id = 'h1'").run();
      w.holds.set("n1", "lifted");
      await pump.tick();
      expect(row(db, "h1").message_state).toBeNull();
    });
  });

  describe("a seat gone for good (decision 1)", () => {
    it("moves to the successor when the seat has one: same id and body, and the successor's gate settles it", async () => {
      accept("m1");
      await pump.tick();
      w.fates.set(SEAT, { kind: "successor", seat: "dev2@r" });
      await pump.tick();
      expect(row(db, "m1")).toMatchObject({ destination_session: "dev2@r", message_state: "attempting", attempts: 1, body: "body of m1" });
      await pump.tick();
      expect(w.hop.calls.map((c) => [c.ids[0], c.seat])).toEqual([["m1", SEAT], ["m1", "dev2@r"]]);
      expect(w.returned).toEqual([]);
    });

    it("otherwise goes back to the sender once, and ends undeliverable", async () => {
      accept("m1");
      w.fates.set(SEAT, { kind: "gone", reason: "rig r is archived" });
      await pump.tick();
      await pump.tick();
      expect(w.hop.calls).toEqual([]);
      expect(w.returned).toEqual([{ id: "m1", sender: "lead@r", reason: "rig r is archived" }]);
      expect(row(db, "m1")).toMatchObject({ message_state: "undeliverable", delivery_state: "failed", ack_evidence: "seat_gone", ack_detail: "qitem-back", message_closed_reason: "rig r is archived" });
    });

    it("drains the whole seat, not only the head", async () => {
      accept("m1");
      accept("m2");
      w.fates.set(SEAT, { kind: "gone", reason: "archived" });
      await pump.tick();
      expect(w.returned.map((r) => r.id)).toEqual(["m1", "m2"]);
    });

    it("a queue that cannot take it now leaves the row open, to try again", async () => {
      accept("m1");
      w.fates.set(SEAT, { kind: "gone", reason: "archived" });
      w.returnResult = "throw";
      await pump.tick();
      expect(row(db, "m1").message_state).toBe("accepted");
      w.returnResult = { kind: "returned", qitemId: "q2" };
      await pump.tick();
      expect(row(db, "m1")).toMatchObject({ message_state: "undeliverable", ack_detail: "q2" });
    });

    it("a sender no queue can reach ends the row, and says why", async () => {
      accept("m1");
      w.fates.set(SEAT, { kind: "gone", reason: "archived" });
      w.returnResult = { kind: "no_return_path", reason: "sender rig is gone" };
      await pump.tick();
      expect(row(db, "m1")).toMatchObject({ message_state: "undeliverable", ack_detail: null });
      expect(String(row(db, "m1").message_closed_reason)).toBe("archived; not returned: sender rig is gone");
    });

    it("a gate record beats the seat's end: the message arrived", async () => {
      accept("m1");
      await pump.tick();
      w.gate.record(messageId("m1"));
      w.fates.set(SEAT, { kind: "gone", reason: "archived" });
      await pump.tick();
      expect(row(db, "m1").message_state).toBe("received");
      expect(w.returned).toEqual([]);
    });

    it("a gone seat that never declared a gate still ends: it has no gate to wait on", async () => {
      w.ungated.add(SEAT);
      accept("m1");
      w.fates.set(SEAT, { kind: "gone", reason: "archived" });
      await pump.tick();
      expect(row(db, "m1").message_state).toBe("undeliverable");
    });

    it("an unknown fate proves nothing", async () => {
      accept("m1");
      w.fates.set(SEAT, { kind: "unknown" });
      await pump.tick();
      expect(row(db, "m1").message_state).toBe("attempting");
      expect(w.hop.calls).toHaveLength(1);
      expect(w.returned).toEqual([]);
    });

    it("a lifecycle message never reaches a successor or a new occupant", async () => {
      accept("m1", SEAT, { occupantGeneration: "g1" });
      w.fates.set(SEAT, { kind: "successor", seat: "dev2@r" });
      await pump.tick();
      expect(row(db, "m1")).toMatchObject({ message_state: "undeliverable", destination_session: SEAT });
      accept("m2", "qa@r", { occupantGeneration: "g1" });
      w.fates.set("qa@r", { kind: "live", occupantGeneration: "g2" });
      await pump.tick();
      expect(row(db, "m2").message_state).toBe("undeliverable");
      accept("m3", "ok@r", { occupantGeneration: "g1" });
      w.fates.set("ok@r", { kind: "live", occupantGeneration: "g1" });
      await pump.tick();
      expect(w.hop.calls.map((c) => [c.ids[0], c.occupantGeneration])).toEqual([["m3", "g1"]]);
    });
  });
});

describe("the message store", () => {
  let db: Database.Database;
  let store: MessageStore;
  beforeEach(() => { db = createDb(); migrate(db, ALL_MIGRATIONS); store = new MessageStore(db); });
  const input = { id: messageId("m1"), seat: "dev@r", sender: "lead@r", body: "x" };

  it("commits the row on accept, and accepting the id again is the same row", () => {
    expect(store.accept(input)).toMatchObject({ state: "accepted", attempts: 0, nextAttemptAtMs: null });
    db.prepare("UPDATE outbox_entries SET attempts = 4, message_state = 'attempting' WHERE outbox_id = 'm1'").run();
    expect(store.accept(input)).toMatchObject({ state: "attempting", attempts: 4 });
  });

  it("refuses an id that names other content or another seat, and an id already settled", () => {
    store.accept(input);
    expect(() => store.accept({ ...input, body: "y" })).toThrow(/different content/);
    expect(() => store.accept({ ...input, seat: "qa@r" })).toThrow(/different content/);
    new OutboxHandler(db).record({ outboxId: "old", senderSession: "lead@r", destinationSession: "dev@r", body: "x" });
    new OutboxHandler(db).markDelivered("old");
    expect(() => store.accept({ ...input, id: messageId("old") })).toThrow(/already delivered/);
  });

  it("adopts a row the send path wrote and has not settled", () => {
    new OutboxHandler(db).record({ outboxId: "m1", senderSession: "lead@r", destinationSession: "dev@r", body: "x" });
    expect(store.accept(input).state).toBe("accepted");
  });

  it("a settled message does not reopen on a late accept", () => {
    store.accept(input);
    expect(store.recordReceived({ id: input.id, recordedAt: "1970-01-01T00:00:00.000Z", nonce: null }, 1)).toBe(true);
    expect(() => store.accept(input)).toThrow(/already delivered/);
    expect(store.headOf("dev@r")).toBeNull();
    expect(store.recordReceived({ id: input.id, recordedAt: "1970-01-01T00:00:01.000Z", nonce: null }, 1)).toBe(false);
  });

  it("a gate that stays unreadable never brings the backoff forward", () => {
    store.accept(input);
    const claimed = store.headOf("dev@r")!;
    store.claimAttempt(claimed, 900_000);
    store.recordGateUnavailable(input.id, 100);
    expect(store.headOf("dev@r")).toMatchObject({ nextAttemptAtMs: 900_000, pauseReason: "gate_unavailable" });
  });

  it("the old reader still reads every state's row", () => {
    store.accept(input);
    const handler = new OutboxHandler(db);
    expect(handler.getById("m1")?.deliveryState).toBe("pending");
    store.recordReceived({ id: input.id, recordedAt: "1970-01-01T00:00:00.000Z", nonce: null }, 1);
    expect(handler.getById("m1")).toMatchObject({ deliveryState: "delivered", ackEvidence: "gate_seen" });
    store.accept({ ...input, id: messageId("m2") });
    store.recordUndeliverable(messageId("m2"), "gone", null, "1970-01-01T00:00:00.000Z");
    expect(handler.getById("m2")).toMatchObject({ deliveryState: "failed", ackEvidence: "seat_gone" });
  });
});
