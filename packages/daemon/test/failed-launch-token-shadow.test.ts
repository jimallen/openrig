import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { snapshotMatchesCurrentOccupants } from "../src/domain/rehydrate-eligibility.js";
import { buildRestorePlanPreview, collectPreviewSessionRows } from "../src/domain/restore-plan-preview.js";
import { resolveActiveOccupantRow, resolveActiveSnapshotSession } from "../src/domain/active-occupant.js";
import { readFreshOccupantRelations } from "../src/domain/fresh-occupant-relation.js";

// OF-30. A harness launch that FAILED (Codex profile preflight) wrote a new sessions row with startup_status
// 'failed' and no resume token. The earlier rows (exited, startup ready) still held a valid codex_id token, but
// the restore plan read only the newest row and said "Prior occupant has no usable native resume identity ...
// --fresh required", so the seat could only be fresh-primed and its conversation was lost.
//
// These rows are fixtures, not wall-clock facts: the dates are far from now.
const READY_AT = "2020-01-02T03:04:05.000Z";
const CODEX_ID = "019a0000-aaaa-7bbb-8ccc-0123456789ab";
const NO_IDENTITY = "Prior occupant has no usable native resume identity";

describe("a launch that failed before ready does not hide its predecessor's resume identity (OF-30)", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let registry: SessionRegistry;
  let capture: SnapshotCapture;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    registry = new SessionRegistry(db);
    capture = new SnapshotCapture({
      db, rigRepo, sessionRegistry: registry, eventBus: new EventBus(db),
      snapshotRepo: new SnapshotRepository(db), checkpointStore: new CheckpointStore(db),
    });
  });
  afterEach(() => db.close());

  function seat() {
    const rig = rigRepo.createRig("r01");
    const node = rigRepo.addNode(rig.id, "impl", { role: "worker", runtime: "codex" });
    return { rig, node };
  }

  /** A row that ran: reached ready, left an exited occupant, optionally holding a token. */
  function ranOccupant(nodeId: string, token: string | null) {
    const s = registry.registerSession(nodeId, "impl@r01");
    registry.updateStartupStatus(s.id, "ready", READY_AT);
    if (token) registry.updateResumeToken(s.id, "codex_id", token, "hook");
    registry.updateStatus(s.id, "exited");
    return s;
  }

  /** A launch that failed and never reached ready: no token, no completion time. */
  function failedLaunch(nodeId: string, status: "detached" | "running" | "superseded" = "detached") {
    const s = registry.registerSession(nodeId, "impl@r01");
    registry.updateStartupStatus(s.id, "failed");
    registry.updateStatus(s.id, status);
    return s;
  }

  function livePlan(rigId: string) {
    const rig = rigRepo.getRig(rigId)!;
    // The call shape every production caller uses (rigs.ts, up.ts, startup.ts): the recorded fresh-occupant relation rides along.
    return buildRestorePlanPreview(rig, null, collectPreviewSessionRows(db, rig, null), undefined, Date.now(), readFreshOccupantRelations(db, rigId)).nodes[0]!;
  }

  it.each(["detached", "running"] as const)("live plan resumes the predecessor's token behind a %s failed launch", (status) => {
    const { rig, node } = seat();
    ranOccupant(node.id, CODEX_ID);
    const failed = failedLaunch(node.id, status);

    const forecast = livePlan(rig.id);
    expect(forecast.occupantSessionId).toBe(failed.id);
    expect(forecast.intendedAction).toBe("resume-original");
    expect(forecast.reason ?? "").not.toContain(NO_IDENTITY);
    expect(forecast.tokenState).not.toBe("missing");
  });

  it("a snapshot captured behind the failed launch resumes the predecessor's token, and still matches current state", () => {
    const { rig, node } = seat();
    ranOccupant(node.id, CODEX_ID);
    const failed = failedLaunch(node.id);
    const snapshot = capture.captureSnapshot(rig.id, "auto-rehydrate");

    const resolved = resolveActiveSnapshotSession(snapshot.data, node.id);
    expect(resolved).toMatchObject({ kind: "resolved", session: { id: failed.id, resumeType: "codex_id", resumeToken: CODEX_ID } });
    const current = rigRepo.getRig(rig.id)!;
    expect(buildRestorePlanPreview(current, snapshot, collectPreviewSessionRows(db, current, snapshot)).nodes[0]!.intendedAction).toBe("resume-original");
    expect(snapshotMatchesCurrentOccupants(db, current, snapshot)).toBe(true);
  });

  it("walks past several stacked failed launches to the newest usable token", () => {
    const { rig, node } = seat();
    ranOccupant(node.id, "older-token-must-lose");
    const keeper = ranOccupant(node.id, CODEX_ID);
    failedLaunch(node.id, "superseded"); // the next attempt replaced it
    failedLaunch(node.id);
    expect(keeper.id).toBeTruthy();
    const snapshot = capture.captureSnapshot(rig.id, "auto-rehydrate");
    expect(resolveActiveSnapshotSession(snapshot.data, node.id)).toMatchObject({ kind: "resolved", session: { resumeToken: CODEX_ID } });
    expect(livePlan(rig.id).intendedAction).toBe("resume-original");
  });

  it("does not fall back past a row that reached ready: its missing token is real", () => {
    const { rig, node } = seat();
    ranOccupant(node.id, CODEX_ID);
    ranOccupant(node.id, null); // a real occupant ran here and left no token
    failedLaunch(node.id);
    const forecast = livePlan(rig.id);
    expect(forecast.intendedAction).toBe("awaiting-decision");
    expect(forecast.reason).toContain(NO_IDENTITY);
    const snapshot = capture.captureSnapshot(rig.id, "auto-rehydrate");
    expect(resolveActiveSnapshotSession(snapshot.data, node.id)).toMatchObject({ kind: "resolved", session: { resumeToken: null } });
  });

  it("does not fall back past a row that recorded no launch outcome (pending is not a failed launch)", () => {
    const { rig, node } = seat();
    ranOccupant(node.id, CODEX_ID);
    const stuck = registry.registerSession(node.id, "impl@r01");
    registry.updateStatus(stuck.id, "exited");
    failedLaunch(node.id);
    expect(livePlan(rig.id).intendedAction).toBe("awaiting-decision");
  });

  it("a failed launch that completed startup once is not treated as never having had an occupant", () => {
    const { rig, node } = seat();
    ranOccupant(node.id, CODEX_ID);
    const failed = failedLaunch(node.id);
    db.prepare("UPDATE sessions SET startup_completed_at = ? WHERE id = ?").run(READY_AT, failed.id);
    expect(livePlan(rig.id).intendedAction).toBe("awaiting-decision");
  });

  it("does not inherit from a predecessor whose token has no usable resume type", () => {
    const { rig, node } = seat();
    const old = ranOccupant(node.id, CODEX_ID);
    db.prepare("UPDATE sessions SET resume_type = 'none' WHERE id = ?").run(old.id);
    failedLaunch(node.id);
    expect(livePlan(rig.id).intendedAction).toBe("awaiting-decision");
    // The plan words an inherited 'none' source and a missing one alike; the resolved row must stay empty.
    const snapshot = capture.captureSnapshot(rig.id, "auto-rehydrate");
    expect(resolveActiveSnapshotSession(snapshot.data, node.id)).toMatchObject({ kind: "resolved", session: { resumeType: null, resumeToken: null } });
  });

  it("never reaches across seats: another node's token is not a predecessor", () => {
    const { rig, node } = seat();
    const other = rigRepo.addNode(rig.id, "other", { role: "worker", runtime: "codex" });
    ranOccupant(other.id, CODEX_ID);
    failedLaunch(node.id);
    const forecast = buildRestorePlanPreview(rigRepo.getRig(rig.id)!, null, collectPreviewSessionRows(db, rigRepo.getRig(rig.id)!, null), undefined, Date.now(), readFreshOccupantRelations(db, rig.id))
      .nodes.find((n) => n.logicalId === "impl")!;
    expect(forecast.intendedAction).toBe("awaiting-decision");
    // The snapshot/current comparison reads every row of the rig at once; it must not borrow across seats either.
    const snapshot = capture.captureSnapshot(rig.id, "auto-rehydrate");
    expect(resolveActiveSnapshotSession(snapshot.data, node.id)).toMatchObject({ kind: "resolved", session: { resumeToken: null } });
    expect(snapshotMatchesCurrentOccupants(db, rigRepo.getRig(rig.id)!, snapshot)).toBe(true);
  });

  it("rig set-resume-token and the eligibility rule agree: the operator's token on the failed row wins over the predecessor's", () => {
    const { rig, node } = seat();
    ranOccupant(node.id, CODEX_ID);
    const failed = failedLaunch(node.id);
    // What POST /api/sessions/:name/resume-token does: write the row findResumeContextByName names.
    const ctx = registry.findResumeContextByName("impl@r01")!;
    expect(ctx.sessionId).toBe(failed.id);
    registry.updateResumeToken(ctx.sessionId, "codex_id", "operator-attested-token", "operator");

    const snapshot = capture.captureSnapshot(rig.id, "auto-rehydrate");
    expect(resolveActiveSnapshotSession(snapshot.data, node.id)).toMatchObject({ kind: "resolved", session: { id: failed.id, resumeToken: "operator-attested-token" } });
    expect(livePlan(rig.id).intendedAction).toBe("resume-original");
  });

  it("a pre-convention snapshot (no active-relation map) resolves a uniquely running failed launch the same way", () => {
    const rows = [
      { id: "01-old", nodeId: "n", status: "exited", resumeType: "codex_id", resumeToken: "t", startupStatus: "ready", startupCompletedAt: READY_AT },
      { id: "02-new", nodeId: "n", status: "running", resumeType: null, resumeToken: null, startupStatus: "failed", startupCompletedAt: null },
    ];
    expect(resolveActiveOccupantRow(rows, undefined, "n")).toMatchObject({ kind: "resolved", session: { id: "02-new", resumeToken: "t" } });
    // ... and the single-row legacy branch has no predecessor to inherit from, so it is left as recorded.
    expect(resolveActiveOccupantRow([rows[1]!], undefined, "n")).toMatchObject({ kind: "resolved", session: { id: "02-new", resumeToken: null } });
  });

  it("the walk looks only at OLDER rows: a newer row's token is never inherited by an older failed launch", () => {
    const rows = [
      { id: "01", nodeId: "n", status: "exited", resumeType: "codex_id", resumeToken: "OLD", startupStatus: "ready", startupCompletedAt: READY_AT },
      { id: "02", nodeId: "n", status: "detached", resumeType: null, resumeToken: null, startupStatus: "failed", startupCompletedAt: null },
      { id: "03", nodeId: "n", status: "running", resumeType: "codex_id", resumeToken: "NEWER", startupStatus: "ready", startupCompletedAt: READY_AT },
    ];
    expect(resolveActiveOccupantRow(rows, { n: "02" }, "n")).toMatchObject({ kind: "resolved", session: { id: "02", resumeToken: "OLD" } });
  });

  it("probe status and verification travel with the inherited token: a donor marked not_resumable plans as stale", () => {
    const { rig, node } = seat();
    const old = ranOccupant(node.id, CODEX_ID);
    registry.markResumeProbeResult(old.id, "not_resumable");
    failedLaunch(node.id);
    const forecast = livePlan(rig.id);
    expect(forecast.tokenState).toBe("stale");
    // and a verified donor's freshness is carried too, not recomputed from the empty failed row
    const rows = [
      { id: "01", nodeId: "n", status: "exited", resumeType: "codex_id", resumeToken: "t", resumeLastVerified: "2020-02-03 04:05:06", resumeLastProbeStatus: "resumable", startupStatus: "ready", startupCompletedAt: READY_AT },
      { id: "02", nodeId: "n", status: "running", resumeType: null, resumeToken: null, startupStatus: "failed", startupCompletedAt: null },
    ];
    expect(resolveActiveOccupantRow(rows, { n: "02" }, "n")).toMatchObject({ session: { resumeLastVerified: "2020-02-03 04:05:06", resumeLastProbeStatus: "resumable" } });
  });

  it("an operator-attested token on an older failed row is itself a usable donor", () => {
    const { rig, node } = seat();
    const older = failedLaunch(node.id, "superseded");
    registry.updateResumeToken(older.id, "codex_id", "attested-on-failed-row", "operator");
    failedLaunch(node.id);
    const snapshot = capture.captureSnapshot(rig.id, "auto-rehydrate");
    expect(resolveActiveSnapshotSession(snapshot.data, node.id)).toMatchObject({ kind: "resolved", session: { resumeToken: "attested-on-failed-row" } });
  });

  describe("a deliberate fresh start is the operator's choice to leave the earlier conversation", () => {
    it("registerSession marks a fresh occupant (the launchFresh writer) and nothing else", () => {
      const { node } = seat();
      const plain = registry.registerSession(node.id, "impl@r01");
      const fresh = registry.registerSession(node.id, "impl@r01", "fresh");
      const restoreFresh = registry.registerSession(node.id, "impl@r01", "initial", null, true);
      expect(plain.freshStart).toBeUndefined();
      expect(fresh.freshStart).toBe(true);
      expect(restoreFresh.freshStart).toBe(true);
      expect(db.prepare("SELECT fresh_start FROM sessions WHERE id = ?").get(plain.id)).toEqual({ fresh_start: 0 });
    });

    /** A resumable conversation, then a fresh start that fails, then an ordinary token-less failed launch. */
    function freshFailedThenOrdinaryFailure(freshRow: "launch-fresh" | "restore-fresh") {
      const { rig, node } = seat();
      const donor = ranOccupant(node.id, CODEX_ID);
      registry.markSuperseded(donor.id); // what launchFresh does to the rows it replaces
      const failedFresh = freshRow === "launch-fresh"
        ? registry.registerSession(node.id, "impl@r01", "fresh")
        : registry.registerSession(node.id, "impl@r01", "initial", null, true);
      registry.updateStartupStatus(failedFresh.id, "failed");
      registry.updateStatus(failedFresh.id, "exited"); // compensateFailedFreshLaunch ends it exited
      const later = failedLaunch(node.id, "running");
      return { rig, node, later };
    }

    it.each(["launch-fresh", "restore-fresh"] as const)("a later failed launch does not walk through a failed %s into the conversation it left", (writer) => {
      const { rig, node } = freshFailedThenOrdinaryFailure(writer);
      expect(livePlan(rig.id).intendedAction).toBe("awaiting-decision");
      const snapshot = capture.captureSnapshot(rig.id, "auto-rehydrate");
      expect(resolveActiveSnapshotSession(snapshot.data, node.id)).toMatchObject({ kind: "resolved", session: { resumeToken: null } });
    });

    it("the snapshot-versus-current comparison applies the same bound: a fresh start in the history keeps the two in step", () => {
      const { rig } = freshFailedThenOrdinaryFailure("launch-fresh");
      const snapshot = capture.captureSnapshot(rig.id, "auto-rehydrate");
      expect(snapshotMatchesCurrentOccupants(db, rigRepo.getRig(rig.id)!, snapshot)).toBe(true);
    });

    it.each(["launch-fresh", "restore-fresh"] as const)("a failed %s that is itself the occupant does not inherit the earlier token", (writer) => {
      const { rig, node } = seat();
      ranOccupant(node.id, CODEX_ID);
      const failedFresh = writer === "launch-fresh"
        ? registry.registerSession(node.id, "impl@r01", "fresh")
        : registry.registerSession(node.id, "impl@r01", "initial", null, true);
      registry.updateStartupStatus(failedFresh.id, "failed");
      registry.updateStatus(failedFresh.id, "running");
      const forecast = livePlan(rig.id);
      expect(forecast.intendedAction).toBe("awaiting-decision");
      expect(forecast.reason).toContain(NO_IDENTITY);
    });

    it("the same sequence with an ordinary (not fresh) first failure still resumes: the marker is what stops the walk", () => {
      const { rig, node } = seat();
      const donor = ranOccupant(node.id, CODEX_ID);
      registry.markSuperseded(donor.id);
      const first = registry.registerSession(node.id, "impl@r01");
      registry.updateStartupStatus(first.id, "failed");
      registry.updateStatus(first.id, "exited");
      failedLaunch(node.id, "running");
      expect(livePlan(rig.id).intendedAction).toBe("resume-original");
    });

    it("a fresh start that succeeded and later left a token is a usable donor like any other row", () => {
      const { rig, node } = seat();
      ranOccupant(node.id, "token-before-the-fresh-choice");
      const fresh = registry.registerSession(node.id, "impl@r01", "fresh");
      registry.updateStartupStatus(fresh.id, "ready", READY_AT);
      registry.updateResumeToken(fresh.id, "codex_id", CODEX_ID, "hook");
      registry.updateStatus(fresh.id, "exited");
      failedLaunch(node.id);
      const snapshot = capture.captureSnapshot(rig.id, "auto-rehydrate");
      expect(resolveActiveSnapshotSession(snapshot.data, node.id)).toMatchObject({ session: { resumeToken: CODEX_ID } });
    });

    it("the marker survives a snapshot round trip, and a snapshot without it (older revision) still reads as an ordinary failure", () => {
      const rows = [
        { id: "01", nodeId: "n", status: "superseded", resumeType: "codex_id", resumeToken: "t", startupStatus: "ready", startupCompletedAt: READY_AT },
        { id: "02", nodeId: "n", status: "exited", resumeType: null, resumeToken: null, startupStatus: "failed", startupCompletedAt: null, freshStart: true },
        { id: "03", nodeId: "n", status: "running", resumeType: null, resumeToken: null, startupStatus: "failed", startupCompletedAt: null },
      ];
      expect(resolveActiveOccupantRow(rows, { n: "03" }, "n")).toMatchObject({ session: { resumeToken: null } });
      const older = rows.map(({ freshStart: _drop, ...r }) => r);
      expect(resolveActiveOccupantRow(older, { n: "03" }, "n")).toMatchObject({ session: { resumeToken: "t" } });
    });
  });

  it("keeps the occupant's own identity: only resume fields are inherited, never id, status or restore policy", () => {
    const rows = [
      { id: "01-old", nodeId: "n", status: "exited", resumeType: "codex_id", resumeToken: "t", resumeProvenance: "hook", restorePolicy: "resume_if_possible", startupStatus: "ready", startupCompletedAt: READY_AT },
      { id: "02-new", nodeId: "n", status: "detached", resumeType: null, resumeToken: null, resumeProvenance: null, restorePolicy: "fresh_only", startupStatus: "failed", startupCompletedAt: null },
    ];
    const resolved = resolveActiveOccupantRow(rows, { n: "02-new" }, "n");
    expect(resolved).toMatchObject({ kind: "resolved", session: { id: "02-new", status: "detached", restorePolicy: "fresh_only", resumeType: "codex_id", resumeToken: "t", resumeProvenance: "hook" } });
  });
});
