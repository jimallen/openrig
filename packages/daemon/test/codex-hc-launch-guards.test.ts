import { mockShellCommand } from "./helpers/shell-command-mock.js";
import fs from "node:fs";
import { describe, it, expect, vi } from "vitest";
import { CodexRuntimeAdapter, type CodexAdapterFsOps } from "../src/adapters/codex-runtime-adapter.js";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import { codexHcPreflight, CODEX_MINIMUM_VERSION, type CodexVersionCheck, type CodexVersionDetector } from "../src/adapters/hc-runtime-requirements.js";
import type { CodexDaemonSupport, CodexDaemonSupportDetector } from "../src/domain/codex-daemon-support.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

// Design section 15, wired (security review F3): under the hc host the Codex version floor and the --no-daemon requirement
// refuse a launch on every Codex path; under tmux the same probes change nothing. Every process seam is fake.

const supported: CodexDaemonSupport = { kind: "supported" };
const legacy: CodexDaemonSupport = { kind: "legacy" };
const unknownSupport: CodexDaemonSupport = { kind: "unknown", detail: "codex --help failed" };
const okVersion: CodexVersionCheck = { kind: "ok", version: CODEX_MINIMUM_VERSION };
const oldVersion: CodexVersionCheck = { kind: "too_old", version: "0.158.0", minimum: CODEX_MINIMUM_VERSION };
const unknownVersion: CodexVersionCheck = { kind: "unknown", detail: "codex --version failed: spawn codex ENOENT" };

function mockTmux(hostKind: "tmux" | "hc"): TmuxAdapter {
  return mockShellCommand({
    hostKind,
    sendText: vi.fn(async () => ({ ok: true as const })),
    hasSession: vi.fn(async () => true),
    getPaneCommand: vi.fn(async () => "codex"),
    capturePaneContent: vi.fn(async () => "OpenAI Codex (v0.0.0)\n› Ask Codex to do anything"),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    getPanePid: vi.fn(async () => null),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => []),
  } as unknown as TmuxAdapter);
}
const mockFs = (): CodexAdapterFsOps => ({ readFile: () => { throw new Error("not found"); }, writeFile: () => {}, exists: () => false, mkdirp: () => {}, listFiles: () => [] });
const binding = (): NodeBinding => ({
  id: "b1", nodeId: "n1", tmuxSession: "r01-qa", tmuxWindow: null, tmuxPane: null,
  cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "/project", model: "gpt-5.5",
});
const sent = (tmux: TmuxAdapter) => (tmux.sendText as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[1]));

type Path = "fresh" | "fork" | "resume" | "restore" | "restart-in-place";
const PATHS: Path[] = ["fresh", "fork", "resume", "restore", "restart-in-place"];
const runningWithFlag = { addDirs: [], daemonOptOut: true, networkOverride: false };

interface Probes { version?: CodexVersionCheck; support?: CodexDaemonSupport; running?: typeof runningWithFlag }
async function run(path: Path, hostKind: "tmux" | "hc", probes: Probes) {
  const tmux = mockTmux(hostKind);
  const detectVersion = vi.fn<CodexVersionDetector>(async () => probes.version!);
  const detectDaemonSupport = vi.fn<CodexDaemonSupportDetector>(async () => probes.support!);
  const wired = {
    ...(probes.version ? { detectVersion } : {}),
    ...(probes.support ? { detectDaemonSupport } : {}),
  };
  if (path === "restart-in-place") {
    const result = await new CodexRuntimeAdapter({ tmux, fsOps: mockFs(), listProcesses: () => [], sleep: async () => {}, ...wired })
      .buildResumeCommand(binding(), { name: "dev-qa@test-rig", resumeToken: "sess 456", running: probes.running ?? runningWithFlag });
    return { result, commands: result.ok ? [result.command] : [], detectVersion, detectDaemonSupport };
  }
  const result = path === "restore"
    ? await new CodexResumeAdapter(tmux, { sleep: async () => {}, maxWaitMs: 0, ...wired }).resume("r01-qa", "codex_id", "sess 456", "/project", null, undefined, "gpt-5.5")
    : await new CodexRuntimeAdapter({ tmux, fsOps: mockFs(), listProcesses: () => [], sleep: async () => {}, ...wired }).launchHarness(binding(), {
      name: "dev-qa@test-rig",
      ...(path === "fork" ? { forkSource: { kind: "native_id" as const, value: "parent" } } : path === "resume" ? { resumeToken: "sess 456" } : {}),
    });
  return { result, commands: sent(tmux), detectVersion, detectDaemonSupport };
}
const refused = (r: Awaited<ReturnType<typeof run>>) => !r.result.ok;

