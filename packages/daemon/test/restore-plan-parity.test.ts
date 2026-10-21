// OF-44: `rig up --existing <rig> --plan` must not forecast a different outcome than the restore it previews.
// Production consequence: the operator reads the plan ("resume-original", or no mention of a seat), runs
// `rig up --existing <rig>`, and restore stops the seat (failed / awaiting-decision, nothing started), skips it, or
// starts it fresh. The plan is built from the same gate function restore calls (restore-seat-gates.ts), so each row runs
// the REAL RestoreOrchestrator and the REAL buildRestorePlanPreview over the same snapshot and requires them to agree,
// and the plan to carry restore's own error text.
//
// Deployed entrypoint: server.ts mounts routes/up.ts (`POST /api/up`, `/api/rigs/:id/up` with plan=true), which calls
// buildRestorePlanPreview; startup.ts constructs RestoreOrchestrator, whose restoreNodeUnisolated calls
// decideSeatPreLaunchGate. A removed seat is reachable in production: `rig remove-node` deletes the node row and keeps
// the rig's snapshots (the removal row uses RigLifecycleService.removeNode, as restore-check-predicts-gates does).
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createRestoreHarness, type RestoreHarness } from "./helpers/restore-fresh-harness.js";
import { buildRestorePlanPreview, collectPreviewSessionRows, readPreviewContinuity } from "../src/domain/restore-plan-preview.js";
import { RigLifecycleService } from "../src/domain/rig-lifecycle-service.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { EventBus } from "../src/domain/event-bus.js";

