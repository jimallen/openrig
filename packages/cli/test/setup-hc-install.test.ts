// hc cutover (Jim, 2026-11-01): `rig setup` installs the pinned hc when it is absent.
//
// Source, read 2026-11-01 (read only, nothing run): https://releases.herdr.dev/core/install.sh is herdr-core's own installer (linked
// from https://herdr.dev/core/). Its header: "HC_VERSION=0.2.0 picks a version". With HC_VERSION set it reads
// https://releases.herdr.dev/core/$HC_VERSION/manifest.json (0.1.15 exists: per-target url and sha256), downloads that target's archive,
// refuses on a sha256 mismatch, and installs ~/.local/bin/herdr-core with `hc` beside it only if no `hc` exists. https://herdr.dev/install.sh
// is another product's installer (`herdr`, the TUI, always the latest, never hc).
//
// Nothing here downloads or runs a real installer: the install is an injected `exec`. The command is restated here, not imported.
import { describe, expect, it, vi } from "vitest";
import { runSetup, type SetupDeps, type SetupStep } from "../src/commands/setup.js";

const PIN = "0.1.15";
const INSTALL = `curl -fsSL https://releases.herdr.dev/core/install.sh | HC_VERSION=${PIN} sh`;

interface World { hc: string | null; binary?: boolean; onInstall?: (set: (hc: string | null) => void) => void | never }

function fixture(world: World, platform: NodeJS.Platform = "darwin") {
  const state = { hc: world.hc };
  const exec = vi.fn((cmd: string, _opts?: { timeoutMs?: number }) => {
    if (cmd === "hc --version") {
      if (state.hc === null) throw new Error("hc: command not found");
      return state.hc;
    }
    if (cmd === INSTALL) { world.onInstall?.((hc) => { state.hc = hc; }); return "installed"; }
    if (cmd.endsWith("herdr --version") || cmd.endsWith("herdr' --version")) return "herdr 0.9.5";
    if (cmd === "brew --version") return "Homebrew 4.0";
    return "available";
  });
  const exists = vi.fn((p: string) => world.binary === true && p === "/fixture/.local/bin/herdr-core");
  const deps: SetupDeps = { platform, env: { HOME: "/fixture" }, exec, exists, readFile: () => null, writeFile: vi.fn(), mkdirp: vi.fn() };
  return { deps, exec };
}
const hcStep = (steps: SetupStep[]) => steps.find((s) => s.id === "hc_install")!;
const installs = (exec: ReturnType<typeof fixture>["exec"]) => exec.mock.calls.filter(([cmd]) => /releases\.herdr\.dev|HC_VERSION/.test(cmd));

