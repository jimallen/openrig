// OF-44: `rig start`'s picker label for a rig whose plan lists a seat removed since the snapshot (restoreStatus failed).
// Restore goes on without that seat and reports it failed, so it must not turn "[ready to resume]" into
// "[will ask before fresh]" (the plan now lists removed seats; at base it did not).
import { describe, expect, it } from "vitest";
import { summarizeReadiness, type StartCandidate } from "../src/commands/start.js";

function candidate(nodes: Array<Record<string, unknown>>): StartCandidate {
  return {
    rigId: "r1", rigName: "r", lifecycleState: "stopped", nodeCount: nodes.length, lastActivity: null,
    preview: { status: "plan", mode: "restore", rigId: "r1", rigName: "r", snapshot: null, wouldCaptureCurrentState: false, mutated: false, nodes: nodes as never },
  };
}

describe("rig start readiness label", () => {
  it("a removed (failed) seat beside resumable seats still reads ready to resume", () => {
    expect(summarizeReadiness(candidate([
      { logicalId: "a", intendedAction: "resume-original" },
      { logicalId: "gone", intendedAction: "awaiting-decision", restoreStatus: "failed" },
    ]))).toBe("[ready to resume]");
  });
  it("control: a seat that needs a decision still reads will ask before fresh", () => {
    expect(summarizeReadiness(candidate([
      { logicalId: "a", intendedAction: "resume-original" },
      { logicalId: "b", intendedAction: "awaiting-decision", restoreStatus: "awaiting-decision" },
    ]))).toBe("[will ask before fresh]");
  });
  it("control: no restoreStatus (older daemon) still reads will ask before fresh", () => {
    expect(summarizeReadiness(candidate([
      { logicalId: "a", intendedAction: "resume-original" },
      { logicalId: "b", intendedAction: "awaiting-decision" },
    ]))).toBe("[will ask before fresh]");
  });
});
