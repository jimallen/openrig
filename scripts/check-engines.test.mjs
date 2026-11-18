import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

// workspaces-o9o.180: the supported majors have one source; the LTS engines range is derived from it.
const SUPPORTED_MAJORS = JSON.parse(readFileSync("packages/cli/scripts/node-support.json", "utf-8")).supportedMajors;
const LTS_ENGINE = SUPPORTED_MAJORS.map((major) => `^${major}`).join(" || ");
const CLI_ENGINE = ">=22";

const LTS_PACKAGE_PATHS = [
  "package.json",
  "packages/daemon/package.json",
];

for (const pkgPath of LTS_PACKAGE_PATHS) {
  test(`${pkgPath} has engines.node set to LTS-only constraint`, () => {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    assert.ok(pkg.engines, `${pkgPath} is missing an "engines" field`);
    assert.ok(pkg.engines.node, `${pkgPath} is missing "engines.node"`);
    assert.equal(
      pkg.engines.node,
      LTS_ENGINE,
      `${pkgPath} engines.node should be "${LTS_ENGINE}" (even-numbered LTS only) but got "${pkg.engines.node}"`
    );
  });
}

test("the one source of supported majors is the range o9o.121 set: 22, 24 and 26", () => {
  assert.deepEqual(SUPPORTED_MAJORS, [22, 24, 26]);
  assert.equal(LTS_ENGINE, "^22 || ^24 || ^26");
});

test("published CLI allows odd Node majors to reach its Node guard (the postinstall where npm runs it, and the CLI's own runtime gate)", () => {
  const pkgPath = "packages/cli/package.json";
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  assert.ok(pkg.engines, `${pkgPath} is missing an "engines" field`);
  assert.equal(
    pkg.engines.node,
    CLI_ENGINE,
    `${pkgPath} engines.node should be "${CLI_ENGINE}" so npm selects the latest package and the Node guard (check-abi.mjs, or the CLI runtime gate when npm skips install scripts) prints the supported-Node fix`
  );
});
