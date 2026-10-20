// OF-32 N6: a fresh seat that re-reads its spec (`rig seat launch --fresh`, `rig up --existing --fresh <seat>`) gets
// the re-read release's managed skills, as its first launch got the first release's. Before this, the re-read paths
// delivered the new release's role and startup files but never ran the S04 skill reconciler, so a release that added or
// changed a skill was delivered only in part, with no warning, and a seat whose cwd lost a skill folder was not repaired.
// A seat that replays its stored context (`--startup-from stored`, a seat not listed with --fresh, an exact resume)
// keeps the stored behaviour: no reconcile.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import { PodRigInstantiator } from "../src/domain/rigspec-instantiator.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { RigTeardownOrchestrator } from "../src/domain/rig-teardown.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { reconcileSkillLoadout, resolveSkillLoadout } from "../src/domain/skill-catalog.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";
import { guardedAgentRefFsOps } from "../src/domain/agent-ref-guard.js";

const RIG = `version: "0.2"
name: team
pods:
  - id: dev
    label: Dev
    members:
      - id: impl
        agent_ref: "local:agents/impl"
        profile: default
        runtime: claude-code
        cwd: .
    edges: []
edges: []
`;
// The persona shape Jim's releases use: no topology skills of its own, its skills arrive through a selected plugin.
const AGENT = (version: string) => `name: impl
version: "${version}"
resources:
  plugins:
    - id: core
      source:
        kind: local
        path: plugins/core
profiles:
  default:
    uses:
      plugins: [core]
startup:
  files:
    - path: guidance/role.md
      delivery_hint: guidance_merge
      required: true
  actions: []
`;
const SKILL = (id: string, body: string) => `---\nname: ${id}\ndescription: Skill fixture\n---\n${body}\n`;

/** One release: rig.yaml, the agent with its role file, and its plugin's skills (id -> body). */
function writeRelease(dir: string, version: string, skills: Record<string, string>) {
  const agent = path.join(dir, "agents", "impl");
  fs.mkdirSync(path.join(agent, "guidance"), { recursive: true });
  fs.writeFileSync(path.join(dir, "rig.yaml"), RIG);
  fs.writeFileSync(path.join(agent, "agent.yaml"), AGENT(version));
  fs.writeFileSync(path.join(agent, "guidance", "role.md"), `# role ${version}\n`);
  const plugin = path.join(agent, "plugins", "core");
  fs.mkdirSync(path.join(plugin, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(path.join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "core", version }));
  for (const [id, body] of Object.entries(skills)) {
    fs.mkdirSync(path.join(plugin, "skills", id), { recursive: true });
    fs.writeFileSync(path.join(plugin, "skills", id, "SKILL.md"), SKILL(id, body));
  }
}

