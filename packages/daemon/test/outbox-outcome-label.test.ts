// Native comms step 1 (design-native-comms-20261030 §5.6): every settled outbox row says HOW it was settled — the
// path its text took (tmux, native, gateway, none) and what the outcome rests on — so delivery outcomes can be counted
// per path. The census that motivated it could not tell an unconfirmed render from a crash-reconciled claim (§1.1).
import { describe, it, expect, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { outboxOutcomeLabelSchema } from "../src/db/migrations/117_outbox_outcome_label.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository, type QueueNudgeTransport } from "../src/domain/queue-repository.js";
import { OutboxHandler, OutboxHandlerError, WAKE_INTENT_PREFIX, labelForTmuxSend } from "../src/domain/outbox-handler.js";

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
    expect(ALL_MIGRATIONS.at(-1)?.name).toBe("117_outbox_outcome_label.sql");
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

  it("a stored value outside the vocabulary is refused on read, not passed off as a typed value", () => {
    const db = fullDb();
    const outbox = new OutboxHandler(db);
    const id = record(outbox);
    db.prepare("UPDATE outbox_entries SET ack_evidence = 'telepathy' WHERE outbox_id = ?").run(id);
    expect(() => outbox.getById(id)).toThrow(OutboxHandlerError);
    expect(() => outbox.getById(id)).toThrow(/unknown ack_evidence "telepathy"/);
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
  type Mode = "verified" | "unverified" | "notok" | "timeout" | "throw";
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
  ] as const)("%s → %s with %j", async (mode, state, label) => {
    const got = await stageAndDrain(mode);
    expect(got.state).toBe(state);
    expect(got.label).toEqual(label);
  });
});
