// workspaces-o9o.7: a message that reaches a seat's OLD occupant in the seconds around `rig seat launch --fresh --stop` must reach the fresh
// occupant. Reported three times on 2026-11-15/16 (build-impl@eztrack, CoS message 6045 recorded 23:06:08Z, two seconds after the operator's
// pre-relaunch check): the old session took it, the launch stopped that session, and the fresh occupant never saw it.
//
// The real SeatLifecycleService.launchFresh runs here, with the real MessageStore, MessagePump and PumpHandOff wired on its tmux adapter as the
// daemon wires them (startup.ts). The gate and the last hop are fakes: the gate answers by (id, nonce) as every real gate does, and the hop
// records what it was given. tmux is a fake that stops and starts sessions in memory.
import { TMP_CREDENTIAL_FILES } from "./helpers/credential-files.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";
import { mockTmuxAdapter } from "./helpers/test-app.js";
import { MessagePump } from "../src/domain/seat-messaging/message-pump.js";
import { MessageStore, carryIdOf, carryOriginOf, redeliveryLabel } from "../src/domain/seat-messaging/message-store.js";
import { PumpHandOff } from "../src/domain/seat-messaging/hand-off.js";
import { DbSeatDirectory } from "../src/domain/seat-messaging/seat-directory.js";
import { PREVIOUS_OCCUPANT_LABEL } from "../src/domain/seat-messaging/message-label.js";
import { messageId, type GateLookup, type LastHop, type LastHopResult, type MessageId, type SeatGate, type SeatMessage } from "../src/domain/seat-messaging/ports.js";
import { ClaudeSeatHop, type HopGuard } from "../src/adapters/seat-hops.js";
import type { NativeEligibility, NativeEndpointRow } from "../src/domain/claude-native-inbox.js";
import { existingRigRoot } from "./helpers/existing-rig-root.js";
import { SeatDeliveryGuard, type GuardTarget } from "../src/domain/seat-delivery-guard.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { MessageObligations } from "../src/domain/seat-messaging/pump-ports.js";
import { WAKE_INTENT_PREFIX } from "../src/domain/outbox-handler.js";

const SEAT_DIR = existingRigRoot("project");
const SEAT = "dev-impl@race-rig";

/** A gate as every real one is: a record is of one (id, nonce), written by whichever occupant took the text. */
class RecordingGate implements SeatGate {
  readonly version = 3;
  private readonly records = new Map<string, string>();
  constructor(private readonly store: MessageStore) {}
  /** The occupant now in the seat took this message at `atIso`, under the nonce its copy carried. */
  take(id: string, atIso: string): void {
    this.records.set(`${id}:${this.store.nonceOf(messageId(id))}`, atIso);
  }
  async lookup(_seat: string, id: MessageId): Promise<GateLookup> {
    const at = this.records.get(`${id}:${this.store.nonceOf(id)}`);
    return at === undefined ? { kind: "not_seen" } : { kind: "seen", record: { id, recordedAt: at, nonce: this.store.nonceOf(id) } };
  }
}

class RecordingHop implements LastHop {
  readonly sent: Array<{ body: string; ids: readonly string[] }> = [];
  async attempt(message: SeatMessage): Promise<LastHopResult> {
    this.sent.push({ body: message.body, ids: message.ids });
    return { kind: "sent" };
  }
}

