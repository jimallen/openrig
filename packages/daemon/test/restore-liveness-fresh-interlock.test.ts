// integ21 nit 1 (review-integ21-bc23cdf5-9f): nothing drove OF-33 (the bounded tmux liveness check that refuses a
// restore while a seat is live or tmux does not answer) and OF-32s3 (`rig up --existing --fresh <seat>` re-reads the
// spec for the listed seat only) through ONE restore. Both are decided at the front of `restore()`; these rows pin
// their ORDER and the absence of every side effect on the refusal paths, not only the final status:
//   R1 (x2)  a live seat + a --fresh seat: refused rig_not_stopped, before any fresh decision;
//   R2       a hung tmux that would otherwise reach the fresh decision: refused, bounded, no seat pipeline entered;
//   R3       both features passing: the restore proceeds, and only the listed seat re-reads.
// "No fresh decision / no seat pipeline" is measured as: the spec reader never called, no tmux session created, no
// startup file delivered, no harness launched, and a fingerprint of the sessions, saved startup contexts, node versions,
// snapshots and events table identical before and after. Test-only; the harness is a copy of restore-fresh-reread's.
// Boundary: these rows do not assert how many seats are probed on the live path (probing stops at the first live seat);
// that is pinned by restore-orchestrator.test.ts "N-2: probing stops at the first live seat (1 probe of 3)".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
import type { RuntimeAdapter, ResolvedStartupFile } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";
import { guardedAgentRefFsOps } from "../src/domain/agent-ref-guard.js";
import { mergeManagedBlock } from "../src/domain/managed-blocks.js";

const blockFs = {
  exists: (p: string) => fs.existsSync(p),
  readFile: (p: string) => fs.readFileSync(p, "utf-8"),
  writeFile: (p: string, c: string) => fs.writeFileSync(p, c),
  mkdirp: (p: string) => fs.mkdirSync(p, { recursive: true }),
};

const RIG = (name = "team") => `version: "0.2"
name: ${name}
culture_file: CULTURE.md
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
const AGENT = (version: string) => `name: impl
version: "${version}"
profiles:
  default: {}
startup:
  files:
    - path: guidance/role.md
      delivery_hint: guidance_merge
      required: true
  actions: []
`;

function writeRelease(dir: string, version: string) {
  fs.mkdirSync(path.join(dir, "agents", "impl", "guidance"), { recursive: true });
  fs.writeFileSync(path.join(dir, "rig.yaml"), RIG());
  fs.writeFileSync(path.join(dir, "CULTURE.md"), `# culture ${version}\n`);
  fs.writeFileSync(path.join(dir, "agents", "impl", "agent.yaml"), AGENT(version));
  fs.writeFileSync(path.join(dir, "agents", "impl", "guidance", "role.md"), `# role ${version}\n`);
}

