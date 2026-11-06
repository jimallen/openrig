// S4g, startup text through the pump: the real StartupOrchestrator, MessagePump, MessageStore and delivery guard on a real database; only the gate, the
// hop and the seat host are stubs. The real daemon on a private core is startup-pump.real.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { StubRuntimeAdapter } from "../src/adapters/stub-runtime-adapter.js";
import { guarded } from "../src/adapters/seat-hops.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import type { RuntimeAdapter, ResolvedStartupFile } from "../src/domain/runtime-adapter.js";
import { resolveGuardTarget, SeatDeliveryGuard } from "../src/domain/seat-delivery-guard.js";
import { PumpHandOff } from "../src/domain/seat-messaging/hand-off.js";
import { MessagePump } from "../src/domain/seat-messaging/message-pump.js";
import { MessageStore } from "../src/domain/seat-messaging/message-store.js";
import { messageId, type LastHopResult, type MessageId, type SeatGate, type SeatMessage } from "../src/domain/seat-messaging/ports.js";
import { DbSeatDirectory } from "../src/domain/seat-messaging/seat-directory.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { StartupOrchestrator, STARTUP_TEXT_WAIT_MS, type StartupInput } from "../src/domain/startup-orchestrator.js";
import { STARTUP_PROOF_INSTRUCTION_LINE } from "../src/domain/startup-proof.js";
import type { StartupAction } from "../src/domain/types.js";

const SEAT = "dev-impl@seat-rig";
const contents: Record<string, string> = { "/one.txt": "first file", "/two.txt": "second file" };
const file = (absolutePath: string): ResolvedStartupFile => ({ path: absolutePath.slice(1), absolutePath, deliveryHint: "send_text", required: true, appliesOn: ["fresh_start", "restore"] } as ResolvedStartupFile);

