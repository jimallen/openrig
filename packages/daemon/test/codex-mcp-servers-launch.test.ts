// Per-member Codex MCP servers, stage 2 (renderer): every Codex launch path renders a seat's
// switched-on servers as ONE `-c 'mcp_servers.<name>={...}'` each, quoted with the fork's shellQuote,
// and a seat with none switched on launches byte-identically. Rows drive the existing adapters with
// an injected selection reader, so at the base commit they fail on behaviour (the option is ignored).
import { afterAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseToml } from "smol-toml";
import { mockShellCommand } from "./helpers/shell-command-mock.js";
import { CodexRuntimeAdapter, type CodexAdapterFsOps } from "../src/adapters/codex-runtime-adapter.js";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import { codexCommandResumeToken, processArgv } from "../src/domain/native-process-lineage.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { SeatMcpSelection } from "../src/domain/codex-mcp-servers.js";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "mcp-launch-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const MCPLS = join(scratch, "opt", "mcpls");
execFileSync("/bin/mkdir", ["-p", join(scratch, "opt")]);
writeFileSync(MCPLS, "#!/bin/sh\nexit 0\n");
chmodSync(MCPLS, 0o755);
// Prints its own argv as JSON: stands in for codex so the rendered command can run through a real shell.
const DUMP = join(scratch, "dump-argv.mjs");
writeFileSync(DUMP, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");

// The binary checksum a switch-on would have pinned for this command (zeros when it does not exist).
const pinned = (command: string) => { try { return createHash("sha256").update(readFileSync(realpathSync(command))).digest("hex"); } catch { return "0".repeat(64); } };
const pilot = (over: Partial<SeatMcpSelection & { ok: true }["servers"][number]["declaration"]> = {}) => {
  const declaration = { command: MCPLS, args: ["--config", "/x/mcpls.toml", "--workspace-trust", "untrusted"], enabledTools: ["get_definition", "get_hover"], startupTimeoutSec: 30, toolTimeoutSec: 60, ...over };
  return { name: "lsp", specDir: join(scratch, "spec"), declaration, commandSha256: pinned(declaration.command) };
};
const ON: SeatMcpSelection = { ok: true, servers: [pilot()] };
const EXPECTED = ` -c 'mcp_servers.lsp={command=${JSON.stringify(MCPLS)},args=["--config","/x/mcpls.toml","--workspace-trust","untrusted"],startup_timeout_sec=30,tool_timeout_sec=60,enabled_tools=["get_definition","get_hover"]}'`;

function mockTmux(): TmuxAdapter {
  return mockShellCommand({
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
const mockFs = (): CodexAdapterFsOps => ({
  readFile: () => { throw new Error("not found"); }, writeFile: () => {}, exists: () => false, mkdirp: () => {}, listFiles: () => [],
});
const sentCommands = (tmux: TmuxAdapter) => (tmux.sendText as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[1]));

const kinds = ["fresh", "fork", "resume", "restore", "last"] as const;
type Kind = typeof kinds[number];
const cwd = "/seat-dir";

function fixture(kind: Kind, selection: SeatMcpSelection | undefined, opts: { posture?: "floor" | "full_bypass"; profile?: string; nodeId?: string } = {}) {
  const tmux = mockTmux();
  const nodeId = opts.nodeId ?? "n1";
  const reader = selection ? vi.fn((id: string) => (id === "n1" ? selection : { ok: true as const, servers: [] })) : undefined;
  const adapter = new CodexRuntimeAdapter({
    tmux, fsOps: mockFs(), listProcesses: () => [], sleep: async () => {},
    verifyProfilePreflight: async (name) => ({ ok: true, profile: name }), resolveGitAddDirs: async () => [],
    ...(reader ? { readSeatMcpServers: reader } : {}),
  } as ConstructorParameters<typeof CodexRuntimeAdapter>[0]);
  const restore = new CodexResumeAdapter(tmux, { sleep: async () => {}, maxWaitMs: 0, exec: async () => "" });
  const posture = opts.posture ?? "floor";
  const binding: NodeBinding = {
    id: "b1", nodeId, tmuxSession: "r01-ops", tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null,
    updatedAt: "", cwd, model: "gpt-5.5", launchPosture: posture, codexConfigProfile: opts.profile,
  };
  const restoreSelection = selection && nodeId === "n1" ? selection : undefined;
  const run = () => kind === "restore" || kind === "last"
    ? (restore.resume as (...a: unknown[]) => Promise<{ ok: boolean; message?: string }>)(
      "r01-ops", kind === "last" ? "codex_last" : "codex_id", "thread-7", cwd, opts.profile, posture, "gpt-5.5",
      ...(restoreSelection ? [undefined, undefined, undefined, undefined, restoreSelection] : []))
    : adapter.launchHarness(binding, {
        name: "verify-ops@eztrack",
        ...(kind === "fork" ? { forkSource: { kind: "native_id" as const, value: "parent-7" } }
          : kind === "resume" ? { resumeToken: "thread-7" } : {}),
      });
  return { run, commands: () => sentCommands(tmux), reader };
}

/** Run the sent command through a real shell with codex replaced by an argv printer. */
function shellArgv(command: string): string[] {
  expect(command.startsWith("codex ")).toBe(true);
  const out = execFileSync("/bin/bash", ["-c", `${JSON.stringify(process.execPath)} ${JSON.stringify(DUMP)}${command.slice("codex".length)}`], { cwd: scratch, encoding: "utf-8" });
  return JSON.parse(out) as string[];
}

describe("every Codex launch path renders the seat's switched-on server once, and nothing for other seats", () => {
  for (const kind of kinds) {
    it(`${kind}: exactly one -c mcp_servers.lsp override; removing it gives the unchanged command`, async () => {
      const baseline = fixture(kind, undefined);
      await baseline.run();
      const on = fixture(kind, ON);
      const result = await on.run();
      // A fork in this fake pane cannot capture its new thread id, so only fresh/resume/restore report ok.
      if (kind !== "fork") expect(result.ok).toBe(true);
      expect(on.commands()).toHaveLength(1);
      const cmd = on.commands()[0]!;
      expect(cmd.split(EXPECTED)).toHaveLength(2);
      expect(cmd.match(/mcp_servers\./g)).toHaveLength(1);
      expect(cmd.replace(EXPECTED, "")).toBe(baseline.commands()[0]);
    });

    it(`${kind}: containment - another seat, and a seat with nothing switched on, launch byte-identically`, async () => {
      const baseline = fixture(kind, undefined);
      await baseline.run();
      // The reader answers "none" for any node other than n1; restore passes no selection for it.
      const other = fixture(kind, ON, { nodeId: "n2" });
      await other.run();
      const none = fixture(kind, { ok: true, servers: [] });
      await none.run();
      expect(other.commands()).toEqual(baseline.commands());
      expect(none.commands()).toEqual(baseline.commands());
      expect(other.commands()[0]).not.toContain("mcp_servers");
    });

    it(`${kind}: under full_bypass with a named profile, the override rides beside -s/-a and no -p is passed`, async () => {
      const on = fixture(kind, ON, { posture: "full_bypass", profile: "rig-yolo" });
      await on.run();
      const cmd = on.commands()[0]!;
      expect(cmd).toContain(" -s danger-full-access -a never");
      expect(cmd).toContain(EXPECTED);
      expect(processArgv(cmd)).not.toContain("-p");
      expect(processArgv(cmd)).not.toContain("--profile");
    });
  }
});

describe("quoting and argv fidelity", () => {
  it("a hostile argument reaches the program byte for byte through a real shell, and nothing is executed", async () => {
    const pwned = join(scratch, "PWNED");
    const hostile = [`it's`, `"q"`, `$(touch${"${IFS}"}${pwned})`, "`touch${IFS}" + pwned + "`", "back\\slash", "$HOME", "ü-ñ", "a=b,c]{}"];
    const on = fixture("fresh", { ok: true, servers: [pilot({ args: hostile })] });
    expect((await on.run()).ok).toBe(true);
    const argv = shellArgv(on.commands()[0]!);
    const values = argv.filter((a) => a.startsWith("mcp_servers."));
    expect(values).toHaveLength(1);
    const value = values[0]!;
    expect(argv[argv.indexOf(value) - 1]).toBe("-c");
    const table = (parseToml(`v = ${value.slice("mcp_servers.lsp=".length)}`) as { v: Record<string, unknown> }).v;
    expect(table).toEqual({ command: MCPLS, args: hostile, startup_timeout_sec: 30, tool_timeout_sec: 60, enabled_tools: ["get_definition", "get_hover"] });
    expect(existsSync(pwned)).toBe(false);
  });

  it("the running process line still proves the resumed conversation (the override stays one ps token)", async () => {
    const on = fixture("resume", ON);
    await on.run();
    const argv = shellArgv(on.commands()[0]!);
    expect(argv.filter((a) => a.startsWith("mcp_servers.lsp={"))).toHaveLength(1);
    // ps flattens argv with spaces; identity proof re-splits that line.
    expect(codexCommandResumeToken(["/usr/local/bin/codex", ...argv].join(" "))).toBe("thread-7");
  });
});

describe("a selection that is unreadable, malformed or misplaced refuses the launch with the remedy", () => {
  for (const kind of kinds) {
    it(`${kind}: nothing is sent to the pane`, async () => {
      const cases: Array<[SeatMcpSelection, string]> = [
        [{ ok: false, error: "stored value is not JSON" }, "Codex MCP servers for this seat cannot be read: stored value is not JSON"],
        [{ ok: true, servers: [pilot({ args: ["has space"] })] }, 'Codex MCP server "lsp" for this seat is not valid'],
        [{ ok: true, servers: [pilot({ command: join(scratch, "missing") })] }, `Codex MCP server "lsp" for this seat cannot start: its command ${join(scratch, "missing")} does not exist; switch it on again to accept the new binary (rig seat set-mcp <seat> lsp on --reason ...), or turn it off with: rig seat set-mcp <seat> lsp off`],
        [{ ok: true, servers: [{ ...pilot(), specDir: join(scratch, "opt") }] }, "lies inside the rig spec's directory"],
      ];
      for (const [selection, message] of cases) {
        const f = fixture(kind, selection);
        const result = await f.run() as { ok: boolean; error?: string; message?: string };
        expect(result.ok).toBe(false);
        expect(result.error ?? result.message).toContain(message);
        expect(f.commands()).toEqual([]);
      }
    });
  }
});

// Security review of 97aa027b, N3: where the program may live. Each row launches through the real adapter.
describe("placement: content another principal controls never chooses the program (security review N3)", () => {
  function exe(path: string, mode = 0o755): string {
    execFileSync("/bin/mkdir", ["-p", join(path, "..")]);
    writeFileSync(path, "#!/bin/sh\nexit 0\n");
    chmodSync(path, mode);
    return path;
  }
  async function launch(command: string): Promise<{ ok: boolean; error?: string; commands: string[] }> {
    const f = fixture("fresh", { ok: true, servers: [pilot({ command })] });
    const result = await f.run() as { ok: boolean; error?: string };
    return { ...result, commands: f.commands() };
  }
  const base = join(scratch, "placement");

  it("refuses a command inside any git work tree", async () => {
    execFileSync("/bin/mkdir", ["-p", join(base, "repo", ".git")]);
    const r = await launch(exe(join(base, "repo", "bin", "mcpls")));
    expect(r.ok).toBe(false);
    expect(r.error).toContain(`lies inside the git work tree ${join(base, "repo")}`);
    expect(r.commands).toEqual([]);
  });

  it("refuses a command inside any .workspaces directory (a sibling seat's folder)", async () => {
    const r = await launch(exe(join(base, "proj", ".workspaces", "verify-qa", "bin", "mcpls")));
    expect(r.ok).toBe(false);
    expect(r.error).toContain(`lies inside the seat workspaces directory ${join(base, "proj", ".workspaces")}`);
  });

  it("follows a link: a command outside that resolves into a git work tree is refused", async () => {
    execFileSync("/bin/mkdir", ["-p", join(base, "repo2", ".git"), join(base, "links")]);
    const target = exe(join(base, "repo2", "bin", "mcpls"));
    const link = join(base, "links", "mcpls");
    symlinkSync(target, link);
    const r = await launch(link);
    expect(r.ok).toBe(false);
    expect(r.error).toContain(`lies inside the git work tree ${join(base, "repo2")}`);
  });

  it("judges the written path too: a link inside a git work tree pointing outside is refused", async () => {
    execFileSync("/bin/mkdir", ["-p", join(base, "repo3", ".git"), join(base, "repo3", "bin")]);
    const link = join(base, "repo3", "bin", "mcpls");
    symlinkSync(MCPLS, link);
    const r = await launch(link);
    expect(r.ok).toBe(false);
    expect(r.error).toContain(`lies inside the git work tree ${join(base, "repo3")}`);
  });

  it("refuses a binary writable by group or others", async () => {
    const r = await launch(exe(join(base, "ww", "mcpls"), 0o777));
    expect(r.ok).toBe(false);
    expect(r.error).toContain(`is not protected: ${join(base, "ww", "mcpls")} is writable by group or others`);
  });

  it("refuses a binary under a world-writable directory without the sticky bit", async () => {
    const command = exe(join(base, "open", "sub", "mcpls"));
    chmodSync(join(base, "open"), 0o777);
    const r = await launch(command);
    expect(r.ok).toBe(false);
    expect(r.error).toContain(`is not protected: ${join(base, "open")} is writable by group or others`);
  });

  it("accepts a binary below a sticky world-writable directory when the entry beneath it is yours", async () => {
    const command = exe(join(base, "sticky", "mine", "mcpls"));
    chmodSync(join(base, "sticky", "mine"), 0o700);
    chmodSync(join(base, "sticky"), 0o1777);
    const r = await launch(command);
    expect(r.ok).toBe(true);
    expect(r.commands[0]).toContain(`mcp_servers.lsp={command=${JSON.stringify(command)}`);
  });
});

// Jim, 2026-10-20: a server on a seat that is not full_bypass is allowed, and every launch that renders it says so.
describe("unsandboxed-server warning on every launch path", () => {
  for (const kind of kinds) {
    it(`${kind}: logged once under the floor, never under full_bypass`, async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await fixture(kind, ON, { posture: "floor" }).run();
        const floor = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("runs outside Codex's sandbox"));
        expect(floor).toHaveLength(1);
        expect(floor[0]).toContain(`Codex MCP server "lsp" runs outside Codex's sandbox with your full user rights (this launch's sandbox is workspace-write, not danger-full-access)`);
        warn.mockClear();
        await fixture(kind, ON, { posture: "full_bypass" }).run();
        expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("runs outside Codex's sandbox"))).toEqual([]);
      } finally { warn.mockRestore(); }
    });
  }
});
