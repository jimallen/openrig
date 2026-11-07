// OF-250 census: every place the daemon builds a Claude launch command carries the rig-body guard. Parsed (TypeScript AST), not grepped.
// The guard is added by operationalLaunchArgs / operationalLaunchArg (kernel-authority.ts) into the launch's one --settings; a site is covered when
// its command is built from that function's output. A NEW site that builds `claude ...` without it fails here.
//
// OF-252 adds two more shapes the template/`.command` match was blind to (the OF-250 review probe survived them): (c) `spawn("claude", [...])` and its
// siblings (spawnSync, execFile, execFileSync, exec, execSync, fork), and (d) `["claude", ...].join(" ")`. Each has a positive control that runs the
// finder on in-memory source. Found at the base of OF-252: one (c) site, the `claude --help` probe, and no (d) site.
//
// OF-258 adds the shapes OF-252 left: (b) the binary held in a name, (c) a conditional or defaulted "claude", (d) Bun.spawn's array command, (e) an array
// joined or spawned later through its variable; each has positive fixtures and negative controls below. Found at the base of OF-258: nothing new in the tree
// (the same one spawn site). NOT followed: an executable resolved at run time (`execFile(context.executable, ["--help"])` in domain/claude-managed-launch.ts is
// the `claude --help` capability probe, found by hand), a command passed as a parameter, and a name held in another file's non-exported or non-constant value.
//
// Population: (a) every call `<x>.command([...])` on the managed launch, (b) every template/string text that starts a `claude` invocation with a flag or
// an interpolated flag (`claude --`, `claude ${`). Found at the base of OF-250: 3 managed + 4 classic = 7 launch sites in two files, plus two NON-launch uses.
import fs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

/** Files that mention a `claude ...` command and are NOT a launch of a seat, with the reason. */
const NOT_A_LAUNCH: Record<string, string> = {
  "domain/native-resume-probe.ts": "buildNativeResumeCommand: the OPERATOR-facing resume line (and the resume-metadata probe's one-shot check in a throwaway session that is never sent input); no seat runs it with tools",
  "domain/rigspec-preflight.ts": "`claude --version`: a runtime availability probe the preflight runs; it starts no session",
  "domain/permission-drift-observer.ts": "execFile(\"claude\", [\"--help\"]): reads the help text to see which permission flags exist; it starts no session and sends no model input",
  "domain/node-inventory.ts": "display text for `rig ps`/inventory (the command an operator could type); never executed by the daemon",
};

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(nodePath.join(dir, e.name)) : e.name.endsWith(".ts") ? [nodePath.join(dir, e.name)] : []);
}

interface Site { file: string; line: number; kind: "managed" | "classic" | "spawn" | "join"; text: string; covered: boolean }

