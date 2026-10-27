// OF-117: the workflow stores a decision rests on (the instance frontier the projector rewrites, the cached spec a projection
// runs against, the step trail the replay absorption compares) parsed their saved JSON columns bare, so one damaged row was a
// bare SyntaxError: HTTP 500 for the instance and spec listings, and a boot sweep that stopped at the first damaged instance.
// Measured at base 5eed3994: runWorkflowBootSweep over one good and one damaged instance threw; GET /api/workflow listed none.
//
// Now: a by-id read refuses by name (UnreadableRowError: table, row, column); the listings and the boot sweep serve/skip the
// damaged row NAMED, and the rows beside it are served and swept.
//
// Deployed entrypoints: server.ts mounts routes/workflow.ts (WorkflowRuntime.listInstancesWithDeadline, specCache.listAll);
// startup.ts runs runWorkflowBootSweep at boot; the projector reads WorkflowInstanceStore / WorkflowSpecCache by id.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { runWorkflowBootSweep } from "../src/domain/workflow-boot-sweep.js";
import { recoverGraphOperation } from "../src/domain/workflow-reconciliation.js";
import { UnreadableRowError } from "../src/domain/unreadable-row.js";
import { Hono } from "hono";
import { workflowRoutes } from "../src/routes/workflow.js";
import { jsonBodyErrorHandler } from "../src/middleware/json-body-error.js";

