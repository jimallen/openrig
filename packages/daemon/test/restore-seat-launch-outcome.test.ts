// OF-44 N2: decideSeatLaunchOutcome is a public seam of the gate module. Its contract for a seat listed with --fresh was
// unreachable from every current caller (the plan checks the listing itself, `rig launch` advice never lists), so no
// caller-level test could pin it. These rows call it directly.
import { describe, expect, it } from "vitest";
import { decideSeatLaunchOutcome } from "../src/domain/restore-seat-gates.js";
import type { SnapshotData } from "../src/domain/types.js";

function data(session: Record<string, unknown>): SnapshotData {
  return { sessions: [{ id: "s1", nodeId: "n1", status: "running", ...session }], activeSessionIdByNode: { n1: "s1" }, nodes: [], checkpoints: {} } as unknown as SnapshotData;
}
const input = (d: SnapshotData, freshRequested: boolean) =>
  ({ data: d, snapshotNodeId: "n1", logicalId: "dev.impl", live: { runtime: "claude-code" }, freshRequested, rigName: "team", continuityStatus: null });
const RESUMABLE = { restorePolicy: "resume_if_possible", resumeType: "claude_id", resumeToken: "tok" };

describe("decideSeatLaunchOutcome", () => {
  it("a resumable seat resumes", () => {
    expect(decideSeatLaunchOutcome(input(data(RESUMABLE), false))).toEqual({ kind: "resume" });
  });
  it("the same seat listed with --fresh starts fresh and says why", () => {
    expect(decideSeatLaunchOutcome(input(data(RESUMABLE), true))).toEqual({ kind: "fresh", why: "is listed with --fresh" });
  });
  it("a listed seat with no token is not stopped (--fresh is the way out of the no-token gate)", () => {
    expect(decideSeatLaunchOutcome(input(data({ ...RESUMABLE, resumeToken: null }), true))).toEqual({ kind: "fresh", why: "is listed with --fresh" });
  });
  it("a seat whose restore policy is not resume_if_possible says the policy, listed or not", () => {
    for (const listed of [false, true]) {
      expect(decideSeatLaunchOutcome(input(data({ ...RESUMABLE, restorePolicy: "relaunch_fresh" }), listed)))
        .toEqual({ kind: "fresh", why: "saves this seat with restore policy 'relaunch_fresh'" });
    }
  });
});
