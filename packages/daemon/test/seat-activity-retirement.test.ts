import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { HcAdapter } from "../src/adapters/hc-adapter.js";
import { HcIdentity } from "../src/adapters/hc-identity.js";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
import { runtimeRungInventory } from "../src/domain/activity-taxonomy.js";
import { readWaitingView } from "../src/domain/queue-waiting.js";
import { findHc, startHcScratch } from "./helpers/hc-scratch.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

// hc has no window-activity clock (design-hc-cutover §3 gap 4; HcIdentity says so, and HcAdapter wires none), so a live hc seat
// gives the sampler no timestamp unless a source is passed: which source is a product call, not made here. This suite's subject is
// RETIREMENT, which reads the core's real membership (the seats it lists, whether one is there), so it passes a clock of its own:
// every seat last moved in 2023, far from wall clock, hence idle at every sweep, as the injected reader clock made them before.
const STALE_ACTIVITY_SECONDS = 1_700_000_000;

async function fixture() {
  const scratch = mkdtempSync(path.join(tmpdir(), "retire-"));
  const core = startHcScratch();
  const db = new Database(path.join(scratch, "state.db"));
  db.exec(`CREATE TABLE nodes(id TEXT PRIMARY KEY, runtime TEXT);
    CREATE TABLE sessions(id INTEGER, node_id TEXT, session_name TEXT, status TEXT);
    CREATE TABLE bindings(node_id TEXT, attachment_type TEXT);
    CREATE TABLE queue_items(qitem_id TEXT PRIMARY KEY, source_session TEXT, destination_session TEXT,
      state TEXT, blocked_on TEXT, closure_required_at TEXT, ts_created TEXT);`);
  const adapter = new HcAdapter(core.client());
  // The membership the sampler reads is the core's own; only the clock is the test's.
  const svc = new SeatActivityService({ tmux: new HcIdentity(core.client(), { activity: () => STALE_ACTIVITY_SECONDS }), defaultWindowSeconds: 3 });
  /** End the seat's terminal, as `tmux kill-session` ended its session. */
  const kill = async (session: string) => {
    const ended = await adapter.killSession(session);
    expect(ended, `${session} had a live terminal to end`).toEqual({ ok: true });
  };
  cleanups.push(async () => {
    db.close();
    core.cleanup();
    rmSync(scratch, { recursive: true, force: true });
  });
  async function add(id: number, node: string, session: string) {
    db.prepare("INSERT OR IGNORE INTO nodes VALUES (?, NULL)").run(node);
    db.prepare("INSERT INTO sessions VALUES (?, ?, ?, 'running')").run(id, node, session);
    const created = await adapter.createSession(session, scratch);
    expect(created, `${session} got a terminal`).toEqual({ ok: true });
  }
  function waiting(session: string) {
    db.prepare("INSERT OR REPLACE INTO queue_items VALUES ('q1', 'sender@fixture', ?, 'pending', NULL, NULL, ?)")
      .run(session, new Date().toISOString());
    // The startup activity-reader SQL seam resolves the durable node; the real
    // service and queue projection supply all activity/confidence values.
    return readWaitingView(db, "q1", name => {
      const row = db.prepare("SELECT node_id FROM sessions WHERE session_name = ? ORDER BY id DESC LIMIT 1")
        .get(name) as { node_id: string } | undefined;
      return row ? svc.getSeatState(row.node_id) : null;
    });
  }
  return { db, adapter, svc, kill, add, waiting };
}

