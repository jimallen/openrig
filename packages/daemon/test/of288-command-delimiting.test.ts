// OF-288: commands in operator text outside the rig up / bundle-install refusals are set off and their names quoted, as OF-287 did
// for those refusals. Most surfaces are asserted in their own suites (see the OF-288 comments there); this file holds the ones that
// are pure functions of a rig name, so the hostile-name table can run through them directly.
import { describe, it, expect } from "vitest";
import { noFreshStartRemedy } from "../src/domain/restore-seat-gates.js";
import { manualReasonMessage } from "../src/routes/compaction.js";
import { shellArgv, setOffCommands, rigWords, closesCleanly } from "./helpers/shell-argv.js";

const HOSTILE = ["workshop", "my rig", "a;b", "$(id)", "it's", "=x", "a b;rm -rf x", "a`b", "a`b'c", "x``y'z"];

/** Every span the text sets off, as setOff writes it: a fence, '...' or `...` (setOffCommands keeps only those that begin "rig "). */
const setOffSpans = (text: string) => [...text.matchAll(/(``+) (.+?) \1(?!`)|'([^']*)'|`([^`]*)`/g)].map((m) => m[2] ?? m[3] ?? m[4]!);

describe("noFreshStartRemedy: the resume-token pipeline and the rig up command are set off (OF-288)", () => {
  it("a plain name: the exact text", () => {
    expect(noFreshStartRemedy("pda", "dev.impl", "workshop")).toBe(
      "A pda seat has no fresh start (pda owns the conversation). To resume it, record the agent its spec binds as its resume token, "
      + "`printf '%s' 'http://127.0.0.1:<port>/agents/<agent>' | rig seat set-resume-token 'dev.impl@workshop' --token-stdin --reason \"<why>\"`, "
      + "then run 'rig up workshop --existing'. To drive another agent, re-instantiate the seat.",
    );
  });

  it.each(HOSTILE)("a rig named %j: rig up pastes as its own words, the pipeline sets the token of exactly this seat", (name) => {
    const text = noFreshStartRemedy("pda", "dev.impl", name);
    expect(setOffCommands(text).map(rigWords)).toEqual([["up", name, "--existing"]]);
    expect(closesCleanly(text, setOffCommands(text)[0]!)).toBe(true);
    const pipeline = setOffSpans(text).find((span) => span.startsWith("printf "))!;
    expect(closesCleanly(text, pipeline)).toBe(true);
    const [producer, consumer] = pipeline.split(" | rig ");
    expect(shellArgv(producer!.slice("printf ".length))).toEqual(["%s", "http://127.0.0.1:<port>/agents/<agent>"]);
    expect(shellArgv(consumer!)).toEqual(["seat", "set-resume-token", `dev.impl@${name}`, "--token-stdin", "--reason", "<why>"]);
  });
});

describe("compaction refusals: every command is set off and names its seat as one word (OF-288 review F2)", () => {
  const seats = ["dev@rig", "my seat@rig", "it's@rig", "$(id)@rig", "a`b'c@rig"];
  it.each(seats)("preparation_incomplete for %j: rig compact --state pastes as its own words", (seat) => {
    const text = manualReasonMessage(seat, "preparation_incomplete");
    const from = text.slice(text.indexOf("Inspect"));
    expect(setOffCommands(from).map(rigWords)).toEqual([["compact", seat, "--state"]]);
    expect(closesCleanly(from, setOffCommands(from)[0]!)).toBe(true);
  });
  it.each(seats)("occupant_generation_unavailable for %j: reconcile-session and compact paste as their own words", (seat) => {
    const text = manualReasonMessage(seat, "occupant_generation_unavailable");
    const from = text.slice(text.indexOf("For the confirmed"));
    expect(setOffCommands(from).map(rigWords)).toEqual([["reconcile-session", seat, "--no-launch"], ["compact", seat]]);
    for (const c of setOffCommands(from)) expect(closesCleanly(from, c)).toBe(true);
  });
});
