// A seat's own Claude config home (`claude_config_dir`, `rig seat set-claude-home`): one canonical spelling, stored on
// the node, carried by every launch path, and never the default home spelled out. Fixture homes and a fake `claude`
// only: no native Claude, no real user configuration. Proves OpenRig's routing, not Claude's login or lookup.
import { TMP_CREDENTIAL_FILES } from "./helpers/credential-files.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import type Database from "better-sqlite3";
import { claudeConfigDirFindings, claudeConfigDirLaunchRefusal, claudeHomeNoModelFinding, claudeForkHomeRefusal, claudeConfigDirShapeError, normalizeClaudeConfigDir, seatClaudeConfigDirEnv } from "../src/domain/claude-config-dir.js";
import { RigSpecSchema } from "../src/domain/rigspec-schema.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import { ClaudeManagedLaunch } from "../src/domain/claude-managed-launch.js";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import { sessionEnvFromLabels, sessionEnvLabels } from "../src/adapters/hc-identity.js";
import { seatRestartEnv } from "../src/domain/seat-restart-env.js";
import { partitionLaunchEnv } from "../src/adapters/tmux-launch-env-channel.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";

/** A test double that implements only what the code under test calls. */
function partial<T>(implemented: Partial<T>): T { return implemented as T; }

const cleanup: Array<() => void> = [];
afterEach(() => { for (const f of cleanup.splice(0).reverse()) f(); });
function scratch(prefix: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), prefix)));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

describe("normalizeClaudeConfigDir: one canonical spelling", () => {
  const home = "/Users/jim";
  it.each([
    ["~/.claude-cel", "/Users/jim/.claude-cel"],
    ["~/.claude-cel/", "/Users/jim/.claude-cel"],
    ["/Users/jim/.claude-cel//", "/Users/jim/.claude-cel"],
    ["//opt//homes/cel", "/opt/homes/cel"],
  ])("%s -> %s", (raw, canonical) => {
    expect(normalizeClaudeConfigDir(raw, home)).toEqual({ ok: true, value: canonical });
  });

  it.each([
    ["relative", ".claude-cel"],
    ["dot-relative", "./x"],
    ["bare tilde", "~"],
    ["another user's tilde", "~bob/.claude"],
    ["dot segment", "/a/./b"],
    ["dotdot segment", "~/../x"],
    ["empty", ""],
    ["surrounding whitespace", " /a"],
    ["line break", "/a\nb"],
    ["the filesystem root", "/"],
    ["the home itself", "~/"],
    ["the default home, as ~", "~/.claude"],
    ["the default home, absolute with slash", "/Users/jim/.claude/"],
  ])("refuses %s", (_label, raw) => {
    expect(normalizeClaudeConfigDir(raw, home).ok).toBe(false);
  });

  it("refuses a non-string, and ~/ when HOME is unknown", () => {
    expect(normalizeClaudeConfigDir(5, home).ok).toBe(false);
    expect(normalizeClaudeConfigDir("~/.claude-cel", undefined).ok).toBe(false);
  });

  it("the shape check needs no HOME and agrees with the normaliser", () => {
    expect(claudeConfigDirShapeError("~/.claude-cel")).toBeNull();
    expect(claudeConfigDirShapeError("rel/dir")).toMatch(/absolute/);
  });

  it("adds CLAUDE_CONFIG_DIR only for a seat that has a home", () => {
    expect(seatClaudeConfigDirEnv({ claudeConfigDir: "/h/cel" })).toEqual({ CLAUDE_CONFIG_DIR: "/h/cel" });
    expect(seatClaudeConfigDirEnv({})).toEqual({});
    expect(seatClaudeConfigDirEnv({ claudeConfigDir: null })).toEqual({});
  });

  it("refuses a launch when the stored home is not a directory", () => {
    const root = scratch("ccd-refuse-");
    expect(claudeConfigDirLaunchRefusal(root)).toBeNull();
    expect(claudeConfigDirLaunchRefusal(undefined)).toBeNull();
    expect(claudeConfigDirLaunchRefusal(path.join(root, "gone"))).toMatch(/^claude_config_dir_missing:/);
    fs.writeFileSync(path.join(root, "file"), "");
    expect(claudeConfigDirLaunchRefusal(path.join(root, "file"))).toMatch(/not a directory/);
  });
});

