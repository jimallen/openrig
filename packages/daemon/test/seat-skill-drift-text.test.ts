// workspaces-o9o.30: the pure drift compare and the exact operator-facing text, including the fix command as the CLI
// spells it (`rig seat launch <seat> --fresh`, the spec being the default source; `--stop`, because the seat is live).
import { describe, expect, it } from "vitest";
import { compareSeatSkillSelection, seatSkillDriftFix, seatSkillDriftUncheckedWarning, seatSkillDriftWarning, skillsDriftEventAfterLaunch } from "../src/domain/seat-skill-drift.js";

describe("workspaces-o9o.30: seat skill drift", () => {
  it("compares the recorded and planned selections as sets, sorted, and is null when they hold the same skills", () => {
    expect(compareSeatSkillSelection({ recorded: ["gamma", "alpha"], planned: ["beta", "alpha"] })).toEqual({ extra: ["gamma"], missing: ["beta"] });
    expect(compareSeatSkillSelection({ recorded: ["b", "a"], planned: ["a", "b"] })).toBeNull();
    expect(compareSeatSkillSelection({ recorded: [], planned: [] })).toBeNull();
    expect(compareSeatSkillSelection({ recorded: ["z", "y"], planned: [] })).toEqual({ extra: ["y", "z"], missing: [] });
    expect(compareSeatSkillSelection({ recorded: [], planned: ["q"] })).toEqual({ extra: [], missing: ["q"] });
  });

  it("names the fix exactly as the CLI spells it, quoting the seat", () => {
    expect(seatSkillDriftFix("dev.impl", "team")).toBe(`rig seat launch 'dev.impl@team' --fresh --stop --reason "<why>"`);
    expect(seatSkillDriftFix("dev.impl", "o'hare")).toBe(`rig seat launch 'dev.impl@o'"'"'hare' --fresh --stop --reason "<why>"`);
  });

  it("the drift warning, exact", () => {
    const fix = seatSkillDriftFix("dev.impl", "team");
    expect(seatSkillDriftWarning({ extra: ["gamma"], missing: ["beta"], specSource: "/lib/team/rig.yaml", replayed: { kind: "stored" }, fix })).toBe(
      "skills_drift: this launch replayed the startup files saved at its last successful launch, which never update a seat's skills, "
      + "so its skills differ from its spec /lib/team/rig.yaml (no longer in the spec: gamma; in the spec but not projected: beta). "
      + `To bring them in line with the spec, run: rig seat launch 'dev.impl@team' --fresh --stop --reason "<why>"`);
    expect(seatSkillDriftWarning({ extra: [], missing: ["beta", "delta"], specSource: "/s", replayed: { kind: "snapshot", snapshotId: "S1" }, fix })).toBe(
      "skills_drift: this launch replayed snapshot S1's copy of its startup files, which never update a seat's skills, "
      + "so its skills differ from its spec /s (in the spec but not projected: beta, delta). "
      + `To bring them in line with the spec, run: rig seat launch 'dev.impl@team' --fresh --stop --reason "<why>"`);
  });

  it("the unchecked warning, exact", () => {
    expect(seatSkillDriftUncheckedWarning({ kind: "stored" }, "boom")).toBe(
      "skills_drift_unchecked: this launch replayed the startup files saved at its last successful launch, which never update a seat's skills, "
      + "and its skills were not compared with its spec, which could not be read: boom");
  });

  it("records a drift always, an in-line launch only while a drift is shown, and nothing when nothing was compared", () => {
    const seat = { rigId: "R", nodeId: "N", logicalId: "dev.impl", sessionName: "dev-impl@team" };
    const observation = { extra: ["g"], missing: [], specSource: "/s", replayed: { kind: "snapshot" as const, snapshotId: "S1" }, fix: "F" };
    expect(skillsDriftEventAfterLaunch(seat, { kind: "drift", observation }, false)).toEqual({
      type: "seat.skills_drift_observed", ...seat, specSource: "/s", startupSource: "snapshot", snapshotId: "S1", extra: ["g"], missing: [], fix: "F",
    });
    const inLine = { kind: "in_line" as const, specSource: "/s", startupSource: "spec" as const };
    expect(skillsDriftEventAfterLaunch(seat, inLine, false)).toBeNull();
    expect(skillsDriftEventAfterLaunch(seat, inLine, true)).toEqual({
      type: "seat.skills_drift_observed", ...seat, specSource: "/s", startupSource: "spec", extra: [], missing: [],
    });
    expect(skillsDriftEventAfterLaunch(seat, { kind: "unknown" }, true)).toBeNull();
  });
});
