// hc cutover: what the outbox and the queue do with a send to an hc seat that the core may still deliver.
// The rule under test: `delivery_outcome_unknown` and `waiting_on_person` are neither failures nor retryable. The row is
// `indeterminate` with the pending record in it; the queue's ladder reads `indeterminate:` as unconfirmed and never
// resends it; only a sweep that has evidence moves the row, and the one move that licenses a retry is "the core restarted".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository, isWakeTimeoutSignal, type QueueNudgeTransport } from "../src/domain/queue-repository.js";
import { OutboxHandler, labelForTmuxSend, OUTBOX_ACK_EVIDENCE, OUTBOX_DELIVERY_PATHS } from "../src/domain/outbox-handler.js";
import { nativeFallbackOutcome } from "../src/domain/native-inbox-settlement.js";
import { PostRestartNotifier, POST_RESTART_SENDER, type PostRestartSendResult } from "../src/domain/post-restart-notifier.js";
import { parsePending, sweepHcUnsettled } from "../src/domain/hc-unsettled-sweep.js";
import type { HcDeliveryOutcome, HcPendingSend } from "../src/adapters/hc-delivery.js";
import type { RestoreResult } from "../src/domain/types.js";

const PENDING: HcPendingSend = { version: 1, seat: "reviewer@rig", address: "t4", token: "tok-9", sendStartedAtMs: 4_100_000_000_000, preTurn: 2, preStatus: "idle", preReported: true };

type HcResult = Awaited<ReturnType<QueueNudgeTransport["send"]>>;
const unknownResult = (reason: "waiting_on_person" | "delivery_outcome_unknown"): HcResult => ({ ok: false, path: "hc", reason, error: `Delivery to 'reviewer@rig' is not confirmed (${reason})`, hcPending: PENDING });

function harness() {
  const db = createDb();
  migrate(db, ALL_MIGRATIONS);
  const outbox = new OutboxHandler(db);
  const calls: string[] = [];
  const next: { result: HcResult } = { result: { ok: true, verified: true } };
  const transport: QueueNudgeTransport = { async send(session) { calls.push(session); return next.result; } };
  const repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
  repo.attachTransport(transport);
  repo.attachOutbox(outbox);
  async function handoff() {
    const source = await repo.create({ nudge: false, sourceSession: "planner@rig", destinationSession: "driver@rig", body: "x" });
    calls.length = 0;
    const { created } = await repo.handoff({ qitemId: source.qitemId, fromSession: "driver@rig", toSession: "reviewer@rig", body: "y" });
    const outboxId = `wake-intent-${created.qitemId}`;
    await vi.waitFor(() => expect(outbox.getById(outboxId)?.deliveryState).not.toMatch(/^(pending|sending)$/));
    return { qitemId: created.qitemId, outboxId };
  }
  return { db, outbox, repo, calls, next, handoff };
}

describe("the vocabulary", () => {
  it("knows the hc path and the three evidence words, and an older reader would flag rather than refuse them", () => {
    expect(OUTBOX_DELIVERY_PATHS).toContain("hc");
    for (const word of ["waiting_on_person", "outcome_unknown", "verified_after_wait"]) expect(OUTBOX_ACK_EVIDENCE).toContain(word);
  });

  it("matches the transport's two reasons as unconfirmed, by whole word, and nothing near them", () => {
    for (const s of ["delivery_outcome_unknown", "waiting_on_person", "Delivery to 'x' is not confirmed: delivery_outcome_unknown.", "verify timeout", "ETIMEDOUT"]) expect(isWakeTimeoutSignal(s)).toBe(true);
    for (const s of ["send_failed", "session_missing", "not_waiting_on_personnel", "xdelivery_outcome_unknown", undefined, ""]) expect(isWakeTimeoutSignal(s)).toBe(false);
  });

  it("labels a settled hc send on the hc path as a tmux send is labelled", () => {
    expect(labelForTmuxSend({ ok: true, path: "hc", verified: true, outcome: "delivered" })).toEqual({ path: "hc", evidence: "render_verified" });
    expect(labelForTmuxSend({ ok: false, path: "hc", reason: "session_missing", outcome: "failed" })).toEqual({ path: "hc", evidence: "send_failed", detail: "session_missing" });
    expect(labelForTmuxSend({ ok: true, path: "hc", outcome: "rendered-unconfirmed" })).toEqual({ path: "hc", evidence: "render_unconfirmed" });
    expect(labelForTmuxSend({ ok: false, reason: "waiting_on_person" })).toMatchObject({ path: "tmux", evidence: "send_failed" });  // only the hc path carries the record
  });
});

