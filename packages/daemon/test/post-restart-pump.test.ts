// S4b: the post-restart wake on a seat the pump serves. The row commits at the restore, and from then on it is the pump's: this notifier
// keeps no loop, no window and no row-after-send for such a seat. The hand-off, store and pump are real; the gate and hop are fakes.
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { PostRestartNotifier, postRestartDeliveryId, POST_RESTART_SENDER, type PostRestartDeps } from "../src/domain/post-restart-notifier.js";
import { PumpHandOff } from "../src/domain/seat-messaging/hand-off.js";
import { MessagePump } from "../src/domain/seat-messaging/message-pump.js";
import { MessageStore } from "../src/domain/seat-messaging/message-store.js";
import { messageId, type LastHop, type SeatGate } from "../src/domain/seat-messaging/ports.js";
import { MessageObligations } from "../src/domain/seat-messaging/pump-ports.js";
import type { RestoreResult } from "../src/domain/types.js";

const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

/** `accept` starts a pass of its own, and a seat with a pass running is skipped: let it end, so the next tick is a real one. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
const T0 = Date.parse("2026-10-30T18:00:00.000Z");
const SEAT = "dev-a@rig1";
const ID = postRestartDeliveryId(41, "node-a");
const restore = (createdAt?: string): { seq: number; rigId: string; result: RestoreResult; createdAt?: string } => ({
  seq: 41, rigId: "rig-1", createdAt,
  result: { snapshotId: "s", preRestoreSnapshotId: null, rigResult: "fully_restored", warnings: [], nodes: [{ nodeId: "node-a", logicalId: "dev.a", status: "resumed" }] },
});

function make(opts: { gated?: boolean; generation?: string | null; startedAt?: string; over?: Partial<PostRestartDeps> } = {}) {
  const db = createDb();
  migrate(db, ALL_MIGRATIONS);
  dbs.push(db);
  const store = new MessageStore(db);
  const live = { generation: opts.generation === undefined ? "gen-1" : opts.generation };
  const sent: string[] = [];
  const attempted: string[] = [];
  const returned: string[] = [];
  const hop: LastHop = { attempt: async (message) => { attempted.push(message.ids[0]); return { kind: "sent" }; } };
  const gate: SeatGate = { version: 1, lookup: async () => ({ kind: "not_seen" }) };
  const ports = { gateFor: () => (opts.gated === false ? null : gate), hopFor: () => (opts.gated === false ? null : hop) };
  const obligations = new MessageObligations();
  const clock = { t: T0 };
  const pump = new MessagePump({
    store, ports, obligations, clock: () => clock.t, log: () => undefined,
    directory: { fate: () => ({ kind: "live", occupantGeneration: live.generation }) },
    held: { status: () => "held" },
    senders: { returnToSender: async (message) => { returned.push(message.id); return { kind: "no_return_path", reason: "none" }; } },
  });
  const handOff = new PumpHandOff(store, pump, ports);
  const notifier = new PostRestartNotifier({
    enabled: () => true,
    sessionOf: () => ({ name: SEAT, startedAt: opts.startedAt ?? "2026-10-30T17:59:00.000Z" }),
    rigNameOf: () => "rig1",
    send: async (sessionName) => { sent.push(sessionName); return { ok: true, verified: true }; },
    outbox: new OutboxHandler(db),
    handOff: () => handOff,
    occupantGenerationOf: () => live.generation,
    now: () => new Date(clock.t),
    sleep: async () => { throw new Error("a seat the pump serves is never waited on here"); },
    firstDelayMs: 20_000,
    ...opts.over,
  });
  obligations.register("post-restart-", notifier.whyNoLongerWanted);
  return { db, store, pump, handOff, notifier, sent, attempted, returned, clock, live, row: () => db.prepare("SELECT * FROM outbox_entries WHERE outbox_id = ?").get(ID) as Record<string, unknown> | undefined, rows: () => (db.prepare("SELECT count(*) AS n FROM outbox_entries").get() as { n: number }).n };
}

describe("post-restart on a seat the pump serves", () => {
  it("commits one row at the restore, first attempt 20 s out, bound to the occupant, class content, lane 2, with no send and no sleep", async () => {
    const f = make();
    const out = await f.notifier.onRestoreCompleted(restore());
    expect(out).toEqual([{ nodeId: "node-a", sessionName: SEAT, outcome: "accepted", attempts: 0 }]);
    expect(f.sent).toEqual([]);
    expect(f.row()).toMatchObject({
      outbox_id: ID, destination_session: SEAT, sender_session: POST_RESTART_SENDER, audit_pointer: ID, message_state: "accepted", delivery_state: "pending", attempts: 0,
      occupant_generation: "gen-1", class: "content", lane: 2, next_attempt_at: new Date(T0 + 20_000).toISOString(), message_pump_owned: 1,
    });
    expect(f.row()!.body).toContain("rig rig1 was restored");
  });

  it("the pump does not attempt it before the 20 s are up, and does at them", async () => {
    const f = make();
    await f.notifier.onRestoreCompleted(restore());
    await settled();
    await f.pump.tick();
    expect(f.attempted).toEqual([]);
    f.clock.t = T0 + 20_000;
    await f.pump.tick();
    expect(f.attempted).toEqual([ID]);
  });

  it("re-deriving the same restore changes nothing: the id is the idempotence", async () => {
    const f = make();
    await f.notifier.onRestoreCompleted(restore());
    f.clock.t = T0 + 5_000;
    await f.notifier.onRestoreCompleted(restore());
    expect(f.rows()).toBe(1);
    expect(f.row()!.next_attempt_at).toBe(new Date(T0 + 20_000).toISOString());
  });

  it("a row that ended is not opened again, and the notifier says it is done", async () => {
    const f = make();
    await f.notifier.onRestoreCompleted(restore());
    f.handOff.cancel(messageId(ID), "gone");
    const out = await f.notifier.onRestoreCompleted(restore());
    expect(out[0]).toMatchObject({ outcome: "already_sent", attempts: 0 });
    expect(f.row()).toMatchObject({ message_state: "undeliverable", attempts: 0 });
    expect(f.sent).toEqual([]);
  });

  it("an id that names another seat now is left alone, and never falls through to a send", async () => {
    const f = make();
    await f.notifier.onRestoreCompleted(restore());
    f.db.prepare("UPDATE outbox_entries SET destination_session = 'other@rig1' WHERE outbox_id = ?").run(ID);
    const out = await f.notifier.onRestoreCompleted(restore());
    expect(out[0]).toMatchObject({ outcome: "already_sent" });
    expect(f.row()!.destination_session).toBe("other@rig1");
    expect(f.sent).toEqual([]);
  });

  it("a session that started after the restore is not told its conversation resumed: no row", async () => {
    const f = make({ startedAt: "2026-10-30T18:30:00.000Z" });
    const out = await f.notifier.onRestoreCompleted(restore("2026-10-30T18:00:00.000Z"));
    expect(out[0]).toMatchObject({ outcome: "replaced", attempts: 0 });
    expect(f.row()).toBeUndefined();
  });

  it("a seat with no gate keeps its old path: no row from here, the send goes", async () => {
    const f = make({ gated: false, over: { sleep: async () => undefined } });
    const out = await f.notifier.onRestoreCompleted(restore());
    expect(f.sent).toEqual([SEAT]);
    expect(out[0]).toMatchObject({ outcome: "delivered", attempts: 1 });
  });

  it("no hand-off (the pump is off) keeps the old path too", async () => {
    const f = make({ over: { handOff: () => null, sleep: async () => undefined } });
    await f.notifier.onRestoreCompleted(restore());
    expect(f.sent).toEqual([SEAT]);
  });
});

describe("whether the wake is still wanted", () => {
  const message = (occupantGeneration: string | null) => ({ id: messageId(ID), seat: SEAT, messageClass: "content" as const, attempts: 0, occupantGeneration, auditPointer: ID });

  it("the same occupant: wanted", () => {
    expect(make().notifier.whyNoLongerWanted(message("gen-1"))).toBeNull();
  });

  it("another occupant: not wanted, and the reason names both", () => {
    const reason = make({ generation: "gen-2" }).notifier.whyNoLongerWanted(message("gen-1"));
    expect(reason).toContain("gen-1");
    expect(reason).toContain("gen-2");
  });

  it("an unknown occupant proves nothing, and a row bound to none has nothing to compare", () => {
    expect(make({ generation: null }).notifier.whyNoLongerWanted(message("gen-1"))).toBeNull();
    expect(make({ generation: "gen-2" }).notifier.whyNoLongerWanted(message(null))).toBeNull();
  });

  it("the pump ends a row whose occupant changed with no notice and no attempt, never labelled on to the new one", async () => {
    const f = make();
    await f.notifier.onRestoreCompleted(restore());
    await settled();
    f.live.generation = "gen-2";
    f.clock.t = T0 + 20_000;
    await f.pump.tick();
    expect(f.attempted).toEqual([]);
    expect(f.returned).toEqual([]);
    expect(f.row()).toMatchObject({ message_state: "undeliverable", delivery_state: "failed", ack_evidence: "superseded", attempts: 0, message_previous_occupant: null });
  });
});
