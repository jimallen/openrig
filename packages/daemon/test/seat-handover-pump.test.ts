// S4f, handover packets through the pump: the real SeatHandoverService, MessagePump, MessageStore and delivery guard on a real database; only the
// gate, the hop and the seat host are stubs. The real daemon on a private core is seat-handover-pump.real.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { probeSessionFromHasSession } from "./helpers/probe-from-has-session.js";
import { StubRuntimeAdapter } from "../src/adapters/stub-runtime-adapter.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { resolveGuardTarget, SeatDeliveryGuard } from "../src/domain/seat-delivery-guard.js";
import { HANDOVER_PACKET_WAIT_MS, SeatHandoverService } from "../src/domain/seat-handover-service.js";
import { PumpHandOff } from "../src/domain/seat-messaging/hand-off.js";
import { MessagePump, PUMP_PAUSE_RECHECK_MS } from "../src/domain/seat-messaging/message-pump.js";
import { MessageStore } from "../src/domain/seat-messaging/message-store.js";
import { messageId, type LastHopResult, type MessageId, type SeatGate, type SeatMessage } from "../src/domain/seat-messaging/ports.js";
import { DbSeatDirectory } from "../src/domain/seat-messaging/seat-directory.js";
import { SessionRegistry } from "../src/domain/session-registry.js";

const SEAT = "dev-impl@seat-rig";

