/**
 * FORK-OWNED (jimallen/openrig; not in upstream mvschwarz/openrig). OF-223: the hexagonal boundary of the daemon's domain.
 * The rule, and the merge procedure, are in local/architecture/hexagonal-boundary.md. The census test is
 * test/fork-hexagonal-boundary.test.ts; the baseline is local/architecture/hexagonal-baseline.txt.
 *
 * Instrument: the TypeScript compiler's parser over every *.ts file under packages/daemon/src/domain (a positional
 * predicate: the folder, not a list of files). Only syntax that loads or names a module is read, so a module name that
 * appears in a string, a template or a comment is never counted. Forms read:
 *   static `import`, side-effect `import "x"`, `import type`, inline `type` specifiers, `export ... from`,
 *   `export * from`, `import x = require("x")`, dynamic `import("x")`, `require("x")`, and the type-position
 *   `import("x").T`. A dynamic import or require whose argument is not a string literal cannot be resolved; it is
 *   reported as `unresolved` so the census can pin that there are none.
 *
 * A violation is one (file, target, kind) triple; several statements of the same kind collapse into one, so a baseline
 * line survives edits that only move or split statements.
 *
 * Run as a script (from the repository root) for the merge procedure:
 *   node --import tsx packages/daemon/test/helpers/fork-hexagonal-boundary.ts check
 *   node --import tsx packages/daemon/test/helpers/fork-hexagonal-boundary.ts sync [--upstream origin/main]
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
export const DAEMON_ROOT = path.join(REPO_ROOT, "packages/daemon");
export const DOMAIN_DIR = "src/domain";
export const BASELINE_PATH = path.join(REPO_ROOT, "local/architecture/hexagonal-baseline.txt");
export const RULE_DOC = "local/architecture/hexagonal-boundary.md";
export const SYNC_COMMAND = "node --import tsx packages/daemon/test/helpers/fork-hexagonal-boundary.ts sync";

export type ImportKind = "value" | "type";
export type ImportForm = "import" | "import-type" | "export-from" | "import-equals" | "dynamic-import" | "require" | "type-position-import";
export interface ImportEdge { specifier: string; kind: ImportKind; form: ImportForm; line: number }
export interface UnresolvedImport { form: "dynamic-import" | "require"; line: number; text: string }

/** Every module a source file loads or names, by syntax. Strings and comments are never read as imports. */
export function scanImports(fileName: string, source: string): { edges: ImportEdge[]; unresolved: UnresolvedImport[] } {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const edges: ImportEdge[] = [];
  const unresolved: UnresolvedImport[] = [];
  const lineOf = (node: ts.Node): number => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const add = (spec: ts.Node, kind: ImportKind, form: ImportForm, at: ts.Node): void => {
    if (ts.isStringLiteralLike(spec)) edges.push({ specifier: spec.text, kind, form, line: lineOf(at) });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      // `import "x"` loads x; `import type` loads nothing; `import { type A, type B }` is elided (isolatedModules, no
      // verbatimModuleSyntax in tsconfig.base.json), so it names x only for the type checker.
      let kind: ImportKind = "value";
      if (clause?.isTypeOnly) kind = "type";
      else if (clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings)
        && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every((e) => e.isTypeOnly)) kind = "type";
      add(node.moduleSpecifier, kind, kind === "type" ? "import-type" : "import", node);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const clause = node.exportClause;
      const allTypes = node.isTypeOnly || (clause !== undefined && ts.isNamedExports(clause) && clause.elements.length > 0 && clause.elements.every((e) => e.isTypeOnly));
      add(node.moduleSpecifier, allTypes ? "type" : "value", "export-from", node);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression, node.isTypeOnly ? "type" : "value", "import-equals", node);
    } else if (ts.isImportTypeNode(node)) {
      const arg = node.argument;
      if (ts.isLiteralTypeNode(arg)) add(arg.literal, "type", "type-position-import", node);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const form = callee.kind === ts.SyntaxKind.ImportKeyword ? "dynamic-import" : ts.isIdentifier(callee) && callee.text === "require" ? "require" : null;
      if (form !== null) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteralLike(arg)) add(arg, "value", form, node);
        else unresolved.push({ form, line: lineOf(node), text: node.getText(sf).slice(0, 120) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { edges, unresolved };
}

/** Infrastructure modules the domain may not import, by the name the scan normalises a specifier to. */
export const INFRASTRUCTURE_MODULES: ReadonlySet<string> = new Set([
  "better-sqlite3", "node:fs", "node:fs/promises", "node:child_process", "node:net", "node:http", "node:os",
]);

export type BoundaryRule = "domain-imports-adapter" | "domain-imports-db" | "domain-imports-infrastructure";

/** `fs` and `node:fs` are one module; a subpath of better-sqlite3 is better-sqlite3. */
export function normaliseBareSpecifier(spec: string): string {
  if (spec === "better-sqlite3" || spec.startsWith("better-sqlite3/")) return "better-sqlite3";
  return spec.startsWith("node:") ? spec : `node:${spec}`;
}

/**
 * The target of an edge, relative to packages/daemon, and the rule it breaks; null when the edge is allowed.
 * `file` is relative to packages/daemon (`src/domain/x.ts`).
 */
export function classifyEdge(file: string, specifier: string): { target: string; rule: BoundaryRule } | null {
  if (specifier.startsWith(".")) {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
    if (target === "src/adapters" || target.startsWith("src/adapters/")) return { target, rule: "domain-imports-adapter" };
    if (target === "src/db" || target.startsWith("src/db/")) return { target, rule: "domain-imports-db" };
    return null;
  }
  const bare = normaliseBareSpecifier(specifier);
  return INFRASTRUCTURE_MODULES.has(bare) ? { target: bare, rule: "domain-imports-infrastructure" } : null;
}

export interface Violation { file: string; target: string; kind: ImportKind; rule: BoundaryRule; lines: number[]; forms: ImportForm[] }
export const violationKey = (v: { file: string; target: string; kind: ImportKind }): string => `${v.file} ${v.target} ${v.kind}`;

/** The violations in one domain file's source. */
export function violationsInSource(file: string, source: string): { violations: Violation[]; unresolved: UnresolvedImport[] } {
  const { edges, unresolved } = scanImports(file, source);
  const byKey = new Map<string, Violation>();
  for (const edge of edges) {
    const hit = classifyEdge(file, edge.specifier);
    if (!hit) continue;
    const v = { file, target: hit.target, kind: edge.kind, rule: hit.rule, lines: [] as number[], forms: [] as ImportForm[] };
    const existing = byKey.get(violationKey(v)) ?? v;
    existing.lines.push(edge.line);
    if (!existing.forms.includes(edge.form)) existing.forms.push(edge.form);
    byKey.set(violationKey(v), existing);
  }
  return { violations: [...byKey.values()], unresolved };
}

/** Every *.ts file under src/domain, relative to packages/daemon, sorted. */
export function listDomainFiles(daemonRoot = DAEMON_ROOT): string[] {
  const walk = (rel: string): string[] => readdirSync(path.join(daemonRoot, rel), { withFileTypes: true }).flatMap((e) => {
    const child = path.posix.join(rel, e.name);
    return e.isDirectory() ? walk(child) : e.isFile() && e.name.endsWith(".ts") ? [child] : [];
  });
  return walk(DOMAIN_DIR).sort();
}

export interface DomainScan { files: string[]; violations: Violation[]; unresolved: Array<UnresolvedImport & { file: string }>; statements: number }

export function scanDomain(daemonRoot = DAEMON_ROOT): DomainScan {
  const files = listDomainFiles(daemonRoot);
  const violations: Violation[] = [];
  const unresolved: Array<UnresolvedImport & { file: string }> = [];
  let statements = 0;
  for (const file of files) {
    const result = violationsInSource(file, readFileSync(path.join(daemonRoot, file), "utf8"));
    violations.push(...result.violations);
    statements += result.violations.reduce((n, v) => n + v.lines.length, 0);
    unresolved.push(...result.unresolved.map((u) => ({ ...u, file })));
  }
  violations.sort((a, b) => violationKey(a).localeCompare(violationKey(b)));
  return { files, violations, unresolved, statements };
}

// ---- the baseline -------------------------------------------------------------------------------------------------

export type Origin = "upstream" | "fork";
export interface BaselineEntry { file: string; target: string; kind: ImportKind; origin: Origin; lineNo: number }

const BASELINE_LINE = /^(\S+) (\S+) (value|type) (upstream|fork)$/;

/** Parses the baseline; a malformed, duplicate or out-of-order line throws, naming the line. */
export function parseBaseline(text: string): BaselineEntry[] {
  const entries: BaselineEntry[] = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.trimEnd();
    if (line === "" || line.startsWith("#")) return;
    const m = BASELINE_LINE.exec(line);
    if (!m) throw new Error(`${path.relative(REPO_ROOT, BASELINE_PATH)}:${i + 1}: malformed line (want "<file> <target> <value|type> <upstream|fork>"): ${line}`);
    const entry: BaselineEntry = { file: m[1]!, target: m[2]!, kind: m[3] as ImportKind, origin: m[4] as Origin, lineNo: i + 1 };
    const prev = entries[entries.length - 1];
    if (prev && violationKey(prev).localeCompare(violationKey(entry)) >= 0) {
      throw new Error(`${path.relative(REPO_ROOT, BASELINE_PATH)}:${i + 1}: out of order or duplicate (lines are sorted by "<file> <target> <kind>", one per triple): ${line}`);
    }
    entries.push(entry);
  });
  return entries;
}

