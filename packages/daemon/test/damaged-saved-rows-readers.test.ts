// OF-51: a saved row with a JSON column that is not JSON (a hand edit, a truncated write) used to throw out of the reader
// that parses it, so a route that merely LISTS the table answered 500 for every row in it. Measured at base 18f46db6:
// GET /api/rigs/:id/snapshots -> 500 once one snapshot's data was damaged; the event replay and the audit listing threw
// the same way. Now the damaged value reads as absent (or the row is flagged / left out where the JSON IS the row) and
// the rows beside it are served.
//
// Production consequence, in the test names: a damaged row never turns a read route into a 500 for its neighbours.
//
// What is NOT guarded here, on purpose: readers whose callers DECIDE on the row and rely on it throwing. Measured: the
// queue item reader (the prompt-blocked alert's "unreadable member" protocol, pinned by prompt-blocked-alert.test.ts,
// failed 5 rows when its tags read as absent), the inbox absorb (copies tags into a queue item), the outbox guard
// binding (session-transport compares it), the workflow instance frontier (the projector rewrites it), the watchdog
// history notes (the parked-owner policy reconciles from them), the workflow spec cache (projection runs against it).
// Reading a damaged column there as "absent" turns a refusal into a silent wrong answer or a fail-open guard; they need
// the OF-45 marker pattern first (PR body, follow-ups).
//
// Census at 18f46db6 (AST walk of packages/daemon/src, JSON.parse call expressions not inside a `try` block of their own
// function): 54 unguarded. This file pins the stored-row readers it guards; the rest are classified in the PR body.
//
// Deployed entrypoints: server.ts mounts routes/snapshots.ts, routes/events.ts and routes/restore-check.ts; startup.ts
// constructs the stores below (SnapshotRepository, EventBus, CheckpointStore, StreamStore, MissionControlActionLog,
// MissionControlAuditBrowse, WorkflowStepTrailLog) and the workflow-keepalive policy.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createTestApp } from "./helpers/test-app.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { StreamStore } from "../src/domain/stream-store.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { MissionControlAuditBrowse } from "../src/domain/mission-control/audit-browse.js";
import { WorkflowStepTrailLog } from "../src/domain/workflow-step-trail-log.js";
import { WorkflowInstanceStore } from "../src/domain/workflow-instance-store.js";
import { readFreshOccupantRelations } from "../src/domain/fresh-occupant-relation.js";
import { hasPendingFreshStartup, readFreshStartupPending } from "../src/domain/startup-orchestrator.js";
import { captureSkippingUnreadable } from "../src/domain/snapshot-capture.js";
import { makeWorkflowKeepalivePolicy } from "../src/domain/policies/workflow-keepalive.js";
import { UnreadableRowError } from "../src/domain/unreadable-row.js";

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
  it("GET /api/rigs/:id/snapshots lists every snapshot newest first; the damaged one is flagged unreadable, not hidden", async () => {
    const { rig, first, damaged, last } = seedRigWithSnapshots();
    const res = await setup.app.request(`/api/rigs/${rig.id}/snapshots`);
    expect(res.status).toBe(200);
    const listed = await res.json() as Array<{ id: string; kind: string; status: string; createdAt: string; data: unknown; unreadable?: string }>;
    expect(listed.map((s) => s.id)).toEqual([last.id, damaged.id, first.id]);
    expect(listed.map((s) => s.unreadable)).toEqual([undefined, "its saved data is not JSON", undefined]);
    // The flagged row keeps the fields the CLI and the UI list by; its data is null, not a guess.
    expect(listed[1]).toMatchObject({ id: damaged.id, rigId: rig.id, kind: "auto-pre-down", createdAt: "2026-01-01 00:00:02", data: null });
    expect(typeof listed[1]!.status).toBe("string");
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

  // OF-117: a damaged SEAT row (not a damaged snapshot) refuses the restore at the pre-restore capture. It used to come out of
  // the route as restore_error, HTTP 500; it is a named 409.
  it("POST /api/rigs/:id/restore/:snapshotId on a rig with a damaged seat row is 409 saved_row_damaged, not a 500", async () => {
    const { rig, first } = seedRigWithSnapshots();
    db.prepare("UPDATE nodes SET package_refs = ? WHERE rig_id = ?").run(NOT_JSON, rig.id);
    const res = await setup.app.request(`/api/rigs/${rig.id}/restore/${first.id}`, { method: "POST" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      code: "saved_row_damaged",
      error: `Rig ${rig.id} was not restored: its pre-restore snapshot cannot be taken because dev.impl's saved row is damaged (package_refs is not JSON). Nothing was changed. Repair the damaged saved row, then restore again.`,
    });
  });

  it("POST /api/rigs/:id/up (rig start / rig up --existing by id) on a rig with a damaged seat row is the same 409 saved_row_damaged, not a 400", async () => {
    const { rig } = seedRigWithSnapshots();
    db.prepare("UPDATE nodes SET package_refs = ? WHERE rig_id = ?").run(NOT_JSON, rig.id);
    const res = await setup.app.request(`/api/rigs/${rig.id}/up`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const body = await res.json() as { code?: string; error?: string };
    expect({ status: res.status, code: body.code }, JSON.stringify(body)).toEqual({ status: 409, code: "saved_row_damaged" });
    expect(body.error).toContain("dev.impl's saved row is damaged (package_refs is not JSON)");
  });

  it("POST /api/up with an existing rig's name (rig up <name>) on a rig with a damaged seat row is the same 409 saved_row_damaged", async () => {
    const { rig } = seedRigWithSnapshots();
    db.prepare("UPDATE nodes SET package_refs = ? WHERE rig_id = ?").run(NOT_JSON, rig.id);
    const res = await setup.app.request("/api/up", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceRef: "r" }) });
    const body = await res.json() as { code?: string; error?: string };
    expect({ status: res.status, code: body.code }, JSON.stringify(body)).toEqual({ status: 409, code: "saved_row_damaged" });
    expect(body.error).toContain("dev.impl's saved row is damaged (package_refs is not JSON)");
  });

  it("the restore orchestrator answers snapshot_unusable for the damaged snapshot instead of throwing", async () => {
    const { damaged } = seedRigWithSnapshots();
    const out = await setup.restoreOrchestrator.restore(damaged.id, { adapters: {}, fsOps: { exists: () => true } } as never);
    expect(out).toMatchObject({ ok: false, code: "snapshot_unusable" });
  });

  it("the latest-snapshot lookups skip a damaged newest row and name the newest readable one", () => {
    const { rig, first, damaged, last } = seedRigWithSnapshots();
    // Make the damaged one the newest of all.
    db.prepare("UPDATE snapshots SET created_at = '2026-01-01 00:00:09' WHERE id = ?").run(damaged.id);
    expect(setup.snapshotRepo.getLatestSnapshot(rig.id)!.id).toBe(last.id);
    // The only auto-pre-down snapshot is the damaged one: no readable one exists.
    expect(setup.snapshotRepo.findLatestAutoPreDown(rig.id)).toBeNull();
    // Control: with a readable auto-pre-down older than the damaged one, that one is named.
    db.prepare("UPDATE snapshots SET kind = 'auto-pre-down' WHERE id = ?").run(first.id);
    expect(setup.snapshotRepo.findLatestAutoPreDown(rig.id)!.id).toBe(first.id);
  });
});

