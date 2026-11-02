// Delivery S4d: the wake ladder's retry half moves to the pump. On a seat the pump serves a wake's row is the record: the ladder reads it and
// never sends, its cap ends nothing but the notice, and the item stays the obligation, so a closed item ends its wake at the next attempt.
// Real database, real queue, real SessionTransport and real pump; the gate and the hop are stubs, and the send adapters record any write.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { LADDER_ATTEMPT_PREFIX } from "../src/domain/queue-stuck-sweep.js";
import { runWakeLadderTick, WAKE_ESCALATION_TAG } from "../src/domain/queue-wake-ladder.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { PumpHandOff } from "../src/domain/seat-messaging/hand-off.js";
import { MessagePump } from "../src/domain/seat-messaging/message-pump.js";
import { MessageLedger } from "../src/domain/seat-messaging/message-ledger.js";
import { MessageStore } from "../src/domain/seat-messaging/message-store.js";
import { messageId, type GateRecord, type LastHop, type LastHopResult, type SeatGate } from "../src/domain/seat-messaging/ports.js";
import { MessageObligations, type SeatMessagingPorts } from "../src/domain/seat-messaging/pump-ports.js";
import { tmuxStub } from "./helpers/tmux-stub.js";
import { DbSeatDirectory } from "../src/domain/seat-messaging/seat-directory.js";

const SEAT = "dev@hr";
const PLAIN = "plain@hr";
const LEAD = "lead@hr";
const MINUTE = 60_000;
const CAP = 3;
const INTERVAL_S = 300;

