import { describe, it, expect, vi, afterEach } from "vitest";
import { mockShellCommand } from "./helpers/shell-command-mock.js";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { execFileSync, spawn } from "node:child_process";
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

// `rig add` builds a synthetic one-pod spec around the existing pod. That spec never carried the rig's
// culture_file, and the rig record does not store it, so a seat added to a RUNNING rig got the OpenRig
// culture floor but not the rig's own CULTURE.md. `rig add --culture <path>` supplies it explicitly.
// These drive the real instantiator + the real Claude adapter into temp dirs (fake tmux, no real
// processes) and read the seat's actual guidance file.

const MARKER = "RIGCULTURE-MARKER-7f3a";
const BEGIN = "<!-- BEGIN OpenRig MANAGED BLOCK:";

function mockTmux(): TmuxAdapter {
  return mockShellCommand({
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
  } as unknown as TmuxAdapter);
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
  return { db, root, rigRoot, rigId, tmux, inst, member, read, addCwd, startupPaths };
}

describe("rig add: the rig's own culture reaches a seat added to a running rig", () => {
  it("without --culture the added seat gets the culture FLOOR only (behaviour unchanged, pinned)", async () => {
    const f = await runningRig();
    const out = await f.inst.addMemberToPod(f.rigId, "dev", f.member(), f.rigRoot);
    expect(out.ok, JSON.stringify(out)).toBe(true);
    const guidance = f.read("CLAUDE.md");
    expect(guidance).toContain(BEGIN);       // the floor and startup blocks are there...
    expect(guidance).not.toContain(MARKER);  // ...the rig's CULTURE.md is not
    expect(f.startupPaths("dev.mgr")).not.toContain("CULTURE.md");
    f.db.close();
  });

  it("culture relative to rigRoot: the added seat's CLAUDE.md carries the rig-culture managed block", async () => {
    const f = await runningRig();
    const out = await f.inst.addMemberToPod(f.rigId, "dev", f.member(), f.rigRoot, { cultureFile: "CULTURE.md" });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    const guidance = f.read("CLAUDE.md")!;
    // The marker sits INSIDE a managed block (BEGIN ... marker ... END), not loose in the file.
    expect(guidance).toMatch(new RegExp(`${BEGIN}[^\\n]*-->\\n(?:(?!<!-- END)[\\s\\S])*${MARKER}`));
    expect(f.startupPaths("dev.mgr")).toContain("CULTURE.md");
    f.db.close();
  });

  it("an absolute culture path resolves as a launch does (path.resolve(rigRoot, p)) and is delivered", async () => {
    const f = await runningRig();
    const abs = nodePath.join(f.root, "elsewhere-culture.md");
    const out = await f.inst.addMemberToPod(f.rigId, "dev", f.member(), f.rigRoot, { cultureFile: abs });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(f.read("CLAUDE.md")).toContain(`${MARKER}-ABS`);
    f.db.close();
  });

  it.each([
    ["a file that does not exist (relative)", "NOPE.md", /culture file .*NOPE\.md.* not found/i],
    ["a file that does not exist (absolute)", "/definitely/not/here/CULTURE.md", /culture file .*not found/i],
    ["an empty path", "  ", /cultureFile: must be a non-empty string/],
    ["a non-string", 7, /cultureFile: must be a non-empty string/],
    ["a relative path that escapes the rig root", "../elsewhere-culture.md", /culture_file: path traversal/],
  ])("refuses %s as validation_failed, before any seat is created or launched", async (_label, culture, message) => {
    const f = await runningRig();
    const nodesBefore = (f.db.prepare("SELECT COUNT(*) AS c FROM nodes").get() as { c: number }).c;
    const sessionsBefore = (f.tmux.createSession as ReturnType<typeof vi.fn>).mock.calls.length;
    const out = await f.inst.addMemberToPod(f.rigId, "dev", f.member(), f.rigRoot, { cultureFile: culture as string });
    expect(out).toMatchObject({ ok: false, code: "validation_failed" });
    expect(JSON.stringify(out)).toMatch(message);
    expect((f.db.prepare("SELECT COUNT(*) AS c FROM nodes").get() as { c: number }).c).toBe(nodesBefore);
    expect((f.tmux.createSession as ReturnType<typeof vi.fn>).mock.calls.length).toBe(sessionsBefore);
    expect(f.read("CLAUDE.md")).toBeNull();
    f.db.close();
  });
});