describe("a wake to an hc seat whose delivery is not confirmed", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => { h = harness(); });
  afterEach(async () => { await new Promise<void>((resolve) => setImmediate(resolve)); h.db.close(); });

  it.each([["waiting_on_person", "waiting_on_person"], ["delivery_outcome_unknown", "outcome_unknown"]] as const)("%s settles the row indeterminate with the pending record, never failed", async (reason, evidence) => {
    h.next.result = unknownResult(reason);
    const { qitemId, outboxId } = await h.handoff();
    const row = h.outbox.getById(outboxId)!;
    expect(row).toMatchObject({ deliveryState: "indeterminate", deliveryPath: "hc", ackEvidence: evidence });
    expect(JSON.parse(row.ackDetail!)).toEqual(PENDING);
    expect(h.repo.getById(qitemId)?.lastNudgeResult).toMatch(/^indeterminate:/);
  });

  it("is not driven again by the recovery sweep, and the queue's retry reads it as unconfirmed, not failed", async () => {
    h.next.result = unknownResult("waiting_on_person");
    const { qitemId, outboxId } = await h.handoff();
    expect(h.calls).toHaveLength(1);
    h.next.result = { ok: true, verified: true };
    expect(await h.repo.drainPendingWakeIntents()).toEqual({ delivered: 0, indeterminate: 0, failed: 0, retained: 0 });
    expect(h.calls).toHaveLength(1);
    expect(h.outbox.getById(outboxId)?.deliveryState).toBe("indeterminate");
    expect(h.repo.getById(qitemId)?.lastNudgeResult?.startsWith("failed:")).toBe(false);
  });

  it("still records an hc refusal that is definite as failed, on the hc path", async () => {
    h.next.result = { ok: false, path: "hc", reason: "session_missing", error: "Session 'reviewer@rig' not found", outcome: "failed" };
    const { qitemId, outboxId } = await h.handoff();
    expect(h.outbox.getById(outboxId)).toMatchObject({ deliveryState: "failed", deliveryPath: "hc", ackEvidence: "send_failed" });
    expect(h.repo.getById(qitemId)?.lastNudgeResult).toMatch(/^failed:/);
  });

  it("keeps a plain tmux timeout a tmux send_timeout with no record", async () => {
    h.next.result = { ok: false, reason: "verify timeout waiting for render ack" };
    const { outboxId } = await h.handoff();
    expect(h.outbox.getById(outboxId)).toMatchObject({ deliveryState: "indeterminate", deliveryPath: "tmux", ackEvidence: "send_timeout" });
  });
});

describe("a tmux fallback to an hc seat that is not confirmed (the native inbox's failover)", () => {
  it("is unconfirmed and keeps the hc label with its record, not a tmux send_timeout", () => {
    const res = unknownResult("delivery_outcome_unknown");
    const outcome = nativeFallbackOutcome(res, labelForTmuxSend(res));
    expect(outcome).toMatchObject({ state: "indeterminate", unconfirmed: true, undelivered: false, label: { path: "hc", evidence: "outcome_unknown" } });
    expect(JSON.parse(outcome.label.detail!)).toEqual(PENDING);
  });
});

