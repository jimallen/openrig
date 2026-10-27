// y1 "damaged-row safety III" (OF-143, OF-147, and the daemon parts of OF-146). The rule since OF-117: a listing marks the
// damaged row, a decision read refuses it by name, a sweep names and skips it, and an unreadable row is NEVER read as absent
// and then acted on. Four places still broke it:
//   - findQueueRecovery filtered json_valid(tags), so a recovery row with damaged tags read as "no recovery" and the wake ladder
//     retried / escalated / exhausted the original on a guess (OF-143);
//   - the restore attempt receipt scanned every restore.outcome_reconciled event of the rig with json_extract, so ONE damaged
//     event of ANOTHER attempt refused this attempt's receipt (OF-143);
//   - a usage-limit blocker whose tags were overwritten with nothing recognizable was not found, so the ladder opened a second
//     blocker beside it (OF-147);
//   - three daemon displays read a damaged saved column as an empty one with no marker: the rig review's workflow band (a
//     damaged instance vanished from it), the RECENT transition list and the slice's workflow binding (OF-146).
//
// Each row damages ONE input of ONE site, so each guard fails on its own. Production consequence, in the names: a damaged
// saved row names itself and waits for repair; it is never "no recovery", "no blocker", "no reconciliation" or "healthy".
//
// Deployed entrypoints: startup.ts runs runWakeLadderTick (scheduler) and wires queueRecoveryOwnsWake into the waiting view;
// routes/snapshots.ts calls deriveRestoreAttemptReceipt; routes/review.ts serves ReviewGatherer.composeRig; routes/queue.ts
// serves listRecentTransitions; routes/slices.ts and the SliceDetailProjector call findSliceWorkflowBinding.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository, type QueueItem } from "../src/domain/queue-repository.js";
import { findQueueRecovery, recoveryTag } from "../src/domain/queue-recovery.js";
import { queueRecoveryOwnsWake, readWakeLadderBackstop, runWakeLadderTick } from "../src/domain/queue-wake-ladder.js";
import { LADDER_ATTEMPT_PREFIX, LADDER_RUNG_PREFIX } from "../src/domain/queue-stuck-sweep.js";
import { USAGE_LIMIT_BLOCKER_TAG } from "../src/domain/queue-wake-repository.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { deriveRestoreAttemptReceipt } from "../src/domain/restore-attempt-receipt.js";
import { ReviewGatherer } from "../src/domain/review/gather.js";
import { SliceIndexer } from "../src/domain/slices/slice-indexer.js";
import { SliceDetailProjector } from "../src/domain/slices/slice-detail-projector.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { runWorkflowBootSweep } from "../src/domain/workflow-boot-sweep.js";
import { makeEnsureStuckExceptionItem } from "../src/domain/workflow-exception-escalation.js";
import { WORKFLOW_STEP_STUCK_THRESHOLD_SECONDS } from "../src/domain/workflow-deadline.js";
import { findSliceWorkflowBinding } from "../src/domain/workflow/slice-workflow-binding.js";

const NOT_JSON = "{not json";

function memoryDb(): Database.Database {
  const db = new Database(":memory:");
  migrate(db, ALL_MIGRATIONS);
  return db;
}

// ───────────────────────────── OF-143: a recovery row with damaged tags ─────────────────────────────

