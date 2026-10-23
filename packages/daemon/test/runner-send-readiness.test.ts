// pda L0 (pda-runtime-design-9l Rev 2 D7/A3; review nits D1 and A3): the runner send-readiness seam in
// SessionTransport. A runner-hosted seat's readiness comes from its runner (RuntimeAdapter.sendReadiness,
// wired as the `runnerSendReadiness` dep), consulted before any hook or pane heuristic, and believed only
// while the pane's foreground is not a shell. No runtime answers in production until L2a wires the dep, so
// these rows drive the seam with a fake dep.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport, classifyPaneActivity } from "../src/domain/session-transport.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { AgentActivity } from "../src/domain/types.js";
import { createFullTestDb } from "./helpers/test-app.js";

const SEAT = "dev-pda@my-rig";
// The review's frame F1, verbatim from its probe: a runner pane whose last reply ends in a question. The
// pane classifier reads it as a permission prompt (pinned below as the control), which is why the runner
// must decide.
const F1_FRAME = [
  "you ▸ plan the migration", "I have drafted the plan in PLAN.md.", "Do you want to proceed with the migration?",
  "── idle ── tokens in/out/cache +812/+144/+0",
].join("\n");

function runnerAnswer(state: AgentActivity["state"], reason: string): AgentActivity {
  return { state, reason, evidenceSource: "runtime_hook", sampledAt: "2026-10-23T12:00:00.000Z", evidence: null };
}

