// OF-200: every place the daemon starts an agent in a seat's terminal, and the options each passes (finding-shell-paste-race-20261102.md, section 3).
//
// An agent started by typing a command into the seat's login shell leaves that shell above it. The core holds a send and re-checks only that the
// terminal is live, so an agent that dies in the hold hands the message to the shell, which runs it. `asTerminalProgram` makes the hc host replace the
// shell with the launch (or end it with the launch), so nothing is left to run a message. The option is per call, so a launch site that forgets it
// reintroduces the hazard with every test of every other site still green. This census reads every non-test call of `sendShellCommand` (the one function
// all launches go through) with the TypeScript parser, and fails for a call that is not in the table below, passes a different option set, or has
// lost the option.
//
// The finding counted 13 call lines in 8 files (a `managed ? a : b` pair counted once). The parser counts calls: 16, because Claude's managed and classic
// branches are two calls each at three of those lines.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

const SRC = new URL("../src/", import.meta.url).pathname;

/** The implementation, its delegate and the tmux adapter (which ignores the option: its shell stays above the agent, the deployed shape). */
const NOT_LAUNCH_SITES = new Set(["adapters/tmux.ts", "adapters/hc-input.ts", "adapters/hc-adapter.ts"]);

type Flags = readonly string[];
/** Options a launch site passes, as written. A runner is `exec`ed by its script, so the runner is the terminal's own process. A Codex or managed
 *  Claude command is run by the script as a child (`/bin/sh <script>` stays the terminal's program until the agent ends, as the pump's agent check
 *  expects: see isSeatAgent); a classic Claude may be an rc alias or function, so its launch is sourced in the pane shell, which then ends. */
const RUNNER: Flags = ["asTerminalProgram", "execInScript", "stageIfLong"];
const SITES: Array<{ file: string; flags: Flags; why: string }> = [
  { file: "adapters/pi-runtime-adapter.ts", flags: RUNNER, why: "Pi / OMP launch" },
  { file: "adapters/pi-runtime-adapter.ts", flags: RUNNER, why: "Pi / OMP launch, bare command when routing cannot fit" },
  { file: "adapters/pi-resume.ts", flags: RUNNER, why: "Pi / OMP resume" },
  { file: "adapters/pi-resume.ts", flags: RUNNER, why: "Pi / OMP resume, bare command when routing cannot fit" },
  { file: "adapters/pda-runtime-adapter.ts", flags: RUNNER, why: "PDA launch" },
  { file: "adapters/stub-runtime-adapter.ts", flags: ["asTerminalProgram", "execInScript"], why: "stub launch" },
  { file: "adapters/codex-runtime-adapter.ts", flags: ["asTerminalProgram"], why: "Codex fork" },
  { file: "adapters/codex-runtime-adapter.ts", flags: ["asTerminalProgram"], why: "Codex launch / resume" },
  { file: "adapters/codex-runtime-adapter.ts", flags: ["asTerminalProgram"], why: "Codex resume command (restart in place)" },
  { file: "adapters/codex-resume.ts", flags: ["asTerminalProgram"], why: "Codex resume" },
  { file: "adapters/claude-code-adapter.ts", flags: ["asTerminalProgram"], why: "managed Claude fork" },
  { file: "adapters/claude-code-adapter.ts", flags: ["asTerminalProgram", "sourceInPane"], why: "classic Claude fork" },
  { file: "adapters/claude-code-adapter.ts", flags: ["asTerminalProgram"], why: "managed Claude launch / resume" },
  { file: "adapters/claude-code-adapter.ts", flags: ["asTerminalProgram", "sourceInPane"], why: "classic Claude launch / resume" },
  { file: "adapters/claude-resume.ts", flags: ["asTerminalProgram"], why: "managed Claude resume" },
  { file: "adapters/claude-resume.ts", flags: ["asTerminalProgram", "sourceInPane"], why: "classic Claude resume" },
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
  });
}

interface Found { file: string; line: number; options: Record<string, string> | "absent" | "not-a-literal"; argCount: number }

/** Every `<expr>.sendShellCommand(...)` call outside the implementation, with the fourth argument's properties as written. */
function launchCalls(): Found[] {
  const found: Found[] = [];
  for (const path of sourceFiles(SRC)) {
    const file = relative(SRC, path);
    if (NOT_LAUNCH_SITES.has(file)) continue;
    const text = readFileSync(path, "utf8");
    if (!text.includes("sendShellCommand")) continue;
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "sendShellCommand") {
        const arg = node.arguments[3];
        let options: Found["options"] = "absent";
        if (arg !== undefined) {
          if (ts.isObjectLiteralExpression(arg)) {
            options = {};
            for (const property of arg.properties) {
              if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)) options[property.name.text] = property.initializer.getText(source);
              else options = "not-a-literal";
              if (options === "not-a-literal") break;
            }
          } else options = "not-a-literal";
        }
        found.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, options, argCount: node.arguments.length });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

describe("every launch of an agent into a seat's terminal says it is the terminal's program (OF-200)", () => {
  const calls = launchCalls();

  it("the census finds exactly the classified launch sites, file by file, and the population is not empty (a new or removed call fails here)", () => {
    expect(calls.length, "the population filtered: a zero here is a wrong filter, not a clean tree").toBe(16);
    const counted = new Map<string, number>();
    for (const call of calls) counted.set(call.file, (counted.get(call.file) ?? 0) + 1);
    const known = new Map<string, number>();
    for (const site of SITES) known.set(site.file, (known.get(site.file) ?? 0) + 1);
    expect([...counted.entries()].sort()).toEqual([...known.entries()].sort());
    expect(counted.size, "files").toBe(8);
  });

  // One row per call, in file order: the n-th call of a file is the n-th row of that file's table. A launch that drops the option, or passes a
  // different set (a classic Claude without `sourceInPane`, a runner without `execInScript`), fails its own row and no other.
  const ordinal = new Map<string, number>();
  const rows = calls.map((call) => {
    const n = ordinal.get(call.file) ?? 0;
    ordinal.set(call.file, n + 1);
    return { call, site: SITES.filter((s) => s.file === call.file)[n] };
  });
  it.each(rows.map((r) => [`${r.call.file} #${(r.site ? SITES.filter((s) => s.file === r.call.file).indexOf(r.site) : -1) + 1}: ${r.site?.why ?? "unclassified"}`, r] as const))("%s", (_name, { call, site }) => {
    expect(site, `${call.file}:${call.line} is a launch site that the table does not classify`).toBeDefined();
    expect(call.options, `${call.file}:${call.line} passes no option literal as the fourth argument`).not.toBe("absent");
    expect(call.options, `${call.file}:${call.line} passes an options value that is not an object literal, so it cannot be read here`).not.toBe("not-a-literal");
    const options = call.options as Record<string, string>;
    expect(options.asTerminalProgram, `${call.file}:${call.line} leaves the login shell above the agent`).toBe("true");
    expect(Object.keys(options).sort(), `${call.file}:${call.line}`).toEqual([...site!.flags].sort());
    for (const flag of site!.flags) expect(options[flag], `${call.file}:${call.line} ${flag}`).toBe("true");
  });
});
