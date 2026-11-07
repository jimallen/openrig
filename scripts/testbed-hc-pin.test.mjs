import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// hc cutover W8, reworked by OF-254: hc is installed beside tmux in the testbed image and in the package-tests CI job at one
// pinned version, from the release TARBALL, checked against a per-target sha256 literal in ONE pin file
// (docker/testbed/hc-pin.env) that the Dockerfile, the workflow and this test all read. The earlier design pinned the
// installer SCRIPT's hash; the script changed under a fixed hc version (pin 4d052d13 -> ac94d641) and the pin broke CI for
// every unrelated PR. A tarball at a version URL does not change, so the pin goes stale only when someone bumps hc.
//
// The expectations below are RESTATED, not read from the pin file: a bump is a deliberate edit of the pin file and of this
// test together, and a wrong literal in the pin file fails here. The literals were taken from
// https://releases.herdr.dev/core/0.1.17/manifest.json (manifest sha256 a76688138f11464918d7ed46b4d8bc7d03983705ea0fd3027660e90a370a1000)
// and each tarball was downloaded and hashed to the same value.
//
// Dropped with install.sh (OF-254): its bundled-app install path and the codesign check on "Herdr Core.app" (taken only when the tarball
// holds the app and, on macOS, the install dir is under $HOME; the 0.1.17 tarballs for the three targets hold herdr-core, LICENSE and
// THIRD-PARTY-NOTICES and no app bundle, so neither ran for the CI or Docker installs), the `?src=install` download-counter mark, and the update/downgrade logic.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => readFileSync(join(REPO_ROOT, ...p), "utf8");
/** The file without its comment lines: what the file DOES, not what it says about the old design. */
const code = (text) => text.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
const dockerfile = code(read("docker", "testbed", "Dockerfile"));
const workflow = code(read(".github", "workflows", "tests.yml"));
const buildVerb = read("scripts", "build-testbed-image.sh");
const PIN = join(REPO_ROOT, "docker", "testbed", "hc-pin.env");
const INSTALLER = join(REPO_ROOT, "docker", "testbed", "install-pinned-hc.sh");

const PINNED_HC = "0.1.17";
const EXPECTED_PINS = {
  HC_SHA256_LINUX_X86_64: "82ec44043f6894bfdb716b979b87cda43fd7fa46b0104e7b7bd93e64d1a9b877",
  HC_SHA256_LINUX_AARCH64: "3a37a454ec63494cf4306db26481fe9db96673d888723701d24f8a992ae8ab8c",
  HC_SHA256_MACOS_AARCH64: "cedbd4d4d9ba1385588198dd4d3c67d2654478f33add5b6445d4d0eb9da5fcf3",
};

/** KEY=value lines of a pin file (comments and blanks skipped). */
const parsePin = (text) => Object.fromEntries(text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));

test("the pin file names the hc version and exactly the three targets' tarball checksums, as restated here", () => {
  assert.deepEqual(parsePin(readFileSync(PIN, "utf8")), { HC_VERSION: PINNED_HC, ...EXPECTED_PINS });
});

test("the Dockerfile installs from the pin file with the installer, copied in before it runs, and no longer runs install.sh", () => {
  assert.doesNotMatch(dockerfile, /install\.sh|HC_INSTALLER_SHA256|releases\.herdr\.dev\/core\/install/, "no installer-script download or hash is left");
  const copy = dockerfile.indexOf("hc-pin.env");
  const run = dockerfile.indexOf("install-pinned-hc.sh /tmp/hc-pin.env", copy);
  assert.ok(copy !== -1 && /^COPY\s+hc-pin\.env\s+install-pinned-hc\.sh\s+\/tmp\/$/m.test(dockerfile), "COPY hc-pin.env install-pinned-hc.sh /tmp/");
  assert.ok(run > copy, "the installer runs after both files are copied in");
  assert.match(dockerfile, /\. \/tmp\/hc-pin\.env; test "\$\(hc --version\)" = "hc \$\{HC_VERSION\}"/, "the build proves the installed version against the pin file's");
  assert.doesNotMatch(dockerfile, /^ARG\s+HC_VERSION/m, "the version lives in the pin file only");
});

test("hc is installed as root, before the non-root user takes over", () => {
  assert.ok(dockerfile.indexOf("install-pinned-hc.sh /tmp/hc-pin.env /usr/local/bin") !== -1);
  assert.ok(dockerfile.indexOf("install-pinned-hc.sh /tmp/hc-pin.env /usr/local/bin") < dockerfile.search(/^USER openrig$/m));
});

