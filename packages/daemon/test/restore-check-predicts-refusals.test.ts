// OF-32 follow-up: restore-check (and `rig up --existing --plan`) must say, before the restore runs, what the restore
// will refuse, using the predicates restore uses. The "agreement table" below runs BOTH the real RestoreOrchestrator
// and the real RestoreCheckService over the same seat state and requires that the check is never greener than the
// restore it predicts. A prediction that is looser than restore sends an operator into a restore that fails.
//
// Production consequence these rows protect: `rig restore-check` says "green", the operator runs
// `rig up --existing <rig> --fresh <seat>` (or a plain `rig up --existing`), and the seat is refused, or the whole
// restore ends in restore_error, or the seat fails after its launch with the session left in place.
//
// Deployed entrypoint: startup.ts constructs RestoreOrchestrator (with `seatStartupSource: podInstantiator`) and
// server.ts mounts routes/restore-check.ts and routes/up.ts, which build the check and the plan from the same
// modules (fresh-seat-restore-decision.ts, own-startup-replay.ts) that restore calls.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRestoreHarness, type RestoreHarness } from "./helpers/restore-fresh-harness.js";
import { createRestoreCheckService } from "../src/routes/restore-check.js";
import { buildRestorePlanPreview, collectPreviewSessionRows, predictedPlanRefusals } from "../src/domain/restore-plan-preview.js";
import { readFreshOccupantRelations } from "../src/domain/fresh-occupant-relation.js";
import type { StartupFrom } from "../src/domain/seat-startup-source.js";

type Outcome = "ok" | "seat-refused" | "pre-restore-refused" | "failed-after-launch" | "restore-ended";