// A culture file that EXISTS but cannot be delivered (a directory, an unreadable file) used to pass the
// existsSync-only check, then fail as a required startup file AFTER the seat was created. The check is
// now: the path, followed through symlinks, is a regular file the daemon can read. Symlinks are FOLLOWED
// (a CULTURE.md that is a link to a shared file is a normal setup); what the link points at is judged.
describe("rig add: the culture file must be a readable regular file, checked before any seat exists", () => {
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

  it("a directory (relative to the rig root) is refused as not a regular file", async () => {
    const f = await runningRig();
    await refused(f, "agents", /culture file .*agents.* is not a regular file/i);
    f.db.close();
  });

  it("a directory (absolute) is refused as not a regular file", async () => {
    const f = await runningRig();
    await refused(f, f.rigRoot, /is not a regular file/i);
    f.db.close();
  });

  it("a symlink to a directory is refused (the link is followed, the directory judged)", async () => {
    const f = await runningRig();
    fs.symlinkSync(nodePath.join(f.rigRoot, "agents"), nodePath.join(f.rigRoot, "culture-dir-link"));
    await refused(f, "culture-dir-link", /is not a regular file/i);
    f.db.close();
  });

  // exists() is true for these and statSync succeeds; only the file-type check refuses them. A FIFO is the
  // dangerous one: reading it as a startup file would block the daemon forever. (isDirectory() in place of
  // isFile() passes both of these, which the directory rows above cannot see.)
  it("a FIFO is refused as not a regular file", async () => {
    const f = await runningRig();
    const fifo = nodePath.join(f.rigRoot, "culture.fifo");
    execFileSync("mkfifo", [fifo]);
    // A writer parked on the FIFO, looping so every read (the daemon may read a startup file more than
    // once) finds a writer. Correct code never opens the FIFO, so the writer stays blocked and is killed
    // below. A regression that lets the FIFO through would read it, so the row FAILS (seat created)
    // instead of hanging the synchronous read and the whole worker.
    const writer = spawn("sh", ["-c", 'while :; do printf "%s" "$1" > "$2"; done', "sh", `# fifo\n${MARKER}\n`, fifo], { stdio: "ignore" });
    try {
      await refused(f, "culture.fifo", /culture file .*culture\.fifo.* is not a regular file/i);
    } finally { writer.kill("SIGKILL"); }
    f.db.close();
  });

  it("a device file (/dev/null), directly and through a symlink, is refused as not a regular file", async () => {
    const f = await runningRig();
    await refused(f, "/dev/null", /culture file .*\/dev\/null.* is not a regular file/i);
    fs.symlinkSync("/dev/null", nodePath.join(f.rigRoot, "null-link.md"));
    await refused(f, "null-link.md", /culture file .*null-link\.md.* is not a regular file/i);
    f.db.close();
  });

  it("a dangling symlink is refused as not found", async () => {
    const f = await runningRig();
    fs.symlinkSync(nodePath.join(f.root, "gone.md"), nodePath.join(f.rigRoot, "dangling.md"));
    await refused(f, "dangling.md", /not found/i);
    f.db.close();
  });

  // chmod 000 only denies a non-root user; as root the file stays readable and the row cannot be set up.
  it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)("an unreadable file is refused as not readable", async () => {
    const f = await runningRig();
    const locked = nodePath.join(f.rigRoot, "LOCKED.md");
    fs.writeFileSync(locked, `# locked\n${MARKER}\n`);
    fs.chmodSync(locked, 0o000);
    try {
      await refused(f, "LOCKED.md", /culture file .*LOCKED\.md.* is not readable/i);
    } finally { fs.chmodSync(locked, 0o600); }
    f.db.close();
  });

  it("a symlink to a regular file is followed and its content delivered", async () => {
    const f = await runningRig();
    fs.symlinkSync(nodePath.join(f.root, "elsewhere-culture.md"), nodePath.join(f.rigRoot, "LINKED.md"));
    const out = await f.inst.addMemberToPod(f.rigId, "dev", f.member(), f.rigRoot, { cultureFile: "LINKED.md" });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(f.read("CLAUDE.md")).toContain(`${MARKER}-ABS`);
    f.db.close();
  });
});

