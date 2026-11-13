// A scenario daemon never reaches the host's Herdr app. The daemon drives the app through `herdr-app` on its PATH (`rig terminal open`,
// `rig terminal status`, and the names a relaunch puts back, hc-placement-names.ts), and a scenario daemon is started with the host's PATH:
// on a Mac that runs the app (stu: `herdr-app` beside `hc` in ~/.local/bin) that is the person's own window. spawnScenarioDaemon hides
// `herdr-app` and nothing else (helpers/path-without-herdr-app.ts).
//   - pathWithoutHerdrApp, on folders made here: the app is gone, the programs beside it are still found, in order.
//   - The host's own PATH: `node` and `hc` still resolve, to the same files, and `herdr-app` does not.
//   - A real scenario daemon, asked `rig terminal status` (which runs `herdr-app ls`, read-only): a logging stand-in for the host's app,
//     first on the PATH the test hands the helper, is never called; the same stand-in inside the scaffold is (positive control).
// Not proven: the real Herdr app (never run here). Linux runs every row (folders and symlinks only).
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareHermeticEnv, type HermeticScaffold } from "./helpers/hermetic-env.js";
import { runRig, spawnScenarioDaemon, type ScenarioDaemon } from "./helpers/scenario-daemon.js";
import { findHc } from "./helpers/hc-scratch.js";
import { herdrAppDirsOn, pathWithoutHerdrApp } from "./helpers/path-without-herdr-app.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const RIG_BIN = resolve(HERE, "../../cli/dist/bin-wrapper.js");

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };

/** Where `name` resolves on `pathEnv`, as a shell finds it (`command -v`), or "" when it does not. */
const which = (name: string, pathEnv: string): string =>
  spawnSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8", env: { PATH: pathEnv } }).stdout.trim();

/** An executable script at `dir/name` that appends its argv to `log` and prints `out`. */
function program(dir: string, name: string, log: string, out = ""): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `#!/bin/sh\necho "$0 $*" >> '${log}'\nprintf '%s' '${out}'\n`);
  chmodSync(join(dir, name), 0o755);
}

describe("pathWithoutHerdrApp hides herdr-app and nothing else", () => {
  it("a folder holding herdr-app is replaced by a copy without it: what was beside it is still found, the order is kept", () => {
    const root = tmp("pwha-");
    const log = join(root, "calls.log");
    const system = join(root, "usr-bin");   // herdr-app installed beside the system's own programs, as in /usr/bin
    const later = join(root, "later");
    program(system, "herdr-app", log);
    program(system, "mynode", log);
    program(system, "mysh", log);
    program(later, "mynode", log);           // a second mynode, later on PATH: the first must still win
    program(later, "other", log);
    const shims = join(root, "shims");
    mkdirSync(shims);

    const filtered = pathWithoutHerdrApp([system, "", "relative/bin", later].join(delimiter), shims);
    const entries = filtered.split(delimiter);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.startsWith(`${shims}/`), "the system folder is replaced in place by a copy").toBe(true);
    expect(entries[1]).toBe(later);
    expect(herdrAppDirsOn(filtered)).toEqual([]);
    expect(which("herdr-app", filtered)).toBe("");
    expect(realpathSync(which("mynode", filtered))).toBe(realpathSync(join(system, "mynode")));
    expect(realpathSync(which("mysh", filtered))).toBe(realpathSync(join(system, "mysh")));
    expect(which("other", filtered)).toBe(join(later, "other"));
    // The copy runs the real program (a symlink, not a stand-in).
    expect(spawnSync(which("mynode", filtered), ["x"]).status).toBe(0);
    expect(readFileSync(log, "utf8")).toContain("mynode x");
    // Positive control: the same PATH unfiltered finds the app.
    expect(which("herdr-app", [system, later].join(delimiter))).toBe(join(system, "herdr-app"));
  });

  it("a folder inside keepUnder is the test's own fake, and stays", () => {
    const root = tmp("pwha-");
    const fake = join(root, "scaffold", "fake-app");
    const host = join(root, "host-bin");
    program(fake, "herdr-app", join(root, "fake.log"));
    program(host, "herdr-app", join(root, "host.log"));
    const filtered = pathWithoutHerdrApp([fake, host].join(delimiter), root, join(root, "scaffold"));
    expect(herdrAppDirsOn(filtered)).toEqual([fake]);
  });

  it("on this host's own PATH, node and hc still resolve to the same files and herdr-app does not", () => {
    const hostPath = process.env.PATH ?? "";
    const filtered = pathWithoutHerdrApp(hostPath, tmp("pwha-"));
    expect(herdrAppDirsOn(filtered)).toEqual([]);
    expect(which("herdr-app", filtered)).toBe("");
    const node = which("node", hostPath);
    expect(node, "positive control: node is on this host's PATH").not.toBe("");
    expect(realpathSync(which("node", filtered))).toBe(realpathSync(node));
    const hc = findHc();
    if (hc !== null) expect(realpathSync(which("hc", filtered))).toBe(realpathSync(hc));
  });
});

