// OF-40: restore-check (and `rig up --existing --plan`) must stop being greener than restore for the gates restore runs
// BEFORE it looks at a seat's startup files: a removed seat, a runtime that differs from the snapshot's, a resumable
// seat with no token, an earlier occupant who left a token. Production consequence: `rig restore-check` says "green",
// the operator runs `rig up --existing <rig>`, and the seat stops (failed, or awaiting a decision) with nothing started.
//
// The table runs the REAL RestoreOrchestrator and the REAL RestoreCheckService over the same snapshot and requires
// them to agree both ways: the check is red exactly when restore stops the seat, and when it is red it says what
// restore says (restore's own text). Rows where restore comes up cleanly are there so the check cannot get stricter
// by guessing.
//
// The active-occupant ambiguity gate IS reachable through restore(): a snapshot whose occupant is `ambiguous` with at
// least two distinct candidate session rows (what capture writes for two running occupants), or a legacy snapshot whose
// activeSessionIdByNode records an explicit null, is usable, and restore stops the seat `failed`. (An earlier version of
// this file dropped its ambiguity rows claiming the snapshot was refused whole. That was wrong: those rows named every
// session of a one-session snapshot as candidates, which fails the two-candidate test and made the snapshot unusable
// for that reason. G12 to G14 below are the well-formed shapes.)
//
// Deployed entrypoint: startup.ts constructs RestoreOrchestrator; server.ts mounts routes/restore-check.ts and
// routes/up.ts, which build the check and the plan from the same module restore calls (restore-seat-gates.ts).
// A removed seat is reachable in production: `rig remove-node` (RigLifecycleService.removeNode, foreign keys ON)
// deletes the node row and keeps the rig's snapshots; the removal row below uses that service, not a raw delete.
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createRestoreHarness, type RestoreHarness } from "./helpers/restore-fresh-harness.js";
import { createRestoreCheckService } from "../src/routes/restore-check.js";
import { RigLifecycleService } from "../src/domain/rig-lifecycle-service.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { EventBus } from "../src/domain/event-bus.js";

type Status = "ok" | "awaiting-decision" | "failed" | "restore-ended";