describe("the post-restart prompt to an hc seat", () => {
  const restore: RestoreResult = { snapshotId: "s", preRestoreSnapshotId: null, rigResult: "fully_restored", warnings: [], nodes: [{ nodeId: "node-a", logicalId: "dev.a", status: "resumed" }] };

  async function run(script: PostRestartSendResult[]) {
    const db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const outbox = new OutboxHandler(db);
    const clock = { t: Date.parse("2026-10-30T18:00:00.000Z") };
    const sent: string[] = [];
    const queue = [...script];
    const notifier = new PostRestartNotifier({
      enabled: () => true, sessionOf: () => ({ name: "dev-a@rig1", startedAt: "2026-10-30T17:59:00.000Z" }), rigNameOf: () => "rig1",
      send: async (name) => { sent.push(name); return queue.shift() ?? { ok: true, verified: true }; },
      outbox, now: () => new Date(clock.t), sleep: async (ms) => { clock.t += ms; },
      firstDelayMs: 20_000, retryEveryMs: 60_000, windowMs: 30 * 60_000, waitForIdleMs: 60_000,
    });
    const out = await notifier.onRestoreCompleted({ seq: 7, rigId: "rig-1", result: restore });
    return { db, outbox, sent, out };
  }

  it.each(["waiting_on_person", "delivery_outcome_unknown"] as const)("sends once on %s and stops, instead of retrying a text that may land", async (reason) => {
    const { db, outbox, sent, out } = await run([{ ok: false, path: "hc", reason, hcPending: PENDING }]);
    expect(sent).toEqual(["dev-a@rig1"]);
    expect(out).toEqual([{ nodeId: "node-a", sessionName: "dev-a@rig1", outcome: "unconfirmed", attempts: 1, detail: reason }]);
    expect(outbox.getById("post-restart-7-node-a")).toMatchObject({ senderSession: POST_RESTART_SENDER, deliveryState: "indeterminate", deliveryPath: "hc" });
    db.close();
  });

  it("still retries a definite refusal for the whole window", async () => {
    const { db, sent } = await run([{ ok: false, path: "hc", reason: "target_needs_input" }, { ok: false, path: "hc", reason: "target_needs_input" }, { ok: true, verified: true }]);
    expect(sent).toHaveLength(3);
    db.close();
  });
});

describe("the sweep of rows the core may still deliver", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => { h = harness(); });
  afterEach(async () => { await new Promise<void>((resolve) => setImmediate(resolve)); h.db.close(); });

  async function waitingRow() {
    h.next.result = unknownResult("waiting_on_person");
    return h.handoff();
  }
  const sweep = (verify: (p: HcPendingSend) => Promise<HcDeliveryOutcome>) => sweepHcUnsettled({ outbox: h.outbox, verify, recordNudgeAttempt: (id, r) => h.repo.recordNudgeAttempt(id, r) });
  const delivered: HcDeliveryOutcome = { state: "delivered", evidence: "token_on_screen", verified: false, started: null, status: "idle", turn: 3 };

  it("settles a row delivered on evidence, labels it, and tells the queue it is verified", async () => {
    const { qitemId, outboxId } = await waitingRow();
    const verify = vi.fn(async () => delivered);
    expect(await sweep(verify)).toEqual({ delivered: 1, gone: 0, open: 0, unreadable: [] });
    expect(verify).toHaveBeenCalledWith(PENDING);
    expect(h.outbox.getById(outboxId)).toMatchObject({ deliveryState: "delivered", deliveryPath: "hc", ackEvidence: "verified_after_wait", ackDetail: "token_on_screen" });
    expect(h.outbox.getById(outboxId)!.deliveredAt).not.toBeNull();
    expect(h.repo.getById(qitemId)?.lastNudgeResult).toBe("verified");
  });

  it("settles a row failed only when the send is proved gone, which is what lets the queue retry it", async () => {
    const { qitemId, outboxId } = await waitingRow();
    const gone: HcDeliveryOutcome = { state: "not_delivered", reason: "core_restarted_send_gone", code: "send_gone", message: "gone" };
    expect(await sweep(async () => gone)).toEqual({ delivered: 0, gone: 1, open: 0, unreadable: [] });
    expect(h.outbox.getById(outboxId)).toMatchObject({ deliveryState: "failed", deliveryPath: "hc", ackEvidence: "send_failed", ackDetail: "core_restarted_send_gone" });
    expect(h.outbox.getById(outboxId)!.deliveredAt).toBeNull();
    expect(h.repo.getById(qitemId)?.lastNudgeResult).toBe("failed:core_restarted_send_gone");
  });

  it.each([
    ["still waiting", async (): Promise<HcDeliveryOutcome> => ({ state: "waiting", reason: "waiting_on_person", pending: PENDING, message: "" })],
    ["unknown", async (): Promise<HcDeliveryOutcome> => ({ state: "unknown", reason: "seat_ended", pending: PENDING, message: "" })],
    ["a refusal that proves nothing", async (): Promise<HcDeliveryOutcome> => ({ state: "not_delivered", reason: "core_unreachable", code: "transport_unavailable", message: "" })],
    ["a read that threw", async (): Promise<HcDeliveryOutcome> => { throw new Error("boom"); }],
  ])("leaves the row alone when it is %s", async (_name, verify) => {
    const { qitemId, outboxId } = await waitingRow();
    const before = h.repo.getById(qitemId)?.lastNudgeResult;
    expect(await sweep(verify)).toEqual({ delivered: 0, gone: 0, open: 1, unreadable: [] });
    expect(h.outbox.getById(outboxId)).toMatchObject({ deliveryState: "indeterminate", ackEvidence: "waiting_on_person" });
    expect(h.repo.getById(qitemId)?.lastNudgeResult).toBe(before);
  });

  it("settles each row once: a second sweep finds nothing to ask about", async () => {
    await waitingRow();
    const verify = vi.fn(async () => delivered);
    await sweep(verify);
    await sweep(verify);
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("does not move a row another writer settled between the read and the write", async () => {
    const { outboxId } = await waitingRow();
    const raced = vi.fn(async () => {
      h.db.prepare("UPDATE outbox_entries SET delivery_state = 'delivered' WHERE outbox_id = ?").run(outboxId);
      return delivered;
    });
    expect(await sweep(raced)).toEqual({ delivered: 0, gone: 0, open: 0, unreadable: [] });
    expect(h.outbox.getById(outboxId)).toMatchObject({ deliveryState: "delivered", ackEvidence: "waiting_on_person" });
  });

  it("names a row whose record is unreadable and does not guess", async () => {
    const { outboxId } = await waitingRow();
    h.db.prepare("UPDATE outbox_entries SET ack_detail = 'not json' WHERE outbox_id = ?").run(outboxId);
    const verify = vi.fn(async () => delivered);
    expect(await sweep(verify)).toEqual({ delivered: 0, gone: 0, open: 0, unreadable: [outboxId] });
    expect(verify).not.toHaveBeenCalled();
  });

  it("ignores an hc row that is indeterminate for another reason: only the two waiting words are the sweep's", async () => {
    h.next.result = { ok: true, path: "hc", outcome: "rendered-unconfirmed" };
    const { outboxId } = await h.handoff();
    h.db.prepare("UPDATE outbox_entries SET delivery_state = 'indeterminate', ack_detail = ? WHERE outbox_id = ?").run(JSON.stringify(PENDING), outboxId);
    expect(h.outbox.getById(outboxId)).toMatchObject({ deliveryState: "indeterminate", deliveryPath: "hc", ackEvidence: "render_unconfirmed" });
    const verify = vi.fn(async () => delivered);
    expect(await sweep(verify)).toEqual({ delivered: 0, gone: 0, open: 0, unreadable: [] });
    expect(verify).not.toHaveBeenCalled();
  });

  it("ignores tmux timeouts and every other indeterminate row", async () => {
    h.next.result = { ok: false, reason: "verify timeout waiting for render ack" };
    await h.handoff();
    const verify = vi.fn(async () => delivered);
    expect(await sweep(verify)).toEqual({ delivered: 0, gone: 0, open: 0, unreadable: [] });
    expect(verify).not.toHaveBeenCalled();
  });
});