export const BASELINE_HEADER = [
  "# FORK-OWNED. OF-223 hexagonal-boundary baseline: the domain's known imports of adapters, src/db and infrastructure modules.",
  "# The rule and the merge procedure: local/architecture/hexagonal-boundary.md. Checked by packages/daemon/test/fork-hexagonal-boundary.test.ts.",
  "# One line per violation: <file under packages/daemon> <target> <value|type> <upstream|fork>, sorted. This file only shrinks,",
  "# except that the sync command adds violations an upstream merge brought in (marked upstream). Never add a fork line by hand.",
];

export function formatBaseline(entries: ReadonlyArray<Omit<BaselineEntry, "lineNo">>): string {
  const sorted = [...entries].sort((a, b) => violationKey(a).localeCompare(violationKey(b)));
  return [...BASELINE_HEADER, ...sorted.map((e) => `${e.file} ${e.target} ${e.kind} ${e.origin}`)].join("\n") + "\n";
}

export interface Comparison {
  /** In the tree, not in the baseline: a new violation. */
  added: Violation[];
  /** In the baseline, gone from the tree: the line must go. */
  stale: BaselineEntry[];
  /** Baseline says value; the tree now has only a type import of that target: the line must say type. */
  tightened: BaselineEntry[];
}

export function compareToBaseline(violations: readonly Violation[], baseline: readonly BaselineEntry[]): Comparison {
  const have = new Map(violations.map((v) => [violationKey(v), v]));
  const allowed = new Set(baseline.map(violationKey));
  const added = violations.filter((v) => !allowed.has(violationKey(v)));
  const stale: BaselineEntry[] = [];
  const tightened: BaselineEntry[] = [];
  for (const entry of baseline) {
    if (have.has(violationKey(entry))) continue;
    // Tighten only when the type triple is not recorded already; otherwise the value line simply goes.
    const typeKey = violationKey({ ...entry, kind: "type" });
    if (entry.kind === "value" && have.has(typeKey) && !allowed.has(typeKey)) tightened.push(entry);
    else stale.push(entry);
  }
  return { added, stale, tightened };
}

