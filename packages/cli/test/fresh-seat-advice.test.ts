import { describe, expect, it } from "vitest";
import { freshSeatLaunchCommand } from "../src/fresh-seat-advice.js";
import { shellWords } from "./helpers/advised-command.js";
import { launchAcceptedFreshSeats, printFreshSeatNotes } from "../src/fresh-seat-accept.js";

// The CLI builder is a hand-kept twin of the daemon's `freshSeatLaunchCommand` (domain/active-occupant.ts); these are the
// same expectations as the daemon's builder row, so drift between the two fails here.
describe("cli freshSeatLaunchCommand", () => {
  it("quotes the seat ref and names the per-seat door", () => {
    expect(freshSeatLaunchCommand("operator.human", "kernel")).toBe(`rig seat launch 'operator.human@kernel' --fresh --reason "<why>"`);
  });

  // OF-32 stage 3: the restore's stored escape travels into the advice (the daemon's twin has the same row).
  it("carries --startup-from stored when the restore was asked for it, and nothing for spec or no choice", () => {
    expect(freshSeatLaunchCommand("operator.human", "kernel", "stored")).toBe(`rig seat launch 'operator.human@kernel' --fresh --startup-from stored --reason "<why>"`);
    expect(freshSeatLaunchCommand("operator.human", "kernel", "spec")).toBe(`rig seat launch 'operator.human@kernel' --fresh --reason "<why>"`);
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

  // OF-32 (N4): the accept path in rig up / rig start shows the daemon's warning and its refusal guidance.
  it("keeps the daemon's warnings and refusal guidance, and prints them", async () => {
    const replay = "This rig records no spec source (...), so this fresh launch replays the startup files saved at the seat's last successful launch.";
    const guidance = "Restore or fix the spec at that path, or run again with --startup-from stored to replay ...";
    const client = {
      post: async (path: string) => path.includes("a.one")
        ? { status: 200, data: { ok: true, warnings: [replay] } }
        : { status: 409, data: { ok: false, code: "startup_source_unavailable", message: "gone", guidance } },
    };
    const outcomes = await launchAcceptedFreshSeats(client as never, ["a.one", "b.two"], "r", "why", 1000);
    expect(outcomes.map((o) => [o.warnings, o.guidance])).toEqual([[[replay], null], [[], guidance]]);
    const printed: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { printed.push(args.join(" ")); };
    try { for (const o of outcomes) printFreshSeatNotes(o, "  "); } finally { console.error = original; }
    expect(printed).toEqual([`  a.one: warning: ${replay}`, `  b.two: ${guidance}`]);
  });
});
