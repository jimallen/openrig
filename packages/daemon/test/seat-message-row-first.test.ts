// Seat Messaging S1: the row commits before anything is written to the seat, and the id and body never change across attempts. Each
// test reads the row at the moment of the write, through a tmux fake that looks at the database: that is the order, not the end state.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { OUTBOX_DELIVERY_STATES, OutboxHandler } from "../src/domain/outbox-handler.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { EventBus } from "../src/domain/event-bus.js";
import { MessageLedger, lifecycleMessageId } from "../src/domain/seat-messaging/message-ledger.js";
import { SEAT_MESSAGE_ROLLBACK_SQL } from "../src/db/migrations/122_seat_message.js";
import { transportRoutes } from "../src/routes/transport.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

/** The same object, read as the narrow part of `T` the test gives it. */
const view = <T,>(fake: object): T => Object.assign(fake);

const SEAT = "dev@rig";

interface Row { delivery_path?: string | null; outbox_id: string; delivery_state: string; message_state: string | null; attempts: number; body: string; class: string | null; lane: number | null; message_id: string | null }

describe("a seat message's row", () => {
  let db: Database.Database;
  let outbox: OutboxHandler;
  /** Rows seen by the fake at the moment text reached it. */
  let atWrite: Row[][];
  let sendTextResult: { ok: boolean; code?: string; message?: string };
  const rows = () => db.prepare("SELECT * FROM outbox_entries ORDER BY rowid").all() as Row[];

  function transport(): SessionTransport {
    const tmux = view<TmuxAdapter>({
      hasSession: async () => true,
      probeSession: async () => ({ state: "present" }),
      capturePaneContent: async () => "idle\n❯ ",
      getPaneCommand: async () => "bash",
      sendText: async () => { atWrite.push(rows()); return sendTextResult; },
      sendKeys: async () => ({ ok: true }),
    });
    const rigRepo = new RigRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const rig = rigRepo.createRig("rig");
    const node = rigRepo.addNode(rig.id, "dev", { role: "worker", runtime: "terminal" });
    const session = sessionRegistry.registerSession(node.id, SEAT);
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: SEAT, tmuxPane: "%1" });
    return new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux });
  }

  beforeEach(() => {
    db = createDb(); migrate(db, ALL_MIGRATIONS); outbox = new OutboxHandler(db); atWrite = []; sendTextResult = { ok: true };
    new EventBus(db);
  });
  afterEach(() => db.close());

  describe("invariant 1: the row commits before the write", () => {
    it("is already there, attempting, when the text reaches the seat", async () => {
      await transport().send(SEAT, "hello", { actorSession: "a@rig", deliveryId: "m1" });
      expect(atWrite).toHaveLength(1);
      expect(atWrite[0]).toHaveLength(1);
      expect(atWrite[0]![0]).toMatchObject({ outbox_id: "m1", delivery_state: "pending", message_state: "attempting", attempts: 1, body: "hello", class: "content", lane: 2, message_id: "m1" });
    });

    it("a send with no id gets a minted one, and its attribution is the row's", async () => {
      await transport().send(SEAT, "hello");
      expect(atWrite[0]![0]!.outbox_id).toMatch(/^seat-msg-[0-9a-f-]{36}$/);
      expect(outbox.getById(atWrite[0]![0]!.outbox_id)?.senderSession).toBe("unknown");
    });

    it("a row that cannot be written refuses the send, and nothing is typed", async () => {
      const t = transport();
      vi.spyOn(MessageLedger.prototype, "accept").mockImplementationOnce(() => { throw new Error("disk full"); });
      const result = await t.send(SEAT, "hello");
      expect(result).toMatchObject({ ok: false, sent: false, reason: "message_not_recorded" });
      expect(atWrite).toHaveLength(0);
      expect(rows()).toHaveLength(0);
    });

    it("types nothing for a submit-only Enter and leaves no row: no text, no message", async () => {
      await transport().send(SEAT, "", { submitOnly: true, expectedStagedText: "x" });
      expect(rows()).toHaveLength(0);
    });
  });

  describe("settling, unchanged in its meaning", () => {
    it("a delivered send settles delivered, and is out of the pump's hands", async () => {
      await transport().send(SEAT, "hello", { deliveryId: "m1" });
      expect(rows()[0]).toMatchObject({ delivery_state: "delivered", message_state: null, attempts: 1 });
    });

    it("a refused send settles failed; a caller that retries itself keeps it open", async () => {
      sendTextResult = { ok: false, code: "send_failed", message: "no" };
      const t = transport();
      await t.send(SEAT, "hello", { deliveryId: "m1" });
      await t.send(SEAT, "other", { deliveryId: "m2", keepRowOpenOnRefusal: true });
      expect(rows().map((r) => [r.delivery_state, r.message_state])).toEqual([["failed", null], ["pending", "attempting"]]);
    });

    it("an attempt that throws is neither delivered nor failed: bytes may have left", async () => {
      const t = transport();
      vi.spyOn(view<{ attempt: () => Promise<never> }>(t), "attempt").mockRejectedValueOnce(new Error("boom"));
      await expect(t.send(SEAT, "hello", { deliveryId: "m1" })).rejects.toThrow("boom");
      expect(rows()[0]).toMatchObject({ delivery_state: "indeterminate", message_state: null });
    });
  });

  describe("invariant 2: one id, one body, across attempts", () => {
    it("a repeat under an id is one more attempt at the same row, which the next outcome can settle", async () => {
      const t = transport();
      sendTextResult = { ok: false, code: "send_failed", message: "no" };
      await t.send(SEAT, "hello", { deliveryId: "m1" });
      expect(rows()[0]).toMatchObject({ delivery_state: "failed", attempts: 1 });
      sendTextResult = { ok: true };
      await t.send(SEAT, "hello", { deliveryId: "m1" });
      expect(rows()).toHaveLength(1);
      expect(rows()[0]).toMatchObject({ delivery_state: "delivered", attempts: 2, message_state: null });
      expect(atWrite[1]![0]).toMatchObject({ delivery_state: "pending", message_state: "attempting", attempts: 2 });
    });

    it.each([
      ["a different body", "other", SEAT, "a@rig"],
      ["a different sender", "hello", SEAT, "b@rig"],
    ])("%s under an id is refused, unwritten", async (_name, text, seat, actor) => {
      const t = transport();
      await t.send(SEAT, "hello", { deliveryId: "m1", actorSession: "a@rig" });
      const result = await t.send(seat, text, { deliveryId: "m1", actorSession: actor });
      expect(result).toMatchObject({ ok: false, sent: false, reason: "delivery_identity_conflict" });
      expect(atWrite).toHaveLength(1);
      expect(rows()[0]).toMatchObject({ attempts: 1, body: "hello" });
    });

    it("a caller that rebuilds its text per attempt carries the first body (freezeBody)", async () => {
      const t = transport();
      sendTextResult = { ok: false, code: "send_failed", message: "no" };
      const seen: string[] = [];
      const spy = vi.spyOn(view<{ attempt: (s: string, text: string) => Promise<unknown> }>(t), "attempt").mockImplementation(async (s, text) => { seen.push(text); return { ok: false, sessionName: s, reason: "send_failed" }; });
      await t.send(SEAT, "stamped 1", { deliveryId: "m1", freezeBody: true });
      await t.send(SEAT, "stamped 2", { deliveryId: "m1", freezeBody: true });
      spy.mockRestore();
      expect(seen).toEqual(["stamped 1", "stamped 1"]);
    });

    it("a committed wake row is counted, and the drain keeps it: no message state", async () => {
      outbox.record({ outboxId: "wake-intent-q1", senderSession: "a@rig", destinationSession: SEAT, body: "wake" });
      expect(outbox.claimForDelivery("wake-intent-q1")).toBe(true);
      await transport().send(SEAT, "wake", { committedOutboxIds: ["wake-intent-q1"], actorSession: "a@rig" });
      expect(rows()[0]).toMatchObject({ delivery_state: "sending", attempts: 1, message_state: null });
    });

    it("a lifecycle id follows its occupant: the same text to a successor is a different message", () => {
      expect(lifecycleMessageId("startup", SEAT, "gen-1", "boot")).toBe(lifecycleMessageId("startup", SEAT, "gen-1", "boot"));
      expect(lifecycleMessageId("startup", SEAT, "gen-1", "boot")).not.toBe(lifecycleMessageId("startup", SEAT, "gen-2", "boot"));
    });
  });

  describe("a native attempt", () => {
    /** The inbox's own claim and release on the accepted row, with nothing written: what a failed socket write does. */
    const fallingBack = (t: SessionTransport) => {
      Object.assign(t, { nativeInbox: {
        eligibility: async () => ({ ok: true, endpoint: {} }),
        deliver: async (input: { deliveryId: string }) => {
          outbox.claimNative(input.deliveryId, "ab".repeat(8), new Date().toISOString());
          outbox.releaseNativeClaim(input.deliveryId, false);
          return { kind: "fallback", reason: "socket_write_failed", outboxIds: [], acked: false };
        },
      } });
      return t;
    };

    it("that wrote nothing leaves the row open for the tmux attempt, never in a claim nobody owns", async () => {
      await fallingBack(transport()).send(SEAT, "hello", { deliveryId: "m1", actorSession: "a@rig" });
      expect(atWrite[0]![0]).toMatchObject({ delivery_state: "pending", message_state: "attempting" });
      expect(rows()[0]).toMatchObject({ delivery_state: "delivered", message_state: null });
    });

    it("that wrote hands the row to the native sweep, out of the pump's hands", async () => {
      const t = transport();
      Object.assign(t, { nativeInbox: {
        eligibility: async () => ({ ok: true, endpoint: {} }),
        deliver: async (input: { deliveryId: string }) => { outbox.claimNative(input.deliveryId, "ab".repeat(8), new Date().toISOString()); return { kind: "written", write: "all", outboxIds: [input.deliveryId], acked: false }; },
      } });
      await t.send(SEAT, "hello", { deliveryId: "m1", actorSession: "a@rig" });
      expect(rows()[0]).toMatchObject({ delivery_state: "sending", message_state: null, delivery_path: "native" });
    });
  });

  describe("direct text (startup, handover, the resume probe)", () => {
    const ledger = () => new MessageLedger(db, { resolveOccupantGeneration: () => "gen-1" });

    it("commits before the write, and settles on the write's result", async () => {
      let during: Row | undefined;
      await ledger().carryDirect({ kind: "startup", seat: SEAT, body: "boot", messageClass: "lifecycle" }, async () => { during = rows()[0]; return { ok: true }; });
      expect(during).toMatchObject({ delivery_state: "pending", message_state: "attempting", attempts: 1, class: "lifecycle", lane: 0, occupant_generation: "gen-1" });
      expect(rows()[0]).toMatchObject({ delivery_state: "delivered", message_state: null });
    });

    it("a failed write settles failed; a repeat for this occupant is the same row", async () => {
      const input = { kind: "startup", seat: SEAT, body: "boot", messageClass: "lifecycle" as const };
      await ledger().carryDirect(input, async () => ({ ok: false, message: "no" }));
      expect(rows()[0]).toMatchObject({ delivery_state: "failed", ack_detail: "no" });
      await ledger().carryDirect(input, async () => ({ ok: true }));
      expect(rows()).toHaveLength(1);
      expect(rows()[0]).toMatchObject({ delivery_state: "delivered", attempts: 2 });
    });

    it("a Command is never the pump's: its row has no message state at any point", async () => {
      let during: Row | undefined;
      await ledger().carryDirect({ kind: "resume-probe", seat: "probe", body: "cmd", messageClass: "command" }, async () => { during = rows()[0]; return { ok: true }; });
      expect(during).toMatchObject({ class: "command", message_state: null, lane: null, attempts: 1 });
    });
  });

  it("a Command the daemon died on before its first attempt is still not the pump's", () => {
    new MessageLedger(db).accept({ id: "seat-msg-compaction-a-compact", seat: SEAT, body: "/compact", sender: "daemon@kernel", identityProvenance: "transport:v1", messageClass: "command" });
    expect(rows()[0]).toMatchObject({ class: "command", message_state: null, attempts: 0 });
  });

  it("a message the daemon died on before its first attempt reads accepted, 0 attempts: it certainly never went out", () => {
    new MessageLedger(db).accept({ id: "m1", seat: SEAT, body: "x", sender: "a@rig", identityProvenance: "transport:v1" });
    expect(rows()[0]).toMatchObject({ message_state: "accepted", attempts: 0, delivery_state: "pending" });
  });

  describe("the route", () => {
    function app(t: SessionTransport) {
      const hono = new Hono();
      hono.use("*", async (c, next) => { c.set("sessionTransport" as never, t); c.set("outboxHandler" as never, outbox); await next(); });
      hono.route("/", transportRoutes());
      return hono;
    }
    const post = (hono: Hono, path: string, body: unknown) => hono.request(path, { method: "POST", headers: { "content-type": "application/json", "x-openrig-session": "a@rig" }, body: JSON.stringify(body) });

    it.each(["wake-intent-x", "guard-nudge-x", "seat-msg-x"])("refuses a caller's id under a daemon prefix (%s): a pending `wake-intent-` row would be executed at boot", async (id) => {
      const hono = app(transport());
      for (const path of ["/send", "/broadcast"]) {
        const res = await post(hono, path, { session: SEAT, rig: "rig", text: "hi", deliveryId: id });
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ reason: "invalid_delivery_id" });
      }
      expect(rows()).toHaveLength(0);
    });

    it("refuses an id a native marker could not carry", async () => {
      expect((await post(app(transport()), "/send", { session: SEAT, text: "hi", deliveryId: "has space" })).status).toBe(400);
    });

    it("a repeat under a caller's id is one row and answers with the id; a different text is 409", async () => {
      const hono = app(transport());
      const first = await post(hono, "/send", { session: SEAT, text: "hi", deliveryId: "job-1" });
      expect(await first.json()).toMatchObject({ messageId: "job-1", ok: true });
      await post(hono, "/send", { session: SEAT, text: "hi", deliveryId: "job-1" });
      expect(rows()).toHaveLength(1);
      expect(rows()[0]!.attempts).toBe(2);
      expect((await post(hono, "/send", { session: SEAT, text: "changed", deliveryId: "job-1" })).status).toBe(409);
    });

    it("a fan-out under a caller's id is `<id>:<seat>` with no Sent stamp, so its repeat is the same bytes", async () => {
      const hono = app(transport());
      const body = { sessions: [SEAT], text: "hi", deliveryId: "fan-1", envelopeSender: "x" };
      await post(hono, "/broadcast", body);
      await post(hono, "/broadcast", body);
      expect(rows().map((r) => [r.outbox_id, r.attempts])).toEqual([[`fan-1:${SEAT}`, 2]]);
      expect(rows()[0]!.body).not.toContain("Sent:");
    });
  });

  describe("rollback (design-delivery-s4, section 3)", () => {
    it("every delivery_state an S1 row holds is in the vocabulary 771a08e5 can read", async () => {
      const t = transport();
      await t.send(SEAT, "a", { deliveryId: "m1" });
      sendTextResult = { ok: false, code: "send_failed", message: "no" };
      await t.send(SEAT, "b", { deliveryId: "m2" });
      await t.send(SEAT, "c", { deliveryId: "m3", keepRowOpenOnRefusal: true });
      const live = ["pending", "sending", "delivered", "failed", "indeterminate", "retained", "retired"];
      expect([...OUTBOX_DELIVERY_STATES]).toEqual(live);
      for (const row of rows()) expect(live).toContain(row.delivery_state);
    });

    it("B4a closes every open row by what it is, keeps wake rows pending, and leaves none for the pump", () => {
      const open = (id: string, attempts: number, cls: string) => {
        outbox.record({ outboxId: id, senderSession: "a@rig", destinationSession: SEAT, body: id, messageState: attempts ? "attempting" : "accepted", messageClass: cls as "content" });
        db.prepare("UPDATE outbox_entries SET attempts = ? WHERE outbox_id = ?").run(attempts, id);
      };
      open("c-tried", 1, "content"); open("c-new", 0, "content"); open("l", 1, "lifecycle"); open("wake-intent-w", 1, "nudge");
      db.exec(`BEGIN; ${SEAT_MESSAGE_ROLLBACK_SQL} COMMIT;`);
      const state = (id: string) => db.prepare("SELECT delivery_state AS d, ack_evidence AS e, message_state AS m FROM outbox_entries WHERE outbox_id = ?").get(id);
      expect(state("c-tried")).toEqual({ d: "indeterminate", e: "crash_reconciled", m: null });
      expect(state("c-new")).toEqual({ d: "failed", e: "send_failed", m: null });
      expect(state("l")).toEqual({ d: "failed", e: "superseded", m: null });
      expect(state("wake-intent-w")).toEqual({ d: "pending", e: null, m: null });
    });
  });
});
