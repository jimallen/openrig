// OF-263. One seat whose occupant cannot be settled used to refuse the WHOLE rig. Two things made it so, both measured at
// fork/main 659b989b7: a snapshot that records a seat as ambiguous over fewer than two rows (a fresh-launch record that names a
// row the seat can no longer resume, a damaged one, two contradicting ones) was judged not restore-usable, so no seat of the rig
// could be restored from it; and the fallback that captures the current state refused the rig for that seat's missing startup
// context or live token, although restore fails the ambiguous seat before it starts anything in it. The refusal is now the seat's
// alone: it is named, with the reason, and the other seats restore. (Two or more candidates, "H2", was already per seat: the control.)
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { snapshotMatchesCurrentOccupants, assessCurrentStateRehydrateEligibility } from "../src/domain/rehydrate-eligibility.js";
import { buildRestorePlanPreview, collectPreviewSessionRows } from "../src/domain/restore-plan-preview.js";
import { readFreshOccupantRelations } from "../src/domain/fresh-occupant-relation.js";

type Row = "running" | "detached" | "exited" | "superseded";
type Shape = "none" | "dangling" | "damaged" | "contradict";

describe("one ambiguous seat does not refuse the rig (OF-263)", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;
  beforeEach(() => { db = createFullTestDb(); setup = createTestApp(db); });
  afterEach(() => { db.close(); });

  const post = (path: string, body: unknown) =>
    setup.app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  /** Two healthy siblings and one seat with `rows` and the given fresh-launch record shape. */
  function seed(name: string, rows: Row[], shape: Shape) {
    const { rigRepo, sessionRegistry } = setup;
    const rig = rigRepo.createRig(name);
    for (const sibling of ["cos", "arch"]) {
      const node = rigRepo.addNode(rig.id, sibling, { runtime: "claude-code" });
      const row = sessionRegistry.registerSession(node.id, `${sibling}@${name}`);
      sessionRegistry.updateResumeToken(row.id, "claude_name", `${sibling}-native`, "hook");
      sessionRegistry.updateStatus(row.id, "running");
    }
    const node = rigRepo.addNode(rig.id, "seat", { runtime: "claude-code" });
    const made = rows.map((state, i) => {
      const row = sessionRegistry.registerSession(node.id, `seat@${name}`);
      sessionRegistry.updateResumeToken(row.id, "claude_name", `seat-native-${i}`, "hook");
      if (state === "superseded") sessionRegistry.markSuperseded(row.id); else sessionRegistry.updateStatus(row.id, state);
      return row;
    });
    const generation = sessionRegistry.currentOccupantTenure(node.id)!.generationUuid;
    const event = (payload: string) => db.prepare("INSERT INTO events (rig_id, node_id, type, payload) VALUES (?, ?, 'seat.fresh_launched', ?)").run(rig.id, node.id, payload);
    if (shape === "dangling") event(JSON.stringify({ nodeId: node.id, sessionId: made[0]!.id, newGeneration: generation }));
    if (shape === "damaged") event("{not json");
    if (shape === "contradict") for (const row of made) event(JSON.stringify({ nodeId: node.id, sessionId: row.id, newGeneration: generation }));
    return { rig, node, made };
  }

  const sentTexts = () => vi.mocked(setup.tmuxAdapter.sendText).mock.calls.map((call) => String(call[1]));

  // [label, the seat's rows, the fresh-launch record, candidates the capture records]
  const ambiguous: Array<[string, Row[], Shape, number]> = [
    ["a fresh-launch record names a row the seat cannot resume (superseded)", ["superseded", "exited"], "dangling", 0],
    ["a fresh-launch record is damaged and one live row remains", ["detached"], "damaged", 1],
    ["two fresh-launch records contradict each other", ["superseded", "detached"], "contradict", 1],
    ["control, two candidates: two detached rows", ["detached", "detached"], "none", 2],
  ];

  describe.each(ambiguous)("%s", (_label, rows, shape, candidates) => {
    it.each([[false], [true]])("rig up --existing (after rig down: %s) restores the siblings and names the seat that waits, with the reason", async (down) => {
      const { rig } = seed("whole", rows, shape);
      setup.snapshotCapture.captureSnapshot(rig.id, "auto-periodic");
      if (down) expect((await post("/api/down", { rigId: rig.id, force: true })).status).toBe(200);
      const up = await post("/api/up", { sourceRef: rig.name });
      const body = await up.json() as { error?: string; code?: string; rigResult?: string; nodes?: Array<{ logicalId: string; status: string; error?: string }> };
      expect({ status: up.status, error: body.error, code: body.code }).toEqual({ status: 200, error: undefined, code: undefined });
      const byName = Object.fromEntries((body.nodes ?? []).map((n) => [n.logicalId, n]));
      // The seat is named and says why; nothing was started in it.
      expect(byName["seat"]?.status).toBe("failed");
      expect(byName["seat"]?.error ?? "").toContain(`Active-occupant ambiguity: ${candidates} candidate session rows`);
      expect(byName["seat"]?.error ?? "").toContain("Seat unrecoverable until resolved");
      // The harness tmux fake cannot observe a resumed Claude pane, so a restored seat reads attention_required with that one reason.
      for (const sibling of ["cos", "arch"]) {
        expect(byName[sibling]?.status, sibling).toBe("attention_required");
        expect(byName[sibling]?.error ?? "Claude resume observation unavailable").toContain("Claude resume observation unavailable");
      }
      expect(body.rigResult).toBe("partially_restored");
      const sent = sentTexts();
      expect(sent.some((text) => text.includes("cos-native"))).toBe(true);
      expect(sent.some((text) => text.includes("arch-native"))).toBe(true);
      expect(sent.some((text) => text.includes("seat-native"))).toBe(false);
    });
  });

  it("a zero- or one-candidate ambiguity says what it is, not that the snapshot recorded multiple candidates", async () => {
    const { rig } = seed("wording", ["superseded", "exited"], "dangling");
    const up = await post("/api/up", { sourceRef: rig.name });
    const body = await up.json() as { nodes?: Array<{ logicalId: string; error?: string }> };
    const error = body.nodes?.find((n) => n.logicalId === "seat")?.error ?? "";
    expect(error).toContain("could not settle this seat's occupant at capture");
    expect(error).not.toContain("multiple live occupant candidates");
  });

  describe("the pieces", () => {
    it("a snapshot that records a seat ambiguous over zero or one rows is restore-usable; a duplicated or foreign candidate is not", () => {
      const { rig, node, made } = seed("usable", ["superseded", "exited"], "dangling");
      const snapshot = setup.snapshotCapture.captureSnapshot(rig.id, "auto-rehydrate");
      expect(snapshot.data.activeOccupantsByNode?.[node.id]).toEqual({ kind: "ambiguous", candidateIds: [] });
      const repo = new SnapshotRepository(db);
      expect(repo.selectRestoreUsable(rig.id, snapshot.id).ok).toBe(true);
      const withCandidates = (candidateIds: string[]) => {
        const data = JSON.parse(JSON.stringify(snapshot.data));
        data.activeOccupantsByNode[node.id] = { kind: "ambiguous", candidateIds };
        return repo.createSnapshot(rig.id, "manual", data).id;
      };
      expect(repo.selectRestoreUsable(rig.id, withCandidates([made[0]!.id])).ok).toBe(true);
      expect(repo.selectRestoreUsable(rig.id, withCandidates([made[0]!.id, made[0]!.id]))).toMatchObject({ ok: false, code: "snapshot_unusable" });
      expect(repo.selectRestoreUsable(rig.id, withCandidates(["not-a-row-of-this-seat"]))).toMatchObject({ ok: false, code: "snapshot_unusable" });
    });

    it("a snapshot that records the seat ambiguous matches a present that is ambiguous too; one that names an occupant does not", () => {
      const { rig, node } = seed("match", ["detached", "detached"], "none");
      const rigFull = () => setup.rigRepo.getRig(rig.id)!;
      const ambiguousSnapshot = setup.snapshotCapture.captureSnapshot(rig.id, "auto-rehydrate");
      expect(snapshotMatchesCurrentOccupants(db, rigFull(), ambiguousSnapshot)).toBe(true);
      const naming = JSON.parse(JSON.stringify(ambiguousSnapshot.data));
      naming.activeOccupantsByNode[node.id] = { kind: "resolved", sessionId: ambiguousSnapshot.data.sessions.find((s) => s.nodeId === node.id)!.id };
      expect(snapshotMatchesCurrentOccupants(db, rigFull(), { ...ambiguousSnapshot, data: naming })).toBe(false);
      const absent = JSON.parse(JSON.stringify(ambiguousSnapshot.data));
      absent.activeOccupantsByNode[node.id] = { kind: "absent" };
      expect(snapshotMatchesCurrentOccupants(db, rigFull(), { ...ambiguousSnapshot, data: absent })).toBe(false);
    });

    it("the eligibility gate lets an ambiguous seat go (restore fails it alone) but still refuses the rig for another seat that cannot start", () => {
      const { rig } = seed("elig", ["superseded", "exited"], "dangling");
      expect(assessCurrentStateRehydrateEligibility(db, setup.rigRepo.getRig(rig.id)!)).toEqual({ ok: true, blockers: [] });
      // arch loses every token: it would start fresh with neither startup context nor token, which restore cannot do.
      const arch = setup.rigRepo.getRig(rig.id)!.nodes.find((n) => n.logicalId === "arch")!;
      db.prepare("UPDATE sessions SET resume_token = NULL, resume_type = NULL WHERE node_id = ?").run(arch.id);
      expect(assessCurrentStateRehydrateEligibility(db, setup.rigRepo.getRig(rig.id)!).blockers).toEqual(["node arch has runtime claude-code but no startup context or resume token"]);
    });

    it("the plan forecasts the same failure for the seat, in restore's own words", () => {
      const { rig } = seed("plan", ["superseded", "exited"], "dangling");
      const rigFull = setup.rigRepo.getRig(rig.id)!;
      const plan = buildRestorePlanPreview(rigFull, null, collectPreviewSessionRows(db, rigFull, null), undefined, Date.now(), readFreshOccupantRelations(db, rig.id));
      const seat = plan.nodes.find((n) => n.logicalId === "seat")!;
      expect(seat.intendedAction).toBe("awaiting-decision");
      expect(seat.reason ?? "").toContain("Active-occupant ambiguity: 0 candidate session rows");
    });
  });
});
