// Seat Messaging S4e: on a seat the pump serves, a compaction prompt is a lifecycle row, and the sequence moves on a gate record, never on a
// send. Real database, real SessionTransport, real pump and hand-off; the gate and the hop are stubs, so `sent` is what left for the seat.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { AUTO_PREP_WAIT_MS_DEFAULT, ClaudeCompactionEnforcer } from "../src/domain/claude-compaction-enforcer.js";
import { CompactionStageStore } from "../src/domain/compaction-stage-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { PumpHandOff } from "../src/domain/seat-messaging/hand-off.js";
import { MessagePump } from "../src/domain/seat-messaging/message-pump.js";
import { MessageStore } from "../src/domain/seat-messaging/message-store.js";
import { messageId, type LastHop, type LastHopResult, type SeatGate } from "../src/domain/seat-messaging/ports.js";
import { NO_SEAT_MESSAGING_PORTS } from "../src/domain/seat-messaging/pump-ports.js";
import type { SettingsStore } from "../src/domain/user-settings/settings-store.js";
import { tmuxStub } from "./helpers/tmux-stub.js";

const SEAT = "writer@demo";
const CYCLE = "cycle-1";
const stageId = (stage: string) => `seat-msg-compaction-${CYCLE}-${stage}`;
const BOUNDARY = stageId("turn_boundary");
const RESTORE = stageId("restore_prompt");
const COMPLIANCE = stageId("compliance_prompt");
const tick = { sessionName: SEAT, runtime: "claude-code" as const };
const high = { ...tick, usedPercentage: 95 };
const view = <T,>(fake: object): T => Object.assign(fake);
const policy = { enabled: true, thresholdPercent: 80, preCompactInstruction: "", compactInstruction: "", messageInline: "", messageFilePath: "", postRestoreAuditInstruction: "" };

