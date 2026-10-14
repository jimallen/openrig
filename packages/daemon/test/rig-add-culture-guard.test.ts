import { describe, it, expect, vi, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { migrationsForFullTestDb, createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import { PodRigInstantiator } from "../src/domain/rigspec-instantiator.js";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import type { AgentResolverFsOps } from "../src/domain/agent-resolver.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

// (fixture copied from rig-add-culture.test.ts so the two files cannot conflict)
// `rig add` builds a synthetic one-pod spec around the existing pod. That spec never carried the rig's
// culture_file, and the rig record does not store it, so a seat added to a RUNNING rig got the OpenRig
// culture floor but not the rig's own CULTURE.md. `rig add --culture <path>` supplies it explicitly.
// These drive the real instantiator + the real Claude adapter into temp dirs (fake tmux, no real
// processes) and read the seat's actual guidance file.

const MARKER = "RIGCULTURE-MARKER-7f3a";
const BEGIN = "<!-- BEGIN OpenRig MANAGED BLOCK:";

function mockTmux(): TmuxAdapter {
  return {
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    sendText: vi.fn(async () => ({ ok: true as const })),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    hasSession: vi.fn(async () => true),
    getPaneCommand: vi.fn(async () => "claude"),
    capturePaneContent: vi.fn(async () => "Claude Code\n>"),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => []),
  } as unknown as TmuxAdapter;
}

const realFs = (home: string): ClaudeAdapterFsOps => ({
  readFile: (p) => fs.readFileSync(p, "utf-8"),
  writeFile: (p, c) => fs.writeFileSync(p, c),
  exists: (p) => fs.existsSync(p),
  mkdirp: (p) => fs.mkdirSync(p, { recursive: true }),
  copyFile: (s, d) => fs.copyFileSync(s, d),
  listFiles: (dir) => (fs.existsSync(dir) && fs.statSync(dir).isDirectory() ? fs.readdirSync(dir) : []),
  homedir: home,
});

const noopAdapter = (runtime: string): RuntimeAdapter => ({
  runtime,
  listInstalled: vi.fn(async () => []),
  project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
  deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
  checkReady: vi.fn(async () => ({ ready: true })),
  launchHarness: vi.fn(async () => ({ ok: true })),
});

const tmpDirs: string[] = [];
afterEach(() => { for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const rigYaml = (cwd: string) => [
  `version: "0.2"`, `name: culture-rig`, `culture_file: CULTURE.md`, `pods:`, `  - id: dev`, `    label: Dev`, `    members:`,
  `      - id: impl`, `        agent_ref: "local:agents/impl"`, `        profile: default`, `        runtime: claude-code`, `        cwd: "${cwd}"`,
  `    edges: []`, `edges: []`,
].join("\n") + "\n";

async function runningRig() {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "or-rigadd-culture-"));
  tmpDirs.push(root);
  const rigRoot = nodePath.join(root, "rig");
  const implCwd = nodePath.join(root, "impl-repo");
  const addCwd = nodePath.join(root, "added-repo");
  const home = nodePath.join(root, "home");
  for (const d of [nodePath.join(rigRoot, "agents", "impl"), implCwd, addCwd, home]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(nodePath.join(rigRoot, "agents", "impl", "agent.yaml"),
    `name: impl\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []\n`);
  fs.writeFileSync(nodePath.join(rigRoot, "CULTURE.md"), `# Rig culture\n\n${MARKER}\n`);
  fs.writeFileSync(nodePath.join(root, "elsewhere-culture.md"), `# Elsewhere culture\n\n${MARKER}-ABS\n`);

  const db = createDb(nodePath.join(root, "openrig.sqlite"));
  migrate(db, migrationsForFullTestDb);
  const rigRepo = new RigRepository(db);
  const podRepo = new PodRepository(db);
  const sessionRegistry = new SessionRegistry(db);
  const eventBus = new EventBus(db);
  const tmux = mockTmux();
  const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
  const startupOrchestrator = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux });
  const claude = new ClaudeCodeAdapter({ tmux, fsOps: realFs(home), sleep: async () => {}, sessionIdFactory: () => "sess-add" });
  const resolverFs: AgentResolverFsOps = { readFile: (p) => fs.readFileSync(p, "utf-8"), exists: (p) => fs.existsSync(p) };
  const inst = new PodRigInstantiator({
    db, rigRepo, podRepo, sessionRegistry, eventBus, nodeLauncher, startupOrchestrator, fsOps: resolverFs, tmuxAdapter: tmux,
    adapters: { "claude-code": claude, codex: noopAdapter("codex"), terminal: noopAdapter("terminal") },
  } as never);
  // The "running rig": launched from a spec that HAS a culture_file.
  const up = await inst.instantiate(rigYaml(implCwd), rigRoot);
  expect(up.ok, JSON.stringify(up)).toBe(true);
  const rigId = (up as { ok: true; result: { rigId: string } }).result.rigId;
  const member = (over: Record<string, unknown> = {}) => ({
    id: "mgr", agent_ref: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: addCwd, ...over,
  });
  const read = (name: string) => { const p = nodePath.join(addCwd, name); return fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : null; };
  const startupPaths = (logicalId: string): string[] => {
    const nodeId = (db.prepare("SELECT id FROM nodes WHERE logical_id = ?").get(logicalId) as { id: string }).id;
    const row = db.prepare("SELECT resolved_files_json FROM node_startup_context WHERE node_id = ?").get(nodeId) as { resolved_files_json: string };
    return (JSON.parse(row.resolved_files_json) as Array<{ path: string }>).map((f) => f.path);
  };
  const outside = fs.mkdtempSync(nodePath.join(os.tmpdir(), "or-rigadd-outside-"));
  tmpDirs.push(outside);
  return { outside, db, root, rigRoot, rigId, tmux, inst, member, read, addCwd, startupPaths };
}