describe("a wake on a seat the pump serves", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let store: MessageStore;
  let pump: MessagePump;
  let writes: string[];
  let hopTexts: string[][];
  let hopResult: LastHopResult;
  let seen: Map<string, GateRecord>;
  let nowMs: number;
  let gone: boolean;

  beforeEach(() => {
    nowMs = Date.parse("2026-11-01T12:00:00.000Z");
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    writes = []; hopTexts = []; seen = new Map(); gone = false;
    hopResult = { kind: "paused", reason: "seat_stopped" };
    const rigRepo = new RigRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    const rig = rigRepo.createRig("hr");
    for (const [logical, session] of [["dev", SEAT], ["plain", PLAIN], ["lead", LEAD]] as const) {
      const node = rigRepo.addNode(rig.id, logical, { role: "worker", runtime: "claude-code" });
      sessionRegistry.updateStatus(sessionRegistry.registerSession(node.id, session).id, "running");
      sessionRegistry.updateBinding(node.id, { attachmentType: "tmux", tmuxSession: session, tmuxPane: "%1" });
    }
    const gate: SeatGate = { version: 1, lookup: async (_seat, id) => { const record = seen.get(id); return record ? { kind: "seen", record } : { kind: "not_seen" }; } };
    const hop: LastHop = {
      attempt: async (message) => {
        hopTexts.push([...message.ids]);
        if (hopResult.kind === "sent") for (const id of message.ids) seen.set(id, { id, recordedAt: new Date(nowMs).toISOString(), nonce: null });
        return hopResult;
      },
    };
    const ports: SeatMessagingPorts = { gateFor: (seat) => (seat === SEAT && !gone ? gate : null), hopFor: (seat) => (seat === SEAT && !gone ? hop : null) };
    store = new MessageStore(db);
    const obligations = new MessageObligations();
    pump = new MessagePump({
      store, ports, obligations, clock: () => nowMs,
      directory: { fate: (seat) => (gone ? { kind: "gone", reason: "the rig is archived" } : new DbSeatDirectory(db).fate(seat)) },
      held: { status: () => "held" }, senders: { returnToSender: async () => ({ kind: "returned", qitemId: "returned-item" }) },
      timing: { backoffMs: [0], pauseRecheckMs: 0 }, log: () => undefined,
    });
    const handOff = new PumpHandOff(store, pump, ports);
    const tmuxAdapter = tmuxStub({
      hasSession: async () => true, probeSession: async () => ({ state: "present" as const }), capturePaneContent: async () => "idle\n❯ ",
      listSessions: async () => [], listWindows: async () => [], listPanes: async () => [], getPanePid: async () => null, getPaneCommand: async () => null,
      sendText: async (_t: string, text: string) => { writes.push(text); return { ok: true as const }; }, sendKeys: async () => { writes.push("<keys>"); return { ok: true as const }; },
    });
    tmuxAdapter.messageHandOff = handOff;
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, agentActivityStore: new AgentActivityStore({ db, eventBus }), eventBus, tmuxAdapter, sleep: async () => undefined });
    repo = new QueueRepository(db, eventBus, { validateRig: () => true });
    repo.attachOutbox(new OutboxHandler(db));
    repo.attachTransport(transport);
    repo.attachMessagePump(handOff, obligations);
  });
  afterEach(() => { pump.stop(); db.close(); });

  const settle = async () => { await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); };
  const ladder = (extra: Partial<Parameters<typeof runWakeLadderTick>[0]> = {}) => runWakeLadderTick({
    db, queueRepo: repo, now: new Date(nowMs), retryIntervalSeconds: INTERVAL_S, retryCap: CAP, swapGraceSeconds: 0, unconfirmedWindowMinutes: 30, resolveOrchestrator: () => LEAD, log: () => undefined, ...extra,
  });
  /** A baton to `dest`, delivered as production delivers it: stage, commit, drain. */
  async function baton(dest = SEAT, tag?: string): Promise<{ qitemId: string; wakeId: string }> {
    const src = await repo.create({ sourceSession: "sender@hr", destinationSession: "relay@hr", body: "the work", nudge: false, tags: tag ? [tag] : undefined });
    const { created } = await repo.handoff({ qitemId: src.qitemId, fromSession: "relay@hr", toSession: dest });
    await settle();
    await pump.tick();
    return { qitemId: created.qitemId, wakeId: `wake-intent-${created.qitemId}` };
  }
  const row = (id: string) => db.prepare("SELECT * FROM outbox_entries WHERE outbox_id = ?").get(id) as Record<string, unknown>;
  const rowsFor = (qitemId: string) => db.prepare("SELECT outbox_id FROM outbox_entries WHERE audit_pointer = ?").all(qitemId) as Array<{ outbox_id: string }>;
  const item = (id: string) => db.prepare("SELECT state, last_nudge_result FROM queue_items WHERE qitem_id = ?").get(id) as { state: string; last_nudge_result: string | null };
  const notes = (id: string) => (db.prepare("SELECT transition_note AS n FROM queue_transitions WHERE qitem_id = ? ORDER BY transition_id").all(id) as Array<{ n: string | null }>).map((r) => r.n ?? "");
  const escalations = () => db.prepare(`SELECT qitem_id, state FROM queue_items WHERE tags LIKE ?`).all(`%"${WAKE_ESCALATION_TAG}"%`) as Array<{ qitem_id: string; state: string }>;
  const advance = (minutes: number) => { nowMs += minutes * MINUTE; };
  /** Rows are stamped by wall clock at accept, so a fixture's age is written on them. */
  const age = (qitemId: string, minutes: number) => {
    const past = new Date(nowMs - minutes * MINUTE).toISOString();
    db.prepare("UPDATE outbox_entries SET ts_dispatched = ? WHERE audit_pointer = ?").run(past, qitemId);
    db.prepare("UPDATE queue_items SET last_nudge_attempt = ? WHERE qitem_id = ?").run(past, qitemId);
  };
  const noticeAgeMinutes = (CAP * INTERVAL_S) / 60;

  it("the drain hands it over: the row is the pump's, the item says so, and nothing is written past the pump", async () => {
    const { qitemId, wakeId } = await baton();
    expect(row(wakeId)).toMatchObject({ message_state: "attempting", class: "nudge", delivery_state: "pending", message_pump_owned: 1 });
    expect(item(qitemId).last_nudge_result).toBe("retained:pump");
    expect(hopTexts.flat()).toContain(wakeId);
    expect(writes).toEqual([]);
  });

  describe("the cap ends nothing but the notice", () => {
    it("cap reached and seat restored: the wake still arrives, and exactly one escalation exists", async () => {
      const { qitemId, wakeId } = await baton();
      age(qitemId, noticeAgeMinutes + 1);
      await ladder();
      expect(escalations()).toHaveLength(1);
      expect(notes(qitemId).some((n) => n.includes("orchestrator -> lead@hr"))).toBe(true);

      for (let i = 0; i < 4; i++) { advance(10); age(qitemId, 30 + i); await ladder(); await pump.tick(); }
      expect(escalations()).toHaveLength(1);
      expect(row(wakeId)).toMatchObject({ message_state: "attempting", delivery_state: "pending" });

      hopResult = { kind: "sent" };
      await pump.tick();
      await pump.tick();
      expect(row(wakeId)).toMatchObject({ message_state: "received", delivery_state: "delivered", ack_evidence: "gate_seen" });
      await ladder();
      expect(item(qitemId).last_nudge_result).toBe("verified");
      expect(escalations().map((e) => e.state)).toEqual(["done"]);  // the notice retires with the wake
      expect(escalations()).toHaveLength(1);
    });

    it("no notice before the cap's time has run, off the oldest attempt, and one the moment it has", async () => {
      const { qitemId } = await baton();
      age(qitemId, noticeAgeMinutes - 1);
      await ladder();
      expect(escalations()).toHaveLength(0);
      age(qitemId, noticeAgeMinutes);
      await ladder();
      expect(escalations()).toHaveLength(1);
    });

    it("the ladder adds no attempt: no retry marker, no second row, however many ticks", async () => {
      const { qitemId, wakeId } = await baton();
      const attempts = () => row(wakeId).attempts;
      const before = attempts();
      for (let i = 0; i < 6; i++) { age(qitemId, 5 * i); await ladder(); }
      expect(attempts()).toBe(before);
      expect(notes(qitemId).filter((n) => n.startsWith(LADDER_ATTEMPT_PREFIX))).toEqual([]);
      expect(rowsFor(qitemId).map((r) => r.outbox_id)).toEqual([wakeId]);
    });

    it("the ladder's own wake is not called for it, even past the cap", async () => {
      const { qitemId } = await baton();
      age(qitemId, noticeAgeMinutes + 1);
      const called: string[] = [];
      await ladder({ attemptWake: async (id) => { called.push(id); return "verified"; } });
      expect(called).not.toContain(qitemId);
    });

    it("a wake received before the notice was due ends the ladder's interest: no notice, and the item reads verified", async () => {
      const { qitemId } = await baton();
      hopResult = { kind: "sent" };
      await pump.tick();
      await pump.tick();
      age(qitemId, noticeAgeMinutes + 1);
      await ladder();
      expect(item(qitemId).last_nudge_result).toBe("verified");
      expect(escalations()).toHaveLength(0);
    });

    it("a row that ended undelivered goes straight to the notice, with no retry and no new row", async () => {
      const { qitemId, wakeId } = await baton();
      gone = true;
      await pump.tick();
      expect(row(wakeId)).toMatchObject({ message_state: "undeliverable", ack_evidence: "seat_gone" });
      await ladder();
      expect(item(qitemId).last_nudge_result).toMatch(/^failed:/);
      age(qitemId, INTERVAL_S / 60 + 1);  // the ladder's own spacing still applies to the act
      await ladder();
      expect(escalations()).toHaveLength(1);
      expect(rowsFor(qitemId).map((r) => r.outbox_id)).toEqual([wakeId]);
      expect(notes(qitemId).filter((n) => n.startsWith(LADDER_ATTEMPT_PREFIX))).toEqual([]);
    });
  });

  describe("attemptWake reads the row", () => {
    it("a wake that failed before the seat had a gate is handed over once: one row, then only its state", async () => {
      const { qitemId } = await baton(SEAT);
      db.prepare("DELETE FROM outbox_entries WHERE audit_pointer = ?").run(qitemId);
      db.prepare("UPDATE queue_items SET last_nudge_result = 'failed:no session', last_nudge_attempt = ? WHERE qitem_id = ?").run(new Date(nowMs - 20 * MINUTE).toISOString(), qitemId);
      await ladder();
      await settle();
      const rows = rowsFor(qitemId).map((r) => r.outbox_id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatch(/^guard-nudge-/);
      expect(item(qitemId).last_nudge_result).toBe("retained:pump");
      expect(notes(qitemId).filter((n) => n.startsWith(LADDER_ATTEMPT_PREFIX))).toEqual([expect.stringContaining("outcome=retained:pump")]);
      await ladder();
      expect(rowsFor(qitemId)).toHaveLength(1);
    });

    it("the default attempt on a row that exists sends nothing and answers in the nudge grammar", async () => {
      const { qitemId, wakeId } = await baton();
      expect(repo.pumpedWake(qitemId)).toMatchObject({ kind: "open", nudgeResult: "retained:pump" });
      seen.set(messageId(wakeId), { id: messageId(wakeId), recordedAt: new Date(nowMs).toISOString(), nonce: null });
      await pump.tick();
      expect(repo.pumpedWake(qitemId)).toEqual({ kind: "received", nudgeResult: "verified" });
    });

    it("a stale failure on a wake that arrived: the attempt reads the row, says verified, and sends nothing", async () => {
      const { qitemId, wakeId } = await baton();
      hopResult = { kind: "sent" };
      await settle();
      await pump.tick();
      await pump.tick();
      expect(row(wakeId).message_state).toBe("received");
      db.prepare("UPDATE queue_items SET last_nudge_result = 'failed:old', last_nudge_attempt = ? WHERE qitem_id = ?").run(new Date(nowMs - 20 * MINUTE).toISOString(), qitemId);
      await ladder();
      await settle();
      expect(item(qitemId).last_nudge_result).toBe("verified");
      expect(rowsFor(qitemId).map((r) => r.outbox_id)).toEqual([wakeId]);
    });

    it("only a wake counts: another message about the item, or a row the pump never took, says nothing", async () => {
      const src = await repo.create({ sourceSession: "relay@hr", destinationSession: SEAT, body: "x", nudge: false });
      store.accept({ id: messageId("content-1"), seat: SEAT, sender: "relay@hr", body: "text", auditPointer: src.qitemId, messageClass: "content" });
      expect(repo.pumpedWake(src.qitemId)).toBeNull();
      const other = await repo.create({ sourceSession: "relay@hr", destinationSession: PLAIN, body: "y", nudge: false });
      new MessageLedger(db).accept({ id: "ledger-1", seat: PLAIN, sender: "relay@hr", body: "text", identityProvenance: "transport:v1", auditPointer: other.qitemId, messageClass: "nudge" });
      expect(row("ledger-1").message_state).toBe("accepted");
      expect(repo.pumpedWake(other.qitemId)).toBeNull();
    });
  });

  describe("the item stays the obligation", () => {
    it("a closed item ends its wake at the next attempt, with no send and no notice", async () => {
      const { qitemId, wakeId } = await baton();
      const hops = hopTexts.length;
      db.prepare("UPDATE queue_items SET state = 'done' WHERE qitem_id = ?").run(qitemId);
      await pump.tick();
      expect(hopTexts).toHaveLength(hops);
      expect(row(wakeId)).toMatchObject({ message_state: "undeliverable", ack_evidence: "superseded", delivery_state: "failed" });
    });

    it("a claimed item ends its wake too: only a pending item is waiting to be woken", async () => {
      const { qitemId, wakeId } = await baton();
      await repo.claim({ qitemId, destinationSession: SEAT });
      await pump.tick();
      expect(row(wakeId)).toMatchObject({ message_state: "undeliverable", ack_evidence: "superseded" });
    });

    it("a plain nudge carrying a parked owner's decision outlives the claim, and ends when the item closes", async () => {
      const { qitemId, wakeId } = await baton();
      await repo.claim({ qitemId, destinationSession: SEAT });
      await pump.tick();
      expect(row(wakeId).message_state).toBe("undeliverable");
      await repo.maybeNudge(qitemId, SEAT, true, "relay@hr", "Your decision came back.");
      await settle();
      await pump.tick();
      const nudge = rowsFor(qitemId).map((r) => r.outbox_id).find((id) => id.startsWith("guard-nudge-"))!;
      expect(row(nudge).message_state).toBe("attempting");
      await settle();
      db.prepare("UPDATE queue_items SET state = 'done' WHERE qitem_id = ?").run(qitemId);
      await pump.tick();
      expect(row(nudge)).toMatchObject({ message_state: "undeliverable", ack_evidence: "superseded" });
    });

    it("a blocker wake ends when the item left the transition it was for", async () => {
      const { qitemId, wakeId } = await baton();
      db.prepare("UPDATE outbox_entries SET outbox_id = 'wake-intent-blocker-999999' WHERE outbox_id = ?").run(wakeId);
      await pump.tick();
      expect(row("wake-intent-blocker-999999")).toMatchObject({ message_state: "undeliverable", ack_evidence: "superseded" });
      expect(item(qitemId).state).toBe("pending");
      expect(repo.pumpedWake(qitemId)).toBeNull();  // superseded says nothing about the item: the ladder's own path is open to it
    });
  });

  describe("one driver per row", () => {
    it("a later wake of the same group leaves the row the pump already has where it is", async () => {
      const first = await baton();
      const tag = "queue:return:same-work";
      db.prepare("UPDATE outbox_entries SET tags = ? WHERE outbox_id = ?").run(JSON.stringify([tag]), first.wakeId);
      const second = await repo.create({ sourceSession: "sender@hr", destinationSession: "relay@hr", body: "more", nudge: false });
      const { created } = await repo.handoff({ qitemId: second.qitemId, fromSession: "relay@hr", toSession: SEAT, nudge: false });
      const secondWake = `wake-intent-${created.qitemId}`;
      new OutboxHandler(db).record({ outboxId: secondWake, senderSession: "relay@hr", destinationSession: SEAT, body: "second wake", tags: [tag], auditPointer: created.qitemId });
      await repo.deliverWakeForSuccessor(created.qitemId, SEAT, true);
      await pump.tick();
      expect(row(first.wakeId)).toMatchObject({ delivery_state: "pending", message_state: "attempting" });
      expect(row(secondWake).message_state).toBe("accepted");  // its turn comes after the row ahead of it
    });

    it("a second delivery of a row the pump has is a skip, and leaves it open", async () => {
      const { qitemId, wakeId } = await baton();
      await repo.deliverWakeForSuccessor(qitemId, SEAT, true);
      expect(row(wakeId)).toMatchObject({ delivery_state: "pending", message_state: "attempting" });
    });
  });

  describe("a crash between the claim and the hand-over", () => {
    it("the boundary gives the claim to the pump, and an ungated seat's stays closed as ever", async () => {
      const outbox = new OutboxHandler(db);
      const gated = await baton();
      db.prepare("DELETE FROM outbox_entries WHERE outbox_id = ?").run(gated.wakeId);
      outbox.record({ outboxId: gated.wakeId, senderSession: "relay@hr", destinationSession: SEAT, body: "wake", auditPointer: gated.qitemId });
      outbox.claimForDelivery(gated.wakeId);
      const plain = await repo.create({ sourceSession: "relay@hr", destinationSession: PLAIN, body: "x", nudge: false });
      const plainWake = `wake-intent-${plain.qitemId}`;
      outbox.record({ outboxId: plainWake, senderSession: "relay@hr", destinationSession: PLAIN, body: "wake", auditPointer: plain.qitemId });
      outbox.claimForDelivery(plainWake);

      expect(repo.reconcileAbandonedWakeIntents()).toBe(1);
      expect(row(plainWake).delivery_state).toBe("indeterminate");
      expect(row(gated.wakeId)).toMatchObject({ delivery_state: "pending", message_state: "accepted", message_pump_owned: 1 });
      await pump.tick();
      expect(hopTexts.flat().filter((id) => id === gated.wakeId).length).toBeGreaterThan(0);
    });
  });

  describe("a wake the typing guard holds", () => {
    function hold(id: string) {
      db.prepare(`UPDATE outbox_entries SET delivery_state = 'retained', message_state = NULL, message_pump_owned = NULL, attempts = 0,
        guard_binding = '{"nodeId":"n","session":"dev@hr","occupant":null,"pane":null}' WHERE outbox_id = ?`).run(id);
    }

    it("on a seat the pump serves it counts as the pump's: the ladder adds no second row", async () => {
      const { qitemId, wakeId } = await baton();
      hold(wakeId);
      db.prepare("UPDATE queue_items SET last_nudge_result = 'retained:typing_guard' WHERE qitem_id = ?").run(qitemId);
      expect(repo.pumpedWake(qitemId)).toMatchObject({ kind: "open" });
      age(qitemId, INTERVAL_S / 60 + 1);  // due, and short of the notice
      await ladder();
      await settle();
      expect(rowsFor(qitemId).map((r) => r.outbox_id)).toEqual([wakeId]);
      expect(notes(qitemId).filter((n) => n.startsWith(LADDER_ATTEMPT_PREFIX))).toEqual([]);
    });

    it("a re-delivery says the pump holds it, so the ladder never reads a retry there", async () => {
      const { qitemId, wakeId } = await baton();
      hold(wakeId);
      await repo.deliverWakeForSuccessor(qitemId, SEAT, true);
      expect(item(qitemId).last_nudge_result).toBe("retained:pump");
    });
  });

  describe("controls: a seat with no gate keeps its ladder", () => {
    it("a held row on an ungated seat is not the pump's", async () => {
      const plain = await repo.create({ sourceSession: "relay@hr", destinationSession: PLAIN, body: "x", nudge: false });
      new OutboxHandler(db).retain({ outboxId: `wake-intent-${plain.qitemId}`, senderSession: "relay@hr", destinationSession: PLAIN, body: "w", auditPointer: plain.qitemId, messageClass: "nudge" }, { nodeId: "n", session: PLAIN, occupant: null, pane: null });
      expect(repo.pumpedWake(plain.qitemId)).toBeNull();
    });

    it("the retry rung runs as before: the ladder's wake is called and its marker written", async () => {
      const src = await repo.create({ sourceSession: "sender@hr", destinationSession: "relay@hr", body: "the work", nudge: false });
      const { created } = await repo.handoff({ qitemId: src.qitemId, fromSession: "relay@hr", toSession: PLAIN, nudge: false });
      db.prepare("UPDATE queue_items SET last_nudge_result = 'failed:no session', last_nudge_attempt = ? WHERE qitem_id = ?").run(new Date(nowMs - 20 * MINUTE).toISOString(), created.qitemId);
      const called: string[] = [];
      await ladder({ attemptWake: async (id) => { called.push(id); return "failed:no session"; } });
      expect(called).toEqual([created.qitemId]);
      expect(notes(created.qitemId).filter((n) => n.startsWith(LADDER_ATTEMPT_PREFIX))).toHaveLength(1);
    });

    it("a queue with no pump attached reads no row", async () => {
      const bare = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
      const { qitemId } = await baton();
      expect(bare.pumpedWake(qitemId)).toBeNull();
    });
  });
});
