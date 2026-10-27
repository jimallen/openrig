// w1 "damaged-row safety II" (OF-140, OF-136 non-display parts and its N4 addendum). OF-117 made a listing mark a damaged
// saved row, a decision read refuse it by name, and a sweep name and skip it. Five places still ended a whole pass on one
// damaged row, or read a row they could not read as an absent one and acted on that:
//   - the wake ladder's escalation aggregate (refresh / ensure) and the prompt pass's aggregate, recovery and re-read:
//     `getById(...)!` on a row found by its tag text; one damaged aggregate failed the tick for every destination (OF-140);
//   - the wake-intent drain: damaged intents stay pending at the head of the oldest-first list, so 200 of them fill every
//     batch and the good intents behind them are never reached (OF-136);
//   - two `events.payload` json_extract reads: one damaged event threw for every row asking (OF-136);
//   - a flagged workflow instance was served `deadline: healthy` (OF-136, N3);
//   - the N4 sites that are decision or listing readers: the stuck-exception reconcile, the cached-spec removal, the spec library.
//
// Each row damages ONE input of ONE site, so each guard fails on its own. Production consequence, in the names: one damaged
// saved row names itself and waits for repair; it does not blind delivery for every seat, and it is never read as "absent".
//
// Deployed entrypoints: startup.ts runs runWakeLadderTick (scheduler), drainPendingWakeIntents, runStuckSweep, the workflow
// keepalive / boot sweep (WorkflowRuntime.reconcileStuckExceptions), scanWorkflowSpecFolder; server.ts mounts routes/workflow.ts
// (listInstancesWithDeadline) and the spec library (scanWorkflowSpecs); the restore route calls reconcileNodeRuntimeTruth.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { migrate } from "../src/db/migrate.js";
import { createDb } from "../src/db/connection.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository, type QueueItem, type QueueNudgeTransport } from "../src/domain/queue-repository.js";
import { escalationDedupTag, runWakeLadderTick } from "../src/domain/queue-wake-ladder.js";
import { LADDER_ATTEMPT_PREFIX, LADDER_RUNG_PREFIX } from "../src/domain/queue-stuck-sweep.js";
import { RESERVE_PREFIX, REFUSED_PREFIX } from "../src/domain/policies/parked-owner-consumer.js";
import { USAGE_LIMIT_BLOCKER_TAG } from "../src/domain/queue-wake-repository.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { WorkflowSpecCache } from "../src/domain/workflow-spec-cache.js";
import { scanWorkflowSpecFolder, scanWorkflowSpecs } from "../src/domain/spec-library-workflow-scanner.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import { workflowRoutes } from "../src/routes/workflow.js";
import { jsonBodyErrorHandler } from "../src/middleware/json-body-error.js";
import { createFullTestDb } from "./helpers/test-app.js";

const NOT_JSON = "{not json";

// ───────────────────────────── OF-140: the wake ladder's aggregates ─────────────────────────────

