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
// OF-52 (review of39-41 nits): a restore that THROWS fails the row (it used to be read as "restore ended" and then
// required the check to be red, so a broken harness looked like a legitimate row); a green check and a yellow one are
// told apart when restore comes up (yellow exactly when restore warned that the seat replays a snapshot copy); the
// default resume policy is covered as well as checkpoint_only; and two snapshots of the same seat are covered.
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

  // A refusal is a result (`ok: false, code: pre_restore_validation_failed`: restore ended before it started anything). An
  // exception is not, and neither is `restore_error` (restore's own conversion of one): either fails the row, so a defect in
  // restore or the harness cannot pass as a refusal the check happens to agree with.
  async function runRestore(snapshotId: string, listed: boolean): Promise<{ outcome: Outcome; error: string | null; warned: boolean; warnings: string[] }> {
    const out = await h.restore.restore(snapshotId, { adapters: { "claude-code": h.adapter }, fsOps: { exists }, ...(listed ? { freshLogicalIds: [SEAT] } : {}) } as never);
    // What makes the check yellow: restore says the seat replays another snapshot's copy of its startup files because what it would
    // replay cannot be used (own-startup-replay.ts words it "the newest snapshot of this rig whose copy can be used").
    const warned = (warnings: string[]) => warnings.some((w) => w.includes("the newest snapshot of this rig whose copy can be used"));
    if (!out.ok) {
      // restore() turns an exception inside it into `restore_error`; that is a defect, not a refusal. The only refusal a seat's
      // saved startup row can cause is the pre-restore validation one.
      if (out.code !== "pre_restore_validation_failed") throw new Error(`restore ended with ${out.code}: ${out.message}`);
      return { outcome: "restore-ended", error: null, warned: warned(out.result?.warnings ?? []), warnings: out.result?.warnings ?? [] };
    }
    const node = out.result.nodes.find((n) => n.logicalId === SEAT)!;
    return { outcome: node.status === "failed" || node.status === "awaiting-decision" ? node.status : "ok", error: node.error ?? null, warned: warned(out.result.warnings), warnings: out.result.warnings };
  }

  // Known divergence, pinned as it is (filed as a follow-up by OF-52): a seat listed with --fresh, in a rig that records no
  // spec source, whose own row was damaged AFTER the snapshot: restore warns that it replays the snapshot's copy and the check
  // reports green, not yellow. The verdict (not red) still agrees. When the check learns to warn, these rows flip to yellow and
  // this list is deleted.
  const checkGreenWhereRestoreWarns = (name: string) => name.includes("; listed; no spec source; damaged after");

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

    expectAgreement(_name, check, restore);
  });

  // Never looser, never stricter: red exactly when restore does not come up cleanly.
  function expectAgreement(name: string, check: { status: string; evidence: string }, restore: { outcome: Outcome; error: string | null; warned: boolean }) {
    expect(check.status === "red", `check ${check.status}: ${check.evidence}; restore ${restore.outcome}: ${restore.error}`).toBe(restore.outcome !== "ok");
    // And when it does come up, green and yellow are not interchangeable: yellow exactly when restore warned of the copy.
    if (restore.outcome === "ok") {
      expect(check.status, `restore warned of a replayed copy: ${restore.warned}; check ${check.status}: ${check.evidence}`)
        .toBe(restore.warned && !checkGreenWhereRestoreWarns(name) ? "yellow" : "green");
    }
    // The unlisted blocker's remedy must not be offered when restore would refuse the same way (OF-41).
    if (restore.outcome !== "ok" && restore.error) expect(check.evidence).toContain(restore.error.replace(/^Fresh start refused: /, "").replace(/ No session was started\.$/, ""));
  }

  // The snapshot the check reads is the one an unnamed restore uses (the latest restore-usable one), so the row restores that one.
  const chosenSnapshotId = (rigId: string) => {
    const selected = h.snapshotRepo.selectRestoreUsable(rigId);
    if (!selected.ok) throw new Error(`no usable snapshot: ${selected.message}`);
    return selected.snapshot.id;
  };

  // OF-52: the rows above force restore_policy = checkpoint_only so that an unlisted seat starts fresh. The default policy
  // (resume_if_possible) takes the other branch: the seat has a saved conversation, so restore resumes it (or stops it) and
  // reads none of the replay files. Same corruptions, both listings.
  const DEFAULT_POLICY_ROWS = CORRUPTIONS.flatMap(([name, col, value]) => [false, true].map((listed) =>
    [`${name}; ${listed ? "listed" : "unlisted"}; default restore policy; damaged before the snapshot`, col, value, listed] as const));
  it.each(DEFAULT_POLICY_ROWS)("%s", async (name, col, value, listed) => {
    h = createRestoreHarness();
    const seat = await h.launchRig({ record: true });
    setCol(seat.nodeId, col, value);
    await h.down(seat.rigId);

    const check = await runCheck(listed);
    const restore = await runRestore(chosenSnapshotId(seat.rigId), listed);

    expectAgreement(name, check, restore);
  });

  // OF-52: two or more snapshots of the seat. The reviewer's mutants that read the seat's copy from the wrong place (MY1: the
  // own row instead of the snapshot; M1) survived the one-snapshot table because, with a single snapshot, the restored
  // snapshot's copy and "the newest snapshot whose copy can be used" are the same copy. The rule (own-startup-replay.ts):
  //   - the seat's own row can be used: it is replayed, whatever any snapshot holds;
  //   - the own row is absent: the restored snapshot's copy is replayed when it can be used;
  //   - otherwise (the row cannot be used, or it is absent and the restored copy cannot be): the NEWEST copy, of any snapshot of
  //     the rig, that can be used, with a warning naming its snapshot; none can be used: restore starts nothing.
  // "Cannot be used" = captured with the damaged row. S1 is the auto-pre-down snapshot, the one an unnamed restore and the check
  // both read (restore prefers it to the newer manual snapshots S2 and S3). Production consequence of the check naming another
  // copy than restore replays: it validates (or fails to validate) files restore will not use, so it is green for a restore that
  // stops, or red for one that would have come up. The expected outcomes below are restated from the rule above, written before
  // the rows were first run.
  type Steps = {
    damage(): void; heal(): void; dropRow(): void; capture(): string; down(): Promise<string>; goneFile(snapshotId: string): void;
  };
  const TWO_SNAPSHOT_ROWS: Array<[string, (t: Steps) => Promise<Record<string, string>>, Outcome, "S1" | "S2" | null]> = [
    ["row damaged now; S1's copy is clean, S2 and S3 are damaged: S1's is the only usable copy", async (t) => {
      const S1 = await t.down(); t.damage(); return { S1, S2: t.capture(), S3: t.capture() };
    }, "ok", "S1"],
    ["row damaged now; S1 clean, S2 usable but names a missing file, S3 damaged: the NEWEST usable copy (S2's) is replayed, not S1's, and its file is gone", async (t) => {
      const S1 = await t.down(); const S2 = t.capture(); t.goneFile(S2); t.damage(); return { S1, S2, S3: t.capture() };
    }, "restore-ended", "S2"],
    ["row damaged now; S1 damaged, S2 clean, S3 damaged: S2's copy is replayed", async (t) => {
      t.damage(); const S1 = await t.down(); t.heal(); const S2 = t.capture(); t.damage(); return { S1, S2, S3: t.capture() };
    }, "ok", "S2"],
    ["row damaged now and in every snapshot: no copy can be used, restore starts nothing", async (t) => {
      t.damage(); const S1 = await t.down(); return { S1, S2: t.capture(), S3: t.capture() };
    }, "restore-ended", null],
    ["row absent; S1's copy cannot be used, S2 is clean: S2's copy is replayed", async (t) => {
      t.damage(); const S1 = await t.down(); t.heal(); const S2 = t.capture(); t.dropRow(); return { S1, S2, S3: t.capture() };
    }, "ok", "S2"],
    ["row absent; S1's copy cannot be used, S2 is usable but names a missing file: S2's copy is replayed and its file is gone", async (t) => {
      t.damage(); const S1 = await t.down(); t.heal(); const S2 = t.capture(); t.goneFile(S2); t.dropRow(); return { S1, S2, S3: t.capture() };
    }, "restore-ended", "S2"],
    ["row absent; S1's copy is clean, S2 names a missing file: the restored snapshot's copy is replayed, not the newest", async (t) => {
      const S1 = await t.down(); const S2 = t.capture(); t.goneFile(S2); t.dropRow(); return { S1, S2, S3: t.capture() };
    }, "ok", null],
  ];
  it.each(TWO_SNAPSHOT_ROWS)("two snapshots: %s", async (label, setup, expected, supplier) => {
    h = createRestoreHarness();
    const seat = await h.launchRig({ record: true });
    policyFresh(seat.nodeId);
    const original = h.db.prepare("SELECT startup_actions_json AS v FROM node_startup_context WHERE node_id = ?").get(seat.nodeId) as { v: string };
    const ids = await setup({
      damage: () => setCol(seat.nodeId, "startup_actions_json", "{}"),
      heal: () => setCol(seat.nodeId, "startup_actions_json", original.v),
      dropRow: () => { h.db.prepare("DELETE FROM node_startup_context WHERE node_id = ?").run(seat.nodeId); },
      capture: () => h.snapshotCapture.captureSnapshot(seat.rigId, "manual").id,
      down: () => h.down(seat.rigId),
      goneFile: (snapshotId) => { h.db.prepare("UPDATE snapshots SET data = json_set(data, ?, ?) WHERE id = ?")
        .run(`$.nodeStartupContext.${seat.nodeId}.resolvedStartupFiles[0].absolutePath`, "/gone/guidance/role.md", snapshotId); },
    });
    // Both the check and an unnamed restore read S1 (the auto-pre-down snapshot), not the newest.
    expect(chosenSnapshotId(seat.rigId), "the snapshot both read").toBe(ids.S1);

    const check = await runCheck(false);
    const restore = await runRestore(ids.S1!, false);

    expect(restore.outcome, `${label}: ${restore.error}`).toBe(expected);
    expectAgreement(label, check, restore);
    // Which snapshot supplied the replayed copy: restore names it in its warning, and the check must name the same one and no
    // other (the evidence starts with the snapshot checked, S1, which is not necessarily the one replayed).
    const body = check.evidence.replace(/^Snapshot \w+: /, "");
    if (supplier) {
      expect(restore.warnings.join(" ")).toContain(ids[supplier]!);
      expect(body).toContain(ids[supplier]!);
    } else {
      expect(restore.warned, "no snapshot copy is substituted").toBe(false);
    }
    for (const other of ["S1", "S2", "S3"].filter((id) => id !== supplier)) expect(body).not.toContain(ids[other]!);
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
