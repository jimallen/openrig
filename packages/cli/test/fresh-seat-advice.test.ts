import { describe, expect, it } from "vitest";
import { freshSeatLaunchCommand } from "../src/fresh-seat-advice.js";
import { shellWords } from "./helpers/advised-command.js";
import { launchAcceptedFreshSeats } from "../src/fresh-seat-accept.js";

// The CLI builder is a hand-kept twin of the daemon's `freshSeatLaunchCommand` (domain/active-occupant.ts); these are the
// same expectations as the daemon's builder row, so drift between the two fails here.
describe("cli freshSeatLaunchCommand", () => {
  it("quotes the seat ref and names the per-seat door", () => {
    expect(freshSeatLaunchCommand("operator.human", "kernel")).toBe(`rig seat launch 'operator.human@kernel' --fresh --reason "<why>"`);
  });

  it("escapes an apostrophe so the printed command still parses back to the exact seat ref", () => {
    const command = freshSeatLaunchCommand("a'b", "r");
    expect(command).toBe(`rig seat launch 'a'"'"'b@r' --fresh --reason "<why>"`);
    expect(shellWords(command)).toEqual(["rig", "seat", "launch", "a'b@r", "--fresh", "--reason", "<why>"]);
  });
});

describe("launchAcceptedFreshSeats", () => {
  it("treats every seat independently, even when the client throws something that is not a daemon error", async () => {
    const calls: string[] = [];
    const client = {
      post: async (path: string) => {
        calls.push(path);
        if (path.includes("b.two")) throw new TypeError("socket hang up");
        return { status: 200, data: { ok: true } } as never;
      },
    };
    const outcomes = await launchAcceptedFreshSeats(client as never, ["a.one", "b.two", "c.three"], "r", "why", 1000);
    expect(calls).toEqual(["/api/seat/launch/a.one%40r", "/api/seat/launch/b.two%40r", "/api/seat/launch/c.three%40r"]);
    expect(outcomes.map((o) => [o.logicalId, o.ok])).toEqual([["a.one", true], ["b.two", false], ["c.three", true]]);
    expect(outcomes[1]!.message).toBe("socket hang up");
  });
});
