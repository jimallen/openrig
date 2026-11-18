import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { claudeRigBodyGuardGroup } from "../src/adapters/claude-rig-body-guard.js";

// workspaces-o9o.131: in Claude Code's Code Mode each piece of code arrives at PreToolUse as tool_name "REPL" with the JavaScript in
// tool_input.code (measured on Claude Code 2.1.327, o9o.122/o9o.131). The nested shell calls arrive as Bash and are checked as before;
// the code itself was not. The guard now reads it: the same rig-send and broad-kill rules over every string and template literal in
// the code (code builds its commands as strings), and a refusal of code that names child_process, process.binding, process.dlopen
// or a Function-constructor chain. Claude Code itself refuses module loading in REPL code ("the vm context is sealed", measured):
// this is defence in depth over that refusal, not a sandbox.
const require = createRequire(import.meta.url);
const guard = require("../assets/plugins/openrig-core/hooks/scripts/rig-body-guard.cjs") as {
  hookDecision(raw: string): { output: { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } } | null; note: string | null };
  checkReplCode(code: string): { block: boolean; reason: string; violations: Array<{ kind: string }> };
};

const repl = (code: string) => guard.hookDecision(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "REPL", tool_input: { code, description: "probe" } }));
const denied = (code: string) => repl(code).output?.hookSpecificOutput.permissionDecision === "deny";
const BT = "`";

const DENY: Array<{ note: string; code: string; kind: RegExp }> = [
  { note: "rig send with $() in a template literal passed to Bash", code: `await Bash({ command: ${BT}rig send x@y "hi $(date)"${BT} })`, kind: /^substitution$/ },
  { note: "rig send with $() in a double-quoted string", code: `await Bash({ command: "rig send x@y \\"hi $(date)\\"" })`, kind: /^substitution$/ },
  { note: "rig send with $() in the shell tag", code: `await $${BT}rig send x@y "hi $(date)"${BT}`, kind: /^substitution$/ },
  { note: "rig send with backticks in a single-quoted string", code: `await Bash({ command: 'rig send x@y "hi \\${BT}date\\${BT}"' })`, kind: /^substitution$/ },
  { note: "pkill -f in a string", code: `await Bash({ command: "pkill -f vitest" })`, kind: /^pkill-f$/ },
  { note: "pkill -f with an interpolated pattern", code: `const n = "vitest"; await $${BT}pkill -f ${"$"}{n}${BT}`, kind: /^pkill-f$/ },
  { note: "killall in a single-quoted string", code: `await Bash({ command: 'killall node' })`, kind: /^killall$/ },
  { note: "kill of a process group", code: `await Bash({ command: "kill -9 -1" })`, kind: /^kill-group$/ },
  { note: "child_process by dynamic import", code: `const cp = await import("node:child_process"); cp.execSync("ls")`, kind: /^repl-api$/ },
  { note: "child_process by bracket name", code: `const m = globalThis["child_process"]`, kind: /^repl-api$/ },
  { note: "process.binding", code: `process.binding("spawn_sync")`, kind: /^repl-api$/ },
  { note: "process . dlopen with spaces", code: `process . dlopen(m, "/tmp/x.node")`, kind: /^repl-api$/ },
  { note: "constructor.constructor chain", code: `Read.constructor.constructor("return 1")()`, kind: /^repl-api$/ },
  { note: "constructor by bracket", code: `const F = ({})["constructor"]["constructor"]; F("return 1")()`, kind: /^repl-api$/ },
  { note: "a function literal's constructor called", code: `(function(){}).constructor("return 1")()`, kind: /^repl-api$/ },
  { note: "new Function", code: `const f = new Function("return 1"); f()`, kind: /^repl-api$/ },
  { note: "Function called directly", code: `Function("return 1")()`, kind: /^repl-api$/ },
  { note: "an unterminated literal that names rig is refused (fail closed)", code: `await $${BT}rig send x@y "hi $(date)"`, kind: /^unparseable-repl$/ },
  // workspaces-o9o.131 FAIL F1 (verify-sec2): the API rules read a normalised property access, so the member name is caught however it is spelled.
  { note: "process.binding by bracket string (double quote)", code: `process["binding"]("spawn_sync")`, kind: /^repl-api$/ },
  { note: "process.binding by bracket string (single quote)", code: `process['binding']("spawn_sync")`, kind: /^repl-api$/ },
  { note: "process.binding by bracket template string", code: `process[${BT}binding${BT}]("spawn_sync")`, kind: /^repl-api$/ },
  { note: "process?.binding (optional chaining)", code: `process?.binding("spawn_sync")`, kind: /^repl-api$/ },
  { note: "process .dlopen by bracket with spaces", code: `process [ "dlopen" ](m, "/x.node")`, kind: /^repl-api$/ },
  { note: "globalThis['process']['binding'] (no dot anywhere)", code: `globalThis["process"]["binding"]("x")`, kind: /^repl-api$/ },
  { note: "self.process.binding via bracket on self", code: `self["process"].binding("x")`, kind: /^repl-api$/ },
  { note: "process.binding with a unicode-escaped member name", code: `process["\\u0062inding"]("x")`, kind: /^repl-api$/ },
  { note: "process spelled with a unicode-escaped identifier char", code: `\\u0070rocess.binding("x")`, kind: /^repl-api$/ },
  { note: "constructor by bracket with a hex-escaped name", code: `Read["\\u0063onstructor"]["constructor"]("return 1")()`, kind: /^repl-api$/ },
  { note: "a direct alias of Function, then called", code: `const F = Function; F("return 1")()`, kind: /^repl-api$/ },
  { note: "an alias of globalThis.Function, then called", code: `const G = globalThis.Function; G("return 1")()`, kind: /^repl-api$/ },
  { note: "an alias of self['Function'], then called", code: `const H = self["Function"]; H("return 1")()`, kind: /^repl-api$/ },
  { note: "child_process as a require module specifier (a specifier IS scanned)", code: `const cp = require("child_process"); cp.execSync("ls")`, kind: /^repl-api$/ },
  { note: "child_process as an import specifier with node: prefix", code: `const cp = await import("node:child_process")`, kind: /^repl-api$/ },
  { note: "process.binding reached from inside a template ${...} expression", code: `const t = ${BT}x${"$"}{process.binding("y")}${BT}; t`, kind: /^repl-api$/ },
  // workspaces-o9o.131 round 2 (CoS reference-based ruling): ANY reference to the global Function value is refused, however used; any
  // .constructor access; process.binding/dlopen in any spelling (parenthesised literal keys folded); typeof Function flips to refuse.
  { note: "bare reference to Function (no call)", code: `const f = Function; f;`, kind: /^repl-api$/ },
  { note: "typeof Function (a reference)", code: `const t = typeof Function; t`, kind: /^repl-api$/ },
  { note: "an UNUSED alias of Function", code: `const F = Function; 1 + 1`, kind: /^repl-api$/ },
  { note: "Function.call(...)()", code: `Function.call(null, "return 1")()`, kind: /^repl-api$/ },
  { note: "Function.apply(...)()", code: `Function.apply(null, ["return 1"])()`, kind: /^repl-api$/ },
  { note: "Function.bind(...)()", code: `Function.bind(null, "return 1")()`, kind: /^repl-api$/ },
  { note: "globalThis['Function']['call'] chain", code: `globalThis["Function"]["call"](null, "return 1")()`, kind: /^repl-api$/ },
  { note: "window.Function reference", code: `const f = window.Function; f`, kind: /^repl-api$/ },
  { note: "Reflect.construct(Function, [...])", code: `Reflect.construct(Function, ["return 1"])()`, kind: /^repl-api$/ },
  { note: "a bare .constructor access (no call)", code: `const c = ({}).constructor; c`, kind: /^repl-api$/ },
  { note: "this.constructor access", code: `function f() { return this.constructor; }`, kind: /^repl-api$/ },
  { note: "process.binding via a parenthesised literal key", code: `process[("binding")]("x")`, kind: /^repl-api$/ },
  { note: "process.binding via optional-chaining parenthesised key", code: `process?.[("binding")]("x")`, kind: /^repl-api$/ },
  { note: "process.binding via nested parenthesised keys on globalThis", code: `globalThis[("process")][("binding")]("x")`, kind: /^repl-api$/ },
  { note: "process.dlopen via a parenthesised key", code: `process[("dlopen")](m, "/x.node")`, kind: /^repl-api$/ },
];