test("the image build verb puts both files in the build context", () => {
  assert.match(buildVerb, /cp "\$\{TESTBED_DIR\}\/Dockerfile" "\$\{TESTBED_DIR\}\/entrypoint\.sh" "\$\{TESTBED_DIR\}\/hc-pin\.env" "\$\{TESTBED_DIR\}\/install-pinned-hc\.sh" "\$\{CONTEXT\}\/"/);
});

test("the CI package-tests job installs from the same pin file with the same installer, and puts it on PATH", () => {
  assert.doesNotMatch(workflow, /install\.sh|HC_INSTALLER_SHA256|shasum -a 256 -c/, "no installer-script download or hash is left");
  assert.doesNotMatch(workflow, /^\s+HC_VERSION:/m, "the version lives in the pin file only");
  assert.match(workflow, /sh docker\/testbed\/install-pinned-hc\.sh docker\/testbed\/hc-pin\.env "\$hc_bin"/);
  assert.match(workflow, /GITHUB_PATH/);
});

test("tmux is still installed in both while tmux code remains (hc is added beside it, not instead)", () => {
  assert.match(dockerfile, /\btmux\b[^\n]*tini/, "the image's apt layer keeps tmux");
  assert.match(workflow, /^\s+- run: brew install tmux$/m, "CI keeps brew install tmux");
});

// ---- the installer, run against a local release tree (file://), so a wrong literal or a missing target is a failure here ----

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** A fake release tree with one tarball per target holding a `herdr-core` that prints `hc <version>`; returns its URL base and the tarballs' hashes. */
function releaseTree(root, version, targets, printed = version) {
  const hashes = {};
  for (const target of targets) {
    const stage = join(root, `stage-${target}`);
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, "herdr-core"), `#!/bin/sh\necho "hc ${printed}"\n`, { mode: 0o755 });
    mkdirSync(join(root, "rel", "core", version), { recursive: true });
    const tgz = join(root, "rel", "core", version, `herdr-core-${target}.tar.gz`);
    assert.equal(spawnSync("tar", ["-czf", tgz, "-C", stage, "herdr-core"]).status, 0);
    hashes[target] = sha256(readFileSync(tgz));
  }
  return { base: `file://${join(root, "rel")}`, hashes };
}

function install(root, pinText, target, extraEnv = {}) {
  const pin = join(root, "hc-pin.env");
  writeFileSync(pin, pinText);
  const dest = join(root, "bin");
  const run = spawnSync("sh", [INSTALLER, pin, dest, target], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: root, ...extraEnv } });
  return { run, dest };
}

function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), "hcpin-"));
  try { fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test("installer: a tarball that matches its pinned literal is installed as herdr-core with an hc link, and the version is proved", () => {
  withRoot((root) => {
    const { base, hashes } = releaseTree(root, "9.9.9", ["linux-x86_64"]);
    const { run, dest } = install(root, `HC_VERSION=9.9.9\nHC_SHA256_LINUX_X86_64=${hashes["linux-x86_64"]}\n`, "linux-x86_64", { HC_RELEASES_URL: base });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(spawnSync(join(dest, "herdr-core"), ["--version"], { encoding: "utf8" }).stdout.trim(), "hc 9.9.9");
    assert.equal(spawnSync(join(dest, "hc"), ["--version"], { encoding: "utf8" }).stdout.trim(), "hc 9.9.9");
  });
});

test("installer: a WRONG literal installs nothing and says the checksum differs", () => {
  withRoot((root) => {
    const { base, hashes } = releaseTree(root, "9.9.9", ["linux-x86_64"]);
    const wrong = (hashes["linux-x86_64"].startsWith("0") ? "1" : "0") + hashes["linux-x86_64"].slice(1);
    const { run, dest } = install(root, `HC_VERSION=9.9.9\nHC_SHA256_LINUX_X86_64=${wrong}\n`, "linux-x86_64", { HC_RELEASES_URL: base });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /checksum mismatch/);
    assert.equal(existsSync(join(dest, "herdr-core")), false, "nothing installed");
  });
});

test("installer: a target the pin file does not name fails before any download, naming the target", () => {
  withRoot((root) => {
    const { base, hashes } = releaseTree(root, "9.9.9", ["linux-x86_64", "linux-aarch64"]);
    const { run, dest } = install(root, `HC_VERSION=9.9.9\nHC_SHA256_LINUX_X86_64=${hashes["linux-x86_64"]}\n`, "linux-aarch64", { HC_RELEASES_URL: "file:///nonexistent-no-download-expected" });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /no pinned checksum for linux-aarch64/);
    assert.equal(existsSync(join(dest, "herdr-core")), false);
    void base;
  });
});

