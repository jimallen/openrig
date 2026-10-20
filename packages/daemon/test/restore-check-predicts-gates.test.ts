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
// Not in this table: the active-occupant ambiguity gate. A snapshot with an ambiguous occupant is refused whole before
// any seat ("No usable snapshot", snapshot-repository selectRestoreUsable), by restore and by the check alike, so the
// gate behind it is not reachable through restore(); only the restore-side tests that call it directly pin it.
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

  async function runCheck(listed: boolean) {
    const service = createRestoreCheckService(h.rigRepo, h.snapshotRepo, undefined, { runtimeAdapters: { "claude-code": h.adapter }, specReader: h.inst });
    const result = await service.checkWithLiveness({ rig: "team", noQueue: true, noHooks: true, ...(listed ? { freshLogicalIds: [SEAT] } : {}) } as never);
    const pre = result.checks.find((c) => c.check === "rig.team.restore-preconditions")!;
    return { status: pre.status, evidence: pre.evidence };
  }

  async function runRestore(snapshotId: string, listed: boolean): Promise<{ status: Status; error: string | null }> {
    try {
      const out = await h.restore.restore(snapshotId, { adapters: { "claude-code": h.adapter }, fsOps: { exists }, ...(listed ? { freshLogicalIds: [SEAT] } : {}) } as never);
      if (!out.ok) return { status: "restore-ended", error: null };
      const node = out.result.nodes.find((n) => n.logicalId === SEAT)!;
      const stopped = node.status === "awaiting-decision" || node.status === "failed";
      return { status: stopped ? (node.status as Status) : "ok", error: node.error ?? null };
    } catch {
      return { status: "restore-ended", error: null };
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
});