describe("OF-140: a damaged escalation or prompt aggregate waits for repair; it does not fail the ladder tick for every destination", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let calls: Array<{ qitemId: string; target: string }>;
  let lines: string[];

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    calls = [];
    lines = [];
  });
  afterEach(() => db.close());

  const attemptWake = async (qitemId: string, target: string): Promise<string> => {
    calls.push({ qitemId, target });
    return "failed:tmux session not found";
  };
  async function tick(extra: Partial<Parameters<typeof runWakeLadderTick>[0]> = {}) {
    return runWakeLadderTick({
      db, queueRepo: repo, attemptWake, resolveOrchestrator: () => "orch@r",
      retryIntervalSeconds: 300, retryCap: 3, unconfirmedWindowMinutes: 30, swapGraceSeconds: 180,
      log: (line: string) => lines.push(line), ...extra,
    });
  }
  const skippedLine = (id: string, column: string) => `[wake-ladder] ${id} skipped: its saved ${column} is not readable JSON (repair or remove the row)`;
  const setColumn = (qitemId: string, column: string, text: string | null) =>
    db.prepare(`UPDATE queue_items SET ${column} = ? WHERE qitem_id = ?`).run(text, qitemId);
  const rawTags = (qitemId: string): string => (db.prepare("SELECT tags FROM queue_items WHERE qitem_id = ?").get(qitemId) as { tags: string }).tags;
  const markers = (qitemId: string, prefix: string): string[] =>
    (db.prepare("SELECT transition_note FROM queue_transitions WHERE qitem_id = ? ORDER BY ts, rowid").all(qitemId) as Array<{ transition_note: string | null }>)
      .map((row) => row.transition_note ?? "").filter((note) => note.startsWith(prefix));

  async function mkBaton(dest: string): Promise<QueueItem> {
    const src = await repo.create({ sourceSession: "sender@r", destinationSession: "relay@r", body: "obligation" });
    return (await repo.handoff({ qitemId: src.qitemId, fromSession: "relay@r", toSession: dest, nudge: false })).created;
  }
  /** A baton whose retry cap is spent, so the next tick escalates it (the storm fixture of queue-wake-ladder.test.ts). */
  async function escalatedBaton(dest: string): Promise<QueueItem> {
    const baton = await mkBaton(dest);
    db.prepare("UPDATE queue_items SET last_nudge_attempt = ?, last_nudge_result = 'failed:tmux session not found' WHERE qitem_id = ?")
      .run(new Date(Date.now() - 120 * 60_000).toISOString(), baton.qitemId);
    for (let attempt = 1; attempt <= 3; attempt++) {
      repo.transitionLog.append({ qitemId: baton.qitemId, state: "pending", actorSession: "wake-ladder@system", transitionNote: `${LADDER_ATTEMPT_PREFIX} ${attempt}/3 outcome=failed:fixture` });
    }
    db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ? AND transition_note LIKE 'wake-attempt:%'")
      .run(new Date(Date.now() - 30 * 60_000).toISOString(), baton.qitemId);
    return baton;
  }
  const aggregatesFor = (dest: string): QueueItem[] => repo.list({ limit: 500 }).filter((row) => (row.tags ?? []).includes(escalationDedupTag(dest)));

  describe("the wake-escalation aggregate (ensureEscalationRow / refreshEscalationRowIfExists)", () => {
    const DAMAGE: Array<[string, string, (aggregateId: string) => string]> = [
      ["chain_of_record", "chain_of_record", () => NOT_JSON],
      ["human_questions", "human_questions", () => NOT_JSON],
      ["tags of a truncated list that still carries the dedup tag", "tags", () => JSON.stringify(["wake-escalation", escalationDedupTag("worker@r")]).slice(0, -1)],
    ];

    it.each(DAMAGE)("%s damaged: the tick is not failed, the other destination is escalated, no second aggregate is opened beside it, the damaged row is named", async (_name, column, damaged) => {
      const first = await escalatedBaton("worker@r");
      await tick();
      const [aggregate] = aggregatesFor("worker@r");
      expect(aggregate, "the first tick opened the aggregate").toBeDefined();
      setColumn(aggregate!.qitemId, column, damaged(aggregate!.qitemId));
      const late = await escalatedBaton("worker@r");
      const other = await escalatedBaton("other@r");
      calls.length = 0;
      lines.length = 0;

      const result = await tick();

      expect(result.outcome, lines.join("\n")).not.toBe("failed");
      expect(result.error).toBeUndefined();
      const otherAggregate = aggregatesFor("other@r");
      expect(otherAggregate, "the destination beside the damaged one is escalated as before").toHaveLength(1);
      expect(calls).toContainEqual({ qitemId: otherAggregate[0]!.qitemId, target: "orch@r" });
      expect(markers(other.qitemId, LADDER_RUNG_PREFIX).length).toBeGreaterThan(0);
      // Not read as absent: no second aggregate for the destination whose aggregate is unreadable, and nothing acted on it.
      expect(db.prepare("SELECT COUNT(*) AS n FROM queue_items WHERE tags LIKE ?").get(`%"${escalationDedupTag("worker@r")}"%`)).toEqual({ n: 1 });
      expect(calls.filter((call) => call.qitemId === aggregate!.qitemId)).toEqual([]);
      expect(markers(late.qitemId, LADDER_RUNG_PREFIX), "no rung is recorded for a destination whose aggregate cannot take members").toEqual([]);
      expect(rawTags(aggregate!.qitemId)).not.toContain(late.qitemId);
      expect(markers(first.qitemId, LADDER_RUNG_PREFIX)).toHaveLength(1);
      expect(lines).toContain(skippedLine(aggregate!.qitemId, column));
    });

    it("once the row is repaired the destination is escalated again and the aggregate gains the member it could not take", async () => {
      await escalatedBaton("worker@r");
      await tick();
      const [aggregate] = aggregatesFor("worker@r");
      setColumn(aggregate!.qitemId, "chain_of_record", NOT_JSON);
      const late = await escalatedBaton("worker@r");
      await tick();
      expect(markers(late.qitemId, LADDER_RUNG_PREFIX)).toEqual([]);

      setColumn(aggregate!.qitemId, "chain_of_record", null);
      lines.length = 0;
      calls.length = 0;
      const result = await tick();

      expect(result.outcome).not.toBe("failed");
      expect(lines.filter((line) => line.includes("skipped"))).toEqual([]);
      expect(rawTags(aggregate!.qitemId)).toContain(late.qitemId);
      expect(markers(late.qitemId, LADDER_RUNG_PREFIX).length).toBeGreaterThan(0);
      expect(aggregatesFor("worker@r")).toHaveLength(1);
    });
  });

  describe("the shared usage-limit blocker (ensureUsageLimitBlocker)", () => {
    const blockerRows = () => db.prepare("SELECT qitem_id FROM queue_items WHERE tags LIKE ?").all(`%"${USAGE_LIMIT_BLOCKER_TAG}"%`) as Array<{ qitem_id: string }>;

    it.each([["chain_of_record"], ["tags"]])("an existing blocker whose %s cannot be read is named: the tick is not failed, no second blocker is opened, and the seat waits for the repair", async (column) => {
      const now = new Date();
      const reset = new Date(now.getTime() + 15 * 60_000).toISOString();
      const staleAfter = new Date(now.getTime() + 30 * 60_000).toISOString();
      repo.attachWatchdogJobsRepository(new WatchdogJobsRepository(db, () => now));
      const model = (seats: string[]) => async () => ({
        bindings: [],
        signals: seats.map((seatSession) => ({
          provider: "claude" as const, seatSession, sourceClass: "provider_statusline" as const, authority: "account_cross_device" as const,
          window: "five_hour", usedPercent: 100, resetsAt: reset, asOf: now.toISOString(), staleAfter, supportsNotification: false,
          automationUse: "allow_switch_decision" as const,
        })),
      });
      const limited = async (dest: string) => {
        const baton = await mkBaton(dest);
        repo.recordNudgeAttempt(baton.qitemId, "failed:provider usage limit");
        return baton;
      };
      await limited("dev-a@r");
      await tick({ now, usageLimitJitterSeconds: 0, getProviderReadModel: model(["dev-a@r"]) });
      const [blocker] = blockerRows();
      expect(blocker, "the first tick opened the shared blocker").toBeDefined();
      // For `tags` the damage keeps the quoted tag text, as a truncated write does: the blocker is still there.
      setColumn(blocker!.qitem_id, column, column === "tags" ? rawTags(blocker!.qitem_id).slice(0, -1) : NOT_JSON);
      const late = await limited("dev-c@r");
      lines.length = 0;

      const result = await tick({ now, usageLimitJitterSeconds: 0, getProviderReadModel: model(["dev-a@r", "dev-c@r"]) });

      expect(result.outcome, lines.join("\n")).not.toBe("failed");
      expect(blockerRows().map((row) => row.qitem_id), "no second blocker beside the unreadable one").toEqual([blocker!.qitem_id]);
      expect(repo.getById(late.qitemId)!.state, "the seat is not parked on a guess").toBe("pending");
      expect(lines.some((line) => line.includes(`usage-limit blocker ${blocker!.qitem_id}`) && line.includes(`${column} that is not readable JSON`))).toBe(true);
    });
  });

  describe("the prompt pass (aggregate re-read, recovery lookup, aggregate after ensure)", () => {
    const BLOCKED = () => "blocked" as const;
    const FUTURE = () => new Date(Date.now() + 60_000);
    /** A work row whose parked-owner wake was refused at an interactive prompt: the reserve + refusal notes openPromptRefusals reads. */
    async function refusedRow(dest: string): Promise<QueueItem> {
      const row = await repo.create({ sourceSession: "sender@r", destinationSession: dest, body: "work", nudge: false });
      repo.claim({ qitemId: row.qitemId, destinationSession: dest });
      const key = `${dest}|w1fixture#1`;
      repo.transitionLog.append({ qitemId: row.qitemId, state: "in-progress", actorSession: "watchdog@system", transitionNote: `${RESERVE_PREFIX} ${key}; generation g1; obligations ${row.qitemId}` });
      repo.transitionLog.append({ qitemId: row.qitemId, state: "in-progress", actorSession: "watchdog@system", transitionNote: `${REFUSED_PREFIX} ${key}` });
      return row;
    }
    const promptAggregates = (dest: string): QueueItem[] =>
      repo.list({ limit: 500 }).filter((row) => (row.tags ?? []).includes("wake-prompt-refusal") && (row.tags ?? []).includes(`prompt-destination:${dest}`));
    const passFailed = () => lines.filter((line) => line.includes("prompt refusal pass failed"));

    it("a damaged prompt aggregate is named and left alone: the pass still escalates the other seat, and no second aggregate is opened for the damaged one", async () => {
      await refusedRow("seat-a@r");
      await tick({ readPromptState: BLOCKED, now: FUTURE() });
      const [aggregate] = promptAggregates("seat-a@r");
      expect(aggregate, "the first pass opened the prompt aggregate").toBeDefined();
      setColumn(aggregate!.qitemId, "chain_of_record", NOT_JSON);
      await refusedRow("seat-b@r");
      calls.length = 0;
      lines.length = 0;

      await tick({ readPromptState: BLOCKED, now: FUTURE() });

      expect(passFailed(), lines.join("\n")).toEqual([]);
      expect(promptAggregates("seat-b@r"), "the seat beside the damaged aggregate is escalated").toHaveLength(1);
      expect(promptAggregates("seat-a@r").map((row) => row.qitemId), "no second aggregate beside the unreadable one").toEqual([aggregate!.qitemId]);
      expect(calls.filter((call) => call.qitemId === aggregate!.qitemId)).toEqual([]);
      expect(lines).toContain(skippedLine(aggregate!.qitemId, "chain_of_record"));
    });

    it("a recovery row that exists but cannot be read owns the continuation: the seat is not escalated, the pass goes on, the row is named", async () => {
      const held = await refusedRow("seat-c@r");
      const recovery = await repo.create({ sourceSession: "sender@r", destinationSession: "elsewhere@r", body: "recovery", nudge: false, tags: ["some-recovery", `recovery-for:${held.qitemId}`] });
      await refusedRow("seat-d@r");

      // Control: the same recovery, readable, is owned elsewhere: the seat is not escalated either.
      await tick({ readPromptState: BLOCKED, now: FUTURE() });
      expect(promptAggregates("seat-c@r"), "control: readable recovery owned elsewhere").toEqual([]);
      expect(promptAggregates("seat-d@r")).toHaveLength(1);

      // Damage the recovery: an unreadable recovery is not an absent one. (Fresh rows, so the first pass cannot answer for this one.)
      const heldAgain = await refusedRow("seat-e@r");
      const recoveryAgain = await repo.create({ sourceSession: "sender@r", destinationSession: "elsewhere@r", body: "recovery", nudge: false, tags: ["some-recovery", `recovery-for:${heldAgain.qitemId}`] });
      setColumn(recoveryAgain.qitemId, "chain_of_record", NOT_JSON);
      await refusedRow("seat-f@r");
      calls.length = 0;
      lines.length = 0;

      await tick({ readPromptState: BLOCKED, now: FUTURE() });

      expect(passFailed(), lines.join("\n")).toEqual([]);
      expect(promptAggregates("seat-e@r"), "an unreadable recovery is not read as no recovery").toEqual([]);
      expect(promptAggregates("seat-f@r"), "the seat beside it is escalated").toHaveLength(1);
      expect(lines).toContain(skippedLine(recoveryAgain.qitemId, "chain_of_record"));
      expect(recovery.qitemId).not.toBe(recoveryAgain.qitemId);
    });
  });
});