describe("the claude_config_dir member field", () => {
  function spec(member: Record<string, unknown>) {
    return { version: "0.2", name: "r", pods: [{ id: "dev", label: "Dev", members: [{ id: "impl", agent_ref: "local:a", profile: "default", runtime: "claude-code", cwd: ".", ...member }], edges: [] }], edges: [] };
  }

  it("is accepted on a claude-code (and stub) seat, carried as written, and serialised back", () => {
    expect(RigSpecSchema.validate(spec({ claude_config_dir: "~/.claude-cel" })).valid).toBe(true);
    expect(RigSpecSchema.validate(spec({ runtime: "stub", claude_config_dir: "/x" })).valid).toBe(true);
    const normalized = RigSpecSchema.normalize(spec({ claude_config_dir: "~/.claude-cel" }));
    expect(normalized.pods[0]!.members[0]!.claudeConfigDir).toBe("~/.claude-cel");
    expect(RigSpecCodec.serialize(normalized)).toContain("claude_config_dir: ~/.claude-cel");
    expect(RigSpecSchema.normalize(spec({})).pods[0]!.members[0]!.claudeConfigDir).toBeUndefined();
  });

  it.each([
    [{ runtime: "codex", claude_config_dir: "/x" }, /only valid when runtime is "claude-code"/],
    [{ claude_config_dir: "relative" }, /absolute/],
    [{ claude_config_dir: true }, /text value/],
  ])("refuses %j", (member, message) => {
    const result = RigSpecSchema.validate(spec(member));
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toMatch(message);
  });
});

