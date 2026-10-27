// OF-80: the hermetic setup (test/hermetic-env.setup.ts) creates a fixture OPENRIG_HOME and
// a `-user-home` sibling per test process. Consequence pinned here: a suite run must not
// leave `.openrig-test-fixture-home-*` directories behind in the temp dir (a long-lived
// build host accumulated ~467,000 of them). Observed end to end: a nested vitest run with a
// private TMPDIR, once with a passing test and once with a failing one.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { teardown as globalTeardown } from "../../../test/hermetic-env.global.js";

const SETUP = path.resolve(__dirname, "../../../test/hermetic-env.setup.ts");
const GLOBAL_SETUP = path.resolve(__dirname, "../../../test/hermetic-env.global.ts");
const VITEST_BIN = path.join(path.dirname(createRequire(import.meta.url).resolve("vitest/package.json")), "vitest.mjs");
const PREFIX = ".openrig-test-fixture-home-";

// The probe records the OPENRIG_HOME it was handed (positive control that a fixture home
// existed during the run), then passes or throws.
const probe = (outcome: "pass" | "fail") =>
  `import fs from "node:fs";\n` +
  `test("probe", () => {\n` +
  `  fs.writeFileSync("home-seen", process.env.OPENRIG_HOME ?? "");\n` +
  (outcome === "fail" ? `  throw new Error("deliberate");\n` : "") +
  `});\n`;

