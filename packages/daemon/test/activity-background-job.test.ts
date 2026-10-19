// OF-34 — a seat whose turn ended while background work keeps running (a Claude background shell or
// monitor, a Codex background terminal) posts an `idle` Stop hook and used to read idle in `rig ps`.
// The structural service now records the pane's own job counter, and the ACTIVITY ladder lets a
// positive idle yield to it exactly as it yields to motion. Panes below are the exact strings from the
// 2026-10-19 live report plus the footer chips natively captured on 2026-10-05 (see
// claude-warning-footer-readiness.test.ts). The monitor chip wording has no native capture here: it is
// modelled on the shell chip and flagged as such.

import { describe, it, expect } from "vitest";
import { attachAgentActivity, attachTerminalActivityAndWork } from "../src/domain/node-inventory.js";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
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
// Scrollback copy of a finished turn's status row (carrying the full /ps tail so only the line-start
// anchor, not the tail requirement, keeps it out): history, not a live job.
const CODEX_STALE_WORKING = [
  "◦ Working (9m 26s • esc to interrupt) · 6 background terminals running · /ps to view · /stop to close",
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

  it("Codex: prose that merely says N background terminals running does not count (the /ps tail is required)", () => {
    const quoted = (row: string) => ["• The footer says:", "", `    ${row}`, "", "› Summarize recent commits", "", "  gpt-5.4 xhigh fast · Context [████ ] · ~/work/openrig"].join("\n");
    expect(detectBackgroundJobs(quoted("2 background terminals running"))).toBeNull();
    expect(detectBackgroundJobs(quoted("2 background terminals running · /ps to view"))).toBeNull();
    expect(detectBackgroundJobs(quoted("2 background terminals running · /ps to view · /stop to close"))).toEqual({ count: 2, evidence: "2 background terminals" });
  });

  it("the live footers captured on eztrack seats: chip present vs the no-job footer", () => {
    expect(detectBackgroundJobs(claudePane({ footer: "⏵⏵ bypass permissions on · 1 shell" }))).toEqual({ count: 1, evidence: "1 shell" });
    expect(detectBackgroundJobs(claudePane({ footer: "⏵⏵ bypass permissions on (shift+tab to cycle)" }))).toBeNull();
  });

  it("the chip must be a whole footer segment: text that merely contains one is not a counter", () => {
    expect(detectBackgroundJobs(claudePane({ footer: "⏵⏵ bypass permissions on · 3 shells queued" }))).toBeNull();
    expect(detectBackgroundJobs(claudePane({ footer: "⏵⏵ bypass permissions on · ran 3 shells" }))).toBeNull();
  });

  // Live footer bytes captured read-only from exec-cos (launched with --remote-control): two leading
  // spaces, the chip, ~165 alignment spaces, then Claude's right-aligned remote-control indicator.
  const COS_FOOTER = `  ⏵⏵ bypass permissions on · 1 shell${" ".repeat(165)}/rc`;
  it.each([
    ["the exact exec-cos live footer (/rc)", COS_FOOTER, { count: 1, evidence: "1 shell" }],
    ["trailing warnings", `  ⏵⏵ bypass permissions on · 1 shell${" ".repeat(40)}⚠ 2 warnings`, { count: 1, evidence: "1 shell" }],
    ["trailing warnings and /rc", `  ⏵⏵ bypass permissions on · 2 shells${" ".repeat(40)}⚠ 2 warnings · /rc`, { count: 2, evidence: "2 shells" }],
    ["a chip in the middle followed by a trailing run", `  ⏵⏵ bypass permissions on · 1 monitor  ← for agents${" ".repeat(30)}/rc`, { count: 1, evidence: "1 monitor" }],
  ])("a right-aligned trailing status does not hide the chip: %s", (_n, footer, expected) => {
    expect(detectBackgroundJobs(claudePane({ footer: footer.trimStart() }))).toEqual(expected);
  });

  it("trailing status does not loosen anything else: no chip, a single space, quoted prose, or a non-whole segment stay null", () => {
    const f = (footer: string) => detectBackgroundJobs(claudePane({ footer }));
    expect(f(`⏵⏵ bypass permissions on (shift+tab to cycle)${" ".repeat(165)}/rc`)).toBeNull();
    expect(f("⏵⏵ bypass permissions on · 1 shell /rc")).toBeNull();
    expect(f(`⏵⏵ bypass permissions on · ran 3 shells${" ".repeat(40)}/rc`)).toBeNull();
    expect(f(`⏵⏵ bypass permissions on · 3 shells queued${" ".repeat(40)}/rc`)).toBeNull();
    expect(f(`⏵⏵ bypass permissions on · 0 shells${" ".repeat(40)}/rc`)).toBeNull();
  });

  it("only the live bottom 12 non-blank lines are read: the footer on line 12 counts, on line 13 it is history", () => {
    const filler = (n: number) => Array.from({ length: n }, (_, i) => `output line ${i}`).join("\n");
    const footerWithChip = "  ⏵⏵ bypass permissions on · 1 shell";
    expect(detectBackgroundJobs(`${footerWithChip}\n${filler(11)}`)).toEqual({ count: 1, evidence: "1 shell" });
    expect(detectBackgroundJobs(`${footerWithChip}\n${filler(12)}`)).toBeNull();
  });

  it("does not change the pane verdict: a seat with a shell is still agent_idle / attention for the send guards", () => {
    expect(classifyPaneActivity(ONE_SHELL)).toMatchObject({ state: "agent_idle", reason: "idle_status_bar" });
    expect(classifyPaneActivity(QUESTION_AND_SHELL)).toMatchObject({ state: "attention", reason: "selection_prompt" });
    expect(detectBackgroundJobs(QUESTION_AND_SHELL)).toEqual({ count: 2, evidence: "2 shells" });
  });
});

