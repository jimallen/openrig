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

async function runningRig(standing: string[] = []) {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "or-rigadd-culture-"));
  tmpDirs.push(root);
  const rigRoot = nodePath.join(root, "rig");
  // The running rig's seat works in `root`, so the rig's own folders (rig/, elsewhere-culture.md, ...) are inside its
  // allowed culture roots; `outside` (a separate temp dir) is not.
  const implCwd = root;
  const addCwd = nodePath.join(root, "added-repo");
  const home = nodePath.join(root, "home");
  for (const d of [nodePath.join(rigRoot, "agents", "impl"), nodePath.join(root, "impl-repo"), addCwd, home]) fs.mkdirSync(d, { recursive: true });
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
    cultureStandingRoots: () => standing,
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

import { CULTURE_FILE_MAX_BYTES, rigWorkRoots, standingCultureRoots } from "../src/domain/culture-file-guard.js";

// OF-15: a rig's culture file is injected into the new seat's startup context, so `rig add --culture` /
// MCP rig_add cultureFile / spec culture_file must not name "any file the daemon can read" (~/.ssh/id_rsa).
// Allowed: inside the rig's own folders (seat cwds, run dir above .workspaces), the deployed ~/.agents
// release, $OPENRIG_HOME/shared-docs/rigs, OPENRIG_CULTURE_ROOTS. Regular file, <= 256 KiB, checked
// before any seat exists. `root` below is the running rig's seat cwd; `outside` is another temp dir.

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

describe("rig add --culture: refusals (each before any seat exists)", () => {
  it("a file outside every allowed root is refused, naming why and which roots were expected", async () => {
    const f = await runningRig();
    const secret = nodePath.join(f.outside, "id_rsa");
    fs.writeFileSync(secret, `-----BEGIN FAKE KEY-----\n${MARKER}-SECRET\n`);
    await refused(f, secret, /outside every allowed root; a culture file must be inside one of: .*or-rigadd-culture-/);
    // a plain outside file is not reported as reached "through a symlink"
    const out = await f.inst.addMemberToPod(f.rigId, "dev", f.member(), f.rigRoot, { cultureFile: secret });
    expect(JSON.stringify(out)).not.toMatch(/resolves through a symlink/);
    f.db.close();
  });

  it("a symlink from inside a root to a file outside is refused (the link is followed, the target judged)", async () => {
    const f = await runningRig();
    const secret = nodePath.join(f.outside, "credentials");
    fs.writeFileSync(secret, `${MARKER}-SECRET\n`);
    fs.symlinkSync(secret, nodePath.join(f.rigRoot, "CULTURE-LINK.md"));
    await refused(f, "CULTURE-LINK.md", /resolves through a symlink or alias to .*credentials\) is outside every allowed root/);
    await refused(f, nodePath.join(f.rigRoot, "CULTURE-LINK.md"), /outside every allowed root/);
    f.db.close();
  });

  it("a symlinked DIRECTORY inside a root that points outside is refused too", async () => {
    const f = await runningRig();
    fs.writeFileSync(nodePath.join(f.outside, "CULTURE.md"), `${MARKER}-SECRET\n`);
    fs.symlinkSync(f.outside, nodePath.join(f.rigRoot, "linked-dir"));
    await refused(f, "linked-dir/CULTURE.md", /outside every allowed root/);
    f.db.close();
  });

  it("`..` traversal out of the rig root to a file outside every root is refused", async () => {
    const f = await runningRig();
    const secret = nodePath.join(f.outside, "id_rsa");
    fs.writeFileSync(secret, `${MARKER}-SECRET\n`);
    await refused(f, nodePath.relative(f.rigRoot, secret), /outside every allowed root/);
    f.db.close();
  });

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

  it("a FIFO inside a root is refused as not a regular file, and the call does not hang", async () => {
    const f = await runningRig();
    execFileSync("mkfifo", [nodePath.join(f.rigRoot, "PIPE.md")]);
    await refused(f, "PIPE.md", /is not a regular file/);
    f.db.close();
  }, 10000);

  it("the caller-supplied rigRoot is not a trust anchor: --rig-root at the outside dir does not admit its files", async () => {
    const f = await runningRig();
    fs.writeFileSync(nodePath.join(f.outside, "CULTURE.md"), `${MARKER}-SECRET\n`);
    const nodesBefore = (f.db.prepare("SELECT COUNT(*) AS c FROM nodes").get() as { c: number }).c;
    const out = await f.inst.addMemberToPod(f.rigId, "dev", f.member(), f.outside, { cultureFile: "CULTURE.md" });
    expect(out).toMatchObject({ ok: false, code: "validation_failed" });
    expect(JSON.stringify(out)).toMatch(/outside every allowed root/);
    expect((f.db.prepare("SELECT COUNT(*) AS c FROM nodes").get() as { c: number }).c).toBe(nodesBefore);
    f.db.close();
  });
});

