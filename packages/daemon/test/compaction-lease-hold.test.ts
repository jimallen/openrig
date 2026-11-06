// OF-247 (c), from the OF-241 review (N4): the compaction enforcer's `withDeliveryGuard` (claude-compaction-enforcer.ts) holds a lifecycle lease around a whole drain or sampled
// pass, and the owner's note said the hold was "about 1 s" (true of sendPreparedCompact only). The drain's sends wait for the pane to read idle for up to
// POST_COMPACT_SEND_WAIT_MS_DEFAULT (10 s). This file MEASURES the hold on a busy, unpumped seat, on the real monitor, enforcer, transport and delivery guard over an inert
// tmux adapter, and pins what bounds it: the default wait, one stage per pass, and a release between passes. The shipped 10 s is read from the options the enforcer passes (a recording transport);
// the hold itself is measured in real time at a scaled wait (1 s), because the transport's deadline is wall-clock. Production entrypoint: startup.ts constructs ContextMonitor (30 s timer, ContextMonitor.start) and ClaudeCompactionEnforcer with the daemon's SessionTransport
// and its guard; SeatIdentityReconciler (5 s timer) reads the guard's lease table. Consequence read from the measurement: a Claude seat that crashes inside a hold is excused for the
// hold, at most about 10 s plus the send, and a hold is followed by at least the monitor interval minus that, so the reconciler's hold clock restarts at the next poll; the
// ceiling (10 min + the per-seat term) is never approached. Display only. Boundary: Claude's real screen is not driven; the busy pane is a synthetic frame.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { ContextUsageStore } from "../src/domain/context-usage-store.js";
import { ContextMonitor, DEFAULT_POLL_INTERVAL_MS } from "../src/domain/context-monitor.js";
import { ClaudeCompactionEnforcer, POST_COMPACT_SEND_WAIT_MS_DEFAULT } from "../src/domain/claude-compaction-enforcer.js";
import { SettingsStore } from "../src/domain/user-settings/settings-store.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";

const COMPACTING_PANE = "⠋ Compacting conversation\nesc to interrupt";

