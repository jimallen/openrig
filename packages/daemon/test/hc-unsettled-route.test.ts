// hc cutover: the two route-level behaviours around a send to an hc seat that nobody has settled.
//   1. /send records the unconfirmed send as an `indeterminate` row with its pending record, as /broadcast does, so the sweep can
//      settle it and `rig health` can name it. Before this the 202 left no row at all.
//   2. The operator's close (rig seat retire-unsettled-send): audited, refuses a settled row, another seat's row and a row not
//      yet escalated, and never sends.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { transportRoutes, UNATTRIBUTED_OPERATOR } from "../src/routes/transport.js";
import type { SessionTransport } from "../src/domain/session-transport.js";
import type { HcPendingSend } from "../src/adapters/hc-delivery.js";

const PENDING: HcPendingSend = { version: 1, seat: "dev@rig", address: "t4", token: null, sendStartedAtMs: 1_600_000_000_000, preTurn: 0, preStatus: null, preReported: false, commandLed: false, preScreen: null };
const MIN = 60_000;
const sqliteStamp = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);

type SendResult = Awaited<ReturnType<SessionTransport["send"]>>;

function app(outbox: OutboxHandler, send: (session: string) => SendResult) {
  const calls: string[] = [];
  // The route reads two methods of the transport; the stub is typed as exactly those.
  const transport: Pick<SessionTransport, "resolveSessions" | "send"> = {
    resolveSessions: async () => ({ ok: true, sessions: [] }),
    send: async (session) => { calls.push(session); return send(session); },
  };
  const hono = new Hono();
  hono.use("*", async (c, next) => {
    c.set("sessionTransport" as never, transport);
    c.set("outboxHandler" as never, outbox);
    await next();
  });
  hono.route("/api/transport", transportRoutes());
  return { hono, calls };
}

const post = (hono: Hono, path: string, body: unknown, actor: string | null = "planner@rig") =>
  hono.request(path, { method: "POST", headers: { "content-type": "application/json", ...(actor ? { "x-openrig-session": actor } : {}) }, body: JSON.stringify(body) });

describe("/send records a send to an hc seat that is not confirmed", () => {
  let db: Database.Database;
  let outbox: OutboxHandler;
  beforeEach(() => { db = createDb(); migrate(db, ALL_MIGRATIONS); outbox = new OutboxHandler(db); });
  afterEach(() => db.close());

  const unconfirmed = (reason: "waiting_on_person" | "delivery_outcome_unknown"): SendResult => ({ ok: false, sessionName: "dev@rig", path: "hc", reason, error: "not confirmed", hcPending: PENDING });

  it.each([["waiting_on_person", "waiting_on_person"], ["delivery_outcome_unknown", "outcome_unknown"]] as const)("%s: 202, and one indeterminate row carrying the pending record", async (reason, evidence) => {
    const { hono } = app(outbox, () => unconfirmed(reason));
    const res = await post(hono, "/api/transport/send", { session: "dev@rig", text: "hello" });
    expect(res.status).toBe(202);
    const rows = outbox.listHcUnsettled();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ senderSession: "planner@rig", destinationSession: "dev@rig", deliveryState: "indeterminate", deliveryPath: "hc", ackEvidence: evidence });
    expect(JSON.parse(rows[0]!.ackDetail!)).toEqual(PENDING);
  });

  it("records an unattributed unconfirmed send too: its sender was told 202, and without a row health could never name it (QA F7)", async () => {
    const anon = app(outbox, () => unconfirmed("waiting_on_person"));
    expect((await post(anon.hono, "/api/transport/send", { session: "dev@rig", text: "hello" }, null)).status).toBe(202);
    const rows = outbox.listHcUnsettled();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ destinationSession: "dev@rig", deliveryState: "indeterminate", deliveryPath: "hc", ackEvidence: "waiting_on_person" });
    expect(rows[0]!.senderSession).not.toBe("planner@rig");
    expect(db.prepare("SELECT identity_provenance AS p FROM outbox_entries").get()).toEqual({ p: "origin-unknown:v1" });
  });

  it("records nothing for a definite refusal, or for submit-only (nothing was typed)", async () => {
    const refused = app(outbox, () => ({ ok: false, sessionName: "dev@rig", path: "hc", reason: "session_missing", error: "gone" }));
    expect((await post(refused.hono, "/api/transport/send", { session: "dev@rig", text: "hello" })).status).toBe(404);
    const anon = app(outbox, () => unconfirmed("waiting_on_person"));
    expect((await post(anon.hono, "/api/transport/send", { session: "dev@rig", submitOnly: true }, "planner@rig")).status).toBe(202);
    expect(db.prepare("SELECT count(*) AS n FROM outbox_entries").get()).toEqual({ n: 0 });
  });
});