const CLAUDE_START = /\bclaude (--|\$\{)/;

// OF-258 review F5: spawn-style calls count on ANY receiver (`this.deps.spawn("claude", ...)`); a bare `exec` or `.exec` is a RegExp or a db handle (`RE.exec(text)`) unless the receiver is child_process / cp / Bun / Deno.
const SPAWNERS = /^(?:(?:[\w$.]+\.)?(?:spawn|spawnSync|execFile|execFileSync|fork|execa|execaSync|execSync)|(?:(?:child_?process|cp|Bun|Deno|node:child_process)\.)?exec)$/;
const isClaudeText = (n: ts.Node | undefined): boolean => !!n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && /^(.*\/)?claude$/.test(n.text);

// OF-258: the claude binary is also reached through (b) a name that holds it (`const BIN = "claude"`, an object key, a default parameter, a class field,
// followed through `const B = A`), (c) a conditional or `||` / `??` default with "claude" on one branch, (d) Bun.spawn, whose command is an ARRAY (or
// `{ cmd: [...] }`), and (e) an array that starts with the binary and is joined or passed to a spawner later through the variable that holds it.
// A file's own names count in that file; across files only an exported constant counts. Matching is by identifier name, so an unrelated same-named constant that reaches a spawner would be listed and has to be classified.
type Names = Set<string>;
function claudish(n: ts.Node | undefined, names: Names, viaProperty = true): boolean {
  if (!n) return false;
  if (isClaudeText(n)) return true;
  if (ts.isIdentifier(n)) return names.has(n.text);
  // a property read counts at a call site; it is NOT followed when building the names (that chain reaches every `x.runtime`)
  if (ts.isPropertyAccessExpression(n)) return viaProperty && names.has(n.name.text);
  if (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n) || ts.isSatisfiesExpression(n)) return claudish(n.expression, names, viaProperty);
  if (ts.isConditionalExpression(n)) return claudish(n.whenTrue, names, viaProperty) || claudish(n.whenFalse, names, viaProperty);
  if (ts.isBinaryExpression(n) && (n.operatorToken.kind === ts.SyntaxKind.BarBarToken || n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) return claudish(n.left, names, viaProperty) || claudish(n.right, names, viaProperty);
  return false;
}
/** The names (variables, properties, parameters, class fields) initialised with the claude binary in this source, to a fixpoint. */
function claudeNamesIn(text: string, seed: Names, exportedOnly = false): Names {
  const sf = ts.createSourceFile("n.ts", text, ts.ScriptTarget.Latest, true);
  const names = new Set(seed);
  for (let changed = true; changed;) {
    changed = false;
    const add = (id: ts.Node, init: ts.Node | undefined): void => {
      const nm = ts.isIdentifier(id) || ts.isStringLiteral(id) ? id.text : undefined;
      if (nm && !names.has(nm) && claudish(init, names, false)) { names.add(nm); changed = true; }
    };
    const v = (n: ts.Node): void => {
      // exportedOnly (the tree pass): only `export const X = ...`, the constants another file can import; the file's own pass sees all of its names
      if (ts.isVariableDeclaration(n) && (!exportedOnly || ts.isVariableDeclarationList(n.parent) && ts.isVariableStatement(n.parent.parent) && n.parent.parent.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))) add(n.name, n.initializer);
      if (!exportedOnly) {
        if ((ts.isParameter(n) || ts.isPropertyDeclaration(n) || ts.isPropertyAssignment(n)) && n.name && "initializer" in n) add(n.name, n.initializer);
        if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(n.left)) add(n.left.name, n.right);
      }
      ts.forEachChild(n, v);
    };
    v(sf);
  }
  return names;
}

const isArrayStartingClaude = (n: ts.Node | undefined, names: Names): n is ts.ArrayLiteralExpression => !!n && ts.isArrayLiteralExpression(n) && claudish(n.elements[0], names);
/** The command of a spawner call: first argument a claude binary, an array that starts with it (Bun.spawn), or `{ cmd: [...] }`. */
function spawnedClaude(arg: ts.Node | undefined, names: Names): boolean {
  if (!arg) return false;
  if (claudish(arg, names) || isArrayStartingClaude(arg, names)) return true;
  return ts.isObjectLiteralExpression(arg) && arg.properties.some((p) => ts.isPropertyAssignment(p) && p.name.getText() === "cmd" && isArrayStartingClaude(p.initializer, names));
}

function sitesIn(file: string, names: Names): Site[] {
  return sitesInText(nodePath.relative(SRC, file), fs.readFileSync(file, "utf8"), names);
}

