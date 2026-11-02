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
import { ATTEMPT_BACKOFF_MS, MessagePump, PREVIOUS_OCCUPANT_LABEL, PUMP_PAUSE_RECHECK_MS, nextAttemptDelayMs, type MessagePumpDeps } from "../src/domain/seat-messaging/message-pump.js";
import { PumpHandOff, type MessageHandOff } from "../src/domain/seat-messaging/hand-off.js";
import { MessageLedger } from "../src/domain/seat-messaging/message-ledger.js";
import { MESSAGE_LANES, MessageStore } from "../src/domain/seat-messaging/message-store.js";
import { partId } from "../src/domain/seat-messaging/long-message.js";
import { messageId, type GateLookup, type GateRecord, type LastHop, type LastHopResult, type MessageId, type SeatGate, type SeatMessage } from "../src/domain/seat-messaging/ports.js";
import { MessageObligations, type HeldMessages, type HoldStatus, type SeatDirectory, type SeatFate, type SenderReturn, type SenderReturnResult } from "../src/domain/seat-messaging/pump-ports.js";

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
  afterReceived?: (message: SeatMessage) => Promise<void>;
  forget?: (seat: string) => void;
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
  readonly seatHolds = new Map<string, HoldStatus>();
  readonly held: HeldMessages = { status: (binding, seat) => (binding ? this.holds.get(binding.nodeId) : this.seatHolds.get(seat)) ?? "held" };
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
  const hold = (id: string, nodeId = "n1", seat = SEAT, messageClass?: "lifecycle") => new OutboxHandler(db).retain(
    { outboxId: id, senderSession: "lead@r", destinationSession: seat, body: `held ${id}`, messageClass }, { nodeId, session: seat, occupant: "g1", pane: null });

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

      const nonce = store.nonceOf(messageId("m1"))!;
      w.gate.record(messageId("m1"), nonce);
      await pump.tick();
      expect(row(db, "m1")).toMatchObject({ message_state: "received", delivery_state: "delivered", ack_evidence: "gate_seen", message_gate_version: 3, gate_nonce: nonce });
      expect(row(db, "m1").delivered_at).toBe("1970-01-01T02:00:00.000Z");
      expect(w.hop.calls).toHaveLength(1);
    });

    it("a record that names another id is not this message's record, and settles neither row", async () => {
      accept("m1");
      accept("m2");
      await pump.tick();
      w.gate.answer = { kind: "seen", record: { id: messageId("m2"), recordedAt: "1970-01-01T02:00:00.000Z", nonce: null } };
      await pump.tick();
      expect(row(db, "m1").message_state).toBe("attempting");
      expect(row(db, "m2").message_state).toBe("accepted");
    });

    it("a record under another nonce is forged: the real message has not arrived, and the pump keeps going", async () => {
      accept("m1");
      await pump.tick();
      w.gate.record(messageId("m1"), "f".repeat(32));
      w.now += 2 * MIN;
      await pump.tick();
      expect(row(db, "m1")).toMatchObject({ message_state: "attempting", attempts: 2 });
    });

    it("looks up before every attempt: a record a live recovery found costs no resend", async () => {
      accept("m1");
      await pump.tick();
      w.now += 2 * MIN;
      w.gate.record(messageId("m1"), store.nonceOf(messageId("m1")));
      await pump.tick();
      expect(w.hop.calls).toHaveLength(1);
      expect(row(db, "m1").message_state).toBe("received");
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
      expect(row(db, "u1")).toMatchObject({ message_state: "accepted", attempts: 0, next_attempt_at: null });
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

  describe("a wake group (S4 design, N2): N rows, one text, one marker each", () => {
    let handOff: PumpHandOff;
    const wake = (id: string, seat = SEAT) => new OutboxHandler(db).record({ outboxId: id, senderSession: "lead@r", destinationSession: seat, body: `wake ${id}`, auditPointer: `q-${id}` });
    const pair = async () => { wake("w1"); wake("w2"); handOff.adoptClaimed(["w1", "w2"]); await settle(); };
    const settle = () => new Promise((r) => setImmediate(r));
    beforeEach(() => { handOff = new PumpHandOff(store, pump, w.deps(store).ports); });

    it("goes out as one attempt: one text, every id, each row counted once", async () => {
      await pair();
      expect(w.hop.calls.map((c) => [c.ids, c.body])).toEqual([[["w1", "w2"], "wake w1\nwake w2"]]);
      expect([row(db, "w1").attempts, row(db, "w2").attempts]).toEqual([1, 1]);
      expect(store.nonceOf(messageId("w2"))).not.toBeNull();
    });

    it("the text is in staging order whichever row started the delivery", async () => {
      wake("w1"); wake("w2");
      handOff.adoptClaimed(["w2", "w1"]);
      await settle();
      expect(w.hop.calls.map((c) => c.ids)).toEqual([["w1", "w2"]]);
    });

    it("each row needs its own gate record, and a repeat carries only the rows without one", async () => {
      await pair();
      w.gate.record(messageId("w1"));
      await pump.tick();
      expect(row(db, "w1").message_state).toBe("received");
      expect(row(db, "w2").message_state).toBe("attempting");
      expect(w.hop.calls).toHaveLength(1);
      w.now += ATTEMPT_BACKOFF_MS[0];
      await pump.tick();
      expect(w.hop.calls.slice(1).map((c) => [c.ids, c.body])).toEqual([[["w2"], "wake w2"]]);
      expect(row(db, "w2").attempts).toBe(2);
    });

    it("a repeat is the same text while no row has a record", async () => {
      await pair();
      w.now += ATTEMPT_BACKOFF_MS[0];
      await pump.tick();
      expect(w.hop.calls.map((c) => c.body)).toEqual(["wake w1\nwake w2", "wake w1\nwake w2"]);
    });

    it("a member recorded while the head was not is settled before the attempt, and is not sent", async () => {
      wake("w1"); wake("w2"); wake("w3");
      w.gate.record(messageId("w2"));
      handOff.adoptClaimed(["w1", "w2", "w3"]);
      await settle();
      expect(w.hop.calls.map((c) => c.ids)).toEqual([["w1", "w3"]]);
      expect(row(db, "w2").message_state).toBe("received");
    });

    it("a member whose gate cannot be read proves nothing, so nothing goes", async () => {
      await pair();
      w.now += ATTEMPT_BACKOFF_MS[0];
      const lookup = w.gate.lookup.bind(w.gate);
      w.gate.lookup = async (seat, id) => (id === "w2" ? { kind: "unavailable", cause: "down" } : lookup(seat, id));
      await pump.tick();
      expect(w.hop.calls).toHaveLength(1);
      expect(row(db, "w1").message_pause_reason).toBe("gate_unavailable");
    });

    it("a pause gives the attempt back on every row, and a refusal is on every row", async () => {
      w.hop.result = { kind: "paused", reason: "busy" };
      await pair();
      expect([row(db, "w1").attempts, row(db, "w2").attempts]).toEqual([0, 0]);
      expect([row(db, "w1").message_pause_reason, row(db, "w2").message_pause_reason]).toEqual(["busy", "busy"]);
      w.hop.result = { kind: "refused", reason: "no" };
      w.now += PUMP_PAUSE_RECHECK_MS;
      await pump.tick();
      expect([row(db, "w1").message_last_refusal, row(db, "w2").message_last_refusal]).toEqual(["no", "no"]);
    });

    it("rows handed over apart go apart, and one row is no group, even at a second forward", async () => {
      wake("w1"); wake("w2");
      handOff.adoptClaimed(["w1"]);
      handOff.adoptClaimed(["w2"]);
      await settle();
      w.gate.record(messageId("w1"));
      await pump.tick();
      expect(w.hop.calls.map((c) => c.ids)).toEqual([["w1"], ["w2"]]);
      db.prepare("UPDATE outbox_entries SET message_group = 'stale', message_state = NULL, attempts = 0, delivery_state = 'pending' WHERE outbox_id = 'w2'").run();
      handOff.adoptClaimed(["w2"]);
      expect(row(db, "w2").message_group).toBeNull();
    });

    it("a row that left for another seat is not in the group's text", async () => {
      await pair();
      db.prepare("UPDATE outbox_entries SET destination_session = 'other@r' WHERE outbox_id = 'w2'").run();
      w.now += ATTEMPT_BACKOFF_MS[0];
      await pump.tick();
      expect(w.hop.calls[1]!.ids).toEqual(["w1"]);
    });

    it("a claim is every row's or none's: a row another pass took leaves the rest unclaimed", async () => {
      wake("w1"); wake("w2");
      handOff.adoptClaimed(["w1", "w2"]);
      const rows = store.groupOf(store.headOf(SEAT)!);
      expect(rows).toHaveLength(2);
      await settle();
      expect(store.claimAttempts([{ ...rows[0]!, attempts: 1 }, rows[1]!], T0 + MIN)).toBe(false);
      expect([row(db, "w1").attempts, row(db, "w2").attempts]).toEqual([1, 1]);
    });

    it("rows bound to different occupants are not one text", async () => {
      await pair();
      db.prepare("UPDATE outbox_entries SET occupant_generation = 'g2' WHERE outbox_id = 'w2'").run();
      w.now += ATTEMPT_BACKOFF_MS[0];
      await pump.tick();
      expect(w.hop.calls[1]!.ids).toEqual(["w1"]);
    });

    it("every row of a group sent to a previous occupant carries the label", async () => {
      await pair();
      db.prepare("UPDATE outbox_entries SET message_previous_occupant = 'g0'").run();
      w.now += ATTEMPT_BACKOFF_MS[0];
      await pump.tick();
      expect(w.hop.calls[1]!.body).toBe(`${PREVIOUS_OCCUPANT_LABEL} wake w1\n${PREVIOUS_OCCUPANT_LABEL} wake w2`);
    });

    it("after a repeat, the tidy sees the text the seat was sent, whole", async () => {
      const tidied: SeatMessage[] = [];
      w.hop.afterReceived = async (m) => { tidied.push(m); };
      await pair();
      w.now += ATTEMPT_BACKOFF_MS[0];
      await pump.tick();
      w.gate.record(messageId("w1"));
      w.gate.record(messageId("w2"));
      await pump.tick();
      expect(tidied[0]!.ids).toEqual(["w1", "w2"]);
      expect(tidied[0]!.body).toBe("wake w1\nwake w2");
    });
  });

  describe("the content lane's hold (N4: lane 2 waits while a seat's startup is open)", () => {
    const inLane = (id: string, lane: 0 | 1 | 2, seat = SEAT) => store.accept({ id: messageId(id), seat, sender: "lead@r", body: id, lane });

    it("startup, then startup, then the queued message, though the lane is empty between the two", async () => {
      const release = pump.holdContentLane(SEAT);
      inLane("c1", MESSAGE_LANES.content);
      inLane("s1", MESSAGE_LANES.startup);
      await pump.tick();
      w.gate.record(messageId("s1"));
      await pump.tick();
      await pump.tick();
      expect(w.hop.calls.map((c) => c.ids[0])).toEqual(["s1"]);
      expect(row(db, "c1")).toMatchObject({ attempts: 0, message_pause_reason: "lane_held" });
      expect(store.headOf(SEAT)?.pauseReason).toBe("lane_held");
      inLane("s2", MESSAGE_LANES.startup);
      await pump.tick();
      w.gate.record(messageId("s2"));
      await pump.tick();
      expect(w.hop.calls.map((c) => c.ids[0])).toEqual(["s1", "s2"]);
      release();
      await new Promise((r) => setImmediate(r));
      expect(w.hop.calls.map((c) => c.ids[0])).toEqual(["s1", "s2", "c1"]);
      expect(row(db, "c1").message_pause_reason).toBeNull();
    });

    it("holds only lane 2, and only its own seat", async () => {
      pump.holdContentLane(SEAT);
      inLane("p1", MESSAGE_LANES.compaction);
      inLane("o1", MESSAGE_LANES.content, "other@r");
      await pump.tick();
      expect(w.hop.calls.map((c) => c.ids[0]).sort()).toEqual(["o1", "p1"]);
    });

    it("lifts with its last holder, and a second release changes nothing", async () => {
      const first = pump.holdContentLane(SEAT);
      const second = pump.holdContentLane(SEAT);
      inLane("c1", MESSAGE_LANES.content);
      first();
      first();
      await new Promise((r) => setImmediate(r));
      await pump.tick();
      expect(w.hop.calls).toEqual([]);
      await new Promise((r) => setImmediate(r));
      second();
      await new Promise((r) => setImmediate(r));
      expect(w.hop.calls).toHaveLength(1);
    });

    it("a record still counts during the hold", async () => {
      inLane("c1", MESSAGE_LANES.content);
      await pump.tick();
      pump.holdContentLane(SEAT);
      w.gate.record(messageId("c1"));
      await pump.tick();
      expect(row(db, "c1").message_state).toBe("received");
    });
  });

  describe("a message's obligation (S4 design: a closed item ends its wake, at every attempt)", () => {
    let obligations: MessageObligations;
    let reason: string | null;
    const wake = (id: string) => store.accept({ id: messageId(id), seat: SEAT, sender: "lead@r", body: id, messageClass: "nudge", auditPointer: "q-1" });
    beforeEach(() => {
      obligations = new MessageObligations();
      reason = null;
      obligations.register("wake-", () => reason);
      pump = new MessagePump({ ...w.deps(store), obligations });
    });

    it("is read at every attempt: an item closed after the first ends the row, with no notice and no second attempt", async () => {
      wake("wake-1");
      await pump.tick();
      expect(w.hop.calls).toHaveLength(1);
      reason = "qitem closed";
      w.now += ATTEMPT_BACKOFF_MS[0];
      await pump.tick();
      expect(w.hop.calls).toHaveLength(1);
      expect(row(db, "wake-1")).toMatchObject({ message_state: "undeliverable", ack_evidence: "superseded", message_closed_reason: "qitem closed" });
      expect(w.returned).toEqual([]);
    });

    it("a gate record beats it: what arrived, arrived", async () => {
      wake("wake-1");
      await pump.tick();
      reason = "qitem closed";
      w.gate.record(messageId("wake-1"));
      await pump.tick();
      expect(row(db, "wake-1").message_state).toBe("received");
    });

    it("ends a row before its seat's fate does: nobody is told about a wake nobody wants", async () => {
      wake("wake-1");
      reason = "qitem closed";
      w.fates.set(SEAT, { kind: "gone", reason: "archived" });
      await pump.tick();
      expect(w.returned).toEqual([]);
      expect(row(db, "wake-1").ack_evidence).toBe("superseded");
    });

    it("the check sees the row: attempts, occupant and audit pointer", async () => {
      const seen: unknown[] = [];
      obligations.register("job-", (m) => { seen.push([m.id, m.messageClass, m.attempts, m.occupantGeneration, m.auditPointer]); return null; });
      store.accept({ id: messageId("job-1"), seat: SEAT, sender: "lead@r", body: "x", occupantGeneration: "g1", auditPointer: "j1" });
      w.fates.set(SEAT, { kind: "live", occupantGeneration: "g1" });
      await pump.tick();
      expect(seen).toEqual([["job-1", "content", 0, "g1", "j1"]]);
    });

    it("a member nobody wants leaves the group's text", async () => {
      obligations.register("job-", (m) => (m.id === "job-2" ? "stale" : null));
      for (const id of ["job-1", "job-2"]) new OutboxHandler(db).record({ outboxId: id, senderSession: "lead@r", destinationSession: SEAT, body: id });
      new PumpHandOff(store, pump, w.deps(store).ports).adoptClaimed(["job-1", "job-2"]);
      await new Promise((r) => setImmediate(r));
      expect(w.hop.calls.map((c) => c.ids)).toEqual([["job-1"]]);
      expect(row(db, "job-2").ack_evidence).toBe("superseded");
    });

    it("no check for the id, or a check that throws, leaves the message wanted", async () => {
      accept("other");
      await pump.tick();
      expect(w.hop.calls).toHaveLength(1);
      obligations.register("boom-", () => { throw new Error("read failed"); });
      store.accept({ id: messageId("boom-1"), seat: "b@r", sender: "lead@r", body: "x" });
      await pump.tick();
      expect(w.hop.calls.map((c) => c.ids[0])).toContain("boom-1");
    });

    it("a prefix has one owner", () => {
      expect(() => obligations.register("wake-", () => null)).toThrow(/already/);
    });
  });

  describe("class and lane", () => {
    it("lifecycle text with no lane named goes in the startup lane, in the store as in the ledger", () => {
      store.accept({ id: messageId("l1"), seat: SEAT, sender: "lead@r", body: "x", messageClass: "lifecycle" });
      new MessageLedger(db).accept({ id: "l2", seat: SEAT, sender: "lead@r", body: "x", identityProvenance: "t", messageClass: "lifecycle" });
      expect([row(db, "l1").lane, row(db, "l2").lane]).toEqual([MESSAGE_LANES.startup, MESSAGE_LANES.startup]);
    });

    it("a lane named wins, and a nudge stays with content", () => {
      store.accept({ id: messageId("l1"), seat: SEAT, sender: "lead@r", body: "x", messageClass: "lifecycle", lane: MESSAGE_LANES.compaction });
      store.accept({ id: messageId("n1"), seat: SEAT, sender: "lead@r", body: "x", messageClass: "nudge" });
      expect([row(db, "l1").lane, row(db, "n1").lane]).toEqual([MESSAGE_LANES.compaction, MESSAGE_LANES.content]);
    });
  });

  describe("the hand-off is the consumers' whole seam", () => {
    it("takes the row, waits for it, ends it, and holds the lane", async () => {
      const handOff: MessageHandOff = new PumpHandOff(store, pump, w.deps(store).ports);
      const accepted = handOff.accept({ id: messageId("m1"), seat: SEAT, sender: "lead@r", body: "x" });
      await new Promise((r) => setImmediate(r));
      expect(accepted).toEqual({ kind: "accepted", id: "m1" });
      expect(await handOff.awaitReceived(messageId("m1"), 0)).toBe("open");
      const release = handOff.holdContentLane(SEAT);
      handOff.accept({ id: messageId("m2"), seat: "two@r", sender: "lead@r", body: "x" });
      expect(handOff.cancel(messageId("m1"), "unwound")).toBe(true);
      expect(await handOff.awaitReceived(messageId("m1"), 0)).toBe("undeliverable");
      await new Promise((r) => setImmediate(r));
      accept("m3");
      await pump.tick();
      expect(row(db, "m3").attempts).toBe(0);
      release();
      await new Promise((r) => setImmediate(r));
      expect(row(db, "m3").attempts).toBe(1);
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
    const accept2 = (extra: { messageClass: "command" }) => store.accept({ id: messageId("cmd"), seat: SEAT, sender: "lead@r", body: "/compact", ...extra });

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

  describe("a record reconcile cleared (M5)", () => {
    const received = async (id: string) => {
      accept(id);
      await pump.tick();
      w.gate.record(messageId(id), store.nonceOf(messageId(id)));
      await pump.tick();
      expect(row(db, id).message_state).toBe("received");
    };

    it("opens the row again under its id, nonce and body, in the seat's order, and the pump resends it", async () => {
      await received("m1");
      const nonce = store.nonceOf(messageId("m1"))!;
      accept("m2");
      await pump.tick();
      w.gate.seen.delete("m1");
      expect(store.reopenCleared(messageId("m1"), nonce)).toBe(true);
      expect(row(db, "m1")).toMatchObject({ message_state: "attempting", delivery_state: "pending", delivered_at: null, gate_recorded_at: null, ack_evidence: null, body: "body of m1", native_nonce: nonce });
      w.hop.calls.length = 0;
      await pump.tick();
      expect(w.hop.calls.map((c) => c.ids[0])).toEqual(["m1"]);
    });

    it("the same goes for a row the old ack path delivered", () => {
      const outbox = new OutboxHandler(db);
      outbox.record({ outboxId: "n1", senderSession: "a@r", destinationSession: SEAT, body: "x" });
      outbox.claimNative("n1", "a".repeat(32), "1970-01-01T00:00:00.000Z");
      outbox.ackNative("n1", "a".repeat(32), SEAT);
      expect(store.reopenCleared(messageId("n1"), "a".repeat(32))).toBe(true);
      expect(row(db, "n1")).toMatchObject({ message_state: "attempting", delivery_state: "pending" });
    });

    it("a clear under another nonce opens nothing: it was a forged record", async () => {
      await received("m1");
      expect(store.reopenCleared(messageId("m1"), "f".repeat(32))).toBe(false);
      expect(row(db, "m1").message_state).toBe("received");
    });

    it("a row that never arrived has nothing to open", () => {
      accept("m1");
      expect(store.reopenCleared(messageId("m1"), "f".repeat(32))).toBe(false);
    });
  });

  describe("a hop's tidying after the record", () => {
    it("runs when more than one attempt went out, and a failure in it changes nothing", async () => {
      const tidied: string[] = [];
      const hop: LastHop = { attempt: async () => ({ kind: "sent" }), afterReceived: async (m) => { tidied.push(m.ids[0]); throw new Error("no"); } };
      pump = new MessagePump({ ...w.deps(store), ports: { gateFor: () => w.gate, hopFor: () => hop } });
      accept("m1");
      await pump.tick();
      w.now += 2 * MIN;
      await pump.tick();
      w.gate.record(messageId("m1"), store.nonceOf(messageId("m1")));
      await pump.tick();
      expect(tidied).toEqual(["m1"]);
      expect(row(db, "m1").message_state).toBe("received");
    });

    it("a tidying failure does not hold up the seat: the next message goes in the same pass", async () => {
      const sent: string[] = [];
      const hop: LastHop = { attempt: async (m) => { sent.push(m.ids[0]); return { kind: "sent" }; }, afterReceived: async () => { throw new Error("no"); } };
      pump = new MessagePump({ ...w.deps(store), ports: { gateFor: () => w.gate, hopFor: () => hop } });
      accept("m1");
      await pump.tick();
      w.now += 2 * MIN;
      await pump.tick();
      accept("m2");
      w.gate.record(messageId("m1"), store.nonceOf(messageId("m1")));
      await pump.tick();
      expect(sent).toEqual(["m1", "m1", "m2"]);
    });

    it("does not run after one attempt: no repeat can be sitting anywhere", async () => {
      const tidied: string[] = [];
      const hop: LastHop = { attempt: async () => ({ kind: "sent" }), afterReceived: async (m) => { tidied.push(m.ids[0]); } };
      pump = new MessagePump({ ...w.deps(store), ports: { gateFor: () => w.gate, hopFor: () => hop } });
      accept("m1");
      await pump.tick();
      w.gate.record(messageId("m1"), store.nonceOf(messageId("m1")));
      await pump.tick();
      expect(tidied).toEqual([]);
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
        expect(row(db, "m1")).toMatchObject({ message_state: "attempting", message_pause_reason: null, attempts: 1, next_attempt_at: new Date(w.now + 2 * MIN).toISOString() });
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
        expect(row(b, "m1")).toMatchObject({ message_state: "attempting", attempts: 1, next_attempt_at: new Date(T0 + 2 * MIN).toISOString() });
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

    it("a daemon that closed its database stops the pump, with no noise after", async () => {
      const lines: string[] = [];
      pump = new MessagePump({ ...w.deps(store), log: (line) => lines.push(line), timing: { tickMs: 3_600_000 } });
      pump.start();
      await new Promise((r) => setImmediate(r));
      db.close();
      await pump.tick();
      await pump.tick();
      expect(lines).toEqual([]);
      db = createDb(); migrate(db, ALL_MIGRATIONS); store = new MessageStore(db);
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

    it("a row the send path left attempting when the guard held it is still the guard's", async () => {
      hold("h1");
      db.prepare("UPDATE outbox_entries SET message_state = 'attempting', attempts = 1 WHERE outbox_id = 'h1'").run();
      await pump.tick();
      expect(w.hop.calls).toEqual([]);
      w.holds.set("n1", "lifted");
      await pump.tick();
      expect(w.hop.calls.map((c) => c.ids[0])).toEqual(["h1"]);
    });

    it("go to the new occupant when the occupant changed, labelled at every attempt, the stored body untouched", async () => {
      hold("h1");
      w.holds.set("n1", "occupant_changed");
      await pump.tick();
      w.now += 2 * MIN;
      await pump.tick();
      const text = `${PREVIOUS_OCCUPANT_LABEL} held h1`;
      expect(w.hop.calls.map((c) => c.body)).toEqual([text, text]);
      expect(row(db, "h1")).toMatchObject({ body: "held h1", message_state: "attempting", message_previous_occupant: "g1" });
      expect(w.returned).toEqual([]);
    });

    it("a held command is not a message: it stays with its owner", async () => {
      hold("h1");
      db.prepare("UPDATE outbox_entries SET class = 'command' WHERE outbox_id = 'h1'").run();
      w.holds.set("n1", "occupant_changed");
      await pump.tick();
      expect(w.hop.calls).toEqual([]);
      expect(row(db, "h1").message_hold_released_at).toBeNull();
    });

    it("a held message that changed no occupant carries no label", async () => {
      hold("h1");
      w.holds.set("n1", "lifted");
      await pump.tick();
      expect(w.hop.calls[0]!.body).toBe("held h1");
    });

    it("held lifecycle text stays bound: it goes back to its sender, never to the new occupant", async () => {
      hold("h1", "n1", SEAT, "lifecycle");
      w.holds.set("n1", "occupant_changed");
      await pump.tick();
      expect(w.hop.calls).toEqual([]);
      expect(w.returned.map((r) => r.id)).toEqual(["h1"]);
      expect(row(db, "h1")).toMatchObject({ message_state: "undeliverable", delivery_state: "failed" });
    });

    it("a held message bound to one occupant goes on labelled unless it is lifecycle text", async () => {
      hold("h1");
      db.prepare("UPDATE outbox_entries SET occupant_generation = 'g1' WHERE outbox_id = 'h1'").run();
      w.holds.set("n1", "occupant_changed");
      w.fates.set(SEAT, { kind: "live", occupantGeneration: "g2" });
      await pump.tick();
      expect(w.hop.calls.map((c) => c.body)).toEqual([`${PREVIOUS_OCCUPANT_LABEL} held h1`]);
      expect(w.returned).toEqual([]);
    });

    it("a held message on a seat gone for good does not wait for its guard: it ends", async () => {
      hold("h1");
      w.fates.set(SEAT, { kind: "gone", reason: "rig r is archived" });
      await pump.tick();
      expect(row(db, "h1").message_state).toBe("undeliverable");
      expect(w.returned.map((r) => r.reason)).toEqual(["rig r is archived"]);
    });

    it("a held message on a seat with a successor moves when the guard lets go", async () => {
      hold("h1");
      w.holds.set("n1", "occupant_changed");
      w.fates.set(SEAT, { kind: "successor", seat: "dev2@r" });
      await pump.tick();
      await pump.tick();
      expect(w.hop.calls.map((c) => [c.seat, c.body])).toEqual([["dev2@r", `${PREVIOUS_OCCUPANT_LABEL} held h1`]]);
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

    it("a row with an unreadable binding still leaves the guard: its seat is on the row, and it goes labelled, since who held it is lost", async () => {
      hold("h1");
      db.prepare("UPDATE outbox_entries SET guard_binding = '{broken' WHERE outbox_id = 'h1'").run();
      await pump.tick();
      expect(row(db, "h1").message_state).toBeNull();  // the seat's guard is on
      w.seatHolds.set(SEAT, "occupant_changed");
      await pump.tick();
      expect(w.hop.calls.map((c) => c.body)).toEqual([`${PREVIOUS_OCCUPANT_LABEL} held h1`]);
      expect(row(db, "h1").message_previous_occupant).toBe("unknown");
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

    it("a row the pump never took is not its to end on a gateless seat, in any fate: nothing here can know what reached it", async () => {
      new OutboxHandler(db).record({ outboxId: "m1", senderSession: "lead@r", destinationSession: SEAT, body: "x", messageState: "attempting" });
      w.ungated.add(SEAT);
      w.fates.set(SEAT, { kind: "gone", reason: "archived" });
      await pump.tick();
      expect(row(db, "m1").message_state).toBe("attempting");
      expect(w.returned).toEqual([]);
    });

    it("a row the pump took ends when its seat's record is gone and no gate can be found", async () => {
      accept("m1");
      w.ungated.add(SEAT);
      w.fates.set(SEAT, { kind: "gone", reason: "archived" });
      await pump.tick();
      expect(row(db, "m1").message_state).toBe("undeliverable");
      expect(w.returned.map((r) => r.id)).toEqual(["m1"]);
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
      const lifecycle = (id: string, seat: string) => store.accept({ id: messageId(id), seat, sender: "lead@r", body: id, occupantGeneration: "g1", messageClass: "lifecycle" });
      lifecycle("m1", SEAT);
      w.fates.set(SEAT, { kind: "successor", seat: "dev2@r" });
      await pump.tick();
      expect(row(db, "m1")).toMatchObject({ message_state: "undeliverable", destination_session: SEAT });
      lifecycle("m2", "qa@r");
      w.fates.set("qa@r", { kind: "live", occupantGeneration: "g2" });
      await pump.tick();
      expect(row(db, "m2").message_state).toBe("undeliverable");
      lifecycle("m3", "ok@r");
      w.fates.set("ok@r", { kind: "live", occupantGeneration: "g1" });
      await pump.tick();
      expect(w.hop.calls.map((c) => [c.ids[0], c.occupantGeneration])).toEqual([["m3", "g1"]]);
    });

    it("other text bound to an occupant goes on to the new one, labelled: only lifecycle text stays bound", async () => {
      accept("m1", SEAT, { occupantGeneration: "g1" });
      w.fates.set(SEAT, { kind: "live", occupantGeneration: "g2" });
      await pump.tick();
      expect(w.hop.calls.map((c) => c.body)).toEqual([`${PREVIOUS_OCCUPANT_LABEL} body of m1`]);
      expect(row(db, "m1")).toMatchObject({ message_previous_occupant: "g1", occupant_generation: null, message_state: "attempting" });
      expect(w.returned).toEqual([]);
    });

    it("to a successor seat too, and it goes back to the sender if the seat is simply gone", async () => {
      accept("m1", SEAT, { occupantGeneration: "g1" });
      w.fates.set(SEAT, { kind: "successor", seat: "dev2@r" });
      await pump.tick();
      expect(row(db, "m1")).toMatchObject({ message_previous_occupant: "g1" });
      await pump.tick();
      accept("m2", "gone@r", { occupantGeneration: "g1" });
      w.fates.set("gone@r", { kind: "gone", reason: "archived" });
      await pump.tick();
      expect(row(db, "m2").message_state).toBe("undeliverable");
      expect(w.returned.map((r) => r.id)).toEqual(["m2"]);
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

  it("a stale claim loses: one claim per attempt, even across two pumps on one database", () => {
    store.accept(input);
    const seenByBoth = store.headOf("dev@r")!;
    expect(store.claimAttempt(seenByBoth, 1)).toBe(true);
    expect(store.claimAttempt(seenByBoth, 1)).toBe(false);
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

describe("the S4 review's pump rows", () => {
  const SEAT = "dev@r";
  const world = () => {
    const db = createDb(); migrate(db, ALL_MIGRATIONS);
    const store = new MessageStore(db); const w = new World();
    return { db, store, w, pump: new MessagePump(w.deps(store)) };
  };

  it("QA F4 (probe P1): rows of a long group the hop did not carry owe no backoff: the next goes at once", async () => {
    const { db, store, w, pump } = world();
    const handOff = new PumpHandOff(store, pump, w.deps(store).ports);
    for (const id of ["w1", "w2", "w3"]) new OutboxHandler(db).record({ outboxId: id, senderSession: "lead@r", destinationSession: SEAT, body: `wake ${id}`, auditPointer: `q-${id}` });
    w.hop.result = { kind: "sent", carried: [messageId("w1")] };
    handOff.adoptClaimed(["w1", "w2", "w3"]);
    await new Promise((r) => setImmediate(r));
    expect(row(db, "w1").attempts).toBe(1);
    expect(row(db, "w2")).toMatchObject({ attempts: 0, next_attempt_at: null });
    w.gate.record(messageId("w1"));
    w.hop.result = { kind: "sent", carried: [messageId("w2")] };
    await pump.tick();  // no clock move: not one minute of a backoff is owed
    expect(w.hop.calls.at(-1)!.ids[0]).toBe("w2");
  });

  it("a group carried whole charges every row", async () => {
    const { db, store, w, pump } = world();
    const handOff = new PumpHandOff(store, pump, w.deps(store).ports);
    for (const id of ["w1", "w2"]) new OutboxHandler(db).record({ outboxId: id, senderSession: "lead@r", destinationSession: SEAT, body: `wake ${id}`, auditPointer: `q-${id}` });
    handOff.adoptClaimed(["w1", "w2"]);
    await new Promise((r) => setImmediate(r));
    expect(row(db, "w2").attempts).toBe(1);
  });

  it("QA F5 (probe P2): a part that needed a repeat is tidied before the next part, and names itself", async () => {
    const { store, w, pump } = world();
    const tidied: Array<number | undefined> = [];
    w.hop.afterReceived = async (m) => { tidied.push(m.part); };
    store.accept({ id: messageId("L1"), seat: SEAT, sender: "lead@r", body: "x" });
    store.markParts(messageId("L1"), 3);
    await pump.tick();
    w.now += 2 * MIN; await pump.tick();
    w.gate.record(partId(messageId("L1"), 1, 3), store.nonceOf(messageId("L1")));
    w.now += 1000; await pump.tick();
    expect(tidied).toEqual([1]);
    expect(w.hop.calls.at(-1)!.part).toBe(2);
  });

  it("a part that took one attempt needs no tidying", async () => {
    const { store, w, pump } = world();
    const tidied: unknown[] = [];
    w.hop.afterReceived = async (m) => { tidied.push(m); };
    store.accept({ id: messageId("L1"), seat: SEAT, sender: "lead@r", body: "x" });
    store.markParts(messageId("L1"), 2);
    await pump.tick();
    w.gate.record(partId(messageId("L1"), 1, 2), store.nonceOf(messageId("L1")));
    await pump.tick();
    expect(tidied).toEqual([]);
  });

  it("QA F7: a pass asked for one seat leaves every other seat to its recheck", async () => {
    const { store, w, pump } = world();
    store.accept({ id: messageId("a"), seat: "other@r", sender: "lead@r", body: "x" });
    w.hop.result = { kind: "paused", reason: "busy" };
    await pump.tick();
    const before = w.hop.calls.length;
    store.accept({ id: messageId("b"), seat: SEAT, sender: "lead@r", body: "y" });
    await pump.ask(SEAT);
    await pump.ask(SEAT);
    expect(w.hop.calls.filter((c) => c.seat === "other@r")).toHaveLength(before);
    expect(w.hop.calls.filter((c) => c.seat === SEAT).length).toBeGreaterThanOrEqual(2);
  });

  it("security F3: a cancelled head clears the seat's spool; a cancel further back leaves the head's text alone", async () => {
    const { store, w, pump } = world();
    const forgot: string[] = [];
    w.hop.forget = (seat) => { forgot.push(seat); };
    store.accept({ id: messageId("h"), seat: SEAT, sender: "lead@r", body: "x" });
    store.accept({ id: messageId("t"), seat: SEAT, sender: "lead@r", body: "y" });
    expect(pump.cancel(messageId("t"), "later")).toBe(true);
    expect(forgot).toEqual([]);
    expect(pump.cancel(messageId("h"), "now")).toBe(true);
    expect(forgot).toEqual([SEAT]);
    expect(pump.cancel(messageId("h"), "again")).toBe(false);
    expect(forgot).toEqual([SEAT]);
  });

  it("a hop that says the seat is gone ends the row and tells the sender", async () => {
    const { store, w, pump } = world();
    store.accept({ id: messageId("g"), seat: SEAT, sender: "lead@r", body: "x" });
    w.hop.result = { kind: "gone", reason: "no such seat" };
    await pump.tick();
    expect(store.outcomeOf(messageId("g"))).toBe("undeliverable");
    expect(w.returned).toEqual([{ id: "g", sender: "lead@r", reason: "no such seat" }]);
  });

  it("far_not_gated is asked again at the cap, not every recheck", async () => {
    const { store, w, pump } = world();
    store.accept({ id: messageId("n"), seat: SEAT, sender: "lead@r", body: "x" });
    w.hop.result = { kind: "paused", reason: "far_not_gated" };
    await pump.tick();
    w.now += PUMP_PAUSE_RECHECK_MS + 1; await pump.tick();
    expect(w.hop.calls).toHaveLength(1);
    w.now += ATTEMPT_BACKOFF_MS.at(-1)!; await pump.tick();
    expect(w.hop.calls).toHaveLength(2);
  });
});