describe.runIf(findHc() !== null)("a scenario daemon never reaches a herdr-app outside its scaffold", () => {
  let scaffold: HermeticScaffold | undefined;
  let daemon: ScenarioDaemon | undefined;
  afterEach(async () => {
    if (daemon) await daemon.stop().catch(() => {});
    else scaffold?.cleanup();
    daemon = undefined;
    scaffold = undefined;
  });

  type Status = { providers: Array<{ name: string; status: { available: boolean }; liveness: { alive: boolean; detail?: string } }> };
  const status = async (d: ScenarioDaemon): Promise<Status> => {
    const out = await runRig(["terminal", "status", "--json"], d.readEnv, RIG_BIN, 60_000);
    expect(out.code, out.stdout + out.stderr).toBe(0);
    return JSON.parse(out.stdout) as Status;
  };

  it("the host's app, first on the PATH the test gives, is hidden: `rig terminal status` never runs it and says the app is not installed", async () => {
    // Stands in for the host's real app and sits FIRST on PATH, so a daemon that is not protected runs this one, never the real app.
    const hostBin = tmp("host-app-");
    const log = join(hostBin, "calls.log");
    program(hostBin, "herdr-app", log, '{"spaces":[]}');
    scaffold = prepareHermeticEnv({ baseEnv: { HOME: process.env.HOME, PATH: `${hostBin}${delimiter}${process.env.PATH ?? ""}`, TERM: "xterm" } });
    daemon = await spawnScenarioDaemon(scaffold, { rigBin: RIG_BIN });
    expect(herdrAppDirsOn(daemon.readEnv.PATH), "no herdr-app on the PATH the daemon was started with").toEqual([]);
    const herdr = (await status(daemon)).providers.find((p) => p.name === "herdr");
    expect(herdr?.liveness.alive).toBe(false);
    expect(herdr?.liveness.detail).toMatch(/herdr-app is not installed/);
    expect(existsSync(log), "the host's herdr-app was never run").toBe(false);
  }, 120_000);

  it("positive control: the same stand-in inside the scaffold is the daemon's, and `rig terminal status` runs it", async () => {
    scaffold = prepareHermeticEnv({ baseEnv: { HOME: process.env.HOME, PATH: process.env.PATH, TERM: "xterm" } });
    const fakeBin = join(scaffold.root, "fake-app");
    const log = join(fakeBin, "calls.log");
    program(fakeBin, "herdr-app", log, '{"spaces":[]}');
    scaffold.env.PATH = `${fakeBin}${delimiter}${scaffold.env.PATH ?? ""}`;
    daemon = await spawnScenarioDaemon(scaffold, { rigBin: RIG_BIN });
    expect(herdrAppDirsOn(daemon.readEnv.PATH)).toEqual([fakeBin]);
    const herdr = (await status(daemon)).providers.find((p) => p.name === "herdr");
    expect(herdr?.liveness.alive, JSON.stringify(herdr)).toBe(true);
    expect(readFileSync(log, "utf8")).toMatch(/herdr-app ls/);
  }, 120_000);
});