describe("pda L0: runner send readiness at the SessionTransport seam", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let agentActivityStore: AgentActivityStore;
  let rigId: string;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    agentActivityStore = new AgentActivityStore({ db, eventBus });
    rigId = rigRepo.createRig("my-rig").id;
    seat(SEAT, "dev.pda", "pda");
  });
  afterEach(() => db.close());

  function seat(name: string, logicalId: string, runtime: string) {
    const node = rigRepo.addNode(rigId, logicalId, { role: "worker", runtime });
    const session = sessionRegistry.registerSession(node.id, name);
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: name });
  }

  function tmux(opts: { paneCommand: () => string | null; pane?: string }) {
    const sendText = vi.fn(async () => ({ ok: true as const }));
    const sendKeys = vi.fn(async () => ({ ok: true as const }));
    const adapter = {
      hasSession: async () => true,
      probeSession: async () => ({ state: "present" as const }),
      sendText, sendKeys,
      capturePaneContent: async () => opts.pane ?? F1_FRAME,
      createSession: async () => ({ ok: true as const }),
      killSession: async () => ({ ok: true as const }),
      listSessions: async () => [], listWindows: async () => [], listPanes: async () => [],
      startPipePane: async () => ({ ok: true as const }), stopPipePane: async () => ({ ok: true as const }),
      getPanePid: async () => null,
      getPaneCommand: async () => opts.paneCommand(),
    } as unknown as TmuxAdapter;
    return { adapter, sendText, sendKeys };
  }

  function transport(adapter: TmuxAdapter, runnerSendReadiness?: (t: { sessionName: string; runtime: string; nodeId: string | null }) => Promise<AgentActivity | null>) {
    return new SessionTransport({
      db, rigRepo, sessionRegistry, tmuxAdapter: adapter, agentActivityStore, eventBus,
      waitForIdlePollMs: 1,
      ...(runnerSendReadiness ? { runnerSendReadiness } : {}),
    });
  }

  it("control: the F1 frame is positive needs-input evidence to the pane classifier", () => {
    expect(classifyPaneActivity(F1_FRAME)).toMatchObject({ state: "attention", reason: "permission_prompt" });
  });

  it("A3: an idle, alive runner decides a default send; the F1 frame on screen does not refuse it", async () => {
    const t = tmux({ paneCommand: () => "node" });
    const r = await transport(t.adapter, async ({ runtime }) => runtime === "pda" ? runnerAnswer("idle", "runner_idle") : null)
      .send(SEAT, "hello");
    expect(r.ok).toBe(true);
    expect(r.reason).toBeUndefined();
    expect(t.sendText).toHaveBeenCalledTimes(1);
  });

  it("A3: --wait-for-idle returns on the runner's idle at once, with no hook at all", async () => {
    const t = tmux({ paneCommand: () => "node" });
    const r = await transport(t.adapter, async () => runnerAnswer("idle", "runner_idle")).send(SEAT, "hello", { waitForIdleMs: 2_000 });
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(1);
    expect(r.activity?.evidenceSource).toBe("runner_sidecar");
    expect(t.sendText).toHaveBeenCalledTimes(1);
  });

  it("control: with no runner answer (null) the same seat keeps today's pane verdict and refuses", async () => {
    const t = tmux({ paneCommand: () => "node" });
    const r = await transport(t.adapter, async () => null).send(SEAT, "hello");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("target_needs_input");
    expect(r.activity?.evidenceSource).toBe("pane_heuristic");
    expect(t.sendText).not.toHaveBeenCalled();
  });

  // Review D1. The runner is SIGKILLed during a --wait-for-idle send: no `exited` record is written and its
  // sidecar still reads alive and idle, but the pane is back at zsh. The shell refusal ran once, before the
  // wait, when the runner (node) was still the foreground. 0 bytes may reach the shell.
  it("D1: a runner killed mid --wait-for-idle cannot make the send paste into zsh", async () => {
    let killed = false;
    let calls = 0;
    const t = tmux({ paneCommand: () => killed ? "zsh" : "node", pane: "$ " });
    const dep = async (): Promise<AgentActivity | null> => {
      calls += 1;
      if (calls === 1) { killed = true; return runnerAnswer("running", "run_active"); }
      return runnerAnswer("idle", "runner_idle"); // the dead runner's sidecar, still inside its alive window
    };
    const r = await transport(t.adapter, dep).send(SEAT, "rm -rf ./build", { waitForIdleMs: 300 });
    expect(calls).toBeGreaterThan(1);
    expect(r.ok).toBe(false);
    expect(r.sent).toBe(false);
    expect(r.reason).toBe("target_activity_unknown");
    expect(r.activity).toMatchObject({ state: "unknown", reason: "runner_not_foreground", evidenceSource: "runner_sidecar" });
    expect(t.sendText).not.toHaveBeenCalled();
    expect(t.sendKeys).not.toHaveBeenCalled();
  });

  it("D1 control: the same sequence with the runner still in the foreground sends once it is idle", async () => {
    let calls = 0;
    const t = tmux({ paneCommand: () => "node", pane: "$ " });
    const dep = async (): Promise<AgentActivity | null> => {
      calls += 1;
      return calls === 1 ? runnerAnswer("running", "run_active") : runnerAnswer("idle", "runner_idle");
    };
    const r = await transport(t.adapter, dep).send(SEAT, "hello", { waitForIdleMs: 2_000 });
    expect(r.ok).toBe(true);
    expect(calls).toBe(2);
    expect(t.sendText).toHaveBeenCalledTimes(1);
  });

  it("A3: --dangerously-interact on a runner's needs-input is refused, and the refusal never offers it", async () => {
    const t = tmux({ paneCommand: () => "node" });
    const r = await transport(t.adapter, async () => runnerAnswer("needs_input", "pda_message_held"))
      .send(SEAT, "1", { dangerouslyInteract: true, reason: "drive it" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("runner_input_no_override");
    expect(r.error).toContain("pda_message_held");
    expect(r.error).not.toContain("dangerously-interact");
    expect(t.sendText).not.toHaveBeenCalled();
    expect(t.sendKeys).not.toHaveBeenCalled();
    const overrides = db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'transport.prompt_override'").get() as { n: number };
    expect(overrides.n).toBe(0);
  });

  it("A3: a plain send to a runner's needs-input is refused without suggesting the override", async () => {
    const t = tmux({ paneCommand: () => "node" });
    const r = await transport(t.adapter, async () => runnerAnswer("needs_input", "pda_message_held")).send(SEAT, "hello");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("target_needs_input");
    expect(r.error).toContain("pda_message_held");
    expect(r.error).not.toContain("dangerously-interact");
  });

  it("control: a pane-sourced needs-input still offers the audited override (today's text, unchanged)", async () => {
    const t = tmux({ paneCommand: () => "node" });
    const r = await transport(t.adapter).send(SEAT, "hello");
    expect(r.reason).toBe("target_needs_input");
    expect(r.error).toContain("--dangerously-interact");
  });

  it("the dep is asked with the seat's identity and runtime", async () => {
    const t = tmux({ paneCommand: () => "node" });
    const asked: unknown[] = [];
    await transport(t.adapter, async (target) => { asked.push(target); return runnerAnswer("idle", "runner_idle"); }).send(SEAT, "hello");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ sessionName: SEAT, runtime: "pda" });
  });
});
