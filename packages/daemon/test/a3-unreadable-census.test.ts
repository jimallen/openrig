// OF-168 (a3): the json_valid( census (31 code sites + 1 comment at base e38e10c3; table in the PR body) against the unreadable rule:
// a listing marks a damaged row, a decision read refuses, a sweep or drain names the row and skips it, and an unreadable row is
// never read as absent and then acted on. Each row below damages ONE input of ONE site.
//
// Deployed entrypoints: routes/workflow.ts (GET /operations/:key -> WorkflowRuntime.recoverOperation; POST /:id/revision ->
// reviseGraph) and WorkflowRuntime.instantiate (workflow-runtime.ts) read the operation-key readback; startup.ts constructs the runtime.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { Hono } from "hono";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { recoverGraphOperation, reviseGraph } from "../src/domain/workflow-reconciliation.js";
import { UnreadableRowError } from "../src/domain/unreadable-row.js";
import { newestUsableSnapshotCopy, seatStartupForRestore } from "../src/domain/own-startup-replay.js";
import { workflowRoutes } from "../src/routes/workflow.js";
import { jsonBodyErrorHandler } from "../src/middleware/json-body-error.js";

const SPEC = `workflow:
  id: a3-census
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

describe("workflow-reconciliation recoverGraphOperation (the operation-key idempotency readback)", () => {
  let db: Database.Database;
  let bus: EventBus;
  let runtime: WorkflowRuntime;
  let tmp: string;
  let specPath: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    bus = new EventBus(db);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    const queueRepo = new QueueRepository(db, bus, { validateRig: () => true, transport: { send: async () => ({ ok: true, verified: true }) } });
    runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo, watchdogJobsRepo: new WatchdogJobsRepository(db) });
    tmp = mkdtempSync(join(tmpdir(), "a3-census-"));
    specPath = join(tmp, "spec.yaml");
    writeFileSync(specPath, SPEC);
  });
  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const instance = async (objective: string) => (await runtime.instantiate({ specPath, rootObjective: objective, createdBySession: "ops@rig" })).instance;
  const setBinding = (instanceId: string, text: string | null) => db.prepare("UPDATE workflow_instances SET lifecycle_binding_json = ? WHERE instance_id = ?").run(text, instanceId);
  const receipt = (key: string) => JSON.stringify({ revisionHistory: [{ operationKey: key, expectedVersion: 0, compiledInputDigest: "d", actorSession: "ops@rig", reason: "r" }] });
  /** The write a truncated save leaves: the quoted text survives, the JSON does not parse. */
  const damage = (instanceId: string, key: string) => setBinding(instanceId, receipt(key).slice(0, -1));
  const versionOf = (instanceId: string) => (db.prepare("SELECT version FROM workflow_instances WHERE instance_id = ?").get(instanceId) as { version: number }).version;

  it("a damaged lifecycle binding that still carries the operation key is not 'no such operation': the readback refuses it by name", async () => {
    const holder = await instance("holder");
    damage(holder.instanceId, "op-lost");

    let thrown: unknown;
    try { recoverGraphOperation(db, "op-lost"); } catch (error) { thrown = error; }

    expect(thrown, "a revision receipt that may sit in an unreadable binding must not read as absent").toBeInstanceOf(UnreadableRowError);
    expect(thrown).toMatchObject({ table: "workflow_instances", rowId: holder.instanceId, columns: ["lifecycle_binding_json"] });
  });

  it("controls: a damaged binding without that key, and a readable binding with it, do not refuse", async () => {
    const holder = await instance("holder");
    const readable = await instance("readable");
    damage(holder.instanceId, "op-other");
    setBinding(readable.instanceId, receipt("op-here"));

    expect(recoverGraphOperation(db, "op-unrelated")).toBeNull();
    expect(recoverGraphOperation(db, "op-here")).toMatchObject({ kind: "revision", instance: { instanceId: readable.instanceId } });
  });

  it("control: a READABLE binding that merely mentions the key text outside a receipt is not damage", async () => {
    const holder = await instance("holder");
    setBinding(holder.instanceId, JSON.stringify({ note: { operationKey: "op-text" } }));

    expect(recoverGraphOperation(db, "op-text")).toBeNull();
  });

  it("a readable receipt for the key wins even while another instance's binding is damaged and carries the same text", async () => {
    const holder = await instance("holder");
    const readable = await instance("readable");
    damage(holder.instanceId, "op-shared");
    setBinding(readable.instanceId, receipt("op-shared"));

    expect(recoverGraphOperation(db, "op-shared")).toMatchObject({ kind: "revision", instance: { instanceId: readable.instanceId } });
  });

  it("the operation key is matched whole: a damaged binding for op-1 does not refuse op-10", async () => {
    const holder = await instance("holder");
    damage(holder.instanceId, "op-10");

    expect(recoverGraphOperation(db, "op-1")).toBeNull();
  });

  it("a revision submitted under a key whose receipt may sit in a damaged binding writes nothing", async () => {
    const holder = await instance("holder");
    const target = await instance("target");
    damage(holder.instanceId, "op-retry");
    const before = versionOf(target.instanceId);

    expect(() => reviseGraph(db, bus, {
      instanceId: target.instanceId, operationKey: "op-retry", expectedVersion: before, expectedDigest: "x", actorSession: "ops@rig", reason: "retry",
    })).toThrow(UnreadableRowError);
    expect(versionOf(target.instanceId)).toBe(before);
  });

  it("GET /operations/:key answers 422 saved_row_unreadable naming the row, not 404 'no committed effect'", async () => {
    const holder = await instance("holder");
    damage(holder.instanceId, "op-route");
    const hono = new Hono();
    hono.onError(jsonBodyErrorHandler);
    hono.use("*", async (c, next) => { c.set("workflowRuntime" as never, runtime); await next(); });
    hono.route("/api/workflow", workflowRoutes());

    const res = await hono.request("/api/workflow/operations/op-route");

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "saved_row_unreadable", table: "workflow_instances", rowId: holder.instanceId, columns: ["lifecycle_binding_json"] });
  });
});

describe("own-startup-replay: a newer snapshot whose data is not JSON is named, not silently passed over", () => {
  // Restore replays the newest snapshot copy of a seat's startup files that can be used. A snapshot whose data is not JSON cannot say
  // what it holds for the seat, so the fallback to an older snapshot is an act on a guess unless the operator is told which snapshots
  // were not read.
  //
  // Deployed entrypoint: startup.ts constructs RestoreOrchestrator, whose fresh-seat path (restore-orchestrator.ts) calls
  // seatStartupForRestore; routes/restore-check.ts asks the same function.
  const NOT_JSON = "{not json";
  const COPY = { projectionEntries: [], resolvedStartupFiles: [], startupActions: [], runtime: "claude-code" };
  /** A selected copy the seat cannot use (blank runtime), so restore looks for the newest snapshot copy that it can. */
  const BROKEN_SELECTED = { ...COPY, runtime: "" };
  let db: Database.Database;
  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')").run();
  });
  afterEach(() => db.close());

  const snapshot = (id: string, createdAt: string, data: string) =>
    db.prepare("INSERT INTO snapshots (id, rig_id, kind, status, data, created_at) VALUES (?, 'r-1', 'auto-pre-down', 'active', ?, ?)").run(id, data, createdAt);
  const usable = () => JSON.stringify({ nodes: [{ id: "n-old", logicalId: "dev.impl" }], nodeStartupContext: { "n-old": COPY } });
  const restoreChoice = () => seatStartupForRestore(db, { rigId: "r-1", nodeId: "n-new", logicalId: "dev.impl", runtime: "claude-code" }, BROKEN_SELECTED);

  it("names the newer unreadable snapshots in the fallback warning and on the copy, newest first, and still replays the older usable copy", () => {
    snapshot("snap-good", "2026-01-01 00:00:00", usable());
    snapshot("snap-bad-1", "2026-02-01 00:00:00", NOT_JSON);
    snapshot("snap-bad-2", "2026-03-01 00:00:00", NOT_JSON);

    const choice = restoreChoice();

    expect(choice.kind).toBe("fallback");
    if (choice.kind !== "fallback") return;
    expect(choice.from.snapshotId).toBe("snap-good");
    expect(choice.from.skippedUnreadable).toEqual(["snap-bad-2", "snap-bad-1"]);
    expect(choice.warning).toContain("Newer snapshots snap-bad-2, snap-bad-1 could not be read (saved data is not JSON) and were passed over");
  });

  it("one unreadable snapshot reads in the singular", () => {
    snapshot("snap-good", "2026-01-01 00:00:00", usable());
    snapshot("snap-bad", "2026-02-01 00:00:00", NOT_JSON);

    const choice = restoreChoice();

    expect(choice.kind === "fallback" && choice.warning).toContain("Newer snapshot snap-bad could not be read (saved data is not JSON) and was passed over; repair or remove it.");
  });

  it("control: with nothing unreadable the copy carries no skippedUnreadable key and the warning says nothing about unreadable snapshots", () => {
    snapshot("snap-good", "2026-01-01 00:00:00", usable());

    const choice = restoreChoice();

    expect(choice.kind).toBe("fallback");
    if (choice.kind !== "fallback") return;
    expect("skippedUnreadable" in choice.from).toBe(false);
    expect(choice.warning).not.toContain("could not be read");
  });

  it("an unreadable snapshot OLDER than the usable copy is not named: the search stopped before it", () => {
    snapshot("snap-bad-old", "2025-12-01 00:00:00", NOT_JSON);
    snapshot("snap-good", "2026-01-01 00:00:00", usable());

    expect("skippedUnreadable" in (newestUsableSnapshotCopy(db, "r-1", "dev.impl", "claude-code") ?? {})).toBe(false);
  });

  it("a snapshot that is valid JSON without this seat is not 'unreadable': it is passed over silently, as before", () => {
    snapshot("snap-good", "2026-01-01 00:00:00", usable());
    snapshot("snap-other-seat", "2026-02-01 00:00:00", JSON.stringify({ nodes: [{ id: "n-x", logicalId: "someone.else" }], nodeStartupContext: { "n-x": COPY } }));

    expect("skippedUnreadable" in (newestUsableSnapshotCopy(db, "r-1", "dev.impl", "claude-code") ?? {})).toBe(false);
  });
});