describe("persistence and the fresh launch env", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  beforeEach(() => { db = createFullTestDb(); rigRepo = new RigRepository(db); });
  afterEach(() => db.close());

  it("stores the home on the node, reads it back, and clears it to absent", () => {
    const rig = rigRepo.createRig("r");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code", claudeConfigDir: "/h/cel" });
    const nodeOf = (id: string) => rigRepo.getRig(rig.id)!.nodes.find(n => n.id === id)!;
    expect(node.claudeConfigDir).toBe("/h/cel");
    expect(nodeOf(node.id).claudeConfigDir).toBe("/h/cel");
    expect(rigRepo.getNodeClaudeConfigDir(node.id)).toBe("/h/cel");
    expect(rigRepo.setNodeClaudeConfigDir(node.id, null)).toBe(true);
    expect(nodeOf(node.id)).not.toHaveProperty("claudeConfigDir");
    expect(rigRepo.addNode(rig.id, "dev.peer", { runtime: "claude-code" })).not.toHaveProperty("claudeConfigDir");
  });

  function launcher(captured: Array<{ name: string; env?: Record<string, string> }>) {
    const tmux = partial<TmuxAdapter>({
      createSession: async (name: string, _cwd?: string, env?: Record<string, string>) => { captured.push({ name, env }); return { ok: true as const }; },
      killSession: async () => ({ ok: true as const }), listPanes: async () => [],
      hasSession: async () => false, sendText: async () => ({ ok: true as const }), sendKeys: async () => ({ ok: true as const }),
    });
    const openrigHome = scratch("ccd-openrig-");
    return new NodeLauncher({ credentialFiles: TMP_CREDENTIAL_FILES, db, rigRepo, sessionRegistry: new SessionRegistry(db), eventBus: new EventBus(db), tmuxAdapter: tmux, sessionEnv: { OPENRIG_HOME: openrigHome } });
  }

  it("a seat with a home launches with CLAUDE_CONFIG_DIR set to it; a seat without one gets none", async () => {
    const home = scratch("ccd-home-");
    const rig = rigRepo.createRig("r");
    rigRepo.addNode(rig.id, "dev.cel", { runtime: "claude-code", claudeConfigDir: home });
    rigRepo.addNode(rig.id, "dev.plain", { runtime: "claude-code" });
    const captured: Array<{ name: string; env?: Record<string, string> }> = [];
    const nl = launcher(captured);
    const cel = await nl.launchNode(rig.id, "dev.cel");
    const plain = await nl.launchNode(rig.id, "dev.plain");
    if (!cel.ok || !plain.ok) throw new Error("launch failed");
    expect(captured.find(c => c.name === cel.sessionName)?.env?.["CLAUDE_CONFIG_DIR"]).toBe(home);
    expect(captured.find(c => c.name === plain.sessionName)?.env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
  });

  // workspaces-o9o.10 (a): a Claude seat with its own home, no model of its own (nodes.model: spec or rig seat set-model)
  // and no `model` in <home>/settings.json launches with no --model, so Claude picks the project setting or the account
  // default and OpenRig said nothing. The launch warns; it never refuses.
  describe("a seat home with no default model (workspaces-o9o.10)", () => {
    const fsRead = { exists: fs.existsSync, isDirectory: (p: string) => fs.statSync(p).isDirectory(), readFile: (p: string) => fs.readFileSync(p, "utf8") };
    function readingLauncher(captured: Array<{ name: string; env?: Record<string, string> }>) {
      const tmux = partial<TmuxAdapter>({
        createSession: async (name: string, _cwd?: string, env?: Record<string, string>) => { captured.push({ name, env }); return { ok: true as const }; },
        killSession: async () => ({ ok: true as const }), listPanes: async () => [],
        hasSession: async () => false, sendText: async () => ({ ok: true as const }), sendKeys: async () => ({ ok: true as const }),
      });
      return new NodeLauncher({ credentialFiles: TMP_CREDENTIAL_FILES, db, rigRepo, sessionRegistry: new SessionRegistry(db), eventBus: new EventBus(db), tmuxAdapter: tmux,
        sessionEnv: { OPENRIG_HOME: scratch("ccd-openrig-") }, claudeHomeRead: fsRead });
    }
    function home(settings?: string): string {
      const dir = scratch("ccd-model-");
      fs.writeFileSync(path.join(dir, ".claude.json"), "{}");
      if (settings !== undefined) fs.writeFileSync(path.join(dir, "settings.json"), settings);
      return dir;
    }
    const noModel = (warnings: string[] | undefined) => (warnings ?? []).filter((w) => w.includes("sets no model"));

    it.each([
      ["no settings.json", undefined],
      ["settings.json without a model", JSON.stringify({ skipDangerousModePermissionPrompt: true })],
      ["an empty model", JSON.stringify({ model: "" })],
      ["unparseable settings.json", "{ not json"],
    ])("warns at launch, and still launches, when the home has %s and the seat has no model", async (_label, settings) => {
      const dir = home(settings);
      const rig = rigRepo.createRig("r");
      rigRepo.addNode(rig.id, "dev.cel", { runtime: "claude-code", claudeConfigDir: dir });
      const captured: Array<{ name: string; env?: Record<string, string> }> = [];
      const result = await readingLauncher(captured).launchNode(rig.id, "dev.cel");
      if (!result.ok) throw new Error(result.message);
      expect(captured).toHaveLength(1);
      expect(noModel(result.warnings)).toEqual([
        `dev.cel: ${path.join(dir, "settings.json")} sets no model and the seat has none of its own, so Claude picks its model from its other sources in Claude Code's documented order (ANTHROPIC_MODEL, a model setting in managed, project or local settings, your organization's default, ANTHROPIC_DEFAULT_MODEL), else the account default; see https://code.claude.com/docs/en/model-config. Pin one with: rig seat set-model ${result.sessionName} --model <model> --reason <why>, or set "model" in ${path.join(dir, "settings.json")}.`,
      ]);
    });

    // The production launcher gets its reader only from startup.ts; without it nothing is read and no seat is warned.
    // Instrument: a text scan of the one `new NodeLauncher({` in packages/daemon/src/startup.ts (as the OF-183 census does).
    it("the daemon's node launcher is wired with a Claude-home reader", () => {
      const startup = fs.readFileSync(path.resolve(import.meta.dirname, "../src/startup.ts"), "utf-8");
      const constructions = startup.match(/new NodeLauncher\(\{[\s\S]*?\n  \}\);/g) ?? [];
      expect(constructions).toHaveLength(1);
      expect(constructions[0]).toMatch(/\n    claudeHomeRead: \{ exists: /);
    });

    // workspaces-o9o.10 review: a handover's successor is launched by SuccessorSessionLauncher, built inside
    // SeatHandoverService from its deps; the one production SeatHandoverService is the handover route's. Same instrument:
    // a text scan of each construction (src census: one `new SeatHandoverService({` in routes/seat.ts, one
    // `new SuccessorSessionLauncher(` in seat-handover-service.ts).
    it("the handover route's successor launcher is wired with a Claude-home reader (workspaces-o9o.10)", () => {
      const route = fs.readFileSync(path.resolve(import.meta.dirname, "../src/routes/seat.ts"), "utf-8");
      const handovers = route.match(/new SeatHandoverService\(\{[\s\S]*?\n  \}\);/g) ?? [];
      expect(handovers).toHaveLength(1);
      expect(handovers[0]).toMatch(/\n    claudeHomeRead: \{ exists: /);
      const service = fs.readFileSync(path.resolve(import.meta.dirname, "../src/domain/seat-handover-service.ts"), "utf-8");
      const launchers = service.match(/new SuccessorSessionLauncher\([\s\S]*?\n    \}\);/g) ?? [];
      expect(launchers).toHaveLength(1);
      expect(launchers[0]).toMatch(/claudeHomeRead: deps\.claudeHomeRead/);
    });

    it("warns for the stub stand-in too, as set-claude-home accepts it", async () => {
      const rig = rigRepo.createRig("r");
      rigRepo.addNode(rig.id, "dev.stub", { runtime: "stub", claudeConfigDir: home() });
      const result = await readingLauncher([]).launchNode(rig.id, "dev.stub");
      if (!result.ok) throw new Error(result.message);
      expect(noModel(result.warnings)).toHaveLength(1);
    });

    it("says nothing when the seat has a model, the home sets one, the seat has no home of its own, or the seat is not Claude (terminal)", async () => {
      const rig = rigRepo.createRig("r");
      const pinned = rigRepo.addNode(rig.id, "dev.pinned", { runtime: "claude-code", claudeConfigDir: home() });
      rigRepo.setNodeModel(pinned.id, "opus");
      rigRepo.addNode(rig.id, "dev.homeset", { runtime: "claude-code", claudeConfigDir: home(JSON.stringify({ model: "sonnet" })) });
      rigRepo.addNode(rig.id, "dev.plain", { runtime: "claude-code" });
      rigRepo.addNode(rig.id, "dev.term", { runtime: "terminal", claudeConfigDir: home() });
      const nl = readingLauncher([]);
      for (const logicalId of ["dev.pinned", "dev.homeset", "dev.plain", "dev.term"]) {
        const result = await nl.launchNode(rig.id, logicalId);
        if (!result.ok) throw new Error(`${logicalId}: ${result.message}`);
        expect(noModel(result.warnings), logicalId).toEqual([]);
      }
    });
  });

  it("refuses the launch, before any session exists, when the seat's home is gone", async () => {
    const rig = rigRepo.createRig("r");
    rigRepo.addNode(rig.id, "dev.cel", { runtime: "claude-code", claudeConfigDir: path.join(scratch("ccd-gone-"), "missing") });
    const captured: Array<{ name: string; env?: Record<string, string> }> = [];
    const result = await launcher(captured).launchNode(rig.id, "dev.cel");
    expect(result).toMatchObject({ ok: false, code: "claude_config_dir_missing" });
    expect(captured).toHaveLength(0);
  });
});

describe("respawn and channel: the home survives a daemon restart and is argv-safe", () => {
  it("is written as an hc label and read back for a respawn that kept no record", () => {
    const labels = sessionEnvLabels({ OPENRIG_NODE_ID: "n1", OPENRIG_SESSION_NAME: "a@r", CLAUDE_CONFIG_DIR: "/h/cel" });
    expect(sessionEnvFromLabels(labels)).toMatchObject({ CLAUDE_CONFIG_DIR: "/h/cel" });
    const env = seatRestartEnv(sessionEnvFromLabels(labels), { sessionEnv: { HOME: "/h", OPENRIG_HOME: "/h/.openrig", PATH: "/bin" }, runtimeSessionEnv: {}, runtimeOf: () => "claude-code" });
    expect(env["CLAUDE_CONFIG_DIR"]).toBe("/h/cel");
  });

  it("rides the tmux argv like CODEX_HOME (a path, never a credential)", () => {
    expect(partitionLaunchEnv({ CLAUDE_CONFIG_DIR: "/h/cel" }).argv).toEqual({ CLAUDE_CONFIG_DIR: "/h/cel" });
  });
});

describe("managed launch and bootstrap use the seat's home", () => {
  function fixture(opts: { seatHome: "set" | "none" | "missing"; daemonSelection?: "alternate" }) {
    const root = scratch("ccd-managed-");
    const cwd = path.join(root, "seat");
    const home = path.join(root, "home");
    const bin = path.join(root, "bin");
    const seatHome = path.join(root, "cel-home");
    for (const dir of [cwd, home, bin]) fs.mkdirSync(dir, { recursive: true });
    if (opts.seatHome === "set") fs.mkdirSync(seatHome);
    const env: Record<string, string> = { PATH: bin, HOME: home };
    if (opts.daemonSelection) env.CLAUDE_CONFIG_DIR = path.join(root, "daemon-selected");
    const executable = path.join(bin, "claude");
    fs.writeFileSync(executable, `#!${process.execPath}
if (process.argv.includes('--help')) { console.log('--permission-mode <mode> (choices: "acceptEdits", "default")'); process.exit(0); }
console.log(JSON.stringify({ CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null }));\n`);
    fs.chmodSync(executable, 0o700);
    const db = createFullTestDb(); cleanup.push(() => db.close());
    const rigRepo = new RigRepository(db);
    const rig = rigRepo.createRig("r");
    const node = rigRepo.addNode(rig.id, "dev.cel", { runtime: "claude-code", cwd, ...(opts.seatHome !== "none" ? { claudeConfigDir: seatHome } : {}) });
    const managed = new ClaudeManagedLaunch(db, env, {}, () => []);
    const fsOps: ClaudeAdapterFsOps = {
      homedir: home, exists: fs.existsSync, mkdirp: p => { fs.mkdirSync(p, { recursive: true }); },
      readFile: p => fs.readFileSync(p, "utf8"), writeFile: (p, t) => fs.writeFileSync(p, t),
      copyFile: fs.copyFileSync, readdir: p => fs.readdirSync(p),
    };
    const adapter = new ClaudeCodeAdapter({ tmux: {} as TmuxAdapter, fsOps, claudeManagedLaunch: managed });
    return { root, cwd, home, seatHome, managed, adapter, node };
  }

  it.each([["over the daemon's own selection", "alternate" as const], ["with no daemon selection", undefined]])("the managed env -i launch states the seat's home, %s", async (_label, daemonSelection) => {
    const f = fixture({ seatHome: "set", daemonSelection });
    expect(f.managed.configPaths(f.cwd, f.seatHome)).toEqual({ configDir: f.seatHome, statePath: path.join(f.seatHome, ".claude.json") });
    const prepared = await f.managed.prepare({ nodeId: f.node.id }, "acceptEdits");
    expect(prepared.configDir).toBe(f.seatHome);
    const out = JSON.parse(execFileSync("/bin/sh", ["-c", prepared.command([])], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } }));
    expect(out).toEqual({ CLAUDE_CONFIG_DIR: f.seatHome });
  });

  it("a seat without a home keeps the unset native selection (nothing exported)", async () => {
    const f = fixture({ seatHome: "none" });
    const prepared = await f.managed.prepare({ nodeId: f.node.id }, "acceptEdits");
    const out = JSON.parse(execFileSync("/bin/sh", ["-c", prepared.command([])], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } }));
    expect(out).toEqual({ CLAUDE_CONFIG_DIR: null });
  });

  it("refuses a managed launch whose seat home is gone", async () => {
    const f = fixture({ seatHome: "missing" });
    await expect(f.managed.prepare({ nodeId: f.node.id }, "acceptEdits")).rejects.toThrow(/claude_config_dir_missing/);
  });

  it("classic bootstrap writes trust and onboarding into <seat home>/.claude.json only", () => {
    const f = fixture({ seatHome: "set", daemonSelection: "alternate" });
    f.adapter.ensureManagedBootstrap({ nodeId: f.node.id, cwd: f.cwd });
    const state = JSON.parse(fs.readFileSync(path.join(f.seatHome, ".claude.json"), "utf8"));
    expect(state).toMatchObject({ hasCompletedOnboarding: true, projects: { [f.cwd]: { hasTrustDialogAccepted: true } } });
    expect(fs.existsSync(path.join(f.home, ".claude.json"))).toBe(false);
    expect(fs.existsSync(path.join(f.root, "daemon-selected", ".claude.json"))).toBe(false);
  });

  it("managed bootstrap writes into the seat's home too", () => {
    const f = fixture({ seatHome: "set" });
    f.adapter.ensureManagedBootstrap({ nodeId: f.node.id, cwd: f.cwd, permissionMode: "acceptEdits" } as Pick<NodeBinding, "nodeId" | "cwd" | "permissionMode">);
    expect(fs.existsSync(path.join(f.seatHome, ".claude.json"))).toBe(true);
    expect(fs.existsSync(path.join(f.home, ".claude.json"))).toBe(false);
  });
});