describe("OF-247 (c): how long the compaction enforcer holds a seat's lifecycle lease on a busy, unpumped seat", () => {
  let db: Database.Database;
  let home: string;
  let monitor: ContextMonitor;
  let enforcer: ClaudeCompactionEnforcer;
  let guard: SeatDeliveryGuard;
  let nodeId: string;
  let sessionName: string;
  let clock: number;
  let deliver: boolean;
  let activity: AgentActivityStore;
  let sends: Array<{ heldAtStart: boolean; heldMs: number; ok: boolean; waitForIdleMs: unknown }>;
  let build: () => void;
  let recordOnly: boolean;
  let waitMs: number | undefined;
  const heldNow = () => guard.lifecycleHeld(nodeId);

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    home = mkdtempSync(join(tmpdir(), "compaction-lease-hold-"));
    mkdirSync(join(home, "state", "context-usage"), { recursive: true });
    const rigRepo = new RigRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const rig = rigRepo.createRig("lease");
    const node = rigRepo.addNode(rig.id, "worker", { runtime: "claude-code" });
    nodeId = node.id;
    sessionName = "worker@lease";
    const session = sessionRegistry.registerSession(node.id, sessionName);
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: sessionName });
    clock = Date.now();
    deliver = false;
    recordOnly = false;
    waitMs = undefined;
    sends = [];
    guard = new SeatDeliveryGuard(db, (name) => resolveGuardTarget(db, name));
    activity = new AgentActivityStore({
      db, eventBus: new EventBus(db), now: () => new Date(clock),
      resolveOccupantGeneration: () => "gen-1", isRegisteredOccupantGeneration: () => true,
    });
    const tmux = {
      deliveryGuard: guard,
      hasSession: async () => true, probeSession: async () => ({ state: "present" }), getPanePid: async () => null, getPaneCommand: async () => null,
      capturePaneContent: vi.fn(async () => COMPACTING_PANE),
      sendText: vi.fn(async () => ({ ok: true })), sendKeys: vi.fn(async () => ({ ok: true })),
      listSessions: async () => [], listWindows: async () => [], listPanes: async () => [],
    };
    const realTransport = new SessionTransport({
      db, rigRepo, sessionRegistry, tmuxAdapter: tmux, agentActivityStore: activity,
      now: () => new Date(clock), sleep: async (ms: number) => { clock += ms; }, waitForIdlePollMs: 10,
    } as never);
    const transport = {
      deliveryGuard: guard,
      send: async (name: string, text: string, opts: unknown) => {
        if (deliver) {
          const start = Date.now(), heldAtStart = heldNow();
          const waitForIdleMs = (opts as { waitForIdleMs?: unknown }).waitForIdleMs;
          // A recording transport answers at once (a busy timeout), so the shipped default is read without waiting for it.
          const result = recordOnly ? { ok: false as const } : await realTransport.send(name, text, opts as never);
          sends.push({ heldAtStart, heldMs: Date.now() - start, ok: result.ok, waitForIdleMs });
          return result as never;
        }
        // Preparation and /compact go to a recording fake, as in compaction-drain-readiness.test.ts.
        const marker = text.match(/<!-- openrig-compaction-complete .*? -->/)?.[0];
        const target = text.match(/Write this attempt's complete restore map to ("(?:[^"\\]|\\.)*")/);
        if (marker && target) {
          const file = JSON.parse(target[1]!) as string;
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, `# Completed fixture map\n${marker}\n`);
        }
        return { ok: true };
      },
    } as unknown as SessionTransport;
    const settings = new SettingsStore(join(home, "settings.json"));
    settings.set("policies.claude_compaction.enabled", "true");
    settings.set("policies.claude_compaction.threshold_percent", "80");
    build = () => {
      // postCompactSendWaitMs is passed only when a row scales it: the default is what ships.
      enforcer = new ClaudeCompactionEnforcer(settings, transport, { openrigHome: home, resolveOccupantGeneration: () => "gen-1", ...(waitMs === undefined ? {} : { postCompactSendWaitMs: waitMs }) });
      monitor = new ContextMonitor(db, new ContextUsageStore(db, { stateDir: home, codexHomeDir: home }), undefined, enforcer);
    };
    writeFileSync(join(home, "state", "context-usage", `${sessionName}.json`), JSON.stringify({
      session_id: "fixture-session", session_name: sessionName, transcript_path: null, sampled_at: new Date().toISOString(),
      context_window: { context_window_size: 200000, used_percentage: 80, remaining_percentage: 20 },
    }));
  });

  afterEach(() => { monitor?.stop(); db.close(); rmSync(home, { recursive: true, force: true }); vi.restoreAllMocks(); });

  async function compactAndLeaveStagePending() {
    build();
    await monitor.pollOnce();
    await monitor.pollOnce();
    expect(enforcer.hasPendingPostCompactStage(sessionName)).toBe(true);
    deliver = true;
    // No usage sample from here on (the drain path), and the newest hook is the Stop from before /compact: only the pane's own reading counts as idle.
    expect(activity.recordHookEvent({ runtime: "claude-code", sessionName, hookEvent: "Stop", generation: "gen-1", occurredAt: new Date(clock - 30_000).toISOString() }).ok).toBe(true);
    rmSync(join(home, "state", "context-usage", `${sessionName}.json`), { force: true });
  }

  it("the shipped wait is 10 s and the monitor's interval 30 s", () => {
    expect(POST_COMPACT_SEND_WAIT_MS_DEFAULT).toBe(10_000);
    expect(DEFAULT_POLL_INTERVAL_MS).toBe(30_000);
  });

  it("with the shipped default, one pass over a busy seat makes ONE send that waits 10 s for idle under the lease, and the stage stays pending", async () => {
    recordOnly = true;
    await compactAndLeaveStagePending();
    expect(heldNow(), "before the pass").toBe(false);
    await monitor.pollOnce();
    expect(sends, "sends in one pass (one stage per pass)").toHaveLength(1);
    expect(sends[0]).toMatchObject({ heldAtStart: true, ok: false, waitForIdleMs: 10_000 });
    expect(heldNow(), "after the pass").toBe(false);
    expect(enforcer.hasPendingPostCompactStage(sessionName), "the busy timeout does not advance the stage").toBe(true);
  });

  it("the lease is held for as long as the idle wait lasts, measured at a 1 s wait (real time): at least the wait, one send, released after", async () => {
    waitMs = 1_000;
    await compactAndLeaveStagePending();
    await monitor.pollOnce();
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ heldAtStart: true, ok: false, waitForIdleMs: 1_000 });
    expect(sends[0]!.heldMs, "ms the send held the lease on a seat that never read idle").toBeGreaterThanOrEqual(990);
    expect(heldNow()).toBe(false);
  });

  it("a second pass makes one more send and the seat is free between passes: holds do not chain, and the monitor's interval leaves room for the reconciler's 5 s polls", async () => {
    recordOnly = true;
    await compactAndLeaveStagePending();
    await monitor.pollOnce();
    expect(heldNow(), "between passes").toBe(false);
    await monitor.pollOnce();
    expect(sends).toHaveLength(2);
    expect(sends.map((x) => x.heldAtStart)).toEqual([true, true]);
    expect(DEFAULT_POLL_INTERVAL_MS - POST_COMPACT_SEND_WAIT_MS_DEFAULT, "ms of each 30 s tick the seat is free, at most one wait being held: more than the reconciler's 5 s poll").toBeGreaterThan(5_000);
  });
});
