// OF-69 (review F3): a seat whose recorded folder was deleted is refused by the launcher (tmux would start it in $HOME).
// Production consequence: `rig restore-check` stayed green and `rig up --existing <rig> --plan` forecast the seat as started,
// and the restore then reported it failed. Each row runs the REAL RestoreOrchestrator, the REAL RestoreCheckService and the
// REAL buildRestorePlanPreview over the same rig and requires the check and the plan to say what restore says.
//
// Deployed entrypoints: startup.ts constructs RestoreOrchestrator over NodeLauncher; server.ts mounts routes/restore-check.ts
// and routes/up.ts (plan=true -> buildRestorePlanPreview).
import fs from "node:fs";
import path from "node:path";
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

  const wording = () => `its cwd '${h.workdir}' does not exist, and a seat launched there would silently start in $HOME. Create the folder ${h.workdir}, then launch it again.`;
  async function goneFolder() {
    h = createRestoreHarness();
    const seat = await h.launchRig();
    const snapshotId = await h.down(seat.rigId);
    fs.rmSync(h.workdir, { recursive: true });
    return { seat, snapshotId };
  }

  it("a deleted folder: restore reports the seat failed with the launcher's code and starts nothing", async () => {
    const { snapshotId } = await goneFolder();
    const out = await h.restore.restore(snapshotId, { adapters: { "claude-code": h.adapter }, fsOps: { exists } } as never);
    expect(out.ok).toBe(true);
    const node = out.ok ? out.result.nodes.find((n) => n.logicalId === SEAT) : undefined;
    expect(node).toMatchObject({ status: "failed", errorCode: "seat_cwd_unusable" });
    expect(node?.error).toBe(`${SEAT} was not started: ${wording()}`);
  });

  it("a deleted folder: restore-check is red, names the folder and the fix, and advises no rig up --existing", async () => {
    await goneFolder();
    const { result, cwd } = await check();
    expect(cwd, "a cwd check is emitted").toBeDefined();
    expect(cwd!.status).toBe("red");
    expect(cwd!.evidence).toBe(`${SEAT} was not started: ${wording()}`);
    expect(cwd!.remediation).toContain(`Create the folder ${h.workdir}`);
    expect(result.verdict).toBe("not_restorable");
    expect(JSON.stringify(result.recovery.actions)).not.toContain("rig up --existing");
  });

  it("a deleted folder: the plan, from the snapshot, does not forecast a start", async () => {
    const { seat, snapshotId } = await goneFolder();
    // From the snapshot `rig down` took (the plan `rig up --existing --plan` prints). The no-snapshot plan of a downed rig stops
    // at the active-occupant gate before any launch, so it says nothing about the folder.
    const forecast = plan(seat.rigId, snapshotId);
    expect({ action: forecast.intendedAction, status: forecast.restoreStatus }).toEqual({ action: "awaiting-decision", status: "failed" });
    expect(forecast.reason).toBe(`${SEAT} was not started: ${wording()}`);
  });

  it("control: with the folder in place the check has no cwd entry and the plan forecasts a start", async () => {
    h = createRestoreHarness();
    const seat = await h.launchRig();
    const snapshotId = await h.down(seat.rigId);

    expect((await check()).cwd).toBeUndefined();
    expect(plan(seat.rigId, snapshotId).intendedAction).not.toBe("awaiting-decision");
  });
});