describe("o9o.7: a message the old occupant took around rig seat launch --fresh --stop reaches the fresh occupant", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let alive: Set<string>;
  let tmux: TmuxAdapter;
  let service: SeatLifecycleService;
  let store: MessageStore;
  let gate: RecordingGate;
  let hop: RecordingHop;
  let pump: MessagePump;
  let now: number;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    alive = new Set();
    const panes = new Map<string, string>();
    tmux = Object.assign(mockTmuxAdapter(), {
      createSession: vi.fn(async (name: string) => { alive.add(name); panes.set(name, "%fresh"); return { ok: true as const }; }),
      killSession: vi.fn(async (name: string): Promise<TmuxResult> => { alive.delete(name); panes.delete(name); return { ok: true }; }),
      probeSession: vi.fn(async (name: string) => (alive.has(name) ? { state: "present" as const } : { state: "absent" as const })),
      hasSession: vi.fn(async (name: string) => alive.has(name)),
      startServer: vi.fn(async (): Promise<TmuxResult> => ({ ok: true })),
      listSessions: vi.fn(async () => [...alive].map((name) => ({ name, windows: 1, created: "", attached: false }))),
      listWindows: vi.fn(async () => []),
      listPanes: vi.fn(async (name: string) => {
        const pane = alive.has(name) ? panes.get(name) : undefined;
        return pane ? [{ id: pane, index: 0, cwd: "/project", width: 80, height: 24, active: true }] : [];
      }),
      getPanePid: vi.fn(async () => 4242),
      getPaneCommand: vi.fn(async () => "claude"),
      sendText: vi.fn(async () => ({ ok: true as const })),
      sendKeys: vi.fn(async () => ({ ok: true as const })),
      setSessionOption: vi.fn(async () => ({ ok: true as const })),
    });
    const adapter: RuntimeAdapter = {
      runtime: "claude-code",
      listInstalled: async () => [],
      project: async () => ({ projected: [], skipped: [], failed: [] }),
      deliverStartup: async () => ({ delivered: 0, failed: [] }),
      launchHarness: async () => ({ ok: true, resumeToken: "fresh-native-uuid", resumeType: "claude_session_id" }),
      checkReady: async () => ({ ready: true }),
    };
    service = new SeatLifecycleService({
      db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux,
      listProcesses: async () => [{ pid: 4242, ppid: 1, pgid: 4242, tpgid: 4242, executableName: "claude", command: "claude --session-id fresh-native-uuid", startedAt: "Sat Jan  1 12:00:00 2000" }],
      nodeLauncher: new NodeLauncher({ credentialFiles: TMP_CREDENTIAL_FILES, db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux }),
      startupOrchestrator: new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux, sleep: async () => undefined }),
      runtimeAdapters: { "claude-code": adapter },
    });

    // The seat and its live old occupant.
    const rig = rigRepo.createRig("race-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code", cwd: SEAT_DIR, model: "claude-current" });
    const session = sessionRegistry.registerSession(node.id, SEAT);
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: SEAT, tmuxPane: "%old" });
    alive.add(SEAT);
    panes.set(SEAT, "%old");
    db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, '[]', '[]', '[]', 'claude-code')").run(node.id);

    store = new MessageStore(db);
    gate = new RecordingGate(store);
    hop = new RecordingHop();
    now = Date.parse("2026-11-15T23:06:00.000Z");
    pump = new MessagePump({
      store, directory: new DbSeatDirectory(db), held: { status: () => "held" },
      senders: { returnToSender: async () => ({ kind: "returned", qitemId: "q" }) },
      clock: () => now, log: () => undefined, ports: { gateFor: () => gate, hopFor: () => hop },
    });
    tmux.messageHandOff = new PumpHandOff(store, pump, { gateFor: () => gate, hopFor: () => hop });
  });
  afterEach(() => { pump.stop(); db.close(); });

  const send = (id: string) => store.accept({ id: messageId(id), seat: SEAT, sender: "exec-cos@race-rig", body: `body of ${id}` });
  /** What the occupant in the seat after the launch was given, as the pump hands it over on its next passes. */
  const sentAfter = (index: number) => hop.sent.slice(index).map((attempt) => attempt.body);
  const relaunch = (handOverSince?: string) => service.launchFresh({
    seatRef: SEAT, fresh: true, stop: true, reason: "relaunch race", ...(handOverSince === undefined ? {} : { handOverSince }),
  });

  it("a message the old occupant took two seconds after the operator's check, and before the launch, reaches the fresh occupant", async () => {
    const checkedAt = "2026-11-15T23:06:06.000Z";
    send("cos-6045");
    await pump.tick();
    gate.take("cos-6045", "2026-11-15T23:06:08.000Z");  // the old session took it: the reported 23:06:08Z
    now = Date.parse("2026-11-15T23:06:09.000Z");
    await pump.tick();
    expect(store.outcomeOf(messageId("cos-6045"))).toBe("received");
    const before = hop.sent.length;

    const launched = await relaunch(checkedAt);
    expect(launched.ok).toBe(true);
    now += 60_000;
    await pump.tick();

    // The re-delivery says what it is, names the original and its gate time, and keeps the body as the sender wrote it.
    expect(sentAfter(before)).toEqual([`${redeliveryLabel("cos-6045", "2026-11-15T23:06:08.000Z")}\nbody of cos-6045`]);
    expect(sentAfter(before)[0]).toContain("re-delivery");
    expect(sentAfter(before)[0]).toContain("cos-6045 at 2026-11-15T23:06:08.000Z");
    // The original stays a true record of what the old session took.
    expect(store.outcomeOf(messageId("cos-6045"))).toBe("received");
    expect(launched.ok && launched.handOver).toEqual({
      since: checkedAt, sinceSource: "hand_over_since", reissued: [], notHandedOver: [],
      carried: [{ id: expect.stringMatching(/^cos-6045\.relaunch-[0-9a-f-]{8}$/), original: "cos-6045", gateRecordedAt: "2026-11-15T23:06:08.000Z" }],
    });
  });

  it("the documented gap: with no --hand-over-since, the same message (taken before the launch began) is NOT handed over, and the result names the since-time used", async () => {
    send("cos-6045");
    await pump.tick();
    gate.take("cos-6045", "2026-11-15T23:06:08.000Z");
    await pump.tick();
    const before = hop.sent.length;
    const beganAfter = new Date().toISOString();

    const launched = await relaunch();
    expect(launched.ok).toBe(true);
    now += 60_000;
    await pump.tick();

    expect(sentAfter(before)).toEqual([]);
    if (!launched.ok) return;
    expect(launched.handOver).toMatchObject({ sinceSource: "launch_began", carried: [], reissued: [] });
    // `since` is when this launch began: not before the call, and not the gate time.
    expect(launched.handOver!.since >= beganAfter).toBe(true);
    expect(launched.handOver!.since <= new Date().toISOString()).toBe(true);
  });

  it("only what the old occupant took from the since-time on is carried: an earlier message is not", async () => {
    send("early");
    await pump.tick();
    gate.take("early", "2026-11-15T23:05:00.000Z");
    send("late");
    await pump.tick();
    gate.take("late", "2026-11-15T23:06:08.000Z");
    await pump.tick();
    const before = hop.sent.length;

    const launched = await relaunch("2026-11-15T23:06:06Z");
    now += 60_000;
    await pump.tick();

    expect(launched.ok && launched.handOver?.carried.map((c) => c.original)).toEqual(["late"]);
    expect(sentAfter(before)).toEqual([`${redeliveryLabel("late", "2026-11-15T23:06:08.000Z")}\nbody of late`]);
  });

  it("lifecycle text stays with the occupant it was for: it is never carried", async () => {
    store.accept({ id: messageId("lc-1"), seat: SEAT, sender: "daemon@kernel", body: "for the old occupant", messageClass: "lifecycle" });
    await pump.tick();
    gate.take("lc-1", "2026-11-15T23:06:08.000Z");
    await pump.tick();
    expect(store.outcomeOf(messageId("lc-1"))).toBe("received");

    const launched = await relaunch("2026-11-15T23:06:06Z");

    expect(launched.ok && launched.handOver?.carried).toEqual([]);
  });

  it("a repeat of the hand-over is the same carry row, not a second one", () => {
    send("cos-6045");
    db.prepare("UPDATE outbox_entries SET message_state = 'received', delivery_state = 'delivered', gate_recorded_at = '2026-11-15T23:06:08.000Z' WHERE outbox_id = 'cos-6045'").run();
    const first = store.handOverFromRetiringOccupant(SEAT, "2026-11-15T23:06:06Z", "abcd1234");
    const second = store.handOverFromRetiringOccupant(SEAT, "2026-11-15T23:06:06Z", "abcd1234");

    expect(first.carried.map((c) => c.id)).toEqual(["cos-6045.relaunch-abcd1234"]);
    expect(second.carried).toEqual([]);
    expect(carryOriginOf(first.carried[0]!.id)).toBe("cos-6045");
    expect(carryOriginOf(carryIdOf("x.part1of2", "abcd1234"))).toBe("x.part1of2");
    expect(carryOriginOf("cos-6045")).toBeNull();
    expect(db.prepare("SELECT count(*) AS n FROM outbox_entries WHERE outbox_id LIKE 'cos-6045.relaunch-%'").get()).toEqual({ n: 1 });
  });

  it("a seat the pump does not serve: what its old occupant took since is named in the result, never dropped in silence", async () => {
    const ungated = new PumpHandOff(store, pump, { gateFor: () => null, hopFor: () => null });
    tmux.messageHandOff = ungated;
    db.prepare(`INSERT INTO outbox_entries (outbox_id, sender_session, destination_session, body, ts_dispatched, delivery_state, delivered_at)
      VALUES ('plain-1', 'exec-cos@race-rig', ?, 'b', '2026-11-15T23:06:07.000Z', 'delivered', '2026-11-15T23:06:08.000Z')`).run(SEAT);

    const launched = await relaunch("2026-11-15T23:06:06Z");

    expect(launched.ok && launched.handOver).toMatchObject({ carried: [], reissued: [], notHandedOver: ["plain-1"] });
  });

  it("a launch that fails after it stopped the old occupant has still handed over: nothing the old one took is stranded", async () => {
    send("cos-6045");
    await pump.tick();
    gate.take("cos-6045", "2026-11-15T23:06:08.000Z");
    await pump.tick();
    vi.mocked(tmux.createSession).mockResolvedValueOnce({ ok: false, code: "create_failed", message: "fixture: no new session" });

    const launched = await relaunch("2026-11-15T23:06:06Z");

    expect(launched).toMatchObject({ ok: false, code: "launch_failed" });
    expect(alive.has(SEAT)).toBe(false);
    expect(!launched.ok && launched.handOver?.carried.map((c) => c.original)).toEqual(["cos-6045"]);
    expect(store.headOf(SEAT)?.body).toBe(`${redeliveryLabel("cos-6045", "2026-11-15T23:06:08.000Z")}\nbody of cos-6045`);
  });

  it("a --hand-over-since that is not a time is refused before anything is stopped", async () => {
    const launched = await relaunch("yesterday-ish");

    expect(launched).toMatchObject({ ok: false, code: "invalid_hand_over_since" });
    expect(alive.has(SEAT)).toBe(true);
  });

  // Review finding 3: the help promises ISO 8601. Date.parse also takes these, and reads a zoneless time in the daemon's own zone.
  it.each(["11/15/2026", "2026-11-15T23:06:06", "2026-11-15", "2026-02-30T10:00:00Z", "2026-11-15T24:00:00Z", "Sun, 15 Nov 2026 23:06:06 GMT"])(
    "a --hand-over-since that is not an ISO 8601 time with its zone (%s) is refused before anything is stopped", async (since) => {
      const launched = await relaunch(since);

      expect(launched).toMatchObject({ ok: false, code: "invalid_hand_over_since" });
      expect(alive.has(SEAT)).toBe(true);
    });

  it("an ISO 8601 time with an offset is taken as the same instant in UTC", async () => {
    const launched = await relaunch("2026-11-16T00:06:06+01:00");

    expect(launched).toMatchObject({ ok: true, handOver: { since: "2026-11-15T23:06:06.000Z", sinceSource: "hand_over_since" } });
  });

  it("a message whose copy the old occupant's gate recorded just before the stop, not yet read by the pump, reaches the fresh occupant", async () => {
    send("m-late");
    await pump.tick();
    gate.take("m-late", "2026-11-15T23:06:10.000Z");  // recorded on disk; the pump's next pass has not run
    const before = hop.sent.length;

    const launched = await relaunch();
    expect(launched.ok).toBe(true);
    now += 3 * 60_000;
    await pump.tick();

    expect(sentAfter(before)).toEqual([`${PREVIOUS_OCCUPANT_LABEL} body of m-late`]);
  });
});

