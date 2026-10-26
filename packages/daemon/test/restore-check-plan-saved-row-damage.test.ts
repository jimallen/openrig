// OF-62 (review-integ-20261021a N1): a seat whose saved node row is damaged (nodes.session_source_json or
// nodes.package_refs not what was written, OF-45) makes restore refuse: its pre-restore snapshot is a capture of the
// live rig, and that capture refuses on the damage. Production consequence measured before this change: `rig
// restore-check` stayed green on that rig and `rig up --existing <rig> --plan` forecast the seat as "fresh-primed", the
// operator ran the restore and it refused with the capture's error, nothing started.
//
// Each row runs the REAL RestoreOrchestrator, the REAL RestoreCheckService and the REAL buildRestorePlanPreview over the
// same damaged rig and requires the check and the plan to say what restore says. The restore's refusal text is restated
// here (not imported) so the three can each fail on their own.
//
// Deployed entrypoints: startup.ts constructs RestoreOrchestrator (captureSnapshot "pre_restore"); server.ts mounts
// routes/restore-check.ts (createRestoreCheckService wires getSavedRowDamage) and routes/up.ts (plan=true ->
// buildRestorePlanPreview).
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createRestoreHarness, type RestoreHarness } from "./helpers/restore-fresh-harness.js";
import { createRestoreCheckService } from "../src/routes/restore-check.js";
import { buildRestorePlanPreview, collectPreviewSessionRows, readPreviewContinuity } from "../src/domain/restore-plan-preview.js";

