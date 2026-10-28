// z4 "damaged-row family IV" (OF-159). The rule since OF-117: a listing marks the damaged row, a decision read refuses it by name, a
// sweep names the row and skips it, and an unreadable row is NEVER read as absent and then acted on. OF-159 listed candidates;
// each row below damages ONE input of ONE site, so each guard fails on its own:
//   - workflow show listed an instance's exception items through a json_valid scan, so a damaged item was not listed at all;
//   - the stuck-exception reconcile and the redrive's close of an occurrence's exception items skipped a damaged item unnamed;
//   - the stuck-exception ensurer's historical-item lookup parsed tags, so a damaged historical item read as "none" and a second
//     item was opened beside it;
//   - the prompt ladder's closed-disposition check parsed tags, so a damaged closed alert read as "no disposition" and the alert was
//     opened again for an episode already closed; and a damaged open aggregate was skipped unnamed by the retire pass.
// Production consequence, in the names: a damaged saved row names itself and waits for repair; it is never "no obligation",
// "no disposition" or "not there".
//
// Deployed entrypoints: routes/workflow.ts GET /:instance_id calls WorkflowRuntime.exceptionObligations; startup.ts wires
// reconcileStuckExceptions (boot sweep, keepalive policy, project()) and makeEnsureStuckExceptionItem; WorkflowRuntime.resume
// reaches closeFailureExceptions; startup.ts runs runWakeLadderTick (scheduler).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { runWorkflowBootSweep } from "../src/domain/workflow-boot-sweep.js";
import { makeEnsureStuckExceptionItem } from "../src/domain/workflow-exception-escalation.js";
import { WORKFLOW_STEP_STUCK_THRESHOLD_SECONDS } from "../src/domain/workflow-deadline.js";
import { REFUSED_PREFIX } from "../src/domain/policies/parked-owner-consumer.js";
import { runWakeLadderTick } from "../src/domain/queue-wake-ladder.js";
import { findDamagedTagRows } from "../src/domain/damaged-tag-rows.js";

const NOT_JSON = "{not json";

function memoryDb(): Database.Database {
  const db = new Database(":memory:");
  migrate(db, ALL_MIGRATIONS);
  return db;
}
const rawTags = (db: Database.Database, qitemId: string): string => (db.prepare("SELECT tags FROM queue_items WHERE qitem_id = ?").get(qitemId) as { tags: string }).tags;
/** The write a truncated save leaves: the quoted tag text survives, the JSON does not parse. */
const truncate = (db: Database.Database, qitemId: string): void => {
  db.prepare("UPDATE queue_items SET tags = ? WHERE qitem_id = ?").run(rawTags(db, qitemId).slice(0, -1), qitemId);
};
const stateOf = (db: Database.Database, qitemId: string): string => (db.prepare("SELECT state FROM queue_items WHERE qitem_id = ?").get(qitemId) as { state: string }).state;

describe("findDamagedTagRows", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  beforeEach(() => {
    db = memoryDb();
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
  });
  afterEach(() => db.close());
  const make = (id: string, tags: string[]) => repo.create({ qitemId: id, sourceSession: "s@r", destinationSession: "d@r", body: id, nudge: false, tags });

  it("finds damaged rows by the whole quoted tag, not a prefix; a readable row and a row missing one tag are not found", async () => {
    const hit = await make("hit", ["a", "instance:i1"]);
    const prefix = await make("prefix", ["a", "instance:i10"]);
    const missing = await make("missing", ["a"]);
    const readable = await make("readable", ["a", "instance:i1"]);
    for (const row of [hit, prefix, missing]) truncate(db, row.qitemId);
    expect(readable.qitemId).toBe("readable");
    expect(findDamagedTagRows(db, { tags: ["a", "instance:i1"] }).map((r) => r.qitemId)).toEqual(["hit"]);
  });

  it("honours `without` and `states`", async () => {
    const plain = await make("plain", ["a"]);
    const linked = await make("linked", ["a", "recovery-for:x"]);
    const closed = await make("closed", ["a"]);
    db.prepare("UPDATE queue_items SET state = 'done' WHERE qitem_id = ?").run(closed.qitemId);
    for (const row of [plain, linked, closed]) truncate(db, row.qitemId);
    expect(findDamagedTagRows(db, { tags: ["a"], without: "recovery-for:x" }).map((r) => r.qitemId).sort()).toEqual(["closed", "plain"]);
    expect(findDamagedTagRows(db, { tags: ["a"], states: ["pending"] }).map((r) => r.qitemId).sort()).toEqual(["linked", "plain"]);
  });
});

