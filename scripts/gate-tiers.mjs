#!/usr/bin/env node
// Tiered gates: run the cheap checks first, and never start an expensive run before they have passed at the same
// commit (workspaces-o9o.41). Usage, from anywhere inside the worktree you are handing over:
//
//   node scripts/gate-tiers.mjs --tier 0 --base main     # diff hygiene: seconds
//   node scripts/gate-tiers.mjs --tier 1 --base main     # npm run lint: about a minute
//   node scripts/gate-tiers.mjs --tier 2 --base main     # test:repo + every package test the diff reaches
//   node scripts/gate-tiers.mjs --tier 3 --base main -- <command...>   # the full suite (default: npm test)
//   node scripts/gate-tiers.mjs --tier 2 --base main --list            # print the tier-2 selection only
//
// Each passing tier writes a receipt for HEAD and the merge base. A tier refuses to start without passing receipts
// for every tier below it at the same HEAD and merge base, so the full suite never starts on a commit that fails a
// cheap check. Receipts live in the clone's git directory, shared by all its worktrees, so a fast-forward merge of a
// reviewed commit finds that commit's receipts. docs/as-built/test-layers.md describes the tiers and when each one
// is required.
//
// Exit codes: 0 the tier passed, 1 it ran and failed, 2 it refused to start (dirty tree, missing receipt), 64 usage.
import { spawn, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { cpus, loadavg, tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { addedLines, CHECKS } from "./portability-report.mjs";

export const EXIT = { pass: 0, failed: 1, refused: 2, usage: 64 };
// The packages `npm run test:workspaces` runs. The web UI suite is advisory and stays out, as in `npm test`.
export const SUITE_PACKAGES = ["daemon", "cli", "tui"];
export const T2_MAX_WORKERS = 4;
export const DEFAULT_T3_COMMAND = ["npm", "test"];
const RECEIPT_SCHEMA = 1;

const CODE_FILE = /\.(?:[cm]?[jt]sx?|py|swift)$/;
const TSCONFIG_FILE = /(?:^|\/)tsconfig[^/]*\.json$/;
const TEST_FILE = /\.test\.tsx?$/;
// A test in any language (scripts/*.test.mjs, a .test.js): never production source, never a changed file's name stem
// (workspaces-o9o.83 review). TEST_FILE stays the files vitest runs.
const ANY_TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

// What a diff may never add: an unconditional skip, a lint or type suppression, or looser type-checker strictness.
// Conditional skips (skipIf, runIf) are allowed; the never-skip reporter checks those against its allowlist. The
// suppression markers are assembled from parts so that this file's own lines never match them.
const SUPPRESSION_MARKERS = [
  ["eslint", "disable"].join("-"),
  ["@ts", "ignore"].join("-"),
  ["@ts", "expect", "error"].join("-"),
  ["@ts", "nocheck"].join("-"),
  ["swiftlint", "disable"].join(":"),
  ["swift", "format", "ignore"].join("-"),
];
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const BANNED_ADDITIONS = [
  {
    category: "unconditional skip, todo, only or fails",
    applies: (file) => CODE_FILE.test(file),
    pattern: /\b(?:it|test|describe|suite|bench|context)\.(?:skip|todo|only|fails)\b/,
  },
  {
    category: "skip whose condition is a constant",
    applies: (file) => CODE_FILE.test(file),
    pattern: /\.(?:skipIf\s*\(\s*(?:true|1|!0)\s*\)|runIf\s*\(\s*(?:false|0|!1)\s*\))/,
  },
  {
    category: "x-prefixed test",
    applies: (file) => CODE_FILE.test(file),
    pattern: /(?<![\w.$])x(?:it|describe|test)\s*\(/,
  },
  {
    category: "lint or type suppression",
    applies: (file) => CODE_FILE.test(file),
    pattern: new RegExp(
      `${SUPPRESSION_MARKERS.map(escapeRegExp).join("|")}|#\\s*type:\\s*ignore|pyright:\\s*ignore`,
    ),
  },
  {
    category: "loosened type-checker strictness",
    applies: (file) => TSCONFIG_FILE.test(file),
    pattern:
      /"(?:strict\w*|alwaysStrict|noImplicit\w*|noUnchecked\w*|noUnused\w*|noFallthrough\w*|exactOptional\w*|noPropertyAccessFromIndexSignature|useUnknownInCatchVariables)"\s*:\s*false/,
  },
];
const CREDENTIAL = CHECKS.find((check) => check.category === "Credential");

// ---------- git ----------

function git(repo, args, options = {}) {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

export function readHead(repo) {
  return git(repo, ["rev-parse", "HEAD"]).trim();
}

export function porcelain(repo) {
  return git(repo, ["status", "--porcelain=v1", "--untracked-files=all"]).trim();
}

export function resolveMergeBase(repo, base) {
  const baseSha = git(repo, ["rev-parse", "--verify", `${base}^{commit}`]).trim();
  return git(repo, ["merge-base", baseSha, "HEAD"]).trim();
}

export function defaultReceiptsRoot(repo) {
  const common = git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim();
  return join(common, "openrig-gate-tiers");
}

export function changedFiles(repo, mergeBase) {
  // --no-renames lists a renamed file under both its old and its new path, so tests naming either are reached.
  return git(repo, ["diff", "--name-only", "--no-renames", mergeBase, "HEAD"])
    .split("\n")
    .filter(Boolean);
}

// ---------- receipts ----------

function receiptPath(root, head, tier) {
  return join(root, head, `tier-${tier}.json`);
}

export function readReceipt(root, head, tier) {
  try {
    return JSON.parse(readFileSync(receiptPath(root, head, tier), "utf8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(path, value) {
  mkdirSync(resolve(path, ".."), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

// A receipt below the requested tier counts only when it passed, at this HEAD, against this merge base.
export function missingPrerequisites(root, head, mergeBase, tier) {
  const missing = [];
  for (let below = 0; below < tier; below += 1) {
    const receipt = readReceipt(root, head, below);
    if (!receipt) missing.push({ tier: below, reason: "no receipt" });
    else if (receipt.ok !== true) missing.push({ tier: below, reason: "its last run failed" });
    else if (receipt.head !== head) missing.push({ tier: below, reason: `receipt is for ${receipt.head}` });
    else if (receipt.mergeBase !== mergeBase)
      missing.push({ tier: below, reason: `receipt is against merge base ${receipt.mergeBase}` });
  }
  return missing;
}

// Starting a tier withdraws its own receipt and every receipt above it at this HEAD: a failed re-run must not leave
// an older pass behind for a later tier to rely on.
function withdrawReceipts(root, head, fromTier) {
  for (let tier = fromTier; tier <= 3; tier += 1) rmSync(receiptPath(root, head, tier), { force: true });
}

// ---------- tier 0: diff hygiene ----------

export function scanAddedLines(lines) {
  const findings = [];
  for (const { file, line, text } of lines) {
    if (file === null) continue;
    for (const rule of BANNED_ADDITIONS) {
      if (rule.applies(file) && rule.pattern.test(text)) findings.push({ file, line, category: rule.category });
    }
    // The value itself is never recorded or printed: only where it is.
    if (CREDENTIAL.pattern.test(text)) findings.push({ file, line, category: "credential-shaped literal" });
  }
  return findings;
}

function tierZero(context) {
  const { repo, mergeBase } = context;
  const diffCheck = spawnSyncStatus("git", ["diff", "--check", mergeBase, "HEAD"], repo);
  const diff = git(repo, ["diff", "-U0", "--no-color", "--no-ext-diff", "--no-renames", mergeBase, "HEAD"]);
  const findings = scanAddedLines(addedLines(diff));
  // git diff --check prints each offending line after its location. A diff line can hold a credential, so only the
  // location and the kind are kept; the line itself never reaches the log or the receipt.
  const whitespace = parseDiffCheck(diffCheck.output);
  for (const finding of findings) context.log(`  ${finding.file}:${finding.line}  ${finding.category}`);
  for (const problem of whitespace) context.log(`  ${problem.file}:${problem.line}  ${problem.kind}`);
  if (diffCheck.code !== 0 && whitespace.length === 0) {
    context.log(`  git diff --check failed (exit ${diffCheck.code}); its output is not shown, since it can quote diff lines`);
  }
  return {
    ok: findings.length === 0 && diffCheck.code === 0,
    detail: { diffCheckExit: diffCheck.code, diffCheck: whitespace, findings },
  };
}

/** `git diff --check` lines of the form `<file>:<line>: <kind>.`; the quoted diff lines that follow them are dropped. */
export function parseDiffCheck(output) {
  const problems = [];
  for (const raw of output.split("\n")) {
    if (raw.startsWith("+") || raw.startsWith("-") || raw.startsWith(" ")) continue;
    const match = /^(.+?):(\d+): (.+?)\.?$/.exec(raw);
    if (match) problems.push({ file: match[1], line: Number(match[2]), kind: match[3] });
  }
  return problems;
}

function spawnSyncStatus(command, args, cwd) {
  try {
    const output = execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, output };
  } catch (error) {
    return { code: error.status ?? 1, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

// ---------- tier 1: build and static checks ----------

async function tierOne(context) {
  const run = await context.exec("npm", ["run", "lint"], { cwd: context.repo, env: process.env });
  return { ok: run.code === 0, detail: { command: "npm run lint", exitCode: run.code } };
}

// ---------- tier 2: what the diff reaches ----------

function listTestFiles(directory) {
  const files = [];
  if (!existsSync(directory)) return files;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") files.push(...listTestFiles(path));
    } else if (TEST_FILE.test(entry.name)) files.push(path);
  }
  return files;
}

// workspaces-o9o.83: a census test reads source as text and counts calls by name (OF-235's kill-site census greps
// `\.(killSession|respawnPane)\(`), so neither the import graph nor a changed file's stem reaches it when a diff adds such a
// call in a file named otherwise. Measured on four real diffs: matching every test that mentions a called name added
// 87 to 1328 daemon test files; matching the names a test scans for added 0 to 4.
const CALL = /\.([A-Za-z_$][\w$]*)\s*\(/g;
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;
const UNDER_TEST_DIR = /(^|\/)test\//;

/** The method names a diff newly calls: `.name(` in the added lines of non-test source files, more often than in that
 *  file's removed lines. Counted per file, as a census counts: a call moved within a file is not new, one moved to
 *  another file is. Lines are read as content only inside a hunk, so a removed line starting with "--" is not a header. */
export function newlyCalledNames(diff) {
  const perFile = new Map();
  let file = null;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) { file = null; inHunk = false; continue; }
    if (!inHunk) {
      if (line.startsWith("+++ ")) file = line.slice(4).replace(/^b\//, "");
      else if (line.startsWith("@@")) inHunk = true;
      continue;
    }
    if (line.startsWith("@@")) continue;
    if (!file || file === "/dev/null" || ANY_TEST_FILE.test(file) || UNDER_TEST_DIR.test(file) || !SOURCE_FILE.test(file)) continue;
    const sign = line.startsWith("+") ? 1 : line.startsWith("-") ? -1 : 0;
    if (sign === 0) continue;
    if (!perFile.has(file)) perFile.set(file, new Map());
    const counts = perFile.get(file);
    for (const match of line.slice(1).matchAll(CALL)) counts.set(match[1], (counts.get(match[1]) ?? 0) + sign);
  }
  const names = new Set();
  for (const counts of perFile.values()) for (const [name, count] of counts) if (count > 0) names.add(name);
  return [...names].sort();
}

// The compared-name form (workspaces-o9o.83 review): an AST census names its call by comparison, not by a regex
// (`node.expression.name.text === "sendShellCommand"`). So in a test that reads source (readFileSync, readdirSync or
// ts.createSourceFile, and a src path), the camelCase names it compares also count: `=== "a"` / `!== "a"`,
// `.includes("a")`, or an array or Set of names. A single lowercase word there ("slice", "error", "get") is almost always
// generic: on four real diffs this form added 21, 28, 12 and 0 test files with any name, 2, 1, 0 and 0 with camelCase
// names only. Known over-selection, accepted (CoS, o9o.83 review): a `.name(` inside a template string or prose in
// source still counts as a call, so tier 2 may run a census more often than needed; it errs toward running more.
const READS_SOURCE = /\b(?:readFileSync|readdirSync|createSourceFile)\b/;
const NAMES_SRC = /["'`/]src\b|\bSRC\b/;
const QUOTED_ID = String.raw`["'\`]([A-Za-z_$][\w$]*)["'\`]`;
const CAMEL_CASE = /^[a-z_$][\w$]*[A-Z]/;

function comparedNames(text) {
  const names = new Set();
  if (!(READS_SOURCE.test(text) && NAMES_SRC.test(text))) return names;
  for (const m of text.matchAll(new RegExp(String.raw`[!=]==\s*${QUOTED_ID}|${QUOTED_ID}\s*[!=]==`, "g"))) names.add(m[1] ?? m[2]);
  for (const m of text.matchAll(new RegExp(String.raw`\.includes\(\s*${QUOTED_ID}\s*\)`, "g"))) names.add(m[1]);
  const item = QUOTED_ID.replace("(", "(?:");
  for (const m of text.matchAll(new RegExp(String.raw`\[\s*(?:${item}\s*,\s*)*${item}\s*,?\s*\]`, "g"))) {
    for (const n of m[0].matchAll(new RegExp(QUOTED_ID, "g"))) names.add(n[1]);
  }
  return new Set([...names].filter((name) => CAMEL_CASE.test(name)));
}

/** The call names a test scans source text for, read from its own patterns: a regex `\.(a|b)\(` or `\.a\(`, or a quoted
 *  ".a(". A name the test merely calls or mocks is not one. */
export function scannedCallNames(text) {
  const names = comparedNames(text);
  for (const match of text.matchAll(/\\\.\(?((?:[A-Za-z_$][\w$]*\|)*[A-Za-z_$][\w$]*)\)?\\\(/g)) {
    for (const name of match[1].split("|")) names.add(name);
  }
  for (const match of text.matchAll(/["'`]\.([A-Za-z_$][\w$]*)\(["'`]/g)) names.add(match[1]);
  return names;
}

// workspaces-o9o.86: the name match (b) took any substring of a test file, so a short, common-word stem selected most of
// a package. Measured on four real diffs: "up" matched 1133 daemon test files, "seat" 825, "add" 738, "help" 627. A short
// stem without a hyphen (under 10 characters) now counts only where it names the file: a file reference (up.ts, up.js,
// hexagonal-baseline.txt), a quoted name ("up") or a path segment (routes/up). A hyphenated or longer stem is specific
// enough to keep the substring match. On the same diffs (917, 922, 43, 1241 files) this selects 546, 573, 42 and 206;
// every dropped file sampled was a substring inside another word, an object key or prose. Tier 3 still runs everything.
const SPECIFIC_STEM_LENGTH = 10;

/** Does this test text name the file whose stem (name without extension) is `stem`? */
export function namesStem(text, stem) {
  if (stem.includes("-") || stem.length >= SPECIFIC_STEM_LENGTH) return text.includes(stem);
  const name = stem.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
  return new RegExp(`(?<![\\w-])${name}(?:\\.[A-Za-z0-9]+\\b|["'\`])|/${name}(?![\\w-])`).test(text);
}

function stemOf(path) {
  return basename(path).replace(/\.[^.]+$/, "");
}

// The tier-2 selection for one package: the union of (a) what vitest's import graph says the diff reaches, (b) the
// package's test files that name a changed file's stem (census, guard and process-spawning tests read source as text
// or spawn it, so no import edge reaches them), (c) the package's changed test files themselves, and (d) its test files
// that scan source for a call the diff newly makes (newCalls, from newlyCalledNames; workspaces-o9o.83).
export async function selectReach({ repo, mergeBase, changed, packageName, listChanged, newCalls = [] }) {
  const packageDir = join(repo, "packages", packageName);
  const testFiles = listTestFiles(join(packageDir, "test"));
  const viaImports = new Set(
    (await listChanged(packageDir, mergeBase)).map((file) => relative(packageDir, resolve(packageDir, file))),
  );
  const stems = [...new Set(changed.filter((file) => !ANY_TEST_FILE.test(file)).map(stemOf))].filter(Boolean);
  const viaNames = new Set();
  const viaCalls = new Set();
  for (const file of testFiles) {
    const text = readFileSync(file, "utf8");
    if (stems.some((stem) => namesStem(text, stem))) viaNames.add(relative(packageDir, file));
    if (newCalls.length > 0) {
      const scanned = scannedCallNames(text);
      if (newCalls.some((name) => scanned.has(name))) viaCalls.add(relative(packageDir, file));
    }
  }
  const prefix = `packages/${packageName}/`;
  const changedTests = new Set(
    changed
      .filter((file) => file.startsWith(prefix) && TEST_FILE.test(file))
      .map((file) => file.slice(prefix.length))
      .filter((file) => existsSync(join(packageDir, file))),
  );
  const files = [...new Set([...viaImports, ...viaNames, ...changedTests, ...viaCalls])]
    .filter((file) => existsSync(join(packageDir, file)))
    .sort();
  return {
    files,
    viaImports: viaImports.size,
    viaNames: viaNames.size,
    viaNamesOnly: [...viaNames].filter((file) => !viaImports.has(file)).sort(),
    changedTests: changedTests.size,
    viaCalls: viaCalls.size,
    viaCallsOnly: [...viaCalls].filter((file) => !viaImports.has(file) && !viaNames.has(file) && !changedTests.has(file)).sort(),
  };
}

async function selectAll(context) {
  const { repo, mergeBase, listChanged } = context;
  const changed = changedFiles(repo, mergeBase);
  const newCalls = newlyCalledNames(git(repo, ["diff", "-U0", "--no-color", "--no-ext-diff", "--no-renames", mergeBase, "HEAD"]));
  const selection = {};
  for (const packageName of SUITE_PACKAGES) {
    selection[packageName] = await selectReach({ repo, mergeBase, changed, packageName, listChanged, newCalls });
  }
  return { changed, selection };
}

function printSelection(context, changed, selection) {
  context.log(`changed files: ${changed.length}`);
  for (const [packageName, picked] of Object.entries(selection)) {
    context.log(
      `packages/${packageName}: ${picked.files.length} test files (imports ${picked.viaImports}, names ${picked.viaNames}, changed tests ${picked.changedTests}, calls ${picked.viaCalls}; reached by name only: ${picked.viaNamesOnly.length}, by call only: ${picked.viaCallsOnly.length})`,
    );
    for (const file of picked.files) context.log(`  ${file}`);
  }
}

export function summaryLines(output) {
  return output
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^(?:Test Files|Tests)\s/.test(line));
}

async function tierTwo(context) {
  const { changed, selection } = await selectAll(context);
  printSelection(context, changed, selection);
  const runs = [];
  const repoChecks = await context.exec("npm", ["run", "test:repo"], { cwd: context.repo, env: context.testEnv });
  runs.push({ name: "test:repo", exitCode: repoChecks.code, summary: [] });
  for (const [packageName, picked] of Object.entries(selection)) {
    if (picked.files.length === 0) continue;
    const cwd = join(context.repo, "packages", packageName);
    if (packageName === "tui") {
      // `npm test` in packages/tui builds first (its pretest); a direct vitest run must do the same.
      const build = await context.exec("npm", ["run", "build"], { cwd, env: context.testEnv });
      runs.push({ name: "packages/tui build", exitCode: build.code, summary: [] });
      if (build.code !== 0) continue;
    }
    // No --reporter here: passing one replaces the configured reporters and drops the never-skip guard.
    const run = await context.exec(
      "nice",
      ["-n", "10", "npx", "vitest", "run", `--maxWorkers=${T2_MAX_WORKERS}`, ...picked.files],
      { cwd, env: context.testEnv },
    );
    runs.push({ name: `packages/${packageName}`, exitCode: run.code, summary: summaryLines(run.output) });
  }
  return { ok: runs.every((run) => run.exitCode === 0), detail: { changed, selection, runs } };
}

// ---------- tier 3: the full suite ----------

async function tierThree(context) {
  const [command, ...args] = context.command;
  const run = await context.exec(command, args, { cwd: context.repo, env: context.testEnv });
  return {
    ok: run.code === 0,
    detail: { command: context.command, exitCode: run.code, summary: summaryLines(run.output) },
  };
}

const TIER_RUNNERS = [tierZero, tierOne, tierTwo, tierThree];

// ---------- the run ----------

// Tests run with a scratch HOME and OPENRIG_HOME, never the operator's real ones.
function scratchHomes() {
  const root = mkdtempSync(join(tmpdir(), "gate-tiers-home-"));
  mkdirSync(join(root, "home"));
  mkdirSync(join(root, "openrig-home"));
  return {
    root,
    env: { ...process.env, HOME: join(root, "home"), OPENRIG_HOME: join(root, "openrig-home") },
  };
}

export async function runTier(options, ports) {
  const log = ports.log ?? ((line) => console.log(line));
  const repo = git(options.cwd ?? process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
  const head = readHead(repo);
  const mergeBase = resolveMergeBase(repo, options.base);
  const root = options.receiptsRoot ?? defaultReceiptsRoot(repo);
  const dirty = porcelain(repo);
  log(`gate-tiers: tier ${options.tier}, HEAD ${head}, base ${options.base} (merge base ${mergeBase})`);
  log(`porcelain: [${dirty}]`);

  if (options.list) {
    const { changed, selection } = await selectAll({ repo, mergeBase, listChanged: ports.listChanged });
    printSelection({ log }, changed, selection);
    return { exitCode: EXIT.pass, receipt: null };
  }
  if (dirty !== "") {
    log("REFUSED: the worktree is not clean. Commit or stash first: a receipt names a commit, not a working tree.");
    return { exitCode: EXIT.refused, receipt: null };
  }
  const missing = missingPrerequisites(root, head, mergeBase, options.tier);
  if (missing.length > 0) {
    for (const gap of missing) log(`REFUSED: tier ${gap.tier} has not passed here (${gap.reason}).`);
    log(`Run: node scripts/gate-tiers.mjs --tier ${missing[0].tier} --base ${options.base}`);
    return { exitCode: EXIT.refused, receipt: null };
  }
  withdrawReceipts(root, head, options.tier);

  const startedAt = new Date();
  const loadAtStart = loadavg();
  const homes = options.tier >= 2 ? scratchHomes() : null;
  let outcome;
  try {
    outcome = await TIER_RUNNERS[options.tier]({
      repo,
      mergeBase,
      log,
      exec: ports.exec,
      listChanged: ports.listChanged,
      testEnv: homes?.env ?? process.env,
      command: options.command ?? DEFAULT_T3_COMMAND,
    });
  } finally {
    if (homes) rmSync(homes.root, { recursive: true, force: true });
  }

  // The receipt names a commit, so the run must end where it started: same HEAD, still clean.
  const headAfter = readHead(repo);
  const dirtyAfter = porcelain(repo);
  const problems = [];
  if (headAfter !== head) problems.push(`HEAD moved during the run (${head} -> ${headAfter})`);
  if (dirtyAfter !== "") problems.push(`the run left the worktree dirty: [${dirtyAfter}]`);
  for (const problem of problems) log(`FAILED: ${problem}`);

  const endedAt = new Date();
  const receipt = {
    schema: RECEIPT_SCHEMA,
    tool: "gate-tiers",
    tier: options.tier,
    ok: outcome.ok && problems.length === 0,
    head,
    base: options.base,
    mergeBase,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: endedAt.getTime() - startedAt.getTime(),
    loadAtStart,
    cores: cpus().length,
    problems,
    detail: outcome.detail,
  };
  const path = receiptPath(root, head, options.tier);
  writeJsonAtomic(path, receipt);
  if (options.baselineDir) writeJsonAtomic(join(options.baselineDir, `${head}.json`), receipt);
  log(`GATE-TIERS tier=${options.tier} ok=${receipt.ok} head=${head} mergeBase=${mergeBase} receipt=${path}`);
  return { exitCode: receipt.ok ? EXIT.pass : EXIT.failed, receipt };
}

// ---------- the real ports ----------

// Streams the child's output through while keeping its tail, so a summary can be read from it afterwards.
export function realExec(command, args, { cwd, env }) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";
    const keep = (chunk, stream) => {
      stream.write(chunk);
      tail = (tail + chunk.toString("utf8")).slice(-262144);
    };
    child.stdout.on("data", (chunk) => keep(chunk, process.stdout));
    child.stderr.on("data", (chunk) => keep(chunk, process.stderr));
    child.on("error", (error) => resolvePromise({ code: 127, output: `${tail}\n${error.message}` }));
    child.on("close", (code, signal) => resolvePromise({ code: code ?? (signal ? 128 : 1), output: tail }));
  });
}

export async function realListChanged(packageDir, mergeBase) {
  const out = mkdtempSync(join(tmpdir(), "gate-tiers-list-"));
  try {
    const file = join(out, "list.json");
    const run = await realExec(
      "npx",
      ["vitest", "list", "--changed", mergeBase, "--filesOnly", `--json=${file}`],
      { cwd: packageDir, env: process.env },
    );
    if (run.code !== 0) throw new Error(`vitest list --changed failed in ${packageDir} (exit ${run.code})`);
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).map((entry) => entry.file) : [];
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

// ---------- the command line ----------

export function parseArguments(argv) {
  const options = { tier: null, base: null, list: false, baselineDir: null, receiptsRoot: null, command: null };
  const separator = argv.indexOf("--");
  const own = separator === -1 ? argv : argv.slice(0, separator);
  if (separator !== -1) options.command = argv.slice(separator + 1);
  for (let index = 0; index < own.length; index += 1) {
    const key = own[index];
    const value = () => {
      const next = own[++index];
      if (next === undefined) throw new Error(`${key} needs a value`);
      return next;
    };
    if (key === "--tier") options.tier = Number(value());
    else if (key === "--base") options.base = value();
    else if (key === "--list") options.list = true;
    else if (key === "--baseline-dir") options.baselineDir = resolve(value());
    else if (key === "--receipts") options.receiptsRoot = resolve(value());
    else throw new Error(`unknown argument: ${key}`);
  }
  if (![0, 1, 2, 3].includes(options.tier)) throw new Error("--tier must be 0, 1, 2 or 3");
  if (!options.base) throw new Error("--base <ref> is required: the commit this work was cut from, usually main");
  if (options.list && options.tier !== 2) throw new Error("--list applies to tier 2 only");
  if (options.command && options.tier !== 3) throw new Error("a command after -- applies to tier 3 only");
  if (options.command && options.command.length === 0) throw new Error("the command after -- is empty");
  if (options.baselineDir && options.tier !== 3) throw new Error("--baseline-dir applies to tier 3 only");
  return options;
}

async function main(argv) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    console.error(`gate-tiers: ${error.message}`);
    return EXIT.usage;
  }
  if (!options.receiptsRoot && process.env.OPENRIG_GATE_TIERS_DIR) {
    options.receiptsRoot = resolve(process.env.OPENRIG_GATE_TIERS_DIR);
  }
  const { exitCode } = await runTier(options, { exec: realExec, listChanged: realListChanged });
  return exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`gate-tiers: ${error.stack ?? error.message}`);
      process.exit(3);
    },
  );
}
