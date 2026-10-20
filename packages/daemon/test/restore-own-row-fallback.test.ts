// OF-36 / N-C3 / OF-41 / OF-39: a seat's own saved startup context (node_startup_context) that restore cannot use: not
// JSON, JSON of the wrong shape, or naming another runtime than the seat's. Restore treats every such row as unreadable:
// a seat it starts fresh replays the newest snapshot copy of its startup context that IS readable (a snapshot taken
// before the break), and saves it as the seat's new context; when no snapshot holds one, restore refuses before it
// starts anything. restore-check (and the plan) ask the same functions, so the check is red exactly when restore does
// not come up cleanly, and it prints restore's own refusal.
//
// Production consequence these rows protect (measured at c99782ac): `rig down` copies a broken row verbatim into its
// auto-pre-down snapshot, so `rig up --existing` replayed the damage (D5): 4 of the 15 shapes ended the whole restore
// with a raw TypeError (restore_error), 4 failed the seat after its launch with the session left in place, and the
// other 7 came back "fresh-primed" with the row still malformed. A not-JSON row ended every restore() (N-C3: the
// pre-restore capture threw). restore-check said green for a listed seat (OF-41) and for an own row naming another
// runtime (OF-39).
//
// Deployed entrypoint: startup.ts constructs RestoreOrchestrator; routes/up.ts and routes/restore-check.ts build restore
// and the check from fresh-seat-restore-decision.ts / own-startup-replay.ts, the modules exercised here.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRestoreHarness, type RestoreHarness } from "./helpers/restore-fresh-harness.js";
import { createRestoreCheckService } from "../src/routes/restore-check.js";
import { readStoredStartupContext } from "../src/domain/seat-startup-source.js";
import type { StartupFrom } from "../src/domain/seat-startup-source.js";

type Outcome = "ok" | "seat-refused" | "pre-restore-refused" | "failed-after-launch" | "restore-ended" | "awaiting" | "attention";

const SEAT = "dev.impl";

// The 15 JSON-but-wrong-shape rows of the N-C4 agreement table, plus the not-JSON rows (N-C3) and the two runtime rows
// (OF-39). `[column, value]`.
const SHAPES: Array<[string, string, string]> = [
  ["files is not a list", "resolved_files_json", "{}"],
  ["files is a string", "resolved_files_json", '"str"'],
  ["files is null", "resolved_files_json", "null"],
  ["files has a null member", "resolved_files_json", "[null]"],
  ["files has a member with no path", "resolved_files_json", '[{"path":"x"}]'],
  ["files has a number member", "resolved_files_json", "[1]"],
  ["files has an array member", "resolved_files_json", "[[]]"],
  ["projection is not a list", "projection_entries_json", "{}"],
  ["projection has a null member", "projection_entries_json", "[null]"],
  ["projection has a number member", "projection_entries_json", "[1]"],
  ["projection has a member of the wrong shape", "projection_entries_json", '[{"category":"memory"}]'],
  ["actions is not a list", "startup_actions_json", "{}"],
  ["actions is null", "startup_actions_json", "null"],
  ["actions has a number member", "startup_actions_json", "[1]"],
  ["actions has an empty-object member", "startup_actions_json", "[{}]"],
];
const NOT_JSON: Array<[string, string, string]> = [
  ["files is not JSON", "resolved_files_json", "{not json"],
  ["projection is not JSON", "projection_entries_json", "not json"],
  ["actions is not JSON", "startup_actions_json", "["],
  ["files is the empty string", "resolved_files_json", ""],
];
const RUNTIME: Array<[string, string, string]> = [
  ["runtime names another runtime", "runtime", "codex"],
  ["runtime is blank", "runtime", ""],
];