const RULE_TEXT: Record<BoundaryRule, string> = {
  "domain-imports-adapter": "the domain imports an adapter (src/adapters)",
  "domain-imports-db": "the domain imports src/db",
  "domain-imports-infrastructure": "the domain imports an infrastructure module",
};

export function describeComparison(c: Comparison): string {
  const out: string[] = [];
  if (c.added.length > 0) {
    out.push(`${c.added.length} NEW hexagonal-boundary violation(s) (rule: ${RULE_DOC}):`);
    for (const v of c.added) out.push(`  packages/daemon/${v.file}:${v.lines.join(",")} imports ${v.target} (${v.kind}${v.kind === "type" ? "-only" : ""}; ${v.forms.join(", ")}) - ${RULE_TEXT[v.rule]}`);
    out.push(
      "  To fix one you wrote: declare what the domain needs as a port (an interface or type) in src/domain, implement it in",
      "  src/adapters, and wire the adapter in src/startup.ts; a domain service takes the port in its constructor. Do not add",
      "  the line to the baseline.",
      `  If an upstream merge brought it in, run \`${SYNC_COMMAND}\`: it adds only the violations an upstream copy of the`,
      "  file (origin/main's or the merge base's, following renames) also has, marked upstream, and refuses the rest.",
    );
  }
  if (c.stale.length > 0) {
    out.push(`${c.stale.length} STALE baseline line(s) in local/architecture/hexagonal-baseline.txt: the violation is gone, so delete the line (or run \`${SYNC_COMMAND}\`, which prunes them):`);
    for (const e of c.stale) out.push(`  line ${e.lineNo}: ${e.file} ${e.target} ${e.kind} ${e.origin}${e.origin === "upstream" ? " (upstream removed it)" : ""}`);
  }
  if (c.tightened.length > 0) {
    out.push(`${c.tightened.length} baseline line(s) can be TIGHTENED: the import is now type-only, so change "value" to "type" (or run \`${SYNC_COMMAND}\`):`);
    for (const e of c.tightened) out.push(`  line ${e.lineNo}: ${e.file} ${e.target} ${e.kind} ${e.origin}`);
  }
  return out.join("\n");
}

