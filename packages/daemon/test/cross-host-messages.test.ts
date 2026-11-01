// Seat Messaging S4h: a message to a seat on another host. Two real databases, two real pumps, the real route and the real SessionTransport,
// joined by a fetch that calls the far app in process, so every far answer is the route's own. The far seat's gate and hop are stubs: the real
// pair of daemons is in cross-host-messages.real.test.ts.
import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import type { HostRegistryLoadResult } from "../src/domain/hosts/hosts-registry-reader.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { MESSAGE_MAX_BYTES, SessionTransport } from "../src/domain/session-transport.js";
import { CrossHostSenderReturn, crossHostMessageId, FarDaemons, FarSeatDirectory, farSeatName, parseFarSeat, withFarSeats } from "../src/domain/seat-messaging/far-daemon.js";
import { PumpHandOff } from "../src/domain/seat-messaging/hand-off.js";
import { MessagePump } from "../src/domain/seat-messaging/message-pump.js";
import { MessageStore } from "../src/domain/seat-messaging/message-store.js";
import { messageId, type LastHop, type SeatGate } from "../src/domain/seat-messaging/ports.js";
import { NO_SEAT_MESSAGING_PORTS, type SeatMessagingPorts, type SenderReturn } from "../src/domain/seat-messaging/pump-ports.js";
import { MESSAGE_STUCK_AFTER_MS, SeatMessagingHealthSource } from "../src/domain/seat-messaging/message-health.js";
import { messageRoutes } from "../src/routes/messages.js";
import { createTestApp } from "./helpers/test-app.js";
import { tmuxStub } from "./helpers/tmux-stub.js";