describe("OF-51 events: a damaged event payload never ends a replay, and never reads as 'nothing happened'", () => {
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

  describe("readFreshOccupantRelations: a damaged seat.fresh_launched row makes THAT seat's relation unavailable (null), not a throw and not skipped", () => {
    function seedSeats() {
      const rig = setup.rigRepo.createRig("r");
      const damagedSeat = setup.rigRepo.addNode(rig.id, "dev.damaged", { runtime: "terminal" });
      const goodSeat = setup.rigRepo.addNode(rig.id, "dev.good", { runtime: "terminal" });
      const tenure = db.prepare("INSERT INTO occupant_tenures (id, node_id, generation_uuid, generation_ordinal, kind) VALUES (?, ?, ?, 1, 'launch')");
      tenure.run("t-damaged", damagedSeat.id, "gen-damaged");
      tenure.run("t-good", goodSeat.id, "gen-good");
      const insert = (nodeId: string, payload: string) => db.prepare("INSERT INTO events (rig_id, node_id, type, payload) VALUES (?, ?, 'seat.fresh_launched', ?)").run(rig.id, nodeId, payload);
      const launched = (node: { id: string }, generation: string, sessionId: string) => JSON.stringify({ type: "seat.fresh_launched", nodeId: node.id, newGeneration: generation, sessionId });
      return { rig, damagedSeat, goodSeat, insert, launched };
    }

    it("a damaged row names no session: its seat reads null, the other seat's relation is still read", () => {
      const f = seedSeats();
      f.insert(f.goodSeat.id, f.launched(f.goodSeat, "gen-good", "sess-good"));
      f.insert(f.damagedSeat.id, NOT_JSON);
      expect(readFreshOccupantRelations(db, f.rig.id)).toEqual({ [f.damagedSeat.id]: null, [f.goodSeat.id]: "sess-good" });
    });

    it("the damage stays unavailable whichever side of a readable launch it falls on", () => {
      const f = seedSeats();
      // The same session on both sides: skipping the damaged row would read "sess-1" (consistent), not "unavailable".
      f.insert(f.damagedSeat.id, f.launched(f.damagedSeat, "gen-damaged", "sess-1"));
      f.insert(f.damagedSeat.id, NOT_JSON);
      f.insert(f.damagedSeat.id, f.launched(f.damagedSeat, "gen-damaged", "sess-1"));
      expect(readFreshOccupantRelations(db, f.rig.id)[f.damagedSeat.id]).toBeNull();
    });

    it("control: with no damaged row the readable launch is the relation", () => {
      const f = seedSeats();
      f.insert(f.damagedSeat.id, f.launched(f.damagedSeat, "gen-damaged", "sess-1"));
      expect(readFreshOccupantRelations(db, f.rig.id)).toEqual({ [f.damagedSeat.id]: "sess-1" });
    });

    it("a damaged row naming no current seat (no node_id, or a seat with no current occupant generation) changes nothing", () => {
      const f = seedSeats();
      f.insert(f.goodSeat.id, f.launched(f.goodSeat, "gen-good", "sess-good"));
      db.prepare("INSERT INTO events (rig_id, node_id, type, payload) VALUES (?, NULL, 'seat.fresh_launched', ?)").run(f.rig.id, NOT_JSON);
      const ghost = setup.rigRepo.addNode(f.rig.id, "dev.ghost", { runtime: "terminal" });
      f.insert(ghost.id, NOT_JSON);
      expect(readFreshOccupantRelations(db, f.rig.id)).toEqual({ [f.goodSeat.id]: "sess-good" });
    });
  });

  it("hasPendingFreshStartup (canContinueFresh) reads a damaged newest startup row as 'not pending': uncertain delivery is never replayed", () => {
    const rig = setup.rigRepo.createRig("r");
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "terminal" });
    const insert = (type: string, payload: string) => db.prepare("INSERT INTO events (rig_id, node_id, type, payload) VALUES (?, ?, ?, ?)").run(rig.id, node.id, type, payload);
    insert("node.startup_failed", JSON.stringify({ type: "node.startup_failed", sessionId: "s1", freshContextPending: true }));
    expect(hasPendingFreshStartup(db, node.id, "s1"), "control: the readable row is pending").toBe(true);
    insert("node.startup_failed", NOT_JSON);
    expect(hasPendingFreshStartup(db, node.id, "s1")).toBe(false);
    // Review B3: the tri-state tells "no pending" from "cannot tell"; a promoter must not read the second as the first.
    expect(readFreshStartupPending(db, node.id, "s1")).toBe("unreadable");
  });

  it("readFreshStartupPending: pending / not_pending / unreadable are three different answers", () => {
    const rig = setup.rigRepo.createRig("r");
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "terminal" });
    const insert = (type: string, payload: string) => db.prepare("INSERT INTO events (rig_id, node_id, type, payload) VALUES (?, ?, ?, ?)").run(rig.id, node.id, type, payload);
    expect(readFreshStartupPending(db, node.id, "s1"), "no startup event at all").toBe("not_pending");
    insert("node.startup_failed", JSON.stringify({ type: "node.startup_failed", sessionId: "s1", freshContextPending: true }));
    expect(readFreshStartupPending(db, node.id, "s1")).toBe("pending");
    expect(readFreshStartupPending(db, node.id, "other"), "another occupant's pending context").toBe("not_pending");
    insert("node.startup_ready", JSON.stringify({ type: "node.startup_ready" }));
    expect(readFreshStartupPending(db, node.id, "s1")).toBe("not_pending");
    insert("node.startup_pending", "[1]");
    expect(readFreshStartupPending(db, node.id, "s1"), "parses but is not an event").toBe("unreadable");
  });
});

