// S4c: a watchdog wake on a seat the pump serves. The hand-off is the delivery: `ok` and the receipt at commit, and a rescan adds no row and
// sends nothing. The engine, store and pump are real on an in-memory database; the transport's answer, the gate and the hop are fakes.
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { HANDED_TO_PUMP } from "../src/domain/session-transport.js";
import { MessagePump } from "../src/domain/seat-messaging/message-pump.js";
import { MessageStore } from "../src/domain/seat-messaging/message-store.js";
import { messageId, type LastHop, type LastHopResult, type SeatGate } from "../src/domain/seat-messaging/ports.js";
import { MessageObligations } from "../src/domain/seat-messaging/pump-ports.js";
import { watchdogDeliveryOutcome, watchdogWakeObligation } from "../src/domain/watchdog-delivery-status.js";
import { WatchdogHistoryLog } from "../src/domain/watchdog-history-log.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { WatchdogPolicyEngine, type DeliveryOutcome } from "../src/domain/watchdog-policy-engine.js";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbs: Database.Database[] = [];
const dirs: string[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const SEAT = "dev@rig1";
const handed = { ok: true, outcome: "retained", reason: HANDED_TO_PUMP, outboxIds: ["guard-watchdog-x"] };

describe("the status of a wake the pump took", () => {
  it("is ok: the row is committed, and the pump carries it until the gate records it", () => {
    expect(watchdogDeliveryOutcome(handed, true)).toEqual({ status: "ok", continuityActionCompleted: true });
  });

  it("a wake the typing guard retained is still retained", () => {
    expect(watchdogDeliveryOutcome({ ok: true, outcome: "retained", reason: "typing_guard_enabled", outboxIds: ["a"] }, false).status).toBe("retained");
  });
});

function store() {
  const db = createDb();
  migrate(db, ALL_MIGRATIONS);
  dbs.push(db);
  const messages = new MessageStore(db);
  const accept = (id: string, jobId: string, seat = SEAT) => messages.accept({ id: messageId(id), seat, sender: "watchdog@system", body: `body ${id}`, auditPointer: jobId, messageClass: "content" });
  return { db, messages, accept };
}

function check(f: ReturnType<typeof store>, opts: { jobGeneration?: string | null; live?: string | null } = {}) {
  return watchdogWakeObligation({ db: f.db, targetGenerationOf: () => opts.jobGeneration ?? null, liveGenerationOf: () => opts.live ?? null });
}

const obliged = (f: ReturnType<typeof store>, id: string, attempts = 0) => {
  const row = f.db.prepare("SELECT audit_pointer AS auditPointer, occupant_generation AS occupantGeneration FROM outbox_entries WHERE outbox_id = ?").get(id) as { auditPointer: string | null; occupantGeneration: string | null };
  return { id: messageId(id), seat: SEAT, messageClass: "content" as const, attempts, ...row };
};

describe("whether a wake is still wanted", () => {
  it("a newer occurrence of the job ends an older row that never went out", () => {
    const f = store();
    f.accept("guard-watchdog-a", "job-1");
    f.accept("guard-watchdog-b", "job-1");
    expect(check(f)(obliged(f, "guard-watchdog-a"))).toContain("job-1");
  });

  it("the newest occurrence is wanted", () => {
    const f = store();
    f.accept("guard-watchdog-a", "job-1");
    f.accept("guard-watchdog-b", "job-1");
    expect(check(f)(obliged(f, "guard-watchdog-b"))).toBeNull();
  });

  it("a row that has gone out once stays: it may have arrived, and it goes on until the gate says", () => {
    const f = store();
    f.accept("guard-watchdog-a", "job-1");
    f.accept("guard-watchdog-b", "job-1");
    expect(check(f)(obliged(f, "guard-watchdog-a", 1))).toBeNull();
  });

  it("another job's newer row changes nothing", () => {
    const f = store();
    f.accept("guard-watchdog-a", "job-1");
    f.accept("guard-watchdog-b", "job-2");
    expect(check(f)(obliged(f, "guard-watchdog-a"))).toBeNull();
  });

  it("a newer occurrence that was itself ended replaces nothing, and one that arrived does", () => {
    const f = store();
    f.accept("guard-watchdog-a", "job-1");
    f.accept("guard-watchdog-b", "job-1");
    f.db.prepare("UPDATE outbox_entries SET message_state = 'undeliverable' WHERE outbox_id = 'guard-watchdog-b'").run();
    expect(check(f)(obliged(f, "guard-watchdog-a"))).toBeNull();
    f.db.prepare("UPDATE outbox_entries SET message_state = 'received' WHERE outbox_id = 'guard-watchdog-b'").run();
    expect(check(f)(obliged(f, "guard-watchdog-a"))).toContain("job-1");
  });

  it("another family's row under the same pointer is no occurrence of the job", () => {
    const f = store();
    f.accept("guard-watchdog-a", "job-1");
    f.accept("outbox-b", "job-1");
    expect(check(f)(obliged(f, "guard-watchdog-a"))).toBeNull();
  });

  it("a row with no job has nothing to read", () => {
    const f = store();
    f.accept("guard-watchdog-a", "job-1");
    expect(check(f)({ ...obliged(f, "guard-watchdog-a"), auditPointer: null })).toBeNull();
  });

  it("a generation-bound job's wake ends once its target has handed over, whatever the attempts", () => {
    const f = store();
    f.accept("guard-watchdog-a", "job-1");
    expect(check(f, { jobGeneration: "gen-1", live: "gen-2" })(obliged(f, "guard-watchdog-a", 3))).toContain("gen-2");
  });

  it("the same generation, an unknown live one, and a role-bound job are all still wanted", () => {
    const f = store();
    f.accept("guard-watchdog-a", "job-1");
    const row = obliged(f, "guard-watchdog-a");
    expect(check(f, { jobGeneration: "gen-1", live: "gen-1" })(row)).toBeNull();
    expect(check(f, { jobGeneration: "gen-1", live: null })(row)).toBeNull();
    expect(check(f, { jobGeneration: null, live: "gen-2" })(row)).toBeNull();
  });
});

describe("the engine with a wake the pump carries", () => {
  function setup(answer: () => DeliveryOutcome, carried: boolean) {
    const f = store();
    const dir = mkdtempSync(join(tmpdir(), "wd-pump-"));
    dirs.push(dir);
    const transcript = join(dir, "t.jsonl");
    writeFileSync(transcript, "x".repeat(4096));
    f.db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1', 'rig1')").run();
    f.db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('node-1', 'rig-1', 'dev')").run();
    f.db.prepare("INSERT INTO sessions (id, node_id, session_name) VALUES ('s-1', 'node-1', ?)").run(SEAT);
    f.db.prepare("INSERT INTO occupant_tenures (id, node_id, generation_ordinal, generation_uuid, kind, boot_at) VALUES ('t-1', 'node-1', 1, 'gen-1', 'initial', '2026-08-28T09:00:00.000Z')").run();
    const repo = new WatchdogJobsRepository(f.db, undefined, () => "gen-1");
    const seen: { thresholdBeforeDeliver?: string | null } = {};
    const job = repo.register({ policy: "context-usage-threshold", specYaml: JSON.stringify({ policy: "context-usage-threshold", target: { session: SEAT }, message: "too big" }), targetSession: SEAT, intervalSeconds: 60, registeredBySession: "test@rig1", watchedFilePath: transcript, thresholdBytes: 1024 });
    const engine = new WatchdogPolicyEngine({
      jobsRepo: repo, historyLog: new WatchdogHistoryLog(f.db), eventBus: new EventBus(f.db),
      deliver: async () => { seen.thresholdBeforeDeliver = repo.getByIdOrThrow(job.jobId).lastFiredGeneration ?? null; return answer(); },
      resolveTargetGeneration: () => "gen-1",
      pumpCarries: () => carried,
    });
    return { engine, repo, job, seen };
  }

  it("records the threshold fire only once the row is committed, so a crash before it leaves the condition open", async () => {
    const f = setup(() => ({ status: "ok" }), true);
    await f.engine.evaluate(f.job);
    expect(f.seen.thresholdBeforeDeliver).toBeNull();
    expect(f.repo.getByIdOrThrow(f.job.jobId).lastFiredGeneration).toBe("gen-1");
  });

  it("a row that could not be committed leaves the condition open for the next scan", async () => {
    const f = setup(() => ({ status: "failed", error: "no row" }), true);
    await f.engine.evaluate(f.job);
    expect(f.repo.getByIdOrThrow(f.job.jobId).lastFiredGeneration ?? null).toBeNull();
  });

  it("a seat the pump does not serve keeps the at-most-once order: the fire is recorded first", async () => {
    const f = setup(() => ({ status: "failed", error: "refused" }), false);
    await f.engine.evaluate(f.job);
    expect(f.seen.thresholdBeforeDeliver).toBe("gen-1");
  });
});

describe("a condition's receipt", () => {
  function engine() {
    const f = store();
    const repo = new WatchdogJobsRepository(f.db);
    const job = repo.register({ policy: "periodic-reminder", specYaml: JSON.stringify({ target: { session: SEAT }, message: "stand by" }), targetSession: SEAT, intervalSeconds: 60, registeredBySession: "test@rig1" });
    const ids: string[] = [];
    const engine = new WatchdogPolicyEngine({
      jobsRepo: repo, historyLog: new WatchdogHistoryLog(f.db), eventBus: new EventBus(f.db), pumpCarries: () => true,
      deliver: async (_request, source) => {
        const id = `guard-watchdog-${source.occurrenceId}`;
        ids.push(id);
        f.accept(id, job.jobId);
        return watchdogDeliveryOutcome(handed, false);
      },
    });
    return { f, repo, job, engine, ids };
  }

  it("a wake the pump took reads as sent in the history, not as held", async () => {
    const { engine: e, repo, job } = engine();
    const result = await e.evaluate(repo.getByIdOrThrow(job.jobId));
    expect(result.delivery?.status).toBe("ok");
    expect(result.history).toMatchObject({ outcome: "sent", skipReason: null, deliveryStatus: "ok" });
  });

  it("a periodic job's three scans with the seat out make one row per occurrence", async () => {
    const { f, engine: e, repo, job, ids } = engine();
    for (let i = 0; i < 3; i++) await e.evaluate(repo.getByIdOrThrow(job.jobId));
    expect(new Set(ids).size).toBeGreaterThanOrEqual(2);
    expect((f.db.prepare("SELECT count(*) AS n FROM outbox_entries").get() as { n: number }).n).toBe(new Set(ids).size);
  });
});

describe("the pump with the wake's obligation", () => {
  it("delivers the newest occurrence once and ends the older ones with no attempt and no notice", async () => {
    const f = store();
    const attempted: string[] = [];
    const returned: string[] = [];
    const seen = new Set<string>();
    const out = { result: { kind: "paused", reason: "seat_stopped" } as LastHopResult };
    const hop: LastHop = { attempt: async (message) => { if (out.result.kind === "sent") { attempted.push(message.ids[0]); seen.add(message.ids[0]); } return out.result; } };
    const gate: SeatGate = { version: 1, lookup: async (_seat, id) => (seen.has(id) ? { kind: "seen", record: { id, recordedAt: "2026-11-01T00:00:00.000Z", nonce: null } } : { kind: "not_seen" }) };
    const obligations = new MessageObligations();
    obligations.register("guard-watchdog-", check(f));
    const pump = new MessagePump({
      store: f.messages, ports: { gateFor: () => gate, hopFor: () => hop }, obligations, log: () => undefined, timing: { pauseRecheckMs: 0 },
      directory: { fate: () => ({ kind: "live", occupantGeneration: null }) }, held: { status: () => "held" },
      senders: { returnToSender: async (message) => { returned.push(message.id); return { kind: "no_return_path", reason: "none" }; } },
    });
    await pump.tick();
    f.accept("guard-watchdog-a", "job-1");
    await pump.tick();
    f.accept("guard-watchdog-b", "job-1");
    f.accept("guard-watchdog-c", "job-1");
    out.result = { kind: "sent" };
    for (let i = 0; i < 3; i++) await pump.tick();
    expect(attempted).toEqual(["guard-watchdog-c"]);
    expect(returned).toEqual([]);
    const states = f.db.prepare("SELECT outbox_id AS id, message_state AS state, ack_evidence AS evidence FROM outbox_entries ORDER BY rowid").all();
    expect(states).toEqual([
      { id: "guard-watchdog-a", state: "undeliverable", evidence: "superseded" },
      { id: "guard-watchdog-b", state: "undeliverable", evidence: "superseded" },
      { id: "guard-watchdog-c", state: "received", evidence: "gate_seen" },
    ]);
  });
});
