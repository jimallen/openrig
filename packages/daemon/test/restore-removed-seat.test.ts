// OF-128 N6 (review-u14): restoring a one-seat rig whose only seat was removed ended in `restore_error` ("Snapshot intended
// roster must contain unique node ids belonging to the target rig") instead of reporting the seat failed.
//
// Cause (traced): that error is the pre-restore capture refusing a roster that names a node the rig no longer has. The
// review's harness removed the seat with a bare `DELETE FROM nodes`, which leaves the rig's last `topology.roster_recorded`
// event naming it. The only production deletion of a node is RigLifecycleService.removeNode (`rig remove`, and `rig shrink`
// through it), which records the new roster in the same transaction. These rows remove the seat the production way and show
// restore reports it as failed, and keep the bare-delete shape as the documented boundary.
//
// Deployed entrypoint: server.ts constructs RigLifecycleService (rig remove / shrink); startup.ts constructs RestoreOrchestrator.
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRestoreHarness, type RestoreHarness } from "./helpers/restore-fresh-harness.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { RigLifecycleService } from "../src/domain/rig-lifecycle-service.js";

const SEAT = "dev.impl";

describe("restoring a rig whose only seat was removed (OF-128 N6)", () => {
  let h: RestoreHarness;
  afterEach(() => h?.cleanup());
  const exists = (p: string) => fs.existsSync(p);

  it("a seat removed with rig remove is reported failed ('not found in rig'), not a restore_error", async () => {
    h = createRestoreHarness();
    const seat = await h.launchRig();
    const snapshotId = await h.down(seat.rigId);
    const eventBus = new EventBus(h.db);
    const lifecycle = new RigLifecycleService({
      db: h.db, rigRepo: h.rigRepo, sessionRegistry: h.sessionRegistry, discoveryRepo: new DiscoveryRepository(h.db), eventBus,
      queueRepo: new QueueRepository(h.db, eventBus, { validateRig: () => true }),
      tmuxAdapter: { killSession: vi.fn(async () => ({ ok: true as const })), hasSession: vi.fn(async () => true) } as never,
    });
    expect(await lifecycle.removeNode(seat.rigId, SEAT)).toMatchObject({ ok: true });
    expect(h.rigRepo.getRig(seat.rigId)!.nodes, "the population: the rig has no seat left").toHaveLength(0);

    const out = await h.restore.restore(snapshotId, { adapters: { "claude-code": h.adapter }, fsOps: { exists } } as never);

    expect(out.ok ? null : `${out.code}: ${out.message}`).toBeNull();
    if (!out.ok) return;
    expect(out.result.nodes).toEqual([expect.objectContaining({ logicalId: SEAT, status: "failed", error: expect.stringContaining("not found in rig") })]);
  });

  it("boundary: a seat deleted with a bare DELETE (no roster recorded) is still a restore_error; no production path does that", async () => {
    h = createRestoreHarness();
    const seat = await h.launchRig();
    const snapshotId = await h.down(seat.rigId);
    h.db.prepare("DELETE FROM bindings WHERE node_id = ?").run(seat.nodeId);
    h.db.prepare("DELETE FROM nodes WHERE id = ?").run(seat.nodeId);

    const out = await h.restore.restore(snapshotId, { adapters: { "claude-code": h.adapter }, fsOps: { exists } } as never);

    expect(out).toMatchObject({ ok: false, code: "restore_error" });
    expect(!out.ok && out.message).toContain("Snapshot intended roster must contain unique node ids");
  });
});