import { CULTURE_FILE_MAX_BYTES, checkCultureFile, persistedCulturePath } from "../src/domain/culture-file-guard.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import { PiRuntimeAdapter } from "../src/adapters/pi-runtime-adapter.js";
import { StubRuntimeAdapter } from "../src/adapters/stub-runtime-adapter.js";
import type { ResolvedStartupFile } from "../src/domain/runtime-adapter.js";

// OF-15 (reworked). TRUST BOUNDARY: the daemon API caller is trusted -- whoever can call it can already start a
// seat in any folder -- so there is NO folder allowlist, and these tests PIN that (an outside regular file is
// accepted). The culture file is still hardened against accidents and swaps: regular file only, one link,
// at most 256 KiB, opened once with O_NOFOLLOW|O_NONBLOCK on the resolved path, read from that descriptor; the
// RESOLVED path is persisted; and every adapter's delivery/restore read goes through the same guarded reader.

async function refused(f: Awaited<ReturnType<typeof runningRig>>, culture: string, message: RegExp) {
  const nodesBefore = (f.db.prepare("SELECT COUNT(*) AS c FROM nodes").get() as { c: number }).c;
  const sessionsBefore = (f.tmux.createSession as ReturnType<typeof vi.fn>).mock.calls.length;
  const out = await f.inst.addMemberToPod(f.rigId, "dev", f.member(), f.rigRoot, { cultureFile: culture });
  expect(out).toMatchObject({ ok: false, code: "validation_failed" });
  expect(JSON.stringify(out)).toMatch(message);
  expect((f.db.prepare("SELECT COUNT(*) AS c FROM nodes").get() as { c: number }).c).toBe(nodesBefore);
  expect((f.tmux.createSession as ReturnType<typeof vi.fn>).mock.calls.length).toBe(sessionsBefore);
  expect(f.read("CLAUDE.md")).toBeNull();
}

