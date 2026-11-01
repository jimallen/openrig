// hc cutover: how SessionTransport writes to a seat bound to herdr-core. One `terminal.send` replaces paste, a 200 ms
// sleep and Enter; its silence is never retried from here; an audited prompt answer keeps the staged path and says it
// may answer a dialog. tmux seats keep exactly the calls they had.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport, type HcSeatDelivery, type SendResult } from "../src/domain/session-transport.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler, labelForTmuxSend } from "../src/domain/outbox-handler.js";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";
import { tmuxStub } from "./helpers/tmux-stub.js";
import type { HcDeliveryOutcome, HcPendingSend } from "../src/adapters/hc-delivery.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { CaptureObserver, hashSentText, type Observation } from "../src/domain/capture-observer.js";

const SEAT = "dev-impl@my-rig";
const PENDING: HcPendingSend = { version: 1, seat: SEAT, address: "t4", token: null, sendStartedAtMs: 4_100_000_000_000, preTurn: 3, preStatus: "idle", preReported: true, commandLed: false, preScreen: null, pasteEchoes: false };

type TmuxCalls = { sendText: ReturnType<typeof vi.fn>; sendKeys: ReturnType<typeof vi.fn>; capture: ReturnType<typeof vi.fn> };

function mockTmux(over: { capture?: (n: string, lines?: number) => Promise<string | null> } = {}): { tmux: TmuxAdapter; calls: TmuxCalls } {
  const calls: TmuxCalls = {
    sendText: vi.fn(async (): Promise<TmuxResult> => ({ ok: true })),
    sendKeys: vi.fn(async (): Promise<TmuxResult> => ({ ok: true })),
    capture: vi.fn(over.capture ?? (async () => "idle\n❯ ")),
  };
  const tmux = tmuxStub({
    hasSession: async () => true,
    probeSession: async () => ({ state: "present" as const }),
    sendText: calls.sendText, sendKeys: calls.sendKeys, capturePaneContent: calls.capture,
    createSession: async () => ({ ok: true as const }), killSession: async () => ({ ok: true as const }),
    listSessions: async () => [], listWindows: async () => [], listPanes: async () => [],
    startPipePane: async () => ({ ok: true as const }), stopPipePane: async () => ({ ok: true as const }),
    getPanePid: async () => null, getPaneCommand: async () => null,
  });
  return { tmux, calls };
}

const delivered = (over: Partial<Extract<HcDeliveryOutcome, { state: "delivered" }>> = {}): HcDeliveryOutcome =>
  ({ state: "delivered", evidence: "reply", verified: false, started: null, status: "idle", turn: 4, ...over });

function hcDelivery(...outcomes: HcDeliveryOutcome[]): HcSeatDelivery & { deliver: ReturnType<typeof vi.fn> } {
  let i = 0;
  return { deliver: vi.fn(async () => outcomes[Math.min(i++, outcomes.length - 1)] ?? delivered()) };
}