describe("setup installs the pinned hc when it is absent", () => {
  it.each(["darwin", "linux"] as const)("runs the pinned installer once on %s, then verifies the version it left", async (platform) => {
    const f = fixture({ hc: null, onInstall: (set) => set(`hc ${PIN}\n`) }, platform);
    const result = await runSetup(f.deps, {});
    expect(installs(f.exec)).toEqual([[INSTALL, { timeoutMs: 300_000 }]]);
    expect(hcStep(result.steps)).toMatchObject({ status: "applied", message: expect.stringContaining(PIN) });
    // verified by a second `hc --version` after the install, not taken from the installer's say-so
    const calls = f.exec.mock.calls.map(([cmd]) => cmd);
    expect(calls.indexOf(INSTALL)).toBeGreaterThan(calls.indexOf("hc --version"));
    expect(calls.lastIndexOf("hc --version")).toBeGreaterThan(calls.indexOf(INSTALL));
    expect(result.ready).toBe(true);
  });

  it("does not take a silent installer for success: a failed curl still ends the pipe with status 0, so the version is what decides", async () => {
    const f = fixture({ hc: null });
    const result = await runSetup(f.deps, {});
    expect(installs(f.exec)).toHaveLength(1);
    expect(hcStep(result.steps)).toMatchObject({ status: "fail", message: expect.stringContaining("could not be verified") });
    expect(hcStep(result.steps).fixHint).toContain(INSTALL);
    expect(result.ready).toBe(false);
  });

  it("fails, not applied, when what the installer left is another version than the pin (a foreign hc earlier on PATH)", async () => {
    const f = fixture({ hc: null, onInstall: (set) => set("hc 0.1.14\n") });
    const result = await runSetup(f.deps, {});
    expect(hcStep(result.steps).status).toBe("fail");
    expect(hcStep(result.steps).message).toContain("not the pinned version");
    expect(hcStep(result.steps).reason).toContain("0.1.14");
    expect(result.ready).toBe(false);
  });

  it("fails with the cause and the manual command when the installer fails", async () => {
    const f = fixture({ hc: null, onInstall: () => { throw new Error("install timeout"); } });
    const result = await runSetup(f.deps, {});
    expect(hcStep(result.steps)).toMatchObject({ status: "fail", message: expect.stringContaining("install timeout") });
    expect(hcStep(result.steps).fixHint).toContain(INSTALL);
    expect(result.ready).toBe(false);
  });

  it("never installs over an hc that is there: pinned is left alone, another version fails as before", async () => {
    for (const [output, status] of [[`hc ${PIN}\n`, "pass"], ["hc 0.1.14\n", "fail"], ["usage: hc\n", "fail"]] as const) {
      const f = fixture({ hc: output });
      const result = await runSetup(f.deps, {});
      expect(installs(f.exec), output).toEqual([]);
      expect(hcStep(result.steps).status, output).toBe(status);
    }
  });

  it("does not run the installer over a herdr-core already in the install directory (it would swap the binary a core may be running)", async () => {
    const f = fixture({ hc: null, binary: true });
    const result = await runSetup(f.deps, {});
    expect(installs(f.exec)).toEqual([]);
    expect(hcStep(result.steps)).toMatchObject({ status: "fail", message: "hc not found." });
    expect(hcStep(result.steps).reason).toContain("/fixture/.local/bin/herdr-core");
  });

  it("does not try on a platform the installer does not support, and says how", async () => {
    const f = fixture({ hc: null }, "win32");
    const result = await runSetup(f.deps, {});
    expect(installs(f.exec)).toEqual([]);
    expect(hcStep(result.steps)).toMatchObject({ status: "fail", message: "hc not found." });
    expect(hcStep(result.steps).fixHint).toContain(PIN);
  });

  it("a dry run installs nothing", async () => {
    const f = fixture({ hc: null });
    const result = await runSetup(f.deps, { dryRun: true });
    expect(installs(f.exec)).toEqual([]);
    expect(hcStep(result.steps)).toMatchObject({ status: "skipped", message: "Dry run: hc_install would be attempted." });
  });

  it("runs no hc command that starts a core, install included", async () => {
    const f = fixture({ hc: null, onInstall: (set) => set(`hc ${PIN}\n`) });
    await runSetup(f.deps, {});
    const hcCommands = f.exec.mock.calls.map(([cmd]) => cmd).filter((cmd) => cmd === "hc" || cmd.startsWith("hc "));
    expect(hcCommands).toEqual(["hc --version", "hc --version"]);
  });
});

describe("the herdr step no longer says the view can use plain tmux", () => {
  it("a herdr that cannot be installed warns with the view's real dependency, and leaves the cmux sentence alone", async () => {
    const f = fixture({ hc: `hc ${PIN}\n` });
    const original = f.deps.exec;
    f.deps.exec = (cmd, opts) => {
      if (cmd.includes("herdr.dev/install")) throw new Error("install timeout");
      if (cmd.endsWith("herdr --version") || cmd.endsWith("herdr' --version")) throw new Error("missing herdr");
      return original(cmd, opts);
    };
    const result = await runSetup(f.deps, {});
    const herdr = result.steps.find((s) => s.id === "herdr_install")!;
    expect(herdr.status).toBe("warn");
    expect(herdr.reason).not.toMatch(/tmux/i);
    expect(herdr.reason).toContain("Existing cmux workflows remain available.");
  });
});