// ───────────────────────────── OF-136: the wake-intent drain ─────────────────────────────

describe("OF-136: damaged wake intents do not starve the good ones behind them", () => {
  let db: Database.Database;
  let bus: EventBus;
  let outbox: OutboxHandler;
  let repo: QueueRepository;
  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    bus = new EventBus(db);
    outbox = new OutboxHandler(db);
    repo = new QueueRepository(db, bus, { validateRig: () => true });
    repo.attachOutbox(outbox);
  });
  afterEach(() => db.close());

  async function goodIntent(n: number): Promise<string> {
    const source = await repo.create({ nudge: false, sourceSession: "planner@rig", destinationSession: "driver@rig", body: `x${n}` });
    const handed = (await repo.handoff({ qitemId: source.qitemId, fromSession: "driver@rig", toSession: `reviewer-${n}@rig`, body: `y${n}` })).created;
    return `wake-intent-${handed.qitemId}`;
  }

  // The batch is 200. Damaged intents are never executed, so they stay pending at the head of the oldest-first list: with
  // 200 of them the first batch holds nothing else, and the drain used to stop there ("nothing progressed").
  it.each([[199], [200], [201], [450]])("with %i damaged intents ahead of three good ones, all three are delivered and every damaged one is named", async (damaged) => {
    for (let n = 0; n < damaged; n++) {
      outbox.record({ outboxId: `wake-intent-bad-${String(n).padStart(4, "0")}`, senderSession: "planner@rig", destinationSession: "owner@rig", body: "wake", tags: ["t"] });
    }
    db.prepare("UPDATE outbox_entries SET tags = ? WHERE outbox_id LIKE 'wake-intent-bad-%'").run(NOT_JSON);
    const good = [await goodIntent(1), await goodIntent(2), await goodIntent(3)];
    const sent: string[] = [];
    const transport: QueueNudgeTransport = { async send(session) { sent.push(session); return { ok: true, verified: true }; } };
    repo.attachTransport(transport);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const tally = await repo.drainPendingWakeIntents();
    errors.mockRestore();

    expect(tally.delivered).toBe(3);
    expect([...sent].sort()).toEqual(["reviewer-1@rig", "reviewer-2@rig", "reviewer-3@rig"]);
    for (const id of good) expect(outbox.getById(id)!.deliveryState).toBe("delivered");
    expect(tally.unreadable).toHaveLength(damaged);
    expect(new Set(tally.unreadable).size, "each damaged intent is named once").toBe(damaged);
    expect((db.prepare("SELECT COUNT(*) AS n FROM outbox_entries WHERE outbox_id LIKE 'wake-intent-bad-%' AND delivery_state = 'pending'").get() as { n: number }).n, "damaged intents stay pending").toBe(damaged);
  });

  it("control: nothing damaged, nothing named, and the drain still ends on a short batch", async () => {
    await goodIntent(1);
    repo.attachTransport({ async send() { return { ok: true, verified: true }; } });
    const tally = await repo.drainPendingWakeIntents();
    expect(tally.delivered).toBe(1);
    expect("unreadable" in tally).toBe(false);
  });

  it("a transport that cannot deliver still stops the drain (damaged intents do not turn 'nothing progressed' into a loop)", async () => {
    for (let n = 0; n < 3; n++) outbox.record({ outboxId: `wake-intent-bad-${n}`, senderSession: "planner@rig", destinationSession: "owner@rig", body: "wake", tags: ["t"] });
    db.prepare("UPDATE outbox_entries SET tags = ? WHERE outbox_id LIKE 'wake-intent-bad-%'").run(NOT_JSON);
    await goodIntent(1);
    repo.attachTransport({ async send() { return { ok: false, verified: false, error: "no tmux" }; } });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const tally = await repo.drainPendingWakeIntents();
    errors.mockRestore();
    expect(tally.delivered).toBe(0);
    expect(tally.unreadable).toHaveLength(3);
  });
});