const FAR_SEAT = "dev@far";
const LOCAL_SENDER = "lead@near";
const NEAR = "near-host";
const FAST = { tickMs: 5, pauseRecheckMs: 5, backoffMs: [1, 1, 1] };
const until = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 400; i++) { if (check()) return; await new Promise((r) => setTimeout(r, 5)); }
  throw new Error(`timed out: ${what}`);
};
const rowOf = (db: Database.Database, id: string) => db.prepare("SELECT * FROM outbox_entries WHERE outbox_id = ?").get(id) as Record<string, unknown> | undefined;
const rowCount = (db: Database.Database) => (db.prepare("SELECT count(*) AS n FROM outbox_entries").get() as { n: number }).n;
const post = (app: Hono, path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.fetch(new Request(`http://far${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));

interface Side { db: Database.Database; app: Hono; store: MessageStore; hopCalls: string[]; pump: MessagePump; seen: Set<string> }

/** One daemon. `seatPorts` is what its own seats get; `far` adds the far seats, as startup does. */
function side(opts: { gated: boolean; pumpOff?: boolean; far?: FarDaemons; senders?: SenderReturn }): Side {
  const db = createDb();
  migrate(db, ALL_MIGRATIONS);
  const rigRepo = new RigRepository(db);
  const sessionRegistry = new SessionRegistry(db);
  const eventBus = new EventBus(db);
  const rig = rigRepo.createRig("far");
  const node = rigRepo.addNode(rig.id, "dev", { role: "worker", runtime: "claude-code" });
  sessionRegistry.updateStatus(sessionRegistry.registerSession(node.id, FAR_SEAT).id, "running");
  sessionRegistry.updateBinding(node.id, { attachmentType: "tmux", tmuxSession: FAR_SEAT, tmuxPane: "%1" });
  const hopCalls: string[] = [];
  const seen = new Set<string>();
  const gate: SeatGate = { version: 1, lookup: async (_seat, id) => (seen.has(id) ? { kind: "seen", record: { id, recordedAt: "2026-11-01T00:00:00.000Z", nonce: null } } : { kind: "not_seen" }) };
  const hop: LastHop = { attempt: async (m) => { hopCalls.push(m.ids[0]); return { kind: "sent" }; } };
  const store = new MessageStore(db);
  const own: SeatMessagingPorts = opts.gated ? { gateFor: () => gate, hopFor: () => hop } : NO_SEAT_MESSAGING_PORTS;
  const ports = opts.far ? withFarSeats(own, opts.far, (id) => store.senderOf(id)) : own;
  const inner = { fate: () => ({ kind: "live" as const, occupantGeneration: null }) };
  const pump = new MessagePump({
    store, ports, directory: opts.far ? new FarSeatDirectory(inner) : inner, held: { status: () => "held" },
    senders: opts.senders ?? { returnToSender: async () => ({ kind: "returned", qitemId: "q" }) }, timing: FAST,
  });
  const tmuxAdapter = tmuxStub({
    hasSession: async () => true, probeSession: async () => ({ state: "present" as const }), capturePaneContent: async () => "idle\n❯ ",
    listSessions: async () => [], listWindows: async () => [], listPanes: async () => [], getPanePid: async () => null, getPaneCommand: async () => null,
    sendText: async () => { throw new Error("no write outside the pump"); }, sendKeys: async () => { throw new Error("no write outside the pump"); },
  });
  if (!opts.pumpOff) tmuxAdapter.messageHandOff = new PumpHandOff(store, pump, ports);
  const transport = new SessionTransport({ db, rigRepo, sessionRegistry, agentActivityStore: new AgentActivityStore({ db, eventBus }), eventBus, tmuxAdapter, sleep: async () => undefined });
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("sessionTransport" as never, transport as never); c.set("outboxHandler" as never, new OutboxHandler(db) as never); await next(); });
  app.get("/healthz", (c) => c.json({ status: "ok", ...(transport.messageHandOff ? { messaging: 1 } : {}) }));
  app.route("/api/messages", messageRoutes({ bearerToken: null, far: opts.far }));
  return { db, app, store, hopCalls, pump, seen };
}

const originBody = (over: Record<string, unknown> = {}) => ({ id: "m1", seat: FAR_SEAT, body: "the text", origin: { host: NEAR, sender: `${LOCAL_SENDER}@${NEAR}` }, class: "content", ...over });

describe("the far daemon's accept", () => {
  let far: Side;
  beforeEach(() => { far = side({ gated: true }); });

  it("commits one row under (origin host, id), however often it is repeated, and answers the same", async () => {
    const first = await post(far.app, "/api/messages/accept", originBody());
    const second = await post(far.app, "/api/messages/accept", originBody());
    expect([first.status, second.status]).toEqual([200, 200]);
    const id = crossHostMessageId(NEAR, "m1");
    expect((await first.json() as { id: string }).id).toBe(id);
    expect((await second.json() as { id: string }).id).toBe(id);
    expect(rowCount(far.db)).toBe(1);
    expect(rowOf(far.db, id)).toMatchObject({ destination_session: FAR_SEAT, body: "the text", sender_session: `${LOCAL_SENDER}@${NEAR}`, message_pump_owned: 1, class: "content", lane: 2 });
  });

  it("an accept writes nothing to the seat itself, and a repeat after it arrived does not send it again", async () => {
    await post(far.app, "/api/messages/accept", originBody());
    const id = crossHostMessageId(NEAR, "m1");
    await until(() => far.hopCalls.includes(id), "the far pump's attempt");
    far.seen.add(id);
    await new Promise((r) => setTimeout(r, 5));
    await far.pump.tick();
    expect(rowOf(far.db, id)?.message_state).toBe("received");
    const attempts = far.hopCalls.length;
    const again = await post(far.app, "/api/messages/accept", originBody());
    expect(again.status).toBe(200);
    await new Promise((r) => setTimeout(r, 5));
    await far.pump.tick();
    expect(far.hopCalls.length).toBe(attempts);
    expect(rowCount(far.db)).toBe(1);
  });

  it("the same id from two origins is two messages", async () => {
    await post(far.app, "/api/messages/accept", originBody());
    await post(far.app, "/api/messages/accept", originBody({ origin: { host: "other-host", sender: `${LOCAL_SENDER}@other-host` } }));
    expect(rowCount(far.db)).toBe(2);
  });

  it("the same key with another body is delivery_identity_conflict, and the row keeps its text", async () => {
    await post(far.app, "/api/messages/accept", originBody());
    const res = await post(far.app, "/api/messages/accept", originBody({ body: "changed" }));
    expect(res.status).toBe(409);
    expect((await res.json() as { code: string }).code).toBe("delivery_identity_conflict");
    expect(rowOf(far.db, crossHostMessageId(NEAR, "m1"))?.body).toBe("the text");
  });

  it.each(["wake-intent-1", "guard-send-1"])("refuses the daemon's own id %s, so a remote caller never reaches the drain", async (id) => {
    const res = await post(far.app, "/api/messages/accept", originBody({ id }));
    expect(res.status).toBe(400);
    expect(rowCount(far.db)).toBe(0);
  });

  it("takes a daemon-minted id: the sender's seat-msg- ids are what it carries", async () => {
    expect((await post(far.app, "/api/messages/accept", originBody({ id: "seat-msg-abc" }))).status).toBe(200);
  });

  it.each(["lifecycle", "command"])("refuses class %s: a remote caller does not get a lower lane or a command", async (messageClass) => {
    expect((await post(far.app, "/api/messages/accept", originBody({ class: messageClass }))).status).toBe(400);
    expect(rowCount(far.db)).toBe(0);
  });

  it("takes class nudge, in the content lane", async () => {
    await post(far.app, "/api/messages/accept", originBody({ class: "nudge" }));
    expect(rowOf(far.db, crossHostMessageId(NEAR, "m1"))).toMatchObject({ class: "nudge", lane: 2 });
  });

  it("refuses a sender that is not of the origin host, so a key can't be spent in another host's name", async () => {
    expect((await post(far.app, "/api/messages/accept", originBody({ origin: { host: NEAR, sender: "lead@near@elsewhere" } }))).status).toBe(400);
    expect((await post(far.app, "/api/messages/accept", originBody({ origin: { host: NEAR, sender: "unknown" } }))).status).toBe(200);
  });

  it("refuses a body the pump could never carry, with no row", async () => {
    expect((await post(far.app, "/api/messages/accept", originBody({ body: "/compact" }))).status).toBe(400);
    expect((await post(far.app, "/api/messages/accept", originBody({ body: "!rm -rf x" }))).status).toBe(400);
    expect(rowCount(far.db)).toBe(0);
  });

  it.each([
    ["an id that is no string", { id: 7 }],
    ["an id outside the marker alphabet", { id: "a b" }],
    ["no seat", { seat: "" }],
    ["no body", { body: "" }],
    ["a body that is no string", { body: 7 }],
    ["no origin", { origin: null }],
    ["an origin host outside its alphabet", { origin: { host: "a b", sender: "unknown" } }],
  ])("refuses %s, with no row", async (_name, over) => {
    const res = await post(far.app, "/api/messages/accept", originBody(over));
    expect(res.status).toBe(400);
    expect((await res.json() as { code: string }).code).toBe("invalid_accept");
    expect(rowCount(far.db)).toBe(0);
  });

  it("a body over the limit is 413, with no row", async () => {
    expect((await post(far.app, "/api/messages/accept", originBody({ body: "x".repeat(MESSAGE_MAX_BYTES + 1) }))).status).toBe(413);
    expect(rowCount(far.db)).toBe(0);
  });

  it("an ambiguous seat is 409, not 404", async () => {
    const stub = new Hono();
    stub.use("*", async (c, next) => { c.set("sessionTransport" as never, { messageHandOff: {}, resolveSessions: async () => ({ ok: false, code: "ambiguous", error: "two seats" }) } as never); await next(); });
    stub.route("/api/messages", messageRoutes({ bearerToken: null }));
    const res = await post(stub, "/api/messages/accept", originBody());
    expect(res.status).toBe(409);
    expect((await res.json() as { code: string }).code).toBe("seat_unresolved");
  });

  it("names an unknown seat 404, with no row", async () => {
    expect((await post(far.app, "/api/messages/accept", originBody({ seat: "ghost@far" }))).status).toBe(404);
    expect(rowCount(far.db)).toBe(0);
  });

  it("a seat with no gate is refused, with no row: nothing could confirm it", async () => {
    const ungated = side({ gated: false });
    const res = await post(ungated.app, "/api/messages/accept", originBody());
    expect(res.status).toBe(409);
    expect((await res.json() as { code: string }).code).toBe("seat_not_gated");
    expect(rowCount(ungated.db)).toBe(0);
  });

  it("with the pump off it is 503", async () => {
    const off = side({ gated: true, pumpOff: true });
    expect((await post(off.app, "/api/messages/accept", originBody())).status).toBe(503);
  });

  it("reads a cross-host row's state, and nothing else", async () => {
    await post(far.app, "/api/messages/accept", originBody());
    const id = crossHostMessageId(NEAR, "m1");
    const res = await far.app.fetch(new Request(`http://far/api/messages/${id}`));
    expect(res.status).toBe(200);
    const shown = await res.json() as Record<string, unknown>;
    expect(shown).toMatchObject({ id, state: "open" });
    expect(JSON.stringify(shown)).not.toContain("the text");
    far.store.accept({ id: messageId("plain"), seat: FAR_SEAT, sender: "a@b", body: "x" });
    const local = await far.app.fetch(new Request("http://far/api/messages/plain"));
    expect(local.status).toBe(404);
    expect((await local.json() as { error: string }).error).toBe("message_not_found");
    expect((await far.app.fetch(new Request(`http://far/api/messages/${crossHostMessageId(NEAR, "nope")}`))).status).toBe(404);
  });

  it("says whether its seat takes a pumped message", async () => {
    expect(await (await far.app.fetch(new Request(`http://far/api/messages/takes?seat=${encodeURIComponent(FAR_SEAT)}`))).json()).toEqual({ takes: true, seat: FAR_SEAT });
    expect(await (await far.app.fetch(new Request("http://far/api/messages/takes?seat=ghost%40far"))).json()).toEqual({ takes: false });
    const ungated = side({ gated: false });
    expect(await (await ungated.app.fetch(new Request(`http://far/api/messages/takes?seat=${encodeURIComponent(FAR_SEAT)}`))).json()).toEqual({ takes: false });
  });
});

