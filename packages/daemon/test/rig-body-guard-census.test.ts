// OF-249 census: the guard's command table is RE-DERIVED from the CLI source on every run, not trusted as a
// written-down list. A CLI command file that gains a text-carrying option or positional (the places an agent
// puts a message, and so a backtick) and is in neither guard table fails here, until it is added to the guard
// (rig-body-guard.cjs: MESSAGE_COMMANDS / FLAG_COMMANDS) or listed in EXEMPT below with a reason.

import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const commandsDir = join(here, "..", "..", "cli", "src", "commands");
const require = createRequire(import.meta.url);
const guard = require(join(here, "..", "assets", "plugins", "openrig-core", "hooks", "scripts", "rig-body-guard.cjs")) as {
  MESSAGE_COMMANDS: Record<string, unknown>;
  FLAG_COMMANDS: Record<string, string[]>;
};

/** File stems whose text options are not message text, with the reason. */
const EXEMPT: Record<string, string> = {
  config: "rig config set <key> <value>: a configuration value, not message text",
};

const TEXT_PLACEHOLDER = "text|message|body|note|notes|summary|reason|why|detail|decision|title|self-check|intent|continuation|question|answer|citation|blocker|label|heading|value";
const OPTION_RE = new RegExp(`\\.(?:option|requiredOption)\\(\\s*"(?:-[A-Za-z], )?(--[a-z][a-z-]*) <(?:${TEXT_PLACEHOLDER})>`, "g");
const POSITIONAL_RE = new RegExp(`\\.argument\\(\\s*"[\\[<](?:${TEXT_PLACEHOLDER})[\\]>]`, "g");

interface Found { stem: string; options: string[]; positional: boolean; commandNames: string[] }

function census(): Found[] {
  const out: Found[] = [];
  for (const file of readdirSync(commandsDir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).sort()) {
    const src = readFileSync(join(commandsDir, file), "utf8");
    const options = [...new Set([...src.matchAll(OPTION_RE)].map((m) => m[1]!))].sort();
    const positional = POSITIONAL_RE.test(src);
    POSITIONAL_RE.lastIndex = 0;
    if (options.length === 0 && !positional) continue;
    const commandNames = [...new Set([...src.matchAll(/new Command\("([a-z-]+)"\)/g)].map((m) => m[1]!))];
    out.push({ stem: file.replace(/\.ts$/, ""), options, positional, commandNames });
  }
  return out;
}

describe("rig-body-guard census: every CLI file with text-carrying inputs is covered", () => {
  const found = census();
  const guarded = new Set([...Object.keys(guard.MESSAGE_COMMANDS), ...Object.keys(guard.FLAG_COMMANDS)]);
  const isGuarded = (f: Found): boolean => guarded.has(f.stem) || f.commandNames.some((n) => guarded.has(n));

  it("positive control: the census sees the population it is supposed to classify", () => {
    // 18 files with text options + positional-only carriers at the time of writing; a regex that matched nothing would also pass an
    // 'every member is covered' assertion, so the size of the population is pinned from below.
    expect(found.length).toBeGreaterThanOrEqual(18);
    const stems = found.map((f) => f.stem);
    for (const known of ["send", "queue", "broadcast", "ask", "chatroom", "seat"]) expect(stems).toContain(known);
  });

  it("every census member is a guarded top-level command or is exempt with a reason", () => {
    const uncovered = found.filter((f) => !isGuarded(f) && !(f.stem in EXEMPT)).map((f) => `${f.stem}: ${f.options.join(",")}${f.positional ? " +positional" : ""}`);
    expect(uncovered).toEqual([]);
  });

  it("every FLAG command guards exactly the text options its CLI file declares (a new --reason-like flag must be added)", () => {
    for (const [name, flags] of Object.entries(guard.FLAG_COMMANDS)) {
      const member = found.find((f) => f.stem === name || f.commandNames.includes(name));
      expect(member, `${name} has no text option left in the CLI: drop it from FLAG_COMMANDS`).toBeDefined();
      const declared = new Set(member!.options);
      // 'expect-account' is free text that is not a message; it is guarded on purpose.
      for (const flag of flags) expect(declared.has(flag) || flag === "--expect-account", `${name} ${flag}`).toBe(true);
      for (const flag of declared) expect(flags, `${name} declares ${flag} which the guard does not read`).toContain(flag);
    }
  });

  it("no stale guard key: every guarded name is a command the CLI defines", () => {
    const allNames = new Set<string>();
    for (const file of readdirSync(commandsDir).filter((f) => f.endsWith(".ts"))) {
      for (const m of readFileSync(join(commandsDir, file), "utf8").matchAll(/new Command\("([a-z-]+)"\)/g)) allNames.add(m[1]!);
    }
    const index = readFileSync(join(commandsDir, "..", "index.ts"), "utf8");
    for (const name of guarded) {
      const defined = allNames.has(name) || index.includes(`.command("${name}")`) || index.includes(`new Command("${name}")`);
      expect(defined, `${name} is not defined as a CLI command`).toBe(true);
    }
  });
});