describe("OF-32 N6: a seat that re-reads its spec reconciles the re-read release's skills", () => {
  let root: string;
  let current: string;
  let linkSpec: string;
  let workdir: string;
  let catalog: string;
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let snapshotCapture: SnapshotCapture;
  let alive: Set<string>;
  let tmux: TmuxAdapter;
  let adapter: RuntimeAdapter;
  let reconciler: ReturnType<typeof vi.fn<typeof reconcileSkillLoadout>>;
  let inst: PodRigInstantiator;
  let service: SeatLifecycleService;
  let restore: RestoreOrchestrator;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "of32-n6-")));
    // A: alpha and gamma. B: alpha changed, beta added, gamma dropped.
    writeRelease(path.join(root, "releases", "aaaaaaa", "rigs", "team"), "1.0.0", { alpha: "alpha A", gamma: "gamma A" });
    writeRelease(path.join(root, "releases", "bbbbbbb", "rigs", "team"), "2.0.0", { alpha: "alpha B", beta: "beta B" });
    current = path.join(root, "releases", "current");
    fs.symlinkSync(path.join(root, "releases", "aaaaaaa"), current);
    fs.mkdirSync(path.join(root, "library"));
    fs.symlinkSync(path.join(current, "rigs", "team"), path.join(root, "library", "team"));
    linkSpec = path.join(root, "library", "team", "rig.yaml");
    workdir = path.join(root, "work");
    fs.mkdirSync(workdir);
    // A managed catalog that selects nothing at system level; the work-install row selects from it at project level.
    catalog = path.join(root, "catalog");
    fs.mkdirSync(path.join(catalog, "work-skill"), { recursive: true });
    fs.writeFileSync(path.join(catalog, "catalog.yaml"), "schema: openrig.skill-catalog/v1\nsystem: []\n");
    fs.writeFileSync(path.join(catalog, "work-skill", "SKILL.md"), SKILL("work-skill", "work"));
    execFileSync("git", ["init", "-q", catalog]);
    execFileSync("git", ["-C", catalog, "add", "."]);
    execFileSync("git", ["-C", catalog, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "catalog"]);

    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    const snapshotRepo = new SnapshotRepository(db);
    const checkpointStore = new CheckpointStore(db);
    snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });
    alive = new Set();
    const panes = new Map<string, string>();
    tmux = {
      createSession: vi.fn(async (name: string) => {
        if (alive.has(name)) return { ok: false as const, code: "duplicate_session", message: "duplicate" };
        alive.add(name);
        panes.set(name, "%fresh");
        return { ok: true as const };
      }),
      killSession: vi.fn(async (name: string): Promise<TmuxResult> => { alive.delete(name); panes.delete(name); return { ok: true }; }),
      probeSession: vi.fn(async (name: string) => alive.has(name) ? { state: "present" as const } : { state: "absent" as const }),
      hasSession: vi.fn(async (name: string) => alive.has(name)),
      startServer: vi.fn(async (): Promise<TmuxResult> => ({ ok: true })),
      listSessions: vi.fn(async () => [...alive].map((name) => ({ name, windows: 1, created: "", attached: false }))),
      listWindows: vi.fn(async () => []),
      listPanes: vi.fn(async (name: string) => {
        const pane = alive.has(name) ? panes.get(name) : undefined;
        return pane ? [{ id: pane, index: 0, cwd: workdir, width: 80, height: 24, active: true }] : [];
      }),
      getPanePid: vi.fn(async () => 4242),
      getPaneCommand: vi.fn(async () => "claude"),
      capturePaneContent: vi.fn(async () => ""),
      sendText: vi.fn(async () => ({ ok: true as const })),
      sendKeys: vi.fn(async () => ({ ok: true as const })),
      setSessionOption: vi.fn(async () => ({ ok: true as const })),
    } as unknown as TmuxAdapter;
    adapter = {
      runtime: "claude-code",
      listInstalled: async () => [],
      project: async () => ({ projected: [], skipped: [], failed: [] }),
      deliverStartup: async (files) => ({ delivered: files.length, failed: [] }),
      launchHarness: async () => ({ ok: true, resumeToken: "native-uuid", resumeType: "claude_session_id" }),
      checkReady: async () => ({ ready: true }),
    };
    reconciler = vi.fn(reconcileSkillLoadout);
    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    const startupOrchestrator = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux, sleep: async () => undefined });
    inst = new PodRigInstantiator({
      db, rigRepo, podRepo: new PodRepository(db), sessionRegistry, eventBus, nodeLauncher, startupOrchestrator,
      fsOps: { ...guardedAgentRefFsOps, readFile: (p: string) => fs.readFileSync(p, "utf-8"), exists: (p: string) => fs.existsSync(p) },
      adapters: { "claude-code": adapter },
      tmuxAdapter: tmux,
      onboardingEnabledResolver: () => false,
      skillsRootResolver: () => catalog,
      skillReconciler: reconciler,
    } as never);
    service = new SeatLifecycleService({
      db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux, nodeLauncher, startupOrchestrator,
      runtimeAdapters: { "claude-code": adapter },
      listProcesses: async () => [],
      seatStartupSource: inst,
    } as never);
    restore = new RestoreOrchestrator({
      db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture, checkpointStore, nodeLauncher, tmuxAdapter: tmux,
      claudeResume: { canResume: () => false, resume: vi.fn() } as never,
      codexResume: { canResume: () => false, resume: vi.fn() } as never,
      listProcesses: async () => [],
      seatStartupSource: inst,
    } as never);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const SESSION = "dev-impl@team";
  const skillsDir = () => path.join(workdir, ".claude", "skills");
  /** The seat's projected skills as `id:body`, read from its cwd: what the next harness actually sees. */
  const onDisk = () => (fs.existsSync(skillsDir()) ? fs.readdirSync(skillsDir()) : [])
    .filter((id) => fs.existsSync(path.join(skillsDir(), id, "SKILL.md")))
    .map((id) => `${id}:${fs.readFileSync(path.join(skillsDir(), id, "SKILL.md"), "utf-8").trim().split("\n").at(-1)}`)
    .sort();
  const manifest = () => JSON.parse(fs.readFileSync(reconciler.mock.results.at(-1)!.value.manifestPath, "utf-8")) as {
    topologySelections: Record<string, string[]>; projectSelection: string[]; skills: Array<{ id: string }>;
  };
  const retarget = (sha: string) => { fs.unlinkSync(current); fs.symlinkSync(path.join(root, "releases", sha), current); };

  async function launchRig() {
    const realSpec = fs.realpathSync(linkSpec);
    const outcome = await inst.instantiate(fs.readFileSync(realSpec, "utf-8"), path.dirname(realSpec), { cwdOverride: workdir, specSourcePath: linkSpec });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) throw new Error("launch failed");
    const node = rigRepo.getRig(outcome.result.rigId)!.nodes[0]!;
    // First launch projected release A's plugin skills; every row starts from here.
    expect(onDisk()).toEqual(["alpha:alpha A", "gamma:gamma A"]);
    expect(reconciler).toHaveBeenCalledTimes(1);
    return { rigId: outcome.result.rigId, nodeId: node.id };
  }
  const down = async (rigId: string) => {
    const result = await new RigTeardownOrchestrator({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux, snapshotCapture, eventBus: new EventBus(db) }).teardown(rigId);
    expect(result.snapshotId, JSON.stringify(result)).toBeTruthy();
    return result.snapshotId!;
  };
  const restoreFrom = (snapshotId: string, fresh: boolean) => restore.restore(snapshotId, {
    adapters: { "claude-code": adapter },
    fsOps: { exists: (p: string) => fs.existsSync(p) },
    ...(fresh ? { freshLogicalIds: ["dev.impl"] } : {}),
  } as never);
  const freshLaunch = (startupFrom?: "stored") => service.launchFresh({ seatRef: SESSION, fresh: true, stop: true, reason: "release b", ...(startupFrom ? { startupFrom } : {}) });

  // Rows 1 and 2: a release that adds a skill (beta) and changes one (alpha). gamma, which release B no longer selects,
  // is removed: the reconciler removes an unmodified owned skill nothing selects any more, as it does on first launch.
  it("rig seat launch --fresh: a release that adds and changes a skill delivers both", async () => {
    await launchRig();
    retarget("bbbbbbb");

    const result = await freshLaunch();

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(onDisk()).toEqual(["alpha:alpha B", "beta:beta B"]);
    // One owner, the seat's canonical session, as at first launch: no second owner left holding release A's selection.
    expect(Object.keys(manifest().topologySelections)).toEqual([SESSION]);
    expect(manifest().topologySelections[SESSION]).toEqual(["alpha", "beta"]);
  });

  it("rig up --existing --fresh <seat>: a release that adds and changes a skill delivers both", async () => {
    const seat = await launchRig();
    const snapshotId = await down(seat.rigId);
    retarget("bbbbbbb");

    const outcome = await restoreFrom(snapshotId, true);

    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    const node = outcome.ok ? outcome.result.nodes.find((n) => n.logicalId === "dev.impl") : undefined;
    expect(node?.status, JSON.stringify(node)).toBe("fresh-primed");
    expect(onDisk()).toEqual(["alpha:alpha B", "beta:beta B"]);
  });

  // Row 3: the cwd lost a skill folder; the same release re-read puts it back.
  it("a re-read repairs a skill folder its cwd lost", async () => {
    await launchRig();
    fs.rmSync(path.join(skillsDir(), "alpha"), { recursive: true });
    expect(onDisk()).toEqual(["gamma:gamma A"]);

    const result = await freshLaunch();

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(onDisk()).toEqual(["alpha:alpha A", "gamma:gamma A"]);
  });

  // Row 4: a seat that replays its stored context keeps the stored behaviour: no reconcile, a lost folder stays lost and
  // the new release's skills do not arrive. Covers `--startup-from stored` and a restore seat not listed with --fresh.
  it("--startup-from stored does not reconcile", async () => {
    await launchRig();
    fs.rmSync(path.join(skillsDir(), "alpha"), { recursive: true });
    retarget("bbbbbbb");

    const result = await freshLaunch("stored");

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(reconciler).toHaveBeenCalledTimes(1);
    expect(onDisk()).toEqual(["gamma:gamma A"]);
  });

  it.each([["relaunch_fresh"], ["checkpoint_only"]])("a restore seat not listed with --fresh (policy %s) is unchanged", async (policy) => {
    const seat = await launchRig();
    db.prepare("UPDATE sessions SET restore_policy = ? WHERE node_id = ?").run(policy, seat.nodeId);
    const snapshotId = await down(seat.rigId);
    fs.rmSync(path.join(skillsDir(), "alpha"), { recursive: true });
    retarget("bbbbbbb");

    const outcome = await restoreFrom(snapshotId, false);

    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    const node = outcome.ok ? outcome.result.nodes.find((n) => n.logicalId === "dev.impl") : undefined;
    expect(node?.status, JSON.stringify(node)).toBe("fresh-primed");
    expect(node?.startupSource).toEqual({ kind: "stored", reason: "not_fresh_listed" });
    expect(reconciler).toHaveBeenCalledTimes(1);
    expect(onDisk()).toEqual(["gamma:gamma A"]);
  });

  // Row 5: a skill a work-install added stays. The seat's loadout declares no project selection (its cwd has no
  // project.yaml), so the reconciler keeps the installed one, exactly as on first launch.
  it("a re-read keeps a skill a work-install added", async () => {
    await launchRig();
    const workLoadout = resolveSkillLoadout({ catalogRoot: catalog, systemSkills: [], projectRoot: workdir, projectSkills: ["work-skill"] });
    expect(workLoadout.ok).toBe(true);
    if (!workLoadout.ok) return;
    expect(reconcileSkillLoadout({ loadout: workLoadout.loadout, runtime: "claude-code", cwd: workdir, apply: true }).ok).toBe(true);
    expect(onDisk()).toEqual(["alpha:alpha A", "gamma:gamma A", "work-skill:work"]);
    retarget("bbbbbbb");

    const result = await freshLaunch();

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(onDisk()).toEqual(["alpha:alpha B", "beta:beta B", "work-skill:work"]);
    expect(manifest().projectSelection).toEqual(["work-skill"]);
  });

  // Row 6: a skill the reconciler refuses to touch (an operator edit to a managed copy it owns) refuses the re-read
  // before the live occupant is stopped, as every other re-read failure does; `--startup-from stored` is the named
  // escape. (A plugin skill's edited copy is kept with a warning instead, so the edit here is to the work-installed one.)
  it("an operator-edited skill refuses the re-read before the live occupant is stopped", async () => {
    await launchRig();
    const workLoadout = resolveSkillLoadout({ catalogRoot: catalog, systemSkills: [], projectRoot: workdir, projectSkills: ["work-skill"] });
    if (!workLoadout.ok) throw new Error("work loadout");
    expect(reconcileSkillLoadout({ loadout: workLoadout.loadout, runtime: "claude-code", cwd: workdir, apply: true }).ok).toBe(true);
    fs.writeFileSync(path.join(skillsDir(), "work-skill", "SKILL.md"), SKILL("work-skill", "operator edit"));
    retarget("bbbbbbb");
    const killed = vi.mocked(tmux.killSession).mock.calls.length;

    const result = await freshLaunch();

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe("startup_source_unavailable");
    expect(!result.ok && result.message).toContain("work-skill");
    expect(!result.ok && "guidance" in result && result.guidance).toContain("--startup-from stored");
    expect(vi.mocked(tmux.killSession).mock.calls.length).toBe(killed);
    expect(alive.has(SESSION)).toBe(true);
    // Nothing moved: release A's skills and the operator's edit are as they were.
    expect(onDisk()).toEqual(["alpha:alpha A", "gamma:gamma A", "work-skill:operator edit"]);
  });

  // --plan is a snapshot: it checks the skills but writes nothing.
  it("rig seat launch --fresh --plan checks the skills without writing them", async () => {
    await launchRig();
    fs.rmSync(path.join(skillsDir(), "alpha"), { recursive: true });
    retarget("bbbbbbb");

    const plan = await service.planFresh({ seatRef: SESSION, fresh: true, stop: true });

    expect(plan.ok, JSON.stringify(plan)).toBe(true);
    expect(onDisk()).toEqual(["gamma:gamma A"]);
    expect(reconciler.mock.calls.slice(1).map(([input]) => input.apply)).toEqual([false]);
  });
});
