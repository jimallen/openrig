// workspaces-o9o.30: a fresh launch that replays saved startup files (`--startup-from stored`, `snapshot:<id>`) never
// reconciles skills (OF-32 N6: the stored context carries none), so after a spec narrows or changes a seat's plugin
// skills the seat keeps its old set with no word about it. The launch now compares the seat's OWN recorded topology
// selection (its owner row in the skill ownership manifest) with what the spec selects now, read without writing,
// warns when they differ, records `seat.skills_drift_observed`, and `rig seat status` shows it until a later fresh
// launch of the seat replaces it.
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
import { FIXTURE_SPEC_SOURCE_TRUST } from "./helpers/spec-source-trust.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import { SeatStatusService } from "../src/domain/seat-status-service.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { RigTeardownOrchestrator } from "../src/domain/rig-teardown.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { reconcileSkillLoadout, resolveSkillLoadout } from "../src/domain/skill-catalog.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";
import { guardedAgentRefFsOps } from "../src/domain/agent-ref-guard.js";

const RIG = (runtime: string) => `version: "0.2"
name: team
pods:
  - id: dev
    label: Dev
    members:
      - id: impl
        agent_ref: "local:agents/impl"
        profile: default
        runtime: ${runtime}
        cwd: .
    edges: []
edges: []
`;
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

function writeRelease(dir: string, runtime: string, version: string, skills: Record<string, string>) {
  const agent = path.join(dir, "agents", "impl");
  fs.mkdirSync(path.join(agent, "guidance"), { recursive: true });
  fs.writeFileSync(path.join(dir, "rig.yaml"), RIG(runtime));
  fs.writeFileSync(path.join(agent, "agent.yaml"), AGENT(version));
  fs.writeFileSync(path.join(agent, "guidance", "role.md"), `# role ${version}\n`);
  const plugin = path.join(agent, "plugins", "core");
  const manifestDir = runtime === "codex" ? ".codex-plugin" : ".claude-plugin";
  fs.mkdirSync(path.join(plugin, manifestDir), { recursive: true });
  fs.writeFileSync(path.join(plugin, manifestDir, "plugin.json"), JSON.stringify({ name: "core", version }));
  for (const [id, body] of Object.entries(skills)) {
    fs.mkdirSync(path.join(plugin, "skills", id), { recursive: true });
    fs.writeFileSync(path.join(plugin, "skills", id, "SKILL.md"), SKILL(id, body));
  }
}

