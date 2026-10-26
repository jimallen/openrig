// OF-51: a saved row with a JSON column that is not JSON (a hand edit, a truncated write) used to throw out of the reader
// that parses it, so a route that merely LISTS the table answered 500 for every row in it. Measured at base 18f46db6:
// GET /api/rigs/:id/snapshots -> 500 once one snapshot's data was damaged; the event replay, the audit listing and the
// queue / inbox / outbox / stream listings threw the same way. Now the damaged value reads as absent (or the row is left
// out where the JSON IS the row) and the rows beside it are served.
//
// Production consequence, in the test names: a damaged row never turns a read route into a 500 for its neighbours.
//
// Census at 18f46db6 (AST walk of packages/daemon/src, JSON.parse call expressions not inside a `try` block of their own
// function): 54 unguarded. This file pins the stored-row readers a route reaches; the rest are classified in the PR body.
//
// Deployed entrypoints: server.ts mounts routes/snapshots.ts and routes/events.ts; startup.ts constructs the stores
// below (SnapshotRepository, EventBus, QueueRepository, InboxHandler, OutboxHandler, StreamStore, CheckpointStore,
// MissionControlActionLog, MissionControlAuditBrowse, WatchdogHistoryLog, WorkflowStepTrailLog, WorkflowInstanceStore).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createTestApp } from "./helpers/test-app.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { InboxHandler } from "../src/domain/inbox-handler.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { StreamStore } from "../src/domain/stream-store.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { MissionControlAuditBrowse } from "../src/domain/mission-control/audit-browse.js";
import { WatchdogHistoryLog } from "../src/domain/watchdog-history-log.js";
import { WorkflowStepTrailLog } from "../src/domain/workflow-step-trail-log.js";
import { WorkflowInstanceStore } from "../src/domain/workflow-instance-store.js";
import { readFreshOccupantRelations } from "../src/domain/fresh-occupant-relation.js";
import { hasPendingFreshStartup } from "../src/domain/startup-orchestrator.js";

const NOT_JSON = "{not json";

let db: Database.Database;
let setup: ReturnType<typeof createTestApp>;
let queueRepo: QueueRepository;
beforeEach(() => {
  // Every migration the daemon ships: the stores below own tables the shared fixture leaves out.
  db = createDb();
  migrate(db, ALL_MIGRATIONS);
  setup = createTestApp(db);
  queueRepo = new QueueRepository(db, setup.eventBus);
});
afterEach(() => db.close());

function seedRigWithSnapshots() {
  const rig = setup.rigRepo.createRig("r");
  setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "terminal" });
  const mk = (kind: string) => setup.snapshotCapture.captureSnapshot(rig.id, kind);
  const first = mk("manual");
  const damaged = mk("auto-pre-down");
  const last = mk("manual");
  // created_at has one-second resolution: order the three explicitly, damaged in the middle.
  db.prepare("UPDATE snapshots SET created_at = ? WHERE id = ?").run("2026-01-01 00:00:01", first.id);
  db.prepare("UPDATE snapshots SET created_at = ? WHERE id = ?").run("2026-01-01 00:00:02", damaged.id);
  db.prepare("UPDATE snapshots SET created_at = ? WHERE id = ?").run("2026-01-01 00:00:03", last.id);
  db.prepare("UPDATE snapshots SET data = ? WHERE id = ?").run(NOT_JSON, damaged.id);
  return { rig, first, damaged, last };
}