describe("rig add: the add fragment carries remote_control", () => {
  it("`remote_control: true` in the fragment persists on the new node and the real launch command carries --remote-control <session name>", async () => {
    const f = await runningRig();
    const out = await f.inst.addMemberToPod(f.rigId, "dev", f.member({ remote_control: true }), f.rigRoot);
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(f.db.prepare("SELECT remote_control FROM nodes WHERE logical_id = 'dev.mgr'").get()).toEqual({ remote_control: 1 });
    const sent = (f.tmux.sendText as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1] as string).filter((t) => t.includes("claude "));
    const cmd = sent.find((t) => t.includes("--remote-control"));
    expect(cmd, `commands sent: ${sent.join(" | ")}`).toBeDefined();
    const [, name] = /'--remote-control=([^']+)'/.exec(cmd!)!;
    expect(cmd).toContain(`--name=${name}`);
    // The sibling seat added by the spec (no remote_control) launched without it.
    expect(sent.filter((t) => t.includes("--remote-control"))).toHaveLength(1);
    f.db.close();
  });

  it.each([
    ["a non-boolean", { remote_control: "yes" }, /remote_control: must be a boolean/],
    ["true on a non-claude runtime", { runtime: "codex", remote_control: true }, /remote_control: only valid when runtime is \\"claude-code\\"/],
  ])("%s is refused by the add fragment's schema", async (_label, over, message) => {
    const f = await runningRig();
    const out = await f.inst.addMemberToPod(f.rigId, "dev", f.member(over), f.rigRoot);
    expect(out).toMatchObject({ ok: false, code: "validation_failed" });
    expect(JSON.stringify(out)).toMatch(message);
    expect(f.db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE logical_id = 'dev.mgr'").get()).toEqual({ c: 0 });
    f.db.close();
  });
});

describe("POST /api/rigs/:rigId/pods/:pod/members carries cultureFile to the instantiator", () => {
  function route() {
    const db = createFullTestDb();
    const setup = createTestApp(db);
    const spy = vi.spyOn(setup.podInstantiator, "addMemberToPod").mockResolvedValue({ ok: false, code: "pod_not_found", message: "stub" } as never);
    const rig = setup.rigRepo.createRig("r");
    const post = (body: Record<string, unknown>) => setup.app.request(`/api/rigs/${rig.id}/pods/dev/members`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { db, spy, post };
  }
  const member = { id: "mgr", runtime: "claude-code", agent_ref: "local:agents/impl", profile: "default", cwd: "." };

  it("a string cultureFile reaches addMemberToPod's options; absent reaches it as undefined", async () => {
    const { db, spy, post } = route();
    await post({ member, rigRoot: "/rr", cultureFile: "CULTURE.md" });
    expect(spy.mock.calls[0]![4]).toMatchObject({ cultureFile: "CULTURE.md" });
    await post({ member, rigRoot: "/rr" });
    expect(spy.mock.calls[1]![4]?.cultureFile).toBeUndefined();
    db.close();
  });

  it.each([[7], [""], [["a"]]])("a present non-string/empty cultureFile %j is a 400, never silently dropped", async (value) => {
    const { db, spy, post } = route();
    const res = await post({ member, cultureFile: value });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/cultureFile: must be a non-empty string/);
    expect(spy).not.toHaveBeenCalled();
    db.close();
  });
});