// ---- the ACTIVITY ladder, fed by the real structural service over a mutable pane ----
const T0 = Date.parse("2031-03-04T05:06:07.000Z"); // far from wall clock
const REQUEST_SKEW_MS = 2000;
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
        // The REQUEST clock is deliberately 2s past the service clock (and both are far from wall
        // clock): a sampledAt read from the request time instead of the observation is then visible.
        now: new Date(state.clock + REQUEST_SKEW_MS),
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
    // sampledAt is when the pane was OBSERVED, not when the request was served and not wall clock
    expect(a.sampledAt).toBe(new Date(T0).toISOString());
    expect(a.sampledAt).not.toBe(new Date(T0 + REQUEST_SKEW_MS).toISOString());
  });

  it("exec-cos: Stop-hook idle + the live /rc footer -> running / background_job", async () => {
    const h = harness(claudePane({ status: STATUS_ONE, footer: `⏵⏵ bypass permissions on · 1 shell${" ".repeat(165)}/rc` }));
    await h.service.pollSeat("dev-impl@rig");
    expect(await h.derive(hook("idle", "stop"))).toMatchObject({ state: "running", reason: "background_job", evidence: "1 shell" });
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

// ---- F1: the arbitrated `activityState` that `rig ps --nodes`, `rig down` and the TUI render ----
const SESSION = "dev-impl@rig";
const SEAT = "node-1";
function arbitratedHarness(initialPane: string) {
  const state = { pane: initialPane, clock: T0 };
  const seatActivity = new SeatActivityService({
    tmux: { readPaneLastActivity: async () => null },
    defaultWindowSeconds: 3,
    now: () => new Date(state.clock),
  } as never);
  seatActivity.declareRungInventory({ seatNodeId: SEAT, sessionName: SESSION }, {
    adapterId: "claude-code-adapter", runtime: "claude-code",
    rungs: [{ rung: "lifecycle-hooks", lifecycleCoverage: "full", initialTrust: "authoritative" }],
  } as never);
  let seq = 0;
  const report = (activity: string, needsInput?: { count: number; reason: string | null }) =>
    seatActivity.reportEvidence({
      seatNodeId: SEAT, sessionName: SESSION, rung: "lifecycle-hooks", sourceId: "claude-code:hooks",
      seq: ++seq, observedAt: new Date(state.clock).toISOString(), activity, ...(needsInput ? { needsInput } : {}),
    } as never);
  const structural = new SeatStructuralActivityService({ capturePaneContent: async () => state.pane }, () => new Date(state.clock));
  const entry = { rigId: "r", rigName: "rig", logicalId: "dev.impl", canonicalSessionName: SESSION, runtime: "claude-code", attachmentType: "tmux", nodeKind: "agent", sessionStatus: "running", startupStatus: "ready", lifecycleState: "running" };
  // Both enrichers exactly as the routes compose them.
  const enrich = async (hookRow: AgentActivity | null) => {
    const withA = (await attachAgentActivity([entry] as never, {
      tmuxAdapter: { hasSession: async () => true, getPaneCommand: async () => "claude", capturePaneContent: async () => { throw new Error("capture-free"); } } as never,
      activityStore: { getLatestForNode: () => hookRow } as never,
      structuralActivity: structural,
      now: new Date(state.clock),
    } as never)) as never;
    const db = { prepare: () => ({ all: () => [] }) } as never;
    return attachTerminalActivityAndWork(withA, { db, seatActivity, structuralActivity: structural } as never)[0] as unknown as {
      agentActivity: AgentActivity;
      activityState: { activity: string; display: string; decidedBy: string | null; needsInput: { count: number } } | null;
    };
  };
  return { state, seatActivity, structural, report, enrich };
}

describe("OF-34 F1: activityState (rig ps ACTIVITY, rig down, TUI) agrees with agentActivity", () => {
  it("Stop-hook idle + 1 shell: BOTH projections say running/working", async () => {
    const h = arbitratedHarness(ONE_SHELL);
    h.report("idle-at-prompt");
    await h.structural.pollSeat(SESSION);
    const e = await h.enrich(hook("idle", "stop"));
    expect(e.agentActivity).toMatchObject({ state: "running", reason: "background_job" });
    expect(e.activityState).toMatchObject({ activity: "working", display: "working", decidedBy: "background-job" });
  });

  it("no job: both stay idle", async () => {
    const h = arbitratedHarness(NO_JOB);
    h.report("idle-at-prompt");
    await h.structural.pollSeat(SESSION);
    const e = await h.enrich(hook("idle", "stop"));
    expect(e.agentActivity.state).toBe("idle");
    expect(e.activityState).toMatchObject({ activity: "idle-at-prompt", display: "idle" });
    expect(e.activityState?.decidedBy).not.toBe("background-job");
  });

  it("a running arbitrated state is untouched", async () => {
    const h = arbitratedHarness(ONE_SHELL);
    h.report("working");
    await h.structural.pollSeat(SESSION);
    const e = await h.enrich(hook("running", "pre_tool_use"));
    expect(e.activityState).toMatchObject({ activity: "working", display: "working" });
    expect(e.activityState?.decidedBy).not.toBe("background-job");
  });

  it("needs_input wins: a positive needs-input count keeps display needs-input even with a shell chip", async () => {
    const h = arbitratedHarness(ONE_SHELL);
    h.report("idle-at-prompt", { count: 1, reason: "permission prompt" });
    await h.structural.pollSeat(SESSION);
    const e = await h.enrich(hook("needs_input", "permission_request"));
    expect(e.activityState).toMatchObject({ display: "needs-input", needsInput: { count: 1 } });
    expect(e.activityState?.decidedBy).not.toBe("background-job");
  });

  it("a question on the pane (structural attention) is not lifted in either projection", async () => {
    const h = arbitratedHarness(QUESTION_AND_SHELL);
    h.report("idle-at-prompt");
    await h.structural.pollSeat(SESSION);
    const e = await h.enrich(hook("idle", "stop"));
    expect(e.agentActivity.state).not.toBe("running");
    expect(e.activityState).toMatchObject({ activity: "idle-at-prompt", display: "idle" });
  });

  it("expiry: the chip leaving the pane returns activityState to idle on the next tick, and a stalled poller ages out", async () => {
    const h = arbitratedHarness(ONE_SHELL);
    h.report("idle-at-prompt");
    await h.structural.pollSeat(SESSION);
    expect((await h.enrich(hook("idle", "stop"))).activityState?.display).toBe("working");
    h.state.clock += 1000;
    h.state.pane = NO_JOB;
    await h.structural.pollSeat(SESSION);
    expect((await h.enrich(hook("idle", "stop"))).activityState?.display).toBe("idle");
    h.state.pane = ONE_SHELL;
    await h.structural.pollSeat(SESSION);
    h.state.clock += 60_000; // poller stalled (the arbitrated hook evidence also ages to unknown by now)
    expect((await h.enrich(hook("idle", "stop"))).activityState?.display).not.toBe("working");
  });

  it("the line is drawn at the DISPLAY projection: SeatActivityService still arbitrates idle-at-prompt, so the idle-gate watchdog and execution view are unaffected", async () => {
    const h = arbitratedHarness(ONE_SHELL);
    h.report("idle-at-prompt");
    await h.structural.pollSeat(SESSION);
    await h.enrich(hook("idle", "stop"));
    expect(h.seatActivity.getSeatStateBySession(SESSION)).toMatchObject({ activity: "idle-at-prompt" });
  });
});

// ---- node detail: hook-less detail keeps its live probe; only the background-job lift reads the cache ----
describe("OF-34 node detail: backgroundJobActivity", () => {
  const detailEntries = [{ canonicalSessionName: SESSION, runtime: "claude-code", attachmentType: "tmux", logicalId: "dev.impl" }] as never;
  const probeTmux = (pane: string, counter: { captures: number }) => ({
    hasSession: async () => true,
    getPaneCommand: async () => "claude",
    capturePaneContent: async () => { counter.captures++; return pane; },
  }) as never;

  it("Stop-hook idle on the detail path lifts through backgroundJobActivity without structuralActivity", async () => {
    const h = harness(ONE_SHELL);
    await h.service.pollSeat(SESSION);
    const out = (await attachAgentActivity(detailEntries, {
      tmuxAdapter: probeTmux(NO_JOB, { captures: 0 }),
      activityStore: { getLatestForNode: () => hook("idle", "stop") } as never,
      backgroundJobActivity: h.service,
      captureFallback: true,
      now: new Date(T0),
    } as never)) as Array<{ agentActivity: AgentActivity }>;
    expect(out[0]!.agentActivity).toMatchObject({ state: "running", reason: "background_job", evidence: "1 shell" });
  });

  it("hook-less detail still reads the LIVE probe, not the cache (the cache is consulted for the lift only)", async () => {
    const h = harness(ONE_SHELL); // cache says: shell running, idle prompt
    await h.service.pollSeat(SESSION);
    const counter = { captures: 0 };
    const livePane = ["Which region?", "❯ 1. us-east-1", "  2. eu-west-1", "Enter to select · ↑/↓ to navigate · Esc to cancel"].join("\n");
    const out = (await attachAgentActivity(detailEntries, {
      tmuxAdapter: probeTmux(livePane, counter),
      activityStore: { getLatestForNode: () => null } as never,
      backgroundJobActivity: h.service,
      captureFallback: true,
      now: new Date(T0),
    } as never)) as Array<{ agentActivity: AgentActivity }>;
    expect(counter.captures).toBe(1);
    expect(out[0]!.agentActivity.state).toBe("needs_input"); // the live attention, not the cached idle+shell
  });

  it("hook-less detail whose live probe reads idle and whose cache shows a shell lifts too", async () => {
    const h = harness(ONE_SHELL);
    await h.service.pollSeat(SESSION);
    const out = (await attachAgentActivity(detailEntries, {
      tmuxAdapter: probeTmux(ONE_SHELL, { captures: 0 }),
      activityStore: { getLatestForNode: () => null } as never,
      backgroundJobActivity: h.service,
      captureFallback: true,
      now: new Date(T0),
    } as never)) as Array<{ agentActivity: AgentActivity }>;
    expect(out[0]!.agentActivity).toMatchObject({ state: "running", reason: "background_job" });
  });
});
