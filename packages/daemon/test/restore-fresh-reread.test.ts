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
import { readStoredStartupContext } from "../src/domain/seat-startup-source.js";
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

  it("`rig up --existing --fresh <seat>` delivers the release the library link points at now, and records it", async () => {
    const seat = await launchRig();
    const snapshotId = await down(seat.rigId);
    retarget("bbbbbbb");

    const node = seatResult(await restoreFrom(snapshotId));

    expect(node.status, JSON.stringify(node)).toBe("fresh-primed");
    expect(releaseOf(delivered.flat())).toEqual(["CULTURE.md:B", "guidance/role.md:B"]);
    expect(releaseOf(storedFiles(seat.nodeId))).toEqual(["CULTURE.md:B", "guidance/role.md:B"]);
    expect(nodeVersion(seat.nodeId)).toBe("2.0.0");
    // Review must-fix 1: the result and the event say where the files came from and that the agent moved 1.0.0 -> 2.0.0.
    expect(node.startupSource).toEqual(specB());
    expect(eventSeat().startupSource).toEqual(specB());
  });

  // Jim's scope (2026-10-20): only a seat listed with --fresh re-reads the spec. A seat the restore starts fresh for
  // another reason (its restore policy, no history, a checkpoint rebuild) comes back on its saved setup, as at base.
  it.each(["relaunch_fresh", "checkpoint_only"])("a seat fresh by restore policy %s, not listed with --fresh, does not re-read: its version is unchanged", async (policy) => {
    const seat = await launchRig();
    db.prepare("UPDATE sessions SET restore_policy = ? WHERE node_id = ?").run(policy, seat.nodeId);
    const snapshotId = await down(seat.rigId);
    retarget("bbbbbbb");
    const reads = vi.spyOn(inst, "readSeatStartupFromSpec");

    const node = seatResult(await restoreFrom(snapshotId, { fresh: false }));

    expect(node.status, JSON.stringify(node)).toBe("fresh-primed");
    expect(reads).not.toHaveBeenCalled();
    expect(releaseOf(delivered.flat())).toEqual(["CULTURE.md:A", "guidance/role.md:A"]);
    expect(releaseOf(storedFiles(seat.nodeId))).toEqual(["CULTURE.md:A", "guidance/role.md:A"]);
    expect(nodeVersion(seat.nodeId)).toBe("1.0.0");
    // The output stays honest about where its files came from.
    expect(node.startupSource).toEqual({ kind: "stored", reason: "not_fresh_listed" });
    expect(eventSeat().startupSource).toEqual({ kind: "stored", reason: "not_fresh_listed" });
  });

  // The reviewer's probes PA2 / PA3 (rev-of32s3-probes.test.ts): both came up at base and must come up again for a seat
  // not listed with --fresh. Listed with --fresh, the same seat re-reads and is refused before its launch.
  const changedProfile = () => {
    const relB = path.join(root, "releases", "bbbbbbb", "rigs", "team");
    fs.writeFileSync(path.join(relB, "rig.yaml"), RIG().replace("profile: default", "profile: other"));
    fs.writeFileSync(path.join(relB, "agents", "impl", "agent.yaml"), AGENT("2.0.0").replace("  default: {}", "  default: {}\n  other: {}"));
    retarget("bbbbbbb");
  };
  const linkGone = () => fs.unlinkSync(path.join(root, "library", "team"));
  it.each([
    ["PA2 its spec now declares another profile", changedProfile, "profile other (seat: default)"],
    ["PA3 its recorded spec link is gone", linkGone, "no longer exists"],
  ] as const)("%s: a policy-fresh seat still comes up on its saved setup; listed with --fresh it is refused", async (_label, damage, reason) => {
    const seat = await launchRig();
    db.prepare("UPDATE sessions SET restore_policy = 'checkpoint_only' WHERE node_id = ?").run(seat.nodeId);
    const snapshotId = await down(seat.rigId);
    damage();

    const routine = seatResult(await restoreFrom(snapshotId, { fresh: false }));
    expect(routine.status, JSON.stringify(routine)).toBe("fresh-primed");
    expect(routine.error).toBeUndefined();
    expect(releaseOf(delivered.flat())).toEqual(["CULTURE.md:A", "guidance/role.md:A"]);

    await down(seat.rigId);
    const listed = seatResult(await restoreFrom(snapshotId));
    expect(listed.status).toBe("failed");
    expect(listed.error).toContain(reason);
    expect(listed.error).toContain("No session was started");
  });

  // A seat not listed is validated before the restore exactly as at base, but on what it will replay: its own saved
  // setup. A required file that setup names is gone, so the whole restore is not attempted (base's D1/D4 gate).
  it("a seat not listed with --fresh is pre-validated on its own saved setup, as base validated what it replayed", async () => {
    const seat = await launchRig();
    db.prepare("UPDATE sessions SET restore_policy = 'checkpoint_only' WHERE node_id = ?").run(seat.nodeId);
    const snapshotId = await down(seat.rigId);
    const gone = path.join(root, "gone", "role.md");
    const saved = storedFiles(seat.nodeId).map((f) => (f.path === "guidance/role.md" ? { ...f, absolutePath: gone } : f));
    db.prepare("UPDATE node_startup_context SET resolved_files_json = ? WHERE node_id = ?").run(JSON.stringify(saved), seat.nodeId);

    const outcome = await restoreFrom(snapshotId, { fresh: false });

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.code).toBe("pre_restore_validation_failed");
    expect(!outcome.ok && "result" in outcome && JSON.stringify(outcome.result)).toContain(gone);
    expect(delivered).toEqual([]);
  });

  // The snapshot-hazard fix holds for every fresh seat, listed or not: a policy-fresh seat restored from an older
  // snapshot comes back on its own newer saved setup, not the snapshot's copy.
  it("the snapshot hazard is fixed for a seat not listed with --fresh too", async () => {
    const seat = await launchRig();
    db.prepare("UPDATE sessions SET restore_policy = 'checkpoint_only' WHERE node_id = ?").run(seat.nodeId);
    const oldSnapshot = snapshotCapture.captureSnapshot(seat.rigId, "manual").id;
    retarget("bbbbbbb");
    const fresh = await service.launchFresh({ seatRef: seat.sessionName, fresh: true, stop: true, reason: "release b" });
    expect(fresh.ok, JSON.stringify(fresh)).toBe(true);
    await down(seat.rigId);
    retarget("ccccccc");

    const node = seatResult(await restoreFrom(oldSnapshot, { fresh: false }));

    expect(node.status, JSON.stringify(node)).toBe("fresh-primed");
    expect(releaseOf(delivered.flat())).toEqual(["CULTURE.md:B", "guidance/role.md:B"]);
    expect(releaseOf(storedFiles(seat.nodeId))).toEqual(["CULTURE.md:B", "guidance/role.md:B"]);
    expect(nodeVersion(seat.nodeId)).toBe("2.0.0");
  });

  // The reviewer's PC1: at base a fresh restore reinstalled a skill entry from the saved selection. A seat not listed
  // with --fresh still does (its saved setup is replayed as before); a --fresh seat follows `rig seat launch --fresh`.
  it.each([[false, true], [true, false]] as const)("listed with --fresh %s: the saved skill entry is projected %s", async (listed, projectedSkill) => {
    const seat = await launchRig({ record: false });
    db.prepare("UPDATE sessions SET restore_policy = 'checkpoint_only' WHERE node_id = ?").run(seat.nodeId);
    const skillDir = path.join(root, "skills-src", "probe-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: probe-skill\ndescription: probe\n---\n");
    const row = db.prepare("SELECT projection_entries_json FROM node_startup_context WHERE node_id = ?").get(seat.nodeId) as { projection_entries_json: string };
    const entries = JSON.parse(row.projection_entries_json) as unknown[];
    entries.push({ category: "skill", effectiveId: "probe-skill", sourceSpec: "agent", sourcePath: path.dirname(skillDir), resourcePath: "probe-skill", absolutePath: skillDir });
    db.prepare("UPDATE node_startup_context SET projection_entries_json = ? WHERE node_id = ?").run(JSON.stringify(entries), seat.nodeId);
    const projected: string[] = [];
    adapter.project = async (plan) => { projected.push(...plan.entries.map((e) => `${e.category}:${e.effectiveId}`)); return { projected: [], skipped: [], failed: [] }; };
    const snapshotId = await down(seat.rigId);

    const node = seatResult(await restoreFrom(snapshotId, { fresh: listed }));

    expect(node.status, JSON.stringify(node)).toBe("fresh-primed");
    expect(projected.includes("skill:probe-skill")).toBe(projectedSkill);
  });

  it("an exact resume never re-reads and keeps the saved context", async () => {
    const seat = await launchRig();
    const snapshotId = await down(seat.rigId);
    retarget("bbbbbbb");
    const reads = vi.spyOn(inst, "readSeatStartupFromSpec");

    const outcome = await restoreFrom(snapshotId, { fresh: false });

    expect(reads).not.toHaveBeenCalled();
    // A resumed seat was given nothing new, so it names no startup source.
    expect(outcome.ok && outcome.result.nodes.every((n) => n.startupSource === undefined)).toBe(true);
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
    expect(node.startupSource).toEqual({ kind: "stored", reason: "requested" });
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
    expect(node.startupSource).toEqual({ kind: "stored", reason: "no_recorded_source" });
  });

  // Review must-fix 3 / N4: a saved context the strict reader cannot read is not a dead end. Restore replays the
  // snapshot's copy (as before stage 3), says so, and the launch saves a readable context again.
  it("a seat whose saved startup context cannot be read comes up from the snapshot's copy, says so, and is healed", async () => {
    const seat = await launchRig({ record: false });
    const snapshotId = await down(seat.rigId);
    db.prepare("UPDATE node_startup_context SET projection_entries_json = ? WHERE node_id = ?").run(JSON.stringify([{ category: "memory" }]), seat.nodeId);

    const outcome = await restoreFrom(snapshotId);
    const node = seatResult(outcome);

    expect(node.status, JSON.stringify(node)).toBe("fresh-primed");
    expect(node.startupSource).toEqual({ kind: "snapshot", reason: "saved_context_unreadable" });
    expect(eventSeat().startupSource).toEqual({ kind: "snapshot", reason: "saved_context_unreadable" });
    expect(releaseOf(delivered.flat())).toEqual(["CULTURE.md:A", "guidance/role.md:A"]);
    expect(outcome.ok && outcome.result.warnings.some((w) => w.includes("dev.impl") && w.includes("malformed") && w.includes("replays this snapshot's copy"))).toBe(true);
    expect(JSON.parse((db.prepare("SELECT projection_entries_json AS e FROM node_startup_context WHERE node_id = ?").get(seat.nodeId) as { e: string }).e)
      .some((e: { category: string }) => e.category === "memory")).toBe(false);
  });

  // N-C2. The refusal's guidance is what an operator types next, so each claim in it was measured: `rig launch` (the
  // path launchSingleNode serves) against the restore path `rig up --existing --fresh <seat> --startup-from stored`,
  // for a context that is JSON of the wrong shape and for one that is not JSON, under both restore policies.
  const malformed = (nodeId: string, how: "shape" | "json") => {
    if (how === "shape") db.prepare("UPDATE node_startup_context SET projection_entries_json = ? WHERE node_id = ?").run(JSON.stringify([{ category: "memory" }]), nodeId);
    else db.prepare("UPDATE node_startup_context SET resolved_files_json = ? WHERE node_id = ?").run("{not json", nodeId);
  };
  const storedReads = (nodeId: string) => { const r = readStoredStartupContext(db, nodeId, "."); return r.ok ? "ok" : r.refusal.code; };
  const launchWithoutFresh = (rigId: string) => restore.launchSingleNode(rigId, "dev.impl", { adapters: { "claude-code": adapter }, fsOps: { exists: (p: string) => fs.existsSync(p) } } as never);

  it("`rig seat launch --fresh` on a context that is JSON of the wrong shape says rig launch is no way back, and names rig up --fresh", async () => {
    const seat = await launchRig({ record: false });
    malformed(seat.nodeId, "shape");

    const result = await service.launchFresh({ seatRef: seat.sessionName, fresh: true, stop: true, reason: "unreadable" });

    expect(result).toMatchObject({ ok: false, code: "startup_context_malformed" });
    expect(!result.ok && result.guidance).toBe(`Do not use rig launch ${seat.rigId} dev.impl: under the default restore policy (resume_if_possible) it resumes the old conversation, delivers nothing and leaves this context unreadable. To start the seat from the snapshot's copy of its startup files instead, stop the whole rig (rig down 'team'), then run: rig up 'team' --existing --fresh dev.impl --startup-from stored. That replays the snapshot's copy and saves what it replayed as the seat's new context, so a snapshot taken after this context broke carries the damage with it.`);
  });

  it("`rig seat launch --fresh` on a context that is not JSON does not send the operator to rig down or rig up", async () => {
    const seat = await launchRig({ record: false });
    malformed(seat.nodeId, "json");

    const result = await service.launchFresh({ seatRef: seat.sessionName, fresh: true, stop: true, reason: "unreadable" });

    expect(result).toMatchObject({ ok: false, code: "startup_context_malformed" });
    expect(!result.ok && result.guidance).toBe(`A column of the saved startup context is not JSON. Do not stop the rig: rig down cannot snapshot this seat and rig up --existing fails on it (restore_error). After stopping the seat (rig seat stop dev-impl@team --reason "<why>"), rig launch ${seat.rigId} dev.impl starts it from the last snapshot's copy of its startup files and saves a new context only when the seat's restore policy is checkpoint_only, and only if a snapshot taken before the context broke is usable. Under the default policy (resume_if_possible) it resumes the old conversation instead, delivers nothing and leaves this context unreadable. Restore cannot repair it then; the saved row has to be repaired or removed.`);
  });

  it("the guidance holds, shape-invalid context, default policy: rig launch resumes and leaves the context unreadable", async () => {
    const seat = await launchRig({ record: false });
    db.prepare("UPDATE sessions SET restore_policy = 'resume_if_possible' WHERE node_id = ?").run(seat.nodeId);
    await down(seat.rigId);
    malformed(seat.nodeId, "shape");

    const launched = await launchWithoutFresh(seat.rigId);

    expect(launched.ok, JSON.stringify(launched)).toBe(true);
    expect(releaseOf(delivered.flat())).toEqual([]);
    expect(storedReads(seat.nodeId)).toBe("startup_context_malformed");
  });

  it("the guidance holds, shape-invalid context, default policy: rig down then rig up --fresh --startup-from stored delivers and heals", async () => {
    const seat = await launchRig({ record: false });
    db.prepare("UPDATE sessions SET restore_policy = 'resume_if_possible' WHERE node_id = ?").run(seat.nodeId);
    malformed(seat.nodeId, "shape");
    const snapshotId = await down(seat.rigId);

    const node = seatResult(await restoreFrom(snapshotId, { startupFrom: "stored" }));

    expect(node.status, JSON.stringify(node)).toBe("fresh-primed");
    expect(releaseOf(delivered.flat())).toEqual(["CULTURE.md:A", "guidance/role.md:A"]);
    expect(storedReads(seat.nodeId)).toBe("ok");
  });

  it("the guidance holds, context not JSON, checkpoint_only: rig launch starts it from the snapshot's copy and heals it", async () => {
    const seat = await launchRig({ record: false });
    db.prepare("UPDATE sessions SET restore_policy = 'checkpoint_only' WHERE node_id = ?").run(seat.nodeId);
    await down(seat.rigId);
    malformed(seat.nodeId, "json");

    const launched = await launchWithoutFresh(seat.rigId);

    expect(launched.ok, JSON.stringify(launched)).toBe(true);
    expect(launched.ok && launched.launched.map((n) => n.startupSource)).toEqual([{ kind: "snapshot", reason: "saved_context_unreadable" }]);
    expect(releaseOf(delivered.flat())).toEqual(["CULTURE.md:A", "guidance/role.md:A"]);
    expect(storedReads(seat.nodeId)).toBe("ok");
  });

  it("the guidance holds, context not JSON, default policy: rig launch resumes and leaves it unreadable", async () => {
    const seat = await launchRig({ record: false });
    db.prepare("UPDATE sessions SET restore_policy = 'resume_if_possible' WHERE node_id = ?").run(seat.nodeId);
    await down(seat.rigId);
    malformed(seat.nodeId, "json");

    const launched = await launchWithoutFresh(seat.rigId);

    expect(launched.ok, JSON.stringify(launched)).toBe(true);
    expect(releaseOf(delivered.flat())).toEqual([]);
    expect(storedReads(seat.nodeId)).toBe("startup_context_malformed");
  });

  it("the guidance holds, context not JSON: rig up --existing fails with restore_error and starts nothing", async () => {
    const seat = await launchRig({ record: false });
    const snapshotId = await down(seat.rigId);
    malformed(seat.nodeId, "json");

    const restored = await restoreFrom(snapshotId, { startupFrom: "stored" });

    expect(restored).toMatchObject({ ok: false, code: "restore_error" });
    expect(releaseOf(delivered.flat())).toEqual([]);
    expect(storedReads(seat.nodeId)).toBe("startup_context_malformed");
  });

  // Reviewer's PIN-M7 (review of fc2d5b96, rev-of32s3-pin.test.ts), adopted as written.
  it("PIN-M7 a seat refused before launch gets its prior binding and session states back", async () => {
    const seat = await launchRig();
    db.prepare("UPDATE sessions SET restore_policy = 'checkpoint_only' WHERE node_id = ?").run(seat.nodeId);
    const snapshotId = await down(seat.rigId);
    // A seat that was bound and detached (not exited) when the restore began.
    sessionRegistry.updateBinding(seat.nodeId, { tmuxSession: "dev-impl@team" });
    const latest = db.prepare("SELECT id FROM sessions WHERE node_id = ? ORDER BY id DESC LIMIT 1").get(seat.nodeId) as { id: string };
    sessionRegistry.updateStatus(latest.id, "detached");
    fs.unlinkSync(path.join(root, "library", "team"));
    const before = { binding: sessionRegistry.getBindingForNode(seat.nodeId)?.tmuxSession ?? null,
      statuses: db.prepare("SELECT id, status FROM sessions WHERE node_id = ? ORDER BY id").all(seat.nodeId) };
    // Jim's scope: only a --fresh seat can be refused before its launch, so the pin restores it listed.
    const node = seatResult(await restoreFrom(snapshotId));
    expect(node.status).toBe("failed");
    expect(node.error).toContain("Fresh start refused");
    const after = { binding: sessionRegistry.getBindingForNode(seat.nodeId)?.tmuxSession ?? null,
      statuses: db.prepare("SELECT id, status FROM sessions WHERE node_id = ? ORDER BY id").all(seat.nodeId) };
    expect(before.binding).toBe("dev-impl@team");
    expect(after).toEqual(before);
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