describe("POST /retire-unsettled/:seat/:id: the operator's close", () => {
  let db: Database.Database;
  let outbox: OutboxHandler;
  let hono: Hono;
  let calls: string[];
  beforeEach(() => {
    db = createDb(); migrate(db, ALL_MIGRATIONS); outbox = new OutboxHandler(db);
    ({ hono, calls } = app(outbox, () => ({ ok: true, sessionName: "dev@rig" })));
  });
  afterEach(() => db.close());

  /** An hc row left waiting, dispatched `agoMin` minutes ago by the real clock. */
  function row(id: string, agoMin: number, evidence: "waiting_on_person" | "outcome_unknown" = "waiting_on_person", seat = "dev@rig"): string {
    outbox.record({ outboxId: id, senderSession: "planner@rig", destinationSession: seat, body: "x", auditPointer: id, identityProvenance: "transport:v1" });
    db.prepare("UPDATE outbox_entries SET ts_dispatched = ? WHERE outbox_id = ?").run(sqliteStamp(Date.now() - agoMin * MIN), id);
    outbox.markIndeterminate(id, { path: "hc", evidence, detail: JSON.stringify(PENDING) });
    return id;
  }
  const retire = (id: string, body: unknown = { reason: "looked: the text is there" }, seat = "dev@rig", actor: string | null = "operator@rig") =>
    post(hono, `/api/transport/retire-unsettled/${seat}/${id}`, body, actor);

  it("closes an escalated row: retired with who, when and why, label and record kept, off the unsettled list, nothing sent", async () => {
    row("old", 20);
    const res = await retire("old");
    expect(res.status).toBe(200);
    const body = await res.json() as { entry: Record<string, unknown>; effect: string };
    expect(body.entry).toMatchObject({ outboxId: "old", deliveryState: "retired", retiredBy: "operator@rig", retirementReason: "looked: the text is there" });
    expect(body.effect).toMatch(/Nothing was sent/);
    const stored = outbox.getById("old")!;
    expect(stored).toMatchObject({ deliveryState: "retired", deliveryPath: "hc", ackEvidence: "waiting_on_person", retiredBy: "operator@rig" });
    expect(Date.now() - Date.parse(stored.retiredAt!)).toBeLessThan(60_000);
    expect(JSON.parse(stored.ackDetail!)).toEqual(PENDING);
    expect(outbox.listHcUnsettled()).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("closes a row whose reply was lost the same way, and closing twice is the same answer", async () => {
    row("lost", 40, "outcome_unknown");
    expect((await retire("lost")).status).toBe(200);
    const again = await retire("lost", { reason: "again" });
    expect(again.status).toBe(200);
    expect(outbox.getById("lost")).toMatchObject({ retirementReason: "looked: the text is there" });  // the first close stands
  });

  // Both ages: an old row is also turned away by the write's own guard, a young one only by the check made first (it would
  // otherwise be answered "not escalated", which names the wrong reason).
  it.each([
    ["delivered", 1, (id: string) => outbox.settleHcUnsettled(id, "delivered", { path: "hc", evidence: "verified_after_wait", detail: "turn_advanced" })],
    ["delivered", 30, (id: string) => outbox.settleHcUnsettled(id, "delivered", { path: "hc", evidence: "verified_after_wait", detail: "turn_advanced" })],
    ["failed (proved gone)", 1, (id: string) => outbox.settleHcUnsettled(id, "failed", { path: "hc", evidence: "send_failed", detail: "core_restarted_send_gone" })],
    ["failed (proved gone)", 30, (id: string) => outbox.settleHcUnsettled(id, "failed", { path: "hc", evidence: "send_failed", detail: "core_restarted_send_gone" })],
  ])("refuses a settled row: %s, %i min old, row untouched", async (state, age, settle) => {
    row("settled", age);
    expect(settle("settled")).toBe(true);
    const before = db.prepare("SELECT * FROM outbox_entries WHERE outbox_id = 'settled'").get();
    const res = await retire("settled");
    expect(res.status).toBe(409);
    const body = await res.json() as { code: string; error: string };
    expect(body.code).toBe("not_unsettled");
    expect(body.error).toContain(`is ${state.startsWith("failed") ? "failed" : "delivered"} (`);
    expect(db.prepare("SELECT * FROM outbox_entries WHERE outbox_id = 'settled'").get()).toEqual(before);
  });

  it.each([1, 60])("refuses an indeterminate row that is not an unsettled hc send (a tmux timeout, an hc render-unconfirmed), %i min old", async (age) => {
    for (const [id, label] of [["tmux", { path: "tmux", evidence: "send_timeout" }], ["render", { path: "hc", evidence: "render_unconfirmed" }]] as const) {
      outbox.record({ outboxId: id, senderSession: "planner@rig", destinationSession: "dev@rig", body: "x", identityProvenance: "transport:v1" });
      db.prepare("UPDATE outbox_entries SET ts_dispatched = ? WHERE outbox_id = ?").run(sqliteStamp(Date.now() - age * MIN), id);
      outbox.markIndeterminate(id, label);
      const res = await retire(id);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: "not_unsettled" });
      expect(outbox.getById(id)?.deliveryState).toBe("indeterminate");
    }
  });

  it("refuses a row not yet escalated (15 minutes, exclusive): the sweep may still settle it", async () => {
    row("young", 14);
    const young = await retire("young");
    expect(young.status).toBe(409);
    expect(await young.json()).toMatchObject({ code: "not_escalated" });
    expect(outbox.getById("young")?.deliveryState).toBe("indeterminate");
  });

  it("refuses a row that names another seat than the one given: a typo cannot close someone else's message", async () => {
    row("other", 60, "waiting_on_person", "other@rig");
    const wrong = await retire("other");
    expect(wrong.status).toBe(409);
    expect(await wrong.json()).toMatchObject({ code: "wrong_seat" });
    expect(outbox.getById("other")?.deliveryState).toBe("indeterminate");
  });

  it("closes from a plain shell with no seat identity, recorded as unattributed rather than refused (QA F6)", async () => {
    row("shell", 60);
    const res = await retire("shell", { reason: "looked from my shell" }, "dev@rig", null);
    expect(res.status).toBe(200);
    expect(outbox.getById("shell")).toMatchObject({ deliveryState: "retired", retiredBy: UNATTRIBUTED_OPERATOR, retirementReason: "looked from my shell" });
  });

  it("closes a row the sweep proved lost (send_gone), which is what leaves it in the list with a person", async () => {
    row("lost", 60);
    expect(outbox.markHcSendGone("lost")).toBe(true);
    expect(outbox.listHcUnsettled().map((r) => r.outboxId)).toEqual(["lost"]);
    expect((await retire("lost")).status).toBe(200);
    expect(outbox.listHcUnsettled()).toEqual([]);
  });

  it("refuses without a reason, and names an unknown row", async () => {
    row("old", 60);
    expect((await retire("old", {})).status).toBe(400);
    expect((await retire("old", { reason: "   " })).status).toBe(400);
    expect((await retire("old", "not an object")).status).toBe(400);
    expect((await retire("nope")).status).toBe(404);
    expect(outbox.getById("old")?.deliveryState).toBe("indeterminate");
  });
});
