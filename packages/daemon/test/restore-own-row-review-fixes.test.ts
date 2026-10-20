// Review of 4728c079 (rev-of36-9j, PASS-WITH-NITS): F1-F4 and the tie-break pin (probe A2). Each row measured red at
// 4728c079 except the tie-break pin, which is green there and is killed by the reviewer's mutant R2.
//
// Deployed entrypoints: routes/up.ts -> RestoreOrchestrator.restore; routes/restore-check.ts -> RestoreCheckService with
// restoreParityDeps (listedRefusalRemedy).
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRestoreHarness, type RestoreHarness } from "./helpers/restore-fresh-harness.js";
import { createRestoreCheckService } from "../src/routes/restore-check.js";
import type { StartupFrom } from "../src/domain/seat-startup-source.js";

const SEAT = "dev.impl";
let h: RestoreHarness;
afterEach(() => h.cleanup());

const exists = (p: string) => fs.existsSync(p);
const setCol = (nodeId: string, col: string, value: string) => h.db.prepare(`UPDATE node_startup_context SET ${col} = ? WHERE node_id = ?`).run(value, nodeId);
const policyFresh = (nodeId: string) => h.db.prepare("UPDATE sessions SET restore_policy = 'checkpoint_only' WHERE node_id = ?").run(nodeId);
const capture = (rigId: string, kind = "auto-pre-down") => h.snapshotCapture.captureSnapshot(rigId, kind).id;
const breakCopies = () => {
  for (const row of h.db.prepare("SELECT id, data FROM snapshots").all() as Array<{ id: string; data: string }>) {
    const data = JSON.parse(row.data);
    for (const key of Object.keys(data.nodeStartupContext ?? {})) if (data.nodeStartupContext[key]) data.nodeStartupContext[key].resolvedStartupFiles = {};
    h.db.prepare("UPDATE snapshots SET data = ? WHERE id = ?").run(JSON.stringify(data), row.id);
  }
};

async function runCheck(listed: boolean, startupFrom?: StartupFrom) {
  const service = createRestoreCheckService(h.rigRepo, h.snapshotRepo, undefined, { runtimeAdapters: { "claude-code": h.adapter }, specReader: h.inst });
  const result = await service.checkWithLiveness({ rig: "team", noQueue: true, noHooks: true, ...(listed ? { freshLogicalIds: [SEAT] } : {}), ...(startupFrom ? { startupFrom } : {}) } as never);
  const pre = result.checks.find((c) => c.check === "rig.team.restore-preconditions")!;
  return { status: pre.status, evidence: pre.evidence, remediation: pre.remediation };
}
async function runRestore(snapshotId: string, listed: boolean) {
  const out = await h.restore.restore(snapshotId, { adapters: { "claude-code": h.adapter }, fsOps: { exists }, ...(listed ? { freshLogicalIds: [SEAT] } : {}) } as never);
  if (!out.ok) return { outcome: "refused", text: (out.result?.blockers ?? []).map((b) => `${b.message} || ${b.remediation}`).join("; ") || (out.message ?? ""), warnings: [] as string[], source: null as unknown };
  const node = out.result.nodes.find((n) => n.logicalId === SEAT)!;
  return { outcome: node.status, text: node.error ?? "", warnings: out.result.warnings, source: node.startupSource ?? null };
}

describe("F1: a listed seat restore would refuse is never told a route that is refused too", () => {
  it("no spec, no usable copy: the check does not offer 'leave it out of --fresh' (that restore is refused as a whole)", async () => {
    h = createRestoreHarness();
    const seat = await h.launchRig({ record: false });
    policyFresh(seat.nodeId);
    setCol(seat.nodeId, "resolved_files_json", "{}");
    const s1 = await h.down(seat.rigId);

    const listed = await runCheck(true);
    expect(listed.status).toBe("red");
    expect(listed.remediation).not.toContain(`leave ${SEAT} out of --fresh`);
    expect(listed.remediation).toContain(`Leaving ${SEAT} out of --fresh does not help: that restore is refused before it starts anything (saved_startup_context_unusable`);
    // The sentence is true: the restore with the seat left out is refused as a whole.
    expect((await runRestore(s1, false)).outcome).toBe("refused");
  });

  it("a usable older copy: the check names --startup-from snapshot:<id>, and that restore starts the seat", async () => {
    h = createRestoreHarness();
    const seat = await h.launchRig();
    const s0 = capture(seat.rigId, "manual");
    const s1 = await h.down(seat.rigId);
    fs.unlinkSync(path.join(h.root, "library", "team")); // the spec route is gone: the listed seat is refused

    const listed = await runCheck(true);
    expect(listed.status).toBe("red");
    const named = new RegExp(`rig up 'team' --existing --fresh 'dev.impl' --startup-from snapshot:([0-9A-Z]+)`).exec(listed.remediation);
    expect(named, listed.remediation).toBeTruthy();
    // Leaving it out is offered here: the unlisted restore would not refuse this seat.
    expect(listed.remediation).toContain(`leave ${SEAT} out of --fresh`);
    expect([s0, s1]).toContain(named![1]);
    const out = await h.restore.restore(s1, { adapters: { "claude-code": h.adapter }, fsOps: { exists }, freshLogicalIds: [SEAT], startupFrom: `snapshot:${named![1]}` } as never);
    expect(out.ok && out.result.nodes.find((n) => n.logicalId === SEAT)!.status).toBe("fresh-primed");
  });
});

