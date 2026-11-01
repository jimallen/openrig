// Seat Messaging S1: a daemon restart in the middle of a compaction sequence used to lose the stage, so a seat that had compacted never
// got its restore. The stages now live in `compaction_stages`, and a new enforcer on the same database goes on where the last one was.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { ClaudeCompactionEnforcer } from "../src/domain/claude-compaction-enforcer.js";
import { CompactionStageStore } from "../src/domain/compaction-stage-store.js";
import type { SessionTransport } from "../src/domain/session-transport.js";
import type { SettingsStore } from "../src/domain/user-settings/settings-store.js";

/** The same object, read as the narrow part of `T` the test gives it. */
const view = <T,>(fake: object): T => Object.assign(fake);

const SEAT = "writer@demo";
const tick = { sessionName: SEAT, runtime: "claude-code" as const, usedPercentage: 10 };

describe("compaction stages across a restart", () => {
  let db: Database.Database;
  let home: string;
  let generation: string;
  let clock: number;
  const send = vi.fn();
  const settings = view<SettingsStore>({ resolveClaudeCompactionPolicy: () => ({ enabled: true, thresholdPercent: 80, preCompactInstruction: "", compactInstruction: "", messageInline: "", messageFilePath: "", postRestoreAuditInstruction: "" }) });

  const enforcer = () => new ClaudeCompactionEnforcer(settings, view<SessionTransport>({ send }), {
    openrigHome: home, now: () => clock, sleep: async () => {}, resolveOccupantGeneration: () => generation, stageStore: new CompactionStageStore(db), dedupWindowMs: 0,
  });
  const ids = () => send.mock.calls.map((c) => (c[2] as { deliveryId?: string })?.deliveryId);
  const stored = () => (new CompactionStageStore(db).loadAll());

  beforeEach(() => {
    db = createDb(); migrate(db, ALL_MIGRATIONS); home = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "cstage-")); generation = "gen-1"; clock = 1_000_000;
    send.mockReset(); send.mockResolvedValue({ ok: true, sessionName: SEAT });
  });
  afterEach(() => { db.close(); rmSync(home, { recursive: true, force: true }); });

  /** Seeds the stage the way `sendPreparedCompact` leaves it, through the public store a restart reads. */
  function seed(stage: "turn_boundary" | "restore_prompt" | "compliance_prompt", manual: { stage: string; updatedAt: number; operatorInitiated?: boolean } | null = null) {
    new CompactionStageStore(db).save({ sessionName: SEAT, stage, stageGeneration: "gen-1", stageCycle: "cycle-1", manual, preparation: null });
  }

  it("a seat that compacted before the restart still gets each stage, in order, once, and the row is gone at the end", async () => {
    seed("turn_boundary");
    expect(enforcer().hasPendingPostCompactStage(SEAT)).toBe(true);
    await enforcer().drainPendingPostCompactStage(tick);              // first boot
    await enforcer().drainPendingPostCompactStage(tick);              // restart after turn_boundary
    await enforcer().drainPendingPostCompactStage(tick);              // restart after restore_prompt
    expect(ids()).toEqual(["seat-msg-compaction-cycle-1-turn_boundary", "seat-msg-compaction-cycle-1-restore_prompt", "seat-msg-compaction-cycle-1-compliance_prompt"]);
    expect(stored()).toEqual([]);
    expect(enforcer().hasPendingPostCompactStage(SEAT)).toBe(false);
  });

  it("a stage whose send failed stays, and its retry after a restart carries the same id", async () => {
    seed("restore_prompt");
    send.mockResolvedValueOnce({ ok: false, sessionName: SEAT, reason: "mid_work" });
    await enforcer().drainPendingPostCompactStage(tick);
    await enforcer().drainPendingPostCompactStage(tick);
    expect(new Set(ids())).toEqual(new Set(["seat-msg-compaction-cycle-1-restore_prompt"]));
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]![2]).toMatchObject({ freezeBody: true, messageClass: "lifecycle", lane: 1, occupantGeneration: "gen-1" });
  });

  it("a stage saved by a retired occupant never reaches the successor, and is dropped", async () => {
    seed("restore_prompt");
    generation = "gen-2";
    await enforcer().drainPendingPostCompactStage(tick);
    expect(send).not.toHaveBeenCalled();
    expect(stored()).toEqual([]);
  });

  it("an operator's manual sequence keeps its exemption from the disabled policy across the restart", async () => {
    seed("restore_prompt", { stage: "compact-sent", updatedAt: 1, operatorInitiated: true });
    const off = view<SettingsStore>({ resolveClaudeCompactionPolicy: () => ({ enabled: false, thresholdPercent: 80 }) });
    const e = new ClaudeCompactionEnforcer(off, view<SessionTransport>({ send }), { openrigHome: home, resolveOccupantGeneration: () => generation, stageStore: new CompactionStageStore(db), sleep: async () => {} });
    await e.drainPendingPostCompactStage(tick);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("invalidating the occupant removes the saved stage: a successor's restart must not find it", () => {
    seed("turn_boundary");
    enforcer().invalidateOccupant(SEAT);
    expect(stored()).toEqual([]);
  });

  it("a preparation that may have gone out is never resent after a restart: it waits for its map, and its deadline ends it", async () => {
    new CompactionStageStore(db).save({ sessionName: SEAT, stage: null, stageGeneration: null, stageCycle: null, manual: null, preparation: {
      attemptId: "a1", occupantGeneration: "gen-1", mapPath: join(home, "map.md"), marker: "m", mode: "automatic", status: "waiting", delivery: "pending", deadlineAt: null, sends: 1, policyWasEnabled: true,
    } });
    const e = enforcer();
    expect(e.getPreparationState(SEAT)).toMatchObject({ delivery: "uncertain", status: "waiting" });
    await e.maybeAutoCompact({ ...tick, usedPercentage: 95 });
    expect(send).not.toHaveBeenCalled();
    clock += 26 * 60_000;
    expect(e.getPreparationState(SEAT)).toMatchObject({ status: "stopped", reason: "preparation_incomplete" });
  });

  it("one unreadable row costs only that seat", () => {
    seed("turn_boundary");
    db.prepare("INSERT INTO compaction_stages (session_name, state, updated_at) VALUES ('bad@demo', '{', 'x')").run();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(enforcer().hasPendingPostCompactStage(SEAT)).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
