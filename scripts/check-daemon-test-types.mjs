#!/usr/bin/env node
// OF-78: the daemon tsconfig excludes test/, so `npm run lint` never type-checked a daemon test.
// packages/daemon/tsconfig.test.json covers src + test; this script runs it and compares the
// per-file error counts with scripts/daemon-test-type-baseline.json.
//
// A ratchet, not a gate on zero: the baseline records the type errors that existed when the check
// was added, and it can only shrink. A test file with more errors than its baseline entry (or any
// error when it has no entry) fails. OF-127:
//  - a file that improved is tightened automatically (the baseline is rewritten down, never up);
//    `--no-tighten` only reports it, and `--update` still rewrites on demand and REFUSES a rise;
//  - an error with no file position (`error TS5083: ...`, `tsconfig.json: error TS...`) counts under
//    "(no file)" instead of being ignored once positioned errors exist, and any line that says
//    `error TSnnnn:` but fits none of the recognised shapes fails the check loudly;
//  - `as any` in a daemon test file is ratcheted the same way against
//    scripts/daemon-test-as-any-baseline.json: a cast hides exactly the signal this check exists for.
//
// Counts are per file, not per line, so unrelated edits that move lines do not disturb the baseline.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** Key for errors tsc reports without a source file (config and option errors). */
export const NO_FILE = "(no file)";

const POSITIONED = /^(.+?)\(\d+,\d+\): error TS\d+:/;
const FILE_ONLY = /^([^\s(][^:]*?): error TS\d+:/;
const FILELESS = /^error TS\d+:/;
const ANY_ERROR = /\berror TS\d+:/;

/** Count `path(line,col): error TSnnnn:` lines per file in tsc's plain output; fileless errors count under NO_FILE. */
export function countErrorsByFile(tscOutput) {
  const counts = {};
  for (const line of tscOutput.split("\n")) {
    const key = POSITIONED.exec(line)?.[1] ?? FILE_ONLY.exec(line)?.[1] ?? (FILELESS.test(line) ? NO_FILE : undefined);
    if (key !== undefined) counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/** Lines that claim `error TSnnnn:` yet match none of the shapes countErrorsByFile recognises. */
export function unrecognisedErrorLines(tscOutput) {
  return tscOutput.split("\n").filter((line) => ANY_ERROR.test(line) && Object.keys(countErrorsByFile(line)).length === 0);
}

/** Count `as any` casts per file for { relativePath: sourceText }. */
export function countAsAnyByFile(sources) {
  const counts = {};
  for (const [file, text] of Object.entries(sources)) {
    const n = (text.match(/\bas any\b/g) ?? []).length;
    if (n > 0) counts[file] = n;
  }
  return counts;
}

/** Compare current per-file counts to the baseline. `regressions` fail the check; `improvements` do not. */
export function compareToBaseline(current, baseline) {
  const regressions = [];
  const improvements = [];
  for (const [file, count] of Object.entries(current)) {
    const allowed = baseline[file] ?? 0;
    if (count > allowed) regressions.push({ file, allowed, count });
  }
  for (const [file, allowed] of Object.entries(baseline)) {
    const count = current[file] ?? 0;
    if (count < allowed) improvements.push({ file, allowed, count });
  }
  return { regressions, improvements };
}

/** The baseline after tightening: every entry lowered to its current count, zeros dropped, nothing raised. */
export function tighten(baseline, current) {
  const next = {};
  for (const [file, allowed] of Object.entries(baseline)) {
    const count = Math.min(allowed, current[file] ?? 0);
    if (count > 0) next[file] = count;
  }
  return next;
}

function listTestSources(daemonDir) {
  const sources = {};
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(full);
      } else if (/\.tsx?$/.test(entry.name)) {
        sources[relative(daemonDir, full).split("\\").join("/")] = readFileSync(full, "utf8");
      }
    }
  };
  walk(join(daemonDir, "test"));
  return sources;
}

const sortedJson = (counts) =>
  `${JSON.stringify(Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : 1))), null, 2)}\n`;

