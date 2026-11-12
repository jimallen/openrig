// OF-287 nits: resolution line delimiting, second surface. The "team already exists" resolutions of a bundle install are printed one per
// line by the CLI (bundleInstallError) and an operator may paste from a command onward, so each command must sit inside quote or backtick
// marks with nothing of the line running with it: no ";" after it, no "." or "," riding on its last argument, and a user-controlled rig
// name or id a single shell word.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { bundleInstallContext } from "../src/domain/bundle-install-context.js";
import { shellArgv } from "./helpers/shell-argv.js";

const OFFERED = { name: "x", version: null, source: "/b.rigbundle" };
/** The commands of a line as it delimits them: every '...' or `...` span that begins with "rig ". Empty when it sets none off. */
const commandsOf = (line: string): string[] =>
  [...line.matchAll(/'([^']*(?:'"'"'[^']*)*)'|`([^`]*)`/g)].map((x) => x[1] ?? x[2]!).filter((c) => c.startsWith("rig "));
const wordsOf = (command: string) => shellArgv(command.slice("rig ".length));

describe("bundle install context resolutions: commands are delimited (OF-287 nits)", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  beforeEach(() => { db = createFullTestDb(); rigRepo = new RigRepository(db); });
  afterEach(() => db.close());
  const runningTeam = (name: string) => {
    const rig = rigRepo.createRig(name);
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd) VALUES (?, ?, 'crew.a', 'terminal', '/tmp')").run(`n-${rig.id}`, rig.id);
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, 'crew-a@r', 'running', '2026-11-10 12:00:00')").run(`s-${rig.id}`, `n-${rig.id}`);
    return rig;
  };
  const resolutionsOf = (name: string) => bundleInstallContext(db, name, OFFERED).resolutions;

  it("a stopped team with a plain name: the exact lines, each command in single quotes and followed only by a comma or a full stop", () => {
    rigRepo.createRig("workshop");
    expect(resolutionsOf("workshop")).toEqual([
      "Use the existing team: look at it with 'rig ps --rig workshop --nodes', then resume it with 'rig up --existing workshop'.",
      "Retry this install to replace the stopped team. The earlier generation is archived; the result gives its rig unarchive command.",
      "Cancel this install and keep the existing team. --target selects a directory; it does not rename a team.",
    ]);
  });

  it("a running team: the exact lines; 'rig down' is set off and the comma after it is not part of it", () => {
    runningTeam("workshop");
    expect(resolutionsOf("workshop")).toEqual([
      "Use the existing team: look at it with 'rig ps --rig workshop --nodes', then send work to its existing seats.",
      "Stop it with 'rig down workshop', then retry this install to replace the stopped team. The earlier generation is archived; the result gives its rig unarchive command.",
      "Cancel this install and keep the existing team. --target selects a directory; it does not rename a team.",
    ]);
  });

  it.each(["my rig", "a;b", "$(id)", "it's", "=x", "a b;rm -rf x"])("a team named %j: every printed command, pasted, is its own words and no second command", (name) => {
    rigRepo.createRig(name);
    const [use] = resolutionsOf(name);
    const commands = commandsOf(use!);
    expect(commands.map(wordsOf)).toEqual([["ps", "--rig", name, "--nodes"], ["up", "--existing", name]]);
  });

  it.each(["my rig", "a;b"])("a running team named %j: 'rig down' pasted is its own words", (name) => {
    runningTeam(name);
    const commands = commandsOf(resolutionsOf(name)[1]!);
    expect(commands.map(wordsOf)).toEqual([["down", name]]);
  });

  it("after a command comes its closing mark and then only a comma or a full stop and a space or the end", () => {
    rigRepo.createRig("workshop");
    runningTeam("busy");
    // 2 commands in the stopped team's use line, 2 in the running team's use and stop lines: a count, so a line that sets nothing off cannot pass by being empty
    const seen: string[] = [];
    for (const name of ["workshop", "busy"]) for (const line of resolutionsOf(name)) for (const command of commandsOf(line)) {
      seen.push(command);
      expect(line.slice(line.indexOf(command) + command.length)).toMatch(/^['`](\.|,)(\s|$)/);
      expect(line.slice(0, line.indexOf(command)).at(-1)).toMatch(/['`]/);
    }
    expect(seen).toEqual(["rig ps --rig workshop --nodes", "rig up --existing workshop", "rig ps --rig busy --nodes", "rig down busy"]);
  });

  it("two teams share the name: the stopped-team lines still delimit their commands", () => {
    rigRepo.createRig("twin");
    rigRepo.createRig("twin");
    const [use, replace] = resolutionsOf("twin");
    expect(commandsOf(use!).map(wordsOf)[0]).toEqual(["ps", "--rig", "twin", "--nodes"]);
    expect(commandsOf(use!)).toHaveLength(2);
    expect(replace).not.toMatch(/rig down/); // stopped: retry only
  });
});