describe("OF-143: a recovery row whose tags are damaged is not 'no recovery'", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let calls: Array<{ qitemId: string; target: string }>;
  let lines: string[];

  beforeEach(() => {
    db = memoryDb();
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    calls = [];
    lines = [];
  });
  afterEach(() => db.close());

  const attemptWake = async (qitemId: string, target: string): Promise<string> => {
    calls.push({ qitemId, target });
    return "failed:tmux session not found";
  };
  const tick = () => runWakeLadderTick({
    db, queueRepo: repo, attemptWake, resolveOrchestrator: () => "orch@r",
    retryIntervalSeconds: 300, retryCap: 3, unconfirmedWindowMinutes: 30, swapGraceSeconds: 180,
    log: (line: string) => lines.push(line),
  });
  const setTags = (qitemId: string, text: string) => db.prepare("UPDATE queue_items SET tags = ? WHERE qitem_id = ?").run(text, qitemId);
  const rawTags = (qitemId: string): string => (db.prepare("SELECT tags FROM queue_items WHERE qitem_id = ?").get(qitemId) as { tags: string }).tags;
  const markers = (qitemId: string, prefix: string): string[] =>
    (db.prepare("SELECT transition_note FROM queue_transitions WHERE qitem_id = ? ORDER BY ts, rowid").all(qitemId) as Array<{ transition_note: string | null }>)
      .map((row) => row.transition_note ?? "").filter((note) => note.startsWith(prefix));
  /** The write a truncated save leaves: the quoted link text survives, the JSON does not parse. */
  const truncated = (qitemId: string): string => rawTags(qitemId).slice(0, -1);

  /** A baton whose first wake failed long ago and whose retry cap is spent, so the next tick would escalate it. */
  async function spentBaton(dest: string): Promise<QueueItem> {
    const src = await repo.create({ sourceSession: "sender@r", destinationSession: "relay@r", body: "obligation" });
    const baton = (await repo.handoff({ qitemId: src.qitemId, fromSession: "relay@r", toSession: dest, nudge: false })).created;
    db.prepare("UPDATE queue_items SET last_nudge_attempt = ?, last_nudge_result = 'failed:tmux session not found' WHERE qitem_id = ?")
      .run(new Date(Date.now() - 120 * 60_000).toISOString(), baton.qitemId);
    for (let attempt = 1; attempt <= 3; attempt++) {
      repo.transitionLog.append({ qitemId: baton.qitemId, state: "pending", actorSession: "wake-ladder@system", transitionNote: `${LADDER_ATTEMPT_PREFIX} ${attempt}/3 outcome=failed:fixture` });
    }
    db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ? AND transition_note LIKE 'wake-attempt:%'")
      .run(new Date(Date.now() - 30 * 60_000).toISOString(), baton.qitemId);
    return baton;
  }
  const recoveryFor = (baton: QueueItem) =>
    repo.create({ sourceSession: "sender@r", destinationSession: "elsewhere@r", body: "recovery", nudge: false, tags: ["some-recovery", recoveryTag(baton.qitemId)] });

  it("findQueueRecovery finds an open recovery whose tags are damaged and says so; a readable one is unmarked", async () => {
    const baton = await spentBaton("worker@r");
    const recovery = await recoveryFor(baton);
    expect(findQueueRecovery(db, baton.qitemId), "control: readable").toEqual({ qitemId: recovery.qitemId, state: "pending" });

    setTags(recovery.qitemId, truncated(recovery.qitemId));

    expect(findQueueRecovery(db, baton.qitemId)).toEqual({ qitemId: recovery.qitemId, state: "pending", unreadable: true });
  });

  it("findQueueRecovery does not match a damaged row that merely carries another obligation's link", async () => {
    const baton = await spentBaton("worker@r");
    const other = await spentBaton("other@r");
    const recovery = await recoveryFor(other);
    setTags(recovery.qitemId, truncated(recovery.qitemId));
    expect(findQueueRecovery(db, baton.qitemId)).toBeNull();
    expect(findQueueRecovery(db, other.qitemId)?.qitemId).toBe(recovery.qitemId);
  });

  it("findQueueRecovery matches the whole quoted link, not a prefix of another obligation's id", async () => {
    const short = await repo.create({ qitemId: "obl-1", sourceSession: "sender@r", destinationSession: "worker@r", body: "short", nudge: false });
    const long = await repo.create({ qitemId: "obl-1x", sourceSession: "sender@r", destinationSession: "worker@r", body: "long", nudge: false });
    const recovery = await recoveryFor(long);
    setTags(recovery.qitemId, truncated(recovery.qitemId));
    expect(findQueueRecovery(db, short.qitemId), "obl-1 is not obl-1x").toBeNull();
    expect(findQueueRecovery(db, long.qitemId)?.qitemId).toBe(recovery.qitemId);
  });

  it("a readable OPEN recovery wins over a damaged one; a damaged one wins over a readable CLOSED one", async () => {
    const baton = await spentBaton("worker@r");
    const closed = await recoveryFor(baton);
    repo.update({ qitemId: closed.qitemId, actorSession: "elsewhere@r", state: "done", closureReason: "no-follow-on", transitionNote: "recovered" });
    const damagedOpen = await recoveryFor(baton);
    setTags(damagedOpen.qitemId, truncated(damagedOpen.qitemId));
    expect(findQueueRecovery(db, baton.qitemId), "damaged open beats a readable closed one").toEqual({ qitemId: damagedOpen.qitemId, state: "pending", unreadable: true });

    const readableOpen = await recoveryFor(baton);
    expect(findQueueRecovery(db, baton.qitemId), "a readable open recovery owns the continuation").toEqual({ qitemId: readableOpen.qitemId, state: "pending" });
  });

  it("the damaged-row lookup reads the partial tag index, like the readable one (migration 099)", async () => {
    const baton = await spentBaton("worker@r");
    const prepare = db.prepare.bind(db);
    const seen: string[] = [];
    const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => { if (sql.includes("NOT json_valid(tags)")) seen.push(sql); return prepare(sql); });
    try { findQueueRecovery(db, baton.qitemId); } finally { spy.mockRestore(); }
    expect(seen).toHaveLength(1);
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${seen[0]}`).all(recoveryTag(baton.qitemId)) as Array<{ detail: string }>).map((r) => r.detail).join(" | ");
    expect(plan).toContain("idx_queue_items_recovery_tags");
  });

  it("a CLOSED damaged recovery stops holding once the original changes after it (like a readable closed one)", async () => {
    const baton = await spentBaton("worker@r");
    const recovery = await recoveryFor(baton);
    repo.update({ qitemId: recovery.qitemId, actorSession: "elsewhere@r", state: "done", closureReason: "no-follow-on", transitionNote: "recovered by hand" });
    setTags(recovery.qitemId, truncated(recovery.qitemId));
    expect(findQueueRecovery(db, baton.qitemId), "control: still holds before the original changes").toMatchObject({ qitemId: recovery.qitemId, unreadable: true });

    // The original changes after the disposition: a meaningful owner transition dated well after the recovery closed.
    db.prepare("INSERT INTO queue_transitions(qitem_id,ts,state,actor_session,transition_note) VALUES (?,?,'pending','owner@r','actual owner change')")
      .run(baton.qitemId, new Date(Date.now() + 60 * 60_000).toISOString());

    expect(findQueueRecovery(db, baton.qitemId)).toBeNull();
  });

  it("readWakeLadderBackstop keeps the unreadable marker on the recovery it names", async () => {
    const src = await repo.create({ sourceSession: "sender@r", destinationSession: "relay@r", body: "obligation" });
    const baton = (await repo.handoff({ qitemId: src.qitemId, fromSession: "relay@r", toSession: "worker@r", nudge: false })).created;
    const recovery = await recoveryFor(baton);
    expect(readWakeLadderBackstop(db, baton.qitemId)?.recovery, "control: readable carries no marker").toEqual({ qitemId: recovery.qitemId, state: "pending" });

    setTags(recovery.qitemId, truncated(recovery.qitemId));

    expect(readWakeLadderBackstop(db, baton.qitemId)?.recovery).toEqual({ qitemId: recovery.qitemId, state: "pending", unreadable: true });
  });

  it("queueRecoveryOwnsWake: an open recovery with damaged tags still owns the continuation (the consumer does not deliver a second wake)", async () => {
    // A baton with no failed wake of its own: the recovery link is the ONLY thing that makes the answer true.
    const src = await repo.create({ sourceSession: "sender@r", destinationSession: "relay@r", body: "obligation" });
    const baton = (await repo.handoff({ qitemId: src.qitemId, fromSession: "relay@r", toSession: "worker@r", nudge: false })).created;
    expect(queueRecoveryOwnsWake(db, repo.getById(baton.qitemId)), "control: no recovery, no failed wake").toBe(false);
    const recovery = await recoveryFor(baton);
    expect(queueRecoveryOwnsWake(db, repo.getById(baton.qitemId)), "control: a readable recovery owns it").toBe(true);

    setTags(recovery.qitemId, truncated(recovery.qitemId));

    expect(queueRecoveryOwnsWake(db, repo.getById(baton.qitemId))).toBe(true);
  });

  it("the ladder tick leaves the original alone while its OPEN recovery is damaged: no wake, no rung, no aggregate; the row is named", async () => {
    const baton = await spentBaton("worker@r");
    const recovery = await recoveryFor(baton);
    setTags(recovery.qitemId, truncated(recovery.qitemId));
    const rowsBefore = (db.prepare("SELECT COUNT(*) AS n FROM queue_items").get() as { n: number }).n;

    const result = await tick();

    expect(result.outcome, lines.join("\n")).not.toBe("failed");
    expect(calls, "no wake on a guess").toEqual([]);
    expect(markers(baton.qitemId, LADDER_RUNG_PREFIX)).toEqual([]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM queue_items").get() as { n: number }).n, "no escalation aggregate was opened").toBe(rowsBefore);
    expect(lines).toContain(`[wake-ladder] ${recovery.qitemId} skipped: its saved tags is not readable JSON (repair or remove the row)`);
  });

  it("the ladder tick leaves the original alone while its CLOSED recovery is damaged, and names the row", async () => {
    const baton = await spentBaton("worker@r");
    const recovery = await recoveryFor(baton);
    repo.update({ qitemId: recovery.qitemId, actorSession: "elsewhere@r", state: "done", closureReason: "no-follow-on", transitionNote: "recovered by hand" });
    // Control: a readable closed recovery already owns the disposition, so the tick does nothing for the original.
    await tick();
    expect(calls, "control: readable closed recovery").toEqual([]);

    setTags(recovery.qitemId, truncated(recovery.qitemId));
    lines.length = 0;
    await tick();

    expect(calls).toEqual([]);
    expect(markers(baton.qitemId, LADDER_RUNG_PREFIX)).toEqual([]);
    expect(lines).toContain(`[wake-ladder] ${recovery.qitemId} skipped: its saved tags is not readable JSON (repair or remove the row)`);
  });
});

// The stuck-exception ensurer finds the exception item it already opened through findQueueRecovery (the packet is the
// obligation, the item carries recovery-for:<packet>). Damaged tags on that item made it "not there", and the next sweep opened
// a second exception item for the same occurrence.
describe("OF-143: the stuck-exception ensurer does not open a second item beside a damaged one", () => {
  const SPEC = `workflow:
  id: y1-stuck-pipeline
  version: 1
  objective: y1 fixture
  entry:
    role: producer
  roles:
    producer:
      preferred_targets:
        - producer@rig
    orch:
      preferred_targets:
        - orch-lead@rig
  steps:
    - id: produce
      actor_role: producer
      allowed_exits:
        - done
        - waiting
  exception_routing:
    orchestrator_role: orch
`;
  let db: Database.Database;
  let tmp: string;
  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("a second sweep over an occurrence whose exception item has damaged tags creates nothing", async () => {
    db = memoryDb();
    const bus = new EventBus(db);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')").run();
    const queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    queueRepo.attachOutbox(new OutboxHandler(db));
    const runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo });
    const watchdogJobsRepo = new WatchdogJobsRepository(db);
    const ensureLines: string[] = [];
    const ensurer = makeEnsureStuckExceptionItem({ db, queueRepo, log: (line: string) => ensureLines.push(line), resolveRoute: (n, v, c) => runtime.resolveExceptionRouteFor(n, v, c), humanFallbackSeat: "human@host" });
    tmp = mkdtempSync(join(tmpdir(), "y1-stuck-"));
    const specPath = join(tmp, "spec.yaml");
    writeFileSync(specPath, SPEC);
    const inst = await runtime.instantiate({ specPath, rootObjective: "stuck walk", createdBySession: "ops@rig" });
    const packetId = inst.instance.currentFrontier[0]!;
    db.prepare("UPDATE queue_items SET ts_created = ? WHERE qitem_id = ?")
      .run(new Date(Date.now() - (WORKFLOW_STEP_STUCK_THRESHOLD_SECONDS + 3600) * 1000).toISOString(), packetId);
    const lines: string[] = [];
    const sweep = () => runWorkflowBootSweep({
      log: (line: string) => lines.push(line),
      instanceStore: runtime.instanceStore, queueRepo, watchdogJobsRepo, ensureStuckExceptionItem: ensurer,
      reconcileStuckExceptions: () => runtime.reconcileStuckExceptions(),
    });
    const exceptionRows = () => db.prepare("SELECT qitem_id, tags FROM queue_items WHERE tags LIKE '%exception:stuck_overdue%'").all() as Array<{ qitem_id: string; tags: string }>;

    const first = await sweep();
    expect(first.exceptionItemsCreated, "control: the first sweep opens the one item").toBe(1);
    const [item] = exceptionRows();
    db.prepare("UPDATE queue_items SET tags = ? WHERE qitem_id = ?").run(item!.tags.slice(0, -1), item!.qitem_id);

    lines.length = 0;
    const second = await sweep();

    // The item id is derived from the packet, so a second create collides and the sweep logs it as a (non-fatal) ensure failure:
    // that line is the observable of "the damaged item was read as absent and a second one was attempted".
    expect(lines.filter((line) => line.includes("exception-item ensure failed")), lines.join("\n")).toEqual([]);
    expect(second.exceptionItemsCreated, "a damaged item is not an absent one").toBe(0);
    expect(ensureLines.filter((line) => line.includes(item!.qitem_id) && line.includes("not readable JSON")), "the damaged item is named").toHaveLength(1);
    expect(exceptionRows().map((row) => row.qitem_id)).toEqual([item!.qitem_id]);
  });
});

// ───────────────────────────── OF-143: the restore attempt receipt ─────────────────────────────

describe("OF-143: one damaged reconciliation event of another attempt does not refuse this attempt's receipt", () => {
  let db: Database.Database;
  let events: EventBus;
  beforeEach(() => {
    db = memoryDb();
    events = new EventBus(db);
  });
  afterEach(() => db.close());

  const result = (snapshotId: string, status: "failed" | "attention_required" | "resumed") => ({
    snapshotId, preRestoreSnapshotId: null, rigResult: "partially_restored" as const, warnings: [] as string[],
    nodes: [{ nodeId: "n1", logicalId: "lead", status: "resumed" as const }, { nodeId: "n2", logicalId: "worker", status }],
  });
  const roster = [{ nodeId: "n1", logicalId: "lead" }, { nodeId: "n2", logicalId: "worker" }];
  function attempt(snapshotId: string): number {
    const started = events.emit({ type: "restore.started", rigId: "rig-1", snapshotId, intendedRoster: roster });
    events.emit({ type: "restore.completed", rigId: "rig-1", snapshotId, result: result(snapshotId, "attention_required") });
    return started.seq;
  }
  function reconcile(attemptId: number): number {
    return events.emit({
      type: "restore.outcome_reconciled", rigId: "rig-1", nodeId: "n2", attemptId,
      from: "attention_required", to: "operator_recovered",
      evidence: { tmux: true, fgProcess: "codex", resumeTokenUsed: true, paneState: "usable" },
    }).seq;
  }
  const damage = (seq: number) => db.prepare("UPDATE events SET payload = ? WHERE seq = ?").run(NOT_JSON, seq);

  it("an OLDER attempt's damaged event: the later attempt's receipt is still derived, with its own reconciliation", () => {
    const first = attempt("s1");
    const firstReconciled = reconcile(first);
    const second = attempt("s2");
    reconcile(second);
    expect(deriveRestoreAttemptReceipt(db, "rig-1", second), "control: nothing damaged").toMatchObject({ ok: true });

    damage(firstReconciled);
    const receipt = deriveRestoreAttemptReceipt(db, "rig-1", second);

    expect(receipt.ok, JSON.stringify(receipt)).toBe(true);
    if (!receipt.ok) return;
    expect(receipt.reconciliations).toHaveLength(1);
    expect(receipt.unresolvedIntendedSeats).toEqual([]);
  });

  it("a LATER attempt's damaged event: the earlier attempt's receipt is still derived", () => {
    const first = attempt("s1");
    reconcile(first);
    const second = attempt("s2");
    const secondReconciled = reconcile(second);

    damage(secondReconciled);
    const receipt = deriveRestoreAttemptReceipt(db, "rig-1", first);

    expect(receipt.ok, JSON.stringify(receipt)).toBe(true);
    if (!receipt.ok) return;
    expect(receipt.reconciliations).toHaveLength(1);
  });

  it("a damaged event written DURING this attempt refuses by name: the seat is not reported unresolved on a guess", () => {
    const first = attempt("s1");
    const reconciled = reconcile(first);
    damage(reconciled);

    const receipt = deriveRestoreAttemptReceipt(db, "rig-1", first);

    expect(receipt.ok).toBe(false);
    if (receipt.ok) return;
    expect(receipt.code).toBe("attempt_corrupt");
    expect(receipt.message).toContain(`events row ${reconciled}`);
    expect(receipt.message).toContain("restore.outcome_reconciled");
  });
});

// ───────────────────────────── OF-147: a blocker whose tags carry no pool identity ─────────────────────────────

describe("OF-147: a usage-limit blocker whose tags are overwritten is still the pool's blocker", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let lines: string[];
  const now = new Date();
  const reset = new Date(now.getTime() + 15 * 60_000).toISOString();
  const staleAfter = new Date(now.getTime() + 30 * 60_000).toISOString();

  beforeEach(() => {
    db = memoryDb();
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    repo.attachWatchdogJobsRepository(new WatchdogJobsRepository(db, () => now));
    lines = [];
  });
  afterEach(() => db.close());

  const model = (seats: string[]) => async () => ({
    bindings: [],
    signals: seats.map((seatSession) => ({
      provider: "claude" as const, seatSession, sourceClass: "provider_statusline" as const, authority: "account_cross_device" as const,
      window: "five_hour", usedPercent: 100, resetsAt: reset, asOf: now.toISOString(), staleAfter, supportsNotification: false,
      automationUse: "allow_switch_decision" as const,
    })),
  });
  const tick = (seats: string[]) => runWakeLadderTick({
    db, queueRepo: repo, attemptWake: async () => "failed:provider usage limit", resolveOrchestrator: () => "orch@r",
    retryIntervalSeconds: 300, retryCap: 3, unconfirmedWindowMinutes: 30, swapGraceSeconds: 180,
    log: (line: string) => lines.push(line), now, usageLimitJitterSeconds: 0, getProviderReadModel: model(seats),
  });
  const limited = async (dest: string) => {
    const src = await repo.create({ sourceSession: "sender@r", destinationSession: "relay@r", body: "obligation" });
    const baton = (await repo.handoff({ qitemId: src.qitemId, fromSession: "relay@r", toSession: dest, nudge: false })).created;
    repo.recordNudgeAttempt(baton.qitemId, "failed:provider usage limit");
    return baton;
  };
  const ladderBlockers = () => db.prepare("SELECT qitem_id FROM queue_items WHERE source_session = 'wake-ladder@system' AND body LIKE 'Provider usage limit for %'").all() as Array<{ qitem_id: string }>;

  it("tags overwritten with nothing recognizable: no second blocker, the late seat waits, the blocker is named", async () => {
    await limited("dev-a@r");
    await tick(["dev-a@r"]);
    const [blocker] = ladderBlockers();
    expect(blocker, "the first tick opened the shared blocker").toBeDefined();
    db.prepare("UPDATE queue_items SET tags = ? WHERE qitem_id = ?").run(NOT_JSON, blocker!.qitem_id);
    const late = await limited("dev-c@r");
    lines.length = 0;

    const result = await tick(["dev-a@r", "dev-c@r"]);

    expect(result.outcome, lines.join("\n")).not.toBe("failed");
    expect(ladderBlockers().map((row) => row.qitem_id), "no second blocker beside the unreadable one").toEqual([blocker!.qitem_id]);
    expect(repo.getById(late.qitemId)!.state, "the seat is not parked on a guess").toBe("pending");
    expect(lines.some((line) => line.includes(`usage-limit blocker ${blocker!.qitem_id}`) && line.includes("tags that is not readable JSON"))).toBe(true);
  });

  it("tags overwritten with a READABLE list that names no pool: still the pool's one blocker; the late seat parks on it", async () => {
    await limited("dev-a@r");
    await tick(["dev-a@r"]);
    const [blocker] = ladderBlockers();
    db.prepare("UPDATE queue_items SET tags = '[]' WHERE qitem_id = ?").run(blocker!.qitem_id);
    const late = await limited("dev-c@r");

    const result = await tick(["dev-a@r", "dev-c@r"]);

    expect(result.outcome, lines.join("\n")).not.toBe("failed");
    expect(ladderBlockers().map((row) => row.qitem_id), "no second blocker beside the overwritten one").toEqual([blocker!.qitem_id]);
    expect(repo.getById(late.qitemId)).toMatchObject({ state: "blocked", blockedOn: blocker!.qitem_id });
  });

  it("a damaged row for ANOTHER pool whose key merely starts the same does not stand in for this pool's blocker", async () => {
    // Pool key is claude:local; a damaged blocker of pool claude:local2 begins "Provider usage limit for claude:local2; ".
    await repo.create({
      qitemId: "other-pool-blocker", sourceSession: "wake-ladder@system", destinationSession: "wake-ladder@r",
      body: "Provider usage limit for claude:local2; release every dependent once at later.", nudge: false,
      tags: [USAGE_LIMIT_BLOCKER_TAG, "usage-limit-pool:claude:local2"],
    });
    db.prepare("UPDATE queue_items SET tags = ? WHERE qitem_id = 'other-pool-blocker'").run(NOT_JSON);
    const baton = await limited("dev-a@r");

    const result = await tick(["dev-a@r"]);

    expect(result.outcome, lines.join("\n")).not.toBe("failed");
    expect(ladderBlockers().filter((row) => row.qitem_id !== "other-pool-blocker"), "this pool opened its own blocker").toHaveLength(1);
    expect(repo.getById(baton.qitemId)!.state).toBe("blocked");
  });

  it("a damaged row with the same words but not written by the ladder is not its blocker", async () => {
    await repo.create({
      qitemId: "lookalike", sourceSession: "someone@r", destinationSession: "wake-ladder@r",
      body: "Provider usage limit for claude:local; release every dependent once at later.", nudge: false,
    });
    db.prepare("UPDATE queue_items SET tags = ? WHERE qitem_id = 'lookalike'").run(NOT_JSON);
    const baton = await limited("dev-a@r");

    await tick(["dev-a@r"]);

    expect(repo.getById(baton.qitemId)!.state).toBe("blocked");
    expect(db.prepare("SELECT COUNT(*) AS n FROM queue_items WHERE source_session = 'wake-ladder@system' AND body LIKE 'Provider usage limit for claude:local; %'").get()).toEqual({ n: 1 });
  });
});

// ───────────────────────────── OF-146: daemon-side markers ─────────────────────────────

describe("OF-146: a damaged saved column is marked in the daemon's displays, not read as an ordinary empty one", () => {
  let db: Database.Database;
  let dir: string;
  beforeEach(() => {
    db = memoryDb();
    dir = mkdtempSync(join(tmpdir(), "y1-"));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function instance(id: string, frontierText: string, status = "active"): void {
    db.prepare(
      `INSERT INTO workflow_instances (instance_id, workflow_name, workflow_version, created_by_session, created_at, status, current_frontier_json, current_step_id, hop_count)
       VALUES (?, 'conveyor', '1', 'creator@r', '2026-05-04T00:00:00.000Z', ?, ?, 'step-1', 0)`,
    ).run(id, status, frontierText);
  }

  describe("review/gather.ts: the rig review's workflow band", () => {
    const NOW = "2026-07-11T12:00:00.000Z";
    const band = () => {
      const indexer = new SliceIndexer({ slicesRoot: dir, additionalSliceRoots: [], dogfoodEvidenceRoot: null, db });
      return new ReviewGatherer({ db, indexer, gitRepoPath: null, now: () => NOW }).composeRig().needsYou.items;
    };

    it.each([
      ["malformed JSON", NOT_JSON],
      ["valid JSON that is not a list", '{"a":1}'],
      ["a list holding a non-string", "[1]"],
    ])("an active instance whose frontier is %s is named in the band, not absent from it", (_name, text) => {
      instance("inst-damaged", text);
      const items = band();
      const row = items.find((item) => item.workflow?.instanceId === "inst-damaged");
      expect(row, JSON.stringify(items)).toBeDefined();
      expect(row!.derived?.kind).toBe("anomaly");
      expect(row!.derived?.evidence).toContain("current_frontier_json");
      expect(row!.derived?.evidence).toContain("inst-damaged");
    });

    it("control: a readable healthy instance adds no row", () => {
      instance("inst-fine", "[]");
      expect(band().filter((item) => item.workflow?.instanceId === "inst-fine")).toEqual([]);
    });
  });

  describe("queue-transition-log.ts: the RECENT list", () => {
    let repo: QueueRepository;
    beforeEach(() => {
      repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    });
    let nextTransitionId = 1;
    function blockedItem(id: string, tagsText: string): void {
      db.prepare(
        `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, tags, body)
         VALUES (?, '2026-09-03T20:00:00.000Z', '2026-09-03T20:00:00.000Z', 'sender@r', 'owner@r', 'in-progress', 'routine', ?, 'b')`,
      ).run(id, tagsText);
      for (const state of ["pending", "in-progress"]) {
        const n = nextTransitionId++;
        db.prepare("INSERT INTO queue_transitions (transition_id, qitem_id, ts, state, actor_session) VALUES (?, ?, ?, ?, 'owner@r')")
          .run(n, id, `2026-09-03T20:${String(n).padStart(2, "0")}:00.000Z`, state);
      }
    }

    it.each([
      ["malformed JSON", NOT_JSON],
      ["a list holding a non-string", '["slice:s1", 7]'],
    ])("an item whose tags are %s is listed with unreadable: ['tags']; a readable untagged one is not", (_name, text) => {
      blockedItem("q-bad", text);
      blockedItem("q-plain", "[]");
      blockedItem("q-slice", '["slice:s1"]');

      const recent = repo.listRecentTransitions("r");

      const bad = recent.find((row) => row.qitemId === "q-bad");
      expect(bad, JSON.stringify(recent)).toBeDefined();
      expect(bad).toMatchObject({ targetKind: "qitem", target: "q-bad", unreadable: ["tags"] });
      expect(recent.find((row) => row.qitemId === "q-plain")).not.toHaveProperty("unreadable");
      expect(recent.find((row) => row.qitemId === "q-slice")).toMatchObject({ targetKind: "slice", target: "s1" });
      expect(recent.find((row) => row.qitemId === "q-slice")).not.toHaveProperty("unreadable");
    });
  });

  describe("slice-workflow-binding.ts: the slice's workflow binding", () => {
    it.each([
      ["malformed JSON that still carries the id", '{not json "q-1"'],
      ["valid JSON that is not a list of strings", '[1, "q-1"]'],
    ])("an instance whose frontier is %s binds with currentFrontier [] AND unreadable: ['current_frontier_json']", (_name, text) => {
      // The live-frontier signal matches on the column text, so a damaged column that still carries the id still binds.
      instance("inst-1", text);

      const { primary } = findSliceWorkflowBinding(db, ["q-1"]);

      expect(primary?.instanceId).toBe("inst-1");
      expect(primary?.currentFrontier).toEqual([]);
      expect(primary?.unreadable).toEqual(["current_frontier_json"]);
    });

    it("the slice detail payload carries the marker through to the API", () => {
      mkdirSync(join(dir, "alpha"), { recursive: true });
      writeFileSync(join(dir, "alpha", "README.md"), "---\nstatus: active\nqitems:\n  - q-9\n---\n# alpha");
      db.prepare("INSERT OR IGNORE INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, body) VALUES ('q-9', '2026-05-04T00:00:00.000Z', '2026-05-04T00:00:00.000Z', 'src@r', 'dst@r', 'in-progress', 'routine', 'alpha work')").run();
      instance("inst-9", '{not json "q-9"');
      const indexer = new SliceIndexer({ slicesRoot: dir, additionalSliceRoots: [], dogfoodEvidenceRoot: null, db });

      const payload = new SliceDetailProjector({ db, indexer }).project(indexer.get("alpha")!);

      expect(payload.workflowBinding).toMatchObject({ instanceId: "inst-9", currentFrontier: [], unreadable: ["current_frontier_json"] });
    });

    it("control: a readable frontier carries no marker", () => {
      instance("inst-2", '["q-2"]');
      const { primary } = findSliceWorkflowBinding(db, ["q-2"]);
      expect(primary?.currentFrontier).toEqual(["q-2"]);
      expect(primary).not.toHaveProperty("unreadable");
    });
  });
});