const sum = (counts) => Object.values(counts).reduce((a, b) => a + b, 0);

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const daemonDir = join(root, "packages", "daemon");
  const typesBaselinePath = join(root, "scripts", "daemon-test-type-baseline.json");
  const asAnyBaselinePath = join(root, "scripts", "daemon-test-as-any-baseline.json");
  const update = process.argv.includes("--update");
  const tightenAuto = !process.argv.includes("--no-tighten");
  const tsc = createRequire(join(root, "package.json")).resolve("typescript/bin/tsc");
  const run = spawnSync(process.execPath, [tsc, "-p", join(daemonDir, "tsconfig.test.json")], {
    cwd: daemonDir,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  const current = countErrorsByFile(output);
  const total = sum(current);
  // tsc exits 2 when it reports type errors. A non-zero exit with nothing parsed is a crash or a
  // config error, not a clean check: do not let it pass.
  if (run.status !== 0 && total === 0) {
    console.error(`daemon test type-check: tsc failed without reporting type errors (status ${run.status})\n${output.slice(0, 2000)}`);
    process.exit(1);
  }
  // The parser must account for every error line tsc printed; otherwise a new line shape is being ignored.
  const unrecognised = unrecognisedErrorLines(output);
  if (unrecognised.length > 0) {
    console.error(`daemon test type-check: ${unrecognised.length} error line(s) in a shape the parser does not recognise:\n${unrecognised.slice(0, 10).join("\n")}`);
    process.exit(1);
  }
  const currentAsAny = countAsAnyByFile(listTestSources(daemonDir));
  const typesBaseline = JSON.parse(readFileSync(typesBaselinePath, "utf8"));
  const asAnyBaseline = JSON.parse(readFileSync(asAnyBaselinePath, "utf8"));
  const types = compareToBaseline(current, typesBaseline);
  const asAny = compareToBaseline(currentAsAny, asAnyBaseline);
  if (update) {
    if (types.regressions.length > 0 || asAny.regressions.length > 0) {
      console.error("daemon test type-check: refusing --update; the baselines can only shrink. Fix these first:");
      for (const r of types.regressions) console.error(`  ${r.file}: ${r.count} errors, baseline ${r.allowed}`);
      for (const r of asAny.regressions) console.error(`  ${r.file}: ${r.count} \`as any\`, baseline ${r.allowed}`);
      process.exit(1);
    }
    writeFileSync(typesBaselinePath, sortedJson(current));
    writeFileSync(asAnyBaselinePath, sortedJson(currentAsAny));
    console.log(`daemon test type-check: baselines rewritten, ${total} errors in ${Object.keys(current).length} files, ${sum(currentAsAny)} \`as any\` in ${Object.keys(currentAsAny).length} files`);
    return;
  }
  if (types.regressions.length > 0 || asAny.regressions.length > 0) {
    if (types.regressions.length > 0) {
      console.error("daemon test type-check: new type errors in daemon tests (packages/daemon/tsconfig.test.json):");
      for (const r of types.regressions) console.error(`  ${r.file}: ${r.count} errors, baseline allows ${r.allowed}`);
      console.error("Fix them; the baseline (scripts/daemon-test-type-baseline.json) can only shrink.");
    }
    if (asAny.regressions.length > 0) {
      console.error("daemon test type-check: new `as any` in daemon tests; narrow the type or fix the fixture instead:");
      for (const r of asAny.regressions) console.error(`  ${r.file}: ${r.count} \`as any\`, baseline allows ${r.allowed}`);
      console.error("The allowance (scripts/daemon-test-as-any-baseline.json) can only shrink.");
    }
    process.exit(1);
  }
  const improved = [
    ...types.improvements.map((i) => ({ ...i, what: "errors" })),
    ...asAny.improvements.map((i) => ({ ...i, what: "`as any`" })),
  ];
  if (improved.length > 0 && tightenAuto) {
    writeFileSync(typesBaselinePath, sortedJson(tighten(typesBaseline, current)));
    writeFileSync(asAnyBaselinePath, sortedJson(tighten(asAnyBaseline, currentAsAny)));
  }
  for (const i of improved) {
    console.log(`  improved: ${i.file} ${i.what} ${i.allowed} -> ${i.count}${tightenAuto ? " (baseline tightened; commit it)" : " (run: node scripts/check-daemon-test-types.mjs --update)"}`);
  }
  console.log(`daemon test type-check: ${total} errors, none above baseline (${Object.keys(typesBaseline).length} files allowlisted); ${sum(currentAsAny)} \`as any\`, none above baseline`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
