// OF-150: restore's stop-for-decision message names the fresh start command (restore-orchestrator freshStartCommand). Like
// every rig advice (OF-135) it names the rig by its id when another unarchived rig shares its name, since `<seat>@<name>`
// would then be ambiguous. Deployed entrypoint: startup.ts constructs RestoreOrchestrator; routes/up.ts calls restore().
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createRestoreHarness, type RestoreHarness } from "./helpers/restore-fresh-harness.js";

describe("restore's fresh-start advice names the rig as advice should (OF-150)", () => {
  let h: RestoreHarness;
  afterEach(() => h?.cleanup());

  it.each([
    ["a unique name", false],
    ["a name another unarchived rig shares", true],
  ] as const)("a seat restore cannot resume (no runtime adapter): the advised command for %s", async (_label, shared) => {
    h = createRestoreHarness();
    const seat = await h.launchRig();
    h.db.prepare("UPDATE sessions SET resume_type = 'claude_session_id', resume_token = 'seat-token' WHERE node_id = ?").run(seat.nodeId);
    const snapshotId = await h.down(seat.rigId);
    if (shared) h.rigRepo.createRig("team");

    const out = await h.restore.restore(snapshotId, { adapters: {}, fsOps: { exists: (p: string) => fs.existsSync(p) } });

    expect(out.ok, JSON.stringify(out)).toBe(true);
    if (!out.ok) throw new Error("restore refused");
    const node = out.result.nodes.find((n) => n.logicalId === "dev.impl");
    expect(node?.status, JSON.stringify(node)).toBe("awaiting-decision");
    const handle = shared ? seat.rigId : "team";
    expect(node?.error).toContain(`To start only this seat fresh, run: rig seat launch 'dev.impl@${handle}' --fresh`);
    if (shared) expect(node?.error).not.toContain("dev.impl@team");
  });
});