describe("rig add --culture: no folder allowlist (the API caller is trusted)", () => {
  it("TRUST BOUNDARY PIN: a regular file in an unrelated folder is accepted and delivered", async () => {
    const f = await runningRig();
    const elsewhere = nodePath.join(f.outside, "CULTURE.md");
    fs.writeFileSync(elsewhere, `# elsewhere\n${MARKER}-OUTSIDE\n`);
    const out = await f.inst.addMemberToPod(f.rigId, "dev", f.member(), f.rigRoot, { cultureFile: elsewhere });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(f.read("CLAUDE.md")).toContain(`${MARKER}-OUTSIDE`);
    f.db.close();
  });

  it("a kernel-overlay-shaped symlink chain into another package folder is accepted", async () => {
    const f = await runningRig();
    const pkg = nodePath.join(f.outside, "pkg", "culture");
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(nodePath.join(pkg, "CULTURE.md"), `${MARKER}-KERNEL\n`);
    fs.symlinkSync(pkg, nodePath.join(f.outside, "release-culture"));
    fs.symlinkSync(nodePath.join(f.outside, "release-culture"), nodePath.join(f.rigRoot, "culture"));
    const out = await f.inst.addMemberToPod(f.rigId, "dev", f.member(), f.rigRoot, { cultureFile: "culture/CULTURE.md" });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(f.read("CLAUDE.md")).toContain(`${MARKER}-KERNEL`);
    f.db.close();
  });

  it("the RESOLVED real path is what is persisted for delivery and restore, flagged for the guarded reader", async () => {
    const f = await runningRig();
    const real = nodePath.join(f.outside, "real-culture.md");
    fs.writeFileSync(real, `${MARKER}-REAL\n`);
    fs.symlinkSync(real, nodePath.join(f.rigRoot, "LINK.md"));
    const out = await f.inst.addMemberToPod(f.rigId, "dev", f.member(), f.rigRoot, { cultureFile: "LINK.md" });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    const nodeId = (f.db.prepare("SELECT id FROM nodes WHERE logical_id = ?").get("dev.mgr") as { id: string }).id;
    const row = f.db.prepare("SELECT resolved_files_json FROM node_startup_context WHERE node_id = ?").get(nodeId) as { resolved_files_json: string };
    const entry = (JSON.parse(row.resolved_files_json) as Array<{ path: string; absolutePath: string; guardedRead?: boolean }>).find((e) => e.path === "LINK.md")!;
    expect(entry.absolutePath).toBe(fs.realpathSync(real));
    expect(entry.guardedRead).toBe(true);
    f.db.close();
  });
});

describe("the terminal-seat startup builder persists the resolved path and the guarded flag too", () => {
  it("a terminal seat added with --culture through a symlink persists the real path with guardedRead", async () => {
    const f = await runningRig();
    const real = nodePath.join(f.outside, "term-culture.md");
    fs.writeFileSync(real, `${MARKER}-TERM\n`);
    fs.symlinkSync(real, nodePath.join(f.rigRoot, "TLINK.md"));
    const out = await f.inst.addMemberToPod(f.rigId, "dev", { id: "term", agent_ref: "builtin:terminal", runtime: "terminal", profile: "none", cwd: f.addCwd }, f.rigRoot, { cultureFile: "TLINK.md" });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    const nodeId = (f.db.prepare("SELECT id FROM nodes WHERE logical_id = ?").get("dev.term") as { id: string }).id;
    const row = f.db.prepare("SELECT resolved_files_json FROM node_startup_context WHERE node_id = ?").get(nodeId) as { resolved_files_json: string };
    const entry = (JSON.parse(row.resolved_files_json) as Array<{ path: string; absolutePath: string; guardedRead?: boolean }>).find((e) => e.path === "TLINK.md")!;
    expect(entry.absolutePath).toBe(fs.realpathSync(real));
    expect(entry.guardedRead).toBe(true);
    f.db.close();
  });
});