describe("SeatLifecycleService.setClaudeHome", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let service: SeatLifecycleService;
  const savedHome = process.env.HOME;
  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    service = new SeatLifecycleService({ db, rigRepo, sessionRegistry, eventBus: new EventBus(db),
      claudeHomeRead: { exists: fs.existsSync, isDirectory: (p) => fs.statSync(p).isDirectory(), readFile: (p) => fs.readFileSync(p, "utf8") },
      tmuxAdapter: partial<TmuxAdapter>({ probeSession: async () => ({ state: "present" as const }) }) });
  });
  afterEach(() => { db.close(); process.env.HOME = savedHome; });

  function seat(logicalId: string, runtime = "claude-code") {
    const rig = rigRepo.findRigsByName("ch-rig")[0] ?? rigRepo.createRig("ch-rig");
    const node = rigRepo.addNode(rig.id, logicalId, { runtime, cwd: "/project" });
    const session = new SessionRegistry(db).registerSession(node.id, `${logicalId.replace(".", "-")}@ch-rig`);
    new SessionRegistry(db).updateStatus(session.id, "running");
    return { rig, node, sessionName: `${logicalId.replace(".", "-")}@ch-rig` };
  }
  const events = () => (db.prepare("SELECT payload FROM events WHERE type = 'node.claude_home_changed' ORDER BY seq").all() as Array<{ payload: string }>).map(r => JSON.parse(r.payload));

  it("stores the canonical spelling, audits it, touches no peer, and clears back to absent", async () => {
    const userHome = scratch("ccd-user-");
    process.env.HOME = userHome;
    fs.mkdirSync(path.join(userHome, ".claude-cel"));
    const { node, sessionName } = seat("dev.impl");
    const peer = seat("dev.peer");
    const result = await service.setClaudeHome({ seatRef: sessionName, dir: "~/.claude-cel/", reason: "cel account", operator: "orch@r" });
    if (!result.ok) throw new Error(result.message);
    expect(result).toMatchObject({ from: null, to: path.join(userHome, ".claude-cel"), changed: true, running: "yes" });
    expect(rigRepo.getNodeClaudeConfigDir(node.id)).toBe(path.join(userHome, ".claude-cel"));
    expect(rigRepo.getNodeClaudeConfigDir(peer.node.id)).toBeNull();
    expect(events()).toEqual([expect.objectContaining({ from: null, to: path.join(userHome, ".claude-cel"), reason: "cel account", operator: "orch@r", logicalId: "dev.impl" })]);

    const again = await service.setClaudeHome({ seatRef: sessionName, dir: path.join(userHome, ".claude-cel"), reason: "same" });
    expect(again).toMatchObject({ ok: true, changed: false });
    expect(events()).toHaveLength(1);

    const cleared = await service.setClaudeHome({ seatRef: sessionName, dir: null, reason: "back" });
    expect(cleared).toMatchObject({ ok: true, to: null, changed: true });
    expect(rigRepo.getNodeClaudeConfigDir(node.id)).toBeNull();
  });

  // workspaces-o9o.123 round 2 (verify-sec2 F1): clearing the home of a code_mode seat would strand the invariant (Code Mode's answer
  // has nowhere to live), so --clear is refused for a code_mode seat; a non-code_mode seat clears as before.
  it("refuses to clear the home of a code_mode seat, naming code_mode and the way out; a non-code_mode seat still clears", async () => {
    const userHome = scratch("ccd-user-");
    process.env.HOME = userHome;
    fs.mkdirSync(path.join(userHome, ".claude-cm"));
    const { node, sessionName } = seat("dev.cm");
    await service.setClaudeHome({ seatRef: sessionName, dir: "~/.claude-cm/", reason: "cel" });
    rigRepo.setNodeCodeMode(node.id, true);                         // the seat now runs Code Mode
    const refused = await service.setClaudeHome({ seatRef: sessionName, dir: null, reason: "clearing" });
    expect(refused).toMatchObject({ ok: false, code: "code_mode_needs_home" });
    expect(JSON.stringify(refused)).toMatch(/Code Mode \(code_mode\)/);
    expect(JSON.stringify(refused)).toMatch(/code_mode: false/);
    expect(rigRepo.getNodeClaudeConfigDir(node.id)).toBe(path.join(userHome, ".claude-cm"));   // home untouched
    // Control: with Code Mode off, the same clear succeeds.
    rigRepo.setNodeCodeMode(node.id, false);
    const cleared = await service.setClaudeHome({ seatRef: sessionName, dir: null, reason: "clearing" });
    expect(cleared).toMatchObject({ ok: true, to: null, changed: true });
    expect(rigRepo.getNodeClaudeConfigDir(node.id)).toBeNull();
  });

  it("refuses the default home, a relative path, a missing reason and a non-Claude seat, writing nothing", async () => {
    const userHome = scratch("ccd-user-");
    process.env.HOME = userHome;
    const { node, sessionName } = seat("dev.impl");
    const codex = seat("dev.codex", "codex");
    expect(await service.setClaudeHome({ seatRef: sessionName, dir: "~/.claude", reason: "x" })).toMatchObject({ ok: false, code: "invalid_claude_config_dir" });
    expect(await service.setClaudeHome({ seatRef: sessionName, dir: "rel", reason: "x" })).toMatchObject({ ok: false, code: "invalid_claude_config_dir" });
    expect(await service.setClaudeHome({ seatRef: sessionName, dir: "/x", reason: " " })).toMatchObject({ ok: false, code: "missing_reason" });
    expect(await service.setClaudeHome({ seatRef: codex.sessionName, dir: "/x", reason: "x" })).toMatchObject({ ok: false, code: "claude_home_unsupported_runtime" });
    expect(rigRepo.getNodeClaudeConfigDir(node.id)).toBeNull();
    expect(events()).toHaveLength(0);
  });

  it("accepts a stub seat (the scenario stand-in), as the spec field does", async () => {
    const userHome = scratch("ccd-user-");
    process.env.HOME = userHome;
    const stub = seat("dev.stub", "stub");
    expect(await service.setClaudeHome({ seatRef: stub.sessionName, dir: "/x", reason: "scenario" })).toMatchObject({ ok: true, to: "/x" });
  });

  // workspaces-o9o.10 (a): set-claude-home names the gap when it saves a home for a seat with no model of its own.
  it("reports a home with no default model for a seat with no model, and not once the seat has one (workspaces-o9o.10)", async () => {
    const userHome = scratch("ccd-user-");
    process.env.HOME = userHome;
    const cel = path.join(userHome, ".claude-cel");
    fs.mkdirSync(cel);
    fs.writeFileSync(path.join(cel, ".claude.json"), "{}");
    const { node, sessionName } = seat("dev.impl");
    const settings = path.join(cel, "settings.json");
    const expected = `${settings} sets no model and the seat has none of its own, so Claude picks its model from its other sources in Claude Code's documented order (ANTHROPIC_MODEL, a model setting in managed, project or local settings, your organization's default, ANTHROPIC_DEFAULT_MODEL), else the account default; see https://code.claude.com/docs/en/model-config. Pin one with: rig seat set-model ${sessionName} --model <model> --reason <why>, or set "model" in ${settings}.`;
    const first = await service.setClaudeHome({ seatRef: sessionName, dir: cel, reason: "cel account" });
    if (!first.ok) throw new Error(first.message);
    expect(first.findings).toContain(expected);

    rigRepo.setNodeModel(node.id, "opus");
    const pinned = await service.setClaudeHome({ seatRef: sessionName, dir: cel, reason: "same" });
    if (!pinned.ok) throw new Error(pinned.message);
    expect(pinned.findings.filter((f) => f.includes("sets no model"))).toEqual([]);
  });

  // workspaces-o9o.10 review: the home is not Claude's only model source. The warning names the others in Claude Code's
  // documented order (model-config: ANTHROPIC_MODEL, a settings `model`, the organization default, ANTHROPIC_DEFAULT_MODEL),
  // then the account default, and cites the page rather than claiming more.
  it("names Claude's other model sources in the documented order, then the account default, and cites the docs (workspaces-o9o.10)", () => {
    const read = { exists: (p: string) => p === "/h", isDirectory: () => true, readFile: () => "{}" };
    const finding = claudeHomeNoModelFinding("/h", "dev-impl@r", read) ?? "";
    expect(finding).toContain("in Claude Code's documented order (ANTHROPIC_MODEL, a model setting in managed, project or local settings, your organization's default, ANTHROPIC_DEFAULT_MODEL), else the account default; see https://code.claude.com/docs/en/model-config.");
  });

  it("a home that is not a directory gets its own finding, not the no-model one (workspaces-o9o.10)", async () => {
    const userHome = scratch("ccd-user-");
    process.env.HOME = userHome;
    const { sessionName } = seat("dev.impl");
    const result = await service.setClaudeHome({ seatRef: sessionName, dir: path.join(userHome, ".claude-gone"), reason: "not made yet" });
    if (!result.ok) throw new Error(result.message);
    expect(result.findings.join("\n")).toMatch(/not a directory/);
    expect(result.findings.filter((f) => f.includes("sets no model"))).toEqual([]);
  });

  it("reports, names only, what the home lacks for a full-bypass seat", async () => {
    const userHome = scratch("ccd-user-");
    const cel = path.join(userHome, ".claude-cel");
    const read = { exists: fs.existsSync, isDirectory: (p: string) => fs.statSync(p).isDirectory(), readFile: (p: string) => fs.readFileSync(p, "utf8") };
    expect(claudeConfigDirFindings(cel, { fullBypass: true, nonInterruptive: false }, read).join("\n")).toMatch(/not a directory/);
    fs.mkdirSync(cel);
    const bare = claudeConfigDirFindings(cel, { fullBypass: true, nonInterruptive: false }, read);
    expect(bare.join("\n")).toMatch(/\.claude\.json is missing/);
    expect(bare.join("\n")).toMatch(/skipDangerousModePermissionPrompt/);
    expect(claudeConfigDirFindings(cel, { fullBypass: true, nonInterruptive: true }, read).join("\n")).not.toMatch(/skipDangerous/);
    fs.writeFileSync(path.join(cel, ".claude.json"), "{}");
    fs.writeFileSync(path.join(cel, "settings.json"), JSON.stringify({ skipDangerousModePermissionPrompt: true }));
    expect(claudeConfigDirFindings(cel, { fullBypass: true, nonInterruptive: false }, read)).toEqual([]);
  });
});