describe("compaction through the pump", () => {
  let db: Database.Database;
  let home: string;
  let generation: string;
  let clock: number;
  let seen: Set<string>;
  let sent: string[];
  let writes: string[];
  let hopResult: LastHopResult;
  let pump: MessagePump;
  let store: MessageStore;
  let transport: SessionTransport;
  let live: ClaudeCompactionEnforcer[];
  const settings = view<SettingsStore>({ resolveClaudeCompactionPolicy: () => policy });
  const stages = () => new CompactionStageStore(db);
  const row = (id: string) => db.prepare("SELECT * FROM outbox_entries WHERE outbox_id = ?").get(id) as Record<string, unknown> | undefined;
  const settle = async () => { await pump.tick(); await pump.tick(); };
  const record = async (id: string) => { seen.add(id); await settle(); };

  function build(gated: boolean): void {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const rigRepo = new RigRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    const rig = rigRepo.createRig("demo");
    const node = rigRepo.addNode(rig.id, "writer", { role: "worker", runtime: "claude-code" });
    sessionRegistry.updateStatus(sessionRegistry.registerSession(node.id, SEAT).id, "running");
    sessionRegistry.updateBinding(node.id, { attachmentType: "tmux", tmuxSession: SEAT, tmuxPane: "%1" });
    const gate: SeatGate = { version: 1, lookup: async (_seat, id) => (seen.has(id) ? { kind: "seen", record: { id, recordedAt: new Date(clock).toISOString(), nonce: null } } : { kind: "not_seen" }) };
    const hop: LastHop = { attempt: async (message) => { if (hopResult.kind === "sent") sent.push(message.ids[0]); return hopResult; } };
    const ports = gated ? { gateFor: () => gate, hopFor: () => hop } : NO_SEAT_MESSAGING_PORTS;
    store = new MessageStore(db);
    pump = new MessagePump({
      store, ports, directory: { fate: () => ({ kind: "live", occupantGeneration: generation }) }, held: { status: () => "held" },
      senders: { returnToSender: async () => ({ kind: "returned", qitemId: "q" }) }, clock: () => clock, timing: { backoffMs: [60_000] },
    });
    const tmuxAdapter = tmuxStub({
      hasSession: async () => true, probeSession: async () => ({ state: "present" as const }), capturePaneContent: async () => "idle\n❯ ",
      listSessions: async () => [], listWindows: async () => [], listPanes: async () => [], getPanePid: async () => null, getPaneCommand: async () => null,
      sendText: async (_t: string, text: string) => { writes.push(text); return { ok: true as const }; }, sendKeys: async () => ({ ok: true as const }),
    });
    tmuxAdapter.messageHandOff = new PumpHandOff(store, pump, ports);
    transport = new SessionTransport({ db, rigRepo, sessionRegistry, agentActivityStore: new AgentActivityStore({ db, eventBus }), eventBus, tmuxAdapter, sleep: async () => undefined });
  }

  function enforcer(opts: { lapse?: number; receipts?: unknown[]; manualWait?: number } = {}): ClaudeCompactionEnforcer {
    const made = new ClaudeCompactionEnforcer(settings, transport, {
      openrigHome: home, now: () => clock, sleep: async () => { await new Promise((r) => setTimeout(r, 5)); }, resolveOccupantGeneration: () => generation, stageStore: stages(), dedupWindowMs: 0,
      stageContentHoldLapseMs: opts.lapse ?? 60_000, manualPrepWaitMs: opts.manualWait ?? 400, onPostRestoreComplete: (receipt) => { opts.receipts?.push(receipt); },
    });
    live.push(made);
    return made;
  }
  function seed(stage: "turn_boundary" | "restore_prompt" | "compliance_prompt", manual: { stage: string; updatedAt: number; operatorInitiated?: boolean } | null = null) {
    stages().save({ sessionName: SEAT, stage, stageGeneration: "gen-1", stageCycle: CYCLE, manual, preparation: null });
  }
  const content = async (id: string) => { await transport.send(SEAT, `content ${id}`, { deliveryId: id, actorSession: "lead@demo" }); await settle(); };
  const preparation = (over: object = {}) => ({ attemptId: "a1", occupantGeneration: "gen-1", mapPath: join(home, "a1", "map.md"), marker: "m", mode: "automatic" as const, status: "waiting" as const, delivery: "pending" as const, deadlineAt: null, sends: 1, policyWasEnabled: true, ...over });

  beforeEach(() => {
    home = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "cpump-"));
    generation = "gen-1"; clock = 1_000_000; seen = new Set(); sent = []; writes = []; hopResult = { kind: "sent" }; live = [];
  });
  afterEach(() => { for (const e of live) e.invalidateOccupant(SEAT); pump?.stop(); db.close(); rmSync(home, { recursive: true, force: true }); });

  it("accepts a stage in lane 1 for its occupant, and stays on it until the gate records it", async () => {
    build(true); seed("turn_boundary");
    const e = enforcer();
    expect(await e.drainPendingPostCompactStage(tick)).toEqual({ triggered: true });
    await settle();
    expect(row(BOUNDARY)).toMatchObject({ class: "lifecycle", lane: 1, occupant_generation: "gen-1", message_state: "attempting" });
    for (let i = 0; i < 3; i++) expect(await e.drainPendingPostCompactStage(tick)).toEqual({ triggered: false, reason: "stage_in_flight" });
    expect(row(RESTORE)).toBeUndefined();
    expect(writes).toEqual([]);

    await record(BOUNDARY);
    expect(await e.drainPendingPostCompactStage(tick)).toEqual({ triggered: true });
    await settle();
    expect(sent).toEqual([BOUNDARY, RESTORE]);
    expect(stages().loadAll()[0]).toMatchObject({ stage: "restore_prompt" });
  });

  it("runs the three stages in order and ends only when the gate records the last, with the receipt, the manual stage and an empty store", async () => {
    build(true); seed("turn_boundary", { stage: "compact-sent", updatedAt: 1, operatorInitiated: true });
    const receipts: unknown[] = [];
    const e = enforcer({ receipts });
    const sampled = { ...tick, usedPercentage: 10 };
    for (const id of [BOUNDARY, RESTORE, COMPLIANCE]) { await e.maybeAutoCompact(sampled); await settle(); await record(id); }
    expect(sent).toEqual([BOUNDARY, RESTORE, COMPLIANCE]);
    expect(e.hasPendingPostCompactStage(SEAT)).toBe(true);
    expect(e.getManualCompactionState(SEAT)?.stage).toBe("restore-sent");
    expect(receipts).toEqual([]);
    await e.maybeAutoCompact(sampled);
    expect(e.hasPendingPostCompactStage(SEAT)).toBe(false);
    expect(e.getManualCompactionState(SEAT)?.stage).toBe("audit-sent");
    expect(receipts).toHaveLength(1);
    expect(stages().loadAll()).toEqual([expect.objectContaining({ stage: null })]);
  });

  it("a restart with the row open accepts nothing new; with the row recorded it goes on to the next stage and never repeats the last", async () => {
    build(true); seed("restore_prompt");
    await enforcer().drainPendingPostCompactStage(tick);
    await settle();
    expect(await enforcer().drainPendingPostCompactStage(tick)).toEqual({ triggered: false, reason: "stage_in_flight" });
    await record(RESTORE);
    await enforcer().drainPendingPostCompactStage(tick);
    await settle();
    expect(sent).toEqual([RESTORE, COMPLIANCE]);
  });

  it("nothing in the content lane lands between stages, and it goes once the last stage is out", async () => {
    build(true); seed("turn_boundary");
    const e = enforcer();
    await e.drainPendingPostCompactStage(tick);
    await settle();
    await record(BOUNDARY);
    await content("between");           // the boundary is recorded and the restore is not accepted yet: lane order alone would let it through
    expect(sent).toEqual([BOUNDARY]);
    expect(row("between")).toMatchObject({ message_pause_reason: "lane_held" });
    await e.drainPendingPostCompactStage(tick); await settle(); await record(RESTORE);
    await settle();
    expect(sent).toEqual([BOUNDARY, RESTORE]);
    await e.drainPendingPostCompactStage(tick); await settle(); await record(COMPLIANCE);
    await settle();
    expect(sent).toEqual([BOUNDARY, RESTORE, COMPLIANCE, "between"]);
  });

  it("the hold is taken again after a restart, from the persisted stage", async () => {
    build(true); seed("restore_prompt");
    await enforcer({ lapse: 5 }).drainPendingPostCompactStage(tick);
    await settle(); await record(RESTORE);
    await new Promise((r) => setTimeout(r, 30));   // the old process's hold is gone, as a crash leaves it
    const e = enforcer();
    await content("after-boot");
    expect(sent).toEqual([RESTORE]);
    await e.drainPendingPostCompactStage(tick); await settle();
    expect(sent).toEqual([RESTORE, COMPLIANCE]);
  });

  it("a restart with the last stage open: the hold it took goes when that stage ends the sequence", async () => {
    build(true); seed("compliance_prompt");
    await enforcer({ lapse: 5 }).drainPendingPostCompactStage(tick);
    await settle();
    const e = enforcer();
    await record(COMPLIANCE);
    await e.drainPendingPostCompactStage(tick);
    await content("after");
    expect(sent).toEqual([COMPLIANCE, "after"]);
  });

  it("a saved stage with no sequence id gets one, once, so its attempts are one row", async () => {
    build(true);
    stages().save({ sessionName: SEAT, stage: "turn_boundary", stageGeneration: "gen-1", stageCycle: null, manual: null, preparation: null });
    const e = enforcer();
    await e.drainPendingPostCompactStage(tick);
    await settle();
    expect(await e.drainPendingPostCompactStage(tick)).toEqual({ triggered: false, reason: "stage_in_flight" });
    await settle();
    expect(sent).toHaveLength(1);
    expect(stages().loadAll()[0]?.stageCycle).toEqual(expect.any(String));
  });

  it("a sequence no poll moves lets the content lane go: no message waits on a usage sample", async () => {
    build(true); seed("turn_boundary");
    const e = enforcer({ lapse: 20 });
    await e.drainPendingPostCompactStage(tick);
    await settle(); await record(BOUNDARY);
    await content("waits");
    expect(sent).toEqual([BOUNDARY]);
    await new Promise((r) => setTimeout(r, 60));
    await settle();
    expect(sent).toEqual([BOUNDARY, "waits"]);
    await e.drainPendingPostCompactStage(tick);  // a later drain goes on where it was, and holds again
    await settle();
    expect(sent).toEqual([BOUNDARY, "waits", RESTORE]);
    await record("waits");   // or it heads the lane, and the next message waits for it, not for the hold
    await record(RESTORE);
    await content("second");
    expect(sent).toEqual([BOUNDARY, "waits", RESTORE]);
  });

  it("the lapse leaves the hold while the stage's own row is open, so a slow seat keeps it", async () => {
    build(true); seed("turn_boundary");
    const e = enforcer({ lapse: 100 });
    await e.drainPendingPostCompactStage(tick);
    await settle();
    await new Promise((r) => setTimeout(r, 130));   // past the lapse with the row open
    seen.add(BOUNDARY);
    await content("late");
    expect(sent).toEqual([BOUNDARY]);
    await e.drainPendingPostCompactStage(tick);
  });

  it("a stage row that ends without arriving ends the sequence, says so to a manual caller, and frees the lane", async () => {
    build(true); seed("turn_boundary", { stage: "compact-sent", updatedAt: 1, operatorInitiated: true });
    const e = enforcer();
    await e.drainPendingPostCompactStage(tick);
    await settle();
    expect(store.cancel(messageId(BOUNDARY), "occupant ended", new Date(clock).toISOString())).toBe(true);
    expect(await e.drainPendingPostCompactStage(tick)).toEqual({ triggered: false, reason: "stage_undeliverable" });
    expect(e.hasPendingPostCompactStage(SEAT)).toBe(false);
    expect(e.getManualCompactionState(SEAT)).toMatchObject({ stage: "skipped-or-failed", reason: "stage_undeliverable" });
    expect(stages().loadAll()[0]).toMatchObject({ stage: null });
    await content("after");
    expect(sent).toEqual([BOUNDARY, "after"]);
  });

  it("a handover ends the open stage row, so no lifecycle text reaches the successor, and frees the lane", async () => {
    build(true); seed("restore_prompt");
    hopResult = { kind: "paused", reason: "busy" };
    const e = enforcer();
    await e.drainPendingPostCompactStage(tick);
    await settle();
    e.invalidateOccupant(SEAT);
    expect(row(RESTORE)).toMatchObject({ message_state: "undeliverable", message_closed_reason: "stale_generation" });
    hopResult = { kind: "sent" };
    await content("next");
    expect(sent).toEqual(["next"]);
  });

  it("automatic prep: a seat busy for many polls is not a failure, there is no send cap, and the deadline starts at the gate record", async () => {
    build(true);
    hopResult = { kind: "paused", reason: "busy" };
    const e = enforcer();
    expect(await e.maybeAutoCompact(high)).toEqual({ triggered: false, reason: "preparation_pending" });
    for (let i = 0; i < 5; i++) { await settle(); clock += 60_000; expect(await e.maybeAutoCompact(high)).toEqual({ triggered: false, reason: "preparation_pending" }); }
    clock += AUTO_PREP_WAIT_MS_DEFAULT;
    const state = e.getPreparationState(SEAT)!;
    expect(state).toMatchObject({ status: "waiting", delivery: "pending", deadlineAt: null });
    const prep = `seat-msg-compaction-${state.attemptId}-prep`;
    expect((db.prepare("SELECT count(*) AS n FROM outbox_entries WHERE outbox_id LIKE 'seat-msg-compaction-%-prep'").get() as { n: number }).n).toBe(1);
    hopResult = { kind: "sent" };
    await record(prep);
    await e.maybeAutoCompact(high);
    expect(e.getPreparationState(SEAT)).toMatchObject({ status: "waiting", delivery: "delivered", deadlineAt: clock + AUTO_PREP_WAIT_MS_DEFAULT });
  });

  it("prep: a prompt whose row ended without arriving stops the attempt", async () => {
    build(true);
    const e = enforcer();
    await e.maybeAutoCompact(high);
    const prep = messageId(`seat-msg-compaction-${e.getPreparationState(SEAT)!.attemptId}-prep`);
    store.cancel(prep, "gone", new Date(clock).toISOString());
    expect(await e.maybeAutoCompact(high)).toEqual({ triggered: false, reason: "preparation_stopped" });
    expect(e.getPreparationState(SEAT)).toMatchObject({ status: "stopped", reason: "send_failed" });
  });

  it("a cancelled attempt's prompt never arrives late", async () => {
    build(true);
    hopResult = { kind: "paused", reason: "busy" };
    const e = enforcer();
    await e.maybeAutoCompact(high);
    const prep = `seat-msg-compaction-${e.getPreparationState(SEAT)!.attemptId}-prep`;
    await settle();
    e.cancelPreparation(SEAT);
    expect(row(prep)).toMatchObject({ message_state: "undeliverable" });
    hopResult = { kind: "sent" };
    await settle();
    expect(sent).toEqual([]);
  });

  it("a restart keeps a gated prompt pending, with its clock unstarted: the row knows where it is", async () => {
    build(true);
    stages().save({ sessionName: SEAT, stage: null, stageGeneration: null, stageCycle: null, manual: null, preparation: preparation() });
    store.accept({ id: messageId("seat-msg-compaction-a1-prep"), seat: SEAT, sender: "unknown", body: "prep", messageClass: "lifecycle", lane: 1, occupantGeneration: "gen-1" });
    expect(enforcer().getPreparationState(SEAT)).toMatchObject({ delivery: "pending", deadlineAt: null, status: "waiting" });
  });

  it("a restart with no row means the prompt was never accepted, so it goes under the same id", async () => {
    build(true);
    stages().save({ sessionName: SEAT, stage: null, stageGeneration: null, stageCycle: null, manual: null, preparation: preparation({ sends: 3 }) });
    await enforcer().maybeAutoCompact(high);  // reads no row
    await enforcer().maybeAutoCompact(high);  // sends past the old cap
    await settle();
    expect(sent).toEqual(["seat-msg-compaction-a1-prep"]);
  });

  it("manual: /compact waits for the prompt's gate record, and goes by paste, never through the pump, with the lane held behind it", async () => {
    build(true);
    const e = enforcer({ manualWait: 2_000 });
    const done = e.triggerManualCompact(high, { skipMap: true, operatorInitiated: true });
    await new Promise((r) => setTimeout(r, 30));
    await settle();
    expect(writes).toEqual([]);
    const prep = sent[0]!;
    expect(prep).toMatch(/-prep$/);
    await record(prep);
    expect(await done).toEqual({ triggered: true, stage: "compact-sent" });
    expect(writes.join("")).toContain("/compact");
    expect(sent).toEqual([prep]);
    await content("behind");
    expect(sent).toEqual([prep]);
    expect(row(`seat-msg-compaction-${prep.split("-").slice(3, -1).join("-")}-compact`)).toMatchObject({ class: "command", message_state: null });
  });

  it("manual: a prompt the deadline beats fails the request, and its row is ended", async () => {
    build(true);
    hopResult = { kind: "paused", reason: "busy" };
    const e = enforcer({ manualWait: 40 });
    const done = e.triggerManualCompact(high, { skipMap: true });
    await new Promise((r) => setTimeout(r, 20));
    clock += 100;
    expect(await done).toMatchObject({ triggered: false, stage: "skipped-or-failed", reason: "preparation_incomplete" });
    expect(writes).toEqual([]);
    expect((db.prepare("SELECT message_state AS s FROM outbox_entries WHERE outbox_id LIKE '%-prep'").get() as { s: string }).s).toBe("undeliverable");
  });

  it("manual: a prompt whose row ends without arriving fails the request at once, not at its deadline", async () => {
    build(true);
    hopResult = { kind: "paused", reason: "busy" };
    const e = enforcer({ manualWait: 60_000 });
    const done = e.triggerManualCompact(high, { skipMap: true });
    await new Promise((r) => setTimeout(r, 20));
    const prep = messageId(`seat-msg-compaction-${e.getPreparationState(SEAT)!.attemptId}-prep`);
    store.cancel(prep, "gone", new Date(clock).toISOString());
    expect(await done).toMatchObject({ triggered: false, reason: "send_failed" });
    expect(writes).toEqual([]);
  });

  it("a refused /compact leaves the lane free", async () => {
    build(true);
    mkdirSync(join(home, "m"), { recursive: true });
    const e = enforcer();
    await e.maybeAutoCompact(high);
    const state = e.getPreparationState(SEAT)!;
    await settle();
    await record(`seat-msg-compaction-${state.attemptId}-prep`);
    await e.maybeAutoCompact(high);
    mkdirSync(dirname(state.mapPath), { recursive: true });
    writeFileSync(state.mapPath, `map\n${state.marker}\n`);
    expect(existsSync(state.mapPath)).toBe(true);
    const spy = vi.spyOn(transport, "send").mockResolvedValueOnce({ ok: false, sessionName: SEAT, sent: false, reason: "mid_work" });
    expect(await e.maybeAutoCompact(high)).toEqual({ triggered: false, reason: "send_failed" });
    spy.mockRestore();
    await content("free");
    expect(sent).toContain("free");
  });

  it("a /compact that went out for an attempt cancelled meanwhile leaves the lane free", async () => {
    build(true);
    const e = enforcer();
    await e.maybeAutoCompact(high);
    const state = e.getPreparationState(SEAT)!;
    await settle();
    await record(`seat-msg-compaction-${state.attemptId}-prep`);
    await e.maybeAutoCompact(high);
    mkdirSync(dirname(state.mapPath), { recursive: true });
    writeFileSync(state.mapPath, `map\n${state.marker}\n`);
    const spy = vi.spyOn(transport, "send").mockImplementationOnce(async () => { e.cancelPreparation(SEAT); return { ok: true, sessionName: SEAT, sent: true }; });
    await e.maybeAutoCompact(high);
    spy.mockRestore();
    await content("free");
    expect(sent).toContain("free");
  });

  it("an ungated seat keeps its direct path: the stage moves on the send", async () => {
    build(false); seed("turn_boundary");
    const e = enforcer();
    expect(await e.drainPendingPostCompactStage(tick)).toEqual({ triggered: true });
    expect(writes.join("")).toContain("turn boundary");
    expect(stages().loadAll()[0]).toMatchObject({ stage: "restore_prompt" });
  });

  it("an ungated seat keeps its restart rule, pump running or not: a prompt that may have gone out is uncertain, and its clock runs", () => {
    build(false);
    stages().save({ sessionName: SEAT, stage: null, stageGeneration: null, stageCycle: null, manual: null, preparation: preparation() });
    expect(enforcer().getPreparationState(SEAT)).toMatchObject({ delivery: "uncertain", deadlineAt: clock + AUTO_PREP_WAIT_MS_DEFAULT });
  });
});