// ---- upstream attribution (the merge procedure) -------------------------------------------------------------------

const KIND_RANK: Record<ImportKind, number> = { type: 0, value: 1 };

/**
 * Upstream owns a violation when ANY of the upstream copies of the same file (the upstream ref, and the merge base the
 * fork last took from it) has the same target at the same or a stronger kind (value is stronger than type). The merge
 * base matters before a merge: upstream may since have removed a violation the fork still carries from it. A path no
 * upstream copy has is fork-only, so its violations are the fork's. Reads each upstream blob and scans it with the same
 * parser; no blame, so a reformatted or moved line still matches.
 */
/** The upstream copies of a fork file: each with the path it has upstream, so its relative imports resolve from there. */
export type UpstreamCopies = (file: string) => Array<{ path: string; text: string }>;

export function attributeToUpstream(violations: readonly Violation[], ...upstreamSources: UpstreamCopies[]): { upstream: Violation[]; fork: Violation[] } {
  const upstream: Violation[] = [];
  const fork: Violation[] = [];
  const cache = new Map<string, Violation[]>();
  for (const v of violations) {
    if (!cache.has(v.file)) {
      cache.set(v.file, upstreamSources.flatMap((source) => source(v.file).flatMap((copy) => violationsInSource(copy.path, copy.text).violations)));
    }
    const owned = cache.get(v.file)!.some((u) => u.target === v.target && KIND_RANK[u.kind] >= KIND_RANK[v.kind]);
    (owned ? upstream : fork).push(v);
  }
  return { upstream, fork };
}