describe("F2: a seat with no saved row is not told to repair it", () => {
  it("no own row, only a broken copy: the remedy says there is nothing saved, not 'the saved row has to be repaired'", async () => {
    h = createRestoreHarness();
    const seat = await h.launchRig({ record: false });
    policyFresh(seat.nodeId);
    const s1 = await h.down(seat.rigId);
    breakCopies();
    h.db.prepare("DELETE FROM node_startup_context WHERE node_id = ?").run(seat.nodeId);

    const r = await runRestore(s1, false);

    expect(r.outcome).toBe("refused");
    expect(r.text).not.toContain("the saved row has to be repaired");
    expect(r.text).toContain("nothing can start it from saved files (it has no saved startup context of its own, and no snapshot holds a usable copy)");
  });
});

describe("F3: no replay or start claim for a seat restore's runtime gate stops", () => {
  it("own row and restored copy name codex, an older copy is good: no fallback warning; the seat stops awaiting a decision", async () => {
    h = createRestoreHarness();
    const seat = await h.launchRig({ record: false });
    policyFresh(seat.nodeId);
    await h.down(seat.rigId);
    setCol(seat.nodeId, "runtime", "codex");
    const s1 = capture(seat.rigId);

    const r = await runRestore(s1, false);

    expect(r.outcome).toBe("awaiting-decision");
    expect(r.warnings.join("\n")).not.toContain("This fresh start replays the copy");
  });

  it("own row and every copy name codex: restore is not refused as a whole ('would start this seat fresh'); it stops the seat", async () => {
    h = createRestoreHarness();
    const seat = await h.launchRig({ record: false });
    policyFresh(seat.nodeId);
    setCol(seat.nodeId, "runtime", "codex");
    const s1 = await h.down(seat.rigId);

    const r = await runRestore(s1, false);

    expect(r.outcome, r.text).toBe("awaiting-decision");
    expect(r.text).not.toContain("Restore would start this seat fresh");
  });
});

describe("F4: the copy pre-restore validation chose is the copy the seat starts from, or the seat is refused", () => {
  /** A periodic tick lands between pre-validation and the seat's launch: it copies the broken row and keeps 1 periodic. */
  const pruneAtPreRestore = () => {
    const sc = h.snapshotCapture as unknown as { captureSnapshot: (...args: unknown[]) => { id: string } };
    const orig = sc.captureSnapshot.bind(sc);
    sc.captureSnapshot = (rigId: unknown, kind: unknown, opts?: unknown) => {
      if (kind === "pre_restore") {
        orig(rigId, "auto-periodic");
        h.snapshotRepo.pruneSnapshotsByKind(rigId as string, "auto-periodic", 1);
      }
      return orig(rigId, kind, opts);
    };
  };

  it("A13: the chosen periodic copy is pruned before the launch: refused, naming the pruned snapshot; nothing started", async () => {
    h = createRestoreHarness();
    const seat = await h.launchRig({ record: false });
    policyFresh(seat.nodeId);
    const s0 = await h.down(seat.rigId);
    h.db.prepare("UPDATE snapshots SET kind = 'auto-periodic' WHERE id = ?").run(s0);
    setCol(seat.nodeId, "resolved_files_json", "{}");
    const s1 = capture(seat.rigId);
    pruneAtPreRestore();

    const r = await runRestore(s1, false);

    expect(r.outcome).toBe("failed");
    expect(r.text).toMatch(new RegExp(`^Fresh start refused: dev\\.impl: snapshot ${s0}, whose copy of its startup files this restore checked before it started, was removed before the seat's launch`));
    expect(h.delivered).toEqual([]);
    // Re-check G3: the pre-validation warning that it replays that copy is withdrawn when the seat is refused.
    expect(r.warnings.join("\n")).not.toContain("This fresh start replays the copy");
  });

  it("A14: with an older survivor, the seat is not started from that unchecked copy; the refusal names it as the way back", async () => {
    h = createRestoreHarness();
    const seat = await h.launchRig({ record: false });
    policyFresh(seat.nodeId);
    const sOld = await h.down(seat.rigId);
    h.db.prepare("UPDATE snapshots SET created_at = datetime('now', '-1 hour') WHERE id = ?").run(sOld);
    const s0 = capture(seat.rigId, "auto-periodic");
    setCol(seat.nodeId, "resolved_files_json", "{}");
    const s1 = capture(seat.rigId);
    pruneAtPreRestore();

    const r = await runRestore(s1, false);

    expect(r.outcome).toBe("failed");
    expect(r.text).toContain(`snapshot ${s0}, whose copy of its startup files this restore checked before it started, was removed`);
    expect(r.text).toContain(`--startup-from snapshot:${sOld}`);
    expect(h.delivered).toEqual([]);
  });

  it("control: nothing pruned: the seat starts from the copy pre-validation chose", async () => {
    h = createRestoreHarness();
    const seat = await h.launchRig({ record: false });
    policyFresh(seat.nodeId);
    const s0 = await h.down(seat.rigId);
    setCol(seat.nodeId, "resolved_files_json", "{}");
    const s1 = capture(seat.rigId);

    const r = await runRestore(s1, false);

    expect(r.outcome).toBe("fresh-primed");
    expect(r.source).toMatchObject({ kind: "snapshot", reason: "saved_context_unreadable", snapshotId: s0 });
  });
});