describe("integ21 nit 1: OF-33 liveness refusal x OF-32s3 --fresh through one restore", () => {
  let root: string;
  let current: string;
  let linkSpec: string;
  let workdir: string;
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let snapshotCapture: SnapshotCapture;
  let alive: Set<string>;
  let tmux: TmuxAdapter;
  let adapter: RuntimeAdapter;
  let delivered: ResolvedStartupFile[][];
  let inst: PodRigInstantiator;
  let service: SeatLifecycleService;
  let restore: RestoreOrchestrator;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "of32-restore-")));
    for (const [sha, version] of [["aaaaaaa", "1.0.0"], ["bbbbbbb", "2.0.0"], ["ccccccc", "3.0.0"]] as const) {
      writeRelease(path.join(root, "releases", sha, "rigs", "team"), version);
    }
    current = path.join(root, "releases", "current");
    fs.symlinkSync(path.join(root, "releases", "aaaaaaa"), current);
    fs.mkdirSync(path.join(root, "library"));
    fs.symlinkSync(path.join(current, "rigs", "team"), path.join(root, "library", "team"));
    linkSpec = path.join(root, "library", "team", "rig.yaml");
    workdir = path.join(root, "work");
    fs.mkdirSync(workdir);

    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
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
    delivered = [];
    adapter = {
      runtime: "claude-code",
      listInstalled: async () => [],
      project: async () => ({ projected: [], skipped: [], failed: [] }),
      deliverStartup: async (files, binding) => {
        delivered.push(files);
        // As the Claude adapter does: each guidance file it is given becomes a managed block in the seat's CLAUDE.md.
        for (const file of files) {
          if (file.deliveryHint !== "guidance_merge") continue;
          mergeManagedBlock(blockFs, path.join(binding.cwd, "CLAUDE.md"), file.path, fs.readFileSync(file.absolutePath, "utf-8"));
        }
        return { delivered: files.length, failed: [] };
      },
      launchHarness: async () => ({ ok: true, resumeToken: "native-uuid", resumeType: "claude_session_id" }),
      checkReady: async () => ({ ready: true }),
    };
    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    const startupOrchestrator = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux, sleep: async () => undefined });
    inst = new PodRigInstantiator({
      specSourceTrust: FIXTURE_SPEC_SOURCE_TRUST,
      db, rigRepo, podRepo: new PodRepository(db), sessionRegistry, eventBus, nodeLauncher, startupOrchestrator,
      fsOps: { ...guardedAgentRefFsOps, readFile: (p: string) => fs.readFileSync(p, "utf-8"), exists: (p: string) => fs.existsSync(p) },
      adapters: { "claude-code": adapter },
      tmuxAdapter: tmux,
      onboardingEnabledResolver: () => false,
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

  async function launchRig(opts?: { record?: boolean }) {
    const realSpec = fs.realpathSync(linkSpec);
    const outcome = await inst.instantiate(fs.readFileSync(realSpec, "utf-8"), path.dirname(realSpec), {
      cwdOverride: workdir,
      ...(opts?.record === false ? {} : { specSourcePath: linkSpec }),
    });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) throw new Error("launch failed");
    const node = rigRepo.getRig(outcome.result.rigId)!.nodes[0]!;
    delivered = [];
    return { rigId: outcome.result.rigId, nodeId: node.id, sessionName: "dev-impl@team" };
  }

  const releaseOf = (files: ResolvedStartupFile[]) => files
    .filter((f) => f.path === "guidance/role.md" || f.path === "CULTURE.md")
    .map((f) => {
      const sha = ["aaaaaaa", "bbbbbbb", "ccccccc"].find((s) => f.absolutePath.includes(`${path.sep}${s}${path.sep}`));
      return `${f.path}:${sha ? sha[0]!.toUpperCase() : f.absolutePath}`;
    })
    .sort();
  const storedFiles = (nodeId: string) => JSON.parse((db.prepare("SELECT resolved_files_json FROM node_startup_context WHERE node_id = ?").get(nodeId) as { resolved_files_json: string }).resolved_files_json) as ResolvedStartupFile[];
  const nodeVersion = (nodeId: string) => (db.prepare("SELECT resolved_spec_version AS v FROM nodes WHERE id = ?").get(nodeId) as { v: string }).v;
  const retarget = (sha: string) => { fs.unlinkSync(current); fs.symlinkSync(path.join(root, "releases", sha), current); };
  const down = async (rigId: string) => {
    const result = await new RigTeardownOrchestrator({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux, snapshotCapture, eventBus }).teardown(rigId);
    expect(result.snapshotId, JSON.stringify(result)).toBeTruthy();
    delivered = [];
    return result.snapshotId!;
  };
  const restoreFrom = (snapshotId: string, opts: { fresh?: boolean; startupFrom?: "spec" | "stored" } = {}) => restore.restore(snapshotId, {
    adapters: { "claude-code": adapter },
    fsOps: { exists: (p: string) => fs.existsSync(p) },
    ...(opts.fresh === false ? {} : { freshLogicalIds: ["dev.impl"] }),
    ...(opts.startupFrom ? { startupFrom: opts.startupFrom } : {}),
  } as never);
  /** The seat's entry in the last restore.completed event: what anything reading events sees. */
  const eventSeat = () => {
    const row = db.prepare("SELECT payload FROM events WHERE type = 'restore.completed' ORDER BY seq DESC LIMIT 1").get() as { payload: string };
    return (JSON.parse(row.payload).result.nodes as Array<{ logicalId: string; startupSource?: unknown }>).find((n) => n.logicalId === "dev.impl")!;
  };
  const specB = () => ({ kind: "spec", specSource: linkSpec, specPath: path.join(root, "releases", "bbbbbbb", "rigs", "team", "rig.yaml"), previousSpecVersion: "1.0.0", specVersion: "2.0.0" });
  const seatResult = (outcome: Awaited<ReturnType<RestoreOrchestrator["restore"]>>) => {
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) throw new Error("restore refused");
    return outcome.result.nodes.find((n) => n.logicalId === "dev.impl")!;
  };

  // ---- the cross-feature rows ---------------------------------------------------------------------------------------
  const twoSeatRig = () => RIG().replace(/ {6}- id: impl\n[\s\S]*?cwd: \.\n/, (member) => member + member.replace("id: impl", "id: qa"));

  /** Launch the two-seat rig (dev.impl, dev.qa), take a snapshot while both are DB-running (a crash, not a `rig down`),
   *  then point the library link at release B (2.0.0) so any re-read of the spec is visible. */
  async function launchTwo() {
    for (const sha of ["aaaaaaa", "bbbbbbb", "ccccccc"]) fs.writeFileSync(path.join(root, "releases", sha, "rigs", "team", "rig.yaml"), twoSeatRig());
    const first = await launchRig();
    const nodes = rigRepo.getRig(first.rigId)!.nodes;
    const idOf = (logicalId: string) => nodes.find((n) => n.logicalId === logicalId)!.id;
    // qa starts fresh by its restore policy (the snapshot must carry it) but is never listed with --fresh.
    db.prepare("UPDATE sessions SET restore_policy = 'checkpoint_only' WHERE node_id = ?").run(idOf("dev.qa"));
    const snapshotId = snapshotCapture.captureSnapshot(first.rigId, "manual").id;
    retarget("bbbbbbb");
    delivered = [];
    vi.mocked(tmux.createSession).mockClear();
    vi.mocked(tmux.hasSession).mockClear();
    return { rigId: first.rigId, snapshotId, impl: idOf("dev.impl"), qa: idOf("dev.qa") };
  }

  /** Everything a restore that reached a seat would have changed. */
  const fingerprint = () => JSON.stringify({
    sessions: db.prepare("SELECT id, status, restore_policy FROM sessions ORDER BY id").all(),
    contexts: db.prepare("SELECT node_id, resolved_files_json, startup_actions_json FROM node_startup_context ORDER BY node_id").all(),
    versions: db.prepare("SELECT id, resolved_spec_version FROM nodes ORDER BY id").all(),
    snapshots: (db.prepare("SELECT count(*) AS n FROM snapshots").get() as { n: number }).n,
    events: (db.prepare("SELECT count(*) AS n FROM events").get() as { n: number }).n,
  });
  const spies = () => ({
    reads: vi.spyOn(inst, "readSeatStartupFromSpec"),
    deliver: vi.spyOn(adapter, "deliverStartup"),
    launch: vi.spyOn(adapter, "launchHarness"),
  });
  const expectNoSeatPipeline = (s: ReturnType<typeof spies>) => {
    expect(s.reads).not.toHaveBeenCalled();
    expect(tmux.createSession).not.toHaveBeenCalled();
    expect(tmux.killSession).not.toHaveBeenCalled();
    expect(s.deliver).not.toHaveBeenCalled();
    expect(s.launch).not.toHaveBeenCalled();
  };

  it.each([
    ["the --fresh seat itself is the live one", "dev.impl", "dev.qa"],
    ["another seat is live and the --fresh seat is down", "dev.qa", "dev.impl"],
  ] as const)("R1 a live seat plus a --fresh seat (%s): refused rig_not_stopped before any fresh decision", async (_label, liveSeat, deadSeat) => {
    const rig = await launchTwo();
    // tmux reality: only liveSeat still exists; the DB (a crash) still says both are running.
    alive.delete(deadSeat === "dev.impl" ? "dev-impl@team" : "dev-qa@team");
    const before = fingerprint();
    const s = spies();

    const outcome = await restore.restore(rig.snapshotId, {
      adapters: { "claude-code": adapter },
      fsOps: { exists: (p: string) => fs.existsSync(p) },
      freshLogicalIds: ["dev.impl"],
    } as never);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("rig_not_stopped");
    expect(outcome.message).toContain("has live sessions");
    expect(outcome.message).not.toContain("liveness is unknown");
    // Positive control: the liveness probe ran (and named a real session); the refusal is not an unrelated failure.
    expect(tmux.hasSession).toHaveBeenCalled();
    expect(vi.mocked(tmux.hasSession).mock.calls.map((c) => c[0])).toContain(liveSeat === "dev.impl" ? "dev-impl@team" : "dev-qa@team");
    // Ordering/absence: no fresh decision, no seat pipeline, and nothing written.
    expectNoSeatPipeline(s);
    expect(fingerprint()).toBe(before);
    expect(alive.has(liveSeat === "dev.impl" ? "dev-impl@team" : "dev-qa@team")).toBe(true);
    // The refusal came before pre-restore validation: the restore.started event of an attempt was never emitted.
    expect(db.prepare("SELECT count(*) AS n FROM events WHERE type = 'restore.started'").get()).toEqual({ n: 0 });
  });

  it("R2 a hung tmux that would otherwise reach the fresh decision: refused as liveness-unknown within one deadline, no seat pipeline entered", async () => {
    const rig = await launchTwo();
    alive.clear(); // reality: every seat is gone, so a readable tmux would let this restore reach the --fresh decision
    vi.mocked(tmux.hasSession).mockImplementation(() => new Promise<boolean>(() => { /* wedged tmux: never settles */ }));
    const before = fingerprint();
    const s = spies();
    const started = Date.now();

    const outcome = await restore.restore(rig.snapshotId, {
      adapters: { "claude-code": adapter },
      fsOps: { exists: (p: string) => fs.existsSync(p) },
      freshLogicalIds: ["dev.impl"],
    } as never);
    const elapsed = Date.now() - started;

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("rig_not_stopped");
    expect(outcome.message).toContain("liveness is unknown");
    expect(outcome.message).not.toContain("has live sessions");
    // Bounded: one deadline (2000 ms), not one per seat, and not forever.
    expect(vi.mocked(tmux.hasSession)).toHaveBeenCalledTimes(1);
    expect(elapsed).toBeGreaterThanOrEqual(1900);
    expect(elapsed).toBeLessThan(5000);
    expectNoSeatPipeline(s);
    expect(fingerprint()).toBe(before);
    expect(db.prepare("SELECT count(*) AS n FROM events WHERE type = 'restore.started'").get()).toEqual({ n: 0 });
  }, 15000);

  it("R3 both features passing: tmux is answered and clear, the restore proceeds, and only the listed seat re-reads", async () => {
    const rig = await launchTwo();
    alive.clear(); // a crash: both sessions are gone from tmux, still running in the DB
    const s = spies();

    const outcome = await restore.restore(rig.snapshotId, {
      adapters: { "claude-code": adapter },
      fsOps: { exists: (p: string) => fs.existsSync(p) },
      freshLogicalIds: ["dev.impl"],
    } as never);

    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) return;
    const byId = (logicalId: string) => outcome.result.nodes.find((n) => n.logicalId === logicalId)!;
    // Only the listed seat re-reads the spec; the other comes up on its saved setup.
    expect(s.reads).toHaveBeenCalledTimes(1);
    expect(s.reads.mock.calls[0]![0].nodeId).toBe(rig.impl);
    expect(byId("dev.impl").status, JSON.stringify(byId("dev.impl"))).toBe("fresh-primed");
    expect(byId("dev.impl").startupSource).toEqual(specB());
    expect(byId("dev.qa").status, JSON.stringify(byId("dev.qa"))).toBe("fresh-primed");
    expect(byId("dev.qa").startupSource).toEqual({ kind: "stored", reason: "not_fresh_listed" });
    expect(nodeVersion(rig.impl)).toBe("2.0.0");
    expect(nodeVersion(rig.qa)).toBe("1.0.0");
    expect(releaseOf(storedFiles(rig.impl))).toEqual(["CULTURE.md:B", "guidance/role.md:B"]);
    expect(releaseOf(storedFiles(rig.qa))).toEqual(["CULTURE.md:A", "guidance/role.md:A"]);
    // Ordering: the liveness probe was asked before the spec was read and before any session was created.
    const firstProbe = Math.min(...vi.mocked(tmux.hasSession).mock.invocationCallOrder);
    expect(firstProbe).toBeLessThan(s.reads.mock.invocationCallOrder[0]!);
    expect(firstProbe).toBeLessThan(Math.min(...vi.mocked(tmux.createSession).mock.invocationCallOrder));
    // Both seats' sessions were started (positive control for the absence rows above).
    expect(vi.mocked(tmux.createSession)).toHaveBeenCalledTimes(2);
    // Positive control for the `restore.started` == 0 checks in R1 and R2: a restore that proceeds emits it exactly once.
    expect(db.prepare("SELECT count(*) AS n FROM events WHERE type = 'restore.started'").get()).toEqual({ n: 1 });
  });
});