describe("rig add --culture: file hardening (each refusal before any seat exists)", () => {
  it("a file over the size cap is refused; exactly at the cap it is delivered (boundary)", async () => {
    const f = await runningRig();
    fs.writeFileSync(nodePath.join(f.rigRoot, "BIG.md"), "x".repeat(CULTURE_FILE_MAX_BYTES + 1));
    await refused(f, "BIG.md", /is \d+ bytes, over the 262144-byte limit/);
    fs.writeFileSync(nodePath.join(f.rigRoot, "EXACT.md"), `${MARKER}-EXACT\n`.padEnd(CULTURE_FILE_MAX_BYTES, "y"));
    const out = await f.inst.addMemberToPod(f.rigId, "dev", f.member(), f.rigRoot, { cultureFile: "EXACT.md" });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(f.read("CLAUDE.md")).toContain(`${MARKER}-EXACT`);
    f.db.close();
  });

  it("a FIFO is refused as not a regular file, and the call does not hang", async () => {
    const f = await runningRig();
    execFileSync("mkfifo", [nodePath.join(f.rigRoot, "PIPE.md")]);
    await refused(f, "PIPE.md", /is not a regular file/);
    f.db.close();
  }, 10000);

  it("a device file (/dev/null), directly and through a symlink, is refused as not a regular file", async () => {
    const f = await runningRig();
    await refused(f, "/dev/null", /is not a regular file/);
    fs.symlinkSync("/dev/null", nodePath.join(f.rigRoot, "NULL.md"));
    await refused(f, "NULL.md", /is not a regular file/);
    f.db.close();
  });

  it("a hard-linked file (nlink > 1) is refused; the single-link original is accepted (control)", async () => {
    const f = await runningRig();
    const orig = nodePath.join(f.rigRoot, "ORIG.md");
    fs.writeFileSync(orig, `${MARKER}-ORIG\n`);
    const out = await f.inst.addMemberToPod(f.rigId, "dev", f.member(), f.rigRoot, { cultureFile: "ORIG.md" });
    expect(out.ok, JSON.stringify(out)).toBe(true); // CONTROL: one link
    f.db.close();
    const g = await runningRig();
    const real = nodePath.join(g.outside, "other.md");
    fs.writeFileSync(real, `${MARKER}-SECRET\n`);
    fs.linkSync(real, nodePath.join(g.rigRoot, "HARD.md"));
    await refused(g, "HARD.md", /has 2 hard links/);
    g.db.close();
  });
});

describe("checkCultureFile: swap races and nlink (deterministic via the test seams)", () => {
  const mk = () => {
    const root = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), "or-cfg-")));
    const outside = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), "or-cfg-out-")));
    tmpDirs.push(root, outside);
    return { root, outside };
  };

  it("CONTROL: a plain file is read, once, from the opened descriptor", () => {
    const { root } = mk();
    fs.writeFileSync(nodePath.join(root, "C.md"), "hello\n");
    expect(checkCultureFile("C.md", nodePath.join(root, "C.md"))).toMatchObject({ ok: true, bytes: 6, content: "hello\n" });
  });

  it("the leaf swapped for a symlink between the realpath and the open is refused (O_NOFOLLOW), not followed", () => {
    const { root, outside } = mk();
    const file = nodePath.join(root, "C.md");
    fs.writeFileSync(file, "ok\n");
    fs.writeFileSync(nodePath.join(outside, "secret"), "SECRET\n");
    const out = checkCultureFile("C.md", file, {
      beforeOpen: () => { fs.unlinkSync(file); fs.symlinkSync(nodePath.join(outside, "secret"), file); },
    });
    expect(out).toMatchObject({ ok: false, reason: "unreadable" });
    expect(JSON.stringify(out)).not.toContain("SECRET");
  });

  it("the file replaced by a different file after it was read is refused as changed (device+inode re-check)", () => {
    const { root } = mk();
    const file = nodePath.join(root, "C.md");
    fs.writeFileSync(file, "ok\n");
    const out = checkCultureFile("C.md", file, {
      afterRead: () => { fs.renameSync(file, `${file}.old`); fs.writeFileSync(file, "swapped\n"); },
    });
    expect(out).toMatchObject({ ok: false, reason: "changed" });
  });

  it("the parent directory swapped for a symlink to another folder after the read is refused as changed", () => {
    const { root, outside } = mk();
    fs.mkdirSync(nodePath.join(root, "d"));
    fs.writeFileSync(nodePath.join(root, "d", "C.md"), "ok\n");
    fs.writeFileSync(nodePath.join(outside, "C.md"), "SWAPPED\n");
    const out = checkCultureFile("C.md", nodePath.join(root, "d", "C.md"), {
      afterRead: () => { fs.renameSync(nodePath.join(root, "d"), nodePath.join(root, "d.old")); fs.symlinkSync(outside, nodePath.join(root, "d")); },
    });
    expect(out).toMatchObject({ ok: false, reason: "changed" });
  });

  it("a file whose link count goes up is refused with the count in the message", () => {
    const { root, outside } = mk();
    const file = nodePath.join(root, "C.md");
    fs.writeFileSync(file, "ok\n");
    fs.linkSync(file, nodePath.join(outside, "alias.md"));
    expect(checkCultureFile("C.md", file)).toMatchObject({ ok: false, reason: "hard_linked", message: expect.stringContaining("has 2 hard links") });
  });

  it("persistedCulturePath resolves symlinks, and falls back to the lexical path when it cannot", () => {
    const { root, outside } = mk();
    fs.writeFileSync(nodePath.join(outside, "T.md"), "x\n");
    fs.symlinkSync(nodePath.join(outside, "T.md"), nodePath.join(root, "L.md"));
    expect(persistedCulturePath(nodePath.join(root, "L.md"))).toBe(nodePath.join(outside, "T.md"));
    expect(persistedCulturePath(nodePath.join(root, "gone.md"))).toBe(nodePath.join(root, "gone.md"));
  });
});