// `skippedFile` adds a second file whose tests are all skipped: vitest never runs hooks for it, so the
// setup's own afterAll cannot remove the fixture home that file's worker created (OF-82).
// `globalSetup` wires the run the way the package vitest configs do.
function nestedRun(outcome: "pass" | "fail", opts: { skippedFile?: boolean; globalSetup?: boolean; outerRegistry?: string } = {}): { leftovers: string[]; homeSeen: string; status: number | null } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "of80-nested-"));
  const nestedTmp = path.join(root, "tmp");
  fs.mkdirSync(nestedTmp);
  try {
    fs.writeFileSync(path.join(root, "vitest.config.mjs"),
      `export default { test: { globals: true, ${opts.globalSetup ? `globalSetup: [${JSON.stringify(GLOBAL_SETUP)}], ` : ""}setupFiles: [${JSON.stringify(SETUP)}], include: ["*.test.mjs"] } };\n`);
    fs.writeFileSync(path.join(root, "probe.test.mjs"), probe(outcome));
    if (opts.skippedFile) fs.writeFileSync(path.join(root, "skipped.test.mjs"), `describe.skip("all skipped", () => { test("never runs", () => {}); });\n`);
    const r = spawnSync(process.execPath, [VITEST_BIN, "run", "--root", root, "--config", path.join(root, "vitest.config.mjs")], {
      cwd: root,
      env: { ...process.env, TMPDIR: nestedTmp, OPENRIG_HOME: "", OPENRIG_TEST_FIXTURE_REGISTRY: opts.outerRegistry ?? "", OPENRIG_TEST_FIXTURE_REGISTRY_OWNER: opts.outerRegistry ? "1" : "" },
      encoding: "utf8",
    });
    const seenPath = path.join(root, "home-seen");
    return {
      leftovers: fs.readdirSync(nestedTmp).filter((n) => n.startsWith(".openrig-test-fixture-")),
      homeSeen: fs.existsSync(seenPath) ? fs.readFileSync(seenPath, "utf8") : "",
      status: r.status,
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("hermetic setup fixture-home cleanup (OF-80)", () => {
  it("leaves no fixture home behind after a passing run", () => {
    const r = nestedRun("pass");
    expect(r.homeSeen, "positive control: the nested run was given a fixture home").toContain(PREFIX);
    expect(r.status).toBe(0);
    expect(r.leftovers).toEqual([]);
  });
  it("leaves no fixture home behind after a failing run", () => {
    const r = nestedRun("fail");
    expect(r.homeSeen, "positive control: the nested run was given a fixture home").toContain(PREFIX);
    expect(r.status).not.toBe(0);
    expect(r.leftovers).toEqual([]);
  });

  // OF-82. vitest runs no hooks for a file whose tests are all skipped, so the setup's afterAll never
  // removes that worker's fixture home. The control pins that premise: without the run-level
  // globalSetup the skipped file leaves its home and its `-user-home` sibling behind.
  it("control: without the globalSetup, a fully skipped file leaves its fixture home behind", () => {
    const r = nestedRun("pass", { skippedFile: true });
    expect(r.status).toBe(0);
    expect(r.leftovers).toHaveLength(2);
    expect(r.leftovers.some((n) => n.endsWith("-user-home"))).toBe(true);
  });
  it("leaves no fixture home behind when a test file is skipped entirely", () => {
    const r = nestedRun("pass", { skippedFile: true, globalSetup: true });
    expect(r.homeSeen, "positive control: the passing file was given a fixture home").toContain(PREFIX);
    expect(r.status).toBe(0);
    expect(r.leftovers).toEqual([]);
  });
  it("leaves no fixture home or registry behind after a failing run with a skipped file", () => {
    const r = nestedRun("fail", { skippedFile: true, globalSetup: true });
    expect(r.status).not.toBe(0);
    expect(r.leftovers).toEqual([]);
  });
  // A vitest started from inside a test inherits the outer run's registry variables. Its teardown must
  // clean only what it registered itself, never the outer run's live fixture home.
  it("a nested run's teardown leaves the outer run's registered fixture home alone", () => {
    const outer = fs.mkdtempSync(path.join(os.tmpdir(), "of82-outer-"));
    try {
      const outerRegistry = path.join(outer, "registry");
      const outerHome = path.join(outer, ".openrig-test-fixture-home-outer");
      fs.mkdirSync(outerRegistry);
      fs.mkdirSync(outerHome);
      fs.writeFileSync(path.join(outerRegistry, "entry"), outerHome);
      const r = nestedRun("pass", { globalSetup: true, outerRegistry });
      expect(r.status).toBe(0);
      expect(fs.existsSync(outerHome), "the outer run's fixture home survived the nested teardown").toBe(true);
      expect(fs.existsSync(path.join(outerRegistry, "entry"))).toBe(true);
    } finally {
      fs.rmSync(outer, { recursive: true, force: true });
    }
  });
  // The registry holds paths, and teardown deletes recursively: it must delete only fixture homes.
  it("teardown removes registered fixture homes and refuses any other registered path", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "of82-guard-"));
    const saved = { r: process.env.OPENRIG_TEST_FIXTURE_REGISTRY, o: process.env.OPENRIG_TEST_FIXTURE_REGISTRY_OWNER };
    try {
      const registry = path.join(root, "registry");
      const home = path.join(root, `${PREFIX}real`);
      const userHome = `${home}-user-home`;
      const stranger = path.join(root, "not-a-fixture-home");
      for (const d of [registry, home, userHome, stranger]) fs.mkdirSync(d);
      fs.writeFileSync(path.join(registry, "a"), home);
      fs.writeFileSync(path.join(registry, "b"), stranger);
      process.env.OPENRIG_TEST_FIXTURE_REGISTRY = registry;
      process.env.OPENRIG_TEST_FIXTURE_REGISTRY_OWNER = String(process.pid);
      globalTeardown();
      expect(fs.existsSync(home), "positive control: a registered fixture home is removed").toBe(false);
      expect(fs.existsSync(userHome)).toBe(false);
      expect(fs.existsSync(stranger), "a registered path that is not a fixture home survives").toBe(true);
    } finally {
      if (saved.r === undefined) delete process.env.OPENRIG_TEST_FIXTURE_REGISTRY; else process.env.OPENRIG_TEST_FIXTURE_REGISTRY = saved.r;
      if (saved.o === undefined) delete process.env.OPENRIG_TEST_FIXTURE_REGISTRY_OWNER; else process.env.OPENRIG_TEST_FIXTURE_REGISTRY_OWNER = saved.o;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("is wired into every package vitest config that uses the hermetic setup", () => {
    for (const pkg of ["cli", "daemon", "tui"]) {
      const config = fs.readFileSync(path.resolve(__dirname, `../../${pkg}/vitest.config.ts`), "utf8");
      expect(config, pkg).toContain("hermetic-env.setup.ts");
      expect(config, pkg).toContain("hermetic-env.global.ts");
    }
  });
});
