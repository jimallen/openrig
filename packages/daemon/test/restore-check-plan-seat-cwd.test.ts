// OF-69 (review F3): a seat whose recorded folder was deleted is refused by the launcher (tmux would start it in $HOME).
// Production consequence: `rig restore-check` stayed green and `rig up --existing <rig> --plan` forecast the seat as started,
// and the restore then reported it failed. Each row runs the REAL RestoreOrchestrator, the REAL RestoreCheckService and the
// REAL buildRestorePlanPreview over the same rig and requires the check and the plan to say what restore says.
//
// Deployed entrypoints: startup.ts constructs RestoreOrchestrator over NodeLauncher; server.ts mounts routes/restore-check.ts
// and routes/up.ts (plan=true -> buildRestorePlanPreview).
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createRestoreHarness, type RestoreHarness } from "./helpers/restore-fresh-harness.js";
import { createRestoreCheckService } from "../src/routes/restore-check.js";
import { buildRestorePlanPreview, collectPreviewSessionRows, readPreviewContinuity } from "../src/domain/restore-plan-preview.js";

describe("restore, restore-check and --plan agree on a seat whose folder is gone (OF-69)", () => {
  let h: RestoreHarness;
  afterEach(() => h.cleanup());

  const SEAT = "dev.impl";
  const exists = (p: string) => fs.existsSync(p);

  async function check() {
    const service = createRestoreCheckService(h.rigRepo, h.snapshotRepo, undefined, { runtimeAdapters: { "claude-code": h.adapter }, specReader: h.inst });
    const result = await service.checkWithLiveness({ rig: "team", noQueue: true, noHooks: true } as never);
    return { result, cwd: result.checks.find((c) => c.check.endsWith(".cwd")) };
  }
  function plan(rigId: string, snapshotId: string | null) {
    const rig = h.rigRepo.getRig(rigId)!;
    const snapshot = snapshotId ? h.snapshotRepo.getSnapshot(snapshotId)! : null;
    return buildRestorePlanPreview(rig, snapshot, collectPreviewSessionRows(h.db, rig, snapshot), undefined, Date.now(), {}, new Map(), readPreviewContinuity(h.db, rig))
      .nodes.find((n) => n.logicalId === SEAT)!;
  }

  it("a deleted folder: restore reports the seat failed with the launcher's code; the check is red and the plan does not forecast a start", async () => {
    h = createRestoreHarness();
    const seat = await h.launchRig();
    const snapshotId = await h.down(seat.rigId);
    fs.rmSync(h.workdir, { recursive: true });
    const wording = `its cwd '${h.workdir}' does not exist, and a seat launched there would silently start in $HOME. Create the folder ${h.workdir}, then launch it again.`;

    // Ground truth: what restore does. Nothing is started, and the failure keeps the launcher's code.
    const out = await h.restore.restore(snapshotId, { adapters: { "claude-code": h.adapter }, fsOps: { exists } } as never);
    expect(out.ok).toBe(true);
    const node = out.ok ? out.result.nodes.find((n) => n.logicalId === SEAT) : undefined;
    expect(node).toMatchObject({ status: "failed", errorCode: "seat_cwd_unusable" });
    expect(node?.error).toBe(`${SEAT} was not started: ${wording}`);

    // The check: red, naming the folder and the fix, classed as a restore input (no `rig up --existing` is advised for it).
    const { result, cwd } = await check();
    expect(cwd, "a cwd check is emitted").toBeDefined();
    expect(cwd!.status).toBe("red");
    expect(cwd!.evidence).toBe(`${SEAT} was not started: ${wording}`);
    expect(cwd!.remediation).toContain(`Create the folder ${h.workdir}`);
    expect(result.verdict).toBe("not_restorable");
    expect(JSON.stringify(result.recovery.actions)).not.toContain("rig up --existing");

    // The plan, from the snapshot and from live rows: the seat is not forecast to start.
    for (const from of [snapshotId, null]) {
      const forecast = plan(seat.rigId, from);
      expect({ from: from ? "snapshot" : "live", action: forecast.intendedAction, status: forecast.restoreStatus }).toEqual({ from: from ? "snapshot" : "live", action: "awaiting-decision", status: "failed" });
      expect(forecast.reason).toBe(`${SEAT} was not started: ${wording}`);
    }
  });

  it("control: with the folder in place the check has no cwd entry and the plan forecasts a start", async () => {
    h = createRestoreHarness();
    const seat = await h.launchRig();
    const snapshotId = await h.down(seat.rigId);

    expect((await check()).cwd).toBeUndefined();
    for (const from of [snapshotId, null]) expect(plan(seat.rigId, from).intendedAction).not.toBe("awaiting-decision");
  });
});
