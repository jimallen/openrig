// OF-289: the --host value in a command printed for an operator to paste is quoted (shellWord) and the command set off (setOff),
// as OF-288 did for rig names. Each printed command goes through real `sh` (the daemon's test helper), so a paste of it is proved
// to give exactly the intended words and nothing else.
import { describe, it, expect } from "vitest";
import { validatePsLadder } from "../src/commands/ps.js";
import { notAPlanMessage } from "../src/launch-plan-guard.js";
import { setOffCommands, rigWords, closesCleanly } from "../../daemon/test/helpers/shell-argv.js";

const HOSTS = ["vm-1", "my host", "a;b", "$(id)", "it's", "=x", "a b;rm -rf x", "a`b", "a`b'c", "x``y'z"];

/** The set-off commands of one line as rig words (a `<placeholder>` is swapped for a word while sh reads it), each checked to close
 *  cleanly. */
function commandsIn(line: string): string[][] {
  const commands = setOffCommands(line);
  for (const command of commands) expect(closesCleanly(line, command), `${command} closes cleanly in: ${line}`).toBe(true);
  return commands.map((c) => rigWords(c.replace(/<([A-Za-z.-]+)>/g, "PLACEHOLDER_$1")).map((w) => w.replace(/^PLACEHOLDER_(.+)$/, "<$1>")));
}

describe("rig ps --host <id> --nodes with no target: the commands name the host as one word (OF-289)", () => {
  it.each(HOSTS)("--host %j: each command pastes as its words", (host) => {
    const lines = validatePsLadder({ host, nodes: true }, "dev@rig")!.split("\n");
    expect(commandsIn(lines[0]!)).toEqual([["ps", "--host", host, "--nodes"]]);
    expect(commandsIn(lines[2]!)).toEqual([["ps", "--host", host, "--nodes", "--rig", "<name>"], ["ps", "--host", host, "--nodes", "-A"]]);
  });

  it("a plain host: the exact text", () => {
    expect(validatePsLadder({ host: "vm-1", nodes: true }, "dev@rig")).toBe([
      "'rig ps --host vm-1 --nodes' has no target: the local session's rig is not a remote scope",
      "(implicit scope defaults don't cross host boundaries; a same-named remote rig would silently misresolve).",
      "Name one: 'rig ps --host vm-1 --nodes --rig <name>', or the fleet of that host explicitly: 'rig ps --host vm-1 --nodes -A'.",
    ].join("\n"));
  });
});

describe("rig launch --plan, an answer that is not a plan: the rig ps check names the host as one word (OF-289)", () => {
  it.each(HOSTS)("--host %j: the check pastes as its words", (host) => {
    expect(commandsIn(notAPlanMessage(host))).toEqual([["ps", "--host", host, "--nodes", "-A"]]);
  });

  it("no host: the check is set off", () => {
    expect(commandsIn(notAPlanMessage())).toEqual([["ps", "--nodes", "-A"]]);
  });
});
