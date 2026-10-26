// OF-89 review F1/F2: the runner's held-message report reads needs_input so `rig ps` and the UI show the hold
// (pda-held-visible.test.ts), but it must not change what a SEND or a WAKE decides (OF-88 owns send gating for a
// pda seat; its answer is the runner's sidecar). These rows are the cases where the runner gives no answer (its
// sidecar is not ready, is exited, or is older than 180 s), so the transport falls back to hooks and the pane: there
// a held report must behave exactly as it did before OF-89, when it read `unknown`.
//
// Real SessionTransport, AgentActivityStore and queue-wake-ladder prompt reader over a pda seat whose runner source
// answers null, a pane foreground of `node` and neutral pane text. The expected outcomes are what base
// c7a73894 does with the same hook (the store mapping reverted), measured by the reviewer's probe and re-measured
// here as the RED of these rows. Every row has a display control: the SAME hook still reads needs_input from the
// store, so a green gate is not a missing hook.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import { makePromptStateReader } from "../src/domain/queue-wake-ladder.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { RunnerSendReadinessSource } from "../src/domain/runtime-adapter.js";
import { createFullTestDb } from "./helpers/test-app.js";

const SEAT = "dev-pda@my-rig";
const PANE = ["[pda-runner] pda unreachable; retrying", "> "].join("\n");
const NOW = new Date("2026-10-26T12:00:00.000Z");

describe("OF-89: a held report is display evidence, not send or wake authority", () => {
  let db: Database.Database; let rigRepo: RigRepository; let sessionRegistry: SessionRegistry;
  let eventBus: EventBus; let store: AgentActivityStore; let nodeId: string;
  beforeEach(() => {
    db = createFullTestDb(); rigRepo = new RigRepository(db); sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db); store = new AgentActivityStore({ db, eventBus, now: () => NOW });
    const rigId = rigRepo.createRig("my-rig").id;
    const node = rigRepo.addNode(rigId, "dev.pda", { role: "worker", runtime: "pda" });
    nodeId = node.id;
    const s = sessionRegistry.registerSession(node.id, SEAT);
    sessionRegistry.updateStatus(s.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: SEAT });
  });
  afterEach(() => db.close());

  function transport() {
    const sendText = vi.fn(async () => ({ ok: true as const }));
    const adapter = {
      hasSession: async () => true, probeSession: async () => ({ state: "present" as const }),
      sendText, sendKeys: vi.fn(async () => ({ ok: true as const })),
      capturePaneContent: async () => PANE, createSession: async () => ({ ok: true as const }),
      killSession: async () => ({ ok: true as const }), listSessions: async () => [], listWindows: async () => [],
      listPanes: async () => [], startPipePane: async () => ({ ok: true as const }), stopPipePane: async () => ({ ok: true as const }),
      getPanePid: async () => null, getPaneCommand: async () => "node", hasSessionEnv: async () => null,
    } as unknown as TmuxAdapter;
    const ask = async () => null; // the runner gives no answer: sidecar not ready, exited, or past its alive window
    const runnerSendReadiness = Object.assign(ask, { runtimes: new Set(["pda"]), ask }) as unknown as RunnerSendReadinessSource;
    const t = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: adapter, agentActivityStore: store, eventBus,
      waitForIdlePollMs: 1, now: () => NOW, runnerSendReadiness } as never);
    return { t, sendText };
  }
  const held = (ageMs: number, subtype = "pda_message_held") => store.recordHookEvent({
    runtime: "pda", sessionName: SEAT, nodeId, hookEvent: "Notification", subtype, occurredAt: new Date(NOW.getTime() - ageMs).toISOString(),
  });
  const display = () => store.getLatestForNode({ sessionName: SEAT, now: NOW });

  it.each([
    ["fresh (inside the 15 s send window)", 0],
    ["3 minutes old (past the send window, inside the store's)", 180_000],
    ["30 minutes old (past the store's freshness window): the refusal must not live on", 30 * 60_000],
  ])("a default send with the runner silent goes in when the held report is %s", async (_label, ageMs) => {
    held(ageMs);
    const { t, sendText } = transport();
    const r = await t.send(SEAT, "hello");
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.reason).not.toBe("target_needs_input");
    expect(sendText).toHaveBeenCalled();
    // Display control: the same hook, read for display, is the hold. Not applicable past the freshness window,
    // where the display itself has aged it to unknown.
    if (ageMs < 5 * 60_000) expect(display()).toMatchObject({ state: "needs_input", reason: "pda_message_held" });
  });

  it.each(["pda_message_held", "pda_agent_missing", "pda_unauthorized"])("every held code is display-only at the gate and at the wake ladder: %s, fresh", async (code) => {
    held(0, code);
    const { t, sendText } = transport();
    const r = await t.send(SEAT, "hello");
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(sendText).toHaveBeenCalled();
    expect(display()).toMatchObject({ state: "needs_input", reason: code }); // control
    const read = makePromptStateReader({ db, getLatestHook: (sessionName) => store.getLatestForNode({ sessionName, now: NOW }) });
    expect(read(SEAT, new Date(NOW.getTime() - 60_000).toISOString())).toBe("unknown");
  });

  it("--dangerously-interact with the runner silent sends exactly as at base: bracketed, not the unbracketed paste the runner's editor would split", async () => {
    held(0);
    const { t, sendText } = transport();
    const r = await t.send(SEAT, "hello\nworld", { dangerouslyInteract: true, reason: "probe" } as never);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const calls = JSON.stringify(sendText.mock.calls.map((c) => c.slice(1)));
    expect(calls).not.toContain('"bracketed":false');
    expect(display()).toMatchObject({ state: "needs_input" }); // control
  });

  it.each([
    ["fresh", 0],
    ["30 minutes old", 30 * 60_000],
  ])("the wake ladder does not read a %s held report as an interactive prompt (it stays unknown, as at base)", (_label, ageMs) => {
    held(ageMs);
    const read = makePromptStateReader({ db, getLatestHook: (sessionName) => store.getLatestForNode({ sessionName, now: NOW }) });
    expect(read(SEAT, new Date(NOW.getTime() - ageMs - 60_000).toISOString())).toBe("unknown");
  });

  it("control: a permission_prompt hook on the same seat IS read as a blocking prompt by the same reader", () => {
    store.recordHookEvent({ runtime: "pda", sessionName: SEAT, nodeId, hookEvent: "Notification", subtype: "permission_prompt", occurredAt: NOW.toISOString() });
    const read = makePromptStateReader({ db, getLatestHook: (sessionName) => store.getLatestForNode({ sessionName, now: NOW }) });
    expect(read(SEAT, new Date(NOW.getTime() - 60_000).toISOString())).toBe("blocked");
  });
});
