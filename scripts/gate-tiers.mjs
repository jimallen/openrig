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
  for (const finding of findings) context.log(`  ${finding.file}:${finding.line}  ${finding.category}`);
  if (diffCheck.code !== 0) context.log(`  git diff --check failed:\n${diffCheck.output.trim()}`);
  return {
    ok: findings.length === 0 && diffCheck.code === 0,
    detail: { diffCheckExit: diffCheck.code, findings },
  };
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

function stemOf(path) {
  return basename(path).replace(/\.[^.]+$/, "");
}

// The tier-2 selection for one package: the union of (a) what vitest's import graph says the diff reaches, (b) the
// package's test files that name a changed file's stem (census, guard and process-spawning tests read source as text
// or spawn it, so no import edge reaches them), and (c) the package's changed test files themselves.
export async function selectReach({ repo, mergeBase, changed, packageName, listChanged }) {
  const packageDir = join(repo, "packages", packageName);
  const testFiles = listTestFiles(join(packageDir, "test"));
  const viaImports = new Set(
    (await listChanged(packageDir, mergeBase)).map((file) => relative(packageDir, resolve(packageDir, file))),
  );
  const stems = [...new Set(changed.filter((file) => !TEST_FILE.test(file)).map(stemOf))].filter(Boolean);
  const viaNames = new Set();
  for (const file of testFiles) {
    const text = readFileSync(file, "utf8");
    if (stems.some((stem) => text.includes(stem))) viaNames.add(relative(packageDir, file));
  }
  const prefix = `packages/${packageName}/`;
  const changedTests = new Set(
    changed
      .filter((file) => file.startsWith(prefix) && TEST_FILE.test(file))
      .map((file) => file.slice(prefix.length))
      .filter((file) => existsSync(join(packageDir, file))),
  );
  const files = [...new Set([...viaImports, ...viaNames, ...changedTests])]
    .filter((file) => existsSync(join(packageDir, file)))
    .sort();
  return {
    files,
    viaImports: viaImports.size,
    viaNames: viaNames.size,
    viaNamesOnly: [...viaNames].filter((file) => !viaImports.has(file)).sort(),
    changedTests: changedTests.size,
  };
}

async function selectAll(context) {
  const { repo, mergeBase, listChanged } = context;
  const changed = changedFiles(repo, mergeBase);
  const selection = {};
  for (const packageName of SUITE_PACKAGES) {
    selection[packageName] = await selectReach({ repo, mergeBase, changed, packageName, listChanged });
  }
  return { changed, selection };
}

function printSelection(context, changed, selection) {
  context.log(`changed files: ${changed.length}`);
  for (const [packageName, picked] of Object.entries(selection)) {
    context.log(
      `packages/${packageName}: ${picked.files.length} test files (imports ${picked.viaImports}, names ${picked.viaNames}, changed tests ${picked.changedTests}; reached by name only: ${picked.viaNamesOnly.length})`,
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
