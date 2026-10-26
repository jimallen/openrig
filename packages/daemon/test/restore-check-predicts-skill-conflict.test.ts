// OF-32 N6 (integ N2): a seat listed with --fresh re-reads its spec and reconciles the re-read release's managed
// skills; restore refuses it when the reconciler finds an operator-edited skill it must not overwrite. Production
// consequence: `rig restore-check` or `rig up --existing --fresh <seat> --plan` says nothing is wrong, the operator runs
// the restore, and the seat is refused ("Fresh start refused: ... skill ..."), with nothing started. The check and the
// plan must say that refusal first, in restore's words, and must write nothing to the seat's skills to find it.
//
// Deployed entrypoint: startup.ts constructs RestoreOrchestrator (seatStartupSource: podInstantiator, whose reader
// does the skill reconcile in a read-only pass first) and server.ts mounts routes/restore-check.ts and routes/up.ts.
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
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { RigTeardownOrchestrator } from "../src/domain/rig-teardown.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { reconcileSkillLoadout, resolveSkillLoadout } from "../src/domain/skill-catalog.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";
import { createRestoreCheckService } from "../src/routes/restore-check.js";
import { buildRestorePlanPreview, collectPreviewSessionRows, predictedPlanRefusals } from "../src/domain/restore-plan-preview.js";
import { readFreshOccupantRelations } from "../src/domain/fresh-occupant-relation.js";
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