describe("o9o.7: nothing goes to the dying session while a lifecycle lease holds the seat", () => {
  it("the Claude socket writes nothing while another operation's lifecycle lease holds the seat", async () => {
    const db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const store = new MessageStore(db);
    const id = messageId("m-during-launch");
    store.accept({ id, seat: SEAT, sender: "exec-cos@race-rig", body: "sent while launch --stop runs" });
    store.claimAttempt(store.headOf(SEAT)!, 0);
    const writes: string[] = [];
    const guard: HopGuard = { operation: (_name, fn) => fn(), heldByAnotherLifecycle: () => true };
    const hop = new ClaudeSeatHop({
      rows: store, guard, input: { submitText: async () => ({ ok: true as const }), sendKeys: async () => ({ ok: true as const }) },
      client: { call: async <T,>(): Promise<T> => ({ state: "live", status: { state: "idle" } } as T) },
      eligibility: async (): Promise<NativeEligibility> => ({ ok: true, nodeId: "n", endpoint: { socket_path: "/s" } as NativeEndpointRow }),
      writeToSeat: async (_endpoint, _sender, text) => { writes.push(text); return "all"; },
    });

    const result = await hop.attempt({ ids: [id], seat: SEAT, body: "sent while launch --stop runs", messageClass: "content", lane: 2 });

    expect(result).toEqual({ kind: "paused", reason: "busy" });
    expect(writes).toEqual([]);
    db.close();
  });
});