const ALLOW: Array<{ note: string; code: string }> = [
  { note: "reading files through the tool globals", code: `const f = await Read({ file_path: "/tmp/a" }); f.length` },
  { note: "an ordinary shell call", code: `await Bash({ command: "git status --short" })` },
  { note: "kill by pid", code: `await Bash({ command: "kill 4242" })` },
  { note: "kill by an interpolated pid", code: `const pid = 4242; await $${BT}kill -9 ${"$"}{pid}${BT}` },
  { note: "rig send through a quoted here-document", code: `await Bash({ command: "rig send x@y --file - <<'EOF'\\nhi $(date)\\nEOF" })` },
  { note: "a comment that mentions pkill -f and Function(", code: `// never pkill -f, never Function("x")\nawait Bash({ command: "ls" })` },
  { note: "a block comment that names child_process", code: `/* child_process is refused */ await Glob({ pattern: "*.ts" })` },
  { note: "a block comment after a value (where / is division) that names child_process", code: `const n = 2; const m = n /* child_process is refused */ + 1; m` },
  { note: "identifiers that only contain the words (myFunction, constructorName) — not the global Function", code: `const myFunction = (x) => x; const constructorName = "a"; myFunction(constructorName)` },
  { note: "a lowercase function keyword and a declaration are not the Function value", code: `function helper(x) { return x + 1; } helper(2)` },
  { note: "a class constructor METHOD is a definition, not a .constructor access", code: `class Pt { constructor(x) { this.x = x; } } new Pt(1).x` },
  { note: "an object property named constructor at definition (not an access) — still data unless accessed by .constructor", code: `const o = { value: 1 }; o.value` },
  { note: "a template with interpolations and no command words", code: `const a = 1; const s = ${BT}value ${"$"}{a} of ${"$"}{a + 1}${BT}; s` },
  { note: "a regular expression with a quote in it", code: `const r = /it's/; r.test("it's")` },
  { note: "a division next to strings", code: `const x = 6 / 3; const y = "a"; x + y` },
  { note: "a regular expression with a quote, beside a kill by pid (read as a regex, not as an unterminated string)", code: `const r = /it's/; r.test("x"); await Bash({ command: "kill 4242" })` },
  // workspaces-o9o.131 FAIL F1 over-refusal (verify-sec2): the API rules do NOT scan string CONTENTS (except a module specifier), so a
  // string that merely names a host API — a log line, a doc comment, an error message — is not a refusal. Shell/kill rules still scan strings.
  { note: "a string that merely names process.binding (not a property access or a specifier)", code: `const warn = "do not use process.binding here"; warn.length` },
  { note: "a string that names child_process but is not a module specifier", code: `const doc = "child_process is refused by the guard"; doc.length` },
  { note: "a string that names the Function constructor", code: `const note = "never reach for new Function()"; note.length` },
  { note: "process.binding named inside a template with no interpolation", code: `const t = ${BT}process.binding and child_process are refused${BT}; t.length` },
  { note: "an object property literally called binding, not on process", code: `const o = { binding: 1 }; o.binding + 1` },
  { note: "a bracket access with a NON-API member name spelled with an escape", code: `const o = { value: 2 }; o["\\u0076alue"] + 1` },
  { note: "a module specifier that is not a host API (node:fs is fine)", code: `const fs = await import("node:fs"); fs.readFileSync` },
];

