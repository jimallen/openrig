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
  // workspaces-o9o.131 round 3 (verify-sec probes; Jim: rebuild on a real parser). Parens, comments, optional chains collapse in the AST.
  { note: "(process).binding — parenthesised object", code: `(process).binding("x")`, kind: /^repl-api$/ },
  { note: "(process)[quoted] — parenthesised object, bracket key", code: `(process)["binding"]("x")`, kind: /^repl-api$/ },
  { note: "process[(binding)] with a comment in the key", code: `process[("binding")/*c*/]("x")`, kind: /^repl-api$/ },
  { note: "process?.binding optional chain", code: `process?.binding("x")`, kind: /^repl-api$/ },
  { note: "globalThis.process.dlopen", code: `globalThis.process.dlopen(m, "/x.node")`, kind: /^repl-api$/ },
  { note: "(Function).bind(...) parenthesised reference", code: `(Function).bind(null, "return 1")()`, kind: /^repl-api$/ },
  { note: "Reflect.construct(Function, ...) with an inner comment", code: `Reflect.construct(/*f*/Function, ["return 1"])()`, kind: /^repl-api$/ },
  { note: "window.Function member form", code: `window.Function("return 1")()`, kind: /^repl-api$/ },
  { note: ".constructor through optional chaining", code: `const o = {}; o?.constructor`, kind: /^repl-api$/ },
  { note: "unparseable code refused (fail closed), no risk words", code: `const x = (1 +`, kind: /^unparseable-repl$/ },
  // workspaces-o9o.131 round 4 (verify-sec FAIL on the parser; CoS ruling "close the alias chase"): ANY unshadowed reference to a dangerous
  // global identifier (process, require, module, Function, global, globalThis, self, window) refuses, HOWEVER used — the reference itself, no
  // alias tracking. These are the verify-sec probes the alias-following round-1 parser let through.
  { note: "global.Function(...) — a reference to `global`", code: `global.Function("return 1")()`, kind: /^repl-api$/ },
  { note: "global.process.binding — a reference to `global`", code: `global.process.binding("x")`, kind: /^repl-api$/ },
  { note: "global.process.dlopen — a reference to `global`", code: `global.process.dlopen(m, "/x.node")`, kind: /^repl-api$/ },
  { note: "static alias: const p = process; p.binding(...)", code: `const p = process; p.binding("x")`, kind: /^repl-api$/ },
  { note: "static alias: const p = globalThis.process; p.dlopen(...)", code: `const p = globalThis.process; p.dlopen(m, "/x.node")`, kind: /^repl-api$/ },
  { note: "static alias: const r = require; r('child_process')", code: `const r = require; r("child_process")`, kind: /^repl-api$/ },
  { note: "module.require('child_process') — a reference to `module`", code: `module.require("child_process")`, kind: /^repl-api$/ },
  { note: "require('child_process') as a real call — a reference to `require`", code: `require("child_process").execSync("ls")`, kind: /^repl-api$/ },
  { note: "a bare reference to process", code: `const p = process; p`, kind: /^repl-api$/ },
  { note: "a bare reference to require (no call)", code: `const r = require; r`, kind: /^repl-api$/ },
  { note: "a bare reference to module", code: `const m = module; m`, kind: /^repl-api$/ },
  { note: "a bare reference to global", code: `const g = global; g`, kind: /^repl-api$/ },
  { note: "a bare reference to globalThis", code: `const g = globalThis; g`, kind: /^repl-api$/ },
  { note: "a bare reference to self", code: `const s = self; s`, kind: /^repl-api$/ },
  { note: "a bare reference to window", code: `const w = window; w`, kind: /^repl-api$/ },
  { note: "globalThis['child_process'] — a reference to `globalThis` refuses (round-4 reclassification of the old ALLOW)", code: `const m = globalThis["child_process"]; typeof m`, kind: /^repl-api$/ },
  // Scope boundaries (make the var-hoist precise, not a blanket allow): a `var`/`let` named like a global binds only where the language says.
  { note: "a var Function inside a NESTED function does not shadow an outer global Function reference", code: `function inner() { var Function; } Function("return 1")()`, kind: /^repl-api$/ },
  { note: "a let process in a sibling block does not shadow a later global process reference", code: `{ let process = { pid: 1 }; } process.binding("x")`, kind: /^repl-api$/ },
  // workspaces-o9o.131 round-4 nit (verify-sec): a switch block is one lexical scope for its cases, but the discriminant and anything
  // after the switch are outside it. These two refuse; the two ALLOW rows below are the over-refusals they pin against.
  { note: "a switch-scoped `let process` does not leak: a global process reference after the switch refuses", code: `switch (1) { case 1: let process = {}; } process.binding("x")`, kind: /^repl-api$/ },
  { note: "the switch discriminant is evaluated outside the case scope: switch (process) is a global reference", code: `switch (process) { case 1: 1; }`, kind: /^repl-api$/ },
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
  // workspaces-o9o.131 round 3: the parser resolves scope and real calls, so these are NOT references to the host API and are allowed.
  { note: "a LOCAL const named Function shadows the global", code: `const Function = (s) => s; Function("x")` },
  { note: "a param named Function is local", code: `((Function) => Function(1))((x) => x)` },
  { note: "obj.Function is a property on another object, not the global", code: `const o = { Function: 1 }; o.Function` },
  { note: "a member method named require is not the require() call", code: `const api = { require(x) { return x; } }; api.require("child_process")` },
  { note: "a member method named import is not import()", code: `const api = { import(x) { return x; } }; api.import("node:child_process")` },
  { note: "a class constructor method is a definition, not a .constructor access", code: `class Pt { constructor(x) { this.x = x; } } new Pt(1).x` },
  { note: "a LOCAL const named require is not the global require() call", code: `const require = (x) => x; require("child_process")` },
  // workspaces-o9o.131 round 4: scope is per the language — a LOCAL binding of a dangerous name is NOT the global (CoS ruling (2)).
  { note: "const C = class Function {} — the class NAME is a binding, not a reference to the global Function", code: `const C = class Function {}; new C()` },
  { note: "a var Function hoisted from a nested block shadows the global across the whole function", code: `function f() { { var Function; } return Function; } f()` },
  { note: "a named class expression's own name is in scope in its body, not the global Function", code: `const C = class Function { m() { return Function; } }; new C().m()` },
  { note: "a local const named module shadows the global module", code: `const module = { x: 1 }; module.x` },
  { note: "a local let named globalThis shadows the global", code: `{ let globalThis = {}; globalThis.foo = 1; globalThis.foo }` },
  { note: "a param named process is local", code: `((process) => process.pid)({ pid: 1 })` },
  { note: "a local const named self shadows the global", code: `const self = { x: 2 }; self.x` },
  { note: "a statement label named like a global is a label, not a value reference", code: `process: for (const x of [1]) { if (x) break process; }` },
  // workspaces-o9o.131 round-4 nit (verify-sec over-refusal): a switch block is one lexical scope shared by its cases, so a case-level
  // `let`/`const`/`function` binding of a dangerous name shadows the global within the switch.
  { note: "a let in a switch case shadows the global within the switch block", code: `switch (1) { case 1: let process = {}; process.x; }` },
  { note: "a case-level function declaration is in scope across the switch's cases", code: `switch (1) { case 1: function process() {} break; default: process(); }` },
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