describe("a seat's own saved startup context that restore cannot use (OF-36)", () => {
  let h: RestoreHarness;
  afterEach(() => h.cleanup());

  const exists = (p: string) => fs.existsSync(p);
  const setCol = (nodeId: string, col: string, value: string) => h.db.prepare(`UPDATE node_startup_context SET ${col} = ? WHERE node_id = ?`).run(value, nodeId);
  const policyFresh = (nodeId: string) => h.db.prepare("UPDATE sessions SET restore_policy = 'checkpoint_only' WHERE node_id = ?").run(nodeId);
  const copyOf = (snapshotId: string) => {
    const data = JSON.parse((h.db.prepare("SELECT data FROM snapshots WHERE id = ?").get(snapshotId) as { data: string }).data);
    return Object.values(data.nodeStartupContext)[0] as { resolvedStartupFiles: Array<{ absolutePath: string }> };
  };
  /** What `rig down` writes for the rig as it is now (the teardown's own capture), without tmux in the way. */
  const downCapture = (rigId: string) => h.snapshotCapture.captureSnapshot(rigId, "auto-pre-down").id;
  const tmuxSessions = async () => (await h.tmux.listSessions()).map((s) => s.name);

  async function runCheck(opts: { listed: boolean; startupFrom?: StartupFrom }) {
    const service = createRestoreCheckService(h.rigRepo, h.snapshotRepo, undefined, { runtimeAdapters: { "claude-code": h.adapter }, specReader: h.inst });
    const result = await service.checkWithLiveness({
      rig: "team", noQueue: true, noHooks: true,
      ...(opts.listed ? { freshLogicalIds: [SEAT] } : {}),
      ...(opts.startupFrom ? { startupFrom: opts.startupFrom } : {}),
    } as never);
    const pre = result.checks.find((c) => c.check === "rig.team.restore-preconditions")!;
    return { status: pre.status, evidence: pre.evidence, remediation: pre.remediation };
  }

  async function runRestore(snapshotId: string, opts: { listed: boolean; startupFrom?: StartupFrom }): Promise<{ outcome: Outcome; text: string; warnings: string[] }> {
    try {
      const out = await h.restore.restore(snapshotId, {
        adapters: { "claude-code": h.adapter }, fsOps: { exists },
        ...(opts.listed ? { freshLogicalIds: [SEAT] } : {}),
        ...(opts.startupFrom ? { startupFrom: opts.startupFrom } : {}),
      } as never);
      if (!out.ok) {
        const blockers = out.result?.blockers ?? [];
        return { outcome: out.code === "restore_error" ? "restore-ended" : "pre-restore-refused", text: blockers.map((b) => b.message).join("; ") || (out.message ?? ""), warnings: [] };
      }
      const node = out.result.nodes.find((n) => n.logicalId === SEAT)!;
      const warnings = out.result.warnings;
      if (node.status === "awaiting-decision") return { outcome: "awaiting", text: node.error ?? "", warnings };
      if (node.status === "attention_required") return { outcome: "attention", text: node.error ?? "", warnings };
      if (node.status !== "failed") return { outcome: "ok", text: "", warnings };
      const refused = /^Fresh start refused: (.*) No session was started\.$/s.exec(node.error ?? "");
      return refused ? { outcome: "seat-refused", text: refused[1]!, warnings } : { outcome: "failed-after-launch", text: node.error ?? "", warnings };
    } catch (err) {
      return { outcome: "restore-ended", text: (err as Error).message, warnings: [] };
    }
  }

  /** The check is never greener than restore and never redder: red exactly when restore does not come up cleanly. */
  function expectAgreement(check: { status: string; evidence: string }, restore: { outcome: Outcome; text: string }) {
    expect(check.status === "red", `check ${check.status}: ${check.evidence}; restore ${restore.outcome}: ${restore.text}`).toBe(restore.outcome !== "ok");
    if (restore.outcome === "pre-restore-refused" || restore.outcome === "seat-refused") expect(check.evidence).toContain(restore.text);
  }

  // --- a seat restore starts fresh without being listed (a plain `rig up --existing`) ----------------------------------
  // The row breaks after a snapshot that holds a readable copy (S1); `rig down` then copies the broken row (S2) and
  // `rig up --existing` picks S2. Restore must start the seat from S1's copy, and the row must be readable afterwards.
  it.each(SHAPES.map(([name, col, value]) => [name, col, value] as const))(
    "unlisted, an earlier snapshot holds a readable copy: %s -> starts from that copy and heals the row", async (_name, col, value) => {
      h = createRestoreHarness();
      const seat = await h.launchRig();
      policyFresh(seat.nodeId);
      const s1 = await h.down(seat.rigId);
      setCol(seat.nodeId, col, value);
      const s2 = downCapture(seat.rigId);

      const check = await runCheck({ listed: false });
      const restore = await runRestore(s2, { listed: false });

      expect(restore.outcome, restore.text).toBe("ok");
      expectAgreement(check, restore);
      expect(h.delivered.at(-1)!.map((f) => f.absolutePath)).toEqual(copyOf(s1).resolvedStartupFiles.map((f) => f.absolutePath));
      expect(restore.warnings.join("\n")).toContain(`replays the copy of its startup files saved in snapshot ${s1}`);
      expect(check.evidence).toContain(`replays the copy of its startup files saved in snapshot ${s1}`);
      expect(readStoredStartupContext(h.db, seat.nodeId, ".").ok, "the seat's own row is readable again").toBe(true);
    });

  // OF-39: the own row names another runtime (or none), the snapshot's copy is the seat's. (A snapshot that copied the
  // wrong runtime stops the seat at restore's earlier runtime gate instead: awaiting-decision, not modelled here.)
  it.each(RUNTIME.map(([name, col, value]) => [name, col, value] as const))(
    "unlisted, own row %s, the snapshot's copy is the seat's runtime -> starts from that copy and heals the row", async (_name, col, value) => {
      h = createRestoreHarness();
      const seat = await h.launchRig();
      policyFresh(seat.nodeId);
      const s1 = await h.down(seat.rigId);
      setCol(seat.nodeId, col, value);

      const check = await runCheck({ listed: false });
      const restore = await runRestore(s1, { listed: false });

      expect(restore.outcome, restore.text).toBe("ok");
      expectAgreement(check, restore);
      expect(h.delivered.at(-1)!.map((f) => f.absolutePath)).toEqual(copyOf(s1).resolvedStartupFiles.map((f) => f.absolutePath));
      expect(restore.warnings.join("\n")).toContain(`replays the copy of its startup files saved in snapshot ${s1}`);
      expect(readStoredStartupContext(h.db, seat.nodeId, ".").ok, "the seat's own row is readable again").toBe(true);
      expect((h.db.prepare("SELECT runtime FROM node_startup_context WHERE node_id = ?").get(seat.nodeId) as { runtime: string }).runtime).toBe("claude-code");
    });

  // N-C3: a column that is not JSON. `rig down` cannot copy it, so the earlier snapshot is the one restored.
  it.each(NOT_JSON.map(([name, col, value]) => [name, col, value] as const))(
    "unlisted, not JSON, an earlier snapshot holds a readable copy: %s -> restore() reaches the fallback and heals the row", async (_name, col, value) => {
      h = createRestoreHarness();
      const seat = await h.launchRig();
      policyFresh(seat.nodeId);
      const s1 = await h.down(seat.rigId);
      setCol(seat.nodeId, col, value);

      const check = await runCheck({ listed: false });
      const restore = await runRestore(s1, { listed: false });

      expect(restore.outcome, restore.text).toBe("ok");
      expectAgreement(check, restore);
      expect(h.delivered.at(-1)!.map((f) => f.absolutePath)).toEqual(copyOf(s1).resolvedStartupFiles.map((f) => f.absolutePath));
      expect(readStoredStartupContext(h.db, seat.nodeId, ".").ok, "the seat's own row is readable again").toBe(true);
    });

  // No snapshot holds a readable copy: restore refuses before it starts anything, and the check prints the same text.
  it.each([...SHAPES, ...NOT_JSON, ...RUNTIME].map(([name, col, value]) => [name, col, value] as const))(
    "unlisted, no snapshot holds a readable copy: %s -> refused before anything starts, and the check says so", async (_name, col, value) => {
      h = createRestoreHarness();
      const seat = await h.launchRig({ record: false });
      policyFresh(seat.nodeId);
      const s1 = await h.down(seat.rigId);
      // The only snapshot's copy is broken too (as `rig down` copies a broken row).
      const row = h.db.prepare("SELECT data FROM snapshots WHERE id = ?").get(s1) as { data: string };
      const data = JSON.parse(row.data);
      for (const key of Object.keys(data.nodeStartupContext)) data.nodeStartupContext[key].resolvedStartupFiles = {};
      h.db.prepare("UPDATE snapshots SET data = ? WHERE id = ?").run(JSON.stringify(data), s1);
      setCol(seat.nodeId, col, value);

      const check = await runCheck({ listed: false });
      const restore = await runRestore(s1, { listed: false });

      expect(restore.outcome, restore.text).toBe("pre-restore-refused");
      expect(restore.text).toContain(`${SEAT}: no snapshot of this rig holds a readable copy of its startup files`);
      expect(await tmuxSessions()).toEqual([]);
      expectAgreement(check, restore);
      // This rig records no spec: the remediation must not promise a spec re-read.
      expect(check.remediation).not.toContain("re-reads its spec");
      expect(check.remediation).toContain("repaired outside restore");
    });

  // --- a seat listed with --fresh on a rig that records no spec (OF-41) ---------------------------------------------
  it.each(SHAPES.map(([name, col, value]) => [name, col, value] as const))(
    "listed, no recorded spec, an earlier snapshot holds a readable copy: %s -> starts from that copy", async (_name, col, value) => {
      h = createRestoreHarness();
      const seat = await h.launchRig({ record: false });
      const s1 = await h.down(seat.rigId);
      setCol(seat.nodeId, col, value);
      const s2 = downCapture(seat.rigId);

      const check = await runCheck({ listed: true });
      const restore = await runRestore(s2, { listed: true });

      expect(restore.outcome, restore.text).toBe("ok");
      expectAgreement(check, restore);
      expect(h.delivered.at(-1)!.map((f) => f.absolutePath)).toEqual(copyOf(s1).resolvedStartupFiles.map((f) => f.absolutePath));
      // S1 and S2 name the same files when only the projection or actions broke: the snapshot named is what tells them apart.
      expect(restore.warnings.join("\n")).toContain(`replays the copy of its startup files saved in snapshot ${s1}`);
      expect(readStoredStartupContext(h.db, seat.nodeId, ".").ok, "the seat's own row is readable again").toBe(true);
    });

  it.each(SHAPES.map(([name, col, value]) => [name, col, value] as const))(
    "listed, no recorded spec, only the snapshot rig down took after the break: %s -> the seat is refused, the check is red with the same text", async (_name, col, value) => {
      h = createRestoreHarness();
      const seat = await h.launchRig({ record: false });
      setCol(seat.nodeId, col, value);
      const s1 = await h.down(seat.rigId);

      const check = await runCheck({ listed: true });
      const restore = await runRestore(s1, { listed: true });

      expect(restore.outcome, restore.text).toBe("seat-refused");
      expect(restore.text).toContain("no snapshot of this rig holds a readable copy of its startup files");
      expectAgreement(check, restore);
    });

  // Listed, not JSON (N-C3 on the listed path): `rig down` cannot copy the row, so the earlier snapshot is restored.
  it.each(NOT_JSON.map(([name, col, value]) => [name, col, value] as const))(
    "listed, no recorded spec, not JSON: %s -> starts from the earlier snapshot's copy; with that copy broken too, the seat is refused", async (_name, col, value) => {
      h = createRestoreHarness();
      const seat = await h.launchRig({ record: false });
      const s1 = await h.down(seat.rigId);
      setCol(seat.nodeId, col, value);

      const check = await runCheck({ listed: true });
      const restore = await runRestore(s1, { listed: true });
      expect(restore.outcome, restore.text).toBe("ok");
      expectAgreement(check, restore);
      expect(h.delivered.at(-1)!.map((f) => f.absolutePath)).toEqual(copyOf(s1).resolvedStartupFiles.map((f) => f.absolutePath));
      expect(readStoredStartupContext(h.db, seat.nodeId, ".").ok, "the seat's own row is readable again").toBe(true);

      const s2 = await h.down(seat.rigId);
      setCol(seat.nodeId, col, value);
      for (const row of h.db.prepare("SELECT id FROM snapshots").all() as Array<{ id: string }>) {
        const data = JSON.parse((h.db.prepare("SELECT data FROM snapshots WHERE id = ?").get(row.id) as { data: string }).data);
        for (const key of Object.keys(data.nodeStartupContext ?? {})) if (data.nodeStartupContext[key]) data.nodeStartupContext[key].resolvedStartupFiles = {};
        h.db.prepare("UPDATE snapshots SET data = ? WHERE id = ?").run(JSON.stringify(data), row.id);
      }
      const check2 = await runCheck({ listed: true });
      const refused = await runRestore(s2, { listed: true });
      expect(refused.outcome, refused.text).toBe("seat-refused");
      expect(refused.text).toContain("no snapshot of this rig holds a readable copy of its startup files, and its saved startup context cannot be used: a column is not JSON");
      expectAgreement(check2, refused);
    });

  // --- a `rig launch` target (launchSingleNode): no pre-restore validation, so the seat itself is refused -------------
  const launchSeat = (rigId: string) => h.restore.launchSingleNode(rigId, SEAT, { adapters: { "claude-code": h.adapter }, fsOps: { exists } } as never);
  const breakOnlyCopy = (snapshotId: string) => {
    const row = h.db.prepare("SELECT data FROM snapshots WHERE id = ?").get(snapshotId) as { data: string };
    const data = JSON.parse(row.data);
    for (const key of Object.keys(data.nodeStartupContext)) data.nodeStartupContext[key].resolvedStartupFiles = {};
    h.db.prepare("UPDATE snapshots SET data = ? WHERE id = ?").run(JSON.stringify(data), snapshotId);
  };
  it.each([...SHAPES, ...NOT_JSON, ...RUNTIME].map(([name, col, value]) => [name, col, value] as const))(
    "rig launch, checkpoint_only: %s -> starts from an earlier readable copy and heals; with none, refused before its launch", async (_name, col, value) => {
      h = createRestoreHarness();
      const seat = await h.launchRig({ record: false });
      policyFresh(seat.nodeId);
      const s1 = await h.down(seat.rigId);
      setCol(seat.nodeId, col, value);

      const launched = await launchSeat(seat.rigId);
      const node = launched.ok ? launched.launched![0]! : null;
      expect(node?.status, JSON.stringify(launched)).toBe("fresh-primed");
      expect(node?.startupSource).toMatchObject({ kind: "snapshot", reason: "saved_context_unreadable" });
      expect(h.delivered.at(-1)!.map((f) => f.absolutePath)).toEqual(copyOf(s1).resolvedStartupFiles.map((f) => f.absolutePath));
      expect(readStoredStartupContext(h.db, seat.nodeId, ".").ok, "the seat's own row is readable again").toBe(true);

      // Again with no snapshot holding a readable copy: the seat is refused before its launch and nothing is started.
      policyFresh(seat.nodeId); // the occupant `rig launch` just started has the default policy again
      const s2 = await h.down(seat.rigId);
      setCol(seat.nodeId, col, value);
      breakOnlyCopy(s1);
      breakOnlyCopy(s2);
      for (const pre of h.db.prepare("SELECT id FROM snapshots WHERE kind = 'pre_restore'").all() as Array<{ id: string }>) breakOnlyCopy(pre.id);
      const refused = await launchSeat(seat.rigId);
      const refusedNode = refused.ok ? refused.launched![0]! : null;
      expect(refusedNode?.status, JSON.stringify(refused)).toBe("failed");
      expect(refusedNode?.error).toMatch(/^Fresh start refused: dev\.impl: no snapshot of this rig holds a readable copy of its startup files, and its saved startup context cannot be used: /);
      expect(refusedNode?.error).toContain("There is no spec to re-read for this seat");
      expect(refusedNode?.error).toMatch(/No session was started\.$/);
      expect(h.delivered).toEqual([]);
      expect(await tmuxSessions()).toEqual([]);
    });

  // --- a seat that resumes, from a snapshot rig down took after the break (D5 on the resume path) ---------------------
  // A seat that resumes replays nothing, so a broken copy must not change its outcome. The control is the same restore
  // with the copy untouched (in this harness a resume ends attention_required for reasons unrelated to the copy).
  async function resumeOutcome(breakIt: ((nodeId: string) => void) | null): Promise<{ outcome: Outcome; text: string }> {
    h = createRestoreHarness();
    const seat = await h.launchRig();
    breakIt?.(seat.nodeId);
    const s1 = await h.down(seat.rigId);
    const out = await runRestore(s1, { listed: false });
    h.cleanup();
    return out;
  }
  it.each(SHAPES.map(([name, col, value]) => [name, col, value] as const))(
    "a resuming seat whose snapshot copy is broken: %s -> the same outcome as with the copy intact", async (_name, col, value) => {
      const control = await resumeOutcome(null);
      const broken = await resumeOutcome((nodeId) => setCol(nodeId, col, value));
      h = createRestoreHarness(); // afterEach cleans this one

      expect(control.outcome).toBe("attention");
      expect({ outcome: broken.outcome, text: broken.text }).toEqual({ outcome: control.outcome, text: control.text });
    });
});
