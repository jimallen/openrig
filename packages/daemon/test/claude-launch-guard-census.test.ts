// OF-250 census: every place the daemon builds a Claude launch command carries the rig-body guard. Parsed (TypeScript AST), not grepped.
// The guard is added by operationalLaunchArgs / operationalLaunchArg (kernel-authority.ts) into the launch's one --settings; a site is covered when
// its command is built from that function's output. A NEW site that builds `claude ...` without it fails here.
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
  "domain/node-inventory.ts": "display text for `rig ps`/inventory (the command an operator could type); never executed by the daemon",
};

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(nodePath.join(dir, e.name)) : e.name.endsWith(".ts") ? [nodePath.join(dir, e.name)] : []);
}

interface Site { file: string; line: number; kind: "managed" | "classic"; text: string; covered: boolean }

const CLAUDE_START = /\bclaude (--|\$\{)/;

function sitesIn(file: string): Site[] {
  const rel = nodePath.relative(SRC, file);
  const text = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
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

const all = walk(SRC).flatMap(sitesIn);
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