describe("OF-32 N6: restore-check and the plan predict the skill-conflict refusal restore gives", () => {
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
  // OF-103: the roots a recorded spec source must lie under; the fixture folder by default.
  let trustedRoots: string[] = [];

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "of32-n6-")));
    trustedRoots = [root];
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
      specSourceTrust: { ...FIXTURE_SPEC_SOURCE_TRUST, roots: () => trustedRoots },
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
  async function conflicted(edit = true) {
    const seat = await launchRig();
    const workLoadout = resolveSkillLoadout({ catalogRoot: catalog, systemSkills: [], projectRoot: workdir, projectSkills: ["work-skill"] });
    if (!workLoadout.ok) throw new Error("work loadout");
    expect(reconcileSkillLoadout({ loadout: workLoadout.loadout, runtime: "claude-code", cwd: workdir, apply: true }).ok).toBe(true);
    if (edit) fs.writeFileSync(path.join(skillsDir(), "work-skill", "SKILL.md"), SKILL("work-skill", "operator edit"));
    const snapshotId = await down(seat.rigId);
    retarget("bbbbbbb");
    return { seat, snapshotId };
  }
  const checkOf = (listed: string[]) => createRestoreCheckService(rigRepo, new SnapshotRepository(db), tmux, { runtimeAdapters: { "claude-code": adapter }, specReader: inst })
    .checkWithLiveness({ rig: "team", noQueue: true, noHooks: true, ...(listed.length ? { freshLogicalIds: listed } : {}) });

  /** The refusal restore reports for the seat: the text between "Fresh start refused: " and "No session was started." */
  const refusalOf = (error: string | undefined) => /^Fresh start refused: (.*) No session was started\.$/s.exec(error ?? "")?.[1];
  const planDeps = () => ({ db, rigRepo, specReader: inst, runtimeAdapters: { "claude-code": adapter }, exists: (p: string) => fs.existsSync(p) });

  it("restore-check names the skill-conflict refusal restore gives a listed seat, and writes nothing", async () => {
    const { snapshotId } = await conflicted();
    const before = onDisk();
    const callsBefore = reconciler.mock.calls.length;

    const result = await checkOf(["dev.impl"]);
    const pre = result.checks.find((c) => c.check.endsWith("restore-preconditions"))!;

    // Read-only: whatever the check asked the reconciler, it asked to apply nothing, and the seat's skills are as they were.
    expect(reconciler.mock.calls.slice(callsBefore).map(([input]) => input.apply)).not.toContain(true);
    expect(onDisk()).toEqual(before);
    const outcome = await restoreFrom(snapshotId, true);
    const node = outcome.ok ? outcome.result.nodes.find((n) => n.logicalId === "dev.impl") : undefined;
    expect(node?.status, "the table's own expectation of restore").toBe("failed");
    const refusal = refusalOf(node?.error);
    expect(refusal, `restore's error: ${node?.error}`).toContain("work-skill");
    expect(pre.status, pre.evidence).toBe("red");
    expect(pre.evidence).toContain(refusal!);
    expect(onDisk()).toEqual(before);
  });

  it("the plan names the same skill-conflict refusal on the listed seat", async () => {
    const { seat, snapshotId } = await conflicted();
    const rig = rigRepo.getRig(seat.rigId)!;
    const snapshot = new SnapshotRepository(db).getSnapshot(snapshotId)!;
    const before = onDisk();

    const refusals = await predictedPlanRefusals(planDeps(), rig, snapshot, ["dev.impl"], "spec");
    const plan = buildRestorePlanPreview(rig, snapshot, collectPreviewSessionRows(db, rig, snapshot), ["dev.impl"], Date.now(), readFreshOccupantRelations(db, rig.rig.id), refusals);
    expect(onDisk()).toEqual(before);

    const outcome = await restoreFrom(snapshotId, true);
    const node = outcome.ok ? outcome.result.nodes.find((n) => n.logicalId === "dev.impl") : undefined;
    expect(node?.status).toBe("failed");
    expect(plan.nodes.find((n) => n.logicalId === "dev.impl")!.wouldRefuse).toBe(refusalOf(node?.error));
  });

  it("without --fresh the same rig is not red and the plan names no refusal: restore would not re-read", async () => {
    const { seat, snapshotId } = await conflicted();
    const rig = rigRepo.getRig(seat.rigId)!;
    const snapshot = new SnapshotRepository(db).getSnapshot(snapshotId)!;

    const pre = (await checkOf([])).checks.find((c) => c.check.endsWith("restore-preconditions"))!;
    const refusals = await predictedPlanRefusals(planDeps(), rig, snapshot, [], "spec");
    const outcome = await restoreFrom(snapshotId, false);
    const node = outcome.ok ? outcome.result.nodes.find((n) => n.logicalId === "dev.impl") : undefined;

    expect(node?.status).not.toBe("failed");
    expect(pre.status, pre.evidence).not.toBe("red");
    expect(refusals.size).toBe(0);
  });

  // OF-103: the re-read judges the recorded source again, so a source that fails the judgement is refused by restore for a
  // listed seat, and restore-check and the plan say so through the same decision (production: startup.ts wires the one
  // PodRigInstantiator into restore, restore-check and the plan as their specReader).
  it("OF-103: a recorded source outside every trusted root is refused by restore for a listed seat, and the check and the plan name the same refusal", async () => {
    const seat = await launchRig();
    const snapshotId = await down(seat.rigId);
    trustedRoots = [];
    const rig = rigRepo.getRig(seat.rigId)!;
    const snapshot = new SnapshotRepository(db).getSnapshot(snapshotId)!;

    const pre = (await checkOf(["dev.impl"])).checks.find((c) => c.check.endsWith("restore-preconditions"))!;
    const refusals = await predictedPlanRefusals(planDeps(), rig, snapshot, ["dev.impl"], "spec");
    const plan = buildRestorePlanPreview(rig, snapshot, collectPreviewSessionRows(db, rig, snapshot), ["dev.impl"], Date.now(), readFreshOccupantRelations(db, rig.rig.id), refusals);
    const outcome = await restoreFrom(snapshotId, true);
    const node = outcome.ok ? outcome.result.nodes.find((n) => n.logicalId === "dev.impl") : undefined;

    expect(node?.status, JSON.stringify(node)).toBe("failed");
    const refusal = refusalOf(node?.error);
    expect(refusal, `restore's error: ${node?.error}`).toContain("not trusted for a fresh launch");
    expect(pre.status, pre.evidence).toBe("red");
    expect(pre.evidence).toContain(refusal!);
    expect(plan.nodes.find((n) => n.logicalId === "dev.impl")!.wouldRefuse).toBe(refusal);
  });

  it("control: no operator edit, so --fresh is neither refused by restore nor red in the check", async () => {
    const { snapshotId } = await conflicted(false);

    const pre = (await checkOf(["dev.impl"])).checks.find((c) => c.check.endsWith("restore-preconditions"))!;
    const outcome = await restoreFrom(snapshotId, true);
    const node = outcome.ok ? outcome.result.nodes.find((n) => n.logicalId === "dev.impl") : undefined;

    expect(node?.status).not.toBe("failed");
    expect(pre.status, pre.evidence).not.toBe("red");
  });
});
