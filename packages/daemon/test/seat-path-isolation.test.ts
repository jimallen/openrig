import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withoutSeatPath } from "../../../scripts/seat-path.mjs";
import { inheritedTestEnv, testDaemonEnv } from "./helpers/daemon-entrypoint.js";
import { prepareHermeticEnv, type HermeticScaffold } from "./helpers/hermetic-env.js";

// workspaces-o9o.77. A seat's PATH starts with its own rig (<OPENRIG_HOME>/run/seat-bin/<hash>) and the git worktree shim
// (<OPENRIG_HOME>/rig-bin). A suite run from such a seat used the shim's git, which moved the fixtures' worktrees into
// <repo>/.rig-worktrees (83 worktree-sweep tests and 2 daemon tests failed). The test setup and the helpers drop both folders.

const SETUP = path.resolve(import.meta.dirname, "../../../test/hermetic-env.setup.ts");
const VITEST_BIN = path.join(path.dirname(createRequire(import.meta.url).resolve("vitest/package.json")), "vitest.mjs");
const temps: string[] = [];
const scaffolds: HermeticScaffold[] = [];
afterEach(() => {
  for (const s of scaffolds.splice(0)) s.cleanup();
  for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A seat's two PATH-head folders under a temp OpenRig home, the shim's `git` failing loudly, and a PATH that starts with them. */
function seatPath(): { rigBin: string; seatBin: string; path: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "o9o77-"));
  temps.push(root);
  const rigBin = path.join(root, ".openrig", "rig-bin");
  const seatBin = path.join(root, ".openrig", "run", "seat-bin", "f".repeat(64));
  for (const dir of [rigBin, seatBin]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(rigBin, "git"), "#!/bin/sh\necho 'seat shim reached' >&2\nexit 97\n", { mode: 0o755 });
  // The host's own PATH without ITS seat folders (a run from a seat has them), so the fake ones are the only seat entries given.
  return { rigBin, seatBin, path: [seatBin, rigBin, withoutSeatPath(process.env["PATH"]) ?? ""].join(path.delimiter) };
}

/** The fake seat folders found in `value`, judged by the fixture's own paths, never by the predicate under test. */
const seatEntries = (value: string | undefined, seat: { rigBin: string; seatBin: string }) =>
  (value ?? "").split(path.delimiter).filter((d) => d === seat.rigBin || d === seat.seatBin);

describe("o9o.77: no test process sees a seat's PATH head", () => {
  it("a vitest worker started with the seat's folders first on PATH runs without them (the hermetic setup)", () => {
    const seat = seatPath();
    const nested = fs.mkdtempSync(path.join(os.tmpdir(), "o9o77-nested-"));
    temps.push(nested);
    fs.writeFileSync(path.join(nested, "vitest.config.mjs"), `export default { test: { setupFiles: [${JSON.stringify(SETUP)}], include: ["*.test.mjs"] } };\n`);
    fs.writeFileSync(path.join(nested, "probe.test.mjs"),
      `import fs from "node:fs"; import { test } from "vitest";\ntest("probe", () => { fs.writeFileSync(${JSON.stringify(path.join(nested, "path-seen"))}, process.env.PATH ?? ""); });\n`);
    const r = spawnSync(process.execPath, [VITEST_BIN, "run", "--root", nested, "--config", path.join(nested, "vitest.config.mjs")], {
      cwd: nested, encoding: "utf8", env: { ...process.env, PATH: seat.path, OPENRIG_HOME: "", OPENRIG_TEST_FIXTURE_REGISTRY: "", OPENRIG_TEST_FIXTURE_REGISTRY_OWNER: "" },
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const seen = fs.readFileSync(path.join(nested, "path-seen"), "utf8");
    expect(seatEntries(seat.path, seat), "positive control: the nested run was given the seat's folders").toEqual([seat.seatBin, seat.rigBin]);
    expect(seatEntries(seen, seat)).toEqual([]);
    expect(seen.length).toBeGreaterThan(0);
  }, 180_000);

  it("the daemon test helpers drop them from a caller's PATH (inheritedTestEnv, testDaemonEnv)", () => {
    const seat = seatPath();
    expect(seatEntries(inheritedTestEnv({ PATH: seat.path })["PATH"], seat)).toEqual([]);
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "o9o77-home-")));
    temps.push(home);
    expect(seatEntries(testDaemonEnv({ home }, 1, { PATH: seat.path })["PATH"], seat)).toEqual([]);
  });

  it("the scenario scaffold drops them from its children's PATH and its tmux wrapper's", () => {
    const seat = seatPath();
    const scaffold = prepareHermeticEnv({ baseEnv: { PATH: seat.path, TERM: "xterm" } });
    scaffolds.push(scaffold);
    expect(seatEntries(scaffold.env["PATH"], seat)).toEqual([]);
    expect(seatEntries(scaffold.tmuxEnv["PATH"], seat)).toEqual([]);
    const wrapper = fs.readFileSync(path.join(scaffold.root, "bin", "tmux"), "utf8");
    expect(wrapper).not.toContain(seat.rigBin);
  });
});