/** `git show <ref>:packages/daemon/<file>`, or null when the ref has no such path. */
export function gitUpstreamSource(ref: string, repoRoot = REPO_ROOT): (file: string) => string | null {
  return (file) => {
    try {
      return execFileSync("git", ["-C", repoRoot, "show", `${ref}:packages/daemon/${file}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
    } catch {
      return null;
    }
  };
}

/**
 * The renames git detects between two commits under packages/daemon/src (`git diff -M`, the same default similarity a
 * merge uses), as old path -> new path relative to packages/daemon.
 */
export function gitRenames(from: string, to: string, repoRoot = REPO_ROOT): Map<string, string> {
  const out = execFileSync("git", ["-C", repoRoot, "diff", "-M", "--name-status", "--diff-filter=R", from, to, "--", "packages/daemon/src"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  const renames = new Map<string, string>();
  for (const line of out.split("\n")) {
    const [status, oldPath, newPath] = line.split("\t");
    if (status?.startsWith("R") && oldPath && newPath) renames.set(oldPath.replace(/^packages\/daemon\//, ""), newPath.replace(/^packages\/daemon\//, ""));
  }
  return renames;
}

/**
 * The upstream copies of a fork file, following renames: the same path, the path the file had at the merge base when the
 * fork renamed it, and the path upstream moved that file to. Measured at eb2fe398: the fork renamed
 * src/domain/claim-service.ts to src/domain/session-reconciler.ts, and a merge of origin/main puts upstream's
 * claim-service.ts changes into session-reconciler.ts; by path alone they read as the fork's.
 */
export function gitUpstreamSources(sha: string, base: string, repoRoot = REPO_ROOT): UpstreamCopies[] {
  const forkRenamedFrom = new Map([...gitRenames(base, "HEAD", repoRoot)].map(([oldPath, newPath]) => [newPath, oldPath]));
  const upstreamRenamedTo = gitRenames(base, sha, repoRoot);
  const atSha = gitUpstreamSource(sha, repoRoot);
  const atBase = gitUpstreamSource(base, repoRoot);
  const paths = (file: string): string[] => {
    const before = forkRenamedFrom.get(file) ?? file;
    return [...new Set([file, before, upstreamRenamedTo.get(before) ?? before])];
  };
  const copies = (read: (file: string) => string | null): UpstreamCopies => (file) =>
    paths(file).flatMap((p) => { const text = read(p); return text === null ? [] : [{ path: p, text }]; });
  return [copies(atSha), copies(atBase)];
}

function verifyRef(ref: string): string {
  try {
    return execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "--verify", `${ref}^{commit}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    throw new Error(`upstream ref ${ref} does not resolve; run \`git fetch origin\` first (origin is mvschwarz/openrig)`);
  }
}

/** The upstream ref's sha and the merge base of HEAD with it; the two are the same commit right after a merge of the ref. */
function upstreamCommits(ref: string): { sha: string; base: string } {
  const sha = verifyRef(ref);
  const base = execFileSync("git", ["-C", REPO_ROOT, "merge-base", "HEAD", sha], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  return { sha, base };
}

function main(argv: string[]): number {
  const [command = "check", ...rest] = argv;
  const flag = (name: string): string | undefined => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  const scan = scanDomain();
  const baselineText = (() => { try { return readFileSync(BASELINE_PATH, "utf8"); } catch { return null; } })();
  console.log(`scanned ${scan.files.length} domain files; ${scan.violations.length} violations (${scan.statements} statements)`);
  if (scan.unresolved.length > 0) {
    for (const u of scan.unresolved) console.log(`  unresolvable ${u.form} at packages/daemon/${u.file}:${u.line}: ${u.text}`);
  }

  if (command === "check") {
    if (baselineText === null) { console.error(`no baseline at ${BASELINE_PATH}`); return 2; }
    const c = compareToBaseline(scan.violations, parseBaseline(baselineText));
    const message = describeComparison(c);
    if (message) { console.error(message); return 1; }
    console.log("baseline matches the tree");
    return 0;
  }

  if (command === "init") {
    if (baselineText !== null) { console.error(`refusing: ${BASELINE_PATH} exists (init seeds a baseline once; use sync)`); return 2; }
    const ref = flag("--upstream") ?? "origin/main";
    const { sha, base } = upstreamCommits(ref);
    const { upstream, fork } = attributeToUpstream(scan.violations, ...gitUpstreamSources(sha, base));
    writeFileSync(BASELINE_PATH, formatBaseline([...upstream.map((v) => ({ ...v, origin: "upstream" as const })), ...fork.map((v) => ({ ...v, origin: "fork" as const }))]));
    console.log(`seeded against ${ref} (${sha}) and the merge base (${base}): ${upstream.length} upstream, ${fork.length} fork`);
    return 0;
  }

  if (command === "sync") {
    if (baselineText === null) { console.error(`no baseline at ${BASELINE_PATH}`); return 2; }
    const ref = flag("--upstream") ?? "origin/main";
    const { sha, base } = upstreamCommits(ref);
    const baseline = parseBaseline(baselineText);
    const c = compareToBaseline(scan.violations, baseline);
    const { upstream, fork } = attributeToUpstream(c.added, ...gitUpstreamSources(sha, base));
    const gone = new Set([...c.stale, ...c.tightened].map(violationKey));
    const kept = baseline.filter((e) => !gone.has(violationKey(e)));
    const tightened = c.tightened.map((e) => ({ ...e, kind: "type" as const }));
    // A tightened line's type triple may also be in `added`; it is written once, through `tightened`.
    const tightenedKeys = new Set(tightened.map(violationKey));
    const addedUpstream = upstream.filter((v) => !tightenedKeys.has(violationKey(v))).map((v) => ({ ...v, origin: "upstream" as const }));
    const refused = fork.filter((v) => !tightenedKeys.has(violationKey(v)));
    writeFileSync(BASELINE_PATH, formatBaseline([...kept, ...tightened, ...addedUpstream]));
    console.log(`against ${ref} (${sha}) and the merge base (${base}): pruned ${c.stale.length} stale, tightened ${c.tightened.length}, added ${addedUpstream.length} upstream`);
    for (const e of c.stale) console.log(`  pruned   ${e.file} ${e.target} ${e.kind} ${e.origin}`);
    for (const e of tightened) console.log(`  tightened ${e.file} ${e.target} value -> type`);
    for (const v of addedUpstream) console.log(`  added    ${v.file} ${v.target} ${v.kind} upstream`);
    if (refused.length > 0) {
      console.error(describeComparison({ added: refused, stale: [], tightened: [] }));
      console.error(`${refused.length} violation(s) above are in no upstream copy of the file (${ref} or the merge base, following renames), so they are fork-authored and were NOT added.`);
      return 1;
    }
    return 0;
  }

  console.error("usage: fork-hexagonal-boundary.ts check | sync [--upstream <ref>] | init [--upstream <ref>]");
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