// ───────────────────────────── OF-136: events.payload, guard not strict ─────────────────────────────

describe("OF-136: one damaged events.payload row does not throw for every row asking", () => {
  describe("recordClosureOverdue (the legacy no-transitions-table dedupe)", () => {
    const QITEM = "qitem-w1_overdue_1";
    function legacyRepo() {
      const db = createDb();
      migrate(db, [coreSchema, eventsSchema, queueItemsSchema, outboxEntriesSchema]);
      const bus = new EventBus(db);
      const repo = new QueueRepository(db, bus);
      repo.attachOutbox(new OutboxHandler(db));
      const claimed = new Date(Date.now() - 5 * 60_000).toISOString();
      const created = new Date(Date.now() - 10 * 60_000).toISOString();
      for (const id of [QITEM, "qitem-w1_overdue_2"]) {
        db.prepare(`INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, body, closure_required_at, claimed_at)
          VALUES (?, ?, ?, 'alice@rig-a', 'bob@rig-b', 'in-progress', 'routine', 'legacy overdue', ?, ?)`).run(id, created, created, claimed, claimed);
      }
      return { db, repo };
    }
    const overdueEvents = (db: Database.Database) => (db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'qitem.closure_overdue' AND json_valid(payload)").get() as { n: number }).n;

    it("an unrelated damaged event does not stop the dedupe check; the overdue item is still recorded once", () => {
      const { db, repo } = legacyRepo();
      db.prepare("INSERT INTO events (type, payload) VALUES ('qitem.closure_overdue', ?)").run(NOT_JSON);
      const first = repo.recordClosureOverdue("qitem-w1_overdue_2", { now: new Date().toISOString() });
      expect(first?.type).toBe("qitem.closure_overdue");
      expect(overdueEvents(db)).toBe(1);
      db.close();
    });

    it("a damaged event that still names the item counts as recorded: no second event is emitted on a guess", () => {
      const { db, repo } = legacyRepo();
      db.prepare("INSERT INTO events (type, payload) VALUES ('qitem.closure_overdue', ?)").run(`{"qitemId":"${QITEM}","closureRequiredAt":`);
      expect(repo.recordClosureOverdue(QITEM, { now: new Date().toISOString() })).toBeNull();
      expect(overdueEvents(db)).toBe(0);
      db.close();
    });

    it("control: a readable event for the item dedupes, and a damaged event naming only a different item does not hide this one", () => {
      const { db, repo } = legacyRepo();
      db.prepare("INSERT INTO events (type, payload) VALUES ('qitem.closure_overdue', ?)").run(`{"qitemId":"qitem-w1_overdue_2","oops":`);
      expect(repo.recordClosureOverdue(QITEM, { now: new Date().toISOString() })?.type).toBe("qitem.closure_overdue");
      expect(repo.recordClosureOverdue(QITEM, { now: new Date().toISOString() })).toBeNull();
      db.close();
    });
  });

  describe("reconcileNodeRuntimeTruth (the prior-reconciliation shortcut)", () => {
    function setup(beforeStarted?: (db: Database.Database, rigId: string, nodeId: string) => void) {
      const db = createFullTestDb();
      const rigRepo = new RigRepository(db);
      const sessionRegistry = new SessionRegistry(db);
      const eventBus = new EventBus(db);
      const snapshotRepo = new SnapshotRepository(db);
      const checkpointStore = new CheckpointStore(db);
      const snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });
      const tmuxAdapter = new TmuxAdapter(async () => "");
      const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter });
      const orchestrator = new RestoreOrchestrator({
        db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture, checkpointStore, nodeLauncher, tmuxAdapter,
        claudeResume: new ClaudeResumeAdapter(tmuxAdapter), codexResume: new CodexResumeAdapter(tmuxAdapter),
      });
      const rig = rigRepo.createRig("w1rig");
      const node = rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: "claude-code" });
      beforeStarted?.(db, rig.id, node.id);
      eventBus.emit({ type: "restore.started", rigId: rig.id, snapshotId: "snap-w1" });
      eventBus.emit({
        type: "restore.completed", rigId: rig.id, snapshotId: "snap-w1",
        result: { snapshotId: "snap-w1", preRestoreSnapshotId: null, rigResult: "partially_restored", nodes: [{ nodeId: node.id, logicalId: "worker", status: "failed" }], warnings: [] },
      });
      const attemptId = (db.prepare("SELECT seq FROM events WHERE rig_id = ? AND type = 'restore.started'").get(rig.id) as { seq: number }).seq;
      return { db, orchestrator, rigId: rig.id, nodeId: node.id, attemptId };
    }
    const insertEvent = (db: Database.Database, rigId: string, nodeId: string, payload: string) =>
      db.prepare("INSERT INTO events (rig_id, node_id, type, payload) VALUES (?, ?, 'restore.outcome_reconciled', ?)").run(rigId, nodeId, payload);

    it("a damaged reconciliation event from an OLDER attempt (written before this attempt's restore.started) does not block this one: the live proof runs (no tmux binding here)", async () => {
      const { db, orchestrator, rigId, nodeId } = setup((d, r, n) => insertEvent(d, r, n, NOT_JSON));
      const result = await orchestrator.reconcileNodeRuntimeTruth(rigId, nodeId);
      expect(result).toMatchObject({ ok: false, code: "tmux_session_missing" });
      db.close();
    });

    it("a damaged reconciliation event of another NODE of the rig does not block this one", async () => {
      const { db, orchestrator, rigId, nodeId } = setup();
      insertEvent(db, rigId, "some-other-node", NOT_JSON);
      expect(await orchestrator.reconcileNodeRuntimeTruth(rigId, nodeId)).toMatchObject({ ok: false, code: "tmux_session_missing" });
      db.close();
    });

    // A damaged row written during this attempt may keep none, some or all of its text. Every shape refuses by name and writes nothing:
    // the reconcile used to append a second event for the same attempt.
    describe("a damaged reconciliation event written during this attempt refuses by name and writes nothing: the node may already be reconciled", () => {
      const evidence = { tmux: true, fgProcess: "claude", resumeTokenUsed: true, paneState: "usable" };
      it.each([
        ["the payload overwritten with text that is not JSON", () => NOT_JSON],
        ["a payload cut right after the attempt id's digits", (_r: string, _n: string, a: number) => `{"type":"restore.outcome_reconciled","attemptId":${a}`],
        ["a payload cut inside the evidence", (r: string, n: string, a: number) => {
          const whole = JSON.stringify({ type: "restore.outcome_reconciled", rigId: r, nodeId: n, attemptId: a, from: "failed", to: "operator_recovered", evidence });
          return whole.slice(0, whole.indexOf('"evidence"') + 10);
        }],
      ])("%s", async (_name, damaged) => {
        const { db, orchestrator, rigId, nodeId, attemptId } = setup();
        const eventsBefore = (db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
        const damagedSeq = Number(insertEvent(db, rigId, nodeId, damaged(rigId, nodeId, attemptId)).lastInsertRowid);
        const result = await orchestrator.reconcileNodeRuntimeTruth(rigId, nodeId);
        expect(result).toMatchObject({ ok: false, code: "prior_reconciliation_unreadable" });
        expect(result.ok ? "" : result.detail).toContain(`events row ${damagedSeq}`);
        expect((db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n, "nothing was appended").toBe(eventsBefore + 1);
        db.close();
      });
    });

    it("a damaged event is not evidence and does not hide the valid prior one beside it", async () => {
      const { db, orchestrator, rigId, nodeId, attemptId } = setup();
      const evidence = { tmux: true, fgProcess: "claude", resumeTokenUsed: true, paneState: "usable" };
      insertEvent(db, rigId, nodeId, JSON.stringify({ type: "restore.outcome_reconciled", rigId, nodeId, attemptId, from: "failed", to: "operator_recovered", evidence }));
      insertEvent(db, rigId, nodeId, NOT_JSON);
      const result = await orchestrator.reconcileNodeRuntimeTruth(rigId, nodeId);
      expect(result).toMatchObject({ ok: true, attemptId, from: "failed", to: "operator_recovered", evidence });
      db.close();
    });
  });
});

