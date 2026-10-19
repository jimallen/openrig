// OF-32 stage 3: a seat that comes up fresh through `rig up --existing` (or any restore) re-reads the rig's spec as it
// is now, exactly as `rig seat launch --fresh` does, with the same `stored` escape. An exact resume keeps its saved
// context. The snapshot hazard: a restore from a snapshot older than a re-read fresh launch used to write the
// snapshot's old startup files back over the seat's newer saved context.
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

describe("OF-32 stage 3: a seat restored fresh re-reads the rig's spec source", () => {
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
  const seatResult = (outcome: Awaited<ReturnType<RestoreOrchestrator["restore"]>>) => {
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) throw new Error("restore refused");
    return outcome.result.nodes.find((n) => n.logicalId === "dev.impl")!;
  };

  it("`rig up --existing --fresh <seat>` delivers the release the library link points at now, and records it", async () => {
    const seat = await launchRig();
    const snapshotId = await down(seat.rigId);
    retarget("bbbbbbb");

    const node = seatResult(await restoreFrom(snapshotId));

    expect(node.status, JSON.stringify(node)).toBe("fresh-primed");
    expect(releaseOf(delivered.flat())).toEqual(["CULTURE.md:B", "guidance/role.md:B"]);
    expect(releaseOf(storedFiles(seat.nodeId))).toEqual(["CULTURE.md:B", "guidance/role.md:B"]);
    expect(nodeVersion(seat.nodeId)).toBe("2.0.0");
  });

  it("a seat whose restore policy starts it fresh re-reads too, without --fresh", async () => {
    const seat = await launchRig();
    db.prepare("UPDATE sessions SET restore_policy = 'relaunch_fresh' WHERE node_id = ?").run(seat.nodeId);
    const snapshotId = await down(seat.rigId);
    retarget("bbbbbbb");

    const node = seatResult(await restoreFrom(snapshotId, { fresh: false }));

    expect(node.status, JSON.stringify(node)).toBe("fresh-primed");
    expect(releaseOf(delivered.flat())).toEqual(["CULTURE.md:B", "guidance/role.md:B"]);
    expect(nodeVersion(seat.nodeId)).toBe("2.0.0");
  });

  it("an exact resume never re-reads and keeps the saved context", async () => {
    const seat = await launchRig();
    const snapshotId = await down(seat.rigId);
    retarget("bbbbbbb");
    const reads = vi.spyOn(inst, "readSeatStartupFromSpec");

    await restoreFrom(snapshotId, { fresh: false });

    expect(reads).not.toHaveBeenCalled();
    expect(releaseOf(storedFiles(seat.nodeId))).toEqual(["CULTURE.md:A", "guidance/role.md:A"]);
    expect(nodeVersion(seat.nodeId)).toBe("1.0.0");
  });

  it("a snapshot whose saved files were deleted does not block a fresh seat that re-reads", async () => {
    const seat = await launchRig();
    const snapshotId = await down(seat.rigId);
    retarget("bbbbbbb");
    fs.rmSync(path.join(root, "releases", "aaaaaaa"), { recursive: true });

    const node = seatResult(await restoreFrom(snapshotId));

    expect(node.status, JSON.stringify(node)).toBe("fresh-primed");
    expect(releaseOf(delivered.flat())).toEqual(["CULTURE.md:B", "guidance/role.md:B"]);
  });

  it("a spec that can no longer start the seat refuses it before launch, with the stored escape", async () => {
    const seat = await launchRig();
    const snapshotId = await down(seat.rigId);
    retarget("bbbbbbb");
    fs.rmSync(path.join(root, "releases", "bbbbbbb", "rigs", "team", "agents", "impl", "guidance", "role.md"));
    const created = vi.mocked(tmux.createSession).mock.calls.length;

    const node = seatResult(await restoreFrom(snapshotId));

    expect(node.status).toBe("failed");
    expect(node.error).toContain(linkSpec);
    expect(node.error).toContain("required startup file guidance/role.md");
    expect(node.error).toContain(`rig seat launch 'dev.impl@team' --fresh --startup-from stored --reason "<why>"`);
    // Refused before launch: no session was created and nothing was delivered or saved.
    expect(vi.mocked(tmux.createSession).mock.calls.length).toBe(created);
    expect(delivered).toEqual([]);
    expect(releaseOf(storedFiles(seat.nodeId))).toEqual(["CULTURE.md:A", "guidance/role.md:A"]);
  });

  it("`--startup-from stored` replays the seat's saved files, not the snapshot's older copy", async () => {
    const seat = await launchRig();
    const oldSnapshot = snapshotCapture.captureSnapshot(seat.rigId, "manual").id;
    retarget("bbbbbbb");
    const fresh = await service.launchFresh({ seatRef: seat.sessionName, fresh: true, stop: true, reason: "release b" });
    expect(fresh.ok, JSON.stringify(fresh)).toBe(true);
    await down(seat.rigId);
    retarget("ccccccc");

    const node = seatResult(await restoreFrom(oldSnapshot, { startupFrom: "stored" }));

    expect(node.status, JSON.stringify(node)).toBe("fresh-primed");
    expect(releaseOf(delivered.flat())).toEqual(["CULTURE.md:B", "guidance/role.md:B"]);
    expect(releaseOf(storedFiles(seat.nodeId))).toEqual(["CULTURE.md:B", "guidance/role.md:B"]);
    expect(nodeVersion(seat.nodeId)).toBe("2.0.0");
  });

  it("the snapshot hazard: restoring an older snapshot never writes its startup files over a newer re-read", async () => {
    const seat = await launchRig();
    const oldSnapshot = snapshotCapture.captureSnapshot(seat.rigId, "manual").id;
    retarget("bbbbbbb");
    const fresh = await service.launchFresh({ seatRef: seat.sessionName, fresh: true, stop: true, reason: "release b" });
    expect(fresh.ok, JSON.stringify(fresh)).toBe(true);
    await down(seat.rigId);

    const node = seatResult(await restoreFrom(oldSnapshot));

    expect(node.status, JSON.stringify(node)).toBe("fresh-primed");
    expect(releaseOf(storedFiles(seat.nodeId))).toEqual(["CULTURE.md:B", "guidance/role.md:B"]);
    expect(nodeVersion(seat.nodeId)).toBe("2.0.0");
  });

  it("a restore whose launch fails keeps the seat's saved context", async () => {
    const seat = await launchRig();
    const oldSnapshot = snapshotCapture.captureSnapshot(seat.rigId, "manual").id;
    retarget("bbbbbbb");
    const fresh = await service.launchFresh({ seatRef: seat.sessionName, fresh: true, stop: true, reason: "release b" });
    expect(fresh.ok, JSON.stringify(fresh)).toBe(true);
    await down(seat.rigId);
    retarget("ccccccc");
    adapter.launchHarness = async () => ({ ok: false, error: "fixture: harness refused", recovery: "none" } as never);

    const node = seatResult(await restoreFrom(oldSnapshot));

    expect(node.status).toBe("failed");
    expect(releaseOf(storedFiles(seat.nodeId))).toEqual(["CULTURE.md:B", "guidance/role.md:B"]);
    expect(nodeVersion(seat.nodeId)).toBe("2.0.0");
  });

  it("a rig with no recorded source replays the seat's saved files and says so", async () => {
    const seat = await launchRig({ record: false });
    const snapshotId = await down(seat.rigId);
    retarget("bbbbbbb");

    const outcome = await restoreFrom(snapshotId);
    const node = seatResult(outcome);

    expect(node.status, JSON.stringify(node)).toBe("fresh-primed");
    expect(releaseOf(delivered.flat())).toEqual(["CULTURE.md:A", "guidance/role.md:A"]);
    expect(outcome.ok && outcome.result.warnings.some((w) => w.includes("dev.impl") && w.includes("records no spec source"))).toBe(true);
  });

  // The guidance check after the launch asks whether the seat's CLAUDE.md holds the blocks the seat was GIVEN (here
  // release B's), not the blocks the snapshot's older selection names: release A also merged an SOP that B dropped.
  it("the post-restore guidance check looks for what the seat was given, not the snapshot's older selection", async () => {
    const agentA = path.join(root, "releases", "aaaaaaa", "rigs", "team", "agents", "impl");
    fs.writeFileSync(path.join(agentA, "guidance", "sop.md"), "# sop 1.0.0\n");
    fs.writeFileSync(path.join(agentA, "agent.yaml"), AGENT("1.0.0").replace("  actions: []", "    - path: guidance/sop.md\n      delivery_hint: guidance_merge\n      required: false\n  actions: []"));
    const seat = await launchRig();
    expect(storedFiles(seat.nodeId).some((f) => f.path === "guidance/sop.md")).toBe(true);
    const snapshotId = await down(seat.rigId);
    retarget("bbbbbbb");

    const outcome = await restoreFrom(snapshotId);
    const node = seatResult(outcome);

    expect(node.status, JSON.stringify(node)).toBe("fresh-primed");
    expect(releaseOf(delivered.flat())).toEqual(["CULTURE.md:B", "guidance/role.md:B"]);
    expect(node.guidanceGaps).toBeUndefined();
    expect(outcome.ok && outcome.result.warnings.some((w) => w.includes("running without part of its guidance"))).toBe(false);
  });

  it("under --startup-from stored, a seat left awaiting a decision is told the stored command", async () => {
    const seat = await launchRig();
    db.prepare("UPDATE sessions SET resume_token = NULL WHERE node_id = ?").run(seat.nodeId);
    const snapshotId = await down(seat.rigId);

    const node = seatResult(await restoreFrom(snapshotId, { fresh: false, startupFrom: "stored" }));

    expect(node.status).toBe("awaiting-decision");
    expect(node.error).toContain(`rig seat launch 'dev.impl@team' --fresh --startup-from stored --reason "<why>"`);
  });
});