describe("the sender's daemon", () => {
  const registry: HostRegistryLoadResult = { ok: true, registry: { hosts: [{ id: "sparky", transport: "http", url: "http://far:1" }] } };
  let farSide: Side; let near: Side; let farDown: boolean; let requests: string[];
  const daemons = (fetchImpl: typeof fetch) => new FarDaemons({ selfHost: () => NEAR, loadRegistry: () => registry, fetchImpl, capabilityTtlMs: 0 });
  const bridge = (app: () => Hono): typeof fetch => async (input, init) => {
    const url = String(input);
    requests.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
    if (farDown) throw new Error("connection refused");
    return app().fetch(new Request(url, init));
  };
  const sendFar = (body: Record<string, unknown>, app = near.app) => post(app, "/api/messages/send-far", { host: "sparky", session: FAR_SEAT, text: "the text", ...body }, { "x-openrig-session": LOCAL_SENDER });
  const FAR_ID = (id: string) => crossHostMessageId(NEAR, id);

  beforeEach(() => {
    farDown = false; requests = [];
    farSide = side({ gated: true });
    near = side({ gated: false, far: daemons(bridge(() => farSide.app)) });
    near.pump.start();
  });

  it("the local row commits, the hop accepts at the far daemon, and the record is the far daemon's accept", async () => {
    const res = await sendFar({ deliveryId: "m1", waitMs: 2000 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: "held", host: "sparky", messageId: "m1" });
    const local = rowOf(near.db, "m1");
    expect(local).toMatchObject({ message_state: "received", destination_session: farSeatName("sparky", FAR_SEAT), ack_evidence: "far_accepted", sender_session: LOCAL_SENDER, class: "content", lane: 2 });
    expect(rowOf(farSide.db, FAR_ID("m1"))).toMatchObject({ destination_session: FAR_SEAT, body: "the text", sender_session: `${LOCAL_SENDER}@${NEAR}` });
    expect(new OutboxHandler(near.db).getById("m1")).toMatchObject({ ackEvidence: "far_accepted" });
    near.pump.stop();
  });

  it("the local row is not received until the far row exists: a failed accept leaves it open", async () => {
    await post(farSide.app, "/api/messages/accept", originBody({ id: "other" }));
    farSide = side({ gated: false });  // the far seat lost its gate: accepts are refused
    near.store.accept({ id: messageId("m2"), seat: farSeatName("sparky", FAR_SEAT), sender: LOCAL_SENDER, body: "b", messageClass: "content" });
    await until(() => (rowOf(near.db, "m2")?.attempts as number) >= 1, "an attempt");
    await near.pump.tick();
    expect(rowOf(near.db, "m2")).toMatchObject({ message_state: "attempting", message_last_refusal: expect.stringContaining("seat_not_gated") });
    near.pump.stop();
  });

  it("a repeat of the hop leaves one far row", async () => {
    const message = { ids: [messageId("m3")] as [ReturnType<typeof messageId>], seat: farSeatName("sparky", FAR_SEAT), body: "b", messageClass: "content" as const, lane: 2 as const };
    near.store.accept({ id: messageId("m3"), seat: message.seat, sender: LOCAL_SENDER, body: "b" });
    const ports = withFarSeats(NO_SEAT_MESSAGING_PORTS, daemons(bridge(() => farSide.app)), (id) => near.store.senderOf(id));
    const hop = ports.hopFor(message.seat)!;
    expect(await hop.attempt(message)).toEqual({ kind: "sent" });
    expect(await hop.attempt(message)).toEqual({ kind: "sent" });
    expect(rowCount(farSide.db)).toBe(1);
    near.pump.stop();
  });

  it("a far daemon down mid-flight holds the row, and it goes when the daemon is back", async () => {
    await sendFar({ deliveryId: "warm", waitMs: 2000 });
    farDown = true;
    const res = await sendFar({ deliveryId: "m4", waitMs: 20 });
    // Capability was known from a daemon that answered: the row is held, not refused.
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: "accepted", messageId: "m4" });
    await until(() => rowOf(near.db, "m4")?.message_pause_reason === "gate_unavailable", "the pause");
    expect(rowOf(near.db, "m4")?.message_state).toBe("attempting");
    expect(rowOf(farSide.db, FAR_ID("m4"))).toBeUndefined();
    farDown = false;
    await until(() => rowOf(near.db, "m4")?.message_state === "received", "received after return");
    expect(rowCount(farSide.db)).toBe(2);
    near.pump.stop();
  });

  it("a far daemon that went old mid-flight holds the row: its 404 is not read as `not seen`", async () => {
    await sendFar({ deliveryId: "warm", waitMs: 2000 });
    const newFar = farSide.app;
    const oldFar = new Hono();
    oldFar.get("/healthz", (c) => c.json({ status: "ok" }));
    let current = oldFar;
    near = side({ gated: false, far: daemons(bridge(() => current)) });
    near.store.accept({ id: messageId("m5"), seat: farSeatName("sparky", FAR_SEAT), sender: LOCAL_SENDER, body: "b" });
    await near.pump.tick();
    expect(rowOf(near.db, "m5")).toMatchObject({ message_state: "attempting", message_pause_reason: "gate_unavailable", attempts: 0 });
    expect(requests.filter((r) => r === "POST /api/messages/accept").length).toBe(1);  // the warm-up's, none for m5
    current = newFar;
    near.pump.start();
    await until(() => rowOf(near.db, "m5")?.message_state === "received", "received once it is back");
    near.pump.stop();
  });

  it("an old body at a new healthz is not `not seen` either: only the route's own answer is", async () => {
    const proxy = new Hono();
    proxy.get("/healthz", (c) => c.json({ status: "ok", messaging: 1 }));  // a 404 with no route behind it
    const ports = withFarSeats(NO_SEAT_MESSAGING_PORTS, daemons(bridge(() => proxy)), () => LOCAL_SENDER);
    const seat = farSeatName("sparky", FAR_SEAT);
    expect((await ports.gateFor(seat)!.lookup(seat, messageId("m6"))).kind).toBe("unavailable");
    near.pump.stop();
  });

  it("a far build with its pump off says `not found` honestly, and the gate still cannot call that `not seen`: it could not take the message", async () => {
    farSide = side({ gated: true, pumpOff: true });
    const seat = farSeatName("sparky", FAR_SEAT);
    expect((await farSide.app.fetch(new Request(`http://far/api/messages/${FAR_ID("m18")}`))).status).toBe(404);
    const ports = withFarSeats(NO_SEAT_MESSAGING_PORTS, daemons(bridge(() => farSide.app)), () => LOCAL_SENDER);
    expect((await ports.gateFor(seat)!.lookup(seat, messageId("m18"))).kind).toBe("unavailable");
    near.pump.stop();
  });

  it("answers far_legacy, and commits nothing, when the far daemon has no capability", async () => {
    const oldFar = new Hono();
    oldFar.get("/healthz", (c) => c.json({ status: "ok" }));
    const local = side({ gated: false, far: daemons(bridge(() => oldFar)) });
    const res = await sendFar({ deliveryId: "m7" }, local.app);
    expect(await res.json()).toMatchObject({ outcome: "far_legacy" });
    expect(rowCount(local.db)).toBe(0);
    near.pump.stop();
  });

  it("answers far_legacy when capability has never been read and the far daemon is down, and commits nothing", async () => {
    farDown = true;
    const local = side({ gated: false, far: daemons(bridge(() => farSide.app)) });
    expect(await (await sendFar({ deliveryId: "m8" }, local.app)).json()).toMatchObject({ outcome: "far_legacy" });
    expect(rowCount(local.db)).toBe(0);
    near.pump.stop();
  });

  it("answers far_legacy for an ungated far seat: at most once, and the sender is told", async () => {
    farSide = side({ gated: false });
    expect(await (await sendFar({ deliveryId: "m9" })).json()).toMatchObject({ outcome: "far_legacy", reason: expect.stringContaining("gate") });
    expect(rowCount(near.db)).toBe(0);
    near.pump.stop();
  });

  it("answers far_legacy for an ssh host and for text the pump can't carry", async () => {
    const ssh: HostRegistryLoadResult = { ok: true, registry: { hosts: [{ id: "sparky", transport: "ssh", target: "s" }] } };
    const local = side({ gated: false, far: new FarDaemons({ selfHost: () => NEAR, loadRegistry: () => ssh, fetchImpl: bridge(() => farSide.app) }) });
    expect(await (await sendFar({ deliveryId: "m10" }, local.app)).json()).toMatchObject({ outcome: "far_legacy" });
    expect(await (await sendFar({ deliveryId: "m11", text: "/compact" })).json()).toMatchObject({ outcome: "far_legacy" });
    expect(rowCount(local.db) + rowCount(near.db)).toBe(0);
    near.pump.stop();
  });

  it.each([["a paste terminator", "text \u001b[201~ more"], ["nothing but blanks", "   "]])("answers far_legacy for %s, since the far daemon could never take the row", async (_name, text) => {
    expect(await (await sendFar({ deliveryId: "m17", text })).json()).toMatchObject({ outcome: "far_legacy" });
    expect(rowCount(near.db)).toBe(0);
    near.pump.stop();
  });

  it("answers far_legacy for text over the limit, and commits nothing", async () => {
    expect(await (await sendFar({ deliveryId: "m14", text: "x".repeat(MESSAGE_MAX_BYTES + 1) })).json()).toMatchObject({ outcome: "far_legacy" });
    expect(rowCount(near.db)).toBe(0);
    near.pump.stop();
  });

  it("an id whose row ended undelivered is refused, not held", async () => {
    await sendFar({ deliveryId: "warm", waitMs: 2000 });
    farDown = true;
    await sendFar({ deliveryId: "m15", waitMs: 0 });
    near.pump.cancel(messageId("m15"), "nobody wants it");
    const res = await sendFar({ deliveryId: "m15", waitMs: 0 });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: "message_already_ended", messageId: "m15" });
    near.pump.stop();
  });

  it("a caller's long wait is cut to the route's own limit, so a far daemon that is down never holds the request", async () => {
    await sendFar({ deliveryId: "warm", waitMs: 2000 });
    farDown = true;
    const started = Date.now();
    expect(await (await sendFar({ deliveryId: "m16", waitMs: 600_000 })).json()).toMatchObject({ outcome: "accepted" });
    expect(Date.now() - started).toBeLessThan(10_000);
    near.pump.stop();
  }, 20_000);

  it("answers far_legacy with the local pump off", async () => {
    const off = side({ gated: false, pumpOff: true, far: daemons(bridge(() => farSide.app)) });
    expect(await (await sendFar({ deliveryId: "m12" }, off.app)).json()).toMatchObject({ outcome: "far_legacy" });
    near.pump.stop();
  });

  it("a resend under the id is free; another body under it is a conflict", async () => {
    await sendFar({ deliveryId: "m13", waitMs: 2000 });
    const again = await sendFar({ deliveryId: "m13", waitMs: 2000 });
    expect(await again.json()).toMatchObject({ outcome: "held", messageId: "m13" });
    expect(rowCount(farSide.db)).toBe(1);
    const changed = await sendFar({ deliveryId: "m13", text: "other" });
    expect(changed.status).toBe(409);
    near.pump.stop();
  });

  it("mints an id when the caller names none, and refuses one under a daemon prefix", async () => {
    const res = await sendFar({ waitMs: 2000 });
    expect((await res.json() as { messageId: string }).messageId).toMatch(/^seat-msg-/);
    expect((await sendFar({ deliveryId: "wake-intent-1" })).status).toBe(400);
    near.pump.stop();
  });
});