// ───────────────────────────── OF-136 N3 + N4: workflow ─────────────────────────────

const SPEC = `workflow:
  id: w1wf
  version: 1
  entry:
    role: worker
  roles:
    worker:
      preferred_targets:
        - worker@rig
  steps:
    - id: work
      actor_role: worker
      allowed_exits:
        - done
`;

describe("workflow readers", () => {
  let db: Database.Database;
  let runtime: WorkflowRuntime;
  let queueRepo: QueueRepository;
  let tmp: string;
  let specPath: string;
  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const bus = new EventBus(db);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')").run();
    queueRepo = new QueueRepository(db, bus, { validateRig: () => true, transport: { send: async () => ({ ok: true, verified: true }) } });
    runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo });
    tmp = mkdtempSync(join(tmpdir(), "w1-wf-"));
    specPath = join(tmp, "spec.yaml");
    writeFileSync(specPath, SPEC);
  });
  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });
  const instance = async (objective: string) => (await runtime.instantiate({ specPath, rootObjective: objective, createdBySession: "ops@rig" })).instance;

  describe("N3: a flagged workflow instance is not served as healthy", () => {
    it("the flagged instance's deadline is 'unknown' with no evidence; the intact instance beside it keeps its real verdict", async () => {
      const good = await instance("good");
      const bad = await instance("bad");
      db.prepare("UPDATE workflow_instances SET current_frontier_json = ? WHERE instance_id = ?").run(NOT_JSON, bad.instanceId);
      const listed = runtime.listInstancesWithDeadline();
      const flagged = listed.find((row) => row.instanceId === bad.instanceId)!;
      expect(flagged.unreadable).toEqual(["current_frontier_json"]);
      expect(flagged.deadline).toEqual({ state: "unknown", evidence: null });
      expect(listed.find((row) => row.instanceId === good.instanceId)!.deadline).toEqual({ state: "healthy", evidence: null });
    });

    it("GET /list carries the same verdict over HTTP", async () => {
      const bad = await instance("bad");
      db.prepare("UPDATE workflow_instances SET current_frontier_json = ? WHERE instance_id = ?").run(NOT_JSON, bad.instanceId);
      const hono = new Hono();
      hono.onError(jsonBodyErrorHandler);
      hono.use("*", async (c, next) => { c.set("workflowRuntime" as never, runtime); await next(); });
      hono.route("/api/workflow", workflowRoutes());
      const res = await hono.request("/api/workflow/list");
      expect(res.status).toBe(200);
      const rows = await res.json() as Array<{ instanceId: string; deadline: { state: string } }>;
      expect(rows.find((row) => row.instanceId === bad.instanceId)!.deadline.state).toBe("unknown");
    });
  });

  describe("N4: reconcileStuckExceptions names an instance or packet it cannot read and goes on to the exceptions beside it", () => {
    /** An open stuck-overdue exception item for (instance, packet), the shape the keepalive policy writes. */
    async function stuckException(inst: { instanceId: string; workflowName: string }, packetId: string): Promise<QueueItem> {
      return queueRepo.create({
        sourceSession: "ops@rig", destinationSession: "ops@rig", body: "stuck", nudge: false,
        tags: ["workflow-exception", "exception:stuck_overdue", `instance:${inst.instanceId}`, `occurrence:${packetId}`, `workflow:${inst.workflowName}`],
      });
    }

    it.each([
      ["a packet whose chain_of_record is damaged", "packet"],
      ["an instance whose current_frontier_json is damaged", "instance"],
    ])("%s: the damaged exception is left open and named; the resolvable exception after it is closed; project() is not turned into a failure", async (_name, which) => {
      const bad = await instance("bad");
      const good = await instance("good");
      const badPacket = bad.currentFrontier[0]!;
      const goodPacket = good.currentFrontier[0]!;
      const badException = await stuckException(bad, badPacket);
      const goodException = await stuckException(good, goodPacket);
      // The good instance's packet is no longer an active frontier obligation, so its exception is resolvable.
      db.prepare("UPDATE workflow_instances SET status = 'completed' WHERE instance_id = ?").run(good.instanceId);
      if (which === "packet") db.prepare("UPDATE queue_items SET chain_of_record = ? WHERE qitem_id = ?").run(NOT_JSON, badPacket);
      else db.prepare("UPDATE workflow_instances SET current_frontier_json = ? WHERE instance_id = ?").run(NOT_JSON, bad.instanceId);
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});

      let closed = -1;
      expect(() => { closed = runtime.reconcileStuckExceptions(); }).not.toThrow();

      const named = logged.mock.calls.map((args) => String(args[0]));
      logged.mockRestore();
      expect(closed).toBe(1);
      expect(queueRepo.getById(goodException.qitemId)!.state).toBe("done");
      expect(queueRepo.getById(badException.qitemId)!.state, "an exception that cannot be certified is left open").toBe("pending");
      expect(named.some((line) => line.includes(`stuck exception ${badException.qitemId} left open`) && line.includes("not readable JSON"))).toBe(true);
    });
  });

  describe("N4: the cached-spec removal and the spec library", () => {
    const base = Math.floor(Date.now() / 1000) - 1000;
    let folder: string;
    let file: string;
    let cache: WorkflowSpecCache;
    let tick: number;
    beforeEach(() => {
      tick = 0;
      cache = new WorkflowSpecCache(db, () => new Date((base + tick + 1) * 1000));
      folder = mkdtempSync(join(tmpdir(), "w1-specs-"));
      file = join(folder, "flow.yaml");
    });
    afterEach(() => rmSync(folder, { recursive: true, force: true }));
    const write = (content: string) => { writeFileSync(file, content); tick += 10; utimesSync(file, base + tick, base + tick); };
    const scan = () => scanWorkflowSpecFolder({ db, cache, folder, builtinDir: null });
    const specRows = () => db.prepare("SELECT spec_id, status FROM workflow_specs").all() as Array<{ spec_id: string; status: string }>;

    it("a vanished file whose cached row cannot say which version it holds is left in place and named: it is neither deleted nor retained on a guess", () => {
      write(SPEC);
      scan();
      const [row] = specRows();
      expect(row, "the scan cached the spec").toBeDefined();
      // The shape an older diagnostic writer left: no version, the only copy of the identity is the stored spec - which is damaged.
      db.prepare("UPDATE workflow_specs SET version = '', status = 'error', error_message = 'old parse error', spec_json = ? WHERE spec_id = ?").run(NOT_JSON, row!.spec_id);
      unlinkSync(file);
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});

      const result = scan();

      const named = logged.mock.calls.map((args) => String(args[0]));
      logged.mockRestore();
      expect(result.removed).toBe(0);
      expect(specRows()).toEqual([{ spec_id: row!.spec_id, status: "error" }]);
      expect(named.some((line) => line.includes(row!.spec_id) && line.includes("not readable JSON"))).toBe(true);
    });

    it("control: a blanked row with a readable stored spec and no pin is still removed with its vanished file", () => {
      write(SPEC);
      scan();
      const [row] = specRows();
      db.prepare("UPDATE workflow_specs SET version = '', status = 'error', error_message = 'old parse error' WHERE spec_id = ?").run(row!.spec_id);
      unlinkSync(file);
      expect(scan().removed).toBe(1);
      expect(specRows()).toEqual([]);
    });

    it("the library lists a cached spec whose roles_json is damaged as an error entry naming the damage; the spec beside it is listed as before", async () => {
      write(SPEC);
      scan();
      const [row] = specRows();
      const second = join(folder, "second.yaml");
      writeFileSync(second, SPEC.replace("id: w1wf", "id: w1wf-two"));
      utimesSync(second, base + 99, base + 99);
      scan();
      expect(specRows()).toHaveLength(2);
      db.prepare("UPDATE workflow_specs SET roles_json = ? WHERE spec_id = ?").run(NOT_JSON, row!.spec_id);

      const entries = scanWorkflowSpecs({ db, workflowBuiltinSpecsDir: null });

      expect(entries).toHaveLength(2);
      const flagged = entries.filter((entry) => entry.status === "error");
      expect(flagged).toHaveLength(1);
      expect(flagged[0]).toMatchObject({ kind: "workflow", errorMessage: expect.stringContaining("not readable JSON") });
      expect(entries.filter((entry) => entry.status === "valid")).toHaveLength(1);
    });
  });
});
