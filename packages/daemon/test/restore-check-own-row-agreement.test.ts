// OF-39 and OF-41: restore-check must never disagree with restore about a seat's OWN saved startup row.
//  - OF-39: the own row names a runtime that is not the seat's. Filed as: check green, restore leaves the seat awaiting attention.
//  - OF-41: a listed seat, a rig that records no spec source, and an own row that is valid JSON of the wrong shape
//    (startup_actions_json = {}). Filed as: check green, restore fails the seat, and the unlisted blocker's remediation
//    "rig up --existing --fresh" is untrue there.
// Both were filed before OF-36 (a shape-invalid or foreign-runtime own row falls back to the newest usable snapshot copy)
// and OF-40 (one shared seat gate) were deployed. This table runs the REAL RestoreOrchestrator and the REAL
// RestoreCheckService over every combination and requires the verdicts to agree in both directions, so the two cannot
// diverge again whichever of them changes. Production consequence: the check says green, the operator runs
// `rig up --existing <rig>` (optionally `--fresh <seat>`), and the seat stops or fails with nothing useful started; or the
// check says red for a restore that would have come up.
//
// Deployed entrypoint: startup.ts constructs RestoreOrchestrator; server.ts mounts routes/restore-check.ts, which builds
// the check from the modules restore calls (fresh-seat-restore-decision.ts, own-startup-replay.ts, restore-seat-gates.ts).
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createRestoreHarness, type RestoreHarness } from "./helpers/restore-fresh-harness.js";
import { createRestoreCheckService } from "../src/routes/restore-check.js";

type Outcome = "ok" | "awaiting-decision" | "failed" | "restore-ended";

describe("restore-check and restore agree about a seat's own saved startup row (OF-39, OF-41)", () => {
  let h: RestoreHarness;
  afterEach(() => h.cleanup());

  const SEAT = "dev.impl";
  const exists = (p: string) => fs.existsSync(p);
  const setCol = (nodeId: string, col: string, value: string) => h.db.prepare(`UPDATE node_startup_context SET ${col} = ? WHERE node_id = ?`).run(value, nodeId);
  const policyFresh = (nodeId: string) => h.db.prepare("UPDATE sessions SET restore_policy = 'checkpoint_only' WHERE node_id = ?").run(nodeId);

  async function runCheck(listed: boolean) {
    const service = createRestoreCheckService(h.rigRepo, h.snapshotRepo, undefined, { runtimeAdapters: { "claude-code": h.adapter }, specReader: h.inst });
    const result = await service.checkWithLiveness({ rig: "team", noQueue: true, noHooks: true, ...(listed ? { freshLogicalIds: [SEAT] } : {}) } as never);
    const pre = result.checks.find((c) => c.check === "rig.team.restore-preconditions")!;
    return { status: pre.status, evidence: pre.evidence };
  }

  async function runRestore(snapshotId: string, listed: boolean): Promise<{ outcome: Outcome; error: string | null }> {
    try {
      const out = await h.restore.restore(snapshotId, { adapters: { "claude-code": h.adapter }, fsOps: { exists }, ...(listed ? { freshLogicalIds: [SEAT] } : {}) } as never);
      if (!out.ok) return { outcome: "restore-ended", error: null };
      const node = out.result.nodes.find((n) => n.logicalId === SEAT)!;
      return { outcome: node.status === "failed" || node.status === "awaiting-decision" ? node.status : "ok", error: node.error ?? null };
    } catch {
      return { outcome: "restore-ended", error: null };
    }
  }

  // OF-39: what the own row's runtime column holds.
  const RUNTIMES: Array<[string, string]> = [["codex", "codex"], ["empty", ""], ["unknown runtime", "no-such-runtime"]];
  // OF-41: valid JSON of the wrong shape.
  const SHAPES: Array<[string, string, string]> = [
    ["actions {}", "startup_actions_json", "{}"],
    ["actions null", "startup_actions_json", "null"],
    ["actions [{}]", "startup_actions_json", "[{}]"],
    ["files {}", "resolved_files_json", "{}"],
    ["projection [1]", "projection_entries_json", "[1]"],
  ];
  const CORRUPTIONS: Array<[string, string, string]> = [
    ...RUNTIMES.map(([n, v]) => [`own runtime ${n}`, "runtime", v] as [string, string, string]),
    ...SHAPES,
  ];
  // listed x recorded spec source x policy (the unlisted seat restores fresh only when its policy says so).
  const MODES = [
    { listed: false, record: true }, { listed: false, record: false },
    { listed: true, record: true }, { listed: true, record: false },
  ];
  // When the row was damaged: after the snapshot (its copy is clean, so restore can fall back to it) or before it (the
  // snapshot's copy shares the damage, which is the OF-41 reviewer's setup: nothing usable is left to fall back to).
  const WHEN = ["after the snapshot (copy clean)", "before the snapshot (copy shares it)"] as const;
  const ROWS = CORRUPTIONS.flatMap(([name, col, value]) => MODES.flatMap((m) => WHEN.map((when) =>
    [`${name}; ${m.listed ? "listed" : "unlisted"}; ${m.record ? "spec recorded" : "no spec source"}; damaged ${when}`, col, value, m, when] as const)));

  it.each(ROWS)("%s", async (_name, col, value, mode, when) => {
    h = createRestoreHarness();
    const seat = await h.launchRig({ record: mode.record });
    policyFresh(seat.nodeId);
    if (when.startsWith("before")) setCol(seat.nodeId, col, value);
    const snapshotId = await h.down(seat.rigId);
    if (when.startsWith("after")) setCol(seat.nodeId, col, value);

    const check = await runCheck(mode.listed);
    const restore = await runRestore(snapshotId, mode.listed);

    // Never looser, never stricter: red exactly when restore does not come up cleanly.
    expect(check.status === "red", `check ${check.status}: ${check.evidence}; restore ${restore.outcome}: ${restore.error}`).toBe(restore.outcome !== "ok");
    // The unlisted blocker's remedy must not be offered when restore would refuse the same way (OF-41).
    if (restore.outcome !== "ok" && restore.error) expect(check.evidence).toContain(restore.error.replace(/^Fresh start refused: /, "").replace(/ No session was started\.$/, ""));
  });

  // A listed seat whose only source is an own row that cannot be used and a snapshot copy that cannot be used either:
  // both refuse, and the check's remedy must not claim the rig-wide route works when the rig records no spec source.
  it("listed, no spec source, own row and every snapshot copy unusable: restore refuses the seat, the check is red and does not offer --fresh as the way out", async () => {
    h = createRestoreHarness();
    const seat = await h.launchRig({ record: false });
    const snapshotId = await h.down(seat.rigId);
    setCol(seat.nodeId, "startup_actions_json", "{}");
    h.db.prepare("UPDATE snapshots SET data = json_set(data, '$.nodeStartupContext', json('{}'))").run();

    const check = await runCheck(true);
    const restore = await runRestore(snapshotId, true);

    expect(restore.outcome).not.toBe("ok");
    expect(check.status).toBe("red");
    expect(check.evidence).not.toContain("--existing --fresh");
  });
});