describe("the sender's daemon reads its far daemon", () => {
  const registry: HostRegistryLoadResult = { ok: true, registry: { hosts: [{ id: "sparky", transport: "http", url: "http://far:1" }] } };
  const answering = (routes: (app: Hono) => void) => {
    const app = new Hono();
    routes(app);
    const requests: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => { requests.push(new URL(String(input)).pathname); return app.fetch(new Request(String(input), init)); };
    return { fetchImpl, requests };
  };
  const capable = (app: Hono) => { app.get("/healthz", (c) => c.json({ status: "ok", messaging: 1 })); };

  it("reads the capability once per TTL", async () => {
    const { fetchImpl, requests } = answering(capable);
    let now = 0;
    const far = new FarDaemons({ selfHost: () => NEAR, loadRegistry: () => registry, fetchImpl, clock: () => now, capabilityTtlMs: 1000 });
    expect(await far.capability("sparky")).toBe("capable");
    now = 999;
    expect(await far.capability("sparky")).toBe("capable");
    expect(requests).toEqual(["/healthz"]);
    now = 1000;
    expect(await far.capability("sparky")).toBe("capable");
    expect(requests).toEqual(["/healthz", "/healthz"]);
  });

  it("this host with no id yet carries nothing: the send is far_legacy, the gate cannot say, the hop refuses", async () => {
    const { fetchImpl, requests } = answering(capable);
    const far = new FarDaemons({ selfHost: () => null, loadRegistry: () => registry, fetchImpl });
    const near = side({ gated: false, far });
    const res = await post(near.app, "/api/messages/send-far", { host: "sparky", session: FAR_SEAT, text: "x" });
    expect(await res.json()).toMatchObject({ outcome: "far_legacy" });
    expect(rowCount(near.db)).toBe(0);
    const ports = withFarSeats(NO_SEAT_MESSAGING_PORTS, far, () => LOCAL_SENDER);
    const seat = farSeatName("sparky", FAR_SEAT);
    expect((await ports.gateFor(seat)!.lookup(seat, messageId("m"))).kind).toBe("unavailable");
    expect((await ports.hopFor(seat)!.attempt({ ids: [messageId("m")], seat, body: "b", messageClass: "content", lane: 2 })).kind).toBe("refused");
    expect(requests).toEqual([]);
  });

  it("the local row names the far seat as the far daemon knows it, not as it was typed", async () => {
    const { fetchImpl } = answering((app) => {
      capable(app);
      app.get("/api/messages/takes", (c) => c.json({ takes: true, seat: "canon@far" }));
    });
    const near = side({ gated: false, far: new FarDaemons({ selfHost: () => NEAR, loadRegistry: () => registry, fetchImpl }) });
    await post(near.app, "/api/messages/send-far", { host: "sparky", session: "short", text: "x", deliveryId: "m1", waitMs: 0 });
    expect(rowOf(near.db, "m1")?.destination_session).toBe(farSeatName("sparky", "canon@far"));
  });

  it("health names a far seat's held message and why, once it is stuck", async () => {
    const down: typeof fetch = async () => { throw new Error("connection refused"); };
    const far = new FarDaemons({ selfHost: () => NEAR, loadRegistry: () => registry, fetchImpl: down });
    const near = side({ gated: false, far });
    const seat = farSeatName("sparky", FAR_SEAT);
    near.store.accept({ id: messageId("m1"), seat, sender: LOCAL_SENDER, body: "b" });
    await near.pump.tick();
    expect(rowOf(near.db, "m1")).toMatchObject({ message_state: "attempting", message_pause_reason: "gate_unavailable" });
    const later = new Date(Date.now() + MESSAGE_STUCK_AFTER_MS + 120_000);
    const reasons = new SeatMessagingHealthSource(near.store, withFarSeats(NO_SEAT_MESSAGING_PORTS, far, () => LOCAL_SENDER), () => later).coverage().map((row) => (row as { reason: string }).reason);
    expect(reasons).toEqual([expect.stringContaining(`to ${seat} not received`)]);
    expect(reasons[0]).toContain("paused: gate_unavailable");
  });
});