describe("delivery and restore read the culture overlay through the shared guarded reader (all four adapters)", () => {
  const realFsOps = () => ({
    readFile: (p: string) => fs.readFileSync(p, "utf-8"),
    writeFile: (p: string, c: string) => fs.writeFileSync(p, c),
    exists: (p: string) => fs.existsSync(p),
    mkdirp: (p: string) => fs.mkdirSync(p, { recursive: true }),
    copyFile: (s: string, d: string) => fs.copyFileSync(s, d),
    listFiles: (dir: string) => (fs.existsSync(dir) && fs.statSync(dir).isDirectory() ? fs.readdirSync(dir) : []),
    homedir: os.tmpdir(),
  });
  type Deliver = { name: string; make: (cwd: string) => { deliverStartup: (files: ResolvedStartupFile[], binding: never) => Promise<{ delivered: number; failed: Array<{ path: string; error: string }> }> }; guidance: string };
  const adapters: Deliver[] = [
    { name: "claude-code", guidance: "CLAUDE.md", make: (cwd) => new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: realFsOps() as never, sleep: async () => {}, sessionIdFactory: () => "s" }) as never },
    { name: "codex", guidance: "AGENTS.md", make: () => new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: realFsOps() as never, sleep: async () => {} }) as never },
    { name: "pi", guidance: "AGENTS.md", make: (cwd) => new PiRuntimeAdapter({ tmux: mockTmux(), fsOps: realFsOps() as never, stateRoot: nodePath.join(cwd, "state"), runnerEntryPath: "/nonexistent/runner.js", sleep: async () => {} }) as never },
    { name: "stub", guidance: "AGENTS.md", make: () => new StubRuntimeAdapter({ tmux: mockTmux(), fsOps: realFsOps() as never, sleep: async () => {} } as never) as never },
  ];

  const setup = () => {
    const cwd = fs.mkdtempSync(nodePath.join(os.tmpdir(), "or-deliver-"));
    tmpDirs.push(cwd);
    const file = (absolutePath: string, guardedRead = true): ResolvedStartupFile => ({
      path: "CULTURE.md", absolutePath, ownerRoot: cwd, deliveryHint: "guidance_merge", required: true, appliesOn: ["fresh_start", "restore"], ...(guardedRead ? { guardedRead } : {}),
    });
    const binding = { id: "b", nodeId: "n", tmuxSession: "dev-mgr@r", cwd, cwdBase: cwd } as never;
    return { cwd, file, binding };
  };

  describe.each(adapters)("$name", ({ make, guidance }) => {
    it("CONTROL: an ordinary culture file is delivered", async () => {
      const { cwd, file, binding } = setup();
      const p = nodePath.join(cwd, "OK.md"); fs.writeFileSync(p, `${MARKER}-DELIVERED\n`);
      const out = await make(cwd).deliverStartup([file(p)], binding);
      expect(out.failed, JSON.stringify(out)).toEqual([]);
      expect(fs.readFileSync(nodePath.join(cwd, guidance), "utf-8")).toContain(`${MARKER}-DELIVERED`);
    });

    it("an oversize file (swapped in after rig add) is refused at delivery, nothing is merged", async () => {
      const { cwd, file, binding } = setup();
      const p = nodePath.join(cwd, "BIG.md"); fs.writeFileSync(p, `${MARKER}-BIG\n` + "x".repeat(CULTURE_FILE_MAX_BYTES));
      const out = await make(cwd).deliverStartup([file(p)], binding);
      expect(out.failed).toHaveLength(1);
      expect(out.failed[0]!.error).toMatch(/over the 262144-byte limit/);
      expect(fs.existsSync(nodePath.join(cwd, guidance))).toBe(false);
    });

    it("a hard-linked file is refused at delivery", async () => {
      const { cwd, file, binding } = setup();
      const p = nodePath.join(cwd, "H.md"); fs.writeFileSync(p, `${MARKER}-H\n`); fs.linkSync(p, nodePath.join(cwd, "H2.md"));
      const out = await make(cwd).deliverStartup([file(p)], binding);
      expect(out.failed).toHaveLength(1);
      expect(out.failed[0]!.error).toMatch(/has 2 hard links/);
    });

    it("a FIFO swapped in after rig add is refused at delivery and does not hang", async () => {
      const { cwd, file, binding } = setup();
      const p = nodePath.join(cwd, "PIPE.md"); execFileSync("mkfifo", [p]);
      const out = await make(cwd).deliverStartup([file(p)], binding);
      expect(out.failed).toHaveLength(1);
      expect(out.failed[0]!.error).toMatch(/is not a regular file/);
    }, 10000);

    it("a file without the guardedRead flag keeps the adapter's own reader (other startup files are unchanged)", async () => {
      const { cwd, file, binding } = setup();
      const p = nodePath.join(cwd, "BIGOK.md"); fs.writeFileSync(p, `${MARKER}-UNGUARDED\n` + "x".repeat(CULTURE_FILE_MAX_BYTES));
      const out = await make(cwd).deliverStartup([file(p, false)], binding);
      expect(out.failed, JSON.stringify(out)).toEqual([]);
    });
  });
});

