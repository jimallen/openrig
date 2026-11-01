import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// hc cutover W8: hc is installed beside tmux in the testbed image and in the package-tests CI job, at one pinned
// version, by an installer pinned by sha256. These pins keep the two places in step and keep tmux in both while tmux code
// remains in src (the cutover removes tmux in steps, not here). The version is a literal in this file on purpose: a bump
// is a deliberate edit of the Dockerfile, the workflow and this test together.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const dockerfile = readFileSync(join(REPO_ROOT, "docker", "testbed", "Dockerfile"), "utf8");
const workflow = readFileSync(join(REPO_ROOT, ".github", "workflows", "tests.yml"), "utf8");
const PINNED_HC = "0.1.16";

const arg = (text, name) => text.match(new RegExp(`^ARG\\s+${name}=(\\S+)`, "m"))?.[1];
const wfValue = (name) => workflow.match(new RegExp(`^\\s+${name}:\\s*"([^"]+)"`, "m"))?.[1];

test("the Dockerfile pins hc to the version, with a 64-hex installer checksum, verified before the installer runs", () => {
  assert.equal(arg(dockerfile, "HC_VERSION"), PINNED_HC);
  assert.match(arg(dockerfile, "HC_INSTALLER_SHA256") ?? "", /^[0-9a-f]{64}$/);
  const run = dockerfile.slice(dockerfile.indexOf("HC_INSTALLER_SHA256}"));
  assert.ok(run.indexOf("sha256sum -c") !== -1 && run.indexOf("sha256sum -c") < run.indexOf("sh /tmp/hc-install.sh"),
    "the installer checksum must be checked before the installer is run");
  assert.match(dockerfile, /test "\$\(hc --version\)" = "hc \$\{HC_VERSION\}"/, "the build must prove the installed version");
});

test("hc is installed as root, before the non-root user takes over", () => {
  assert.ok(dockerfile.indexOf("HC_INSTALL_DIR=/usr/local/bin") !== -1);
  assert.ok(dockerfile.indexOf("HC_INSTALL_DIR=/usr/local/bin") < dockerfile.search(/^USER openrig$/m));
});

test("the CI package-tests job pins the same version and installer checksum as the Dockerfile", () => {
  assert.equal(wfValue("HC_VERSION"), PINNED_HC);
  assert.equal(wfValue("HC_INSTALLER_SHA256"), arg(dockerfile, "HC_INSTALLER_SHA256"));
  assert.match(workflow, /shasum -a 256 -c -/);
  assert.match(workflow, /GITHUB_PATH/);
});

test("tmux is still installed in both while tmux code remains (hc is added beside it, not instead)", () => {
  assert.match(dockerfile, /\btmux\b[^\n]*tini/, "the image's apt layer keeps tmux");
  assert.match(workflow, /^\s+- run: brew install tmux$/m, "CI keeps brew install tmux");
});