describe("o9o.131: the seat guard reads REPL code", () => {
  it.each(DENY.map((r) => [r.note, r] as const))("refuses: %s", (_note, row) => {
    const verdict = guard.checkReplCode(row.code);
    expect(verdict.block, JSON.stringify(verdict)).toBe(true);
    expect(verdict.violations.some((v) => row.kind.test(v.kind)), JSON.stringify(verdict.violations)).toBe(true);
    expect(denied(row.code)).toBe(true);
  });

  it.each(ALLOW.map((r) => [r.note, r] as const))("allows: %s", (_note, row) => {
    const verdict = guard.checkReplCode(row.code);
    expect(verdict.block, JSON.stringify(verdict)).toBe(false);
    expect(repl(row.code).output).toBeNull();
  });

  it("a refusal of a named API says what it is and what to do instead", () => {
    const reason = repl(`process.binding("x")`).output!.hookSpecificOutput.permissionDecisionReason;
    expect(reason).toContain("BLOCKED this code before it ran. Nothing was executed.");
    expect(reason).toMatch(/process\.binding/);
    expect(reason).toMatch(/shell tool/);
    expect(reason).toMatch(/not a sandbox|defence in depth/i);
  });

  it("a refusal of a literal gives the same reason the Bash rule gives for that command", () => {
    const viaRepl = repl(`await Bash({ command: "pkill -f vitest" })`).output!.hookSpecificOutput.permissionDecisionReason;
    const viaBash = guard.hookDecision(JSON.stringify({ tool_name: "Bash", tool_input: { command: "pkill -f vitest" } })).output!.hookSpecificOutput.permissionDecisionReason;
    expect(viaRepl).toBe(viaBash);
  });

  it("CONTROL: the Bash path is unchanged, and a REPL event without code is allowed", () => {
    expect(guard.hookDecision(JSON.stringify({ tool_name: "Bash", tool_input: { command: "pkill -f vitest" } })).output).not.toBeNull();
    expect(guard.hookDecision(JSON.stringify({ tool_name: "Bash", tool_input: { command: "git status" } })).output).toBeNull();
    expect(guard.hookDecision(JSON.stringify({ tool_name: "REPL", tool_input: {} })).output).toBeNull();
    expect(guard.hookDecision(JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/x" } })).output).toBeNull();
  });
});

describe("o9o.131: both places the guard is installed match REPL as well as Bash", () => {
  it("the launch --settings group (every managed Claude seat)", () => {
    expect(claudeRigBodyGuardGroup("/x/rig-body-guard.cjs").matcher).toBe("Bash|REPL");
  });

  it("the openrig-core plugin's hooks/claude.json", () => {
    const manifest = JSON.parse(readFileSync(new URL("../assets/plugins/openrig-core/hooks/claude.json", import.meta.url), "utf8")) as { hooks: { PreToolUse: Array<{ matcher?: string; hooks: Array<{ command: string }> }> } };
    const groups = manifest.hooks.PreToolUse.filter((g) => g.hooks.some((h) => h.command.includes("rig-body-guard.cjs")));
    expect(groups.map((g) => g.matcher)).toEqual(["Bash|REPL"]);
  });
});
