// OF-34 — the web UI must keep a lifted `background_job` verdict above "terminal quiet".
//
// A seat whose turn ended while a shell/monitor runs gets, from /api/rigs/:id/nodes and /graph:
//   agentActivity = { state: "running", reason: "background_job", evidenceSource: "pane_heuristic", ... }
// (the exact key set is pinned on the daemon side in activity-background-job-routes.test.ts), and a
// waiting shell prints nothing, so the motion poller reports terminalActive === false. Before this
// change the UI ranked `terminalActive === false` above any pane_heuristic verdict and drew the seat idle.

import { describe, it, expect } from "vitest";
import {
  getActivityState,
  getActivityStateWithSource,
  computeActivityRollup,
  isBackgroundJobRunning,
} from "../src/lib/activity-visuals.js";
import { getBaselineActivityState } from "../src/lib/topology-activity.js";
import type { AgentActivitySummary } from "../src/hooks/useNodeInventory.js";

// Real route JSON shape for a Stop-hook seat with `· 1 shell` (daemon output, 2031-dated like the daemon rows).
const lifted: AgentActivitySummary = {
  state: "running",
  reason: "background_job",
  evidenceSource: "pane_heuristic",
  sampledAt: "2031-03-04T05:06:07.000Z",
  evidence: "1 shell",
  runtime: "claude-code",
} as AgentActivitySummary;

const verified = { verdict: "verified" } as never;

describe("OF-34 UI: getActivityStateWithSource keeps background_job above a quiet terminal", () => {
  it("terminalActive === false (the production case: a waiting shell is silent) -> running / pane_heuristic", () => {
    expect(getActivityStateWithSource(lifted, false, verified)).toEqual({ state: "running", source: "pane_heuristic" });
    expect(getActivityState(lifted, false)).toBe("running");
  });

  it("terminalActive true / null / absent: still running", () => {
    expect(getActivityState(lifted, true)).toBe("running");
    expect(getActivityState(lifted, null)).toBe("running");
    expect(getActivityState(lifted)).toBe("running");
  });

  it("ONLY that reason outranks quiet: any other pane_heuristic running verdict still loses to terminalActive === false", () => {
    const motion = { ...lifted, reason: "mid_work_pattern", evidence: "esc to interrupt" };
    expect(getActivityStateWithSource(motion, false)).toEqual({ state: "idle", source: "terminal_activity" });
  });

  it("a stale or fallback background_job verdict is not trusted over the quiet terminal", () => {
    expect(getActivityState({ ...lifted, stale: true }, false)).toBe("idle");
    expect(getActivityState({ ...lifted, fallback: true }, false)).toBe("idle");
  });

  it("a background_job reason from some other evidence source is not trusted either", () => {
    expect(getActivityState({ ...lifted, evidenceSource: "terminal_activity" }, false)).toBe("idle");
  });

  it("needs_input and the identity downrank still win over it", () => {
    expect(getActivityState({ ...lifted, state: "needs_input", evidenceSource: "pane_heuristic" }, false)).toBe("needs_input");
    expect(getActivityState(lifted, false, { verdict: "mismatch" } as never)).toBe("needs_input");
    expect(isBackgroundJobRunning({ ...lifted, state: "idle" })).toBe(false);
  });

  it("the roll-up counts the seat as working", () => {
    expect(computeActivityRollup([{ activity: lifted, terminalActive: false }]).working).toBe(1);
  });
});

describe("OF-34 UI: the topology activity ring agrees", () => {
  it("background_job + terminalActive === false -> active (not idle)", () => {
    expect(getBaselineActivityState({ agentActivity: lifted, terminalActive: false })).toBe("active");
  });

  it("other running verdicts with a quiet terminal stay idle; needs_input and a failed start still win", () => {
    expect(getBaselineActivityState({ agentActivity: { ...lifted, reason: "mid_work_pattern" }, terminalActive: false })).toBe("idle");
    expect(getBaselineActivityState({ agentActivity: { ...lifted, state: "needs_input" }, terminalActive: false })).toBe("needs_input");
    expect(getBaselineActivityState({ agentActivity: lifted, terminalActive: false, startupStatus: "failed" })).toBe("blocked");
  });
});