function sitesInText(rel: string, text: string, treeNames: Names = new Set()): Site[] {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
  const names = claudeNamesIn(text, treeNames);
  const out: Site[] = [];
  /** The variable initialisers in this file, so `${permissionMode}` can be traced to operationalLaunchArg. */
  const inits = new Map<string, string>();
  const collect = (n: ts.Node): void => { if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) inits.set(n.name.text, n.initializer.getText(sf)); ts.forEachChild(n, collect); };
  collect(sf);
  const usesOperational = (src: string) => /operationalLaunchArgs?\(/.test(src);
  const visit = (n: ts.Node): void => {
    const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    if (ts.isCallExpression(n) && /(^|\.)command$/.test(n.expression.getText(sf)) && n.arguments[0] && ts.isArrayLiteralExpression(n.arguments[0]) && /--permission-mode/.test(n.arguments[0].getText(sf))) {
      out.push({ file: rel, line, kind: "managed", text: n.arguments[0].getText(sf).slice(0, 80), covered: usesOperational(n.arguments[0].getText(sf)) });
    }
    if (ts.isCallExpression(n) && SPAWNERS.test(n.expression.getText(sf)) && spawnedClaude(n.arguments[0], names)) {
      // a Bun.spawn-style array carries its own arguments; the others take them as the second argument
      const first = n.arguments[0]!;
      const argText = isArrayStartingClaude(first, names) || ts.isObjectLiteralExpression(first) ? first.getText(sf) : n.arguments[1]?.getText(sf) ?? "";
      out.push({ file: rel, line, kind: "spawn", text: n.getText(sf).slice(0, 80), covered: usesOperational(argText) });
    }
    if (ts.isArrayLiteralExpression(n) && claudish(n.elements[0], names)) {
      const p = n.parent;
      const direct = ts.isPropertyAccessExpression(p) && p.name.text === "join" && ts.isCallExpression(p.parent);
      // held in a variable that is joined or handed to a spawner (anywhere in the file) later
      const holder = ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) ? p.name.text : undefined;
      const later = holder !== undefined && usesLater(sf, holder);
      if (direct || later) out.push({ file: rel, line, kind: "join", text: n.getText(sf).slice(0, 80), covered: usesOperational(n.getText(sf)) });
    }
    if (ts.isTemplateExpression(n)) {
      const whole = n.getText(sf);
      if (CLAUDE_START.test(whole.replace(/\$\{[^}]*\}/g, (m) => (m.startsWith("${") && /^\$\{[a-zA-Z]*(permissionMode|posture)[a-zA-Z]*\}$/.test(m) ? m : "")) ) || /claude \$\{permissionMode\}/.test(whole)) {
        // the identifiers interpolated right after `claude `: permissionMode must come from operationalLaunchArg
        const viaVar = /claude \$\{(\w+)\}/.exec(whole);
        const covered = !!viaVar && usesOperational(inits.get(viaVar[1]!) ?? "");
        out.push({ file: rel, line, kind: "classic", text: whole.slice(0, 80), covered });
      }
    }
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && /(^|[\s'"`])claude --[a-z]/.test(n.text) && !/^\s*(\/\/|\*)/.test(n.text)) {
      out.push({ file: rel, line, kind: "classic", text: n.text.slice(0, 80), covered: false });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** True when `name` is `.join(...)`ed, or is the first argument of a spawner call, somewhere in the file. */
function usesLater(sf: ts.SourceFile, name: string): boolean {
  let found = false;
  const v = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const e = n.expression;
      if (ts.isPropertyAccessExpression(e) && e.name.text === "join" && ts.isIdentifier(e.expression) && e.expression.text === name) found = true;
      if (SPAWNERS.test(e.getText(sf)) && n.arguments[0] && ts.isIdentifier(n.arguments[0]) && n.arguments[0].text === name) found = true;
    }
    ts.forEachChild(n, v);
  };
  v(sf);
  return found;
}

const SOURCES = walk(SRC);
// pass 1: the EXPORTED constants that hold the binary anywhere in the tree (so one imported from another file is still known)
function treeNamesFrom(texts: string[]): Names {
  let names: Names = new Set();
  for (let round = 0; round < 3; round++) for (const t of texts) names = claudeNamesIn(t, names, true);
  return names;
}
const TREE_NAMES: Names = treeNamesFrom(SOURCES.map((f) => fs.readFileSync(f, "utf8")));
const all = SOURCES.flatMap((f) => sitesIn(f, TREE_NAMES));
const launchSites = all.filter((s) => !(s.file in NOT_A_LAUNCH));

