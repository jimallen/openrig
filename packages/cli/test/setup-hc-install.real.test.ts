// A fake `hc --version` can only assume what the real one prints and how a missing hc fails. Here `hc --version` is the real binary,
// run under a private HOME and XDG paths (it starts no core, and the test proves no socket appeared), and a missing hc is the shell's
// own failure. Only the installer is replaced: it links the real hc into a directory, as the real installer would put it on PATH.
// Nothing is downloaded and no real installer runs.
import { afterAll, describe, expect, it } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSetup, type SetupDeps } from "../src/commands/setup.js";

const HC = spawnSync("sh", ["-c", "command -v hc"], { encoding: "utf8" }).stdout.trim();
const PIN = "0.1.15";
const INSTALL = `curl -fsSL https://releases.herdr.dev/core/install.sh | HC_VERSION=${PIN} sh`;

describe.skipIf(!HC)("setup's hc step against the real hc binary", () => {
  const root = mkdtempSync(join(tmpdir(), "shc-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function world() {
    const home = join(root, `h${Math.random().toString(36).slice(2)}`);
    const bin = join(home, "bin");
    for (const d of ["bin", "c", "d", "s", "r"]) mkdirSync(join(home, d), { recursive: true, mode: 0o700 });
    symlinkSync(realpathSync(HC), join(bin, "hc"));
    const state = { path: "/usr/bin:/bin" };
    const env = () => ({ PATH: state.path, HOME: home, HC_SESSION: `s${process.pid}`, XDG_CONFIG_HOME: join(home, "c"), XDG_DATA_HOME: join(home, "d"), XDG_STATE_HOME: join(home, "s"), XDG_RUNTIME_DIR: join(home, "r") });
    const ran: string[] = [];
    const deps: SetupDeps = {
      platform: "linux", env: { HOME: home }, exists: () => false, readFile: () => null, writeFile: () => {}, mkdirp: () => {},
      exec: (cmd) => {
        ran.push(cmd);
        if (cmd === "hc --version") return execSync(cmd, { encoding: "utf8", env: env(), stdio: ["ignore", "pipe", "pipe"] });
        if (cmd === INSTALL) { state.path = `${bin}:${state.path}`; return "installed"; }
        if (cmd.endsWith("herdr --version") || cmd.endsWith("herdr' --version")) return "herdr 0.9.5";
        return "available";
      },
    };
    return { deps, ran, state, bin, home };
  }
  const noCore = (home: string) => expect(existsSync(join(home, "r", "herdr-core")) ? readdirSync(join(home, "r", "herdr-core")) : []).toEqual([]);

  it("a real missing hc is not installed, so setup installs, then reads the real version", async () => {
    const w = world();
    const result = await runSetup(w.deps, {});
    expect(w.ran.filter((c) => c === INSTALL)).toHaveLength(1);
    expect(result.steps.find((s) => s.id === "hc_install")).toMatchObject({ status: "applied", message: expect.stringContaining(PIN) });
    noCore(w.home);
  });

  it("control: a real hc already on PATH is left alone", async () => {
    const w = world();
    w.state.path = `${w.bin}:${w.state.path}`;
    const result = await runSetup(w.deps, {});
    expect(w.ran).not.toContain(INSTALL);
    expect(result.steps.find((s) => s.id === "hc_install")).toMatchObject({ status: "pass" });
    noCore(w.home);
  });
});
