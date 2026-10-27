// OF-69 (review F3): a seat whose recorded folder was deleted is refused by the launcher (tmux would start it in $HOME).
// Production consequence: `rig restore-check` stayed green and `rig up --existing <rig> --plan` forecast the seat as started,
// and the restore then reported it failed. Each row runs the REAL RestoreOrchestrator, the REAL RestoreCheckService and the
// REAL buildRestorePlanPreview over the same rig and requires the check and the plan to say what restore says.
//
// Deployed entrypoints: startup.ts constructs RestoreOrchestrator over NodeLauncher; server.ts mounts routes/restore-check.ts
// and routes/up.ts (plan=true -> buildRestorePlanPreview).
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  // OF-128 L7 (Jim, 2026-10-27): a seat with no live cwd is started in the snapshot's cwd. The check and the plan judge the
  // folder restore will really use, so the three agree. Production consequence: a regrown seat with no cwd of its own stayed
  // green in the check although restore started it in a snapshot folder that was gone.
  describe("a seat with no live cwd is judged on the snapshot's folder (OF-128 L7)", () => {
    async function noLiveCwd(opts: { folderGone: boolean }) {
      h = createRestoreHarness();
      const seat = await h.launchRig();
      const snapshotId = await h.down(seat.rigId);
      h.db.prepare("UPDATE nodes SET cwd = NULL WHERE id = ?").run(seat.nodeId);
      if (opts.folderGone) fs.rmSync(h.workdir, { recursive: true });
      return { seat, snapshotId };
    }

    it("the snapshot's folder is gone: restore fails the seat, the check is red naming it, and the plan forecasts no start", async () => {
      const { seat, snapshotId } = await noLiveCwd({ folderGone: true });

      const out = await h.restore.restore(snapshotId, { adapters: { "claude-code": h.adapter }, fsOps: { exists } } as never);
      const node = out.ok ? out.result.nodes.find((n) => n.logicalId === SEAT) : undefined;
      expect(node).toMatchObject({ status: "failed", errorCode: "seat_cwd_unusable" });
      expect(node?.error).toBe(`${SEAT} was not started: ${wording()}`);

      const { result, cwd } = await check();
      expect(cwd?.status, "the check judges the snapshot's folder for a seat with no live cwd").toBe("red");
      expect(cwd?.evidence).toBe(`${SEAT} was not started: ${wording()}`);
      expect(result.verdict).toBe("not_restorable");

      const forecast = plan(seat.rigId, snapshotId);
      expect({ action: forecast.intendedAction, status: forecast.restoreStatus }).toEqual({ action: "awaiting-decision", status: "failed" });
      expect(forecast.reason).toBe(`${SEAT} was not started: ${wording()}`);
    });

    it("control: the snapshot's folder exists, so the check and the plan have no complaint and restore starts the seat in it", async () => {
      const { seat, snapshotId } = await noLiveCwd({ folderGone: false });

      expect((await check()).cwd).toBeUndefined();
      expect(plan(seat.rigId, snapshotId).intendedAction).not.toBe("awaiting-decision");
      const out = await h.restore.restore(snapshotId, { adapters: { "claude-code": h.adapter }, fsOps: { exists } } as never);
      const node = out.ok ? out.result.nodes.find((n) => n.logicalId === SEAT) : undefined;
      expect(node?.status).not.toBe("failed");
      expect(vi.mocked(h.tmux.createSession).mock.calls.at(-1)![1], "restore started the seat in the snapshot's folder").toBe(h.workdir);
    });
  });

  // OF-125 (review-u12 N1, N2): the check names a missing folder only for a seat restore would START (the plan's rule). A seat
  // that is bound is running and is not started; a seat restore stops at a gate is not started either. Production consequence of
  // judging every non-green seat: a running seat whose tmux was briefly unreadable got "X was not started: ..." and the rig
  // went not_restorable, though restore would start nothing for it.
  describe("the cwd entry follows the plan's rule: only a seat restore would start (OF-125)", () => {
    it("a running, ready seat with its folder gone gets no cwd entry", async () => {
      h = createRestoreHarness();
      await h.launchRig();
      fs.rmSync(h.workdir, { recursive: true });
      const { cwd, result } = await check();
      expect(result.checks.some((c) => c.check.endsWith(".readiness") && c.status === "green"), "the population: the seat reads running and ready").toBe(true);
      expect(cwd).toBeUndefined();
    });

    it("a BOUND running seat whose tmux cannot be read (readiness not green) gets no cwd entry", async () => {
      h = createRestoreHarness();
      await h.launchRig();
      fs.rmSync(h.workdir, { recursive: true });
      vi.mocked(h.tmux.hasSession).mockImplementation(async () => { throw new Error("tmux probe failed (injected)"); });
      vi.mocked(h.tmux.probeSession!).mockImplementation(async () => { throw new Error("tmux probe failed (injected)"); });
      const service = createRestoreCheckService(h.rigRepo, h.snapshotRepo, h.tmux, { runtimeAdapters: { "claude-code": h.adapter }, specReader: h.inst });
      const result = await service.checkWithLiveness({ rig: "team", noQueue: true, noHooks: true } as never);
      const readiness = result.checks.find((c) => c.check.endsWith(".readiness"))!;
      expect(readiness.status, "the population: readiness is not green, which is what used to admit the cwd entry").not.toBe("green");
      expect(result.checks.find((c) => c.check.endsWith(".cwd"))).toBeUndefined();
      expect(result.checks.some((c) => c.evidence.includes("was not started"))).toBe(false);
    });

    it("a seat restore stops at a gate (its runtime changed) gets no cwd entry, only the gate", async () => {
      h = createRestoreHarness();
      const seat = await h.launchRig();
      await h.down(seat.rigId);
      h.db.prepare("UPDATE nodes SET runtime = 'codex' WHERE id = ?").run(seat.nodeId);
      fs.rmSync(h.workdir, { recursive: true });
      const { result, cwd } = await check();
      expect(cwd).toBeUndefined();
      const preconditions = result.checks.find((c) => c.check.endsWith("restore-preconditions"))!;
      expect(preconditions.evidence, "the population: restore does stop this seat").toContain("Restore would not start");
    });
  });
});
