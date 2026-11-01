// Seat Messaging S3: for a gated seat only the pump drives a row. SessionTransport hands off and never races it. Real database and real
// SessionTransport; the send adapters fail if touched, so "the transport wrote nothing" is measured.
import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { retainedNudgeResult } from "../src/domain/queue-repository.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { HANDED_TO_PUMP, SessionTransport } from "../src/domain/session-transport.js";
import { PumpHandOff } from "../src/domain/seat-messaging/hand-off.js";
import { MessagePump } from "../src/domain/seat-messaging/message-pump.js";
import { MessageStore } from "../src/domain/seat-messaging/message-store.js";
import { messageId, type LastHop, type SeatGate } from "../src/domain/seat-messaging/ports.js";
import { NO_SEAT_MESSAGING_PORTS } from "../src/domain/seat-messaging/pump-ports.js";
import { tmuxStub } from "./helpers/tmux-stub.js";

const SEAT = "dev@hr";

describe("a wake's record", () => {
  it("names whose hands it is in", () => {
    expect(retainedNudgeResult(HANDED_TO_PUMP)).toBe("retained:pump");
    expect(retainedNudgeResult("typing_guard_enabled")).toBe("retained:typing_guard");
  });
});

describe("SessionTransport and the pump", () => {
  let db: Database.Database;
  let writes: string[];
  let hopCalls: string[];
  let transport: SessionTransport;
  const row = (id: string) => db.prepare("SELECT * FROM outbox_entries WHERE outbox_id = ?").get(id) as Record<string, unknown> | undefined;

  function build(gated: boolean) {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    writes = []; hopCalls = [];
    const rigRepo = new RigRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    const rig = rigRepo.createRig("hr");
    const node = rigRepo.addNode(rig.id, "dev", { role: "worker", runtime: "claude-code" });
    sessionRegistry.updateStatus(sessionRegistry.registerSession(node.id, SEAT).id, "running");
    sessionRegistry.updateBinding(node.id, { attachmentType: "tmux", tmuxSession: SEAT, tmuxPane: "%1" });
    const gate: SeatGate = { version: 1, lookup: async () => ({ kind: "not_seen" }) };
    const hop: LastHop = { attempt: async (m) => { hopCalls.push(m.ids[0]); return { kind: "sent" }; } };
    const ports = gated ? { gateFor: () => gate, hopFor: () => hop } : NO_SEAT_MESSAGING_PORTS;
    const store = new MessageStore(db);
    const pump = new MessagePump({ store, ports, directory: { fate: () => ({ kind: "live", occupantGeneration: null }) }, held: { status: () => "held" }, senders: { returnToSender: async () => ({ kind: "returned", qitemId: "q" }) } });
    const tmuxAdapter = tmuxStub({
      hasSession: async () => true, probeSession: async () => ({ state: "present" as const }), capturePaneContent: async () => "idle\n❯ ",
      listSessions: async () => [], listWindows: async () => [], listPanes: async () => [], getPanePid: async () => null, getPaneCommand: async () => null,
      sendText: async (_t: string, text: string) => { writes.push(text); return { ok: true as const }; }, sendKeys: async () => { writes.push("<keys>"); return { ok: true as const }; },
    });
    tmuxAdapter.messageHandOff = new PumpHandOff(store, pump, ports);
    transport = new SessionTransport({ db, rigRepo, sessionRegistry, agentActivityStore: new AgentActivityStore({ db, eventBus }), eventBus, tmuxAdapter, sleep: async () => undefined });
    return { store, pump, tmuxAdapter };
  }

  describe("a gated seat", () => {
    let built: ReturnType<typeof build>;
    beforeEach(() => { built = build(true); });

    it("hands a send to the pump: the transport writes nothing, the row is the pump's, and the answer says so", async () => {
      const result = await transport.send(SEAT, "hello", { deliveryId: "m1", actorSession: "lead@hr" });
      await new Promise((r) => setImmediate(r));
      expect(writes).toEqual([]);
      expect(hopCalls).toEqual(["m1"]);
      expect(result).toMatchObject({ ok: true, sent: false, verified: false, outcome: "retained", reason: "handed_to_pump", outboxIds: ["m1"] });
      expect(row("m1")).toMatchObject({ message_state: "attempting", delivery_state: "pending", attempts: 1, body: "hello", sender_session: "lead@hr" });
    });

    it("keeps class, lane and occupant on the row", async () => {
      await transport.send(SEAT, "p", { deliveryId: "m1", messageClass: "lifecycle", lane: 1, occupantGeneration: "g1" });
      expect(row("m1")).toMatchObject({ class: "lifecycle", lane: 1, occupant_generation: "g1" });
    });

    it("a repeat under the same id is the same message: no second row, no second driver", async () => {
      await transport.send(SEAT, "hello", { deliveryId: "m1", actorSession: "lead@hr" });
      const second = await transport.send(SEAT, "hello", { deliveryId: "m1", actorSession: "lead@hr" });
      expect(second).toMatchObject({ ok: true, reason: "handed_to_pump" });
      expect((db.prepare("SELECT count(*) AS n FROM outbox_entries").get() as { n: number }).n).toBe(1);
      expect(writes).toEqual([]);
    });

    it("a repeat of an id that already ended changes nothing, and writes nothing", async () => {
      const { store } = built;
      await transport.send(SEAT, "hello", { deliveryId: "m1", actorSession: "lead@hr" });
      store.recordReceived({ id: messageId("m1"), recordedAt: "1970-01-01T00:00:00.000Z", nonce: null }, 1);
      expect(await transport.send(SEAT, "hello", { deliveryId: "m1", actorSession: "lead@hr" })).toMatchObject({ ok: true, sent: false, reason: "message_already_ended" });
      expect(writes).toEqual([]);
    });

    it("a different body under the id is refused, and nothing is written", async () => {
      await transport.send(SEAT, "hello", { deliveryId: "m1", actorSession: "lead@hr" });
      expect(await transport.send(SEAT, "other", { deliveryId: "m1", actorSession: "lead@hr" })).toMatchObject({ ok: false, reason: "delivery_identity_conflict" });
      expect(writes).toEqual([]);
    });

    it("a row that cannot be committed refuses the send", async () => {
      db.exec("DROP TABLE outbox_entries");
      const result = await transport.send(SEAT, "hello", { deliveryId: "m1" });
      expect(result).toMatchObject({ ok: false, reason: "message_not_recorded" });
      expect(writes).toEqual([]);
    });

    it("a wake row the drain claimed moves to the pump, whole group, and the drain's final write cannot take it back", async () => {
      const outbox = new OutboxHandler(db);
      for (const id of ["wake-intent-a", "wake-intent-b"]) {
        outbox.record({ outboxId: id, senderSession: "lead@hr", destinationSession: SEAT, body: `wake ${id}` });
        outbox.claimForDelivery(id);
      }
      const result = await transport.send(SEAT, "joined text", { committedOutboxIds: ["wake-intent-a", "wake-intent-b"], actorSession: "lead@hr" });
      expect(writes).toEqual([]);
      expect(result).toMatchObject({ ok: true, outcome: "retained", reason: "handed_to_pump" });
      for (const id of ["wake-intent-a", "wake-intent-b"]) {
        expect(row(id)).toMatchObject({ delivery_state: "pending", lane: 2, class: "nudge" });
        expect(row(id)!.message_state).not.toBeNull();
        outbox.finalizeDelivery(id, "retained");
        expect(row(id)!.delivery_state).toBe("pending");
      }
      expect(outbox.listPending("wake-intent-")).toEqual([]);
    });

    it("the pump's own attempt goes through: it is not handed back to itself", async () => {
      const result = await transport.send(SEAT, "hello", { deliveryId: "m1", pumpAttempt: true });
      expect(result.reason).not.toBe("handed_to_pump");
      expect(writes.join("")).toContain("hello");
    });

    it("a row its caller settles stays with that caller", async () => {
      const result = await transport.send(SEAT, "hello", { deliveryId: "m1", ownsOutboxRow: true });
      expect(result.reason).not.toBe("handed_to_pump");
      expect(writes.join("")).toContain("hello");
    });

    it("a seat with a gate and no hop is not the pump's: nothing could carry it", () => {
      const { store, pump } = built;
      const gate: SeatGate = { version: 1, lookup: async () => ({ kind: "not_seen" }) };
      expect(new PumpHandOff(store, pump, { gateFor: () => gate, hopFor: () => null }).takes(SEAT)).toBe(false);
    });

    it("what is not a message stays direct: a submit-only Enter, and a person's answer to a prompt", async () => {
      expect((await transport.send(SEAT, "", { submitOnly: true })).reason).not.toBe("handed_to_pump");
      expect((await transport.send(SEAT, "1", { dangerouslyInteract: true, reason: "answer", actorSession: "jim@hr" })).reason).not.toBe("handed_to_pump");
    });

    for (const [name, opts] of [
      ["/compact, a command", { messageClass: "command" as const }],
      ["a send with a closure on it", { beforeWrite: () => undefined }],
      ["startup text with its submit check", { onStartupMismatch: () => undefined }],
    ] as const) {
      it(`${name} stays direct, and its row is never open to the pump, so a crash cannot make two drivers`, async () => {
        const result = await transport.send(SEAT, "text", { deliveryId: "d1", keepRowOpenOnRefusal: true, ...opts });
        expect(result.reason).not.toBe("handed_to_pump");
        expect(writes.join("")).toContain("text");
        expect(row("d1")?.message_state ?? null).toBeNull();
      });
    }

    it("a direct send's row is closed to the pump before the write, not after it", async () => {
      let during: unknown = "unset";
      await transport.send(SEAT, "text", { deliveryId: "d1", beforeWrite: () => { during = row("d1")?.message_state ?? null; } });
      expect(during).toBeNull();
    });
  });

  describe("a seat with no gate", () => {
    beforeEach(() => { build(false); });

    it("is exactly as it was: the transport sends", async () => {
      const result = await transport.send(SEAT, "hello", { deliveryId: "m1", actorSession: "lead@hr" });
      expect(result.reason).not.toBe("handed_to_pump");
      expect(writes.join("")).toContain("hello");
      expect(hopCalls).toEqual([]);
    });
  });

  it("with no hand-off wired (the setting off), every seat is as it was", async () => {
    build(true).tmuxAdapter.messageHandOff = undefined;
    await transport.send(SEAT, "hello", { deliveryId: "m9" });
    expect(writes.join("")).toContain("hello");
  });
});
