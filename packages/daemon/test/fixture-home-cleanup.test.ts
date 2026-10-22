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

const SETUP = path.resolve(__dirname, "../../../test/hermetic-env.setup.ts");
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

function nestedRun(outcome: "pass" | "fail"): { leftovers: string[]; homeSeen: string; status: number | null } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "of80-nested-"));
  const nestedTmp = path.join(root, "tmp");
  fs.mkdirSync(nestedTmp);
  try {
    fs.writeFileSync(path.join(root, "vitest.config.mjs"),
      `export default { test: { globals: true, setupFiles: [${JSON.stringify(SETUP)}], include: ["probe.test.mjs"] } };\n`);
    fs.writeFileSync(path.join(root, "probe.test.mjs"), probe(outcome));
    const r = spawnSync(process.execPath, [VITEST_BIN, "run", "--root", root, "--config", path.join(root, "vitest.config.mjs")], {
      cwd: root,
      env: { ...process.env, TMPDIR: nestedTmp, OPENRIG_HOME: "" },
      encoding: "utf8",
    });
    const seenPath = path.join(root, "home-seen");
    return {
      leftovers: fs.readdirSync(nestedTmp).filter((n) => n.startsWith(PREFIX)),
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
});