describe("restore-check and --plan say restore refuses a damaged saved row", () => {
  let h: RestoreHarness;
  afterEach(() => h.cleanup());

  const SEAT = "dev.impl";
  const exists = (p: string) => fs.existsSync(p);

  const COLUMNS = [
    { name: "session_source_json not JSON", column: "session_source_json", text: "{not json", reason: "session_source_json is not JSON" },
    { name: "session_source_json wrong shape", column: "session_source_json", text: "[1]", reason: "session_source_json is not an object" },
    { name: "package_refs not JSON", column: "package_refs", text: "{not json", reason: "package_refs is not JSON" },
    { name: "package_refs wrong shape", column: "package_refs", text: "[1]", reason: "package_refs is not a list of strings" },
  ] as const;

  async function check() {
    const service = createRestoreCheckService(h.rigRepo, h.snapshotRepo, undefined, { runtimeAdapters: { "claude-code": h.adapter }, specReader: h.inst });
    const result = await service.checkWithLiveness({ rig: "team", noQueue: true, noHooks: true } as never);
    return { result, damage: result.checks.find((c) => c.check === "rig.team.saved-rows") };
  }

  function planWhole(rigId: string, snapshotId: string | null) {
    const rig = h.rigRepo.getRig(rigId)!;
    const snapshot = snapshotId ? h.snapshotRepo.getSnapshot(snapshotId)! : null;
    return buildRestorePlanPreview(rig, snapshot, collectPreviewSessionRows(h.db, rig, snapshot), undefined, Date.now(), {}, new Map(), readPreviewContinuity(h.db, rig));
  }
  function plan(rigId: string, snapshotId: string | null) {
    return planWhole(rigId, snapshotId).nodes.find((n) => n.logicalId === SEAT)!;
  }

  async function restoreError(snapshotId: string): Promise<string> {
    try {
      const out = await h.restore.restore(snapshotId, { adapters: { "claude-code": h.adapter }, fsOps: { exists } } as never);
      // The route's catch maps a thrown capture to this code; restore() itself reports it as restore_error.
      if (!out.ok && out.code === "restore_error") return out.message;
      return `restore did not refuse: ${JSON.stringify(out.ok ? { ok: true } : out)}`;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  it.each(COLUMNS.map((row) => [row.name, row] as const))("%s: restore refuses, and so do the check (red) and the plan (awaiting a decision)", async (_name, row) => {
    h = createRestoreHarness();
    const seat = await h.launchRig();
    const snapshotId = await h.down(seat.rigId);
    h.db.prepare(`UPDATE nodes SET ${row.column} = ? WHERE id = ?`).run(row.text, seat.nodeId);

    // Ground truth: what restore does.
    expect(await restoreError(snapshotId)).toBe(`Cannot snapshot: ${SEAT}'s saved row is damaged (${row.reason}). Repair the row, then snapshot again.`);

    // The check: red, naming the seat and the reason, and the whole verdict says so.
    const { result, damage } = await check();
    expect(damage, "a saved-rows check is emitted").toBeDefined();
    expect(damage!.status).toBe("red");
    expect(damage!.evidence).toBe(`Restore would refuse team: its pre-restore snapshot cannot be taken because ${SEAT}'s saved row is damaged (${row.reason})`);
    expect(damage!.remediation).toContain(SEAT);
    expect(result.verdict).toBe("not_restorable");
    // Review B1: the recovery block must not advise the restore that refuses. It is blocked, with the evidence and the remedy.
    expect(result.recovery.status).not.toBe("actionable");
    expect(result.recovery.actions).toEqual([]);
    expect(JSON.stringify(result.recovery)).not.toContain("rig up --existing");
    const blockedWhy = result.recovery.blocked.map((issue) => issue.reason).join("\n");
    expect(blockedWhy).toContain(`${SEAT}'s saved row is damaged (${row.reason})`);
    expect(blockedWhy).toContain(`Repair the damaged saved row (${SEAT})`);
    // ... and the rig's own rollup (what `rig ps` / status read) carries it as a blocking check.
    expect(result.rigs.find((rig) => rig.rigName === "team")!.blockingChecks.map((c) => c.check)).toContain("rig.team.saved-rows");

    // The plan, from the snapshot and from live rows (no snapshot): the seat is not forecast to start.
    for (const from of [snapshotId, null]) {
      const node = plan(seat.rigId, from);
      expect({ from: from ? "snapshot" : "live", action: node.intendedAction, status: node.restoreStatus }).toEqual({ from: from ? "snapshot" : "live", action: "awaiting-decision", status: "failed" });
      expect(node.savedRowDamage).toEqual([row.reason]);
      expect(node.reason).toBe(`restore would refuse the whole rig: its pre-restore snapshot cannot be taken because ${SEAT}'s saved row is damaged (${row.reason}). Repair the row first.`);
      expect(node.freshRequired).toBe(false);
    }
  });

  it("both columns damaged: both reasons are named, in the order the capture words them", async () => {
    h = createRestoreHarness();
    const seat = await h.launchRig();
    const snapshotId = await h.down(seat.rigId);
    h.db.prepare("UPDATE nodes SET session_source_json = ?, package_refs = ? WHERE id = ?").run("{not json", "{not json", seat.nodeId);
    const both = "session_source_json is not JSON; package_refs is not JSON";
    expect(await restoreError(snapshotId)).toContain(`${SEAT}'s saved row is damaged (${both})`);
    expect((await check()).damage!.evidence).toContain(`${SEAT}'s saved row is damaged (${both})`);
    expect(plan(seat.rigId, snapshotId).savedRowDamage).toEqual(["session_source_json is not JSON", "package_refs is not JSON"]);
  });

  // Review B2: the damaged seat's own status is `failed`, which the plan's other consumers read as "a removed seat, the rest
  // restore". Restore refuses the WHOLE rig, so the plan carries a rig-level refusal beside the per-seat one.
  it("a multi-seat rig: the plan refuses the whole rig and names the seat, while the undamaged seat keeps its own forecast", async () => {
    h = createRestoreHarness();
    const seat = await h.launchRig();
    const second = h.rigRepo.addNode(seat.rigId, "dev.second", { runtime: "claude-code" });
    const snapshotId = await h.down(seat.rigId);
    h.db.prepare("UPDATE nodes SET package_refs = ? WHERE id = ?").run("{not json", seat.nodeId);
    for (const from of [snapshotId, null]) {
      const whole = planWhole(seat.rigId, from);
      expect(whole.nodes.map((n) => n.logicalId).sort()).toEqual([SEAT, "dev.second"]);
      expect(whole.restoreRefusal, from ? "snapshot" : "live").toEqual({
        reason: `restore would refuse the whole rig and start no seat: its pre-restore snapshot cannot be taken because ${SEAT}'s saved row is damaged (package_refs is not JSON). Repair the row first.`,
        seats: [SEAT],
      });
      expect(whole.nodes.find((n) => n.logicalId === "dev.second")!.savedRowDamage).toBeUndefined();
    }
    // Two damaged seats are both named, in rig order.
    h.db.prepare("UPDATE nodes SET session_source_json = ? WHERE id = ?").run("[1]", second.id);
    expect(planWhole(seat.rigId, snapshotId).restoreRefusal!.seats.sort()).toEqual([SEAT, "dev.second"]);
  });

  describe("controls: a readable row is not reported", () => {
    it("an undamaged rig: restore does not refuse, no saved-rows check, the plan resumes the seat", async () => {
      h = createRestoreHarness();
      const seat = await h.launchRig();
      const snapshotId = await h.down(seat.rigId);
      expect(await restoreError(snapshotId)).not.toContain("saved row is damaged");
      expect((await check()).damage).toBeUndefined();
      const node = plan(seat.rigId, snapshotId);
      expect(node.savedRowDamage).toBeUndefined();
      expect(planWhole(seat.rigId, snapshotId).restoreRefusal).toBeUndefined();
      expect(node.intendedAction).toBe("resume-original");
    });

    it("a literal JSON null in the columns is the real 'none': no damage anywhere", async () => {
      h = createRestoreHarness();
      const seat = await h.launchRig();
      const snapshotId = await h.down(seat.rigId);
      h.db.prepare("UPDATE nodes SET session_source_json = 'null', package_refs = 'null' WHERE id = ?").run(seat.nodeId);
      expect((await check()).damage).toBeUndefined();
      expect(plan(seat.rigId, snapshotId).savedRowDamage).toBeUndefined();
    });
  });
});
