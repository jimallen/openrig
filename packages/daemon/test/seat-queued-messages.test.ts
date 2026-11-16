import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { MessageStore, redeliveryLabel } from "../src/domain/seat-messaging/message-store.js";
import { QUEUED_PREVIEW_CHARS } from "../src/domain/seat-messaging/queued-messages.js";
import { messageId } from "../src/domain/seat-messaging/ports.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { createApp } from "../src/server.js";
import { createTestApp } from "./helpers/test-app.js";

/**
 * workspaces-o9o.9: since d0303ca8 `rig send` tells a sender "N queued (seat busy)", but nothing listed those rows: `rig seat held-messages`
 * lists only the typing guard's retained rows. An operator deciding whether to relaunch a seat could not see what waits for it.
 * `GET /api/seat/queued/:seat` lists the seat's open rows (the ones the pump still owes a delivery), in the order the pump takes them.
 */
const SECRET = "sk-" + "Q".repeat(12) + "z".repeat(12); // the transcript policy's sk- pattern; built so no literal key sits in the tree

function fixture() {
  const db = new Database(":memory:"); migrate(db, ALL_MIGRATIONS);
  db.exec(`INSERT INTO rigs(id,name) VALUES ('rig','test');
    INSERT INTO nodes(id,rig_id,logical_id) VALUES ('a','rig','worker');
    INSERT INTO bindings(id,node_id,tmux_session,tmux_pane) VALUES ('ba','a','worker@test','%1');
    INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('ga','a',1,'g1','fresh');
    INSERT INTO sessions(id,node_id,session_name,status) VALUES ('sa','a','worker@test','running');`);
  const guard = new SeatDeliveryGuard(db, (name) => resolveGuardTarget(db, name));
  const tmux = new TmuxAdapter(async () => "");
  tmux.deliveryGuard = guard;
  const outbox = new OutboxHandler(db);
  const setup = createTestApp(db, { tmux });
  const app = createApp({ ...setup, outboxHandler: outbox, settingsStore: { resolveOne: () => ({ value: "" }) } } as never);
  const store = new MessageStore(db);
  const get = async (path: string) => { const res = await app.request(path); return { status: res.status, body: await res.json() as Record<string, unknown> }; };
  return { db, guard, outbox, store, get };
}

type Fixture = ReturnType<typeof fixture>;

function seed(f: Fixture): void {
  // Open, content lane.
  f.store.accept({ id: messageId("c1"), seat: "worker@test", sender: "lead@test", body: "first content message" });
  f.store.accept({ id: messageId("c2"), seat: "worker@test", sender: "qa@test", body: `token ${SECRET} inside` });
  // c1 (the head while it is the oldest open row) has had one attempt claimed: it is attempting.
  expect(f.store.claimAttempt(f.store.headOf("worker@test")!, Date.parse("2031-03-04T10:00:00Z"))).toBe(true);
  // Open, startup lane, accepted after c1/c2: the pump takes it first (lowest lane), so the list shows it first.
  f.store.accept({ id: messageId("s1"), seat: "worker@test", sender: "daemon@test", body: "startup packet", messageClass: "lifecycle" });
  // Settled: received. Not open.
  f.store.accept({ id: messageId("r1"), seat: "worker@test", sender: "lead@test", body: "already arrived" });
  f.db.prepare("UPDATE outbox_entries SET message_state = 'received', delivery_state = 'delivered' WHERE outbox_id = 'r1'").run();
  // Guard-retained and not released: held-messages lists it, this does not.
  f.outbox.retain({ outboxId: "h1", senderSession: "lead@test", destinationSession: "worker@test", body: "held body" }, f.guard.target("a"));
  // Another seat's open row.
  f.store.accept({ id: messageId("o1"), seat: "other@test", sender: "lead@test", body: "not for worker" });
}

