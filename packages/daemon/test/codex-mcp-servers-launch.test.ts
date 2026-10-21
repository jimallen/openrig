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
import { mcpTrustFixture } from "./helpers/mcp-trust-fixture.js";
import { CodexRuntimeAdapter, type CodexAdapterFsOps } from "../src/adapters/codex-runtime-adapter.js";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import { codexCommandResumeToken, processArgv } from "../src/domain/native-process-lineage.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { SeatMcpSelection } from "../src/domain/codex-mcp-servers.js";

// Fixtures stay under the test temp root; TRUST anchors the trust rule there (see mcp-trust-fixture.ts).
const { dir: scratch, io: TRUST } = mcpTrustFixture("launch");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const MCPLS = join(scratch, "opt", "mcpls");
// Explicit modes: the placement rule refuses group-writable directories, and a umask of 002 (Ubuntu's default with
// user-private groups, as on Sparky) would otherwise make the fixtures themselves unsafe.
execFileSync("/bin/mkdir", ["-p", "-m", "755", join(scratch, "opt")]);
writeFileSync(MCPLS, "#!/bin/sh\nexit 0\n");
chmodSync(MCPLS, 0o755);
const CONFIG = join(scratch, "opt", "mcpls.toml");
writeFileSync(CONFIG, "[[lsp_servers]]\nlanguage_id = \"typescript\"\n");
// Prints its own argv as JSON: stands in for codex so the rendered command can run through a real shell.
const DUMP = join(scratch, "dump-argv.mjs");
writeFileSync(DUMP, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");

// The binary checksum a switch-on would have pinned for this command (zeros when it does not exist).
const pinned = (command: string) => { try { return createHash("sha256").update(readFileSync(realpathSync(command))).digest("hex"); } catch { return "0".repeat(64); } };
const pilot = (over: Partial<SeatMcpSelection & { ok: true }["servers"][number]["declaration"]> = {}) => {
  const declaration = { command: MCPLS, args: ["--config", CONFIG, "--workspace-trust", "untrusted"], enabledTools: ["get_definition", "get_hover"], startupTimeoutSec: 30, toolTimeoutSec: 60, ...over };
  // The config file's pin, restated here (not imported) as a switch-on records it (OF-50).
  const argFiles = over.args ? [] : [{ arg: CONFIG, realPath: CONFIG, sha256: createHash("sha256").update(readFileSync(CONFIG)).digest("hex") }];
  return { name: "lsp", specDir: join(scratch, "spec"), declaration, commandSha256: pinned(declaration.command), argFiles };
};
const ON: SeatMcpSelection = { ok: true, servers: [pilot()] };
const EXPECTED = ` -c 'mcp_servers.lsp={command=${JSON.stringify(MCPLS)},args=["--config",${JSON.stringify(CONFIG)},"--workspace-trust","untrusted"],startup_timeout_sec=30,tool_timeout_sec=60,enabled_tools=["get_definition","get_hover"]}'`;

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

function fixture(kind: Kind, selection: SeatMcpSelection | undefined, opts: { posture?: "floor" | "full_bypass"; profile?: string; nodeId?: string; names?: Map<string, string> } = {}) {
  const names = opts.names ? () => ({ ok: true as const, names: opts.names! }) : undefined;
  const tmux = mockTmux();
  const nodeId = opts.nodeId ?? "n1";
  const reader = selection ? vi.fn((id: string) => (id === "n1" ? selection : { ok: true as const, servers: [] })) : undefined;
  const adapter = new CodexRuntimeAdapter({
    tmux, fsOps: mockFs(), listProcesses: () => [], sleep: async () => {},
    verifyProfilePreflight: async (name) => ({ ok: true, profile: name }), resolveGitAddDirs: async () => [],
    ...(reader ? { readSeatMcpServers: reader } : {}),
    ...(names ? { existingMcpServerNames: names } : {}),
    mcpTrustIo: TRUST,
  } as ConstructorParameters<typeof CodexRuntimeAdapter>[0]);
  const restore = new CodexResumeAdapter(tmux, { sleep: async () => {}, maxWaitMs: 0, exec: async () => "", ...(names ? { existingMcpServerNames: names } : {}), mcpTrustIo: TRUST });
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
    execFileSync("/bin/chmod", ["-R", "go-w", base]); // independent of the host umask (see the opt/ note above)
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

  // Jim, 2026-10-20: no sticky exemption (a sandboxed seat can write the sticky temp roots).
  it("refuses a binary below a sticky world-writable directory, even when the entry beneath it is yours", async () => {
    const command = exe(join(base, "sticky", "mine", "mcpls"));
    chmodSync(join(base, "sticky", "mine"), 0o700);
    chmodSync(join(base, "sticky"), 0o1777);
    const r = await launch(command);
    expect(r.ok).toBe(false);
    expect(r.error).toContain(`is not protected: ${join(base, "sticky")} is writable by group or others`);
  });

  it("accepts a binary in a 0755 directory of yours (control for the rows above)", async () => {
    const command = exe(join(base, "fine", "mcpls"));
    const r = await launch(command);
    expect(r.ok).toBe(true);
    expect(r.commands[0]).toContain(`mcp_servers.lsp={command=${JSON.stringify(command)}`);
  });

  // Security re-check S2: group write alone (0775, the umask-002 shape) is refused.
  it("refuses a binary under a group-writable 0775 directory", async () => {
    const command = exe(join(base, "group", "mcpls"));
    chmodSync(join(base, "group"), 0o775);
    const r = await launch(command);
    expect(r.ok).toBe(false);
    expect(r.error).toContain(`is not protected: ${join(base, "group")} is writable by group or others`);
  });

  // Security re-check F2: the as-written chain is judged too. A link in a 0777 directory can be retargeted.
  it("refuses a link that sits in a world-writable directory, though its target is safe; a link in a safe directory passes", async () => {
    const target = exe(join(base, "safe-target", "mcpls"));
    execFileSync("/bin/mkdir", ["-p", "-m", "755", join(base, "linkdir-open"), join(base, "linkdir-safe")]);
    const open = join(base, "linkdir-open", "mcpls");
    const safe = join(base, "linkdir-safe", "mcpls");
    symlinkSync(target, open);
    symlinkSync(target, safe);
    chmodSync(join(base, "linkdir-open"), 0o777);
    const refused = await launch(open);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain(`is not protected: ${join(base, "linkdir-open")} is writable by group or others`);
    expect((await launch(safe)).ok).toBe(true);
  });
});

