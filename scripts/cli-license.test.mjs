import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Build and pack a copy of the CLI package under `parent`, with a compiler fixture in place of tsc, and check the archive.
 *
 * The fixture is the package's own `node_modules/.bin/tsc`, not a directory prepended to PATH (workspaces-o9o.45). `npm run`
 * puts every ancestor's `node_modules/.bin` ahead of the caller's PATH, nearest first, so a PATH entry loses to any `tsc` an
 * ancestor holds: with the temp dir inside a checkout (a TMPDIR under the repo, as in verify-sec's review worktree), the real
 * TypeScript compiler ran in place of the fixture, found no tsconfig, printed its help and failed "npm run build". The
 * package's own `.bin` is the first one npm searches, so no ancestor can shadow it.
 */
function packInto(parent) {
  const root = mkdtempSync(join(parent, "cli-license-"));
  try {
    const cli = join(root, "packages/cli");
    const bin = join(cli, "node_modules/.bin");
    for (const dir of [cli, bin, join(cli, "src/schemas"), join(cli, "src/lib/scope-templates")]) mkdirSync(dir, { recursive: true });
    copyFileSync("LICENSE", join(root, "LICENSE"));
    copyFileSync("README.md", join(root, "README.md"));
    copyFileSync("packages/cli/package.json", join(cli, "package.json"));
    mkdirSync(join(root, "scripts"), { recursive: true });
    copyFileSync("scripts/prepare-workspace-build.mjs", join(root, "scripts/prepare-workspace-build.mjs"));
    writeFileSync(join(cli, "src/schemas/fixture.json"), "{}\n");
    writeFileSync(join(cli, "src/lib/scope-templates/fixture.md"), "fixture\n");
    // Compilation is outside this packaging regression. Run the actual build
    // script with its expected compiler output, then npm's real file selection.
    writeFileSync(join(bin, "tsc"), "#!/bin/sh\nmkdir -p dist\nprintf '%s\\n' '// compiler fixture' > dist/bin-wrapper.js\n");
    chmodSync(join(bin, "tsc"), 0o755);
    execFileSync("npm", ["run", "build"], { cwd: cli, stdio: "pipe" });
    const source = readFileSync(join(root, "LICENSE"));
    assert.deepEqual(readFileSync(join(cli, "LICENSE")), source, "build must stage the repository license verbatim");
    const packed = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json"], { cwd: cli, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }));
    assert.ok(packed[0].files.some((file) => file.path === "LICENSE"), "npm archive must include LICENSE");
    const bytes = execFileSync("tar", ["-xOf", join(cli, packed[0].filename), "package/LICENSE"]);
    assert.deepEqual(bytes, source, "packed license must equal the existing root bytes");
    // npm shows the package-root README on the registry page; without it the page reads "No README data found".
    const readme = readFileSync(join(root, "README.md"));
    assert.ok(packed[0].files.some((file) => file.path === "README.md"), "npm archive must include README.md");
    const readmeBytes = execFileSync("tar", ["-xOf", join(cli, packed[0].filename), "package/README.md"]);
    assert.deepEqual(readmeBytes, readme, "packed README must equal the existing root bytes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the CLI build carries the unchanged repository LICENSE and README into npm pack", () => {
  packInto(tmpdir());
});

test("the same, built under a directory whose node_modules/.bin holds a tsc that fails (a temp dir inside a checkout)", () => {
  const ancestor = mkdtempSync(join(tmpdir(), "cli-license-ancestor-"));
  try {
    const decoy = join(ancestor, "node_modules/.bin");
    mkdirSync(decoy, { recursive: true });
    writeFileSync(join(decoy, "tsc"), "#!/bin/sh\necho 'the ancestor tsc ran, not the fixture' >&2\nexit 1\n");
    chmodSync(join(decoy, "tsc"), 0o755);
    packInto(ancestor);
  } finally {
    rmSync(ancestor, { recursive: true, force: true });
  }
});