const NOT_JSON = "{not json";
const SPEC = `workflow:
  id: of117
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

let db: Database.Database;
let runtime: WorkflowRuntime;
let queueRepo: QueueRepository;
let watchdogRepo: WatchdogJobsRepository;
let tmp: string;
let specPath: string;
let lines: string[];

beforeEach(() => {
  db = createDb();
  migrate(db, ALL_MIGRATIONS);
  const bus = new EventBus(db);
  db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
  queueRepo = new QueueRepository(db, bus, { validateRig: () => true, transport: { send: async () => ({ ok: true, verified: true }) } });
  watchdogRepo = new WatchdogJobsRepository(db);
  runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo, watchdogJobsRepo: watchdogRepo });
  tmp = mkdtempSync(join(tmpdir(), "of117-wf-"));
  specPath = join(tmp, "spec.yaml");
  writeFileSync(specPath, SPEC);
  lines = [];
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function instance(objective: string) {
  return (await runtime.instantiate({ specPath, rootObjective: objective, createdBySession: "ops@rig" })).instance;
}
const setColumn = (instanceId: string, column: string, text: string | null) =>
  db.prepare(`UPDATE workflow_instances SET ${column} = ? WHERE instance_id = ?`).run(text, instanceId);

describe("workflow instances", () => {
  it.each([
    ["current_frontier_json"],
    ["last_continuation_decision_json"],
    ["lifecycle_binding_json"],
  ])("%s damaged: a by-id read refuses by name, and the listing serves it flagged with its neighbour intact", async (column) => {
    const good = await instance("good");
    const bad = await instance("bad");
    setColumn(bad.instanceId, column, NOT_JSON);
    let caught: unknown;
    try { runtime.instanceStore.getById(bad.instanceId); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(UnreadableRowError);
    expect(caught).toMatchObject({ table: "workflow_instances", rowId: bad.instanceId, columns: [column] });
    expect(() => runtime.instanceStore.listAll()).toThrow(UnreadableRowError);

    const listed = runtime.listInstancesWithDeadline();
    const flagged = listed.find((row) => row.instanceId === bad.instanceId)!;
    expect(flagged.unreadable).toEqual([column]);
    expect(flagged.unknowns.join(" ")).toContain(`Saved ${column} of instance ${bad.instanceId} is not readable JSON`);
    expect(flagged.frontierPackets).toEqual([]);
    const intact = listed.find((row) => row.instanceId === good.instanceId)!;
    expect("unreadable" in intact).toBe(false);
    expect(intact.currentFrontier).toEqual(good.currentFrontier);
    // The status filter goes through the same read.
    expect(runtime.listInstancesWithDeadline("active").map((row) => row.instanceId).sort()).toEqual([good.instanceId, bad.instanceId].sort());
  });

  it("control: NULL optional columns are not damage", async () => {
    const row = await instance("plain");
    setColumn(row.instanceId, "last_continuation_decision_json", null);
    setColumn(row.instanceId, "lifecycle_binding_json", null);
    expect("unreadable" in runtime.instanceStore.getById(row.instanceId)!).toBe(false);
  });

  it("the boot sweep names a damaged in-flight instance, does not sweep it, and sweeps the instance beside it", async () => {
    const good = await instance("good");
    const bad = await instance("bad");
    const armed = (instanceId: string) => watchdogRepo.listAll().filter((job) => JSON.stringify(job).includes(instanceId));
    for (const job of watchdogRepo.listAll()) watchdogRepo.markTerminal(job.jobId, "simulated_pre_wf1_state");
    setColumn(bad.instanceId, "current_frontier_json", NOT_JSON);
    const result = await runWorkflowBootSweep({ instanceStore: runtime.instanceStore, queueRepo, watchdogJobsRepo: watchdogRepo, log: (line) => lines.push(line) });
    expect(result.instancesSwept).toBe(1);
    expect(result.keepalivesArmed).toBe(1);
    expect(result.unreadableInstances).toEqual([{ instanceId: bad.instanceId, columns: ["current_frontier_json"] }]);
    expect(lines).toContain(`workflow boot sweep: instance ${bad.instanceId} skipped: its saved current_frontier_json is not readable JSON (repair or remove the row)`);
    expect(armed(good.instanceId).some((job) => job.state === "active")).toBe(true);
    expect(armed(bad.instanceId).some((job) => job.state === "active"), "no keepalive is armed on a frontier nobody can read").toBe(false);
  });

  it("control: with nothing damaged the sweep result has no unreadableInstances key", async () => {
    await instance("good");
    const result = await runWorkflowBootSweep({ instanceStore: runtime.instanceStore, queueRepo, watchdogJobsRepo: watchdogRepo, log: (line) => lines.push(line) });
    expect("unreadableInstances" in result).toBe(false);
  });

  it("recoverGraphOperation (the operation-key readback across ALL instances) survives one instance whose lifecycle binding is not JSON", async () => {
    const good = await instance("good");
    const bad = await instance("bad");
    setColumn(bad.instanceId, "lifecycle_binding_json", NOT_JSON);
    expect(() => recoverGraphOperation(db, "no-such-operation-key")).not.toThrow();
    expect(recoverGraphOperation(db, "no-such-operation-key")).toBeNull();
    // Control: the readable instance's revision receipt is still found through the same query.
    setColumn(good.instanceId, "lifecycle_binding_json", JSON.stringify({ revisionHistory: [{ operationKey: "op-1", expectedVersion: 0 }] }));
    expect(recoverGraphOperation(db, "op-1")).toMatchObject({ kind: "revision", instance: { instanceId: good.instanceId } });
  });

  it("failure-exception closing (the redrive's tag scan over every open queue row) is not ended by an unrelated row whose tags are not JSON", async () => {
    const unrelated = await queueRepo.create({ sourceSession: "a@rig", destinationSession: "b@rig", body: "unrelated", nudge: false });
    db.prepare("UPDATE queue_items SET tags = ? WHERE qitem_id = ?").run(NOT_JSON, unrelated.qitemId);
    // Bracket access reaches the private method under its real signature: no cast.
    expect(runtime["closeFailureExceptions"]("inst-x", "packet-x", "step-x", { actorSession: "ops@rig" }, () => {})).toBe(0);
  });
});

describe("workflow routes", () => {
  function app(): Hono {
    const hono = new Hono();
    hono.onError(jsonBodyErrorHandler);
    hono.use("*", async (c, next) => { c.set("workflowRuntime" as never, runtime); await next(); });
    hono.route("/api/workflow", workflowRoutes());
    return hono;
  }

  it("GET /list serves 200 with the damaged instance flagged and its neighbour intact (it was a 500 for both)", async () => {
    const good = await instance("good");
    const bad = await instance("bad");
    setColumn(bad.instanceId, "current_frontier_json", NOT_JSON);
    const res = await app().request("/api/workflow/list");
    expect(res.status).toBe(200);
    const rows = await res.json() as Array<{ instanceId: string; unreadable?: string[] }>;
    expect(rows.find((row) => row.instanceId === bad.instanceId)!.unreadable).toEqual(["current_frontier_json"]);
    expect("unreadable" in rows.find((row) => row.instanceId === good.instanceId)!).toBe(false);
  });

  it("GET /specs serves 200 with the damaged spec flagged", async () => {
    await instance("seed");
    const spec = runtime.specCache.listAll()[0]!;
    db.prepare("UPDATE workflow_specs SET spec_json = ? WHERE spec_id = ?").run(NOT_JSON, spec.specId);
    const res = await app().request("/api/workflow/specs");
    expect(res.status).toBe(200);
    const body = await res.json() as { specs: Array<{ name: string; unreadable?: string[] }> };
    expect(body.specs.find((row) => row.name === spec.name)!.unreadable).toEqual(["spec_json"]);
  });

  it("GET /<instance> of the damaged instance is 422 saved_row_unreadable naming the row, not a 500", async () => {
    const bad = await instance("bad");
    setColumn(bad.instanceId, "current_frontier_json", NOT_JSON);
    const res = await app().request(`/api/workflow/${bad.instanceId}`);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "saved_row_unreadable", table: "workflow_instances", rowId: bad.instanceId, columns: ["current_frontier_json"] });
  });
});

describe("workflow spec cache", () => {
  async function cached() {
    await instance("seed the spec cache");
    return runtime.specCache.listAll()[0]!;
  }

  it.each([["spec_json"], ["roles_json"], ["steps_json"]])("%s damaged: the listing flags the spec, a by-name read refuses (a projection never runs on a spec whose guards are unknown)", async (column) => {
    const spec = await cached();
    // roles_json/steps_json are read only when no full spec is stored: damage spec_json too for those two.
    const clearFull = column === "spec_json" ? "" : ", spec_json = NULL";
    db.prepare(`UPDATE workflow_specs SET ${column} = ?${clearFull} WHERE spec_id = ?`).run(NOT_JSON, spec.specId);
    const listed = runtime.specCache.listAll();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.unreadable).toEqual([column]);
    let caught: unknown;
    try { runtime.specCache.getByNameVersion(spec.name, spec.version); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(UnreadableRowError);
    expect(caught).toMatchObject({ table: "workflow_specs", rowId: spec.specId, columns: [column] });
  });

  it("control: an intact cached spec reads and lists with no flag", async () => {
    const spec = await cached();
    expect("unreadable" in spec).toBe(false);
    expect(runtime.specCache.getByNameVersion(spec.name, spec.version)!.spec.steps.map((step) => step.id)).toEqual(["work"]);
  });
});
