// OF-34 — a seat whose turn ended while background work keeps running (a Claude background shell or
// monitor, a Codex background terminal) posts an `idle` Stop hook and used to read idle in `rig ps`.
// The structural service now records the pane's own job counter, and the ACTIVITY ladder lets a
// positive idle yield to it exactly as it yields to motion. Panes below are the exact strings from the
// 2026-10-19 live report plus the footer chips natively captured on 2026-10-05 (see
// claude-warning-footer-readiness.test.ts). The monitor chip wording has no native capture here: it is
// modelled on the shell chip and flagged as such.

import { describe, it, expect } from "vitest";
import { attachAgentActivity } from "../src/domain/node-inventory.js";
import { SeatStructuralActivityService } from "../src/domain/seat-structural-activity-service.js";
import { classifyPaneActivity, detectBackgroundJobs } from "../src/domain/session-transport.js";
import type { AgentActivity } from "../src/domain/types.js";

const RULE = "─".repeat(40);
const STATUS_ONE = "✻ Churned for 9s · done 4:22 PM · 1 shell still running";

function claudePane(opts: { status?: string; composer?: string; footer: string; above?: string[] }): string {
  return [
    ...(opts.above ?? ["● Started the build in the background."]),
    "",
    ...(opts.status ? [opts.status, ""] : []),
    RULE,
    opts.composer ?? "❯ ",
    RULE,
    `  ${opts.footer}`,
  ].join("\n");
}

const ONE_SHELL = claudePane({ status: STATUS_ONE, footer: "⏵⏵ bypass permissions on · 1 shell" });
const TWO_SHELLS = claudePane({
  status: "✻ Churned for 9s · done 4:22 PM · 2 shells still running",
  footer: "⏵⏵ bypass permissions on · 2 shells",
});
const ONE_MONITOR = claudePane({
  status: "✻ Brewed for 12s · done 4:30 PM · 1 monitor still running",
  footer: "⏵⏵ bypass permissions on · 1 monitor · ← for agents",
});
const NO_JOB = claudePane({
  status: "✻ Churned for 9s · done 4:22 PM",
  footer: "⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
});
const QUESTION_AND_SHELL = [
  "☐ Region",
  "Which region should the build target?",
  "❯ 1. us-east-1",
  "  2. eu-west-1",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
  RULE,
  "❯ ",
  RULE,
  "  ? for shortcuts · 2 shells",
].join("\n");
const CODEX_IDLE_TERMINALS = [
  "Lane closed.",
  "",
  "  2 background terminals running · /ps to view · /stop to close",
  "",
  "› Summarize recent commits",
  "",
  "  gpt-5.4 xhigh fast · Context [████ ] · ~/work/openrig",
].join("\n");
// Scrollback copy of a finished turn's status row: history, not a live job.
const CODEX_STALE_WORKING = [
  "◦ Working (9m 26s • esc to interrupt) · 6 background terminals running",
  "",
  "› Use /skills to list available skills",
  "",
  "  gpt-5.5 xhigh fast · Context [█▉   ] · ~/work/openrig",
].join("\n");

describe("OF-34 detectBackgroundJobs (structural, from the pane's own counter)", () => {
  it("the exact live report: 1 shell, status line and footer", () => {
    expect(classifyPaneActivity(ONE_SHELL).state).toBe("agent_idle"); // the turn really is over
    expect(detectBackgroundJobs(ONE_SHELL)).toEqual({ count: 1, evidence: "1 shell" });
  });

  it("plural: 2 shells", () => {
    expect(detectBackgroundJobs(TWO_SHELLS)).toEqual({ count: 2, evidence: "2 shells" });
    expect(detectBackgroundJobs(claudePane({ footer: "? for shortcuts · 2 shells" }))).toEqual({ count: 2, evidence: "2 shells" });
  });

  it("a waiting monitor", () => {
    expect(detectBackgroundJobs(ONE_MONITOR)).toEqual({ count: 1, evidence: "1 monitor" });
    expect(detectBackgroundJobs(claudePane({ footer: "⏵⏵ bypass permissions on · 1 shell, 2 monitors" })))
      .toEqual({ count: 3, evidence: "1 shell, 2 monitors" });
  });

  it("no background job reads null", () => {
    expect(classifyPaneActivity(NO_JOB).state).toBe("agent_idle");
    expect(detectBackgroundJobs(NO_JOB)).toBeNull();
  });

  it("the prose status line alone is scrollback, not a live job (the footer chip is what expires)", () => {
    const afterExit = claudePane({ status: STATUS_ONE, footer: "⏵⏵ bypass permissions on (shift+tab to cycle)" });
    expect(detectBackgroundJobs(afterExit)).toBeNull();
  });

  it("only the live footer counts: an older repaint higher in the capture is ignored", () => {
    const repaint = `${claudePane({ footer: "⏵⏵ bypass permissions on · 3 shells" })}\n${claudePane({ footer: "⏵⏵ bypass permissions on" })}`;
    expect(detectBackgroundJobs(repaint)).toBeNull();
  });

  it("Codex: the idle background-terminal row counts; a Working-row suffix in scrollback does not", () => {
    expect(detectBackgroundJobs(CODEX_IDLE_TERMINALS)).toEqual({ count: 2, evidence: "2 background terminals" });
    expect(classifyPaneActivity(CODEX_STALE_WORKING).state).toBe("agent_idle");
    expect(detectBackgroundJobs(CODEX_STALE_WORKING)).toBeNull();
  });

  it("does not change the pane verdict: a seat with a shell is still agent_idle / attention for the send guards", () => {
    expect(classifyPaneActivity(ONE_SHELL)).toMatchObject({ state: "agent_idle", reason: "idle_status_bar" });
    expect(classifyPaneActivity(QUESTION_AND_SHELL)).toMatchObject({ state: "attention", reason: "selection_prompt" });
    expect(detectBackgroundJobs(QUESTION_AND_SHELL)).toEqual({ count: 2, evidence: "2 shells" });
  });
});