describe("GET /api/seat/queued/:seat lists the rows `rig send` calls queued", () => {
  it("lists exactly the seat's open rows, in the pump's order, with sender, time, state and attempts", async () => {
    const f = fixture(); seed(f);
    expect(f.store.headOf("worker@test")?.id).toBe("s1"); // control: the store's own head is the startup row, the order the list must match
    const res = await f.get("/api/seat/queued/worker%40test");
    expect(res.status).toBe(200);
    const items = res.body["items"] as Array<Record<string, unknown>>;
    expect(items.map((i) => i["id"])).toEqual(["s1", "c1", "c2"]);
    expect(res.body["total"]).toBe(3);
    expect(items[1]).toMatchObject({ id: "c1", sender: "lead@test", state: "attempting", attempts: 1 });
    expect(items[2]).toMatchObject({ id: "c2", sender: "qa@test", state: "accepted", attempts: 0 });
    expect(typeof items[1]!["recordedAt"]).toBe("string");
    f.db.close();
  });

  it("previews each body through the transcript redaction, so a secret in a queued message is not shown", async () => {
    const f = fixture(); seed(f);
    const res = await f.get("/api/seat/queued/worker%40test");
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(SECRET);
    const c2 = (res.body["items"] as Array<Record<string, unknown>>).find((i) => i["id"] === "c2")!;
    expect(c2["preview"]).toBe("token [REDACTED] inside");
    f.db.close();
  });

  it("leaves out the guard's held row until its hold is released, and lists it from then on, as the pump does", async () => {
    const f = fixture(); seed(f);
    expect(f.outbox.heldForNode("a", 10).total).toBe(1); // control: the held row is there, and held-messages lists it
    const before = await f.get("/api/seat/queued/worker%40test");
    expect((before.body["items"] as Array<Record<string, unknown>>).map((i) => i["id"])).not.toContain("h1");
    expect(f.store.adoptHeld(messageId("h1"), new Date().toISOString(), null)).toBe(true);
    const after = await f.get("/api/seat/queued/worker%40test");
    expect((after.body["items"] as Array<Record<string, unknown>>).map((i) => i["id"])).toEqual(["s1", "c1", "c2", "h1"]);
    f.db.close();
  });

  it("redacts the whole body before cutting it: a secret that straddles the preview's end leaves no part of itself", async () => {
    const f = fixture();
    expect(QUEUED_PREVIEW_CHARS).toBe(120);
    // Short words: a run of 40 or more letters is itself a secret to the transcript policy (its base64 rule), and would be redacted whole.
    const lead = "ab ".repeat(37); // 111 characters
    const body = `${lead}${SECRET} tail`; // the secret starts at 111 and runs past 120
    expect(body.indexOf(SECRET)).toBeLessThan(QUEUED_PREVIEW_CHARS);
    expect(body.indexOf(SECRET) + SECRET.length).toBeGreaterThan(QUEUED_PREVIEW_CHARS);
    f.store.accept({ id: messageId("long1"), seat: "worker@test", sender: "lead@test", body });
    const res = await f.get("/api/seat/queued/worker%40test");
    const item = (res.body["items"] as Array<Record<string, unknown>>)[0]!;
    expect(item["preview"]).toBe(`${lead}[REDACTE…`); // 119 characters and the ellipsis: the cut lands inside the redaction marker, never inside the secret
    expect(JSON.stringify(res.body)).not.toMatch(/sk-Q|QQQQ|zzzz/);
    expect(item["bodyBytes"]).toBe(Buffer.byteLength(body, "utf8"));
    f.db.close();
  });

  it("names a relaunch's re-delivery row (o9o.7's id shape) and the message it carries; any other id is not one; with the original gone it previews its own body", async () => {
    const f = fixture();
    // Rows of o9o.7's shape whose originals this store no longer keeps: the id still names the original, and the preview falls back to the row's own body.
    const insertCarry = f.db.prepare(`INSERT INTO outbox_entries (outbox_id, sender_session, destination_session, body, delivery_state, message_state, message_id, class, lane, message_pump_owned, ts_dispatched)
      VALUES (?, 'cos@test', 'worker@test', ?, 'pending', 'accepted', ?, 'content', 2, 1, '2031-03-04T09:00:00.000Z')`);
    const carry = (id: string) => insertCarry.run(id, `[OpenRig re-delivery: the previous occupant of this seat took message ${id.split(".relaunch-")[0]} at 23:06:08Z] hello`, id);
    carry("cos-6045.relaunch-abcd1234");
    carry("cos-7000.relaunch-unknown"); // a seat with no tenure: o9o.7's tag is the word unknown
    f.store.accept({ id: messageId("plain.relaunch-toolongtag"), seat: "worker@test", sender: "lead@test", body: "x" });
    f.store.accept({ id: messageId("c9"), seat: "worker@test", sender: "lead@test", body: "y" });
    const items = (await f.get("/api/seat/queued/worker%40test")).body["items"] as Array<Record<string, unknown>>;
    expect(items.map((i) => [i["id"], i["redeliveryOf"]])).toEqual([["cos-6045.relaunch-abcd1234", "cos-6045"], ["cos-7000.relaunch-unknown", "cos-7000"], ["plain.relaunch-toolongtag", null], ["c9", null]]);
    expect(items[0]!["preview"]).toMatch(/^\[OpenRig re-delivery: /);
    f.db.close();
  });

  it("shows a row moved to the seat's new occupant with the occupant it was first sent to", async () => {
    const f = fixture();
    f.store.accept({ id: messageId("w1"), seat: "worker@test", sender: "watchdog@test", body: "fire", occupantGeneration: "gen-old" });
    expect(f.store.rebindToNewOccupant(messageId("w1"), "gen-old")).toBe(true);
    const items = (await f.get("/api/seat/queued/worker%40test")).body["items"] as Array<Record<string, unknown>>;
    expect(items[0]).toMatchObject({ id: "w1", previousOccupant: "gen-old", redeliveryOf: null });
    f.db.close();
  });

  it("caps the rows at --limit and still counts them all", async () => {
    const f = fixture(); seed(f);
    const res = await f.get("/api/seat/queued/worker%40test?limit=1");
    expect((res.body["items"] as unknown[]).length).toBe(1);
    expect(res.body["total"]).toBe(3);
    f.db.close();
  });

  it("never returns more than 1000 rows, whatever --limit asks for, and still counts them all", async () => {
    const f = fixture();
    f.db.transaction(() => {
      for (let i = 0; i < 1001; i++) f.store.accept({ id: messageId(`bulk-${i}`), seat: "bulk@test", sender: "lead@test", body: `m${i}` });
    })();
    const res = await f.get("/api/seat/queued/bulk%40test?limit=5000");
    expect((res.body["items"] as unknown[]).length).toBe(1000);
    expect(res.body["total"]).toBe(1001);
    f.db.close();
  });

  it("a limit that is not a positive whole number falls back to the default, never to an empty page", async () => {
    const f = fixture(); seed(f);
    for (const bad of ["0", "-1", "abc", "1.5"]) {
      const res = await f.get(`/api/seat/queued/worker%40test?limit=${bad}`);
      expect((res.body["items"] as unknown[]).length, bad).toBe(3);
    }
    f.db.close();
  });

  it("says whether the seat is known here, so an empty list from a wrong name is not 'nothing queued'", async () => {
    const f = fixture(); seed(f);
    const known = await f.get("/api/seat/queued/worker%40test");
    expect(known.body).toMatchObject({ seat: "worker@test", knownSeat: true, redaction: "transcript" });
    const unknown = await f.get("/api/seat/queued/wroker%40test");
    expect(unknown.status).toBe(200);
    expect(unknown.body).toMatchObject({ seat: "wroker@test", knownSeat: false, total: 0, items: [] });
    // A name with rows and no local session (a far seat) still lists them, flagged unknown here.
    const far = await f.get("/api/seat/queued/other%40test");
    expect(far.body).toMatchObject({ knownSeat: false, total: 1 });
    f.db.close();
  });
});

describe("a relaunch's re-delivery row written by o9o.7's own writer", () => {
  it("lists the carry row the writer makes as a re-delivery of the message the old occupant took, previewing the ORIGINAL body, redacted", async () => {
    const f = fixture();
    const since = "2031-03-04T09:00:00.000Z";
    const gateAt = "2031-03-04T09:00:02.000Z";
    const original = `taken by the old occupant, token ${SECRET} inside`;
    f.store.accept({ id: messageId("cos-6045"), seat: "worker@test", sender: "cos@test", body: original });
    f.db.prepare("UPDATE outbox_entries SET message_state = 'received', delivery_state = 'delivered', gate_recorded_at = ? WHERE outbox_id = 'cos-6045'").run(gateAt);
    const handed = f.store.handOverFromRetiringOccupant("worker@test", since, "abcd1234");
    expect(handed.carried.map((c) => c.id)).toEqual(["cos-6045.relaunch-abcd1234"]);
    const res = await f.get("/api/seat/queued/worker%40test");
    const items = res.body["items"] as Array<Record<string, unknown>>;
    expect(items.map((i) => [i["id"], i["redeliveryOf"], i["preview"]])).toEqual([["cos-6045.relaunch-abcd1234", "cos-6045", "taken by the old occupant, token [REDACTED] inside"]]);
    // The size is the carry row's own body (label and original), the one that will be delivered.
    expect(items[0]!["bodyBytes"]).toBe(Buffer.byteLength(`${redeliveryLabel("cos-6045", gateAt)}\n${original}`, "utf8"));
    expect(JSON.stringify(res.body)).not.toMatch(/sk-Q|QQQQ|zzzz/);
    f.db.close();
  });
});
