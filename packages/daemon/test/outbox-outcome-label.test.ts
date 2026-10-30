// Native comms step 1 (design-native-comms-20261030 §5.6): every settled outbox row says HOW it was settled — the
// path its text took (tmux, native, gateway, none) and what the outcome rests on — so delivery outcomes can be counted
// per path. The census that motivated it could not tell an unconfirmed render from a crash-reconciled claim (§1.1).
import { describe, it, expect, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { outboxOutcomeLabelSchema } from "../src/db/migrations/117_outbox_outcome_label.js";
import { EventBus } from "../src/domain/event-bus.js";
import { LOCAL_HUMAN_INBOX_ADDRESS } from "../src/domain/gateway/destination-resolver.js";
import { QueueRepository, type QueueNudgeTransport } from "../src/domain/queue-repository.js";
import { OutboxHandler, WAKE_INTENT_PREFIX, labelForTmuxSend } from "../src/domain/outbox-handler.js";

const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

function fullDb(): Database.Database {
  const db = createDb();
  migrate(db, ALL_MIGRATIONS);
  dbs.push(db);
  return db;
}

interface LabelRow { delivery_path: string | null; ack_evidence: string | null; ack_detail: string | null }
function labelOf(db: Database.Database, outboxId: string): LabelRow | undefined {
  return db.prepare<[string], LabelRow>("SELECT delivery_path, ack_evidence, ack_detail FROM outbox_entries WHERE outbox_id = ?").get(outboxId);
}

describe("migration 117: the label columns", () => {
  it("adds delivery_path, ack_evidence and ack_detail to outbox_entries, last in the canonical list", () => {
    const db = fullDb();
    const cols = (db.prepare("PRAGMA table_info(outbox_entries)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["delivery_path", "ack_evidence", "ack_detail"]));
    const names = ALL_MIGRATIONS.map((m) => m.name);
    expect(names.indexOf("117_outbox_outcome_label.sql")).toBe(names.indexOf("116_pda_usage_entries.sql") + 1);
  });
});

describe("OutboxHandler: settling with a label", () => {
  const record = (outbox: OutboxHandler) =>
    outbox.record({ senderSession: "a@r", destinationSession: "b@r", body: "hi" }).outboxId;

  it("markDelivered stores the label and the entry reads it back", () => {
    const db = fullDb();
    const outbox = new OutboxHandler(db);
    const id = record(outbox);
    const entry = outbox.markDelivered(id, { path: "tmux", evidence: "render_unconfirmed" });
    expect(entry.deliveryState).toBe("delivered");
    expect(entry.deliveryPath).toBe("tmux");
    expect(entry.ackEvidence).toBe("render_unconfirmed");
    expect(entry.ackDetail).toBeNull();
  });

  it("markFailed keeps the transport's reason code as the detail", () => {
    const db = fullDb();
    const outbox = new OutboxHandler(db);
    const id = record(outbox);
    outbox.markFailed(id, { path: "tmux", evidence: "send_failed", detail: "target_needs_input" });
    expect(labelOf(db, id)).toEqual({ delivery_path: "tmux", ack_evidence: "send_failed", ack_detail: "target_needs_input" });
  });

  it("a settle without a label leaves the row unlabelled (NULL, never a guessed value)", () => {
    const db = fullDb();
    const outbox = new OutboxHandler(db);
    const id = record(outbox);
    const entry = outbox.markDelivered(id);
    expect(labelOf(db, id)).toEqual({ delivery_path: null, ack_evidence: null, ack_detail: null });
    expect(entry.deliveryPath).toBeNull();
    expect(entry.ackEvidence).toBeNull();
  });

  it("the label is written only with the state change: a second settle of a settled row changes neither", () => {
    const db = fullDb();
    const outbox = new OutboxHandler(db);
    const id = record(outbox);
    outbox.markDelivered(id, { path: "tmux", evidence: "render_verified" });
    outbox.markFailed(id, { path: "tmux", evidence: "send_failed", detail: "late" });
    expect(labelOf(db, id)).toEqual({ delivery_path: "tmux", ack_evidence: "render_verified", ack_detail: null });
  });

  it("finalizeDelivery labels a claimed wake intent", () => {
    const db = fullDb();
    const outbox = new OutboxHandler(db);
    const id = outbox.record({ outboxId: `${WAKE_INTENT_PREFIX}x1`, senderSession: "a@r", destinationSession: "b@r", body: "w" }).outboxId;
    expect(outbox.claimForDelivery(id)).toBe(true);
    outbox.finalizeDelivery(id, "indeterminate", { path: "tmux", evidence: "send_timeout", detail: "verify timeout" });
    expect(labelOf(db, id)).toEqual({ delivery_path: "tmux", ack_evidence: "send_timeout", ack_detail: "verify timeout" });
  });

  it("startup reconciliation labels an abandoned claim crash_reconciled, and only the claimed rows", () => {
    const db = fullDb();
    const outbox = new OutboxHandler(db);
    const claimed = outbox.record({ outboxId: `${WAKE_INTENT_PREFIX}c1`, senderSession: "a@r", destinationSession: "b@r", body: "w" }).outboxId;
    const pending = outbox.record({ outboxId: `${WAKE_INTENT_PREFIX}p1`, senderSession: "a@r", destinationSession: "b@r", body: "w" }).outboxId;
    outbox.claimForDelivery(claimed);
    expect(outbox.reconcileAbandonedSending(WAKE_INTENT_PREFIX)).toBe(1);
    expect(labelOf(db, claimed)).toEqual({ delivery_path: "tmux", ack_evidence: "crash_reconciled", ack_detail: null });
    expect(labelOf(db, pending)).toEqual({ delivery_path: null, ack_evidence: null, ack_detail: null });
  });

  // OF-179 F5: a label is a record, not something a decision rests on. A value outside the vocabulary reads as null and
  // is flagged, like an OF-117 damaged column, and never refuses the row.
  it("a stored label outside the vocabulary reads as null, is flagged unreadable, and the row still reads", () => {
    const db = fullDb();
    const outbox = new OutboxHandler(db);
    const id = record(outbox);
    db.prepare("UPDATE outbox_entries SET ack_evidence = 'telepathy', delivery_path = 'pigeon' WHERE outbox_id = ?").run(id);
    const entry = outbox.getById(id)!;
    expect(entry.deliveryState).toBe("pending");
    expect([entry.deliveryPath, entry.ackEvidence]).toEqual([null, null]);
    expect(entry.unreadable).toEqual(["delivery_path", "ack_evidence"]);
    // control: a row with valid labels is not flagged
    const ok = record(outbox);
    outbox.markDelivered(ok, { path: "tmux", evidence: "send_ok" });
    expect(outbox.getById(ok)!.unreadable).toBeUndefined();
  });

  // OF-179 F1/F2: a hold is labelled where the row moves; retire keeps that label; markIndeterminate takes one.
  it("retain labels the hold tmux/retained, and a later finalize of the retained row cannot unlabel it", () => {
    const db = fullDb();
    const outbox = new OutboxHandler(db);
    const id = outbox.record({ outboxId: `${WAKE_INTENT_PREFIX}r1`, senderSession: "a@r", destinationSession: "b@r", body: "w" }).outboxId;
    outbox.claimForDelivery(id);
    const binding = { nodeId: "n1", session: "b@r", occupant: null, pane: null };
    outbox.retain({ outboxId: id, senderSession: "a@r", destinationSession: "b@r", body: "w" }, binding, true);
    // the drain's finalize finds the row no longer `sending` (the typing guard moved it) and changes nothing
    outbox.finalizeDelivery(id, "retained", { path: "tmux", evidence: "send_ok" });
    expect(outbox.getById(id)!.deliveryState).toBe("retained");
    expect(labelOf(db, id)).toEqual({ delivery_path: "tmux", ack_evidence: "retained", ack_detail: null });
    outbox.retire(id, "operator@r", "no longer needed");
    expect(outbox.getById(id)!.deliveryState).toBe("retired");
    expect(labelOf(db, id)).toEqual({ delivery_path: "tmux", ack_evidence: "retained", ack_detail: null });
  });

  it("markIndeterminate stores the label it is given", () => {
    const db = fullDb();
    const outbox = new OutboxHandler(db);
    const id = record(outbox);
    outbox.markIndeterminate(id, { path: "tmux", evidence: "send_timeout", detail: "t" });
    expect(labelOf(db, id)).toEqual({ delivery_path: "tmux", ack_evidence: "send_timeout", ack_detail: "t" });
  });

  it("on a database without migration 117 a labelled settle still settles and the entry carries no label fields", () => {
    const db = createDb();
    dbs.push(db);
    migrate(db, [outboxEntriesSchema]);
    const outbox = new OutboxHandler(db);
    const id = record(outbox);
    const entry = outbox.markDelivered(id, { path: "tmux", evidence: "render_verified" });
    expect(entry.deliveryState).toBe("delivered");
    expect("ackEvidence" in entry).toBe(false);
    // positive control: the same handler code labels once the migration is applied (a new handler reads the columns)
    migrate(db, [outboxOutcomeLabelSchema]);
    const outbox2 = new OutboxHandler(db);
    const id2 = record(outbox2);
    expect(outbox2.markDelivered(id2, { path: "tmux", evidence: "render_verified" }).ackEvidence).toBe("render_verified");
  });
});

describe("labelForTmuxSend: SendResult's vocabulary to a label", () => {
  it.each([
    [{ ok: true, outcome: "delivered", verified: true }, { path: "tmux", evidence: "render_verified" }],
    [{ ok: true, outcome: "rendered-unconfirmed", verified: false }, { path: "tmux", evidence: "render_unconfirmed" }],
    [{ ok: true, verified: true }, { path: "tmux", evidence: "render_verified" }],
    [{ ok: true, verified: false }, { path: "tmux", evidence: "render_unconfirmed" }],
    [{ ok: true }, { path: "tmux", evidence: "send_ok" }],
    [{ ok: false, outcome: "failed", reason: "send_failed" }, { path: "tmux", evidence: "send_failed", detail: "send_failed" }],
    [{ ok: false, reason: "target_needs_input" }, { path: "tmux", evidence: "send_failed", detail: "target_needs_input" }],
    [{ ok: false }, { path: "tmux", evidence: "send_failed", detail: null }],
    [{ ok: true, outcome: "retained", reason: "typing_guard" }, { path: "tmux", evidence: "retained", detail: "typing_guard" }],
  ])("%j → %j", (res, label) => {
    expect(labelForTmuxSend(res)).toEqual(label);
  });
});

describe("the wake drain labels each intent by what its send returned", () => {
  type Mode = "verified" | "unverified" | "notok" | "timeout" | "throw" | "retained" | "okfailed" | "okbare";
  function harness(mode: Mode) {
    const db = fullDb();
    const outbox = new OutboxHandler(db);
    const repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    repo.attachOutbox(outbox);
    const transport: QueueNudgeTransport = {
      async send() {
        if (mode === "verified") return { ok: true, verified: true };
        if (mode === "unverified") return { ok: true, verified: false };
        if (mode === "notok") return { ok: false, reason: "target_needs_input", error: "Refused: at an interactive prompt" };
        if (mode === "timeout") return { ok: false, reason: "verify timeout waiting for render ack" };
        if (mode === "retained") return { ok: true, outcome: "retained", reason: "typing_guard" };
        if (mode === "okfailed") return { ok: true, outcome: "failed", reason: "send_failed" };
        if (mode === "okbare") return { ok: true };
        throw new Error("transport exploded");
      },
    };
    return { db, outbox, repo, attach: () => repo.attachTransport(transport) };
  }

  async function stageAndDrain(mode: Mode) {
    const h = harness(mode);
    // no transport yet: the handoff stages the wake intent and leaves it pending (the drain's input)
    const source = await h.repo.create({ nudge: false, sourceSession: "planner@rig", destinationSession: "driver@rig", body: "x" });
    await h.repo.handoff({ qitemId: source.qitemId, fromSession: "driver@rig", toSession: "reviewer@rig", body: "y" });
    const intent = h.outbox.listForSender("driver@rig").find((e) => e.outboxId.startsWith(WAKE_INTENT_PREFIX))!;
    expect(intent.deliveryState).toBe("pending"); // positive control: the drain has something to settle
    h.attach();
    await h.repo.drainPendingWakeIntents();
    return { state: h.outbox.getById(intent.outboxId)!.deliveryState, label: labelOf(h.db, intent.outboxId) };
  }

  it.each([
    ["verified", "delivered", { delivery_path: "tmux", ack_evidence: "render_verified", ack_detail: null }],
    ["unverified", "indeterminate", { delivery_path: "tmux", ack_evidence: "render_unconfirmed", ack_detail: null }],
    ["notok", "failed", { delivery_path: "tmux", ack_evidence: "send_failed", ack_detail: "target_needs_input" }],
    ["timeout", "indeterminate", { delivery_path: "tmux", ack_evidence: "send_timeout", ack_detail: "verify timeout waiting for render ack" }],
    ["throw", "failed", { delivery_path: "tmux", ack_evidence: "send_failed", ack_detail: "thrown" }],
    // OF-179 F3: the drain-retained branch (the mock does not move the row, so the drain's own finalize labels it)
    ["retained", "retained", { delivery_path: "tmux", ack_evidence: "retained", ack_detail: "typing_guard" }],
    // OF-179 F4: the drain and labelForTmuxSend agree on the edge results
    ["okfailed", "failed", { delivery_path: "tmux", ack_evidence: "send_failed", ack_detail: "send_failed" }],
    ["okbare", "indeterminate", { delivery_path: "tmux", ack_evidence: "send_ok", ack_detail: null }],
  ] as const)("%s → %s with %j", async (mode, state, label) => {
    const got = await stageAndDrain(mode);
    expect(got.state).toBe(state);
    expect(got.label).toEqual(label);
  });
});

// OF-179 F3: the destination classes that never reach tmux, and a wake whose qitem is gone.
describe("the wake drain labels the destinations that are not sent through tmux", () => {
  async function drainWith(classify: ReturnType<QueueRepository["classifyDestinationOf"]>) {
    const db = fullDb();
    const outbox = new OutboxHandler(db);
    const repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    repo.attachOutbox(outbox);
    const sent: string[] = [];
    const source = await repo.create({ nudge: false, sourceSession: "planner@rig", destinationSession: "driver@rig", body: "x" });
    await repo.handoff({ qitemId: source.qitemId, fromSession: "driver@rig", toSession: "reviewer@rig", body: "y" });
    const intent = outbox.listForSender("driver@rig").find((e) => e.outboxId.startsWith(WAKE_INTENT_PREFIX))!;
    vi.spyOn(repo, "classifyDestinationOf").mockReturnValue(classify);
    repo.attachTransport({ async send(session: string) { sent.push(session); return { ok: true, verified: true }; } });
    await repo.drainPendingWakeIntents();
    return { state: outbox.getById(intent.outboxId)!.deliveryState, label: labelOf(db, intent.outboxId), sent };
  }

  it("gateway-routable → indeterminate, gateway / gateway_owned, nothing typed", async () => {
    const got = await drainWith({ class: "gateway-routable", via: "external-address", resolvedHuman: null });
    expect([got.state, got.label, got.sent]).toEqual(["indeterminate", { delivery_path: "gateway", ack_evidence: "gateway_owned", ack_detail: null }, []]);
  });

  it("the operator's local inbox → delivered, none / local_inbox, nothing typed", async () => {
    const got = await drainWith({ class: "local-human-inbox", address: LOCAL_HUMAN_INBOX_ADDRESS });
    expect([got.state, got.label, got.sent]).toEqual(["delivered", { delivery_path: "none", ack_evidence: "local_inbox", ack_detail: null }, []]);
  });

  it("unroutable → failed, none / unroutable, nothing typed", async () => {
    const got = await drainWith({ class: "unroutable", teaching: "no transport" });
    expect([got.state, got.label, got.sent]).toEqual(["failed", { delivery_path: "none", ack_evidence: "unroutable", ack_detail: null }, []]);
  });

  // Reachable only as a race: actionable() already calls a missing qitem superseded, so the qitem must vanish between the
  // claim and the send (simulated by getById finding nothing for it once).
  it("a wake whose qitem vanished after its claim → failed, none / no_qitem, nothing typed", async () => {
    const db = fullDb();
    const outbox = new OutboxHandler(db);
    const repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    repo.attachOutbox(outbox);
    const sent: string[] = [];
    const source = await repo.create({ nudge: false, sourceSession: "planner@rig", destinationSession: "driver@rig", body: "x" });
    const { created } = await repo.handoff({ qitemId: source.qitemId, fromSession: "driver@rig", toSession: "reviewer@rig", body: "y" });
    const intent = outbox.listForSender("driver@rig").find((e) => e.outboxId.startsWith(WAKE_INTENT_PREFIX))!;
    const realGetById = repo.getById.bind(repo);
    vi.spyOn(repo, "getById").mockImplementation((id: string) => (id === created.qitemId ? null : realGetById(id)));
    repo.attachTransport({ async send(session: string) { sent.push(session); return { ok: true, verified: true }; } });
    await repo.drainPendingWakeIntents();
    expect([outbox.getById(intent.outboxId)!.deliveryState, labelOf(db, intent.outboxId), sent]).toEqual(["failed", { delivery_path: "none", ack_evidence: "no_qitem", ack_detail: null }, []]);
  });
});
