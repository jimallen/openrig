import Database from "better-sqlite3";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { installNativeNonceRedaction } from "../src/middleware/native-nonce-redaction.js";
import { createApp } from "../src/server.js";
import { createTestApp } from "./helpers/test-app.js";

/**
 * A message's native nonce is what lets the seat gate tell a real message from a forged one (seat-gate-marker.ts). It never leaves the
 * daemon. These rows run the real server (createApp) with its real seat, transport and queue routes over a database whose rows carry a
 * nonce no test string could produce, and read every response body as text, so a new key name or a new nesting cannot hide it.
 */
const SENTINEL = "5ec2e7a1d94b0c3f8a6e1d7b92c4f05a";

function fixture(operatorSeat = "") {
  const db = new Database(":memory:"); migrate(db, ALL_MIGRATIONS);
  db.exec(`INSERT INTO rigs(id,name) VALUES ('rig','test');
    INSERT INTO nodes(id,rig_id,logical_id) VALUES ('a','rig','worker'),('b','rig','sibling');
    INSERT INTO bindings(id,node_id,tmux_session,tmux_pane) VALUES ('ba','a','worker@test','%1'),('bb','b','sibling@test','%2');
    INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('ga','a',1,'g1','fresh'),('gb','b',1,'g2','fresh');
    INSERT INTO sessions(id,node_id,session_name,status) VALUES ('sa','a','worker@test','running'),('sb','b','sibling@test','running');`);
  const guard = new SeatDeliveryGuard(db, (name) => resolveGuardTarget(db, name));
  const tmux = new TmuxAdapter(async () => "");
  tmux.deliveryGuard = guard;
  const outbox = new OutboxHandler(db);
  const setup = createTestApp(db, { tmux });
  // workspace.operator_seat_name is the one setting the route reads; a stub answers it so no config file is touched.
  const settingsStore = { resolveOne: () => ({ value: operatorSeat }) };
  const app = createApp({ ...setup, outboxHandler: outbox, settingsStore } as never);
  const send = (method: "GET" | "POST", path: string, session: string | null, body?: unknown) => app.request(path, {
    method,
    headers: { "content-type": "application/json", ...(session ? { "x-openrig-session": session } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { db, guard, outbox, app, send };
}

type Fixture = ReturnType<typeof fixture>;

/** A held message, a recorded message and a message the pump holds open, each carrying SENTINEL as its nonce. */
function seed(f: Fixture): void {
  f.outbox.retain({ outboxId: "held-1", senderSession: "lead@test", destinationSession: "worker@test", body: "held body" }, f.guard.target("a"));
  f.outbox.retain({ outboxId: "held-2", senderSession: "lead@test", destinationSession: "worker@test", body: "second held body" }, f.guard.target("a"));
  f.outbox.record({ outboxId: "rec-1", senderSession: "lead@test", destinationSession: "worker@test", body: "recorded body" });
  f.db.prepare("UPDATE outbox_entries SET native_nonce = ?").run(SENTINEL);
}

describe("the native nonce never leaves the daemon", () => {
  it("no route that can return a message row shows it, and the keys are not there at all", async () => {
    const f = fixture(); seed(f);
    const responses: Array<{ route: string; status: number; text: string }> = [];
    const call = async (route: string, method: "GET" | "POST", path: string, session: string | null, body?: unknown) => {
      const res = await f.send(method, path, session, body);
      responses.push({ route, status: res.status, text: await res.text() });
    };
    // The census: every route in the server that can return an outbox entry or a message row (HEAD db8abe77e).
    await call("GET /api/seat/held-messages/:seat", "GET", "/api/seat/held-messages/worker@test", "lead@test");
    await call("GET /api/seat/held-messages/:seat?id=", "GET", "/api/seat/held-messages/worker@test?id=held-1", "lead@test");
    await call("POST /api/seat/retire-held-message/:seat/:id", "POST", "/api/seat/retire-held-message/worker@test/held-2", "lead@test", { reason: "read" });
    await call("POST /api/queue/outbox/record", "POST", "/api/queue/outbox/record", "lead@test", { destinationSession: "worker@test", body: "new" });
    await call("GET /api/queue/outbox/list", "GET", "/api/queue/outbox/list?senderSession=lead@test", "lead@test");
    await call("POST /api/transport/cancel-message/:seat/:id", "POST", "/api/transport/cancel-message/worker@test/rec-1", "lead@test", { reason: "x" });

    // Positive control: the routes answered with the rows, so a clean zero is not an empty answer.
    expect(responses.map((r) => [r.route, r.status])).toEqual([
      ["GET /api/seat/held-messages/:seat", 200], ["GET /api/seat/held-messages/:seat?id=", 200],
      ["POST /api/seat/retire-held-message/:seat/:id", 200], ["POST /api/queue/outbox/record", 201],
      ["GET /api/queue/outbox/list", 200], ["POST /api/transport/cancel-message/:seat/:id", expect.any(Number)],
    ]);
    expect(responses[0]!.text).toContain("held body");
    expect(responses[1]!.text).toContain("held body");
    expect(responses[2]!.text).toContain("second held body");
    expect(responses[4]!.text).toContain("recorded body");
    for (const r of responses) {
      expect(r.text, r.route).not.toContain(SENTINEL);
      expect(r.text, r.route).not.toMatch(/nonce/i);
    }
    f.db.close();
  });

  // createApp ends in a catch-all, so a route cannot be added to it afterwards: these rows use the installer createApp calls, on a bare app.
  const appWith = (add: (app: Hono) => void) => { const app = new Hono(); installNativeNonceRedaction(app); add(app); return app; };

  it("a route added later that returns a row with a nonce is stripped too, whatever the key or nesting", async () => {
    const app = appWith((a) => a.get("/new", (c) => c.json({ items: [{ deep: { nativeNonce: SENTINEL, native_nonce: SENTINEL, gate_nonce: SENTINEL, keep: "kept" } }], nonce: SENTINEL }, 201, { "x-probe": "kept" })));
    const res = await app.request("/new");
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ items: [{ deep: { keep: "kept" } }] });
    expect(text).not.toContain(SENTINEL);
    expect([res.status, res.headers.get("x-probe"), res.headers.get("content-type")]).toEqual([201, "kept", expect.stringContaining("json")]);
    expect(res.headers.get("content-length") ?? String(text.length)).toBe(String(text.length));
  });

  it("a response with no nonce key passes through unchanged, and only JSON is rewritten", async () => {
    const app = appWith((a) => {
      a.get("/plain", (c) => c.json({ a: 1, list: [1, 2], text: "a nonce in prose" }, 202, { "x-probe": "kept" }));
      a.get("/text", (c) => c.text(`nativeNonce ${SENTINEL}`));
    });
    const plain = await app.request("/plain");
    expect([plain.status, plain.headers.get("x-probe"), await plain.text()]).toEqual([202, "kept", '{"a":1,"list":[1,2],"text":"a nonce in prose"}']);
    expect(await (await app.request("/text")).text()).toBe(`nativeNonce ${SENTINEL}`);
  });
});

describe("cancel-message records who closed the message, and refuses a seat that did not send it", () => {
  function pumpRow(f: Fixture, id: string, sender: string): void {
    f.outbox.record({ outboxId: id, senderSession: sender, destinationSession: "worker@test", body: `body ${id}` });
    f.db.prepare("UPDATE outbox_entries SET message_state = 'attempting', native_nonce = ? WHERE outbox_id = ?").run(SENTINEL, id);
  }
  const cancel = (f: Fixture, id: string, session: string | null) =>
    f.send("POST", `/api/transport/cancel-message/${encodeURIComponent("worker@test")}/${id}`, session, { reason: "poison" });
  const row = (f: Fixture, id: string) => f.db.prepare("SELECT message_state AS state, message_closed_reason AS why, retired_by AS by, retired_at AS at, retirement_reason AS rwhy FROM outbox_entries WHERE outbox_id = ?").get(id);

  it("the sender closes its own message, and the actor is on the row", async () => {
    const f = fixture(); pumpRow(f, "m1", "lead@test");
    const res = await cancel(f, "m1", "lead@test");
    expect(res.status).toBe(200);
    expect(row(f, "m1")).toMatchObject({ state: "undeliverable", why: "poison", by: "lead@test", rwhy: "poison" });
    expect((row(f, "m1") as { at: string }).at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    f.db.close();
  });

  it("another seat is refused with 403 and the message stays open", async () => {
    const f = fixture(); pumpRow(f, "m1", "lead@test");
    const res = await cancel(f, "m1", "intruder@test");
    expect(res.status).toBe(403);
    expect(row(f, "m1")).toMatchObject({ state: "attempting", by: null, why: null });
    f.db.close();
  });

  it("the operator seat may close another sender's message, and is recorded by name", async () => {
    const f = fixture("operator@kernel"); pumpRow(f, "m1", "lead@test");
    expect((await cancel(f, "m1", "intruder@test")).status).toBe(403);
    expect((await cancel(f, "m1", "operator@kernel")).status).toBe(200);
    expect(row(f, "m1")).toMatchObject({ state: "undeliverable", by: "operator@kernel" });
    f.db.close();
  });

  it("with no operator seat configured, a named seat that is not the sender is refused", async () => {
    const f = fixture(""); pumpRow(f, "m1", "lead@test");
    expect((await cancel(f, "m1", "operator@kernel")).status).toBe(403);
    expect(row(f, "m1")).toMatchObject({ state: "attempting", by: null });
    f.db.close();
  });

  it("a plain shell (no seat identity) is the person at the keyboard: allowed, and recorded as such", async () => {
    const f = fixture(); pumpRow(f, "m1", "lead@test");
    const res = await cancel(f, "m1", null);
    expect(res.status).toBe(200);
    expect(row(f, "m1")).toMatchObject({ state: "undeliverable", by: "operator (no seat identity)" });
    f.db.close();
  });
});