/** Every file under `dir` as path -> bytes, for "nothing was written" pins. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      const st = fs.lstatSync(p);
      if (st.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = st.isSymbolicLink() ? `link:${fs.readlinkSync(p)}` : fs.readFileSync(p, "utf-8");
    }
  };
  walk(dir);
  return out;
}

describe.each([["claude-code", ".claude"], ["codex", ".agents"]] as const)("workspaces-o9o.30: skill drift after a launch that replays saved startup files (%s)", (runtime, homeDir) => {
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
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "o9o30-")));
    // A: alpha and gamma. B: alpha and beta (gamma dropped, beta added).
    writeRelease(path.join(root, "releases", "aaaaaaa", "rigs", "team"), runtime, "1.0.0", { alpha: "alpha A", gamma: "gamma A" });
    writeRelease(path.join(root, "releases", "bbbbbbb", "rigs", "team"), runtime, "2.0.0", { alpha: "alpha A", beta: "beta B" });
    current = path.join(root, "releases", "current");
    fs.symlinkSync(path.join(root, "releases", "aaaaaaa"), current);
    fs.mkdirSync(path.join(root, "library"));
    fs.symlinkSync(path.join(current, "rigs", "team"), path.join(root, "library", "team"));
    linkSpec = path.join(root, "library", "team", "rig.yaml");
    workdir = path.join(root, "work");
    fs.mkdirSync(workdir);
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
      getPaneCommand: vi.fn(async () => runtime === "codex" ? "codex" : "claude"),
      capturePaneContent: vi.fn(async () => ""),
      sendText: vi.fn(async () => ({ ok: true as const })),
      sendKeys: vi.fn(async () => ({ ok: true as const })),
      setSessionOption: vi.fn(async () => ({ ok: true as const })),
    } as never;
    adapter = {
      runtime,
      listInstalled: async () => [],
      project: async () => ({ projected: [], skipped: [], failed: [] }),
      deliverStartup: async (files) => ({ delivered: files.length, failed: [] }),
      launchHarness: async () => ({ ok: true, resumeToken: "native-uuid", resumeType: runtime === "codex" ? "codex_id" : "claude_session_id" }),
      checkReady: async () => ({ ready: true }),
    };
    // A codex pane is identified by its native process (seat-attention-reconciler), as in seat-fresh-launch.test.ts.
    const listProcesses = async () => runtime === "codex"
      ? [{ pid: 4242, ppid: 1, pgid: 4242, tpgid: 4242, executableName: "codex", command: "/opt/native/codex -m model", startedAt: "Sat Jan  1 12:00:00 2000" }]
      : [];
    reconciler = vi.fn(reconcileSkillLoadout);
    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    const startupOrchestrator = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux, sleep: async () => undefined });
    inst = new PodRigInstantiator({
      specSourceTrust: FIXTURE_SPEC_SOURCE_TRUST,
      db, rigRepo, podRepo: new PodRepository(db), sessionRegistry, eventBus, nodeLauncher, startupOrchestrator,
      fsOps: { ...guardedAgentRefFsOps, readFile: (p: string) => fs.readFileSync(p, "utf-8"), exists: (p: string) => fs.existsSync(p) },
      adapters: { [runtime]: adapter },
      tmuxAdapter: tmux,
      onboardingEnabledResolver: () => false,
      skillsRootResolver: () => catalog,
      skillReconciler: reconciler,
    } as never);
    service = new SeatLifecycleService({
      db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux, nodeLauncher, startupOrchestrator,
      runtimeAdapters: { [runtime]: adapter },
      listProcesses,
      seatStartupSource: inst,
    } as never);
    restore = new RestoreOrchestrator({
      db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture, checkpointStore, nodeLauncher, tmuxAdapter: tmux,
      claudeResume: { canResume: () => false, resume: vi.fn() } as never,
      codexResume: { canResume: () => false, resume: vi.fn() } as never,
      listProcesses,
      seatStartupSource: inst,
    } as never);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const SESSION = "dev-impl@team";
  const FIX = `rig seat launch 'dev.impl@team' --fresh --stop --reason "<why>"`;
  const skillsDir = () => path.join(workdir, homeDir, "skills");
  const onDisk = () => (fs.existsSync(skillsDir()) ? fs.readdirSync(skillsDir()) : []).sort();
  const retarget = (sha: string) => { fs.unlinkSync(current); fs.symlinkSync(path.join(root, "releases", sha), current); };
  const driftEvents = () => (db.prepare("SELECT payload FROM events WHERE type = 'seat.skills_drift_observed' ORDER BY seq").all() as Array<{ payload: string }>)
    .map((row) => JSON.parse(row.payload) as Record<string, unknown>);
  const status = () => {
    const result = new SeatStatusService({ rigRepo }).getStatus(SESSION);
    if (!result.ok) throw new Error(JSON.stringify(result));
    return result.status;
  };
  const appliedReconciles = () => reconciler.mock.calls.filter(([input]) => input.apply === true).length;

  async function launchRig() {
    const realSpec = fs.realpathSync(linkSpec);
    const outcome = await inst.instantiate(fs.readFileSync(realSpec, "utf-8"), path.dirname(realSpec), { cwdOverride: workdir, specSourcePath: linkSpec });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) throw new Error("launch failed");
    const node = rigRepo.getRig(outcome.result.rigId)!.nodes[0]!;
    expect(onDisk()).toEqual(["alpha", "gamma"]);
    expect(appliedReconciles()).toBe(1);
    return { rigId: outcome.result.rigId, nodeId: node.id };
  }
  const freshLaunch = (startupFrom?: string) => service.launchFresh({ seatRef: SESSION, fresh: true, stop: true, reason: "drift", ...(startupFrom ? { startupFrom } : {}) } as never);
  const driftWarning = (warnings: string[] | undefined) => (warnings ?? []).filter((w) => w.startsWith("skills_drift:"));

  it("RED row 1: --startup-from stored after the spec narrows warns, names the skills and the fix", async () => {
    await launchRig();
    retarget("bbbbbbb");

    const result = await freshLaunch("stored");

    expect(result.ok, JSON.stringify(result)).toBe(true);
    const warnings = result.ok ? result.warnings : undefined;
    expect(driftWarning(warnings)).toHaveLength(1);
    const [warning] = driftWarning(warnings);
    expect(warning).toContain("no longer in the spec: gamma");
    expect(warning).toContain("in the spec but not projected: beta");
    expect(warning).toContain(linkSpec);
    expect(warning).toContain(FIX);
  });

  it("RED row 2: the drift is recorded as seat.skills_drift_observed and rig seat status shows it", async () => {
    const seat = await launchRig();
    retarget("bbbbbbb");

    const result = await freshLaunch("stored");

    expect(result.ok, JSON.stringify(result)).toBe(true);
    const events = driftEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "seat.skills_drift_observed", rigId: seat.rigId, nodeId: seat.nodeId, logicalId: "dev.impl", sessionName: SESSION, specSource: linkSpec, startupSource: "stored", extra: ["gamma"], missing: ["beta"] });
    expect(status().skills_drift).toMatchObject({ extra: ["gamma"], missing: ["beta"], specSource: linkSpec, startupSource: "stored", fix: FIX });
  });

  it("RED row 3 (read-only pin): the spec read on a stored launch writes nothing: no apply, no manifest, no projection", async () => {
    await launchRig();
    retarget("bbbbbbb");
    const before = tree(workdir);
    const projected = vi.spyOn(inst, "projectSeatSkills");

    const result = await freshLaunch("stored");

    expect(result.ok, JSON.stringify(result)).toBe(true);
    // The spec WAS read (positive control: otherwise there is nothing to compare and the pin is vacuous)...
    expect(reconciler.mock.calls.slice(1).map(([input]) => input.apply)).toEqual([false]);
    // ...and nothing was written from it.
    expect(projected).not.toHaveBeenCalled();
    expect(appliedReconciles()).toBe(1);
    expect(tree(workdir)).toEqual(before);
    expect(onDisk()).toEqual(["alpha", "gamma"]);
  });

  it("RED row 4: --startup-from snapshot:<id> is the same rule at a second site", async () => {
    const seat = await launchRig();
    const snapshotId = snapshotCapture.captureSnapshot(seat.rigId, "manual").id;
    retarget("bbbbbbb");
    const before = tree(workdir);

    const result = await freshLaunch(`snapshot:${snapshotId}`);

    expect(result.ok, JSON.stringify(result)).toBe(true);
    const [warning] = driftWarning(result.ok ? result.warnings : undefined);
    expect(warning).toContain("no longer in the spec: gamma");
    expect(warning).toContain(FIX);
    expect(driftEvents()).toHaveLength(1);
    expect(driftEvents()[0]).toMatchObject({ startupSource: "snapshot", snapshotId, extra: ["gamma"], missing: ["beta"] });
    expect(status().skills_drift).toMatchObject({ startupSource: "snapshot", extra: ["gamma"] });
    expect(tree(workdir)).toEqual(before);
  });

  it("RED row 5: rig up --existing --fresh <seat> --startup-from stored warns and records the drift", async () => {
    const seat = await launchRig();
    const down = await new RigTeardownOrchestrator({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux, snapshotCapture, eventBus: new EventBus(db) }).teardown(seat.rigId);
    expect(down.snapshotId, JSON.stringify(down)).toBeTruthy();
    retarget("bbbbbbb");
    const before = tree(workdir);

    const outcome = await restore.restore(down.snapshotId!, {
      adapters: { [runtime]: adapter }, fsOps: { exists: (p: string) => fs.existsSync(p) }, freshLogicalIds: ["dev.impl"], startupFrom: "stored",
    } as never);

    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    const node = outcome.ok ? outcome.result.nodes.find((n) => n.logicalId === "dev.impl") : undefined;
    expect(node?.status, JSON.stringify(node)).toBe("fresh-primed");
    const warnings = outcome.ok ? outcome.result.warnings ?? [] : [];
    expect(warnings.filter((w) => w.includes("skills_drift:")), JSON.stringify(warnings)).toHaveLength(1);
    expect(driftEvents()).toHaveLength(1);
    expect(driftEvents()[0]).toMatchObject({ nodeId: seat.nodeId, startupSource: "stored", extra: ["gamma"], missing: ["beta"] });
    expect(status().skills_drift).toMatchObject({ extra: ["gamma"], missing: ["beta"] });
    expect(tree(workdir)).toEqual(before);
  });

  it("no drift: a stored launch whose spec still selects the same skills says nothing and records nothing", async () => {
    await launchRig();

    const result = await freshLaunch("stored");

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(driftWarning(result.ok ? result.warnings : undefined)).toEqual([]);
    expect(driftEvents()).toEqual([]);
    expect(status().skills_drift).toBeNull();
  });

  it("a later fresh launch from the spec clears the flag; a stored launch that drifts again raises it again", async () => {
    await launchRig();
    retarget("bbbbbbb");
    expect((await freshLaunch("stored")).ok).toBe(true);
    expect(status().skills_drift).not.toBeNull();

    const fromSpec = await freshLaunch();
    expect(fromSpec.ok, JSON.stringify(fromSpec)).toBe(true);
    expect(onDisk()).toEqual(["alpha", "beta"]);
    expect(status().skills_drift).toBeNull();

    retarget("aaaaaaa");
    expect((await freshLaunch("stored")).ok).toBe(true);
    expect(status().skills_drift).toMatchObject({ extra: ["beta"], missing: ["gamma"] });
    // Two drifts, and between them the spec launch's empty observation that cleared the first.
    expect(driftEvents().map((e) => [e["startupSource"], e["extra"], e["missing"]])).toEqual([
      ["stored", ["gamma"], ["beta"]], ["spec", [], []], ["stored", ["beta"], ["gamma"]],
    ]);
  });

  it("a stored launch that finds the skills in line again clears a shown drift", async () => {
    await launchRig();
    retarget("bbbbbbb");
    expect((await freshLaunch("stored")).ok).toBe(true);
    expect(status().skills_drift).not.toBeNull();

    retarget("aaaaaaa");
    const result = await freshLaunch("stored");

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(driftWarning(result.ok ? result.warnings : undefined)).toEqual([]);
    expect(status().skills_drift).toBeNull();
    expect(driftEvents().at(-1)).toMatchObject({ startupSource: "stored", extra: [], missing: [] });
    expect(driftEvents().at(-1)).not.toHaveProperty("fix");
  });

  it("rig up --existing --fresh <seat> from the spec clears a shown drift; an in-line launch with no drift shown records nothing", async () => {
    const seat = await launchRig();
    expect((await freshLaunch("stored")).ok).toBe(true);
    expect(driftEvents()).toEqual([]);
    retarget("bbbbbbb");
    expect((await freshLaunch("stored")).ok).toBe(true);
    expect(status().skills_drift).not.toBeNull();
    const down = await new RigTeardownOrchestrator({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux, snapshotCapture, eventBus: new EventBus(db) }).teardown(seat.rigId);

    const outcome = await restore.restore(down.snapshotId!, {
      adapters: { [runtime]: adapter }, fsOps: { exists: (p: string) => fs.existsSync(p) }, freshLogicalIds: ["dev.impl"],
    } as never);

    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(onDisk()).toEqual(["alpha", "beta"]);
    expect(status().skills_drift).toBeNull();
    expect(driftEvents().map((e) => [e["startupSource"], e["extra"], e["missing"]])).toEqual([
      ["stored", ["gamma"], ["beta"]], ["spec", [], []],
    ]);
  });

  it("a spec the stored launch cannot read leaves the launch as it was and says the drift was not checked", async () => {
    await launchRig();
    // An operator edit to a work-installed skill refuses a re-read (the stored files are the named escape).
    const workLoadout = resolveSkillLoadout({ catalogRoot: catalog, systemSkills: [], projectRoot: workdir, projectSkills: ["work-skill"] });
    if (!workLoadout.ok) throw new Error("work loadout");
    expect(reconcileSkillLoadout({ loadout: workLoadout.loadout, runtime, cwd: workdir, apply: true }).ok).toBe(true);
    fs.writeFileSync(path.join(skillsDir(), "work-skill", "SKILL.md"), SKILL("work-skill", "operator edit"));
    retarget("bbbbbbb");
    const before = tree(workdir);

    const result = await freshLaunch("stored");

    expect(result.ok, JSON.stringify(result)).toBe(true);
    const warnings = result.ok ? result.warnings ?? [] : [];
    const notChecked = warnings.filter((w) => w.startsWith("skills_drift_unchecked:"));
    expect(notChecked, JSON.stringify(warnings)).toHaveLength(1);
    expect(notChecked[0]).toContain("work-skill");
    expect(driftEvents()).toEqual([]);
    expect(tree(workdir)).toEqual(before);
  });

  it("--plan of a stored launch shows the drift and records nothing", async () => {
    await launchRig();
    retarget("bbbbbbb");

    const plan = await service.planFresh({ seatRef: SESSION, fresh: true, stop: true, startupFrom: "stored" } as never);

    expect(plan.ok, JSON.stringify(plan)).toBe(true);
    const warnings = plan.ok ? plan.warnings : undefined;
    expect(driftWarning(warnings)).toHaveLength(1);
    expect(driftEvents()).toEqual([]);
  });
});

// verify-qa nit (o9o.30 review): a restore of SEVERAL seats records each seat's own drift, and each stays shown after
// restore.completed. Two seats share one folder (cwdOverride), so this also proves the comparison is per owner: each
// seat's drift names only its own skills, never the other seat's.
describe("workspaces-o9o.30: a multi-seat restore records and keeps each seat's own drift", () => {
  const TWO_SEATS = `version: "0.2"
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
      - id: qa
        agent_ref: "local:agents/qa"
        profile: default
        runtime: claude-code
        cwd: .
    edges: []
edges: []
`;
  const writeAgent = (dir: string, id: string, version: string, skills: Record<string, string>) => {
    const agent = path.join(dir, "agents", id);
    fs.mkdirSync(path.join(agent, "guidance"), { recursive: true });
    fs.writeFileSync(path.join(agent, "agent.yaml"), AGENT(version).replace("name: impl", `name: ${id}`));
    fs.writeFileSync(path.join(agent, "guidance", "role.md"), `# ${id} ${version}\n`);
    const plugin = path.join(agent, "plugins", "core");
    fs.mkdirSync(path.join(plugin, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "core", version }));
    for (const [skill, body] of Object.entries(skills)) {
      fs.mkdirSync(path.join(plugin, "skills", skill), { recursive: true });
      fs.writeFileSync(path.join(plugin, "skills", skill, "SKILL.md"), SKILL(skill, body));
    }
  };

  let root: string;
  let db: Database.Database;
  afterEach(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

  it("rig up --existing --fresh impl,qa --startup-from stored: two drift events, one per seat, both shown after restore.completed", async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "o9o30-multi-")));
    // A: impl {alpha, gamma}, qa {delta}. B: impl {alpha, beta}, qa {delta, epsilon}.
    for (const [sha, impl, qa] of [["aaaaaaa", { alpha: "a", gamma: "g" }, { delta: "d" }], ["bbbbbbb", { alpha: "a", beta: "b" }, { delta: "d", epsilon: "e" }]] as const) {
      const dir = path.join(root, "releases", sha, "rigs", "team");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "rig.yaml"), TWO_SEATS);
      writeAgent(dir, "impl", sha === "aaaaaaa" ? "1.0.0" : "2.0.0", impl);
      writeAgent(dir, "qa", sha === "aaaaaaa" ? "1.0.0" : "2.0.0", qa);
    }
    const current = path.join(root, "releases", "current");
    fs.symlinkSync(path.join(root, "releases", "aaaaaaa"), current);
    fs.mkdirSync(path.join(root, "library"));
    fs.symlinkSync(path.join(current, "rigs", "team"), path.join(root, "library", "team"));
    const linkSpec = path.join(root, "library", "team", "rig.yaml");
    const workdir = path.join(root, "work");
    fs.mkdirSync(workdir);
    const catalog = path.join(root, "catalog");
    fs.mkdirSync(catalog);
    fs.writeFileSync(path.join(catalog, "catalog.yaml"), "schema: openrig.skill-catalog/v1\nsystem: []\n");
    execFileSync("git", ["init", "-q", catalog]);
    execFileSync("git", ["-C", catalog, "add", "."]);
    execFileSync("git", ["-C", catalog, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "catalog"]);

    db = createFullTestDb();
    const rigRepo = new RigRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    const snapshotRepo = new SnapshotRepository(db);
    const checkpointStore = new CheckpointStore(db);
    const snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });
    const alive = new Set<string>();
    const tmux = {
      createSession: vi.fn(async (name: string) => { if (alive.has(name)) return { ok: false as const, code: "duplicate_session", message: "duplicate" }; alive.add(name); return { ok: true as const }; }),
      killSession: vi.fn(async (name: string): Promise<TmuxResult> => { alive.delete(name); return { ok: true }; }),
      probeSession: vi.fn(async (name: string) => alive.has(name) ? { state: "present" as const } : { state: "absent" as const }),
      hasSession: vi.fn(async (name: string) => alive.has(name)),
      startServer: vi.fn(async (): Promise<TmuxResult> => ({ ok: true })),
      listSessions: vi.fn(async () => [...alive].map((name) => ({ name, windows: 1, created: "", attached: false }))),
      listWindows: vi.fn(async () => []),
      listPanes: vi.fn(async (name: string) => alive.has(name) ? [{ id: `%${name}`, index: 0, cwd: workdir, width: 80, height: 24, active: true }] : []),
      getPanePid: vi.fn(async () => 4242),
      getPaneCommand: vi.fn(async () => "claude"),
      capturePaneContent: vi.fn(async () => ""),
      sendText: vi.fn(async () => ({ ok: true as const })),
      sendKeys: vi.fn(async () => ({ ok: true as const })),
      setSessionOption: vi.fn(async () => ({ ok: true as const })),
    } as never;
    const adapter: RuntimeAdapter = {
      runtime: "claude-code",
      listInstalled: async () => [],
      project: async () => ({ projected: [], skipped: [], failed: [] }),
      deliverStartup: async (files) => ({ delivered: files.length, failed: [] }),
      launchHarness: async () => ({ ok: true, resumeToken: "native-uuid", resumeType: "claude_session_id" }),
      checkReady: async () => ({ ready: true }),
    };
    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    const startupOrchestrator = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux, sleep: async () => undefined });
    const inst = new PodRigInstantiator({
      specSourceTrust: FIXTURE_SPEC_SOURCE_TRUST,
      db, rigRepo, podRepo: new PodRepository(db), sessionRegistry, eventBus, nodeLauncher, startupOrchestrator,
      fsOps: { ...guardedAgentRefFsOps, readFile: (p: string) => fs.readFileSync(p, "utf-8"), exists: (p: string) => fs.existsSync(p) },
      adapters: { "claude-code": adapter },
      tmuxAdapter: tmux,
      onboardingEnabledResolver: () => false,
      skillsRootResolver: () => catalog,
      skillReconciler: reconcileSkillLoadout,
    } as never);
    const restore = new RestoreOrchestrator({
      db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture, checkpointStore, nodeLauncher, tmuxAdapter: tmux,
      claudeResume: { canResume: () => false, resume: vi.fn() } as never,
      codexResume: { canResume: () => false, resume: vi.fn() } as never,
      listProcesses: async () => [],
      seatStartupSource: inst,
    } as never);

    const realSpec = fs.realpathSync(linkSpec);
    const launched = await inst.instantiate(fs.readFileSync(realSpec, "utf-8"), path.dirname(realSpec), { cwdOverride: workdir, specSourcePath: linkSpec });
    expect(launched.ok, JSON.stringify(launched)).toBe(true);
    if (!launched.ok) return;
    const rigId = launched.result.rigId;
    const nodeOf = (logicalId: string) => rigRepo.getRig(rigId)!.nodes.find((n) => n.logicalId === logicalId)!.id;
    const nodes = { impl: nodeOf("dev.impl"), qa: nodeOf("dev.qa") };
    const down = await new RigTeardownOrchestrator({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux, snapshotCapture, eventBus: new EventBus(db) }).teardown(rigId);
    expect(down.snapshotId, JSON.stringify(down)).toBeTruthy();
    fs.unlinkSync(current);
    fs.symlinkSync(path.join(root, "releases", "bbbbbbb"), current);

    const outcome = await restore.restore(down.snapshotId!, {
      adapters: { "claude-code": adapter }, fsOps: { exists: (p: string) => fs.existsSync(p) }, freshLogicalIds: ["dev.impl", "dev.qa"], startupFrom: "stored",
    } as never);

    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    const rows = db.prepare("SELECT seq, type, payload FROM events WHERE type IN ('seat.skills_drift_observed', 'restore.completed') ORDER BY seq").all() as Array<{ seq: number; type: string; payload: string }>;
    const drifts = rows.filter((r) => r.type === "seat.skills_drift_observed").map((r) => JSON.parse(r.payload) as Record<string, unknown>);
    expect(drifts.map((d) => [d["logicalId"], d["nodeId"], d["extra"], d["missing"]]).sort()).toEqual([
      ["dev.impl", nodes.impl, ["gamma"], ["beta"]],
      ["dev.qa", nodes.qa, [], ["epsilon"]],
    ]);
    // restore.completed lands after both drift events, and neither seat's drift is lost to it.
    const completedSeq = rows.filter((r) => r.type === "restore.completed").at(-1)!.seq;
    expect(rows.filter((r) => r.type === "seat.skills_drift_observed").every((r) => r.seq < completedSeq)).toBe(true);
    const statusOf = (seat: string) => {
      const result = new SeatStatusService({ rigRepo }).getStatus(seat);
      if (!result.ok) throw new Error(JSON.stringify(result));
      return result.status.skills_drift;
    };
    expect(statusOf("dev-impl@team")).toMatchObject({ extra: ["gamma"], missing: ["beta"], startupSource: "stored" });
    expect(statusOf("dev-qa@team")).toMatchObject({ extra: [], missing: ["epsilon"], startupSource: "stored" });
  });
});