describe("re-check G2 and R3", () => {
  it("G2: a listed --startup-from snapshot:<id> whose copy names a gone required file is refused naming that snapshot", async () => {
    h = createRestoreHarness();
    const seat = await h.launchRig({ record: false });
    const s0 = capture(seat.rigId, "manual");
    const data = JSON.parse((h.db.prepare("SELECT data FROM snapshots WHERE id = ?").get(s0) as { data: string }).data);
    for (const key of Object.keys(data.nodeStartupContext)) {
      data.nodeStartupContext[key].resolvedStartupFiles = data.nodeStartupContext[key].resolvedStartupFiles.map((f: object) => ({ ...f, absolutePath: path.join(h.root, "gone", "role.md") }));
    }
    h.db.prepare("UPDATE snapshots SET data = ? WHERE id = ?").run(JSON.stringify(data), s0);
    const s1 = await h.down(seat.rigId);

    const out = await h.restore.restore(s1, { adapters: { "claude-code": h.adapter }, fsOps: { exists }, freshLogicalIds: [SEAT], startupFrom: `snapshot:${s0}` } as never);
    const node = out.ok ? out.result.nodes.find((n) => n.logicalId === SEAT)! : null;

    expect(node?.status).toBe("failed");
    expect(node?.error).toContain(`its startup files (copied in snapshot ${s0}) cannot be delivered`);
    expect(node?.error).not.toContain("saved at the seat's last successful launch");
  });

  it("R3: the snapshot route is not offered for a usable copy whose required file is gone", async () => {
    h = createRestoreHarness();
    const seat = await h.launchRig();
    await h.down(seat.rigId);
    for (const row of h.db.prepare("SELECT id, data FROM snapshots").all() as Array<{ id: string; data: string }>) {
      const data = JSON.parse(row.data);
      for (const key of Object.keys(data.nodeStartupContext ?? {})) {
        data.nodeStartupContext[key].resolvedStartupFiles = data.nodeStartupContext[key].resolvedStartupFiles.map((f: object) => ({ ...f, absolutePath: path.join(h.root, "gone", "role.md") }));
      }
      h.db.prepare("UPDATE snapshots SET data = ? WHERE id = ?").run(JSON.stringify(data), row.id);
    }
    fs.unlinkSync(path.join(h.root, "library", "team")); // the listed seat is refused (spec gone)

    const listed = await runCheck(true);

    expect(listed.status).toBe("red");
    expect(listed.remediation).not.toContain("--startup-from snapshot:");
    expect(listed.remediation).toContain(`leave ${SEAT} out of --fresh`);
  });
});

describe("tie-break pin (review probe A2): two usable copies with the same created_at go to the later insertion", () => {
  it("A2", async () => {
    h = createRestoreHarness();
    const seat = await h.launchRig({ record: false });
    policyFresh(seat.nodeId);
    const s1 = await h.down(seat.rigId);
    // s2: a second valid context with one more optional file, so the two copies are told apart by what is delivered.
    const files = JSON.parse((h.db.prepare("SELECT resolved_files_json AS f FROM node_startup_context WHERE node_id = ?").get(seat.nodeId) as { f: string }).f);
    const extra = path.join(path.dirname(files[0].absolutePath), "extra-B.md");
    fs.writeFileSync(extra, "# extra B\n");
    setCol(seat.nodeId, "resolved_files_json", JSON.stringify([...files, { ...files[0], path: "guidance/extra-B.md", absolutePath: extra, required: false }]));
    const s2 = capture(seat.rigId);
    h.db.prepare("UPDATE snapshots SET created_at = '2026-01-01 00:00:00' WHERE id IN (?, ?)").run(s1, s2);
    setCol(seat.nodeId, "projection_entries_json", "{}");
    const s3 = capture(seat.rigId);

    const r = await runRestore(s3, false);

    expect(r.outcome).toBe("fresh-primed");
    expect(r.source).toMatchObject({ snapshotId: s2 });
    expect(h.delivered.at(-1)!.map((f) => path.basename(f.absolutePath))).toContain("extra-B.md");
  });
});