describe("startup text through the pump", () => {
  let db: Database.Database;
  let sessions: SessionRegistry;
  let store: MessageStore;
  let pump: MessagePump;
  let guard: SeatDeliveryGuard;
  let tmux: TmuxAdapter;
  let sendText: ReturnType<typeof vi.fn>;
  let sendKeys: ReturnType<typeof vi.fn>;
  let capture: ReturnType<typeof vi.fn>;
  let seen: Set<MessageId>;
  let attempts: SeatMessage[];
  /** What an attempt does: by default the seat takes it and its gate records it. */
  let onAttempt: (message: SeatMessage) => Promise<LastHopResult> | LastHopResult;
  let gated: boolean;
  let nodeId: string;
  let sessionId: string;
  let rigId: string;
  let tenure: string;
  let launching: () => void;
  let startPump: (tickMs: number) => void;
  /** Held, a read of the row `old` waits here. */
  let gateHold: Promise<void> | null;
  let holding: boolean;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const rigs = new RigRepository(db);
    sessions = new SessionRegistry(db);
    const rig = rigs.createRig("seat-rig");
    rigId = rig.id;
    const node = rigs.addNode(rig.id, "dev.impl", { runtime: "codex", cwd: "/project" });
    nodeId = node.id;
    sessionId = sessions.registerSession(node.id, SEAT).id;
    sessions.updateStatus(sessionId, "running");
    sessions.updateBinding(node.id, { tmuxSession: SEAT, tmuxPane: "%0" });
    tenure = sessions.currentOccupantTenure(node.id)!.generationUuid;
    store = new MessageStore(db);
    guard = new SeatDeliveryGuard(db, (target) => resolveGuardTarget(db, target));
    seen = new Set();
    attempts = [];
    gated = true;
    gateHold = null;
    holding = false;
    launching = () => undefined;
    onAttempt = (message) => { for (const id of message.ids) seen.add(id); return { kind: "sent" }; };
    const gate: SeatGate = {
      version: 1,
      lookup: async (_seat, id) => {
        if (gateHold !== null && id === messageId("old")) { holding = true; await gateHold; }
        return seen.has(id) ? { kind: "seen", record: { id, recordedAt: "2026-04-24T18:30:01.000Z", nonce: null } } : { kind: "not_seen" };
      },
    };
    const hop = { attempt: (message: SeatMessage) => guarded(guard, message.seat, async () => { attempts.push(message); return onAttempt(message); }) };
    const ports = { gateFor: () => (gated ? gate : null), hopFor: () => (gated ? hop : null) };
    startPump = (tickMs) => {
      pump = new MessagePump({
        store, ports, directory: new DbSeatDirectory(db), held: { status: () => "held" },
        senders: { returnToSender: async () => ({ kind: "no_return_path", reason: "none in this test" }) },
        timing: { tickMs, pauseRecheckMs: 20, backoffMs: [100_000] }, log: () => undefined,
      });
      pump.start();
      if (tmux) tmux.messageHandOff = new PumpHandOff(store, pump, ports);
    };
    startPump(5);
    sendText = vi.fn(async () => ({ ok: true }));
    sendKeys = vi.fn(async () => ({ ok: true }));
    capture = vi.fn(async () => "");
    tmux = Object.assign(new TmuxAdapter(async () => ""), {
      sendText, sendKeys, capturePaneContent: capture, deliveryGuard: guard, messageHandOff: new PumpHandOff(store, pump, ports),
    });
  });
  afterEach(() => { pump.stop(); db.close(); });

  const orchestrator = (waitMs = 300) => new StartupOrchestrator({
    db, sessionRegistry: sessions, eventBus: new EventBus(db), tmuxAdapter: tmux, sleep: async () => {}, startupTextWaitMs: waitMs,
    readinessSettings: { resolveOne: () => ({ value: 5, source: "default" }) } as never,
  });

  function adapter(runtime = "codex"): RuntimeAdapter {
    return Object.assign(new StubRuntimeAdapter({ tmux, runtime, fsOps: { readFile: (p: string) => contents[p]!, writeFile: () => undefined, exists: () => true, mkdirp: () => undefined } as never }), {
      project: async () => ({ projected: [], skipped: [], failed: [] }),
      launchHarness: async () => { launching(); return { ok: true as const }; },
      checkReady: async () => ({ ready: true }),
    });
  }

  const input = (overrides: Partial<StartupInput> = {}): StartupInput => ({
    rigId, nodeId, sessionId, adapter: adapter(), isRestore: false, startupActions: [],
    binding: { id: "b1", nodeId, tmuxSession: SEAT, tmuxWindow: null, tmuxPane: null, updatedAt: "", cwd: "/project" },
    plan: { runtime: "codex", cwd: "/project", entries: [], startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] },
    resolvedStartupFiles: [file("/one.txt"), file("/two.txt")],
    ...overrides,
  });

  const rows = () => db.prepare("SELECT * FROM outbox_entries WHERE sender_session = 'startup@system' ORDER BY rowid").all() as Array<Record<string, unknown>>;
  const typed = () => attempts.map((a) => a.body);

  it("a gated seat takes each file from the pump, lane 0, bound to its occupant, and each goes only after the last was recorded", async () => {
    const recorded: string[] = [];
    onAttempt = async (message) => {
      recorded.push(`attempt ${message.body}`);
      await new Promise((resolve) => setTimeout(resolve, 30));
      for (const id of message.ids) seen.add(id);
      recorded.push(`seen ${message.body}`);
      return { kind: "sent" };
    };
    const result = await orchestrator().startNode(input());
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(recorded).toEqual(["attempt first file", "seen first file", "attempt second file", "seen second file"]);
    expect(sendText).not.toHaveBeenCalled();
    expect(sendKeys).not.toHaveBeenCalled();
    expect(attempts[0]).toMatchObject({ seat: SEAT, messageClass: "lifecycle", lane: 0, occupantGeneration: tenure });
    expect(rows()).toMatchObject([
      { outbox_id: expect.stringMatching(new RegExp(`^seat-msg-startup-${tenure}-[^-]+-.*-1$`)), message_state: "received", class: "lifecycle", lane: 0, occupant_generation: tenure },
      { outbox_id: expect.stringMatching(new RegExp(`^seat-msg-startup-${tenure}-.*-2$`)), message_state: "received", class: "lifecycle", lane: 0, occupant_generation: tenure },
    ]);
  });

  it("startup actions go the same way, in order, behind the files", async () => {
    const action: StartupAction = { type: "send_text", value: "after ready", phase: "after_ready", appliesOn: ["fresh_start"], idempotent: true };
    const result = await orchestrator().startNode(input({ startupActions: [action] }));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(typed()).toEqual(["first file", "second file", "after ready"]);
  });

  it("a message queued during the launch lands after both files: file, file, message", async () => {
    launching = () => { store.accept({ id: messageId("q1"), seat: SEAT, sender: "lead@seat-rig", body: "queued" }); void pump.tick(); };
    onAttempt = async (message) => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      for (const id of message.ids) seen.add(id);
      return { kind: "sent" };
    };
    const result = await orchestrator().startNode(input());
    expect(result.ok, JSON.stringify(result)).toBe(true);
    await vi.waitFor(() => expect(typed()).toContain("queued"));
    expect(typed()).toEqual(["first file", "second file", "queued"]);
  });

  it("the timer's pass is on the seat, outside the lease, when the startup text is accepted: the text still goes, under the lease", async () => {
    // The timer's pass sits in the gate on an older row. When it comes back it reaches the startup row and can only pause it. That order is forced,
    // so this does not depend on how many steps a pass takes.
    store.accept({ id: messageId("old"), seat: SEAT, sender: "lead@seat-rig", body: "older" });
    let release = () => undefined as void;
    gateHold = new Promise<void>((resolve) => { release = resolve; });
    await vi.waitFor(() => expect(holding).toBe(true));
    const accept = store.accept.bind(store);
    store.accept = (entry) => {
      const row = accept(entry);
      if (String(entry.id).includes("startup-")) { seen.add(messageId("old")); gateHold = null; setTimeout(release, 10); store.accept = accept; }
      return row;
    };
    const result = await orchestrator().startNode(input({ resolvedStartupFiles: [file("/one.txt")] }));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(typed()).toEqual(["first file"]);
  });

  it("a seat with no gate keeps the paste and its Enter, and writes no row", async () => {
    gated = false;
    const result = await orchestrator().startNode(input());
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(sendText.mock.calls.map((c) => c[1])).toEqual(["first file", "second file"]);
    expect(sendKeys).toHaveBeenCalledTimes(2);
    expect(rows()).toEqual([]);
    expect(attempts).toEqual([]);
  });

  it("OF-160, OF-169: whichever way it goes, startup text has lost its controls, on a runtime that used to strip its own", async () => {
    contents["/poison.txt"] = "A\u0003B\u001b[201~C\u009b201~D\tE";
    const stripped = "ABC201~D\tE".replace("BC", "B[201~C");
    const stub = () => input({ adapter: adapter("stub"), resolvedStartupFiles: [file("/poison.txt")] });
    expect((await orchestrator().startNode(stub())).ok).toBe(true);
    expect(typed()).toEqual([stripped]);
    gated = false;
    expect((await orchestrator().startNode(stub())).ok).toBe(true);
    expect(sendText.mock.calls.map((c) => c[1])).toEqual([stripped]);
  });

  it("a seat with no occupant generation keeps the paste: a row that names nobody could reach anybody", async () => {
    db.prepare("DELETE FROM occupant_tenures WHERE node_id = ?").run(nodeId);
    const result = await orchestrator().startNode(input());
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(sendText).toHaveBeenCalledTimes(2);
    expect(rows()).toEqual([]);
  });

  it("bytes leaving are not arrival: with no gate record startup fails, the row ends, and nothing arrives later", async () => {
    onAttempt = () => ({ kind: "sent" });
    const result = await orchestrator(60).startNode(input());
    expect(result).toMatchObject({ ok: false, startupStatus: "failed" });
    expect(rows()).toMatchObject([{ message_state: "undeliverable", ack_evidence: "superseded", delivery_state: "failed" }]);
    const after = attempts.length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(attempts.length).toBe(after);
    expect(typed()).toEqual(["first file"]);
  });

  it("a record that lands as the wait ends is arrival, not a failure", async () => {
    const spy = vi.spyOn(PumpHandOff.prototype, "awaitReceived").mockImplementationOnce(async (id) => {
      seen.add(id);
      await vi.waitFor(() => expect(store.outcomeOf(id)).toBe("received"));
      return "open";
    });
    onAttempt = () => ({ kind: "sent" });
    const result = await orchestrator(60).startNode(input({ resolvedStartupFiles: [file("/one.txt")] }));
    spy.mockRestore();
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });

  it("the hold ends on a failed startup too", async () => {
    onAttempt = (message) => { if (message.lane === 2) seen.add(message.ids[0]); return { kind: "sent" }; };
    launching = () => { store.accept({ id: messageId("q2"), seat: SEAT, sender: "lead@seat-rig", body: "queued" }); };
    expect((await orchestrator(60).startNode(input())).ok).toBe(false);
    await vi.waitFor(() => expect(store.outcomeOf(messageId("q2"))).toBe("received"));
  });

  it("the text stays with its occupant: a new occupant during startup ends the row, nothing is typed, and startup fails", async () => {
    launching = () => { sessions.mintOccupantTenure(nodeId, "fresh"); };
    const result = await orchestrator().startNode(input());
    expect(result).toMatchObject({ ok: false, startupStatus: "failed" });
    expect(attempts).toEqual([]);
    expect(rows()).toMatchObject([{ message_state: "undeliverable", occupant_generation: tenure }]);
    expect(String(rows()[0]!.message_closed_reason)).toContain(`occupant ${tenure}`);
  });

  it("a seat that was busy gets its text from a pass under this startup's lease, once the pause is over", async () => {
    // The timer leaves this one to the lease: its passes pause and never type, as the production timer's do.
    pump.stop();
    startPump(60_000);
    let busy = 2;
    onAttempt = (message) => {
      if (busy-- > 0) return { kind: "paused", reason: "busy" };
      for (const id of message.ids) seen.add(id);
      return { kind: "sent" };
    };
    const result = await orchestrator(2_000).startNode(input({ resolvedStartupFiles: [file("/one.txt")] }));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(attempts.length).toBeGreaterThanOrEqual(3);
    expect(rows()).toMatchObject([{ message_state: "received" }]);
  });

  it("a pass that started before a lease it does not own pauses, and never holds the seat from the startup under that lease", async () => {
    // A restore takes its leases before any seat starts, so a queued row's timer pass can reach the seat first.
    const result = await guard.lifecycle([nodeId], async () => {
      store.accept({ id: messageId("q3"), seat: SEAT, sender: "lead@seat-rig", body: "queued" });
      await new Promise((resolve) => setTimeout(resolve, 30));
      return orchestrator(400).startNode(input({ resolvedStartupFiles: [file("/one.txt")] }));
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    await vi.waitFor(() => expect(typed()).toEqual(["first file", "queued"]));
  });

  describe("Claude's paste fallback", () => {
    const composerWith = (text: string) => `Welcome\n${"─".repeat(40)}\n❯ ${text.split("\n").join("\n  ")}\n${"─".repeat(40)}\n  ? for shortcuts\n`;
    const claude = (overrides: Partial<StartupInput> = {}) => input({ adapter: adapter("claude-code"), resolvedStartupFiles: [file("/one.txt")], ...overrides });
    beforeEach(() => { db.prepare("UPDATE nodes SET runtime = 'claude-code' WHERE id = ?").run(nodeId); });

    it("a staged paste gets the guarded Enter, because the hop will not touch what it cannot tell from a draft", async () => {
      let staged: string | null = null;
      // Late on purpose: a look that finds nothing yet spends no Enter.
      onAttempt = (message) => { setTimeout(() => { staged = `${message.body}\n[openrig-msg ${message.ids[0]}:${store.nonceOf(message.ids[0])}]`; }, 700); return { kind: "sent" }; };
      capture.mockImplementation(async () => (staged ? composerWith(staged) : ""));
      sendKeys.mockImplementation(async () => { staged = null; seen.add(attempts[0]!.ids[0]); return { ok: true }; });
      const result = await orchestrator(2_500).startNode(claude());
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(sendKeys).toHaveBeenCalledTimes(1);
      expect(sendKeys).toHaveBeenCalledWith(SEAT, ["Enter"]);
      expect(sendText).not.toHaveBeenCalled();
    });

    describe("a long text with no socket: whole, so its body is in the prompt (decision 35)", () => {
      const LONG = "L".repeat(3_000);
      beforeEach(() => { contents["/long.txt"] = LONG; });
      const marked = (message: SeatMessage) => `${message.body}\n[openrig-msg ${message.ids[0]}:${store.nonceOf(message.ids[0])}]`;

      it("gets the guarded Enter on the whole text and its marker", async () => {
        let staged: string | null = null;
        onAttempt = (message) => { setTimeout(() => { staged = marked(message); }, 700); return { kind: "sent" }; };
        capture.mockImplementation(async () => (staged ? composerWith(staged) : ""));
        sendKeys.mockImplementation(async () => { staged = null; seen.add(attempts[0]!.ids[0]); return { ok: true }; });
        const result = await orchestrator(2_500).startNode(claude({ resolvedStartupFiles: [file("/long.txt")] }));
        expect(result.ok, JSON.stringify(result)).toBe(true);
        expect(sendKeys).toHaveBeenCalledTimes(1);
      });
      it("one Enter is all it gets, however long the text still shows", async () => {
        let staged: string | null = null;
        onAttempt = (message) => { staged = marked(message); return { kind: "sent" }; };
        capture.mockImplementation(async () => (staged ? composerWith(staged) : ""));
        const result = await orchestrator(1_600).startNode(claude({ resolvedStartupFiles: [file("/long.txt")] }));
        expect(result.ok).toBe(false);
        expect(sendKeys).toHaveBeenCalledTimes(1);
      });
      it("collapsed by Claude, with its Enter lost: it cannot be told from a person's paste, so no Enter goes, and the startup fails out loud", async () => {
        onAttempt = () => ({ kind: "sent" });
        capture.mockImplementation(async () => composerWith("[Pasted text #1 +1 lines]"));
        const result = await orchestrator(700).startNode(claude({ resolvedStartupFiles: [file("/long.txt")] }));
        expect(result.ok).toBe(false);
        expect(JSON.stringify(result)).toContain("did not record startup text");
        expect(sendKeys).not.toHaveBeenCalled();
        expect(rows()).toMatchObject([{ message_state: "undeliverable" }]);
      });
      it("never records on a note: the hand-off has no short form to find", () => {
        store.accept({ id: messageId("x"), seat: SEAT, sender: "startup@system", body: "b" });
        store.claimAttempt(store.headOf(SEAT)!, 0);
        store.markParts(messageId("x"), 1);
        expect((tmux.messageHandOff as PumpHandOff).stagedPaste(messageId("x"), "b")).toBe(`b\n[openrig-msg x:${store.nonceOf(messageId("x"))}]`);
      });
      it("a socket that never comes and a paste that never lands fail the startup out loud, and the row ends", async () => {
        onAttempt = () => ({ kind: "paused", reason: "long_no_socket" });
        const result = await orchestrator(400).startNode(claude({ resolvedStartupFiles: [file("/long.txt")] }));
        expect(result.ok).toBe(false);
        expect(JSON.stringify(result)).toContain("did not record startup text");
        expect(rows()).toMatchObject([{ message_state: "undeliverable" }]);
      });
    });

    it("what is in the composer is not ours when it is not exactly this text: no Enter", async () => {
      onAttempt = () => ({ kind: "sent" });
      capture.mockImplementation(async () => composerWith("a person's draft"));
      const result = await orchestrator(700).startNode(claude());
      expect(result.ok).toBe(false);
      expect(capture).toHaveBeenCalled();
      expect(sendKeys).not.toHaveBeenCalled();
    });

    it("a socket write is not a paste: nothing is pressed and the pane is not read", async () => {
      onAttempt = (message) => { store.recordSocketWrite(message.ids[0], Date.now()); return { kind: "sent" }; };
      const result = await orchestrator(700).startNode(claude());
      expect(result.ok).toBe(false);
      expect(capture).not.toHaveBeenCalled();
      expect(sendKeys).not.toHaveBeenCalled();
    });

    it("a gate record is the submission: the proof instruction follows", async () => {
      const proof: StartupAction = { type: "startup_proof", value: "authenticated", phase: "after_ready", appliesOn: ["fresh_start"], idempotent: true };
      const identity: StartupAction = { type: "send_text", value: "OpenRig session identity: x", phase: "after_ready", appliesOn: ["fresh_start"], idempotent: true };
      const result = await orchestrator().startNode(claude({ startupActions: [proof, identity] }));
      expect(result).toMatchObject({ ok: true });
      expect(typed()).toContain(STARTUP_PROOF_INSTRUCTION_LINE);
    });
  });

  it("the wait is long enough for a first turn to end: the next text is held behind it", () => {
    expect(STARTUP_TEXT_WAIT_MS).toBe(5 * 60_000);
  });

  // OF-247 (a), the measurement behind SeatIdentityReconciler's per-seat excuse term (LIFECYCLE_EXCUSE_PER_SEAT_MS): one seat's startup is its readiness window and then ONE
  // startup text wait, however many texts follow. Scaled to real time (window 1.1 s, text wait 0.2 s; the production values are 30 s default / 600 s largest and 5 min):
  // the seat is ready only at the end of its window, no gate records its first text, and the run takes at least the window plus ONE wait (the lower bound: a loaded host
  // only lengthens it). Two files are queued; the second is never attempted, so a second wait is not added (the row count is the proof; the existing "bytes leaving are not
  // arrival" row pins the same latch).
  it("a seat that becomes ready at the end of its readiness window and whose text is never recorded takes the window plus one text wait, and not one wait per text", async () => {
    const WINDOW = 1100, WAIT = 200, readyAfter = 1050;
    const started = Date.now();
    onAttempt = () => ({ kind: "sent" });
    const slowReady = Object.assign(adapter(), { checkReady: async () => ({ ready: Date.now() - started >= readyAfter }) });
    const result = await orchestrator(WAIT).startNode(input({ adapter: slowReady, readinessTimeoutMs: WINDOW }));
    const elapsed = Date.now() - started;
    expect(result).toMatchObject({ ok: false, startupStatus: "failed" });
    expect(JSON.stringify(result)).toContain("did not record startup text");
    expect(elapsed, "ms from start to the failed startup").toBeGreaterThanOrEqual(readyAfter + WAIT - 30);
    expect(rows(), "one row: the first text; the second file was never attempted").toHaveLength(1);
    expect(typed()).toEqual(["first file"]);
  });
});
