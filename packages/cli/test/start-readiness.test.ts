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
  // OF-62 (review B2): a damaged saved row makes restore refuse the whole rig; the damaged seat's own status is `failed`
  // (the removed-seat reading above), so only the rig-level restoreRefusal tells the picker the rig is not ready.
  it("a rig-level restoreRefusal reads restore refused, though every other seat is resumable and the damaged seat is `failed`", () => {
    const c = candidate([
      { logicalId: "a", intendedAction: "resume-original" },
      { logicalId: "b", intendedAction: "resume-original" },
      { logicalId: "damaged", intendedAction: "awaiting-decision", restoreStatus: "failed" },
    ]);
    c.preview!.restoreRefusal = { reason: "restore would refuse the whole rig", seats: ["damaged"] };
    expect(summarizeReadiness(c)).toBe("[restore refused]");
    // Control: the same plan without the rig-level field is the removed-seat reading.
    delete c.preview!.restoreRefusal;
    expect(summarizeReadiness(c)).toBe("[ready to resume]");
  });
  // z6 review F4: a rig whose every seat would be reattached (adopted sessions rig down left running) starts and resumes nothing.
  it("every restored seat reattached reads ready to reattach; a removed seat beside them does not change that", () => {
    expect(summarizeReadiness(candidate([
      { logicalId: "a", intendedAction: "resume-original", reattach: { sessionId: "s1", sessionName: "a@r" } },
      { logicalId: "gone", intendedAction: "awaiting-decision", restoreStatus: "failed" },
    ]))).toBe("[ready to reattach]");
  });
  it("control: a reattached seat beside a resumed one reads ready to resume", () => {
    expect(summarizeReadiness(candidate([
      { logicalId: "a", intendedAction: "resume-original", reattach: { sessionId: "s1", sessionName: "a@r" } },
      { logicalId: "b", intendedAction: "resume-original" },
    ]))).toBe("[ready to resume]");
  });
});