/** A promise and the hand that settles it: a step the test holds open while it does something else. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** Lets every queued promise step run: the lease to be taken, an attempt to reach its next await. */
const settle = async (): Promise<void> => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r)); };

describe("o9o.7 review finding 1: a socket write is decided under the lifecycle lease, on the pump and the direct path", () => {
  const NODE = "node-race";
  const bound: GuardTarget = { nodeId: NODE, session: SEAT, occupant: "occupant-old", pane: "%old" };
  let db: Database.Database;
  let guard: SeatDeliveryGuard;
  /** What happened, in order: a socket write starting and ending, the lifecycle operation's body starting and ending. */
  let events: string[];

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    guard = new SeatDeliveryGuard(db, (name) => (name === SEAT || name === NODE ? bound : null));
    events = [];
  });
  afterEach(() => db.close());

  /** `rig seat launch --fresh --stop` as the guard sees it: a lifecycle lease on the seat, whose body runs until `release` resolves. */
  function lifecycle(release: Promise<void>): Promise<void> {
    return guard.lifecycle([NODE], async () => { events.push("lifecycle body"); await release; events.push("lifecycle end"); });
  }

  function claudeHop(store: MessageStore, eligibility: () => Promise<NativeEligibility>, write: () => Promise<"none" | "all" | "partial">) {
    return new ClaudeSeatHop({
      rows: store, guard, input: { submitText: async () => ({ ok: true as const }), sendKeys: async () => ({ ok: true as const }) },
      client: { call: async () => { throw new Error("no hc in this test"); } },
      eligibility,
      writeToSeat: async () => { events.push("socket write"); const written = await write(); events.push("socket write done"); return written; },
    });
  }

  function acceptedMessage(store: MessageStore): SeatMessage {
    const id = messageId("m-race");
    store.accept({ id, seat: SEAT, sender: "exec-cos@race-rig", body: "sent as launch --stop begins" });
    store.claimAttempt(store.headOf(SEAT)!, 0);
    return { ids: [id], seat: SEAT, body: "sent as launch --stop begins", messageClass: "content", lane: 2 };
  }

  const eligible: NativeEligibility = { ok: true, nodeId: NODE, endpoint: {
    node_id: NODE, session_name: SEAT, generation: null, socket_path: "/s", transcript_path: null, claude_pid: 1, exec_path: null, claude_version: null,
    probe_result: null, registered_at: "2026-11-15T23:00:00.000Z" } };

  it("pump: a lease already holding the seat pauses the hop before it reads eligibility or writes", async () => {
    const store = new MessageStore(db);
    let eligibilityReads = 0;
    const hop = claudeHop(store, async () => { eligibilityReads += 1; return eligible; }, async () => "all");
    const release = deferred<void>();
    const launch = lifecycle(release.promise);
    await settle();

    const result = await hop.attempt(acceptedMessage(store));
    release.resolve();
    await launch;

    expect({ result, eligibilityReads, events }).toEqual({ result: { kind: "paused", reason: "busy" }, eligibilityReads: 0, events: ["lifecycle body", "lifecycle end"] });
  });

  it("pump: a lease taken while the hop reads eligibility stops the write; the hop pauses and the old occupant gets nothing", async () => {
    const store = new MessageStore(db);
    const eligibility = deferred<NativeEligibility>();
    const hop = claudeHop(store, () => eligibility.promise, async () => "all");
    const attempt = hop.attempt(acceptedMessage(store));
    await settle();
    const release = deferred<void>();
    const launch = lifecycle(release.promise);
    await settle();
    eligibility.resolve(eligible);
    await settle();
    release.resolve();
    await launch;

    expect(await attempt).toEqual({ kind: "paused", reason: "busy" });
    expect(events).toEqual(["lifecycle body", "lifecycle end"]);
  });

  it("pump: a write already on the socket when a lease is taken finishes before the lifecycle body runs", async () => {
    const store = new MessageStore(db);
    const write = deferred<"none" | "all" | "partial">();
    const hop = claudeHop(store, async () => eligible, () => write.promise);
    const attempt = hop.attempt(acceptedMessage(store));
    await settle();
    const release = deferred<void>();
    const launch = lifecycle(release.promise);
    await settle();
    write.resolve("all");
    await settle();
    release.resolve();
    await launch;

    expect(await attempt).toEqual({ kind: "sent" });
    expect(events).toEqual(["socket write", "socket write done", "lifecycle body", "lifecycle end"]);
  });

  it("direct: a rig send whose eligibility read is overtaken by a lease writes nothing to the socket while the lease holds the seat", async () => {
    const rigRepo = new RigRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const rig = rigRepo.createRig("race-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { role: "worker", runtime: "terminal" });
    const session = sessionRegistry.registerSession(node.id, SEAT);
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: SEAT, tmuxPane: "%old" });
    new EventBus(db);
    const tmux = Object.assign(mockTmuxAdapter(), {
      hasSession: async () => true,
      probeSession: async () => ({ state: "present" as const }),
      capturePaneContent: async () => "idle\n❯ ",
      getPaneCommand: async () => "bash",
      sendText: async () => { events.push("paste"); return { ok: true as const }; },
      sendKeys: async () => ({ ok: true as const }),
      deliveryGuard: guard,
    });
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux });
    const eligibility = deferred<NativeEligibility>();
    Object.assign(transport, { nativeInbox: {
      eligibility: () => eligibility.promise,
      deliver: async () => { events.push("socket write"); return { kind: "fallback", reason: "fixture", outboxIds: [], acked: false }; },
    } });

    const sent = transport.send(SEAT, "sent as launch --stop begins", { deliveryId: "m-direct", actorSession: "exec-cos@race-rig" });
    await settle();
    const release = deferred<void>();
    const launch = lifecycle(release.promise);
    await settle();
    eligibility.resolve(eligible);
    await settle();
    release.resolve();
    await launch;
    await sent;

    expect(events.slice(0, 2)).toEqual(["lifecycle body", "lifecycle end"]);
    expect(events).not.toContain("socket write");
  });
});

