import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import type { Command } from "commander";
import { createProgram } from "../src/index.js";

// workspaces-o9o.166: the daemon commits a closing write (handoff, handoff-and-complete, update to a terminal state) in one
// transaction, but the seat cannot always tell whether it committed: a timeout or an unreadable reply prints "UNKNOWN", and a
// connection that drops after the request was sent prints "The command was not delivered." for these verbs (only `queue create`
// marks a lost connection as an unknown write outcome). The shipped queue-handoff skill now says what a seat does then: never
// redo the work, re-read the item, retry the closure only while it is still open, and cite the receipt. This pins that section
// and checks every command it names against the real CLI (the keeping-a-watch-doc pattern), so the guidance cannot drift
// onto a flag that does not exist.
const SKILLS = join(dirname(fileURLToPath(import.meta.url)), "../../daemon/assets/plugins/openrig-core/skills");
const HEADING = "## When a closing write's outcome is unknown";

function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(`${heading}\n`);
  if (start < 0) return "";
  const rest = markdown.slice(start + heading.length + 1);
  // Ends at the next heading of the same or a higher level.
  const level = heading.match(/^#+/)![0].length;
  const next = rest.search(new RegExp(`^#{1,${level}} `, "m"));
  return next < 0 ? rest : rest.slice(0, next);
}

function commandsIn(markdown: string): string[] {
  const commands: string[] = [];
  for (const block of markdown.matchAll(/```bash\n([\s\S]*?)```/g)) {
    const joined = block[1]!.replace(/\\\n\s*/g, " ");
    for (const line of joined.split("\n")) if (line.trim().startsWith("rig ")) commands.push(line.trim());
  }
  for (const inline of markdown.matchAll(/`(rig [^`]+)`/g)) commands.push(inline[1]!);
  return commands;
}

function resolve(program: Command, command: string): { sub: Command; options: string[] } {
  const tokens = command.replace(/"[^"]*"/g, "ARG").split(/\s+/).slice(1);
  let sub = program;
  let i = 0;
  for (; i < tokens.length; i++) {
    const next = sub.commands.find((c) => c.name() === tokens[i]);
    if (!next) break;
    sub = next;
  }
  return { sub, options: tokens.slice(i).filter((t) => t.startsWith("-")) };
}

describe("o9o.166: the queue-handoff skill says what to do when a closing write's outcome is unknown", () => {
  const skill = readFileSync(join(SKILLS, "queue-handoff/SKILL.md"), "utf8");
  const body = section(skill, HEADING);
  const program = createProgram();

  it("has the section", () => {
    expect(body.length, `missing "${HEADING}"`).toBeGreaterThan(0);
  });

  it("covers every closing verb, the misleading message, the re-read, the no-redo rule and the refused retry", () => {
    for (const needed of [
      "`rig queue handoff`",
      "`rig queue handoff-and-complete`",
      "`rig queue update`",
      "The command was not delivered.\" is not proof",
      "rig queue show",
      "Never redo the work",
      "qitem_already_terminal",
    ]) expect(body, needed).toContain(needed);
  });

  it("says where the receipt lands on each verb (--evidence-ref is the NEW item's on a handoff)", () => {
    expect(body).toMatch(/--evidence-ref[^\n]*new item/);
    expect(body).toMatch(/--note/);
  });

  it("names at least the commands the recovery relies on", () => {
    const names = commandsIn(body).map((c) => resolve(program, c).sub.name());
    for (const needed of ["show", "update", "handoff-and-complete", "status"]) expect(names).toContain(needed);
  });

  it.each(commandsIn(body))("%s resolves to a real subcommand with declared options", (command) => {
    const { sub, options } = resolve(program, command);
    expect(sub, command).not.toBe(program);
    expect(sub.commands.length, `${command} stops at a command group`).toBe(0);
    const declared = new Set(sub.options.flatMap((o) => [o.long, o.short].filter(Boolean)));
    for (const option of options) expect(declared, `${command}: ${option}`).toContain(option.split("=")[0]);
  });

  it("the openrig-user verb reference points at it from the handoff entry", () => {
    const user = readFileSync(join(SKILLS, "openrig-user/SKILL.md"), "utf8");
    const entry = section(user, "### `rig queue handoff <qitem-id> --to <next> ...` — hot-potato handoff");
    expect(entry).toContain("queue-handoff");
    expect(entry).toContain("When a closing write's outcome is unknown");
    // ...and the heading it names exists in queue-handoff, so the pointer cannot dangle.
    expect(skill).toContain(`${HEADING}\n`);
  });
});
