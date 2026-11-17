// workspaces-o9o.107: `npm test` is the suite every local gate and release runs, and it reaches a package's tests only
// through `test:workspaces`. packages/ui was left out (it ran only as a CI matrix leg), and this rig merges and releases
// without that CI, so no gate ran its 203 test files. These rows keep every package that has a test suite in that list,
// and keep gate-tiers' own package list (tier 2's reach, tier 3's full run) the same list.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SUITE_PACKAGES } from "./gate-tiers.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

/** The packages a `npm run test -w packages/a -w packages/b` script names, in order. */
export function namedWorkspaces(script) {
  return [...script.matchAll(/-w\s+packages\/([\w.-]+)/g)].map((match) => match[1]);
}

/** Every packages/<name> folder whose package.json has a test script. */
function packagesWithTests() {
  return readdirSync(join(ROOT, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(ROOT, "packages", entry.name, "package.json")))
    .filter((entry) => typeof readJson(join(ROOT, "packages", entry.name, "package.json")).scripts?.test === "string")
    .map((entry) => entry.name)
    .sort();
}

test("namedWorkspaces reads the -w packages/<name> arguments of a script", () => {
  assert.deepEqual(namedWorkspaces("npm run test -w packages/daemon -w packages/cli"), ["daemon", "cli"]);
  assert.deepEqual(namedWorkspaces("npm run test:repo"), []);
});

test("npm test runs every package that has a test suite (test:workspaces names each one)", () => {
  const scripts = readJson(join(ROOT, "package.json")).scripts;
  assert.match(scripts.test, /\bnpm run test:workspaces\b/, "npm test runs test:workspaces");
  const withTests = packagesWithTests();
  assert.ok(withTests.length >= 4, `positive control: found ${withTests.join(", ")}`);
  assert.deepEqual([...namedWorkspaces(scripts["test:workspaces"])].sort(), withTests);
});

test("gate-tiers selects and runs the same packages test:workspaces runs", () => {
  const named = namedWorkspaces(readJson(join(ROOT, "package.json")).scripts["test:workspaces"]);
  assert.deepEqual([...SUITE_PACKAGES].sort(), [...named].sort());
});
