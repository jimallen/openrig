/**
 * Static scan for tmux execs in non-test source (hc cutover W8; census-hc-tmux section 4, layer 1).
 *
 * Parses with the TypeScript compiler API and flags by POSITION, not by a list of verbs. A finding is one of:
 *  1. `command-string`   a string literal, no-substitution template, or the head of a template whose text starts with
 *                        `tmux` followed by whitespace and an argument (`"tmux -V"`, `` `tmux send-keys ${x}` ``,
 *                        `"ssh host tmux ..."` is NOT matched: only a string that begins with the command).
 *                        A bare `"tmux"` is vocabulary (`attachment_type`, a provider name) and is not rule 1; it is a
 *                        finding only in the exec positions of rules 2 and 3. Deviation from the census wording
 *                        (`^\s*tmux(\s|$)`), made so the persisted word is not counted as an exec.
 *  2. `argv-array`       an array literal whose first element is the string `tmux` or a path whose basename is `tmux`.
 *  3. `exec-call`        a call to exec/execSync/execFile/execFileSync/spawn/spawnSync/execa/run/execCommand/
 *                        execArgvCommand (as a bare name or a property) whose first argument is `tmux` or ends in `/tmux`.
 *  4. `tmux-import`      an import/export/dynamic import of `adapters/tmux*`, or an import of the name `TmuxAdapter`.
 *
 * Rules 1 is skipped for files under `db/migrations/` (migration history keeps the word and the SQL default `'tmux'`);
 * rules 2 to 4 still apply there.
 *
 * Not caught, by construction: a command assembled at run time (`const bin = cfg.bin; spawn(bin)`), a `tmux` reached only
 * through a config string, and any code a test never imports (this is a static scan of every file, so the last one is not a
 * gap here, but the first two are). The census's dynamic layer (a PATH shim) is not built in this package.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

export type TmuxExecRule = "command-string" | "argv-array" | "exec-call" | "tmux-import";
export interface TmuxExecFinding { rule: TmuxExecRule; file: string; line: number; text: string }

export const EXEC_CALLEES: ReadonlySet<string> = new Set([
  "exec", "execSync", "execFile", "execFileSync", "spawn", "spawnSync", "execa", "run", "execCommand", "execArgvCommand",
]);

const isTmuxProgram = (value: string): boolean => value === "tmux" || value.endsWith("/tmux");
const isTmuxAdapterModule = (value: string): boolean => /(^|\/)adapters\/tmux[^/]*$/.test(value);

function staticText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text;
  return null;
}

export function scanTmuxExecs(fileName: string, source: string): TmuxExecFinding[] {
  const kind = /\.(tsx|jsx)$/.test(fileName) ? ts.ScriptKind.TSX : /\.(js|mjs)$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const inMigrations = /(^|\/)db\/migrations\//.test(fileName.split(path.sep).join("/"));
  const out: TmuxExecFinding[] = [];
  const add = (rule: TmuxExecRule, node: ts.Node): void => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    out.push({ rule, file: fileName, line, text: node.getText(sf).slice(0, 120) });
  };

  const visit = (node: ts.Node): void => {
    // Rule 1. Template heads inside a TemplateExpression are visited through the expression itself, never separately.
    if (!inMigrations && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node))) {
      const text = staticText(node);
      if (text !== null && /^\s*tmux\s+\S/.test(text)) add("command-string", node);
    }
    // Rule 2.
    if (ts.isArrayLiteralExpression(node) && node.elements.length > 0) {
      const first = node.elements[0]!;
      const text = staticText(first);
      if (text !== null && isTmuxProgram(text.trim())) add("argv-array", node);
    }
    // Rule 3.
    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
      if (name !== null && EXEC_CALLEES.has(name)) {
        const text = staticText(node.arguments[0]!);
        if (text !== null && isTmuxProgram(text.trim())) add("exec-call", node);
      }
      // Rule 4, dynamic form.
      if (callee.kind === ts.SyntaxKind.ImportKeyword) {
        const text = staticText(node.arguments[0]!);
        if (text !== null && isTmuxAdapterModule(text)) add("tmux-import", node);
      }
    }
    // Rule 4, static forms.
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (isTmuxAdapterModule(node.moduleSpecifier.text)) add("tmux-import", node);
    }
    if (ts.isImportSpecifier(node) && (node.propertyName ?? node.name).text === "TmuxAdapter") add("tmux-import", node);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const SOURCE_EXT = /\.(ts|tsx|js|mjs)$/;
const isTestFile = (rel: string): boolean =>
  /\.(test|spec)\.[a-z]+$/.test(rel) || /(^|\/)(test|tests|__tests__)\//.test(rel);

/** Every non-test source file under `<repoRoot>/packages/<pkg>/src`, as repo-relative posix paths. */
export function listSourceFiles(repoRoot: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (SOURCE_EXT.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        const rel = path.relative(repoRoot, full).split(path.sep).join("/");
        if (!isTestFile(rel)) files.push(rel);
      }
    }
  };
  const packages = path.join(repoRoot, "packages");
  for (const pkg of fs.readdirSync(packages, { withFileTypes: true })) {
    const src = path.join(packages, pkg.name, "src");
    if (pkg.isDirectory() && fs.existsSync(src)) walk(src);
  }
  return files.sort();
}

export function scanTree(repoRoot: string): { files: number; findings: TmuxExecFinding[] } {
  const files = listSourceFiles(repoRoot);
  const findings = files.flatMap((rel) => scanTmuxExecs(rel, fs.readFileSync(path.join(repoRoot, rel), "utf8")));
  return { files: files.length, findings };
}