test("installer: a pinned value that is not 64 hex digits is refused, not compared", () => {
  withRoot((root) => {
    const { base } = releaseTree(root, "9.9.9", ["linux-x86_64"]);
    const { run } = install(root, "HC_VERSION=9.9.9\nHC_SHA256_LINUX_X86_64=abc123\n", "linux-x86_64", { HC_RELEASES_URL: base });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /not a 64-digit sha256/);
  });
});

test("installer: a tarball whose binary does not report the pinned version is refused and not installed", () => {
  withRoot((root) => {
    const { base, hashes } = releaseTree(root, "9.9.9", ["linux-x86_64"], "9.9.8");
    const { run, dest } = install(root, `HC_VERSION=9.9.9\nHC_SHA256_LINUX_X86_64=${hashes["linux-x86_64"]}\n`, "linux-x86_64", { HC_RELEASES_URL: base });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /reports "hc 9\.9\.8", the pin says 9\.9\.9/);
    assert.equal(existsSync(join(dest, "herdr-core")), false);
  });
});

test("installer: the default release host is releases.herdr.dev and the tarball URL is the version's own path, with no script download", () => {
  const text = code(readFileSync(INSTALLER, "utf8"));
  assert.match(text, /\$\{HC_RELEASES_URL:-https:\/\/releases\.herdr\.dev\}/);
  assert.match(text, /\$releases\/core\/\$HC_VERSION\/herdr-core-\$target\.tar\.gz/);
  assert.doesNotMatch(text, /install\.sh|manifest\.json|latest\.json/, "the installer reads no manifest and no script; the literals are in the pin file");
  assert.deepEqual([...text.matchAll(/https?:\/\/[^\s"')]+/g)].map((m) => m[0]).filter((u) => !u.includes("herdr.dev")), []);
});

// ---- OF-254 review nits: https-only curl, no checksum from the environment, non-hex literal, one named tar member ----

/** A PATH directory holding a logging `curl` (fails by default, so no transfer happens; or runs the real one) and a logging `tar` (then runs the real one); returns the PATH to use and the log paths. */
function shims(root, { curlFails = true } = {}) {
  const dir = join(root, "shims");
  mkdirSync(dir, { recursive: true });
  const curlLog = join(root, "curl.args");
  const tarLog = join(root, "tar.args");
  const realTar = spawnSync("sh", ["-c", "command -v tar"], { encoding: "utf8" }).stdout.trim();
  const realCurl = spawnSync("sh", ["-c", "command -v curl"], { encoding: "utf8" }).stdout.trim();
  const curlEnd = curlFails ? "exit 22" : `exec "${realCurl}" "$@"`;
  writeFileSync(join(dir, "curl"), `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done >> "${curlLog}"\n${curlEnd}\n`);
  writeFileSync(join(dir, "tar"), `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done >> "${tarLog}"\nexec "${realTar}" "$@"\n`);
  chmodSync(join(dir, "curl"), 0o755);
  chmodSync(join(dir, "tar"), 0o755);
  const lines = (f) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : []);
  return { path: `${dir}:${process.env.PATH}`, curl: () => lines(curlLog), tar: () => lines(tarLog) };
}
/** The value following `flag` in an argv list. */
const argAfter = (args, flag) => args[args.indexOf(flag) + 1];

const PIN_X86 = (h) => `HC_VERSION=9.9.9\nHC_SHA256_LINUX_X86_64=${h}\n`;
const GOOD_HEX = "a".repeat(64);

test("installer: production (HC_RELEASES_URL unset) lets curl use https only, redirects included; file: is allowed only when the test override is set", () => {
  withRoot((root) => {
    const sh = shims(root);
    install(root, PIN_X86(GOOD_HEX), "linux-x86_64", { PATH: sh.path });
    const prod = sh.curl();
    assert.ok(prod.length > 0, "the fake curl was reached");
    assert.equal(argAfter(prod, "--proto"), "=https", "first hop: https only, no file:");
    assert.equal(argAfter(prod, "--proto-redir"), "=https", "redirects: https only");
    assert.ok(prod.some((a) => a.startsWith("https://releases.herdr.dev/core/9.9.9/")), "the production URL is https on the release host");
  });
  withRoot((root) => {
    const sh = shims(root);
    install(root, PIN_X86(GOOD_HEX), "linux-x86_64", { PATH: sh.path, HC_RELEASES_URL: "file:///nonexistent" });
    const test = sh.curl();
    assert.equal(argAfter(test, "--proto"), "=https,file", "the test override may read file: on the first hop");
    assert.equal(argAfter(test, "--proto-redir"), "=https", "a redirect still has to be https");
  });
});

test("installer: nothing that ships sets HC_RELEASES_URL (Dockerfile, workflow, build verb), so production never reaches the file: allowance", () => {
  assert.doesNotMatch(dockerfile, /HC_RELEASES_URL/);
  assert.doesNotMatch(workflow, /HC_RELEASES_URL/);
  assert.doesNotMatch(buildVerb, /HC_RELEASES_URL/);
});

test("installer: a checksum preset in the environment never supplies a target the pin file lacks", () => {
  withRoot((root) => {
    const { base, hashes } = releaseTree(root, "9.9.9", ["linux-aarch64"]);
    const { run, dest } = install(root, PIN_X86(GOOD_HEX), "linux-aarch64", { HC_RELEASES_URL: base, HC_SHA256_LINUX_AARCH64: hashes["linux-aarch64"] });
    assert.notEqual(run.status, 0, "the right hash in the environment must not make this install succeed");
    assert.match(run.stderr, /no pinned checksum for linux-aarch64/);
    assert.equal(existsSync(join(dest, "herdr-core")), false);
  });
});

test("installer: a checksum preset in the environment never supplies an unknown target either (the variable is derived from any target name)", () => {
  withRoot((root) => {
    const { base, hashes } = releaseTree(root, "9.9.9", ["linux-riscv"]);
    const { run, dest } = install(root, PIN_X86(GOOD_HEX), "linux-riscv", { HC_RELEASES_URL: base, HC_SHA256_LINUX_RISCV: hashes["linux-riscv"] });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /no pinned checksum for linux-riscv/);
    assert.equal(existsSync(join(dest, "herdr-core")), false);
  });
});

test("installer: a checksum preset in the environment never replaces the pin file's value (the pin file's wrong literal still fails)", () => {
  withRoot((root) => {
    const { base, hashes } = releaseTree(root, "9.9.9", ["linux-x86_64"]);
    const { run, dest } = install(root, PIN_X86(GOOD_HEX), "linux-x86_64", { HC_RELEASES_URL: base, HC_SHA256_LINUX_X86_64: hashes["linux-x86_64"] });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /checksum mismatch/);
    assert.equal(existsSync(join(dest, "herdr-core")), false);
  });
});

test("installer: a 64-character pinned value with a non-hex character (or upper case) is refused as not a sha256, before any download", () => {
  for (const bad of ["z".repeat(64), `${"a".repeat(63)}g`, "A".repeat(64)]) {
    withRoot((root) => {
      const sh = shims(root);
      const { run } = install(root, PIN_X86(bad), "linux-x86_64", { PATH: sh.path, HC_RELEASES_URL: "file:///nonexistent-no-download-expected" });
      assert.notEqual(run.status, 0, bad);
      assert.match(run.stderr, /not a 64-digit sha256/, bad);
      assert.deepEqual(sh.curl(), [], `${bad}: curl never ran`);
    });
  }
});

test("installer: only the named member herdr-core is extracted from the tarball", () => {
  withRoot((root) => {
    const { base, hashes } = releaseTree(root, "9.9.9", ["linux-x86_64"]);
    const sh = shims(root, { curlFails: false });
    const { run } = install(root, PIN_X86(hashes["linux-x86_64"]), "linux-x86_64", { PATH: sh.path, HC_RELEASES_URL: base });
    assert.equal(run.status, 0, run.stderr);
    const args = sh.tar();
    assert.equal(args.at(-1), "herdr-core", "the last tar argument is the member name");
    assert.ok(args.includes("-xzf") && args.includes("-C"), "an extraction into a directory");
  });
});

test("installer: a tarball without a herdr-core member is refused with that message", () => {
  withRoot((root) => {
    const { base } = releaseTree(root, "9.9.9", ["linux-x86_64"]);
    const stage = join(root, "other");
    mkdirSync(stage);
    writeFileSync(join(stage, "LICENSE"), "x\n");
    const tgz = join(root, "rel", "core", "9.9.9", "herdr-core-linux-x86_64.tar.gz");
    assert.equal(spawnSync("tar", ["-czf", tgz, "-C", stage, "LICENSE"]).status, 0);
    const { run, dest } = install(root, PIN_X86(sha256(readFileSync(tgz))), "linux-x86_64", { HC_RELEASES_URL: base });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /the tarball holds no herdr-core/);
    assert.equal(existsSync(join(dest, "herdr-core")), false);
  });
});