describe("rig add --culture: allowed roots (positive controls)", () => {
  it("a file inside the running rig's seat cwd tree is delivered", async () => {
    const f = await runningRig();
    const out = await f.inst.addMemberToPod(f.rigId, "dev", f.member(), f.rigRoot, { cultureFile: "CULTURE.md" });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(f.read("CLAUDE.md")).toContain(MARKER);
    f.db.close();
  });

  it("a file inside a standing root (the deployed ~/.agents release) is delivered even though no seat works there", async () => {
    const release = fs.mkdtempSync(nodePath.join(os.tmpdir(), "or-release-"));
    tmpDirs.push(release);
    fs.mkdirSync(nodePath.join(release, "abc123", "rigs", "jims-team"), { recursive: true });
    const culture = nodePath.join(release, "abc123", "rigs", "jims-team", "CULTURE.md");
    fs.writeFileSync(culture, `# release culture\n${MARKER}-RELEASE\n`);
    const f = await runningRig([release]);
    const out = await f.inst.addMemberToPod(f.rigId, "dev", f.member(), f.rigRoot, { cultureFile: culture });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(f.read("CLAUDE.md")).toContain(`${MARKER}-RELEASE`);
    f.db.close();
  });

  it("a symlink inside a root to another file inside a root is followed", async () => {
    const f = await runningRig();
    fs.symlinkSync(nodePath.join(f.rigRoot, "CULTURE.md"), nodePath.join(f.rigRoot, "CULTURE-ALIAS.md"));
    const out = await f.inst.addMemberToPod(f.rigId, "dev", f.member(), f.rigRoot, { cultureFile: "CULTURE-ALIAS.md" });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    f.db.close();
  });
});

describe("culture roots derivation", () => {
  it("a seat under <run dir>/.workspaces/<seat> contributes the run dir; a plain cwd contributes itself", () => {
    expect(rigWorkRoots(["/proj/run/.workspaces/dev-impl", "/other/repo", null])).toEqual(["/proj/run", "/other/repo"]);
  });
  it("the filesystem root and the home directory are never a rig's folder", () => {
    expect(rigWorkRoots(["/", "/Users/x", "/Users/x/.workspaces/s", "/Users/x/proj"], [], "/Users/x")).toEqual(["/Users/x/proj"]);
  });
  it("relative cwds are ignored", () => {
    expect(rigWorkRoots(["relative/dir"])).toEqual([]);
  });
  it("standing roots: the release dir, shared-docs/rigs under OPENRIG_HOME, plus absolute operator additions only", () => {
    expect(standingCultureRoots({ home: "/h", openrigHome: "/oh", extra: ["/a/b", "rel", "", "/c"].join(nodePath.delimiter) }))
      .toEqual(["/h/.agents-release", "/oh/shared-docs/rigs", "/a/b", "/c"]);
    expect(standingCultureRoots({ home: "/h", openrigHome: "/oh", extra: undefined })).toEqual(["/h/.agents-release", "/oh/shared-docs/rigs"]);
  });
});

describe("launch-time culture_file (rig spec) is judged by the same guard", () => {
  async function launch(setup: (rigRoot: string, outside: string) => void) {
    const f = await runningRig();
    // A second spec folder with its own CULTURE.md arrangement, launched as a fresh rig.
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

  it("a CULTURE.md that is a symlink out of the spec folder is refused at preflight", async () => {
    const out = await launch((specRoot, outside) => {
      fs.writeFileSync(nodePath.join(outside, "id_rsa"), `${MARKER}-SECRET\n`);
      fs.symlinkSync(nodePath.join(outside, "id_rsa"), nodePath.join(specRoot, "CULTURE.md"));
    });
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out)).toMatch(/outside every allowed root/);
  });

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

  it("CONTROL: an ordinary CULTURE.md in the spec folder still launches", async () => {
    const out = await launch((specRoot) => fs.writeFileSync(nodePath.join(specRoot, "CULTURE.md"), `${MARKER}-OK\n`));
    expect(out.ok, JSON.stringify(out)).toBe(true);
  });
});