describe("handover packets through the pump", () => {
  let db: Database.Database;
  let sessions: SessionRegistry;
  let store: MessageStore;
  let pump: MessagePump;
  let sendText: ReturnType<typeof vi.fn>;
  let seen: Set<MessageId>;
  let attempts: SeatMessage[];
  let onAttempt: (message: SeatMessage) => LastHopResult;
  let gated: boolean;
  let nodeId: string;
  let tenure: string;
  let launching: () => void;
  let startPump: (backoffMs: number) => void;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const rigs = new RigRepository(db);
    sessions = new SessionRegistry(db);
    const rig = rigs.createRig("seat-rig");
    const node = rigs.addNode(rig.id, "dev.impl", { runtime: "codex", cwd: "/project" });
    nodeId = node.id;
    const session = sessions.registerSession(node.id, SEAT);
    sessions.updateStatus(session.id, "running");
    sessions.updateStartupStatus(session.id, "ready", "2026-04-20T12:00:00Z");
    sessions.updateBinding(node.id, { tmuxSession: SEAT, tmuxPane: "%0" });
    tenure = sessions.mintOccupantTenure(node.id, "fresh").generationUuid;
    store = new MessageStore(db);
    seen = new Set();
    attempts = [];
    gated = true;
    launching = () => undefined;
    onAttempt = (message) => { for (const id of message.ids) seen.add(id); return { kind: "sent" }; };
    const gate: SeatGate = {
      version: 1,
      lookup: async (_seat, id) => (seen.has(id) ? { kind: "seen", record: { id, recordedAt: "2026-04-24T18:30:01.000Z", nonce: null } } : { kind: "not_seen" }),
    };
    const hop = { attempt: async (message: SeatMessage) => { attempts.push(message); return onAttempt(message); } };
    const ports = { gateFor: () => (gated ? gate : null), hopFor: () => (gated ? hop : null) };
    startPump = (backoffMs) => {
      pump = new MessagePump({
        store, ports, directory: new DbSeatDirectory(db), held: { status: () => "held" },
        senders: { returnToSender: async () => ({ kind: "no_return_path", reason: "none in this test" }) },
        timing: { tickMs: 5, pauseRecheckMs: 60_000, backoffMs: [backoffMs] }, log: () => undefined,
      });
      pump.start();
    };
    sendText = vi.fn(async () => ({ ok: true }));
  });
  afterEach(() => { pump.stop(); db.close(); });

  function service(waitMs = 400, source = "fresh", backoffMs = 60_000): { run: () => ReturnType<SeatHandoverService["handover"]> } {
    startPump(backoffMs);
    const adapter = Object.assign(new TmuxAdapter(async () => ""), {
      probeSession: probeSessionFromHasSession, hasSession: async () => true, createSession: async () => ({ ok: true }),
      listPanes: async () => [{ id: "%9", index: 0, cwd: "/project", width: 80, height: 24, active: true }],
      killSession: async () => ({ ok: true }), respawnPane: async () => ({ ok: true }), setRemainOnExit: async () => ({ ok: true }), signalPaneProcess: async () => ({ ok: true }),
      isPaneDead: async () => true, sendText, sendKeys: vi.fn(async () => ({ ok: true })), capturePaneScreen: async () => "predecessor screen tail",
      getDefaultShell: async () => "/bin/zsh", getPaneCommand: async () => "zsh",
      deliveryGuard: new SeatDeliveryGuard(db, (target) => resolveGuardTarget(db, target)),
      messageHandOff: new PumpHandOff(store, pump, { gateFor: () => (gated ? { version: 1, lookup: async () => ({ kind: "not_seen" }) } : null), hopFor: () => (gated ? { attempt: async () => ({ kind: "sent" }) } : null) }),
    });
    const runtime = Object.assign(new StubRuntimeAdapter({ tmux: adapter, runtime: "codex" }), {
      launchHarness: async () => { launching(); return { ok: true as const, resumeToken: "tok", resumeType: "codex_id" }; }, checkReady: async () => ({ ready: true }),
    });
    const handovers = new SeatHandoverService({
      db, rigRepo: new RigRepository(db), sessionRegistry: sessions, discoveryRepo: new DiscoveryRepository(db), eventBus: new EventBus(db), tmuxAdapter: adapter,
      now: () => new Date("2026-04-24T18:30:00.000Z"), seatCwdFault: () => null, runtimeAdapters: { codex: runtime }, readinessTimeoutMs: 50, sleep: async () => {},
      contextUsageStore: { readSidecar: () => null } as never, resumeTokenCapturer: { captureCodexThreadId: async () => null } as never, packetWaitMs: waitMs,
    });
    return { run: () => handovers.handover({ seatRef: SEAT, reason: "s4f", source, operator: "orch-lead@seat-rig" }) };
  }

  const packetRow = (): Record<string, unknown> => {
    const rows = db.prepare("SELECT * FROM outbox_entries WHERE sender_session = 'handover@system'").all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    return rows[0]!;
  };
  const latestTenure = () => sessions.currentOccupantTenure(nodeId)!.generationUuid;

  it("a gated seat takes the restore packet from the pump, in lane 0, under an id naming the successor, and nothing is typed past it", async () => {
    const result = await service().run();
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(sendText).not.toHaveBeenCalled();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ seat: SEAT, messageClass: "lifecycle", lane: 0 });
    expect(attempts[0]!.body).toContain("predecessor screen tail");
    const successor = latestTenure();
    expect(successor).not.toBe(tenure);
    expect(packetRow()).toMatchObject({ outbox_id: `seat-msg-handover-${successor}-restore`, message_state: "received", class: "lifecycle", lane: 0, occupant_generation: tenure });
  });

  it("a rebuild's priming packet goes the same way", async () => {
    const result = await service(400, "rebuild").run();
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(sendText).not.toHaveBeenCalled();
    expect(packetRow()).toMatchObject({ outbox_id: `seat-msg-handover-${latestTenure()}-rebuild`, message_state: "received" });
  });

  it("a seat with no gate keeps the paste, and writes no row", async () => {
    gated = false;
    const result = await service().run();
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT count(*) AS n FROM outbox_entries WHERE sender_session = 'handover@system'").get()).toEqual({ n: 0 });
  });

  it("bytes leaving are not arrival: with no gate record the handover fails, the candidate unwinds, the row ends, and nothing arrives later", async () => {
    onAttempt = () => ({ kind: "sent" });
    const result = await service(60, "fresh", 100).run();
    expect(result).toMatchObject({ ok: false, code: "context_delivery_failed" });
    expect(latestTenure()).toBe(tenure);
    expect(db.prepare("SELECT status FROM discovered_sessions WHERE tmux_session = ?").get(SEAT)).toEqual({ status: "vanished" });
    expect(packetRow()).toMatchObject({ message_state: "undeliverable", ack_evidence: "superseded", delivery_state: "failed" });
    const after = attempts.length;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(attempts.length).toBe(after);
  });

  it("a record that lands as the wait ends is arrival, not a failure", async () => {
    const handOffAwait = vi.spyOn(PumpHandOff.prototype, "awaitReceived").mockImplementationOnce(async (id) => {
      seen.add(id);
      await vi.waitFor(() => expect(store.outcomeOf(id)).toBe("received"));
      return "open";
    });
    onAttempt = () => ({ kind: "sent" });
    const result = await service(60).run();
    handOffAwait.mockRestore();
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(packetRow()).toMatchObject({ message_state: "received" });
  });

  it("a queued message waits for the packet, the hold covers the launch, and it goes once the handover ends", async () => {
    launching = () => { store.accept({ id: messageId("q1"), seat: SEAT, sender: "lead@seat-rig", body: "queued" }); void pump.tick(); };
    const result = await service().run();
    expect(result.ok, JSON.stringify(result)).toBe(true);
    await vi.waitFor(() => expect(attempts.map((a) => a.ids[0])).toContain("q1"));
    expect(attempts[0]!.lane).toBe(0);
    expect(attempts[1]!.ids[0]).toBe("q1");
  });

  it("a rebuild holds the content lane through its launch too", async () => {
    launching = () => { store.accept({ id: messageId("q3"), seat: SEAT, sender: "lead@seat-rig", body: "queued" }); void pump.tick(); };
    const result = await service(400, "rebuild").run();
    expect(result.ok, JSON.stringify(result)).toBe(true);
    await vi.waitFor(() => expect(attempts.map((a) => a.ids[0])).toContain("q3"));
    expect(attempts[0]!.lane).toBe(0);
  });

  it("the hold ends on a failed handover too", async () => {
    onAttempt = (message) => { if (message.lane === 2) seen.add(message.ids[0]); return { kind: "sent" }; };
    launching = () => { store.accept({ id: messageId("q2"), seat: SEAT, sender: "lead@seat-rig", body: "queued" }); };
    expect((await service(60).run()).ok).toBe(false);
    await vi.waitFor(() => expect(store.outcomeOf(messageId("q2"))).toBe("received"));
  });

  it("the wait stays under the pump's pause recheck, so no timer pass can type behind a cancelled packet", () => {
    expect(HANDOVER_PACKET_WAIT_MS).toBeLessThan(PUMP_PAUSE_RECHECK_MS);
    expect(HANDOVER_PACKET_WAIT_MS).toBeGreaterThan(0);
  });
});