describe("OF-159: workflow runtime exception items", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let runtime: WorkflowRuntime;
  let errors: string[];
  beforeEach(() => {
    db = memoryDb();
    const bus = new EventBus(db);
    repo = new QueueRepository(db, bus, { validateRig: () => true });
    repo.attachOutbox(new OutboxHandler(db));
    runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo: repo });
    errors = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(" ")); });
  });
  afterEach(() => { vi.restoreAllMocks(); db.close(); });

  const exceptionTags = (instance: string, packet: string, extra: string[] = []) =>
    ["workflow-exception", "exception:stuck_overdue", `instance:${instance}`, `occurrence:${packet}`, "workflow:wf", ...extra];
  const item = (id: string, tags: string[]) => repo.create({ qitemId: id, sourceSession: "ops@r", destinationSession: "owner@r", body: id, nudge: false, tags });

  describe("exceptionObligations (workflow show)", () => {
    it("control: readable items are listed in creation order with their owner and state, unmarked", async () => {
      await item("ex-b", exceptionTags("i1", "p2"));
      await item("ex-a", exceptionTags("i1", "p1"));
      await item("ex-other", exceptionTags("i2", "p1"));
      const listed = runtime.exceptionObligations("i1");
      expect(listed.map((o) => o.qitemId)).toEqual(["ex-b", "ex-a"]);
      expect(listed[0]).toMatchObject({ ownerSession: "owner@r", state: "pending", inspectCommand: "rig queue show ex-b --full --json" });
      expect(listed.some((o) => "unreadable" in o)).toBe(false);
    });

    it("an item whose tags are not JSON is listed, marked unreadable, between its readable neighbours (not left out)", async () => {
      await item("ex-1", exceptionTags("i1", "p1"));
      await item("ex-2", exceptionTags("i1", "p2"));
      await item("ex-3", exceptionTags("i1", "p3"));
      for (const [n, ts] of [["ex-1", "2026-01-01T00:00:01.000Z"], ["ex-2", "2026-01-01T00:00:02.000Z"], ["ex-3", "2026-01-01T00:00:03.000Z"]] as const) {
        db.prepare("UPDATE queue_items SET ts_created = ? WHERE qitem_id = ?").run(ts, n);
      }
      truncate(db, "ex-2");
      const listed = runtime.exceptionObligations("i1");
      expect(listed.map((o) => o.qitemId)).toEqual(["ex-1", "ex-2", "ex-3"]);
      expect(listed[1]).toEqual({ qitemId: "ex-2", unreadable: ["tags"], inspectCommand: "rig queue show ex-2 --full --json" });
      expect(listed[0]).not.toHaveProperty("unreadable");
      expect(listed[2]).not.toHaveProperty("unreadable");
    });

    it("an item whose tags are valid JSON of the wrong shape is marked too, and does not end the listing", async () => {
      await item("ex-ok", exceptionTags("i1", "p1"));
      await item("ex-shape", exceptionTags("i1", "p2"));
      db.prepare("UPDATE queue_items SET tags = ? WHERE qitem_id = ?").run(JSON.stringify({ a: "workflow-exception", b: "instance:i1" }), "ex-shape");
      const listed = runtime.exceptionObligations("i1");
      expect(listed.map((o) => o.qitemId).sort()).toEqual(["ex-ok", "ex-shape"]);
      expect(listed.find((o) => o.qitemId === "ex-shape")).toMatchObject({ unreadable: ["tags"] });
      expect(listed.find((o) => o.qitemId === "ex-ok")).not.toHaveProperty("unreadable");
    });

    it("a damaged item of ANOTHER instance is not listed under this one", async () => {
      await item("ex-i2", exceptionTags("i2", "p1"));
      truncate(db, "ex-i2");
      expect(runtime.exceptionObligations("i1")).toEqual([]);
      expect(runtime.exceptionObligations("i2").map((o) => o.qitemId)).toEqual(["ex-i2"]);
    });
  });

  describe("reconcileStuckExceptions", () => {
    it("names a stuck-exception item whose tags are not JSON, leaves it open and untouched; a control pass names nothing", async () => {
      await item("ex-1", exceptionTags("i1", "p1"));
      runtime.reconcileStuckExceptions("i1");
      expect(errors.filter((line) => line.includes("ex-1")), "control: readable item, nothing to name").toEqual([]);

      truncate(db, "ex-1");
      const before = db.prepare("SELECT * FROM queue_items WHERE qitem_id = 'ex-1'").get();
      runtime.reconcileStuckExceptions("i1");
      expect(errors.filter((line) => line.includes("ex-1") && line.includes("not readable JSON")), errors.join("\n")).toHaveLength(1);
      expect(db.prepare("SELECT * FROM queue_items WHERE qitem_id = 'ex-1'").get()).toEqual(before);
      expect(stateOf(db, "ex-1")).toBe("pending");
    });

    it("the whole-queue pass (boot sweep) names it as well, and a damaged item of another instance is not named by a per-instance pass", async () => {
      await item("ex-1", exceptionTags("i1", "p1"));
      await item("ex-2", exceptionTags("i2", "p1"));
      truncate(db, "ex-1");
      truncate(db, "ex-2");
      runtime.reconcileStuckExceptions("i1");
      expect(errors.some((line) => line.includes("ex-1"))).toBe(true);
      expect(errors.some((line) => line.includes("ex-2"))).toBe(false);
      errors.length = 0;
      runtime.reconcileStuckExceptions();
      expect(errors.some((line) => line.includes("ex-1"))).toBe(true);
      expect(errors.some((line) => line.includes("ex-2"))).toBe(true);
    });

    it("a CLOSED damaged stuck-exception item is not named (only open items wait on a recheck)", async () => {
      await item("ex-1", exceptionTags("i1", "p1"));
      db.prepare("UPDATE queue_items SET state = 'done' WHERE qitem_id = 'ex-1'").run();
      truncate(db, "ex-1");
      runtime.reconcileStuckExceptions("i1");
      expect(errors).toEqual([]);
    });

    it("an item whose tags are valid JSON but not a list is named, not skipped silently", async () => {
      await item("ex-1", exceptionTags("i1", "p1"));
      db.prepare("UPDATE queue_items SET tags = ? WHERE qitem_id = ?").run(JSON.stringify({ a: "workflow-exception", b: "exception:stuck_overdue", c: "instance:i1" }), "ex-1");
      runtime.reconcileStuckExceptions("i1");
      expect(errors.filter((line) => line.includes("ex-1") && line.includes("not a list of tags")), errors.join("\n")).toHaveLength(1);
      expect(stateOf(db, "ex-1")).toBe("pending");
    });
  });

  describe("closeFailureExceptions (redrive of a failed occurrence)", () => {
    const close = (instanceId: string, packetId: string): number =>
      db.transaction(() => runtime["closeFailureExceptions"](instanceId, packetId, "step-1", { actorSession: "ops@r" }, () => {}))();

    it("closes the occurrence's readable item and names a damaged one for the same occurrence, which stays open", async () => {
      await item("ex-ok", exceptionTags("i1", "p1"));
      await item("ex-bad", exceptionTags("i1", "p1"));
      truncate(db, "ex-bad");
      expect(close("i1", "p1")).toBe(1);
      expect(stateOf(db, "ex-ok")).toBe("done");
      expect(stateOf(db, "ex-bad")).toBe("pending");
      expect(errors.filter((line) => line.includes("ex-bad") && line.includes("not readable JSON")), errors.join("\n")).toHaveLength(1);
      expect(errors.some((line) => line.includes("ex-ok"))).toBe(false);
    });

    it("does not name a damaged item of another occurrence or instance", async () => {
      await item("ex-other-occ", exceptionTags("i1", "p2"));
      await item("ex-other-inst", exceptionTags("i2", "p1"));
      truncate(db, "ex-other-occ");
      truncate(db, "ex-other-inst");
      expect(close("i1", "p1")).toBe(0);
      expect(errors).toEqual([]);
    });
  });
});

