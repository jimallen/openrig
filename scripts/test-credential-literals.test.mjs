// workspaces-o9o.79: no tracked test file holds a credential-shaped literal, fake or not (house rule, CoS 2026-11-16). gate-tiers'
// tier 0 checks the lines a diff adds; this holds the whole tree, so a literal that predates the rule, or one a merge brings in
// without a fresh tier-0 run, is caught too. The pattern is tier 0's own (portability-report.mjs CHECKS "Credential"). A fake is
// built at runtime instead: "xox" + "b-...", or a key = "value" split at a separator. Only the location is reported, never the value.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CHECKS } from "./portability-report.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const CREDENTIAL = CHECKS.find((check) => check.category === "Credential").pattern;

/** A test file: anything under a test, tests or __tests__ folder, a *.test / *.spec file, or an opt-in measurement. */
export function isTestFile(path) {
  return /(^|\/)(test|tests|__tests__)\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) || /\.opt-in\.ts$/.test(path);
}

/** "file:line" for every line of the given files that tier 0's credential pattern matches. */
export function credentialLines(repo, files) {
  const found = [];
  for (const file of files) {
    let text;
    try { text = readFileSync(join(repo, file), "utf8"); } catch { continue; }
    text.split("\n").forEach((line, i) => { if (CREDENTIAL.test(line)) found.push(`${file}:${i + 1}`); });
  }
  return found;
}

test("no tracked test file holds a credential-shaped literal", () => {
  const tracked = execFileSync("git", ["-C", REPO, "ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
  const tests = tracked.filter(isTestFile);
  assert.ok(tests.length > 1000, `the census ran over the real tree (${tests.length} test files of ${tracked.length})`);
  assert.deepEqual(credentialLines(REPO, tests), []);
});

test("control: the census finds a literal built the old way, and not the same value built at runtime", () => {
  const prefix = "xox";
  const oldWay = `const t = "${prefix}b-EXAMPLE-fake";`;
  const runtime = `const t = "${prefix}" + "b-EXAMPLE-fake";`;
  assert.equal(CREDENTIAL.test(oldWay), true);
  assert.equal(CREDENTIAL.test(runtime), false);
  assert.equal(isTestFile("packages/daemon/test/slack-message.test.ts"), true);
  assert.equal(isTestFile("packages/daemon/src/slack.ts"), false);
});