describe("OF-250 census: every Claude launch command is built through operationalLaunchArg(s), which adds the rig-body guard", () => {
  it("positive control: the walk read the source tree and found the two launch files", () => {
    expect(walk(SRC).length).toBeGreaterThan(300);
    expect([...new Set(launchSites.map((s) => s.file))].sort()).toEqual(["adapters/claude-code-adapter.ts", "adapters/claude-resume.ts"]);
  });

  it("the population is the 7 launch sites: 3 managed (fork, fresh/resume, restore) and 4 classic (fork, resume, fresh, restore)", () => {
    expect(launchSites.filter((s) => s.kind === "managed").map((s) => `${s.file}`).sort()).toEqual(["adapters/claude-code-adapter.ts", "adapters/claude-code-adapter.ts", "adapters/claude-resume.ts"]);
    expect(launchSites.filter((s) => s.kind === "classic").map((s) => `${s.file}`).sort()).toEqual(["adapters/claude-code-adapter.ts", "adapters/claude-code-adapter.ts", "adapters/claude-code-adapter.ts", "adapters/claude-resume.ts"]);
  });

  it("every launch site is built from operationalLaunchArg(s)", () => {
    expect(launchSites.filter((s) => !s.covered).map((s) => `${s.file}:${s.line} ${s.kind} ${s.text}`)).toEqual([]);
  });

  it("the non-launch uses are listed, each with a stated reason", () => {
    const outside = [...new Set(all.filter((s) => s.file in NOT_A_LAUNCH).map((s) => s.file))].sort();
    for (const f of outside) expect(NOT_A_LAUNCH[f]!.length).toBeGreaterThan(20);
    expect(Object.keys(NOT_A_LAUNCH).sort()).toEqual(expect.arrayContaining(outside));
    // The two the OF-250 brief named stay listed whether or not this instrument's shape-match reaches them.
    expect(Object.keys(NOT_A_LAUNCH)).toEqual(expect.arrayContaining(["domain/native-resume-probe.ts", "domain/node-inventory.ts"]));
  });

  it("the instrument sees an uncovered site (negative control)", () => {
    const sf = ts.createSourceFile("x.ts", "const cmd = `claude ${posture} --resume ${t}`; const m = managed.command(['--permission-mode', 'auto', '--resume', t]);", ts.ScriptTarget.Latest, true);
    const found: string[] = [];
    const v = (n: ts.Node): void => { if (ts.isTemplateExpression(n) && CLAUDE_START.test(n.getText(sf))) found.push("classic"); if (ts.isCallExpression(n) && /command$/.test(n.expression.getText(sf))) found.push("managed"); ts.forEachChild(n, v); };
    v(sf);
    expect(found).toEqual(["classic", "managed"]);
  });

  it("OF-252: the spawn and join shapes are in the population: one site today (the `claude --help` probe, listed as a non-launch), no join site", () => {
    expect(all.filter((s) => s.kind === "spawn").map((s) => s.file)).toEqual(["domain/permission-drift-observer.ts"]);
    expect(all.filter((s) => s.kind === "join")).toEqual([]);
    expect(launchSites.filter((s) => s.kind === "spawn" || s.kind === "join")).toEqual([]);
  });

  describe("OF-252 positive and negative controls for the new shapes (the finder run on in-memory source)", () => {
    const find = (src: string) => sitesInText("adapters/zz-new.ts", src);
    it("spawn / execFile / sync and qualified forms of \"claude\" are found, uncovered", () => {
      for (const call of [`spawn("claude", ["--resume", t])`, `cp.spawnSync('claude', args)`, `execFile("claude", ["--resume", t], cb)`, `execFileSync("/opt/homebrew/bin/claude", a)`, `child_process.execSync("claude")`, `fork("claude", [])`]) {
        const sites = find(`const r = ${call};`);
        expect(sites.map((s) => s.kind), call).toEqual(["spawn"]);
        expect(sites[0]!.covered, call).toBe(false);
      }
    });
    it("a [\"claude\", ...].join(\" \") command line is found, uncovered", () => {
      const sites = find(`const cmd = ["claude", "--resume", token].join(" ");`);
      expect(sites.map((s) => s.kind)).toEqual(["join"]);
      expect(sites[0]!.covered).toBe(false);
    });
    it("a spawn or join built from operationalLaunchArgs counts as covered", () => {
      expect(find(`spawn("claude", operationalLaunchArgs(choice, [x]))`).map((s) => s.covered)).toEqual([true]);
      expect(find(`["claude", ...operationalLaunchArgs(c, [])].join(" ")`).map((s) => s.covered)).toEqual([true]);
    });
    it("negative controls: other programs, a bare claude array that is not joined, a join without claude first", () => {
      expect(find(`spawn("git", ["status"]); execFile("node", ["x"]); const m = ["claude", MANIFEST]; const o = ["x", "claude"].join(" "); const t = ["a", "b"].map(f);`)).toEqual([]);
    });
  });

  describe("OF-258 positive and negative controls for the shapes the OF-252 finder was blind to (the finder run on in-memory source)", () => {
    const find = (src: string, tree: Names = new Set()) => sitesInText("adapters/zz-new.ts", src, tree);
    const kinds = (src: string, tree?: Names) => find(src, tree).map((s) => `${s.kind}:${s.covered}`);

    // one `it` per fixture, so a mutant's kill set says which shape it removed
    const B_CASES: Array<[string, Names?]> = [
      [`const CLAUDE_BIN = "claude"; spawn(CLAUDE_BIN, ["--resume", t]);`],
      [`const A = "/opt/homebrew/bin/claude"; const B = A; execFile(B, args, cb);`],
      [`function run(bin = "claude") { return spawnSync(bin, ["--resume", t]); }`],
      [`const cfg = { bin: "claude" }; spawn(cfg.bin, ["--resume", t]);`],
      [`class L { private bin = "claude"; go() { fork(this.bin, []); } }`],
      [`const h = {}; h.exe = "claude"; execFileSync(h.exe, a);`],
      [`spawn(CLAUDE_BIN, ["--resume", t]);`, new Set(["CLAUDE_BIN"])],
    ];
    for (const [n, [src, tree]] of B_CASES.entries()) it(`(b${n}) a binary held in a name: ${src}`, () => { expect(kinds(src, tree)).toEqual(["spawn:false"]); });
    const C_CASES = [
      `spawn(useIt ? "claude" : other, ["--resume", t]);`,
      `spawn(useIt ? other : "claude", args);`,
      `spawn(override ?? "claude", args);`,
      `spawn(process.env.CLAUDE_BIN || "claude", args);`,
      `spawn((x ? "claude" : y) as string, args);`,
      `const bin = ok ? "claude" : "fallback"; execFile(bin, args);`,
    ];
    for (const [n, src] of C_CASES.entries()) it(`(c${n}) a conditional or defaulted "claude": ${src}`, () => { expect(kinds(src)).toEqual(["spawn:false"]); });
    const D_CASES: Array<[string, string]> = [
      [`Bun.spawn(["claude", "--resume", t]);`, "spawn:false"],
      [`Bun.spawnSync(["claude", ...rest]);`, "spawn:false"],
      [`Bun.spawn({ cmd: ["claude", "--resume", t], cwd });`, "spawn:false"],
      [`const B = "claude"; Bun.spawn([B, "--resume", t]);`, "spawn:false"],
      [`Bun.spawn([ok ? "claude" : x, t]);`, "spawn:false"],
      [`Bun.spawn(["claude", ...operationalLaunchArgs(choice, [x])]);`, "spawn:true"],
      [`Bun.spawn({ cmd: ["claude", ...operationalLaunchArgs(choice, [x])] });`, "spawn:true"],
    ];
    for (const [n, [src, want]] of D_CASES.entries()) it(`(d${n}) Bun.spawn, the command an array or { cmd }: ${src}`, () => { expect(kinds(src)).toEqual([want]); });
    const E_CASES: Array<[string, string]> = [
      [`const parts = ["claude", "--resume", t]; run(parts.join(" "));`, "join:false"],
      [`const argv = ["claude", "--resume", t]; Bun.spawn(argv);`, "join:false"],
      [`const argv = ["claude", "--resume", t]; execa(argv);`, "join:false"],
      [`const B = "claude"; const parts = [B, "--resume", t]; const line = parts.join(" ");`, "join:false"],
      [`const parts = [bin ?? "claude", t]; send(parts.join(" "));`, "join:false"],
      [`const parts = ["claude", ...operationalLaunchArgs(c, [])]; send(parts.join(" "));`, "join:true"],
    ];
    for (const [n, [src, want]] of E_CASES.entries()) it(`(e${n}) an array starting with the binary, joined or spawned later: ${src}`, () => { expect(kinds(src)).toEqual([want]); });
    // F5: the receiver of spawn / execFile / spawnSync / fork / execa-style calls is not restricted; only .exec (a RegExp or a db handle too) is
    const R_CASES = [`this.deps.spawn("claude", ["--resume", t]);`, `ctx.execFile("claude", args, cb);`, `deps.child.spawnSync("claude", args);`, `const CLAUDE = "claude"; this.runner.fork(CLAUDE, []);`, `cp.exec("claude");`];
    for (const [n, src] of R_CASES.entries()) it(`(r${n}) any receiver on a spawner call: ${src}`, () => { expect(kinds(src)).toEqual(["spawn:false"]); });
    it("(r5) .exec on a RegExp, a db handle or this is not a spawner, whatever it is given", () => {
      expect(find(`const c = "claude"; RE.exec(c); db.exec(c); this.exec(c); /x/.exec(c);`)).toEqual([]);
    });
    // F6: the tree-wide pass, factored so it can be fed in-memory files (the real tree holds no exported claude constant)
    it("(t0) an exported constant in one file is a name in another, in either file order, through an alias in a third", () => {
      const a = `export const CLAUDE_BIN = "claude";`;
      const b = `import { CLAUDE_BIN } from "./a"; export const ALIAS = CLAUDE_BIN;`;
      const c = `import { ALIAS } from "./b"; spawn(ALIAS, ["--resume", t]);`;
      for (const order of [[a, b, c], [c, b, a]]) {
        const names = treeNamesFrom(order);
        expect([...names].sort()).toEqual(["ALIAS", "CLAUDE_BIN"]);
        expect(sitesInText("adapters/zz-c.ts", c, names).map((s) => s.kind)).toEqual(["spawn"]);
      }
    });
    it("(t1) the tree pass takes exported constants only", () => {
      expect([...treeNamesFrom([`const LOCAL = "claude"; export const OTHER = 1;`, `const o = { bin: "claude" };`])]).toEqual([]);
    });
    it("(l) documented limit: a property read of a claude-holding object is not followed through a second name (the chain reaches every `x.runtime`, so it is not followed)", () => {
      expect(kinds(`const cfg = { bin: "claude" }; const b2 = cfg.bin; execFile(b2, args);`)).toEqual([]);
      expect(kinds(`const cfg = { bin: "claude" }; execFile(cfg.bin, args);`)).toEqual(["spawn:false"]);
    });
    it("(n) negative controls: RegExp.exec, a runtime-name array never joined or spawned, a constant that is never spawned, other binaries", () => {
      expect(find(`const RE = /^x$/; RE.exec(text); const c = "claude"; RE.exec(c); /a/.exec(b); const runtime = "claude"; if (runtime === "claude") go(); const names = ["claude", "codex"]; names.map(f); const parts = ["claude", "x"]; use(parts); spawn(flag ? "git" : "tmux", a); const g = "git"; execFile(g, a); Bun.spawn(["git", "status"]);`)).toEqual([]);
    });
  });

  it("operationalLaunchArgs is where the guard is added, in the fixed order (native inbox first)", () => {
    const text = fs.readFileSync(nodePath.join(SRC, "adapters", "kernel-authority.ts"), "utf8");
    expect(text).toMatch(/return withRigBodyGuard\(choice\.nativeInbox \? withNativeInboxSettings\(args\) : args, choice\.rigBodyGuardScript\);/);
  });

  it("both launch adapters refuse before building a command when the hook script is missing", () => {
    for (const f of ["adapters/claude-code-adapter.ts", "adapters/claude-resume.ts"]) {
      const text = fs.readFileSync(nodePath.join(SRC, f), "utf8");
      expect(text, f).toContain("claudeRigBodyGuardRefusal(");
      expect(text.indexOf("claudeRigBodyGuardRefusal("), `${f}: the refusal precedes the first command`).toBeLessThan(text.search(/managed \? managed\.command\(/));
    }
  });
});