describe("OF-51 snapshots: one damaged snapshot is never a 500 for the rig's other snapshots", () => {
  it("GET /api/rigs/:id/snapshots lists the readable snapshots, newest first, and leaves the damaged one out", async () => {
    const { rig, first, last } = seedRigWithSnapshots();
    const res = await setup.app.request(`/api/rigs/${rig.id}/snapshots`);
    expect(res.status).toBe(200);
    expect((await res.json() as Array<{ id: string }>).map((s) => s.id)).toEqual([last.id, first.id]);
  });

  it("GET /api/rigs/:id/snapshots/:id of the damaged one is 422 snapshot_unreadable, not a 500; a readable one is 200", async () => {
    const { rig, damaged, first } = seedRigWithSnapshots();
    const res = await setup.app.request(`/api/rigs/${rig.id}/snapshots/${damaged.id}`);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "snapshot_unreadable", error: `Snapshot ${damaged.id} is damaged: its saved data is not JSON` });
    expect((await setup.app.request(`/api/rigs/${rig.id}/snapshots/${first.id}`)).status).toBe(200);
  });

  it("POST /api/rigs/:id/restore/:snapshotId of the damaged one is 409 snapshot_unusable, not a 500", async () => {
    const { rig, damaged } = seedRigWithSnapshots();
    const res = await setup.app.request(`/api/rigs/${rig.id}/restore/${damaged.id}`, { method: "POST" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "snapshot_unusable" });
  });

  it("the restore orchestrator answers snapshot_unusable for the damaged snapshot instead of throwing", async () => {
    const { damaged } = seedRigWithSnapshots();
    const out = await setup.restoreOrchestrator.restore(damaged.id, { adapters: {}, fsOps: { exists: () => true } } as never);
    expect(out).toMatchObject({ ok: false, code: "snapshot_unusable" });
  });

  it("the latest-snapshot lookups skip a damaged newest row and name the newest readable one", () => {
    const { rig, first, damaged } = seedRigWithSnapshots();
    // Make the damaged one the newest of all.
    db.prepare("UPDATE snapshots SET created_at = '2026-01-01 00:00:09' WHERE id = ?").run(damaged.id);
    expect(setup.snapshotRepo.getLatestSnapshot(rig.id)!.id).not.toBe(damaged.id);
    expect(setup.snapshotRepo.getLatestSnapshot(rig.id)!.id).toBeTruthy();
    // The only auto-pre-down snapshot is the damaged one: no readable one exists.
    expect(setup.snapshotRepo.findLatestAutoPreDown(rig.id)).toBeNull();
    // Control: with a readable auto-pre-down older than the damaged one, that one is named.
    db.prepare("UPDATE snapshots SET kind = 'auto-pre-down' WHERE id = ?").run(first.id);
    expect(setup.snapshotRepo.findLatestAutoPreDown(rig.id)!.id).toBe(first.id);
  });
});

describe("OF-51 events: a damaged event payload is left out of the replay, not a throw for every other event", () => {
  function emitThree(rigId: string) {
    const bus = setup.eventBus;
    const a = bus.emit({ type: "node.added", rigId, nodeId: "n1", logicalId: "a" } as never);
    const b = bus.emit({ type: "node.added", rigId, nodeId: "n2", logicalId: "b" } as never);
    const c = bus.emit({ type: "node.added", rigId, nodeId: "n3", logicalId: "c" } as never);
    return { a, b, c };
  }

  it("replaySince and replayAll serve the readable events in order", () => {
    const rig = setup.rigRepo.createRig("r");
    const { a, b, c } = emitThree(rig.id);
    db.prepare("UPDATE events SET payload = ? WHERE seq = ?").run(NOT_JSON, b.seq);
    expect(setup.eventBus.replaySince(a.seq - 1, rig.id).map((e) => e.seq)).toEqual([a.seq, c.seq]);
    expect(setup.eventBus.replayAll(a.seq - 1).filter((e) => [a.seq, b.seq, c.seq].includes(e.seq)).map((e) => e.seq)).toEqual([a.seq, c.seq]);
  });

  it("a payload that parses but is not an event (an array) is left out the same way", () => {
    const rig = setup.rigRepo.createRig("r");
    const { a, b, c } = emitThree(rig.id);
    db.prepare("UPDATE events SET payload = '[1]' WHERE seq = ?").run(b.seq);
    expect(setup.eventBus.replaySince(a.seq - 1, rig.id).map((e) => e.seq)).toEqual([a.seq, c.seq]);
  });

  it("readFreshOccupantRelations skips a damaged seat.fresh_launched row and still reads the others", () => {
    const rig = setup.rigRepo.createRig("r");
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "terminal" });
    db.prepare("INSERT INTO occupant_tenures (id, node_id, generation_uuid, generation_ordinal, kind) VALUES ('t1', ?, 'gen-1', 1, 'launch')").run(node.id);
    const insert = (payload: string) => db.prepare("INSERT INTO events (rig_id, node_id, type, payload) VALUES (?, ?, 'seat.fresh_launched', ?)").run(rig.id, node.id, payload);
    insert(NOT_JSON);
    insert(JSON.stringify({ type: "seat.fresh_launched", nodeId: node.id, newGeneration: "gen-1", sessionId: "sess-1" }));
    expect(readFreshOccupantRelations(db, rig.id)).toEqual({ [node.id]: "sess-1" });
  });

  it("hasPendingFreshStartup reads a damaged newest startup row as 'nothing pending'", () => {
    const rig = setup.rigRepo.createRig("r");
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "terminal" });
    const insert = (type: string, payload: string) => db.prepare("INSERT INTO events (rig_id, node_id, type, payload) VALUES (?, ?, ?, ?)").run(rig.id, node.id, type, payload);
    insert("node.startup_failed", JSON.stringify({ type: "node.startup_failed", sessionId: "s1", freshContextPending: true }));
    expect(hasPendingFreshStartup(db, node.id, "s1"), "control: the readable row is pending").toBe(true);
    insert("node.startup_failed", NOT_JSON);
    expect(hasPendingFreshStartup(db, node.id, "s1")).toBe(false);
  });
});