// ---- the ACTIVITY ladder, fed by the real structural service over a mutable pane ----
const T0 = Date.parse("2031-03-04T05:06:07.000Z"); // far from wall clock
function harness(initialPane: string) {
  const state = { pane: initialPane, clock: T0 };
  const service = new SeatStructuralActivityService(
    { capturePaneContent: async () => state.pane },
    () => new Date(state.clock),
  );
  const derive = async (hook: AgentActivity | null) => {
    const out = (await attachAgentActivity(
      [{ canonicalSessionName: "dev-impl@rig", runtime: "claude-code", attachmentType: "tmux", logicalId: "dev.impl" }] as never,
      {
        tmuxAdapter: { hasSession: async () => true, getPaneCommand: async () => "claude", capturePaneContent: async () => { throw new Error("capture-free"); } } as never,
        activityStore: { getLatestForNode: () => hook } as never,
        structuralActivity: service,
        now: new Date(state.clock),
      } as never,
    )) as Array<{ agentActivity: AgentActivity }>;
    return out[0]!.agentActivity;
  };
  return { state, service, derive };
}
const hook = (state: AgentActivity["state"], rawEvent: string): AgentActivity => ({
  state,
  reason: rawEvent,
  evidenceSource: "runtime_hook",
  sampledAt: "2031-03-04T05:06:05.000Z",
  eventAt: "2031-03-04T05:06:05.000Z",
  evidence: null,
  rawEvent,
});

describe("OF-34 ACTIVITY: a positive idle hook yields to a background job", () => {
  it.each([
    ["1 shell", ONE_SHELL, "1 shell"],
    ["2 shells", TWO_SHELLS, "2 shells"],
    ["a monitor", ONE_MONITOR, "1 monitor"],
    ["a Codex background terminal row", CODEX_IDLE_TERMINALS, "2 background terminals"],
  ])("Stop-hook idle + %s -> running / background_job carrying the count", async (_n, pane, evidence) => {
    const h = harness(pane);
    await h.service.pollSeat("dev-impl@rig");
    const a = await h.derive(hook("idle", "stop"));
    expect(a).toMatchObject({ state: "running", reason: "background_job", evidenceSource: "pane_heuristic", evidence });
    expect(a.sampledAt).toBe(new Date(T0).toISOString());
  });

  it("no background job: the idle hook stays idle (the unfixed behaviour is preserved)", async () => {
    const h = harness(NO_JOB);
    await h.service.pollSeat("dev-impl@rig");
    expect(await h.derive(hook("idle", "stop"))).toMatchObject({ state: "idle", reason: "stop" });
  });

  it("running and needs_input hooks stay untouched", async () => {
    const h = harness(ONE_SHELL);
    await h.service.pollSeat("dev-impl@rig");
    expect(await h.derive(hook("running", "pre_tool_use"))).toMatchObject({ state: "running", reason: "pre_tool_use" });
    expect(await h.derive(hook("needs_input", "permission_request"))).toMatchObject({ state: "needs_input", reason: "permission_request" });
  });

  it("needs_input wins: a question on the pane plus a running shell never reads background_job", async () => {
    const h = harness(QUESTION_AND_SHELL);
    await h.service.pollSeat("dev-impl@rig");
    // positive idle hook while the pane asks a person something
    expect((await h.derive(hook("idle", "stop"))).state).not.toBe("running");
    // no hook at all: the structural reading itself
    expect(await h.derive(null)).toMatchObject({ state: "needs_input", reason: "selection_prompt" });
    // needs_input hook
    expect(await h.derive(hook("needs_input", "permission_request"))).toMatchObject({ state: "needs_input" });
  });

  it("hook-less seat: structural idle + job -> running/background_job; without the job -> idle", async () => {
    const h = harness(ONE_SHELL);
    await h.service.pollSeat("dev-impl@rig");
    expect(await h.derive(null)).toMatchObject({ state: "running", reason: "background_job", evidence: "1 shell" });
    h.state.pane = NO_JOB;
    await h.service.pollSeat("dev-impl@rig");
    expect(await h.derive(null)).toMatchObject({ state: "idle", reason: "idle_status_bar" });
  });

  it("expiry: once the shell finishes, the next structural tick returns the seat to idle", async () => {
    const h = harness(ONE_SHELL);
    await h.service.pollSeat("dev-impl@rig");
    expect((await h.derive(hook("idle", "stop"))).reason).toBe("background_job");
    h.state.clock += 1000;
    h.state.pane = claudePane({ status: STATUS_ONE, footer: "⏵⏵ bypass permissions on (shift+tab to cycle)" }); // job gone
    await h.service.pollSeat("dev-impl@rig");
    expect(await h.derive(hook("idle", "stop"))).toMatchObject({ state: "idle", reason: "stop" });
  });

  it("expiry: a stalled poller ages the job out instead of keeping the seat busy", async () => {
    const h = harness(ONE_SHELL);
    await h.service.pollSeat("dev-impl@rig");
    h.state.clock += 60_000; // no further ticks
    expect(await h.derive(hook("idle", "stop"))).toMatchObject({ state: "idle", reason: "stop" });
  });
});