describe.runIf(findHc() !== null)("seat oracle retirement", () => {
  it("a stopped durable seat loses oracle confidence while another running seat stays observable", async () => {
    const f = await fixture();
    await f.add(1, "node-a", "a@fixture"); await f.add(2, "node-b", "b@fixture");
    await f.svc.pollAllRunningTmuxSeats(f.db);
    const before = f.svc.getSeatState("node-a")!;
    expect(f.waiting("a@fixture").liveness.confidence).toBe("oracle");
    const nextState = f.svc.waitForSeatState("node-a", { afterSeq: before.seq, timeoutMs: 1000 });
    await f.kill("a@fixture");
    f.db.prepare("UPDATE sessions SET status = 'exited' WHERE node_id = 'node-a'").run();
    await f.svc.pollAllRunningTmuxSeats(f.db);
    expect(await f.adapter.hasSession("a@fixture")).toBe(false);
    expect(f.svc.getSeatActivity("a@fixture")).toBeNull();
    expect(f.waiting("a@fixture").liveness).toMatchObject({ activity: "unknown", confidence: "unknown" });
    expect(await nextState).toMatchObject({ activity: "unknown", decidedBy: null });
    expect(f.svc.getSeatStateBySession("a@fixture")).toBeNull();
    expect(f.waiting("b@fixture").liveness).toMatchObject({ activity: "idle-at-prompt", confidence: "oracle" });
  });

  it("a revived same-name seat gets fresh sampler evidence after retirement", async () => {
    const f = await fixture(); await f.add(1, "node-a", "a@fixture");
    await f.svc.pollAllRunningTmuxSeats(f.db);
    await f.kill("a@fixture");
    f.db.prepare("UPDATE sessions SET status = 'exited'").run();
    await f.svc.pollAllRunningTmuxSeats(f.db);
    expect(f.svc.getSeatState("node-a")!.activity).toBe("unknown");
    await f.add(2, "node-a", "a@fixture");
    await f.svc.pollAllRunningTmuxSeats(f.db);
    expect(f.svc.getSeatStateBySession("a@fixture")).toMatchObject({ activity: "idle-at-prompt", decidedBy: "window-sampling" });
  });

  it("binds a replacement session and forgetting the old name preserves the current oracle", async () => {
    const f = await fixture(); await f.add(1, "node-a", "old@fixture");
    await f.svc.pollAllRunningTmuxSeats(f.db);
    await f.add(2, "node-a", "new@fixture");
    await f.svc.pollAllRunningTmuxSeats(f.db);
    expect(f.svc.getSeatStateBySession("old@fixture")).toBeNull();
    expect(f.svc.getSeatActivity("new@fixture")).not.toBeNull();
    expect(f.svc.getSeatStateBySession("new@fixture")).toMatchObject({ activity: "idle-at-prompt", decidedBy: "window-sampling" });
    const current = f.svc.getSeatState("node-a");
    f.svc.forgetSeat("old@fixture");
    expect(f.svc.getSeatState("node-a")).toEqual(current);
  });

  it("sweep retires hook-only evidence even when no terminal observation was cached", async () => {
    const f = await fixture();
    f.svc.declareRungInventory({ seatNodeId: "node-a", sessionName: "a@fixture" }, runtimeRungInventory("claude-code"));
    f.svc.reportEvidence({ seatNodeId: "node-a", sessionName: "a@fixture", sourceId: "claude:hooks",
      rung: "lifecycle-hooks", seq: 1, observedAt: new Date().toISOString(), activity: "working",
      needsInput: { count: 1, reason: "permission" } });
    expect(f.svc.getSeatActivity("a@fixture")).toBeNull();
    await f.svc.pollAllRunningTmuxSeats(f.db);
    expect(f.svc.getSeatState("node-a")).toMatchObject({ activity: "unknown", needsInput: { count: 0, reason: null } });
    expect(f.svc.hasRungInventory("node-a")).toBe(false);
  });

  it("explicit teardown retires evidence and a late old-session forget cannot clear a redeclared seat", async () => {
    const f = await fixture();
    const report = (sessionName: string, seq: number) => f.svc.reportEvidence({ seatNodeId: "node-a", sessionName,
      sourceId: "tmux:window-activity", rung: "window-sampling", seq, observedAt: new Date().toISOString(), activity: "idle-at-prompt" });
    f.svc.declareRungInventory({ seatNodeId: "node-a", sessionName: "old@fixture" }, runtimeRungInventory(null));
    report("old@fixture", 1); f.svc.forgetSeat("old@fixture");
    expect(f.svc.getSeatState("node-a")!.activity).toBe("unknown");
    f.svc.declareRungInventory({ seatNodeId: "node-a", sessionName: "new@fixture" }, runtimeRungInventory(null));
    report("new@fixture", 1); f.svc.forgetSeat("old@fixture");
    expect(f.svc.getSeatStateBySession("new@fixture")!.activity).toBe("idle-at-prompt");
  });
});