describe("SessionTransport.send to an hc seat", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let agentActivityStore: AgentActivityStore;
  let nodeId: string;
  const sleeps: number[] = [];

  beforeEach(() => {
    sleeps.length = 0;
    db = createDb();
    migrate(db, ALL_MIGRATIONS);  // the outbox tables are not in the core fixture
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    agentActivityStore = new AgentActivityStore({ db, eventBus });
    const rig = rigRepo.createRig("my-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { role: "worker", runtime: "claude-code" });
    nodeId = node.id;
    const session = sessionRegistry.registerSession(node.id, SEAT);
    sessionRegistry.updateStatus(session.id, "running");
  });
  afterEach(() => db.close());

  const bindAs = (attachmentType: "hc" | "tmux") => sessionRegistry.updateBinding(nodeId, { attachmentType, tmuxSession: SEAT });
  const transport = (tmux: TmuxAdapter, hc?: HcSeatDelivery) => new SessionTransport({
    db, rigRepo, sessionRegistry, tmuxAdapter: tmux, agentActivityStore, eventBus,
    sleep: async (ms) => { sleeps.push(ms); },
    ...(hc ? { hcDelivery: hc } : {}),
  });

  it("writes an ordinary message as one delivery: no tmux paste, no 200 ms wait, no separate Enter", async () => {
    bindAs("hc");
    const { tmux, calls } = mockTmux();
    const hc = hcDelivery(delivered());
    const result = await transport(tmux, hc).send(SEAT, "hello");
    expect(result).toMatchObject({ ok: true, path: "hc" });
    expect(hc.deliver).toHaveBeenCalledTimes(1);
    // An agent seat's message carries its delivery token (the exactly-once evidence); see the token tests below.
    expect(hc.deliver).toHaveBeenCalledWith(SEAT, expect.stringMatching(/^hello\n\[openrig delivery [0-9a-f]{12}\]$/), { token: expect.stringMatching(/^[0-9a-f]{12}$/) });
    expect(calls.sendText).not.toHaveBeenCalled();
    expect(calls.sendKeys).not.toHaveBeenCalled();
    expect(sleeps).not.toContain(200);
  });

  it("takes the core's started as the verification and skips the capture check", async () => {
    bindAs("hc");
    const { tmux } = mockTmux();
    const result = await transport(tmux, hcDelivery(delivered({ started: true, verified: true }))).send(SEAT, "hello", { verify: true });
    expect(result).toMatchObject({ ok: true, path: "hc", verified: true, outcome: "delivered" });
    expect(sleeps).not.toContain(500);
  });

  it("keeps the capture check when the core did not say the program started", async () => {
    bindAs("hc");
    const { tmux } = mockTmux();
    const result = await transport(tmux, hcDelivery(delivered())).send(SEAT, "hello", { verify: true });
    expect(result).toMatchObject({ ok: true, path: "hc", outcome: "rendered-unconfirmed" });
    expect(sleeps).toContain(500);
  });

  it("passes the delivery token and the lifecycle check through to the delivery", async () => {
    bindAs("hc");
    const beforeWrite = vi.fn();
    const hc = hcDelivery(delivered());
    await transport(mockTmux().tmux, hc).send(SEAT, "hello <tok>", { deliveryToken: "tok", beforeWrite });
    expect(hc.deliver).toHaveBeenCalledWith(SEAT, "hello <tok>", { token: "tok", beforeInput: beforeWrite });
    expect(beforeWrite).toHaveBeenCalled();
  });

  describe("the delivery token: exactly once needs a producer (QA B2)", () => {
    /** The recipe restated here, not imported: 12 hex of sha256("openrig-hc-delivery\0" + key). */
    const tokenOf = (key: string) => createHash("sha256").update(`openrig-hc-delivery\0${key}`).digest("hex").slice(0, 12);
    const lastCall = (hc: ReturnType<typeof hcDelivery>) => hc.deliver.mock.calls.at(-1) as [string, string, { token?: string }];

    it("an agent seat's message goes out with its token as a trailing line, and the delivery is told the same token", async () => {
      bindAs("hc");
      const hc = hcDelivery(delivered());
      await transport(mockTmux().tmux, hc).send(SEAT, "hello", { deliveryId: "wake-7" });
      const [, text, options] = lastCall(hc);
      expect(options.token).toBe(tokenOf("delivery:wake-7"));
      expect(text).toBe(`hello\n[openrig delivery ${tokenOf("delivery:wake-7")}]`);
    });

    it("the same delivery id carries the same token on every send, so a retry finds its first landing; another id does not", async () => {
      bindAs("hc");
      const hc = hcDelivery(delivered());
      const t = transport(mockTmux().tmux, hc);
      await t.send(SEAT, "hello", { deliveryId: "wake-7" });
      const first = lastCall(hc)[2].token;
      await t.send(SEAT, "hello", { deliveryId: "wake-7" });
      expect(lastCall(hc)[2].token).toBe(first);
      await t.send(SEAT, "hello", { deliveryId: "wake-8" });
      expect(lastCall(hc)[2].token).not.toBe(first);
    });

    it("a send with no delivery identity still gets a token of its own, never the same twice", async () => {
      bindAs("hc");
      const hc = hcDelivery(delivered());
      const t = transport(mockTmux().tmux, hc);
      await t.send(SEAT, "hello");
      const a = lastCall(hc)[2].token;
      await t.send(SEAT, "hello");
      const b = lastCall(hc)[2].token;
      expect(a).toMatch(/^[0-9a-f]{12}$/);
      expect(b).toMatch(/^[0-9a-f]{12}$/);
      expect(a).not.toBe(b);
    });

    it("a plain terminal seat reads the text as a shell command, so it gets the text as written and no token", async () => {
      const rig = rigRepo.createRig("sh-rig");
      const node = rigRepo.addNode(rig.id, "dev.shell", { role: "worker", runtime: "terminal" });
      const session = sessionRegistry.registerSession(node.id, "dev-shell@sh-rig");
      sessionRegistry.updateStatus(session.id, "running");
      sessionRegistry.updateBinding(node.id, { attachmentType: "hc", tmuxSession: "dev-shell@sh-rig" });
      const hc = hcDelivery(delivered());
      await transport(mockTmux().tmux, hc).send("dev-shell@sh-rig", "ls -la", { deliveryId: "wake-7" });
      expect(hc.deliver).toHaveBeenCalledWith("dev-shell@sh-rig", "ls -la", {});
    });

    it("the capture observation hashes the text that was written, token line included", async () => {
      bindAs("hc");
      const hc = hcDelivery(delivered());
      const observer = new CaptureObserver();
      const t = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: mockTmux().tmux, agentActivityStore, eventBus, sleep: async () => {}, hcDelivery: hc, captureObserver: observer });
      await t.send(SEAT, "hello", { verify: true, deliveryId: "wake-7" });
      const seen: Observation[] = [];
      while (observer.stats().queued > 0) await observer.drain((batch) => { seen.push(...batch); });
      const sent = lastCall(hc)[1];
      expect(sent).toContain("[openrig delivery ");
      expect(seen.filter((o) => o.seam === "send_verify").map((o) => o.sentHash)).toEqual([hashSentText(sent)]);
    });

    it("a token the caller supplies is used as given and the text is not touched again", async () => {
      bindAs("hc");
      const hc = hcDelivery(delivered());
      await transport(mockTmux().tmux, hc).send(SEAT, "hello <tok>", { deliveryToken: "tok", deliveryId: "wake-7" });
      expect(lastCall(hc).slice(1)).toEqual(["hello <tok>", { token: "tok" }]);
    });
  });

  describe("every automated send that ends unconfirmed leaves an indeterminate row (security re-review F3)", () => {
    const waiting: HcDeliveryOutcome = { state: "waiting", reason: "waiting_on_person", cause: "queued_in_core", pending: PENDING, message: "queued; do not resend" };
    const rows = () => new OutboxHandler(db).listHcUnsettled();
    const count = () => (db.prepare("SELECT count(*) AS n FROM outbox_entries").get() as { n: number }).n;

    it.each([
      ["waiting_on_person", waiting, "waiting_on_person"],
      ["delivery_outcome_unknown", { state: "unknown", reason: "core_unreachable", pending: PENDING, message: "cannot be asked" } satisfies HcDeliveryOutcome, "outcome_unknown"],
    ] as const)("%s: one row, indeterminate, hc, with the pending record, whoever called", async (_reason, outcome, evidence) => {
      bindAs("hc");
      const result = await transport(mockTmux().tmux, hcDelivery(outcome)).send(SEAT, "restore prompt", { actorSession: "compaction@system" });
      expect(result).toMatchObject({ ok: false, path: "hc" });
      expect(rows()).toHaveLength(1);
      expect(rows()[0]).toMatchObject({ senderSession: "compaction@system", destinationSession: SEAT, body: "restore prompt", deliveryState: "indeterminate", deliveryPath: "hc", ackEvidence: evidence });
      expect(JSON.parse(rows()[0]!.ackDetail!)).toEqual(PENDING);
    });

    it("a caller with no identity is recorded as unattributed, not skipped (the enforcer's stage sends carry none)", async () => {
      bindAs("hc");
      await transport(mockTmux().tmux, hcDelivery(waiting)).send(SEAT, "audit prompt");
      expect(rows()).toHaveLength(1);
      expect(rows()[0]!.senderSession).toBe("unknown");
      expect(db.prepare("SELECT identity_provenance AS p FROM outbox_entries").get()).toEqual({ p: "origin-unknown:v1" });
    });

    it("a stable delivery id makes the row idempotent: the same wake sent twice leaves one row", async () => {
      bindAs("hc");
      const t = transport(mockTmux().tmux, hcDelivery(waiting));
      await t.send(SEAT, "wake", { deliveryId: "guard-watchdog-abc", actorSession: "watchdog@system" });
      await t.send(SEAT, "wake", { deliveryId: "guard-watchdog-abc", actorSession: "watchdog@system" });
      expect(rows().map((r) => r.outboxId)).toEqual(["guard-watchdog-abc"]);
    });

    it("writes nothing when the caller owns the row: a route or the native fallback says so (ownsOutboxRow)", async () => {
      bindAs("hc");
      await transport(mockTmux().tmux, hcDelivery(waiting)).send(SEAT, "from a route", { ownsOutboxRow: true, actorSession: "planner@my-rig" });
      expect(count()).toBe(0);
    });

    it("writes nothing when a row already exists under the delivery id: the queue's wake owns it and finalizes it", async () => {
      bindAs("hc");
      const outbox = new OutboxHandler(db);
      outbox.record({ outboxId: "wake-intent-q1", senderSession: "planner@my-rig", destinationSession: SEAT, body: "wake", identityProvenance: "transport:v1" });
      await transport(mockTmux().tmux, hcDelivery(waiting)).send(SEAT, "wake", { deliveryId: "wake-intent-q1", actorSession: "planner@my-rig" });
      expect(db.prepare("SELECT delivery_state AS s FROM outbox_entries WHERE outbox_id = 'wake-intent-q1'").get()).toEqual({ s: "pending" });  // untouched
      expect(count()).toBe(1);
    });

    it("writes nothing for a committed queue wake (committedOutboxIds): its rows exist before the send", async () => {
      bindAs("hc");
      const outbox = new OutboxHandler(db);
      outbox.record({ outboxId: "wake-intent-q2", senderSession: "planner@my-rig", destinationSession: SEAT, body: "wake", identityProvenance: "transport:v1" });
      await transport(mockTmux().tmux, hcDelivery(waiting)).send(SEAT, "wake", { committedOutboxIds: ["wake-intent-q2"], actorSession: "planner@my-rig" });
      expect(count()).toBe(1);
      expect(rows()).toEqual([]);
    });

    it("a delivered send settles delivered and a definite refusal failed: neither is an unconfirmed row", async () => {
      bindAs("hc");
      await transport(mockTmux().tmux, hcDelivery(delivered())).send(SEAT, "hello");
      await transport(mockTmux().tmux, hcDelivery({ state: "not_delivered", reason: "blocked", code: "seat_blocked", message: "blocked" })).send(SEAT, "hello");
      expect(count()).toBe(2);
      expect(rows()).toHaveLength(0);
      expect(db.prepare("SELECT delivery_state AS s FROM outbox_entries ORDER BY rowid").all()).toEqual([{ s: "delivered" }, { s: "failed" }]);
    });

    it("a schema with no outbox table has nothing to commit to: the send's result is its own", async () => {
      bindAs("hc");
      db.exec("DROP TABLE outbox_entries");
      const result = await transport(mockTmux().tmux, hcDelivery(waiting)).send(SEAT, "hello");
      expect(result).toMatchObject({ ok: false, path: "hc", reason: "waiting_on_person", hcPending: PENDING });
    });
  });

  describe("a send the core may still deliver is not a failure and is never retried", () => {
    it("reports waiting_on_person with the pending record, once", async () => {
      bindAs("hc");
      const hc = hcDelivery({ state: "waiting", reason: "waiting_on_person", cause: "queued_in_core", pending: PENDING, message: "queued; do not resend" });
      const result = await transport(mockTmux().tmux, hc).send(SEAT, "hello");
      expect(result).toMatchObject({ ok: false, path: "hc", reason: "waiting_on_person", hcPending: PENDING });
      expect(result.error).toContain("do not resend");
      expect(result.outcome).toBeUndefined();  // not "failed"
      expect(result.sent).toBeUndefined();
      expect(hc.deliver).toHaveBeenCalledTimes(1);
    });

    it("reports delivery_outcome_unknown with the pending record, once", async () => {
      bindAs("hc");
      const hc = hcDelivery({ state: "unknown", reason: "core_unreachable", pending: PENDING, message: "cannot be asked; do not resend" });
      const result = await transport(mockTmux().tmux, hc).send(SEAT, "hello");
      expect(result).toMatchObject({ ok: false, path: "hc", reason: "delivery_outcome_unknown", hcPending: PENDING });
      expect(hc.deliver).toHaveBeenCalledTimes(1);
    });

    it("labels both on the hc path as the evidence a sweep settles by, with the record in the detail", () => {
      expect(labelForTmuxSend({ ok: false, path: "hc", reason: "waiting_on_person", hcPending: PENDING })).toEqual({ path: "hc", evidence: "waiting_on_person", detail: JSON.stringify(PENDING) });
      expect(labelForTmuxSend({ ok: false, path: "hc", reason: "delivery_outcome_unknown", hcPending: PENDING })).toEqual({ path: "hc", evidence: "outcome_unknown", detail: JSON.stringify(PENDING) });
    });
  });

  describe("a refusal says what the tmux path says, with nothing typed", () => {
    const refusal = (reason: Extract<HcDeliveryOutcome, { state: "not_delivered" }>["reason"], code: string): HcDeliveryOutcome => ({ state: "not_delivered", reason, code, message: `refused: ${reason}` });
    it.each([
      ["blocked", "seat_blocked", "target_needs_input"], ["not_found", "session_not_found", "session_missing"], ["finished", "session_not_found", "session_missing"],
      ["core_unreachable", "transport_unavailable", "tmux_unavailable"], ["guard_refused", "guard_target_changed", "guard_target_changed"],
      ["status_mismatch", "status_mismatch", "send_failed"], ["core_restarted_send_gone", "send_gone", "send_failed"],
    ] as const)("maps %s to %s", async (reason, code, expected) => {
      bindAs("hc");
      const result = await transport(mockTmux().tmux, hcDelivery(refusal(reason, code))).send(SEAT, "hello");
      expect(result).toMatchObject({ ok: false, path: "hc", reason: expected, sent: false, outcome: "failed", error: `refused: ${reason}` });
    });
  });

  it("keeps the tmux-shaped calls for an hc-labelled seat until a daemon wires hc delivery", async () => {
    bindAs("hc");
    const { tmux, calls } = mockTmux();
    const result = await transport(tmux).send(SEAT, "hello");
    expect(result.ok).toBe(true);
    expect(result.path).toBeUndefined();
    expect(calls.sendText).toHaveBeenCalledWith(SEAT, "hello");
    expect(calls.sendKeys).toHaveBeenCalledWith(SEAT, ["Enter"]);
  });

  it("leaves a tmux seat exactly as it was, even with hc delivery wired", async () => {
    bindAs("tmux");
    const { tmux, calls } = mockTmux();
    const hc = hcDelivery(delivered());
    const result: SendResult = await transport(tmux, hc).send(SEAT, "hello");
    expect(result.ok).toBe(true);
    expect(result.path).toBeUndefined();
    expect(hc.deliver).not.toHaveBeenCalled();
    expect(calls.sendText).toHaveBeenCalledWith(SEAT, "hello");
    expect(calls.sendKeys).toHaveBeenCalledWith(SEAT, ["Enter"]);
    expect(sleeps).toContain(200);
  });

  describe("an audited prompt answer", () => {
    // The answer must reach a dialog that `terminal.send` refuses, so it stages text and presses Enter itself, each call
    // saying it may answer a dialog (hc's keys and a staged paste have no refusal of their own; HcInput makes one by default).
    it("keeps the staged path on an hc seat and says blocked: allow on the text and on the Enter", async () => {
      bindAs("hc");
      agentActivityStore.recordHookEvent({ runtime: "claude-code", sessionName: SEAT, hookEvent: "Notification", subtype: "permission_prompt" });
      const { tmux, calls } = mockTmux({ capture: async () => "❯ typed answer\n──────────────────────────────" });
      const hc = hcDelivery(delivered());
      const result = await transport(tmux, hc).send(SEAT, "typed answer", { dangerouslyInteract: true, reason: "approve it", actorSession: "orch@my-rig" });
      expect(result).toMatchObject({ ok: true, path: "hc", promptInteraction: "enter-sent" });
      expect(hc.deliver).not.toHaveBeenCalled();
      expect(calls.sendText).toHaveBeenCalledWith(SEAT, "typed answer", undefined, { bracketed: false, blocked: "allow" });
      expect(calls.sendKeys).toHaveBeenCalledWith(SEAT, ["Enter"], undefined, { blocked: "allow" });
    });

    it("says blocked: allow for a tmux seat too, where it changes nothing", async () => {
      bindAs("tmux");
      agentActivityStore.recordHookEvent({ runtime: "claude-code", sessionName: SEAT, hookEvent: "Notification", subtype: "permission_prompt" });
      const { tmux, calls } = mockTmux({ capture: async () => "❯ typed answer\n──────────────────────────────" });
      await transport(tmux).send(SEAT, "typed answer", { dangerouslyInteract: true, reason: "approve it", actorSession: "orch@my-rig" });
      expect(calls.sendText).toHaveBeenCalledWith(SEAT, "typed answer", undefined, { bracketed: false, blocked: "allow" });
      expect(calls.sendKeys).toHaveBeenCalledWith(SEAT, ["Enter"], undefined, { blocked: "allow" });
    });

    it("does not say it for an ordinary message", async () => {
      bindAs("tmux");
      const { tmux, calls } = mockTmux();
      await transport(tmux).send(SEAT, "hello");
      expect(calls.sendText).toHaveBeenCalledWith(SEAT, "hello");
      expect(calls.sendKeys).toHaveBeenCalledWith(SEAT, ["Enter"]);
    });
  });
});