describe("parsePending", () => {
  it("takes the record as it was written", () => {
    expect(parsePending(JSON.stringify(PENDING))).toEqual(PENDING);
    expect(parsePending(JSON.stringify({ ...PENDING, token: null, preStatus: null }))).toMatchObject({ token: null, preStatus: null });
  });

  it.each<[string, unknown]>([
    ["a newer version", { ...PENDING, version: 2 }], ["no seat", { ...PENDING, seat: "" }], ["no address", { ...PENDING, address: undefined }],
    ["a string time", { ...PENDING, sendStartedAtMs: "1" }], ["a non-finite time", { ...PENDING, sendStartedAtMs: null }], ["a missing turn", { ...PENDING, preTurn: undefined }],
    ["a numeric token", { ...PENDING, token: 5 }], ["an empty token", { ...PENDING, token: "" }], ["a numeric status", { ...PENDING, preStatus: 1 }], ["reported as a string", { ...PENDING, preReported: "yes" }],
    ["an array", []], ["null", null],
  ])("refuses %s", (_name, value) => {
    expect(parsePending(JSON.stringify(value))).toBeNull();
  });

  it("refuses text that is not JSON, and nothing", () => {
    expect(parsePending("{")).toBeNull();
    expect(parsePending(null)).toBeNull();
    expect(parsePending(undefined)).toBeNull();
    expect(parsePending("")).toBeNull();
  });
});