// Jim, 2026-10-20: the temp roots are refused outright for the binary, as written or resolved.
describe("placement: temporary directories are refused for the binary", () => {
  it("refuses a 0700 directory of yours under the system temp directory", async () => {
    const { mcpServerPlacementProblem } = await import("../src/domain/codex-mcp-servers.js");
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "mcp-temp-")));
    try {
      const bin = join(dir, "mcpls");
      writeFileSync(bin, "#!/bin/sh\nexit 0\n");
      chmodSync(bin, 0o755);
      expect(mcpServerPlacementProblem({ command: bin }, {}, { requireExecutable: true })).toMatch(/lies inside the temporary directory .*, which a sandboxed seat can write$/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("the production temp roots follow $TMPDIR, and a not-yet-installed binary under one is refused", async () => {
    const { mcpServerPlacementProblem, DEFAULT_PATH_JUDGE_IO } = await import("../src/domain/codex-mcp-servers.js");
    const fakeTmp = join(scratch, "fake-tmpdir");
    execFileSync("/bin/mkdir", ["-p", "-m", "755", fakeTmp]);
    const prior = process.env["TMPDIR"];
    process.env["TMPDIR"] = fakeTmp;
    try {
      expect(DEFAULT_PATH_JUDGE_IO.tempRoots()).toContain(fakeTmp);
      // The fixture anchor plus the real temp-root list: only $TMPDIR (the fake one) can match here.
      const io = { ...TRUST, tempRoots: () => [fakeTmp] };
      expect(mcpServerPlacementProblem({ command: join(fakeTmp, "x", "mcpls") }, {}, { requireExecutable: false }, io))
        .toBe(`its command ${join(fakeTmp, "x", "mcpls")} lies inside the temporary directory ${fakeTmp}, which a sandboxed seat can write`);
    } finally { if (prior === undefined) delete process.env["TMPDIR"]; else process.env["TMPDIR"] = prior; }
  });
  it.runIf(process.platform === "darwin")("darwin: a not-yet-installed binary under /var/folders is refused (real reads)", async () => {
    const { mcpServerPlacementProblem } = await import("../src/domain/codex-mcp-servers.js");
    expect(mcpServerPlacementProblem({ command: "/var/folders/zz/abc/T/mcpls" }, {}, { requireExecutable: false }))
      .toMatch(/^its command \/var\/folders\/zz\/abc\/T\/mcpls lies inside the temporary directory .*, which a sandboxed seat can write$/);
  });
});

// Security re-check S3: a component owned by someone else is refused (presented through an injected stat,
// since the suite runs as one uid).
describe("placement: a foreign owner anywhere on the path is refused", () => {
  it("refuses when a directory on the resolved chain belongs to another uid; the unmodified reads accept", async () => {
    const { mcpServerPlacementProblem } = await import("../src/domain/codex-mcp-servers.js");
    const bin = join(scratch, "owned", "mcpls");
    execFileSync("/bin/mkdir", ["-p", "-m", "755", join(scratch, "owned")]);
    writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    chmodSync(bin, 0o755);
    const foreign = join(scratch, "owned");
    const lie = (st: ReturnType<typeof TRUST.stat>, p: string) => (p === foreign ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: 4242 }) : st);
    const io = { ...TRUST, stat: (p: string) => lie(TRUST.stat(p), p), lstat: (p: string) => lie(TRUST.lstat(p), p) };
    expect(mcpServerPlacementProblem({ command: bin }, {}, { requireExecutable: true }, io))
      .toBe(`its command ${bin} is not protected: ${foreign} is owned by uid 4242, not by you or root`);
    expect(mcpServerPlacementProblem({ command: bin }, {}, { requireExecutable: true }, TRUST)).toBeNull();
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

// Security review of 97aa027b, N2: Codex merges `-c mcp_servers.<name>` with a same-named server from any other
// config layer, so a launch refuses a name another layer already defines.
describe("a server name another Codex config layer defines is refused (security review N2)", () => {
  for (const kind of kinds) {
    it(`${kind}: refused naming the file, nothing sent; a different name renders`, async () => {
      const taken = fixture(kind, ON, { names: new Map([["lsp", "/home/u/.codex/config.toml"]]) });
      const r = await taken.run() as { ok: boolean; error?: string; message?: string };
      expect(r.ok).toBe(false);
      expect(r.error ?? r.message).toContain('a server named "lsp" is already defined in /home/u/.codex/config.toml, and Codex would merge that definition');
      expect(taken.commands()).toEqual([]);
      const free = fixture(kind, ON, { names: new Map([["other", "/home/u/.codex/config.toml"]]) });
      await free.run();
      expect(free.commands()[0]).toContain(EXPECTED);
    });
  }
});

describe("codexConfigLayerFiles / codexConfigServerNames read names only", () => {
  // NOT in the account's home: the layer walk climbs every ancestor of the seat cwd, and from the real home
  // it would read the operator's own ~/.codex/config.toml. Nothing here needs the trust rule's acceptance.
  const layers = realpathSync(mkdtempSync(join(tmpdir(), "mcp-layers-")));
  afterAll(() => rmSync(layers, { recursive: true, force: true }));
  it("finds a same-named server in the shared file, a profile and a project .codex layer above the seat", async () => {
    const { codexConfigLayerFiles, codexConfigServerNames } = await import("../src/domain/codex-mcp-servers.js");
    execFileSync("/bin/mkdir", ["-p", join(layers, "home"), join(layers, "proj", ".codex"), join(layers, "proj", "seat")]);
    writeFileSync(join(layers, "home", "config.toml"), 'model = "x"\n[mcp_servers.lsp]\ncommand = "/bin/true"\nenv = { SECRET = "s3cr3t" }\n');
    writeFileSync(join(layers, "home", "p.config.toml"), '[mcp_servers.fromprofile]\ncommand = "/bin/true"\n');
    writeFileSync(join(layers, "proj", ".codex", "config.toml"), '[mcp_servers.fromproject]\ncommand = "/bin/true"\n');
    const files = codexConfigLayerFiles({ sharedCodexHome: join(layers, "home"), seatCwd: join(layers, "proj", "seat"), profileFile: join(layers, "home", "p.config.toml") });
    const result = codexConfigServerNames(files);
    expect(result).toEqual({ ok: true, names: new Map([
      ["lsp", join(layers, "home", "config.toml")],
      ["fromprofile", join(layers, "home", "p.config.toml")],
      ["fromproject", join(layers, "proj", ".codex", "config.toml")],
    ]) });
    expect(JSON.stringify([...(result as { names: Map<string, string> }).names])).not.toContain("s3cr3t");
  });
  it("an unparseable layer is an error, not an empty answer", async () => {
    const { codexConfigServerNames } = await import("../src/domain/codex-mcp-servers.js");
    execFileSync("/bin/mkdir", ["-p", join(layers, "bad")]);
    writeFileSync(join(layers, "bad", "config.toml"), "[mcp_servers.lsp\n");
    const r = codexConfigServerNames([join(layers, "bad", "config.toml")]);
    expect(r.ok).toBe(false);
  });
  it("startup wires the same names reader into both Codex launch adapters", () => {
    const lines = readFileSync(new URL("../src/startup.ts", import.meta.url), "utf8").split("\n");
    expect(lines.find((l) => l.includes("new CodexRuntimeAdapter("))).toContain("existingMcpServerNames,");
    expect(lines.find((l) => l.includes("new CodexResumeAdapter("))).toContain("existingMcpServerNames });");
  });
});

// Security re-check of 53a39e80, R2: the deny checks compare identities, so the spelling a caller picks (letter
// case or firmlink on macOS, letter case of `.workspaces` anywhere) cannot slip past them.
describe("placement: deny checks hold under any spelling of the path (re-check R2)", () => {
  const seatDir = join(scratch, "r2-seat");
  execFileSync("/bin/mkdir", ["-p", "-m", "755", join(seatDir, "bin"), join(scratch, "r2-proj", ".WORKSPACES", "x")]);
  for (const p of [join(seatDir, "bin", "mcpls"), join(scratch, "r2-proj", ".WORKSPACES", "x", "mcpls")]) {
    writeFileSync(p, "#!/bin/sh\nexit 0\n");
    chmodSync(p, 0o755);
  }
  const judge = async (command: string, roots: { seatCwd?: string }, io = TRUST) =>
    (await import("../src/domain/codex-mcp-servers.js")).mcpServerPlacementProblem({ command }, roots, { requireExecutable: true }, io);

  it("a `.WORKSPACES` directory is a workspaces directory", async () => {
    expect(await judge(join(scratch, "r2-proj", ".WORKSPACES", "x", "mcpls"), {})).toContain("lies inside the seat workspaces directory");
  });
  it.runIf(process.platform === "darwin")("darwin: the seat's cwd in another letter case is still the seat's cwd", async () => {
    const upper = join(scratch, "R2-SEAT", "bin", "mcpls");
    expect(await judge(upper, { seatCwd: seatDir })).toContain("lies inside the seat's working directory");
  });
  it.runIf(process.platform === "darwin")("darwin: the seat's cwd through the /System/Volumes/Data firmlink is still the seat's cwd", async () => {
    expect(await judge(`/System/Volumes/Data${join(seatDir, "bin", "mcpls")}`, { seatCwd: seatDir })).toContain("lies inside the seat's working directory");
  });
  it.runIf(process.platform === "darwin")("darwin: $TMPDIR spelled /VAR/FOLDERS/... or through the firmlink is still a temp root (real reads)", async () => {
    const { DEFAULT_PATH_JUDGE_IO } = await import("../src/domain/codex-mcp-servers.js");
    const d = realpathSync(mkdtempSync(join(tmpdir(), "mcp-r2-")));
    try {
      const bin = join(d, "mcpls");
      writeFileSync(bin, "#!/bin/sh\nexit 0\n");
      chmodSync(bin, 0o755);
      expect(bin.startsWith("/private/var/folders/")).toBe(true);
      for (const spelling of [bin.replace("/private/var/folders/", "/VAR/FOLDERS/"), `/System/Volumes/Data${bin}`]) {
        expect(await judge(spelling, {}, DEFAULT_PATH_JUDGE_IO)).toMatch(/lies inside the temporary directory .*, which a sandboxed seat can write$/);
      }
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});