describe("restore-check and restore agree, seat state by seat state", () => {
  let h: RestoreHarness;
  afterEach(() => h.cleanup());

  const SEAT = "dev.impl";
  const exists = (p: string) => fs.existsSync(p);
  const gone = () => path.join(h.root, "gone", "role.md");
  const policyFresh = (nodeId: string) => h.db.prepare("UPDATE sessions SET restore_policy = 'checkpoint_only' WHERE node_id = ?").run(nodeId);
  const setCol = (nodeId: string, col: string, value: string) => h.db.prepare(`UPDATE node_startup_context SET ${col} = ? WHERE node_id = ?`).run(value, nodeId);
  const ownFiles = (nodeId: string) => JSON.parse((h.db.prepare("SELECT resolved_files_json AS f FROM node_startup_context WHERE node_id = ?").get(nodeId) as { f: string }).f) as Array<Record<string, unknown>>;
  /** The snapshot's copy of the seat's startup files is rewritten to name a required file that is gone. */
  const breakSnapshotCopy = (snapshotId: string) => {
    const row = h.db.prepare("SELECT data FROM snapshots WHERE id = ?").get(snapshotId) as { data: string };
    const data = JSON.parse(row.data);
    for (const key of Object.keys(data.nodeStartupContext)) {
      data.nodeStartupContext[key].resolvedStartupFiles = data.nodeStartupContext[key].resolvedStartupFiles.map((f: object) => ({ ...f, absolutePath: gone() }));
    }
    h.db.prepare("UPDATE snapshots SET data = ? WHERE id = ?").run(JSON.stringify(data), snapshotId);
  };

  async function runCheck(opts: { listed: boolean; startupFrom?: StartupFrom; noAdapters?: boolean }) {
    const service = createRestoreCheckService(h.rigRepo, h.snapshotRepo, undefined, { runtimeAdapters: opts.noAdapters ? {} : { "claude-code": h.adapter }, specReader: h.inst });
    const result = await service.checkWithLiveness({
      rig: "team", noQueue: true, noHooks: true,
      ...(opts.listed ? { freshLogicalIds: [SEAT] } : {}),
      ...(opts.startupFrom ? { startupFrom: opts.startupFrom } : {}),
    } as never);
    const pre = result.checks.find((c) => c.check === "rig.team.restore-preconditions")!;
    return { status: pre.status, evidence: pre.evidence };
  }

  async function runRestore(snapshotId: string, opts: { listed: boolean; startupFrom?: StartupFrom; noAdapters?: boolean }): Promise<{ outcome: Outcome; refusal: string | null }> {
    try {
      const out = await h.restore.restore(snapshotId, {
        adapters: opts.noAdapters ? {} : { "claude-code": h.adapter }, fsOps: { exists },
        ...(opts.listed ? { freshLogicalIds: [SEAT] } : {}),
        ...(opts.startupFrom ? { startupFrom: opts.startupFrom } : {}),
      } as never);
      if (!out.ok) return { outcome: out.code === "restore_error" ? "restore-ended" : "pre-restore-refused", refusal: null };
      const node = out.result.nodes.find((n) => n.logicalId === SEAT)!;
      if (node.status !== "failed") return { outcome: "ok", refusal: null };
      const refused = /^Fresh start refused: (.*) No session was started\.$/s.exec(node.error ?? "");
      return refused ? { outcome: "seat-refused", refusal: refused[1]! } : { outcome: "failed-after-launch", refusal: null };
    } catch {
      return { outcome: "restore-ended", refusal: null };
    }
  }

  // --- listed seats: `rig up --existing --fresh <seat>` -------------------------------------------------------------
  interface ListedRow { name: string; startupFrom?: StartupFrom; record?: boolean; policyFresh?: boolean; noAdapters?: boolean; prepare(snapshotId: string, seat: { rigId: string; nodeId: string }): void; expected: Outcome }
  const LISTED: ListedRow[] = [
    { name: "L1 clean: spec re-read gives the seat its files", prepare: () => undefined, expected: "ok" },
    { name: "L2 the recorded spec link is gone", prepare: () => fs.unlinkSync(path.join(h.root, "library", "team")), expected: "seat-refused" },
    {
      name: "L3 the spec now declares another profile", prepare: () => {
        const relB = path.join(h.root, "releases", "bbbbbbb", "rigs", "team");
        fs.writeFileSync(path.join(relB, "rig.yaml"), fs.readFileSync(path.join(relB, "rig.yaml"), "utf-8").replace("profile: default", "profile: other"));
        h.retarget("bbbbbbb");
      }, expected: "seat-refused",
    },
    {
      name: "L4 the spec's required startup file is gone", prepare: () => {
        h.retarget("bbbbbbb");
        fs.rmSync(path.join(h.root, "releases", "bbbbbbb", "rigs", "team", "agents", "impl", "guidance", "role.md"));
      }, expected: "seat-refused",
    },
    { name: "L5 spec link gone but --startup-from stored", startupFrom: "stored", prepare: () => fs.unlinkSync(path.join(h.root, "library", "team")), expected: "ok" },
    { name: "L6 stored, and the saved context's required file is gone", startupFrom: "stored", prepare: (_s, seat) => setCol(seat.nodeId, "resolved_files_json", JSON.stringify(ownFiles(seat.nodeId).map((f) => ({ ...f, absolutePath: gone() })))), expected: "seat-refused" },
    { name: "L7 stored, saved context unreadable, snapshot copy fine: falls back to the copy", startupFrom: "stored", prepare: (_s, seat) => setCol(seat.nodeId, "projection_entries_json", JSON.stringify([{ category: "memory" }])), expected: "ok" },
    {
      name: "L8 stored, saved context unreadable, snapshot copy's required file gone: refused from the copy", startupFrom: "stored",
      prepare: (snapshotId, seat) => { setCol(seat.nodeId, "projection_entries_json", JSON.stringify([{ category: "memory" }])); breakSnapshotCopy(snapshotId); }, expected: "seat-refused",
    },
    { name: "L9 no recorded spec source, saved context's required file gone", record: false, prepare: (_s, seat) => setCol(seat.nodeId, "resolved_files_json", JSON.stringify(ownFiles(seat.nodeId).map((f) => ({ ...f, absolutePath: gone() })))), expected: "seat-refused" },
    { name: "L10 no recorded spec source, saved context fine", record: false, prepare: () => undefined, expected: "ok" },
    { name: "L11 policy-fresh seat, spec link gone, listed", policyFresh: true, prepare: () => fs.unlinkSync(path.join(h.root, "library", "team")), expected: "seat-refused" },
    // The seat's own saved context is what a listed seat without a spec re-read replays; the snapshot's copy is not
    // checked at all (its source is decided at launch), so a broken copy must not turn the check red.
    { name: "L12 no recorded spec source, snapshot copy's required file gone, saved context fine", record: false, prepare: (snapshotId) => breakSnapshotCopy(snapshotId), expected: "ok" },
    // The reverse: with no saved context and no spec re-read, the snapshot's copy IS what the seat replays, so pre-restore
    // validation checks it for a listed seat even though the seat would otherwise resume.
    { name: "L13 no recorded spec source, no saved context, snapshot copy's required file gone", record: false, prepare: (snapshotId, seat) => { breakSnapshotCopy(snapshotId); h.db.prepare("DELETE FROM node_startup_context WHERE node_id = ?").run(seat.nodeId); }, expected: "pre-restore-refused" },
    // No adapter for the seat's runtime: restore decides nothing for a listed seat, so the check must predict nothing.
    { name: "L14 no runtime adapter: restore decides nothing, the spec link being gone is not a refusal", noAdapters: true, prepare: () => fs.unlinkSync(path.join(h.root, "library", "team")), expected: "ok" },
    // Listed, and no adapter: restore still validates the snapshot's copy for a listed seat before anything starts.
    { name: "L15 no runtime adapter, snapshot copy's required file gone: pre-restore validation refuses the restore", noAdapters: true, prepare: (snapshotId) => breakSnapshotCopy(snapshotId), expected: "pre-restore-refused" },
  ];

  it.each(LISTED.map((row) => [row.name, row] as const))("listed seat: %s", async (_name, row) => {
    h = createRestoreHarness();
    const seat = await h.launchRig({ record: row.record });
    if (row.policyFresh) policyFresh(seat.nodeId);
    const snapshotId = await h.down(seat.rigId);
    row.prepare(snapshotId, seat);

    const check = await runCheck({ listed: true, startupFrom: row.startupFrom, noAdapters: row.noAdapters });
    const restore = await runRestore(snapshotId, { listed: true, startupFrom: row.startupFrom, noAdapters: row.noAdapters });

    expect(restore.outcome, "the table's own expectation of restore").toBe(row.expected);
    // Never looser: whenever restore does not come up cleanly, the check is red.
    expect(check.status === "red", `check ${check.status}: ${check.evidence}`).toBe(restore.outcome !== "ok");
    // And it says what restore says: the refusal text is restore's own.
    if (restore.refusal) expect(check.evidence).toContain(restore.refusal);
  });

  // --- seats not listed: a plain `rig up --existing` -----------------------------------------------------------------
  // N-C4 (review of fc2d5b96): restore-check treated a saved context that is JSON of the wrong shape as "no own context"
  // and validated the snapshot's copy; restore replays the own row as it is. Measured at 95fd7cc0.
  const SHAPES: Array<[string, string, string, Outcome]> = [
    ["files is not a list", "resolved_files_json", "{}", "restore-ended"],
    ["files is a string", "resolved_files_json", '"str"', "failed-after-launch"],
    ["files is null", "resolved_files_json", "null", "failed-after-launch"],
    ["files has a null member", "resolved_files_json", "[null]", "restore-ended"],
    ["files has a member with no path", "resolved_files_json", '[{"path":"x"}]', "ok"],
    ["files has a number member", "resolved_files_json", "[1]", "ok"],
    ["files has an array member", "resolved_files_json", "[[]]", "ok"],
    ["projection is not a list", "projection_entries_json", "{}", "restore-ended"],
    ["projection has a null member", "projection_entries_json", "[null]", "restore-ended"],
    ["projection has a number member", "projection_entries_json", "[1]", "ok"],
    ["projection has a member of the wrong shape", "projection_entries_json", '[{"category":"memory"}]', "ok"],
    ["actions is not a list", "startup_actions_json", "{}", "failed-after-launch"],
    ["actions is null", "startup_actions_json", "null", "failed-after-launch"],
    ["actions has a number member", "startup_actions_json", "[1]", "ok"],
    ["actions has an empty-object member", "startup_actions_json", "[{}]", "ok"],
  ];
  // Which of the snapshot's copy and the own row is broken, besides the shape under test.
  const SIDES = ["copy clean", "copy names a required file that is gone", "own row names a required file that is gone"] as const;
  const UNLISTED = SHAPES.flatMap(([shape, col, value, expected]) => SIDES.map((side) => [`${shape}; ${side}`, col, value, side, expected] as const));

  it.each(UNLISTED)("unlisted seat, saved context: %s", async (_name, col, value, side, shapeOnlyExpected) => {
    h = createRestoreHarness();
    const seat = await h.launchRig();
    policyFresh(seat.nodeId);
    const snapshotId = await h.down(seat.rigId);
    if (side === "copy names a required file that is gone") {
      breakSnapshotCopy(snapshotId);
      setCol(seat.nodeId, "resolved_files_json", "[]");
    } else if (side === "own row names a required file that is gone") {
      setCol(seat.nodeId, "resolved_files_json", JSON.stringify(ownFiles(seat.nodeId).map((f) => ({ ...f, absolutePath: gone() }))));
    }
    setCol(seat.nodeId, col, value);

    const check = await runCheck({ listed: false });
    const restore = await runRestore(snapshotId, { listed: false });

    if (side === "copy clean") expect(restore.outcome, "the table's own expectation of restore").toBe(shapeOnlyExpected);
    // Never looser, and (the N-C4 disagreement) never stricter either: the check reads the same row restore replays.
    expect(check.status === "red", `check ${check.status}: ${check.evidence}`).toBe(restore.outcome !== "ok");
  });

  // A saved context that is not JSON never reaches a row: restore replays the snapshot's copy (and its pre-restore
  // capture throws first, N-C3, so a whole restore() ends). The check validates the copy, as restore would.
  it("unlisted seat, a saved column that is not JSON: both stop, and the check is red", async () => {
    h = createRestoreHarness();
    const seat = await h.launchRig();
    policyFresh(seat.nodeId);
    const snapshotId = await h.down(seat.rigId);
    setCol(seat.nodeId, "resolved_files_json", "not json");
    breakSnapshotCopy(snapshotId);

    const check = await runCheck({ listed: false });
    const restore = await runRestore(snapshotId, { listed: false });

    expect(restore.outcome).not.toBe("ok");
    expect(check.status).toBe("red");
  });

  // A prediction that could not be made is never read as "nothing refused".
  it("a spec read that throws makes the check yellow and says it could not predict; never green", async () => {
    h = createRestoreHarness();
    const seat = await h.launchRig();
    await h.down(seat.rigId);
    const exploding = { readSeatStartupFromSpec: async () => { throw new Error("spec reader exploded (injected)"); } };
    const service = createRestoreCheckService(h.rigRepo, h.snapshotRepo, undefined, { runtimeAdapters: { "claude-code": h.adapter }, specReader: exploding });

    const result = await service.checkWithLiveness({ rig: "team", noQueue: true, noHooks: true, freshLogicalIds: [SEAT] });

    const pre = result.checks.find((c) => c.check === "rig.team.restore-preconditions")!;
    expect(pre.status).toBe("yellow");
    expect(pre.evidence).toContain("could not predict which listed seats restore would refuse: spec reader exploded (injected)");
  });

  // --- the plan: `rig up --existing --fresh <seat> --plan` -----------------------------------------------------------
  it("buildRestorePlanPreview shows a refusal only on a seat that is listed", async () => {
    h = createRestoreHarness();
    const seat = await h.launchRig();
    const snapshotId = await h.down(seat.rigId);
    const rig = h.rigRepo.getRig(seat.rigId)!;
    const snapshot = h.snapshotRepo.getSnapshot(snapshotId)!;
    const refusals = new Map([[SEAT, "boom"]]);

    const unlisted = buildRestorePlanPreview(rig, snapshot, collectPreviewSessionRows(h.db, rig, snapshot), [], Date.now(), readFreshOccupantRelations(h.db, rig.rig.id), refusals);
    const listed = buildRestorePlanPreview(rig, snapshot, collectPreviewSessionRows(h.db, rig, snapshot), [SEAT], Date.now(), readFreshOccupantRelations(h.db, rig.rig.id), refusals);

    expect(unlisted.nodes[0]!.wouldRefuse).toBeUndefined();
    expect(listed.nodes[0]!.wouldRefuse).toBe("boom");
  });

  it("the plan names the same refusal restore gives a listed seat", async () => {
    h = createRestoreHarness();
    const seat = await h.launchRig();
    const snapshotId = await h.down(seat.rigId);
    h.retarget("bbbbbbb");
    fs.rmSync(path.join(h.root, "releases", "bbbbbbb", "rigs", "team", "agents", "impl", "guidance", "role.md"));
    const rig = h.rigRepo.getRig(seat.rigId)!;
    const snapshot = h.snapshotRepo.getSnapshot(snapshotId)!;

    const refusals = await predictedPlanRefusals(
      { db: h.db, rigRepo: h.rigRepo, specReader: h.inst, runtimeAdapters: { "claude-code": h.adapter }, exists },
      rig, snapshot, [SEAT], "spec",
    );
    const plan = buildRestorePlanPreview(rig, snapshot, collectPreviewSessionRows(h.db, rig, snapshot), [SEAT], Date.now(), readFreshOccupantRelations(h.db, rig.rig.id), refusals);
    const restore = await runRestore(snapshotId, { listed: true });

    expect(restore.outcome).toBe("seat-refused");
    const planned = plan.nodes.find((n) => n.logicalId === SEAT)!;
    expect(planned.wouldRefuse).toBe(restore.refusal);
  });

  it("the plan names no refusal for a listed seat restore would start", async () => {
    h = createRestoreHarness();
    const seat = await h.launchRig();
    const snapshotId = await h.down(seat.rigId);
    const rig = h.rigRepo.getRig(seat.rigId)!;
    const snapshot = h.snapshotRepo.getSnapshot(snapshotId)!;

    const refusals = await predictedPlanRefusals(
      { db: h.db, rigRepo: h.rigRepo, specReader: h.inst, runtimeAdapters: { "claude-code": h.adapter }, exists },
      rig, snapshot, [SEAT], "spec",
    );
    const plan = buildRestorePlanPreview(rig, snapshot, collectPreviewSessionRows(h.db, rig, snapshot), [SEAT], Date.now(), readFreshOccupantRelations(h.db, rig.rig.id), refusals);

    expect((await runRestore(snapshotId, { listed: true })).outcome).toBe("ok");
    expect(plan.nodes.find((n) => n.logicalId === SEAT)!.wouldRefuse).toBeUndefined();
  });

  it("a seat not listed with --fresh is never predicted refused by the plan, whatever its spec says", async () => {
    h = createRestoreHarness();
    const seat = await h.launchRig();
    const snapshotId = await h.down(seat.rigId);
    fs.unlinkSync(path.join(h.root, "library", "team"));
    const rig = h.rigRepo.getRig(seat.rigId)!;
    const snapshot = h.snapshotRepo.getSnapshot(snapshotId)!;

    const refusals = await predictedPlanRefusals(
      { db: h.db, rigRepo: h.rigRepo, specReader: h.inst, runtimeAdapters: { "claude-code": h.adapter }, exists },
      rig, snapshot, [], "spec",
    );

    expect(refusals.size).toBe(0);
    expect((await runRestore(snapshotId, { listed: false })).outcome).toBe("ok");
  });
});