describe("OF-51 stores: a damaged JSON column reads as absent, the row and its neighbours are still served", () => {
  it("checkpoints: key_artifacts", () => {
    const rig = setup.rigRepo.createRig("r");
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "terminal" });
    setup.checkpointStore.createCheckpoint(node.id, { summary: "one", keyArtifacts: ["a.md"] });
    const damaged = setup.checkpointStore.createCheckpoint(node.id, { summary: "two", keyArtifacts: ["b.md"] });
    db.prepare("UPDATE checkpoints SET key_artifacts = ? WHERE id = ?").run(NOT_JSON, damaged.id);
    expect(setup.checkpointStore.getCheckpointsForNode(node.id).map((c) => [c.summary, c.keyArtifacts])).toEqual([["one", ["a.md"]], ["two", []]]);
    expect(setup.checkpointStore.getCheckpointsForRig(rig.id)[node.id]!.summary).toBe("two");
  });

  it("inbox: tags", () => {
    const inbox = new InboxHandler(db, setup.eventBus, queueRepo);
    const good = inbox.drop({ destinationSession: "b@r", senderSession: "a@r", body: "x", tags: ["t"] });
    const bad = inbox.drop({ destinationSession: "b@r", senderSession: "a@r", body: "y", tags: ["t"] });
    db.prepare("UPDATE inbox_entries SET tags = ? WHERE inbox_id = ?").run(NOT_JSON, bad.inboxId);
    const listed = inbox.listForDestination("b@r");
    expect(listed.map((e) => [e.inboxId, e.tags]).sort()).toEqual([[good.inboxId, ["t"]], [bad.inboxId, null]].sort());
  });

  it("outbox: tags and guard_binding", () => {
    const outbox = new OutboxHandler(db);
    const good = outbox.record({ senderSession: "a@r", destinationSession: "b@r", body: "x", tags: ["t"] });
    const bad = outbox.record({ senderSession: "a@r", destinationSession: "b@r", body: "y", tags: ["t"] });
    db.prepare("UPDATE outbox_entries SET tags = ?, guard_binding = ? WHERE outbox_id = ?").run(NOT_JSON, NOT_JSON, bad.outboxId);
    const listed = outbox.listForSender("a@r");
    expect(listed.find((e) => e.outboxId === good.outboxId)!.tags).toEqual(["t"]);
    const damaged = listed.find((e) => e.outboxId === bad.outboxId)!;
    expect(damaged.tags).toBeNull();
    expect(damaged.guardBinding).toBeNull();
  });

  it("stream: hint_tags", () => {
    const stream = new StreamStore(db, setup.eventBus);
    const good = stream.emit({ sourceSession: "a@r", body: "x", hintTags: ["t"] });
    const bad = stream.emit({ sourceSession: "a@r", body: "y", hintTags: ["t"] });
    db.prepare("UPDATE stream_items SET hint_tags = ? WHERE stream_item_id = ?").run(NOT_JSON, bad.streamItemId);
    expect(stream.list().map((i) => [i.streamItemId, i.hintTags]).sort()).toEqual([[good.streamItemId, ["t"]], [bad.streamItemId, null]].sort());
  });

  it("queue: tags, chain_of_record, human_questions, human_answers", async () => {
    const good = await queueRepo.create({ sourceSession: "a@r", destinationSession: "b@r", body: "x", tags: ["t"], chainOfRecord: ["q0"] });
    const bad = await queueRepo.create({ sourceSession: "a@r", destinationSession: "b@r", body: "y", tags: ["t"], chainOfRecord: ["q0"] });
    db.prepare("UPDATE queue_items SET tags = ?, chain_of_record = ?, human_questions = ?, human_answers = ? WHERE qitem_id = ?")
      .run(NOT_JSON, NOT_JSON, NOT_JSON, NOT_JSON, bad.qitemId);
    const byId = new Map((queueRepo.list({ destinationSession: "b@r" } as never) as Array<{ qitemId: string; tags: unknown; chainOfRecord: unknown; humanQuestions: unknown; humanAnswers: unknown }>).map((q) => [q.qitemId, q]));
    expect(byId.get(good.qitemId)).toMatchObject({ tags: ["t"], chainOfRecord: ["q0"] });
    expect(byId.get(bad.qitemId)).toMatchObject({ tags: null, chainOfRecord: null, humanQuestions: null, humanAnswers: null });
    expect(queueRepo.getById(bad.qitemId)).toMatchObject({ qitemId: bad.qitemId, tags: null });
  });

  it("mission control action log and audit browse: before/after state and audit notes", async () => {
    const q = await queueRepo.create({ sourceSession: "a@r", destinationSession: "b@r", body: "x" });
    const log = new MissionControlActionLog(db);
    const input = { actionVerb: "approve" as const, qitemId: q.qitemId, actorSession: "alice@r", beforeState: { a: 1 }, afterState: { a: 2 }, auditNotes: { n: 1 } };
    log.record({ ...input, actedAt: "2026-05-04T03:00:00.000Z" });
    const bad = log.record({ ...input, actedAt: "2026-05-04T03:01:00.000Z" });
    db.prepare("UPDATE mission_control_actions SET before_state_json = ?, after_state_json = ?, audit_notes_json = ? WHERE action_id = ?").run(NOT_JSON, NOT_JSON, NOT_JSON, bad.actionId);
    for (const rows of [log.listRecent(), new MissionControlAuditBrowse(db).query({}).rows]) {
      expect(rows.map((r) => [r.actedAt.slice(0, 19), r.beforeState, r.afterState, r.auditNotes])).toEqual([
        ["2026-05-04T03:01:00", null, null, null],
        ["2026-05-04T03:00:00", { a: 1 }, { a: 2 }, { n: 1 }],
      ]);
    }
  });

  it("watchdog history: evaluation_notes", () => {
    const history = new WatchdogHistoryLog(db);
    history.record({ jobId: "j1", evaluatedAt: "2026-05-04T03:00:00.000Z", outcome: "skipped", evaluationNotes: { a: 1 } } as never);
    const bad = history.record({ jobId: "j1", evaluatedAt: "2026-05-04T03:01:00.000Z", outcome: "skipped", evaluationNotes: { a: 1 } } as never);
    db.prepare("UPDATE watchdog_history SET evaluation_notes = ? WHERE history_id = ?").run(NOT_JSON, bad.historyId);
    expect(history.listForJob("j1").map((e) => e.evaluationNotes)).toEqual([null, { a: 1 }]);
  });

  describe("workflow", () => {
    const instance = () => new WorkflowInstanceStore(db).create({ workflowName: "wf", workflowVersion: "1", createdBySession: "a@r" } as never);

    it("step trails: closure_evidence_json", () => {
      const inst = instance();
      const trail = new WorkflowStepTrailLog(db);
      const record = (closedAt: string) => trail.record({ instanceId: inst.instanceId, stepId: "s", stepRole: "r", closureReason: "done", closedAt, actorSession: "a@r", priorQitemId: "q", closureEvidence: { ok: true } } as never);
      record("2026-05-04T03:00:00.000Z");
      const bad = record("2026-05-04T03:01:00.000Z");
      db.prepare("UPDATE workflow_step_trails SET closure_evidence_json = ? WHERE trail_id = ?").run(NOT_JSON, bad.trailId);
      expect(trail.listForInstance(inst.instanceId).map((e) => e.closureEvidence).sort((x, y) => String(x).localeCompare(String(y)))).toEqual([{ ok: true }, null].sort((x, y) => String(x).localeCompare(String(y))));
    });

    it("instances: current_frontier_json, last_continuation_decision_json, lifecycle_binding_json", () => {
      const store = new WorkflowInstanceStore(db);
      const inst = instance();
      db.prepare("UPDATE workflow_instances SET current_frontier_json = ?, last_continuation_decision_json = ?, lifecycle_binding_json = ? WHERE instance_id = ?")
        .run(NOT_JSON, NOT_JSON, NOT_JSON, inst.instanceId);
      expect(store.getById(inst.instanceId)).toMatchObject({ instanceId: inst.instanceId, currentFrontier: [], lastContinuationDecision: null, lifecycleBinding: null });
    });
  });
});