describe("OF-51 stores read for display or audit: a damaged JSON column reads as absent, the row and its neighbours are still served", () => {
  it("checkpoints: key_artifacts reads empty WITH a flag, never as a quiet empty list; an automatic capture warns and keeps the flag", () => {
    const rig = setup.rigRepo.createRig("r");
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "terminal" });
    setup.checkpointStore.createCheckpoint(node.id, { summary: "one", keyArtifacts: ["a.md"] });
    const damaged = setup.checkpointStore.createCheckpoint(node.id, { summary: "two", keyArtifacts: ["b.md"] });
    db.prepare("UPDATE checkpoints SET key_artifacts = ? WHERE id = ?").run(NOT_JSON, damaged.id);
    const listed = setup.checkpointStore.getCheckpointsForNode(node.id);
    expect(listed.map((c) => [c.summary, c.keyArtifacts, c.keyArtifactsUnreadable])).toEqual([["one", ["a.md"], undefined], ["two", [], true]]);
    expect(setup.checkpointStore.getCheckpointsForRig(rig.id)[node.id]!.summary).toBe("two");
    // The snapshot a rig-down capture writes keeps the flag and says so.
    const { snapshot, warnings } = captureSkippingUnreadable(setup.snapshotCapture, rig.id, "auto-pre-down");
    expect(warnings.join("\n")).toContain("holds dev.impl's newest checkpoint with an empty key-artifact list");
    expect(snapshot.data.checkpoints[node.id]).toMatchObject({ summary: "two", keyArtifacts: [], keyArtifactsUnreadable: true });
    // Controls: a literal JSON null and a null column are the real "none": no flag, no warning.
    db.prepare("UPDATE checkpoints SET key_artifacts = 'null' WHERE id = ?").run(damaged.id);
    expect(setup.checkpointStore.getCheckpointsForNode(node.id)[1]!.keyArtifactsUnreadable).toBeUndefined();
    db.prepare("UPDATE checkpoints SET key_artifacts = NULL WHERE id = ?").run(damaged.id);
    expect(captureSkippingUnreadable(setup.snapshotCapture, rig.id, "auto-pre-down").warnings).toEqual([]);
  });

  it("stream: hint_tags", () => {
    const stream = new StreamStore(db, setup.eventBus);
    const good = stream.emit({ sourceSession: "a@r", body: "x", hintTags: ["t"] });
    const bad = stream.emit({ sourceSession: "a@r", body: "y", hintTags: ["t"] });
    db.prepare("UPDATE stream_items SET hint_tags = ? WHERE stream_item_id = ?").run(NOT_JSON, bad.streamItemId);
    expect(stream.list().map((i) => [i.streamItemId, i.hintTags]).sort()).toEqual([[good.streamItemId, ["t"]], [bad.streamItemId, null]].sort());
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

  describe("workflow", () => {
    const instance = () => new WorkflowInstanceStore(db).create({ workflowName: "wf", workflowVersion: "1", createdBySession: "a@r" } as never);

    // Review N2: the waiting-replay absorption (workflow-projector matchesStoredWaitingDecision) compares a stored trail's
    // closureEvidence; reading damage as null would let a re-park with no evidence be absorbed. Strict, as at base.
    it("step trails: closure_evidence_json stays strict (a decision reader), it is not read as null", () => {
      const inst = instance();
      db.pragma("foreign_keys = OFF"); // the trail's prior qitem is not what this reads
      const trail = new WorkflowStepTrailLog(db);
      const bad = trail.record({ instanceId: inst.instanceId, stepId: "s", stepRole: "r", closureReason: "done", closedAt: "2026-05-04T03:01:00.000Z", actorSession: "a@r", priorQitemId: "q", closureEvidence: { ok: true } } as never);
      expect(trail.listForInstance(inst.instanceId)[0]!.closureEvidence, "control: readable").toEqual({ ok: true });
      db.prepare("UPDATE workflow_step_trails SET closure_evidence_json = ? WHERE trail_id = ?").run(NOT_JSON, bad.trailId);
      expect(() => trail.listForInstance(inst.instanceId)).toThrow(UnreadableRowError);
    });

    it("keepalive policy: a damaged frontier skips with workflow_frontier_unreadable (the job stays active), not a throw and not terminal", async () => {
      const q = await queueRepo.create({ sourceSession: "a@r", destinationSession: "owner@r", body: "x" });
      const insert = (id: string, frontier: string) => db.prepare(
        `INSERT INTO workflow_instances (instance_id, workflow_name, workflow_version, created_by_session, created_at, status, current_frontier_json)
         VALUES (?, 'wf', '1', 'creator@rig', '2026-05-03T07:00:00Z', 'active', ?)`).run(id, frontier);
      insert("inst-good", JSON.stringify([q.qitemId]));
      insert("inst-bad", NOT_JSON);
      const policy = makeWorkflowKeepalivePolicy({ db });
      const job = (instanceId: string) => ({
        jobId: "job-1", policy: "workflow-keepalive", target: { session: "registered@rig" }, intervalSeconds: 1800, activeWakeIntervalSeconds: null,
        scanIntervalSeconds: null, lastEvaluationAt: null, lastFireAt: null, registeredBySession: "ops@kernel", registeredAt: "2026-05-03T07:00:00.000Z",
        context: { workflow_instance_id: instanceId },
      }) as never;
      expect((await policy.evaluate(job("inst-good"))).action, "control: the readable frontier is served").toBe("send");
      expect(await policy.evaluate(job("inst-bad"))).toMatchObject({ action: "skip", reason: "workflow_frontier_unreadable", notes: { instanceId: "inst-bad" } });
    });
  });
});