describe("launch-time culture_file (rig spec) is judged by the same guard", () => {
  async function launch(setup: (rigRoot: string, outside: string) => void) {
    const f = await runningRig();
    const specRoot = nodePath.join(f.root, "spec2");
    fs.mkdirSync(nodePath.join(specRoot, "agents", "impl"), { recursive: true });
    fs.copyFileSync(nodePath.join(f.rigRoot, "agents", "impl", "agent.yaml"), nodePath.join(specRoot, "agents", "impl", "agent.yaml"));
    setup(specRoot, f.outside);
    const yaml = [
      `version: "0.2"`, `name: culture-rig-2`, `culture_file: CULTURE.md`, `pods:`, `  - id: dev`, `    label: Dev`, `    members:`,
      `      - id: impl`, `        agent_ref: "local:agents/impl"`, `        profile: default`, `        runtime: claude-code`, `        cwd: "${f.root}"`,
      `    edges: []`, `edges: []`,
    ].join("\n") + "\n";
    const out = await f.inst.instantiate(yaml, specRoot);
    f.db.close();
    return out;
  }

  it("an oversize CULTURE.md is refused at preflight", async () => {
    const out = await launch((specRoot) => fs.writeFileSync(nodePath.join(specRoot, "CULTURE.md"), "x".repeat(CULTURE_FILE_MAX_BYTES + 1)));
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out)).toMatch(/over the 262144-byte limit/);
  });

  it("a FIFO CULTURE.md is refused at preflight without hanging", async () => {
    const out = await launch((specRoot) => { execFileSync("mkfifo", [nodePath.join(specRoot, "CULTURE.md")]); });
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out)).toMatch(/is not a regular file/);
  }, 10000);

  it("a hard-linked CULTURE.md is refused at preflight", async () => {
    const out = await launch((specRoot, outside) => {
      fs.writeFileSync(nodePath.join(outside, "other.md"), "x\n");
      fs.linkSync(nodePath.join(outside, "other.md"), nodePath.join(specRoot, "CULTURE.md"));
    });
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out)).toMatch(/has 2 hard links/);
  });

  it("CONTROL: a CULTURE.md that is a symlink out of the spec folder (the kernel overlay shape) launches", async () => {
    const out = await launch((specRoot, outside) => {
      fs.writeFileSync(nodePath.join(outside, "pkg-culture.md"), `${MARKER}-PKG\n`);
      fs.symlinkSync(nodePath.join(outside, "pkg-culture.md"), nodePath.join(specRoot, "CULTURE.md"));
    });
    expect(out.ok, JSON.stringify(out)).toBe(true);
  });

  it("CONTROL: an ordinary CULTURE.md in the spec folder launches", async () => {
    const out = await launch((specRoot) => fs.writeFileSync(nodePath.join(specRoot, "CULTURE.md"), `${MARKER}-OK\n`));
    expect(out.ok, JSON.stringify(out)).toBe(true);
  });
});
