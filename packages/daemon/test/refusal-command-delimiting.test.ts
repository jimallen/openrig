// OF-287 nits: resolution line delimiting, third surface: the running-rig name collision a bundle install is refused with.
import { describe, it, expect } from "vitest";
import { detectBundleConflicts } from "../src/domain/bundle-conflict-detector.js";
import { setOffCommands, rigWords, closesCleanly } from "./helpers/shell-argv.js";

const conflictFor = (name: string) => detectBundleConflicts({ bundleRigName: name, runningRigs: [{ rigId: "r-1", name }] } as never).conflicts[0]!;

describe("bundle conflict resolutions: commands are delimited (OF-287 nits)", () => {
  it("a plain name: the exact lines, each command set off and followed only by its closing mark", () => {
    expect(conflictFor("workshop").resolutions).toEqual([
      "use the existing team with 'rig ps --rig workshop --nodes'",
      "stop the running rig first with 'rig down workshop', then retry this install to replace the stopped team; the earlier generation is archived",
      "cancel the install and keep the existing team; --target chooses a directory, not a new rig name",
    ]);
  });

  it.each(["my rig", "a;b", "$(id)", "it's", "=x", "a b;rm -rf x", "a`b", "a`b'c", "x``y'z"])("a running rig named %j: each printed command, pasted, is its own words and no second command", (name) => {
    const [use, stop] = conflictFor(name).resolutions;
    expect(setOffCommands(use!).map(rigWords)).toEqual([["ps", "--rig", name, "--nodes"]]);
    expect(setOffCommands(stop!).map(rigWords)).toEqual([["down", name]]);
    for (const [line, command] of [[use!, setOffCommands(use!)[0]!], [stop!, setOffCommands(stop!)[0]!]] as const) expect(closesCleanly(line, command)).toBe(true);
  });
});