describe("codexHcPreflight", () => {
  it("passes only a floor-or-newer Codex that supports --no-daemon", async () => {
    expect(await codexHcPreflight("/p", async () => okVersion, supported)).toBeNull();
    expect(await codexHcPreflight("/p", async () => oldVersion, supported)).toMatch(/older than 0\.166\.0/);
    expect(await codexHcPreflight("/p", async () => unknownVersion, supported)).toMatch(/Cannot tell which Codex/);
    expect(await codexHcPreflight("/p", async () => okVersion, legacy)).toMatch(/--no-daemon/);
    expect(await codexHcPreflight("/p", async () => okVersion, unknownSupport)).not.toBeNull();
  });
  it("does not ask a probe that is not wired, as detectDaemonSupport is not asked when absent; the wired one still decides", async () => {
    expect(await codexHcPreflight("/p", undefined, supported)).toBeNull();
    expect(await codexHcPreflight("/p", async () => okVersion, undefined)).toBeNull();
    expect(await codexHcPreflight("/p", undefined, undefined)).toBeNull();
    expect(await codexHcPreflight("/p", async () => oldVersion, undefined)).toMatch(/older than/);
    expect(await codexHcPreflight("/p", undefined, legacy)).toMatch(/--no-daemon/);
  });
});

for (const path of PATHS) {
  describe(`${path} under the hc host`, () => {
    it("launches a Codex at the floor that supports --no-daemon, and asks each probe once", async () => {
      const r = await run(path, "hc", { version: okVersion, support: supported });
      expect(r.commands).toHaveLength(1);  // a fork's own thread-id capture is not what is under test, so the command is the proof
      expect(r.commands[0]).toContain("--no-daemon");
      expect(r.detectVersion).toHaveBeenCalledTimes(1);
      expect(r.detectDaemonSupport).toHaveBeenCalledTimes(1);
    });
    it("refuses a Codex older than the floor, and sends nothing", async () => {
      const r = await run(path, "hc", { version: oldVersion, support: supported });
      expect(refused(r)).toBe(true);
      expect(JSON.stringify(r.result)).toMatch(/older than 0\.166\.0/);
      expect(r.commands).toEqual([]);
    });
    it("refuses a Codex whose version cannot be read, and sends nothing", async () => {
      const r = await run(path, "hc", { version: unknownVersion, support: supported });
      expect(refused(r)).toBe(true);
      expect(r.commands).toEqual([]);
    });
    it("refuses a legacy Codex (no --no-daemon) even at the floor, and sends nothing", async () => {
      const r = await run(path, "hc", { version: okVersion, support: legacy });
      expect(refused(r)).toBe(true);
      expect(JSON.stringify(r.result)).toMatch(/--no-daemon/);
      expect(r.commands).toEqual([]);
    });
    it("launches an adapter composed without the probes, as before (production wires both: see the startup row)", async () => {
      const r = await run(path, "hc", {});
      expect(r.commands).toHaveLength(1);
    });
    it("is not applied under tmux: an old or unreadable version launches as before, and the version probe is never run", async () => {
      for (const version of [oldVersion, unknownVersion]) {
        const r = await run(path, "tmux", { version, support: supported });
        expect(r.commands).toHaveLength(1);
        expect(r.detectVersion).not.toHaveBeenCalled();
      }
      const legacyOnTmux = await run(path, "tmux", { version: oldVersion, support: legacy });
      expect(legacyOnTmux.commands).toHaveLength(1);
    });
  });
}

describe("restart-in-place's own guard: the running argv", () => {
  const without = { ...runningWithFlag, daemonOptOut: false };
  it("refuses under hc a Codex running without --no-daemon, whatever the probes say, and asks neither", async () => {
    for (const probes of [{ version: okVersion, support: supported }, {}]) {
      const r = await run("restart-in-place", "hc", { ...probes, running: without });
      expect(refused(r)).toBe(true);
      expect(JSON.stringify(r.result)).toMatch(/running without --no-daemon/);
      expect(r.commands).toEqual([]);
      expect(r.detectVersion).not.toHaveBeenCalled();
      expect(r.detectDaemonSupport).not.toHaveBeenCalled();
    }
  });
  it("leaves tmux as it was: the running choice is kept and no probe is asked, with the flag or without it", async () => {
    const withFlag = await run("restart-in-place", "tmux", { version: oldVersion, support: legacy });
    expect(withFlag.commands[0]).toContain("--no-daemon");
    const plain = await run("restart-in-place", "tmux", { version: oldVersion, support: legacy, running: without });
    expect(plain.commands).toHaveLength(1);
    expect(plain.commands[0]).not.toContain("--no-daemon");
    for (const r of [withFlag, plain]) {
      expect(r.detectVersion).not.toHaveBeenCalled();
      expect(r.detectDaemonSupport).not.toHaveBeenCalled();
    }
  });
});

describe("startup", () => {
  it("wires the version probe into both Codex launch adapters", () => {
    const source = fs.readFileSync(new URL("../src/startup.ts", import.meta.url), "utf8");
    for (const marker of ["new CodexResumeAdapter(", "new CodexRuntimeAdapter("]) {
      expect(source.split("\n").find((line) => line.includes(marker))!, marker).toContain("detectVersion: codexVersionProbe(");
    }
  });
});