describe("o9o.7 review finding 2: a carried blocker wake stays wanted while its item still waits on that transition", () => {
  it("the real QueueRepository's wake check reads the carry row as the wake it re-delivers", async () => {
    const db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const queue = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    const item = await queue.create({ sourceSession: "exec-cos@race-rig", destinationSession: SEAT, body: "work", nudge: false });
    const { transition_id: transitionId } = db.prepare("SELECT transition_id FROM queue_transitions WHERE qitem_id = ? ORDER BY transition_id DESC LIMIT 1")
      .get(item.qitemId) as { transition_id: number };
    const store = new MessageStore(db);
    const pump = new MessagePump({
      store, directory: new DbSeatDirectory(db), held: { status: () => "held" },
      senders: { returnToSender: async () => ({ kind: "returned", qitemId: "q" }) },
      clock: () => Date.now(), log: () => undefined, ports: { gateFor: () => null, hopFor: () => null },
    });
    const obligations = new MessageObligations();
    queue.attachMessagePump(new PumpHandOff(store, pump, { gateFor: () => null, hopFor: () => null }), obligations);
    const wakeId = `${WAKE_INTENT_PREFIX}blocker-${transitionId}`;
    const asked = (id: string) => obligations.whyNoLongerWanted({ id: messageId(id), seat: SEAT, messageClass: "content", attempts: 0, occupantGeneration: null, auditPointer: item.qitemId });

    expect({ original: asked(wakeId), carried: asked(carryIdOf(wakeId, "abcd1234")) }).toEqual({ original: null, carried: null });
    pump.stop();
    db.close();
  });
});