// OF-124: a project rig's own `.workspaces/<pod>-<member>` folder is the daemon's; when it is gone (a `git clean -fdx`) restore
// makes it again instead of refusing, and restore-check and --plan must say what restore will do. Any other folder is still
// refused and never created.
describe("restore recreates a project rig's own missing workspace, and only that (OF-124)", () => {
  let h: RestoreHarness;
  afterEach(() => h.cleanup());

  const SEAT = "dev.impl";
  const exists = (p: string) => fs.existsSync(p);

  /** A downed rig named "team" whose seat folder is `<project>/.workspaces/dev-impl`, with `<project>/.workspaces` removed. */
  async function downedWith(projectName: string) {
    h = createRestoreHarness();
    const seat = await h.launchRig();
    const project = path.join(h.root, projectName);
    const seatDir = path.join(project, ".workspaces", "dev-impl");
    fs.mkdirSync(seatDir, { recursive: true });
    h.db.prepare("UPDATE nodes SET cwd = ? WHERE id = ?").run(seatDir, seat.nodeId);
    const snapshotId = await h.down(seat.rigId);
    fs.rmSync(path.join(project, ".workspaces"), { recursive: true });
    return { seat, snapshotId, project, seatDir };
  }
  async function check() {
    const service = createRestoreCheckService(h.rigRepo, h.snapshotRepo, undefined, { runtimeAdapters: { "claude-code": h.adapter }, specReader: h.inst });
    const result = await service.checkWithLiveness({ rig: "team", noQueue: true, noHooks: true } as never);
    return result.checks.find((c) => c.check.endsWith(".cwd"));
  }
  function plan(rigId: string, snapshotId: string) {
    const rig = h.rigRepo.getRig(rigId)!;
    const snapshot = h.snapshotRepo.getSnapshot(snapshotId)!;
    return buildRestorePlanPreview(rig, snapshot, collectPreviewSessionRows(h.db, rig, snapshot), undefined, Date.now(), {}, new Map(), readPreviewContinuity(h.db, rig))
      .nodes.find((n) => n.logicalId === SEAT)!;
  }
  const restoreNode = async (snapshotId: string) => {
    const out = await h.restore.restore(snapshotId, { adapters: { "claude-code": h.adapter }, fsOps: { exists } } as never);
    expect(out.ok).toBe(true);
    return out.ok ? out.result.nodes.find((n) => n.logicalId === SEAT) : undefined;
  };

  it("the project's workspace folder is made again, the seat starts, and check and plan agree", async () => {
    const { seat, snapshotId, seatDir } = await downedWith("team");
    expect(fs.existsSync(seatDir)).toBe(false);
    expect(await check(), "restore-check reports no cwd fault for a folder restore will make").toBeUndefined();
    expect(plan(seat.rigId, snapshotId).intendedAction).not.toBe("awaiting-decision");
    expect(fs.existsSync(seatDir), "check and plan create nothing").toBe(false);

    const node = await restoreNode(snapshotId);
    expect(node?.status).not.toBe("failed");
    expect(node).not.toHaveProperty("errorCode", "seat_cwd_unusable");
    expect(fs.statSync(seatDir).isDirectory()).toBe(true);
  });

  // OF-124 N1: listed fresh with the default spec route, the fresh preflight judged the folder before launchNode could make it.
  it("a seat listed fresh on the spec route also gets its workspace made again", async () => {
    const { snapshotId, seatDir } = await downedWith("team");
    const out = await h.restore.restore(snapshotId, { adapters: { "claude-code": h.adapter }, fsOps: { exists }, freshLogicalIds: [SEAT], startupFrom: "spec" } as never);
    expect(out.ok).toBe(true);
    const node = out.ok ? out.result.nodes.find((n) => n.logicalId === SEAT) : undefined;
    expect(node?.status).not.toBe("failed");
    expect(node?.error ?? "").not.toContain("does not exist");
    expect(fs.statSync(seatDir).isDirectory()).toBe(true);
  });

  it("the same fresh spec route still refuses a folder that is not the project rig's own, and creates nothing", async () => {
    const { snapshotId, project } = await downedWith("other-project");
    const out = await h.restore.restore(snapshotId, { adapters: { "claude-code": h.adapter }, fsOps: { exists }, freshLogicalIds: [SEAT], startupFrom: "spec" } as never);
    const node = out.ok ? out.result.nodes.find((n) => n.logicalId === SEAT) : undefined;
    expect(node?.status).toBe("failed");
    // Refused by the fresh preflight (before any launch), not merely caught later by the launcher's own backstop.
    expect(node?.error).toContain("Fresh start refused");
    expect(node?.error).toContain("does not exist");
    expect(fs.existsSync(path.join(project, ".workspaces"))).toBe(false);
  });

  it("a folder of the same shape in a project the rig is not named for is refused as before, and nothing is created", async () => {
    const { snapshotId, project, seatDir } = await downedWith("other-project");
    const cwd = await check();
    expect(cwd?.status).toBe("red");
    expect(cwd?.evidence).toContain(`its cwd '${seatDir}' does not exist`);
    expect(await restoreNode(snapshotId)).toMatchObject({ status: "failed", errorCode: "seat_cwd_unusable" });
    expect(fs.existsSync(path.join(project, ".workspaces"))).toBe(false);
  });

  it("a project folder that is itself gone is not created", async () => {
    const { snapshotId, project } = await downedWith("team");
    fs.rmSync(project, { recursive: true });
    expect((await check())?.status).toBe("red");
    expect(await restoreNode(snapshotId)).toMatchObject({ status: "failed", errorCode: "seat_cwd_unusable" });
    expect(fs.existsSync(project)).toBe(false);
  });
});