describe("the daemon's real app", () => {
  const app = (transport: object, terminalBearerToken?: string) => {
    const db = createDb();
    migrate(db, ALL_MIGRATIONS);
    return createTestApp(db, { appDeps: { sessionTransport: transport as never, terminalBearerToken } as never }).app;
  };
  const handOff = { takes: () => false };

  it("/healthz says `messaging` only when the pump runs", async () => {
    expect(await (await app({ messageHandOff: handOff }).fetch(new Request("http://x/healthz"))).json()).toMatchObject({ messaging: 1 });
    expect(await (await app({ messageHandOff: undefined }).fetch(new Request("http://x/healthz"))).json()).not.toHaveProperty("messaging");
  });

  it.each(["/api/messages/accept", "/api/messages/send-far"])("%s takes the terminal bearer, like /api/transport", async (path) => {
    const gated = app({ messageHandOff: handOff }, "right");
    const asks = (headers: Record<string, string>) => gated.fetch(new Request(`http://x${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" }));
    expect((await asks({})).status).toBe(401);
    expect((await asks({ authorization: "Bearer wrong" })).status).toBe(401);
    expect((await asks({ authorization: "Bearer right" })).status).toBe(400);
  });
});

describe("the far seat's name", () => {
  it("round-trips, and no local seat parses as one", () => {
    expect(parseFarSeat(farSeatName("sparky", "dev@rig"))).toEqual({ hostId: "sparky", seat: "dev@rig" });
    expect(parseFarSeat("dev@sparky")).toBeNull();
    expect(parseFarSeat("dev@rig@sparky")).toBeNull();
  });

  it("the directory calls a far seat live and asks the real one about the rest", () => {
    const directory = new FarSeatDirectory({ fate: () => ({ kind: "gone", reason: "no" }) });
    expect(directory.fate(farSeatName("sparky", "dev@rig"))).toEqual({ kind: "live", occupantGeneration: null });
    expect(directory.fate("dev@rig").kind).toBe("gone");
  });
});

describe("undeliverable at the far end", () => {
  const registry: HostRegistryLoadResult = { ok: true, registry: { hosts: [{ id: "near-label", hostId: NEAR, transport: "http", url: "http://near:1" }] } };
  const message = { id: messageId("m1"), seat: FAR_SEAT, sender: `${LOCAL_SENDER}@${NEAR}`, body: "the text" };
  const inner: SenderReturn = { returnToSender: async () => ({ kind: "no_return_path", reason: "inner" }) };

  it("goes back through the origin's queue, under one item id per message", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl: typeof fetch = async (input, init) => { calls.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> }); return new Response(JSON.stringify({ ok: true }), { status: 201 }); };
    const back = new CrossHostSenderReturn(inner, new FarDaemons({ selfHost: () => "far-host", loadRegistry: () => registry, fetchImpl }));
    const one = await back.returnToSender(message, "rig archived");
    const two = await back.returnToSender(message, "rig archived");
    expect(one).toEqual(two);
    expect(one.kind).toBe("returned");
    expect(calls[0]!.url).toBe("http://near:1/api/queue/create");
    expect(calls[0]!.body).toMatchObject({ destinationSession: LOCAL_SENDER, tags: ["seat-messaging:returned"] });
    expect(String(calls[0]!.body["body"])).toContain("the text");
    expect(calls[0]!.body["qitemId"]).toBe(calls[1]!.body["qitemId"]);
  });

  it("no route back: no_return_path, so the row ends and health names it", async () => {
    const back = new CrossHostSenderReturn(inner, new FarDaemons({ selfHost: () => "far-host", loadRegistry: () => ({ ok: true, registry: { hosts: [] } }), fetchImpl: async () => { throw new Error("no call"); } }));
    expect((await back.returnToSender(message, "gone")).kind).toBe("no_return_path");
  });

  it("the origin refuses it: no_return_path, since asking again would get the same answer", async () => {
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ error: "no" }), { status: 400 });
    const back = new CrossHostSenderReturn(inner, new FarDaemons({ selfHost: () => "far-host", loadRegistry: () => registry, fetchImpl }));
    expect((await back.returnToSender(message, "gone")).kind).toBe("no_return_path");
  });

  it("the origin is down: a throw, which means not now", async () => {
    const back = new CrossHostSenderReturn(inner, new FarDaemons({ selfHost: () => "far-host", loadRegistry: () => registry, fetchImpl: async () => { throw new Error("refused"); } }));
    await expect(back.returnToSender(message, "gone")).rejects.toThrow();
  });

  it("a local sender is the real queue's", async () => {
    const back = new CrossHostSenderReturn(inner, new FarDaemons({ selfHost: () => "far-host", loadRegistry: () => registry, fetchImpl: async () => { throw new Error("no call"); } }));
    expect(await back.returnToSender({ ...message, sender: LOCAL_SENDER }, "gone")).toEqual({ kind: "no_return_path", reason: "inner" });
  });
});