// The stuck-exception ensurer: a HISTORICAL item (no recovery-for link; found by occurrence/instance/workflow tags) with damaged tags.
describe("OF-159: the stuck-exception ensurer does not open a second item beside a damaged historical one", () => {
  const SPEC = `workflow:
  id: z4-stuck-pipeline
  version: 1
  objective: z4 fixture
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

  async function setup() {
    db = memoryDb();
    const bus = new EventBus(db);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')").run();
    const queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    queueRepo.attachOutbox(new OutboxHandler(db));
    const runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo });
    const watchdogJobsRepo = new WatchdogJobsRepository(db);
    const ensureLines: string[] = [];
    const ensurer = makeEnsureStuckExceptionItem({ db, queueRepo, log: (line: string) => ensureLines.push(line), resolveRoute: (n, v, c) => runtime.resolveExceptionRouteFor(n, v, c), humanFallbackSeat: "human@host" });
    tmp = mkdtempSync(join(tmpdir(), "z4-stuck-"));
    const specPath = join(tmp, "spec.yaml");
    writeFileSync(specPath, SPEC);
    /** A second run of the same workflow whose first packet is overdue. */
    const addOverdueInstance = async (): Promise<string> => {
      const inst = await runtime.instantiate({ specPath, rootObjective: "stuck walk", createdBySession: "ops@rig" });
      const id = inst.instance.currentFrontier[0]!;
      db.prepare("UPDATE queue_items SET ts_created = ? WHERE qitem_id = ?")
        .run(new Date(Date.now() - (WORKFLOW_STEP_STUCK_THRESHOLD_SECONDS + 3600) * 1000).toISOString(), id);
      return id;
    };
    const packetId = await addOverdueInstance();
    const lines: string[] = [];
    const sweep = () => runWorkflowBootSweep({
      log: (line: string) => lines.push(line),
      instanceStore: runtime.instanceStore, queueRepo, watchdogJobsRepo, ensureStuckExceptionItem: ensurer,
      reconcileStuckExceptions: () => runtime.reconcileStuckExceptions(),
    });
    const exceptionRows = () => db.prepare("SELECT qitem_id, tags FROM queue_items WHERE tags LIKE '%exception:stuck_overdue%'").all() as Array<{ qitem_id: string; tags: string }>;
    return { sweep, lines, ensureLines, exceptionRows, queueRepo, packetId, addOverdueInstance };
  }
  /** Rewrite the item the first sweep opened into the historical form: same tags, no recovery-for link. */
  function makeHistorical(row: { qitem_id: string; tags: string }): void {
    const tags = (JSON.parse(row.tags) as string[]).filter((tag) => !tag.startsWith("recovery-for:"));
    db.prepare("UPDATE queue_items SET tags = ? WHERE qitem_id = ?").run(JSON.stringify(tags), row.qitem_id);
  }

  it("control: a READABLE historical item is the occurrence's item, so a second sweep opens nothing", async () => {
    const { sweep, exceptionRows } = await setup();
    expect((await sweep()).exceptionItemsCreated).toBe(1);
    makeHistorical(exceptionRows()[0]!);
    expect((await sweep()).exceptionItemsCreated).toBe(0);
    expect(exceptionRows()).toHaveLength(1);
  });

  // The damaged lookup must not widen the readable one: a modern item (recovery-for link) is the occurrence's item only while its
  // closed disposition is current (findQueueRecovery). Once the packet moved after it closed, a new episode opens a NEW item.
  it("a damaged item with a recovery link whose closed disposition is stale does not suppress a new episode's item", async () => {
    const { sweep, exceptionRows, queueRepo, packetId } = await setup();
    expect((await sweep()).exceptionItemsCreated).toBe(1);
    const [first] = exceptionRows();
    await queueRepo.update({ qitemId: first!.qitem_id, actorSession: "ops@rig", state: "done", closureReason: "no-follow-on" });
    truncate(db, first!.qitem_id);
    queueRepo.transitionLog.append({ qitemId: packetId, state: "pending", actorSession: "agent@rig", transitionNote: "the packet moved after the item closed" });

    expect((await sweep()).exceptionItemsCreated, "the stale damaged disposition does not hold the new episode").toBe(1);
    expect(exceptionRows()).toHaveLength(2);
  });

  it("a damaged historical item belongs to ITS occurrence only: another run of the same workflow still opens its own item", async () => {
    const { sweep, ensureLines, exceptionRows, addOverdueInstance } = await setup();
    expect((await sweep()).exceptionItemsCreated).toBe(1);
    const [first] = exceptionRows();
    makeHistorical(first!);
    truncate(db, first!.qitem_id);
    await addOverdueInstance();

    const second = await sweep();

    expect(second.exceptionItemsCreated, "the other run's packet is not covered by the first run's damaged item").toBe(1);
    expect(exceptionRows()).toHaveLength(2);
    expect(ensureLines.filter((line) => line.includes(first!.qitem_id) && line.includes("not readable JSON"))).toHaveLength(1);
  });

  it("a historical item whose tags are damaged is not 'no item': a second sweep creates nothing and names it", async () => {
    const { sweep, lines, ensureLines, exceptionRows } = await setup();
    expect((await sweep()).exceptionItemsCreated, "control: the first sweep opens the one item").toBe(1);
    const [item] = exceptionRows();
    makeHistorical(item!);
    truncate(db, item!.qitem_id);

    lines.length = 0;
    const second = await sweep();

    expect(lines.filter((line) => line.includes("exception-item ensure failed")), lines.join("\n")).toEqual([]);
    expect(second.exceptionItemsCreated, "a damaged item is not an absent one").toBe(0);
    expect(ensureLines.filter((line) => line.includes(item!.qitem_id) && line.includes("not readable JSON")), "the damaged item is named").toHaveLength(1);
    expect(exceptionRows().map((row) => row.qitem_id)).toEqual([item!.qitem_id]);
  });
});

// The prompt ladder: a closed alert (the founder's disposition for a refused-prompt episode) whose tags are damaged.
describe("OF-159: the prompt ladder does not reopen a closed alert's episode, and names a damaged open alert", () => {
  const seat = "worker@fixture";
  let db: Database.Database;
  let repo: QueueRepository;
  let lines: string[];
  let wakes: string[];
  beforeEach(() => {
    db = memoryDb();
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    lines = [];
    wakes = [];
  });
  afterEach(() => db.close());

  /** A pending baton the parked-owner policy already refused at an interactive prompt (the persisted specimen of
   *  prompt-clear-continuation.test.ts). */
  async function refusedBaton(): Promise<string> {
    const source = await repo.create({ sourceSession: "sender@fixture", destinationSession: "relay@fixture", body: "same work", nudge: false });
    const baton = (await repo.handoff({ qitemId: source.qitemId, fromSession: "relay@fixture", toSession: seat, nudge: false })).created;
    const key = `${seat}|fixture#1`;
    for (const transitionNote of [`parked-owner wake reserved: ${key}; obligations ${baton.qitemId}`, `${REFUSED_PREFIX} ${key}; Refused: interactive prompt`]) {
      repo.transitionLog.append({ qitemId: baton.qitemId, state: "pending", actorSession: "watchdog@system", transitionNote });
    }
    repo.recordNudgeAttempt(baton.qitemId, "failed:fixture");
    return baton.qitemId;
  }
  const tick = (promptState: "blocked" | "clear") => runWakeLadderTick({
    db, queueRepo: repo, resolveOrchestrator: () => null, readPromptState: () => promptState,
    retryIntervalSeconds: 60, now: new Date(Date.now() + 120_000),
    deliveryEngine: { dispatchEscalation: async () => ({ decision: "undeliverable:no-registered-human", resolved: false }) },
    attemptWake: async (qitemId, target) => { wakes.push(`${qitemId}->${target}`); return "failed:fixture"; },
    log: (line: string) => lines.push(line),
  });
  const alerts = (states: string[]) => (db.prepare(`SELECT qitem_id, state FROM queue_items WHERE state IN (${states.map(() => "?").join(",")})
    AND tags LIKE '%"wake-prompt-refusal"%'`).all(...states) as Array<{ qitem_id: string; state: string }>);
  const OPEN = ["pending", "in-progress", "blocked"];

  it("control: an alert closed by hand with READABLE tags is not reopened for the same episode", async () => {
    await refusedBaton();
    await tick("blocked");
    const [alert] = alerts(OPEN);
    expect(alert, "the first tick opens the alert").toBeDefined();
    await repo.update({ qitemId: alert!.qitem_id, actorSession: "ops@fixture", state: "done", closureReason: "no-follow-on" });
    await tick("blocked");
    expect(alerts(OPEN)).toEqual([]);
  });

  it("a closed alert whose tags are damaged still closes its episode: no second alert is opened, and the row is named", async () => {
    await refusedBaton();
    await tick("blocked");
    const [alert] = alerts(OPEN);
    await repo.update({ qitemId: alert!.qitem_id, actorSession: "ops@fixture", state: "done", closureReason: "no-follow-on" });
    truncate(db, alert!.qitem_id);

    lines.length = 0;
    await tick("blocked");

    expect(alerts(OPEN), "a damaged disposition is not an absent one").toEqual([]);
    // The ladder's other readers may name the row in their own words; these two lines are this change's: the episode check names it
    // as a closed disposition, and the open-aggregate pass (which is for OPEN alerts) does not.
    expect(lines.filter((line) => line.includes(alert!.qitem_id) && line.includes("closed prompt disposition")), lines.join("\n")).toHaveLength(1);
    expect(lines.filter((line) => line.includes(alert!.qitem_id) && line.includes("tags are not readable JSON (repair")), lines.join("\n")).toEqual([]);
    expect(wakes).toEqual([]);
  });

  it("a damaged OPEN alert beside an open original is not a closed disposition: it is left alone, nothing is opened or woken, and it is not called final", async () => {
    await refusedBaton();
    await tick("blocked");
    const [alert] = alerts(OPEN);
    truncate(db, alert!.qitem_id);

    lines.length = 0;
    await tick("blocked");

    expect(lines.filter((line) => line.includes("closed prompt disposition")), lines.join("\n")).toEqual([]);
    expect(alerts(OPEN).map((row) => row.qitem_id)).toEqual([alert!.qitem_id]);
    expect(stateOf(db, alert!.qitem_id)).toBe("pending");
    expect(wakes).toEqual([]);
  });

  it("a damaged closed alert closes only ITS episode: a later refusal episode of the same work still opens an alert", async () => {
    const original = await refusedBaton();
    await tick("blocked");
    const [alert] = alerts(OPEN);
    await repo.update({ qitemId: alert!.qitem_id, actorSession: "ops@fixture", state: "done", closureReason: "no-follow-on" });
    truncate(db, alert!.qitem_id);
    const key2 = `${seat}|fixture#2`;
    for (const transitionNote of [`parked-owner wake reserved: ${key2}; obligations ${original}`, `${REFUSED_PREFIX} ${key2}; Refused: interactive prompt`]) {
      repo.transitionLog.append({ qitemId: original, state: "pending", actorSession: "watchdog@system", transitionNote });
    }

    await tick("blocked");

    const open = alerts(OPEN);
    expect(open, "the new episode is not held by the old episode's damaged disposition").toHaveLength(1);
    expect(rawTags(db, open[0]!.qitem_id)).toContain(`prompt-episode:${key2}`);
  });

  // The retire pass reads aggregates through a json_valid scan, and the per-original pass only visits OPEN originals. An alert
  // whose original has since closed, and whose tags are damaged, was therefore visited by nothing: it stayed open, silent.
  it("an OPEN alert whose tags are damaged and whose original has closed is named (the retire pass cannot read it); nothing is opened or woken", async () => {
    const original = await refusedBaton();
    await tick("blocked");
    const [alert] = alerts(OPEN);
    truncate(db, alert!.qitem_id);
    await repo.update({ qitemId: original, actorSession: seat, state: "done", closureReason: "no-follow-on" });

    lines.length = 0;
    await tick("blocked");

    expect(lines.filter((line) => line.includes(alert!.qitem_id) && line.includes("tags are not readable JSON (repair")), lines.join("\n")).toHaveLength(1);
    expect(stateOf(db, alert!.qitem_id), "named and left alone, not retired on a guess").toBe("pending");
    expect(alerts(OPEN).map((row) => row.qitem_id), "no second alert").toEqual([alert!.qitem_id]);
    expect(wakes).toEqual([]);
  });
});