describe("restore-check and restore agree on the gates restore runs before a seat's startup files", () => {
  let h: RestoreHarness;
  afterEach(() => h.cleanup());

  const SEAT = "dev.impl";
  const exists = (p: string) => fs.existsSync(p);
  const policyFresh = (nodeId: string) => h.db.prepare("UPDATE sessions SET restore_policy = 'checkpoint_only' WHERE node_id = ?").run(nodeId);
  /** Rewrites the snapshot the way a capture of a different seat state would have written it. */
  const editSnapshot = (snapshotId: string, edit: (data: any) => void) => {
    const row = h.db.prepare("SELECT data FROM snapshots WHERE id = ?").get(snapshotId) as { data: string };
    const data = JSON.parse(row.data);
    edit(data);
    h.db.prepare("UPDATE snapshots SET data = ? WHERE id = ?").run(JSON.stringify(data), snapshotId);
  };

  async function runCheck(listed: boolean, opts: { probe?: boolean } = {}) {
    const service = createRestoreCheckService(h.rigRepo, h.snapshotRepo, opts.probe ? h.tmux : undefined, { runtimeAdapters: { "claude-code": h.adapter }, specReader: h.inst });
    const result = await service.checkWithLiveness({ rig: "team", noQueue: true, noHooks: true, ...(listed ? { freshLogicalIds: [SEAT] } : {}) } as never);
    const pre = result.checks.find((c) => c.check === "rig.team.restore-preconditions")!;
    return { status: pre.status, evidence: pre.evidence, recovery: result.recovery, verdict: result.verdict, checks: result.checks };
  }

  async function runRestore(snapshotId: string, listed: boolean): Promise<{ status: Status; error: string | null; warnings: string[] }> {
    try {
      const out = await h.restore.restore(snapshotId, { adapters: { "claude-code": h.adapter }, fsOps: { exists }, ...(listed ? { freshLogicalIds: [SEAT] } : {}) } as never);
      if (!out.ok) return { status: "restore-ended", error: null, warnings: [] };
      const node = out.result.nodes.find((n) => n.logicalId === SEAT)!;
      const stopped = node.status === "awaiting-decision" || node.status === "failed";
      return { status: stopped ? (node.status as Status) : "ok", error: node.error ?? null, warnings: out.result.warnings ?? [] };
    } catch {
      return { status: "restore-ended", error: null, warnings: [] };
    }
  }

  interface Row {
    name: string;
    listed: boolean;
    /** Shapes the seat before teardown captures it. */
    prepare?(seat: { rigId: string; nodeId: string }): void;
    /** Shapes the snapshot after capture, or the live rig after the snapshot. */
    afterSnapshot?(snapshotId: string, seat: { rigId: string; nodeId: string }): Promise<void> | void;
    /** The table's own expectation of restore (so a row that stopped asserting its state fails loudly). */
    expected: Status;
    /** Words restore's error must contain, so a row says WHICH gate answered, not only that one did. */
    says?: string;
  }
  const CHANGE_RUNTIME = (snapshotId: string) => editSnapshot(snapshotId, (data) => {
    for (const key of Object.keys(data.nodeStartupContext)) data.nodeStartupContext[key].runtime = "codex";
  });
  /** The seat's own saved startup file names a required file that is gone: pre-restore validation refuses the restore. */
  const GONE_OWN_FILE = (nodeId: string) => {
    const row = h.db.prepare("SELECT resolved_files_json AS f FROM node_startup_context WHERE node_id = ?").get(nodeId) as { f: string };
    const files = (JSON.parse(row.f) as Array<Record<string, unknown>>).map((f) => ({ ...f, absolutePath: "/nonexistent/of40/role.md" }));
    h.db.prepare("UPDATE node_startup_context SET resolved_files_json = ? WHERE node_id = ?").run(JSON.stringify(files), nodeId);
  };
  const DROP_TOKEN = (nodeId: string) => h.db.prepare("UPDATE sessions SET resume_token = NULL WHERE node_id = ?").run(nodeId);
  const ABSENT_OCCUPANT = (snapshotId: string) => editSnapshot(snapshotId, (data) => {
    // Captured when the seat had no running occupant: the session row (with its token) is history only.
    data.activeOccupantsByNode = Object.fromEntries(data.nodes.map((node: { id: string }) => [node.id, { kind: "absent" }]));
    data.activeSessionIdByNode = Object.fromEntries(data.nodes.map((node: { id: string }) => [node.id, null]));
  });
  const podOf = (nodeId: string) => (h.db.prepare("SELECT pod_id AS p FROM nodes WHERE id = ?").get(nodeId) as { p: string }).p;
  const CONTINUITY = (nodeId: string, status: string) => h.db.prepare("INSERT OR REPLACE INTO continuity_state (pod_id, node_id, status) VALUES (?, ?, ?)").run(podOf(nodeId), nodeId, status);
  /** Two live occupant candidates, as capture writes it (deriveActiveOccupantsByNode): which saved session is the seat's cannot be told. */
  const AMBIGUOUS_OCCUPANT = (snapshotId: string) => editSnapshot(snapshotId, (data) => {
    const node = data.nodes.find((candidate: { logicalId: string }) => candidate.logicalId === SEAT);
    const first = data.sessions.find((session: { nodeId: string }) => session.nodeId === node.id);
    data.sessions.push({ ...first, id: "01ZZZZZZZZOF40AMBIGUOUS02", sessionName: "dev-impl-second@team" });
    data.activeOccupantsByNode = { ...(data.activeOccupantsByNode ?? {}), [node.id]: { kind: "ambiguous", candidateIds: [first.id, "01ZZZZZZZZOF40AMBIGUOUS02"] } };
  });
  /** A snapshot of the legacy shape: no activeOccupantsByNode, and activeSessionIdByNode records an explicit null. */
  const LEGACY_NULL_OCCUPANT = (snapshotId: string) => editSnapshot(snapshotId, (data) => {
    delete data.activeOccupantsByNode;
    data.activeSessionIdByNode = Object.fromEntries(data.nodes.map((node: { id: string }) => [node.id, null]));
  });
  const REMOVE_SEAT = async (_snapshotId: string, seat: { rigId: string; nodeId: string }) => {
    const bus = new EventBus(h.db);
    const lifecycle = new RigLifecycleService({
      db: h.db, rigRepo: h.rigRepo, sessionRegistry: h.sessionRegistry, discoveryRepo: new DiscoveryRepository(h.db), eventBus: bus,
      queueRepo: new QueueRepository(h.db, bus, { validateRig: () => true }), tmuxAdapter: h.tmux,
    });
    const removed = await lifecycle.removeNode(seat.rigId, SEAT);
    expect(removed.ok, JSON.stringify(removed)).toBe(true);
  };

  const ROWS: Row[] = [
    // Controls: restore comes up cleanly, so the check must not be red.
    { name: "G0 control: seat starts fresh (policy checkpoint_only)", listed: false, prepare: (s) => policyFresh(s.nodeId), expected: "ok" },
    { name: "G0 control, listed", listed: true, prepare: (s) => policyFresh(s.nodeId), expected: "ok" },
    // The runtime gate runs before the fresh gate: --fresh does not get past it.
    { name: "G1 runtime differs from the snapshot's: unlisted", listed: false, prepare: (s) => policyFresh(s.nodeId), afterSnapshot: CHANGE_RUNTIME, expected: "awaiting-decision", says: "saved startup runtime matches" },
    { name: "G2 runtime differs from the snapshot's: listed", listed: true, prepare: (s) => policyFresh(s.nodeId), afterSnapshot: CHANGE_RUNTIME, expected: "awaiting-decision", says: "saved startup runtime matches" },
    // A resumable seat with no token stops; --fresh is the way out, so a listed seat is not stopped.
    { name: "G3 resume_if_possible with no token: unlisted", listed: false, prepare: (s) => DROP_TOKEN(s.nodeId), expected: "awaiting-decision", says: "unresumable" },
    { name: "G4 resume_if_possible with no token: listed starts fresh", listed: true, prepare: (s) => DROP_TOKEN(s.nodeId), expected: "ok" },
    // An earlier occupant left a token but nobody was running at capture.
    { name: "G5 no occupant at capture, an earlier occupant left a token: unlisted", listed: false, afterSnapshot: ABSENT_OCCUPANT, expected: "awaiting-decision", says: "earlier occupant left" },
    { name: "G6 no occupant at capture, an earlier occupant left a token: listed starts fresh", listed: true, afterSnapshot: ABSENT_OCCUPANT, expected: "ok" },
    // The seat was removed after the snapshot; restore does not recreate nodes. Not rescued by --fresh.
    { name: "G7 seat removed since the snapshot: unlisted", listed: false, prepare: (s) => policyFresh(s.nodeId), afterSnapshot: REMOVE_SEAT, expected: "failed", says: "removed after this snapshot" },
    { name: "G8 seat removed since the snapshot: listed", listed: true, prepare: (s) => policyFresh(s.nodeId), afterSnapshot: REMOVE_SEAT, expected: "failed", says: "removed after this snapshot" },
    // Gate order: the runtime gate answers before the token gate, so the runtime's words are the ones restore gives.
    { name: "G9 runtime differs AND no token: restore says the runtime", listed: false, prepare: (s) => DROP_TOKEN(s.nodeId), afterSnapshot: CHANGE_RUNTIME, expected: "awaiting-decision", says: "saved startup runtime matches" },
    // Which saved session is the seat's cannot be told: restore stops it (failed) before the runtime and token gates, and
    // --fresh does not get past it. The check is red with restore's words (the gate walk, not validation, says so).
    { name: "G12 ambiguous occupant, two candidate rows: unlisted", listed: false, prepare: (s) => policyFresh(s.nodeId), afterSnapshot: AMBIGUOUS_OCCUPANT, expected: "failed", says: "Active-occupant ambiguity" },
    { name: "G13 ambiguous occupant, two candidate rows: listed", listed: true, prepare: (s) => policyFresh(s.nodeId), afterSnapshot: AMBIGUOUS_OCCUPANT, expected: "failed", says: "Active-occupant ambiguity" },
    { name: "G14 legacy snapshot, explicit-null occupant relation", listed: false, prepare: (s) => policyFresh(s.nodeId), afterSnapshot: LEGACY_NULL_OCCUPANT, expected: "failed", says: "Active-occupant ambiguity" },
    // A runtime that differs from the snapshot's answers before the `restoring` skip, so a restoring seat is still stopped.
    { name: "G15 runtime differs AND continuity is restoring: the runtime answers before the skip", listed: false, prepare: (s) => policyFresh(s.nodeId), afterSnapshot: (snapshotId, s) => { CHANGE_RUNTIME(snapshotId); CONTINUITY(s.nodeId, "restoring"); }, expected: "awaiting-decision", says: "saved startup runtime matches" },
    // Pre-restore validation refuses the whole restore (the seat's own saved startup file is gone) before any seat is looked at,
    // so the runtime gate behind it never answers: the check is red for the validation blocker alone and does not also
    // claim the seat.
    { name: "G11 validation refuses the snapshot, so the seat gates are never reached", listed: false, prepare: (s) => { policyFresh(s.nodeId); GONE_OWN_FILE(s.nodeId); }, afterSnapshot: CHANGE_RUNTIME, expected: "restore-ended", says: "/nonexistent/of40/role.md" },
  ];

  it.each(ROWS.map((row) => [row.name, row] as const))("%s", async (_name, row) => {
    h = createRestoreHarness();
    const seat = await h.launchRig();
    row.prepare?.(seat);
    const snapshotId = await h.down(seat.rigId);
    await row.afterSnapshot?.(snapshotId, seat);

    const check = await runCheck(row.listed);
    const restore = await runRestore(snapshotId, row.listed);

    expect(restore.status, "the table's own expectation of restore").toBe(row.expected);
    // Never looser, never stricter: red exactly when restore stops the seat.
    expect(check.status === "red", `check ${check.status}: ${check.evidence}`).toBe(restore.status !== "ok");
    // And it says what restore says: the stop reason is restore's own text.
    if (restore.error) expect(check.evidence).toContain(restore.error);
    if (row.says) {
      if (restore.error !== null) expect(restore.error, "the table's own expectation of which gate answered").toContain(row.says);
      expect(check.evidence).toContain(row.says);
    }
    // Restore stopped before any seat: the check names the validation blocker and claims nothing about the seat.
    if (row.expected === "restore-ended") expect(check.evidence).not.toContain("Restore would not start");
  });

  it("G16 a no-token stop keeps the degraded-continuity warning restore gives (and a seat that proceeds keeps it too)", async () => {
    for (const noToken of [true, false]) {
      h = createRestoreHarness();
      const seat = await h.launchRig();
      if (noToken) DROP_TOKEN(seat.nodeId); else policyFresh(seat.nodeId);
      const snapshotId = await h.down(seat.rigId);
      CONTINUITY(seat.nodeId, "degraded");

      const restore = await runRestore(snapshotId, false);

      expect(restore.status, `noToken=${noToken}`).toBe(noToken ? "awaiting-decision" : "ok");
      expect(restore.warnings.filter((w) => w.includes("continuity state is 'degraded'")), `noToken=${noToken}: ${JSON.stringify(restore.warnings)}`).toHaveLength(1);
      h.cleanup();
    }
  });

  it("G10 a pod seat whose continuity is 'restoring' is skipped as fresh by restore; the no-token gate behind it never runs, so the check is not red", async () => {
    h = createRestoreHarness();
    const seat = await h.launchRig();
    DROP_TOKEN(seat.nodeId);
    const snapshotId = await h.down(seat.rigId);
    const podId = (h.db.prepare("SELECT pod_id AS p FROM nodes WHERE id = ?").get(seat.nodeId) as { p: string }).p;
    h.db.prepare("INSERT OR REPLACE INTO continuity_state (pod_id, node_id, status) VALUES (?, ?, 'restoring')").run(podId, seat.nodeId);

    const check = await runCheck(false);
    const restore = await runRestore(snapshotId, false);

    expect(restore.status).toBe("ok");
    expect(check.status, check.evidence).not.toBe("red");
  });

  // --- recovery: a restore that would not run is not recovery's business -------------------------------------------------
  // Restore refuses a rig with a live seat (rig_not_stopped), so a stop at a seat gate (or a validation blocker) of the
  // snapshot is not what a running rig's recovery verdict is about. Before this scoping, one seat that would stop for a
  // decision turned a RUNNING rig's recovery into "blocked: No exact recovery action is known" and hid the more specific
  // tmux-liveness reasons. Gate predictions are made only where restore would run; validation blockers, which base
  // already counted on a running rig (blocked), are counted for recovery only where restore would run too, the same way.
  describe("recovery follows whether restore would run", () => {
    async function runningRig(shape: (seat: { rigId: string; nodeId: string }) => void) {
      h = createRestoreHarness();
      const seat = await h.launchRig();
      shape(seat);
      h.snapshotCapture.captureSnapshot(seat.rigId, "auto-pre-down");
      return seat;
    }
    async function downRig(shape: (seat: { rigId: string; nodeId: string }) => void) {
      h = createRestoreHarness();
      const seat = await h.launchRig();
      shape(seat);
      await h.down(seat.rigId);
      return seat;
    }

    // F4: with a tmux probe (production always has one) a live seat means restore would refuse the rig.
    it("a running rig (probed) whose latest snapshot has a seat that would stop for a decision still needs no recovery", async () => {
      await runningRig((s) => DROP_TOKEN(s.nodeId));
      const check = await runCheck(false, { probe: true });
      expect(check.recovery.status, JSON.stringify(check.recovery)).toBe("not_needed");
      expect(check.status, check.evidence).not.toBe("red");
      expect(check.evidence).not.toContain("Restore would not start");
    });

    it("a running rig (probed) whose latest snapshot has a validation blocker needs no recovery either, and the check still says so", async () => {
      await runningRig((s) => { policyFresh(s.nodeId); GONE_OWN_FILE(s.nodeId); });
      const check = await runCheck(false, { probe: true });
      expect(check.status, "an explicit restore-check still assesses its next restore").toBe("red");
      expect(check.evidence).toContain("/nonexistent/of40/role.md");
      expect(check.recovery.status, JSON.stringify(check.recovery)).toBe("not_needed");
    });

    // Q8: a check built without tmux cannot tell whether a DB-running seat is live, stale or unreadable, so whether restore
    // would run is UNKNOWN: the gates are not predicted and the check says so (yellow), never green; recovery is as base.
    it("a check built without tmux says it could not predict the gates of a rig with a running seat (yellow, never green)", async () => {
      await runningRig((s) => DROP_TOKEN(s.nodeId));
      const check = await runCheck(false);
      expect(check.status).toBe("yellow");
      expect(check.evidence).toContain("tmux was not read");
      expect(check.evidence).not.toContain("Restore would not start");
    });

    it("a check built without tmux still counts a validation blocker for recovery, as base did", async () => {
      await runningRig((s) => { policyFresh(s.nodeId); GONE_OWN_FILE(s.nodeId); });
      const check = await runCheck(false);
      expect(check.status).toBe("red");
      expect(check.recovery.status).toBe("blocked");
    });

    it("control: a stopped rig with a seat that would stop for a decision is blocked, in restore's words", async () => {
      await downRig((s) => DROP_TOKEN(s.nodeId));
      const check = await runCheck(false);
      expect(check.recovery.status).toBe("blocked");
      expect(check.recovery.blocked[0]!.reason).toContain("Original session unresumable");
    });

    it("control: a stopped rig with a validation blocker is blocked", async () => {
      await downRig((s) => { policyFresh(s.nodeId); GONE_OWN_FILE(s.nodeId); });
      const check = await runCheck(false);
      expect(check.recovery.status).toBe("blocked");
      expect(check.recovery.blocked[0]!.reason).toContain("/nonexistent/of40/role.md");
    });
  });
});
