// OF-260. A seat whose occupant of record has ENDED (its `rig seat launch --fresh` successor was stopped, or a deliberate stop came
// after its last live row) is a seat with no live occupant, not an ambiguity over its rows. The capture (OF-255) records it that
// way. This file holds the other readers of the current state to the same rule: the plan preview that forecasts a restore when
// there is no snapshot, the eligibility gate in front of the fallback (auto-rehydrate) capture, and the whole `rig up --existing`
// that falls back to that capture. Shapes are the ones measured at fork/main 659b989b7 (rows oldest first; `exited*` = ended by a
// supported stop, `fresh=N` = a seat.fresh_launched event naming row N).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { buildRestorePlanPreview, collectPreviewSessionRows } from "../src/domain/restore-plan-preview.js";
import { readFreshOccupantRelations } from "../src/domain/fresh-occupant-relation.js";
import { assessCurrentStateRehydrateEligibility } from "../src/domain/rehydrate-eligibility.js";

type Row = "running" | "detached" | "exited" | "exited*" | "superseded";

describe("seats whose occupant of record has ended: every reader of the current state agrees with the capture (OF-260)", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;
  beforeEach(() => { db = createFullTestDb(); setup = createTestApp(db); });
  afterEach(() => { db.close(); });

  /** A rig of a live sibling ("live", running with a token) and the seat under test with `rows` and an optional fresh event. */
  function seed(name: string, rows: Row[], fresh: number | null) {
    const { rigRepo, sessionRegistry } = setup;
    const rig = rigRepo.createRig(name);
    const live = rigRepo.addNode(rig.id, "live", { runtime: "claude-code" });
    const liveRow = sessionRegistry.registerSession(live.id, `live@${name}`);
    sessionRegistry.updateResumeToken(liveRow.id, "claude_name", "live-native", "hook");
    sessionRegistry.updateStatus(liveRow.id, "running");
    const node = rigRepo.addNode(rig.id, "seat", { runtime: "claude-code" });
    const made = rows.map((state, i) => {
      const row = sessionRegistry.registerSession(node.id, `seat@${name}`);
      sessionRegistry.updateResumeToken(row.id, "claude_name", `seat-native-${i}`, "hook");
      if (state === "exited*") sessionRegistry.markIntentionallyStopped(row.id);
      else if (state === "superseded") sessionRegistry.markSuperseded(row.id);
      else sessionRegistry.updateStatus(row.id, state);
      return row;
    });
    if (fresh !== null) {
      db.prepare("INSERT INTO events (rig_id, type, payload) VALUES (?, 'seat.fresh_launched', ?)").run(rig.id, JSON.stringify({
        nodeId: node.id, sessionId: made[fresh]!.id, newGeneration: sessionRegistry.currentOccupantTenure(node.id)!.generationUuid,
      }));
    }
    return { rig, node, made };
  }

  const planOf = (rigId: string) => {
    const rig = setup.rigRepo.getRig(rigId)!;
    return buildRestorePlanPreview(rig, null, collectPreviewSessionRows(db, rig, null), undefined, Date.now(), readFreshOccupantRelations(db, rigId)).nodes.find((n) => n.logicalId === "seat")!;
  };

  // Shapes whose occupant of record ended: no live occupant, history holds a token.
  const ended: Array<[string, Row[], number | null]> = [
    ["a stopped fresh successor", ["superseded", "exited*"], 1],
    ["a fresh successor that ended without the stop mark", ["superseded", "exited"], 1],
    ["a seat stopped on purpose, no fresh launch", ["exited*"], null],
    ["a detached row left behind by a later deliberate stop", ["detached", "exited*"], null],
  ];

  describe.each(ended)("%s", (_label, rows, fresh) => {
    it("the capture records no occupant (green at base: OF-255 already did this)", () => {
      const { rig, node } = seed("cap", rows, fresh);
      const snapshot = setup.snapshotCapture.captureSnapshot(rig.id, "auto-rehydrate");
      expect(snapshot.data.activeOccupantsByNode?.[node.id]).toEqual({ kind: "absent" });
    });

    it("the plan preview forecasts the same: no occupant, never an ambiguity over the seat's rows", () => {
      const { rig } = seed("plan", rows, fresh);
      const node = planOf(rig.id);
      expect(node.occupantSessionId).toBeNull();
      expect(node.reason ?? "").not.toContain("Active-occupant ambiguity");
      // The seat has a token in its history, so restore stops it for a decision with the absent-seat wording.
      expect(node.intendedAction).toBe("awaiting-decision");
      expect(node.reason ?? "").toContain("Original session not resumed");
    });

    it("the eligibility gate does not refuse the rig for that seat (it has no startup context and no live token, and needs neither)", () => {
      const { rig } = seed("elig", rows, fresh);
      expect(assessCurrentStateRehydrateEligibility(db, setup.rigRepo.getRig(rig.id)!)).toEqual({ ok: true, blockers: [] });
    });
  });

  it("control: a seat with no token anywhere in its history IS still refused by the eligibility gate (the decision is derived, not constant)", () => {
    const { rig, node } = seed("notoken", ["exited*"], null);
    db.prepare("UPDATE sessions SET resume_token = NULL, resume_type = NULL WHERE node_id = ?").run(node.id);
    expect(assessCurrentStateRehydrateEligibility(db, setup.rigRepo.getRig(rig.id)!).blockers).toEqual(["node seat has runtime claude-code but no startup context or resume token"]);
  });

  it("control: a seat whose last live row is detached keeps its occupant in the plan, and is not waived by the eligibility gate's new rule", () => {
    const { rig, made } = seed("detached", ["superseded", "detached"], 1);
    expect(planOf(rig.id).occupantSessionId).toBe(made[1]!.id);
    expect(assessCurrentStateRehydrateEligibility(db, setup.rigRepo.getRig(rig.id)!)).toEqual({ ok: true, blockers: [] });
  });

  it("a fresh record naming a row the seat does not hold is still loud: the capture is ambiguous with no candidates, and the plan says so (the rule is not over-widened)", () => {
    const { rig, node } = seed("dangling", ["superseded", "exited*"], 0);
    const snapshot = setup.snapshotCapture.captureSnapshot(rig.id, "auto-rehydrate");
    expect(snapshot.data.activeOccupantsByNode?.[node.id]).toEqual({ kind: "ambiguous", candidateIds: [] });
    expect(planOf(rig.id).reason ?? "").toContain("Active-occupant ambiguity: 0 candidate session rows");
  });

  // The whole path: no usable snapshot, so `rig up --existing` captures the current state (the fallback) and restores from it.
  it("`rig up --existing` with no snapshot restores the live sibling and stops the ended seat for a decision, instead of refusing the rig", async () => {
    const { rig } = seed("whole", ["superseded", "exited*"], 1);
    db.prepare("DELETE FROM snapshots WHERE rig_id = ?").run(rig.id);
    const up = await setup.app.request("/api/up", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceRef: rig.name }) });
    const body = await up.json() as { error?: string; nodes?: Array<{ logicalId: string; status: string }> };
    expect({ status: up.status, error: body.error }).toEqual({ status: 200, error: undefined });
    expect(body.nodes?.find((n) => n.logicalId === "seat")?.status).toBe("awaiting-decision");
    const sent = vi.mocked(setup.tmuxAdapter.sendText).mock.calls.map((call) => String(call[1]));
    expect(sent.some((text) => text.includes("live-native"))).toBe(true);
    expect(sent.some((text) => text.includes("seat-native"))).toBe(false);
  });
});
