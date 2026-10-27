#!/usr/bin/env node
// OF-78: the daemon tsconfig excludes test/, so `npm run lint` never type-checked a daemon test.
// packages/daemon/tsconfig.test.json covers src + test; this script runs it and compares the
// per-file error counts with scripts/daemon-test-type-baseline.json.
//
// A ratchet, not a gate on zero: the baseline records the type errors that existed when the check
// was added, and it can only shrink. A test file with more errors than its baseline entry (or any
// error when it has no entry) fails. A file that improved passes and says so; `--update` rewrites
// the baseline to the current counts and REFUSES when any count would rise.
//
// Counts are per file, not per line, so unrelated edits that move lines do not disturb the baseline.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ERROR_LINE = /^(.+?)\(\d+,\d+\): error TS\d+:/;

/** Count `path(line,col): error TSnnnn:` lines per file in tsc's plain output. */
export function countErrorsByFile(tscOutput) {
  const counts = {};
  for (const line of tscOutput.split("\n")) {
    const match = ERROR_LINE.exec(line);
    if (match) counts[match[1]] = (counts[match[1]] ?? 0) + 1;
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

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const baselinePath = join(root, "scripts", "daemon-test-type-baseline.json");
  const update = process.argv.includes("--update");
  const tsc = createRequire(join(root, "package.json")).resolve("typescript/bin/tsc");
  const run = spawnSync(process.execPath, [tsc, "-p", join(root, "packages", "daemon", "tsconfig.test.json")], {
    cwd: join(root, "packages", "daemon"),
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  const current = countErrorsByFile(output);
  const total = Object.values(current).reduce((a, b) => a + b, 0);
  // tsc exits 2 when it reports type errors. A non-zero exit with nothing parsed is a crash or a
  // config error, not a clean check: do not let it pass.
  if (run.status !== 0 && total === 0) {
    console.error(`daemon test type-check: tsc failed without reporting type errors (status ${run.status})\n${output.slice(0, 2000)}`);
    process.exit(1);
  }
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const { regressions, improvements } = compareToBaseline(current, baseline);
  if (update) {
    if (regressions.length > 0) {
      console.error("daemon test type-check: refusing --update; the baseline can only shrink. Fix these first:");
      for (const r of regressions) console.error(`  ${r.file}: ${r.count} errors, baseline ${r.allowed}`);
      process.exit(1);
    }
    const sorted = Object.fromEntries(Object.entries(current).sort(([a], [b]) => (a < b ? -1 : 1)));
    writeFileSync(baselinePath, `${JSON.stringify(sorted, null, 2)}\n`);
    console.log(`daemon test type-check: baseline rewritten, ${total} errors in ${Object.keys(sorted).length} files`);
    return;
  }
  for (const i of improvements) console.log(`  improved: ${i.file} ${i.allowed} -> ${i.count} (run: node scripts/check-daemon-test-types.mjs --update)`);
  if (regressions.length > 0) {
    console.error("daemon test type-check: new type errors in daemon tests (packages/daemon/tsconfig.test.json):");
    for (const r of regressions) console.error(`  ${r.file}: ${r.count} errors, baseline allows ${r.allowed}`);
    console.error("Fix them; the baseline (scripts/daemon-test-type-baseline.json) can only shrink.");
    process.exit(1);
  }
  console.log(`daemon test type-check: ${total} errors, none above baseline (${Object.keys(baseline).length} files allowlisted)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