describe("a native fork across Claude homes is refused up front", () => {
  const has = (map: Record<string, string[]>) => (home: string, id: string) => (map[home] ?? []).includes(id);

  it("refuses only when the parent is in another known home and not in the seat's own", () => {
    expect(claudeForkHomeRefusal("p1", "/h/cel", ["/h/.claude", "/h/cel"], has({ "/h/cel": ["p1"] }))).toBeNull();
    expect(claudeForkHomeRefusal("p1", "/h/cel", ["/h/.claude", "/h/cel"], has({}))).toBeNull();
    expect(claudeForkHomeRefusal("p1", "/h/cel", ["/h/.claude", "/h/cel"], has({ "/h/.claude": ["p1"] })))
      .toMatch(/^fork_across_claude_homes: conversation p1 is in the Claude home \/h\/\.claude, not in this seat's Claude home \/h\/cel/);
  });

  it("the Claude adapter refuses the fork launch before typing anything", async () => {
    const root = scratch("ccd-fork-");
    const home = path.join(root, "home");
    const cel = path.join(root, "cel");
    fs.mkdirSync(path.join(home, ".claude", "projects", "-w"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude", "projects", "-w", "parent-1.jsonl"), "{}\n");
    fs.mkdirSync(cel);
    const db = createFullTestDb(); cleanup.push(() => db.close());
    const rigRepo = new RigRepository(db);
    const node = rigRepo.addNode(rigRepo.createRig("r").id, "dev.cel", { runtime: "claude-code", cwd: root, claudeConfigDir: cel });
    const typed: string[] = [];
    const tmux = partial<TmuxAdapter>({ sendShellCommand: async (_s: string, cmd: string) => { typed.push(cmd); return { ok: true as const }; } });
    const fsOps: ClaudeAdapterFsOps = { homedir: home, exists: fs.existsSync, mkdirp: () => {}, readFile: p => fs.readFileSync(p, "utf8"), writeFile: () => {}, copyFile: () => {}, readdir: p => fs.readdirSync(p) };
    const saved = process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
    try {
      const adapter = new ClaudeCodeAdapter({ tmux, fsOps, claudeManagedLaunch: new ClaudeManagedLaunch(db, { HOME: home, PATH: "/usr/bin" }, {}, () => []) });
      const binding = { id: "b", nodeId: node.id, cwd: root, tmuxSession: "dev-cel@r", tmuxPane: "%1" } as NodeBinding;
      const result = await adapter.launchHarness(binding, { name: "dev-cel@r", forkSource: { kind: "native_id", value: "parent-1" } });
      expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/^fork_across_claude_homes:/) });
      expect(typed).toHaveLength(0);
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved;
    }
  });
});