describe("rig up --plan and restore agree on the pre-launch gates", () => {
  let h: RestoreHarness;
  afterEach(() => h.cleanup());

  const SEAT = "dev.impl";
  const exists = (p: string) => fs.existsSync(p);
  const policyFresh = (nodeId: string) => h.db.prepare("UPDATE sessions SET restore_policy = 'checkpoint_only' WHERE node_id = ?").run(nodeId);
  const editSnapshot = (snapshotId: string, edit: (data: any) => void) => {
    const row = h.db.prepare("SELECT data FROM snapshots WHERE id = ?").get(snapshotId) as { data: string };
    const data = JSON.parse(row.data);
    edit(data);
    h.db.prepare("UPDATE snapshots SET data = ? WHERE id = ?").run(JSON.stringify(data), snapshotId);
  };
  const CHANGE_RUNTIME = (snapshotId: string) => editSnapshot(snapshotId, (data) => {
    for (const key of Object.keys(data.nodeStartupContext)) data.nodeStartupContext[key].runtime = "codex";
  });
  const DROP_TOKEN = (nodeId: string) => h.db.prepare("UPDATE sessions SET resume_token = NULL WHERE node_id = ?").run(nodeId);
  // A token the seat holds but no recorded resume SOURCE: restore starts it fresh (resumeRequested is false), it does not stop.
  const TOKEN_NO_SOURCE = (nodeId: string) => h.db.prepare("UPDATE sessions SET resume_type = NULL WHERE node_id = ?").run(nodeId);
  const ABSENT_OCCUPANT = (snapshotId: string) => editSnapshot(snapshotId, (data) => {
    data.activeOccupantsByNode = Object.fromEntries(data.nodes.map((node: { id: string }) => [node.id, { kind: "absent" }]));
    data.activeSessionIdByNode = Object.fromEntries(data.nodes.map((node: { id: string }) => [node.id, null]));
  });
  const podOf = (nodeId: string) => (h.db.prepare("SELECT pod_id AS p FROM nodes WHERE id = ?").get(nodeId) as { p: string }).p;
  const CONTINUITY = (nodeId: string, status: string) => h.db.prepare("INSERT OR REPLACE INTO continuity_state (pod_id, node_id, status) VALUES (?, ?, ?)").run(podOf(nodeId), nodeId, status);
  const AMBIGUOUS_OCCUPANT = (snapshotId: string) => editSnapshot(snapshotId, (data) => {
    const node = data.nodes.find((candidate: { logicalId: string }) => candidate.logicalId === SEAT);
    const first = data.sessions.find((session: { nodeId: string }) => session.nodeId === node.id);
    data.sessions.push({ ...first, id: "01ZZZZZZZZOF44AMBIGUOUS02", sessionName: "dev-impl-second@team" });
    data.activeOccupantsByNode = { ...(data.activeOccupantsByNode ?? {}), [node.id]: { kind: "ambiguous", candidateIds: [first.id, "01ZZZZZZZZOF44AMBIGUOUS02"] } };
  });
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

  /** What restore did with the seat: stopped (its status and error), skipped, or went on to launch it. */
  type Restored = { outcome: "stopped"; status: "failed" | "awaiting-decision"; error: string } | { outcome: "skipped" } | { outcome: "launched"; status: string };
  async function runRestore(snapshotId: string, listed: boolean): Promise<Restored> {
    const out = await h.restore.restore(snapshotId, { adapters: { "claude-code": h.adapter }, fsOps: { exists }, ...(listed ? { freshLogicalIds: [SEAT] } : {}) } as never);
    if (!out.ok) throw new Error(`restore ended: ${JSON.stringify(out)}`);
    const node = out.result.nodes.find((n) => n.logicalId === SEAT)!;
    if (node.status === "awaiting-decision" || node.status === "failed") return { outcome: "stopped", status: node.status, error: node.error ?? "" };
    if (node.status === "fresh" && (out.result.warnings ?? []).some((w) => w.includes("continuity state is 'restoring'"))) return { outcome: "skipped" };
    return { outcome: "launched", status: node.status };
  }

  function planFor(snapshotId: string, rigId: string, listed: boolean) {
    const rig = h.rigRepo.getRig(rigId)!;
    const snapshot = h.snapshotRepo.getSnapshot(snapshotId)!;
    const plan = buildRestorePlanPreview(rig, snapshot, collectPreviewSessionRows(h.db, rig, snapshot), listed ? [SEAT] : undefined, Date.now(), {}, new Map(), readPreviewContinuity(h.db, rig));
    return plan.nodes.filter((n) => n.logicalId === SEAT);
  }

  interface Row {
    name: string;
    listed: boolean;
    prepare?(seat: { rigId: string; nodeId: string }): void;
    afterSnapshot?(snapshotId: string, seat: { rigId: string; nodeId: string }): Promise<void> | void;
    /** The table's own expectation of restore, so a row that stopped asserting its state fails loudly. */
    expected: "failed" | "awaiting-decision" | "skipped" | "launched";
    /** For a launched seat: the intended action the plan must give (restore resumed it, or started it fresh). */
    action?: "resume-original" | "fresh-primed";
    says?: string;
  }
  const ROWS: Row[] = [
    // Controls: restore launches the seat.
    { name: "P0 control: policy checkpoint_only starts fresh", listed: false, prepare: (s) => policyFresh(s.nodeId), expected: "launched", action: "fresh-primed" },
    { name: "P1 control: resumable seat", listed: false, expected: "launched", action: "resume-original" },
    { name: "P2 control: listed seat starts fresh", listed: true, expected: "launched", action: "fresh-primed" },
    // Runtime gate (--fresh does not get past it).
    { name: "P3 runtime differs: unlisted", listed: false, prepare: (s) => policyFresh(s.nodeId), afterSnapshot: CHANGE_RUNTIME, expected: "awaiting-decision", says: "saved startup runtime matches" },
    { name: "P4 runtime differs: listed", listed: true, prepare: (s) => policyFresh(s.nodeId), afterSnapshot: CHANGE_RUNTIME, expected: "awaiting-decision", says: "saved startup runtime matches" },
    // No-token gate.
    { name: "P5 resume_if_possible with no token: unlisted", listed: false, prepare: (s) => DROP_TOKEN(s.nodeId), expected: "awaiting-decision", says: "unresumable" },
    { name: "P6 resume_if_possible with no token: listed starts fresh", listed: true, prepare: (s) => DROP_TOKEN(s.nodeId), expected: "launched", action: "fresh-primed" },
    // Absent-history gate.
    { name: "P7 no occupant at capture, an earlier occupant left a token: unlisted", listed: false, afterSnapshot: ABSENT_OCCUPANT, expected: "awaiting-decision", says: "earlier occupant left" },
    { name: "P8 no occupant at capture, an earlier occupant left a token: listed starts fresh", listed: true, afterSnapshot: ABSENT_OCCUPANT, expected: "launched", action: "fresh-primed" },
    // Removed seat: restore reports it failed; the plan used to list live nodes only and omit it.
    { name: "P9 seat removed since the snapshot: unlisted", listed: false, prepare: (s) => policyFresh(s.nodeId), afterSnapshot: REMOVE_SEAT, expected: "failed", says: "removed after this snapshot" },
    { name: "P10 seat removed since the snapshot: listed", listed: true, prepare: (s) => policyFresh(s.nodeId), afterSnapshot: REMOVE_SEAT, expected: "failed", says: "removed after this snapshot" },
    // Gate order.
    { name: "P11 runtime differs AND no token: the runtime answers", listed: false, prepare: (s) => DROP_TOKEN(s.nodeId), afterSnapshot: CHANGE_RUNTIME, expected: "awaiting-decision", says: "saved startup runtime matches" },
    // Occupant ambiguity: restore reports `failed` (the plan said awaiting-decision with no way to see which).
    { name: "P12 ambiguous occupant: unlisted", listed: false, prepare: (s) => policyFresh(s.nodeId), afterSnapshot: AMBIGUOUS_OCCUPANT, expected: "failed", says: "Active-occupant ambiguity" },
    { name: "P13 ambiguous occupant: listed", listed: true, prepare: (s) => policyFresh(s.nodeId), afterSnapshot: AMBIGUOUS_OCCUPANT, expected: "failed", says: "Active-occupant ambiguity" },
    { name: "P14 legacy snapshot, explicit-null occupant relation", listed: false, prepare: (s) => policyFresh(s.nodeId), afterSnapshot: LEGACY_NULL_OCCUPANT, expected: "failed", says: "Active-occupant ambiguity" },
    // Token but no recorded source: restore does not stop; it starts the seat fresh. The plan used to ask for a decision.
    { name: "P15 token with no recorded resume source: restore starts it fresh", listed: false, prepare: (s) => TOKEN_NO_SOURCE(s.nodeId), expected: "launched", action: "fresh-primed" },
    // Continuity `restoring`: restore skips the seat (reports fresh, starts nothing); the plan used to forecast a resume.
    { name: "P16 continuity restoring on a resumable seat: restore skips it", listed: false, afterSnapshot: (_id, s) => CONTINUITY(s.nodeId, "restoring"), expected: "skipped" },
    { name: "P17 continuity restoring AND no token: the skip answers before the token gate", listed: false, prepare: (s) => DROP_TOKEN(s.nodeId), afterSnapshot: (_id, s) => CONTINUITY(s.nodeId, "restoring"), expected: "skipped" },
    { name: "P18 continuity restoring, listed: restore still skips it", listed: true, afterSnapshot: (_id, s) => CONTINUITY(s.nodeId, "restoring"), expected: "skipped" },
    { name: "P19 runtime differs AND continuity restoring: the runtime answers before the skip", listed: false, prepare: (s) => policyFresh(s.nodeId), afterSnapshot: (snapshotId, s) => { CHANGE_RUNTIME(snapshotId); CONTINUITY(s.nodeId, "restoring"); }, expected: "awaiting-decision", says: "saved startup runtime matches" },
  ];

  it.each(ROWS.map((row) => [row.name, row] as const))("%s", async (_name, row) => {
    h = createRestoreHarness();
    const seat = await h.launchRig();
    row.prepare?.(seat);
    const snapshotId = await h.down(seat.rigId);
    await row.afterSnapshot?.(snapshotId, seat);

    // Plan first (read-only), then restore, as an operator would.
    const nodes = planFor(snapshotId, seat.rigId, row.listed);
    const restore = await runRestore(snapshotId, row.listed);

    expect(restore.outcome === "stopped" ? restore.status : restore.outcome, "the table's own expectation of restore").toBe(row.expected);
    // The seat is in the plan exactly once, removed or not.
    expect(nodes.map((n) => n.logicalId), "the seat appears in the plan once").toEqual([SEAT]);
    const node = nodes[0]!;
    if (restore.outcome === "stopped") {
      expect(node.intendedAction).toBe("awaiting-decision");
      expect(node.restoreStatus, "the status restore reports").toBe(restore.status);
      expect(node.reason, "restore's own text").toBe(restore.error);
      expect(node.freshRequired, "a gate --fresh cannot get past does not suggest --fresh").toBe(
        !["node_removed", "occupant_ambiguous", "runtime_mismatch"].some((g) => restore.error.length > 0 && gateOf(restore.error) === g),
      );
      if (row.says) expect(restore.error).toContain(row.says);
    } else if (restore.outcome === "skipped") {
      expect(node.intendedAction).toBe("fresh-primed");
      expect(node.restoreStatus).toBeUndefined();
      expect(node.reason).toContain("continuity state is 'restoring'");
    } else {
      expect(node.intendedAction, "restore launched it; the plan does not ask for a decision").toBe(row.action);
      expect(node.restoreStatus).toBeUndefined();
    }
  });

  /** Which gate a stop text belongs to (the table asserts the text itself against restore above). */
  function gateOf(error: string): string {
    if (error.includes("removed after this snapshot")) return "node_removed";
    if (error.includes("Active-occupant ambiguity")) return "occupant_ambiguous";
    if (error.includes("saved startup runtime matches")) return "runtime_mismatch";
    return "other";
  }
});
