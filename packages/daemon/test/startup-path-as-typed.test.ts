// OF-99: a seat whose agent_ref is a path through a symlink keeps its startup files recorded under the path AS TYPED,
// so a fresh launch, a restore and a compaction restore replay whatever the link points to NOW, not the release that was
// current when the pod was added. (The kernel rig `path:~/.agents-release/current/agents/rsi-engineer` pinned d4f6a482.)
import type { StartupFrom } from "../src/domain/seat-startup-source.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
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

const RIG = (agentRef: string, name = "team") => `version: "0.2"
name: ${name}
culture_file: CULTURE.md
pods:
  - id: dev
    label: Dev
    members:
      - id: impl
        agent_ref: "${agentRef}"
        profile: default
        runtime: claude-code
        cwd: .
    edges: []
edges: []
`;
const AGENT = (version: string) => `name: impl
version: "${version}"
resources:
  skills:
    - id: persona-skill
      path: skills/persona-skill
  guidance:
    - id: persona-guidance
      path: guidance/persona-guidance.md
      target: claude_md
      merge: managed_block
profiles:
  default:
    uses:
      skills: [persona-skill]
      guidance: [persona-guidance]
startup:
  files:
    - path: guidance/role.md
      delivery_hint: guidance_merge
      required: true
  actions: []
`;

function writeRelease(dir: string, version: string) {
  fs.mkdirSync(path.join(dir, "agents", "impl", "guidance"), { recursive: true });
  fs.writeFileSync(path.join(dir, "agents", "impl", "agent.yaml"), AGENT(version));
  fs.writeFileSync(path.join(dir, "agents", "impl", "guidance", "role.md"), `# role ${version}\n`);
  fs.writeFileSync(path.join(dir, "agents", "impl", "guidance", "persona-guidance.md"), `# persona guidance ${version}\n`);
  fs.mkdirSync(path.join(dir, "agents", "impl", "skills", "persona-skill"), { recursive: true });
  fs.writeFileSync(path.join(dir, "agents", "impl", "skills", "persona-skill", "SKILL.md"), `# persona skill ${version}\n`);
}

describe("OF-99: startup files are recorded under the agent_ref path as typed", () => {
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
  let roleTexts: string[];
  let inst: PodRigInstantiator;
  let service: SeatLifecycleService;
  let restore: RestoreOrchestrator;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "of99-typed-")));
    for (const [sha, version] of [["aaaaaaa", "1.0.0"], ["bbbbbbb", "2.0.0"], ["ccccccc", "3.0.0"]] as const) {
      writeRelease(path.join(root, "releases", sha), version);
    }
    current = path.join(root, "releases", "current");
    fs.symlinkSync(path.join(root, "releases", "aaaaaaa"), current);
    // The rig spec itself is a plain file; only the persona folder is reached through the `current` link.
    fs.mkdirSync(path.join(root, "rig"));
    linkSpec = path.join(root, "rig", "rig.yaml");
    fs.writeFileSync(linkSpec, RIG(`path:${path.join(current, "agents", "impl")}`));
    fs.writeFileSync(path.join(root, "rig", "CULTURE.md"), "# culture\n");
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
    roleTexts = [];
    adapter = {
      runtime: "claude-code",
      listInstalled: async () => [],
      project: async () => ({ projected: [], skipped: [], failed: [] }),
      deliverStartup: async (files, binding) => {
        delivered.push(files);
        // What the adapter actually READ for each file at delivery: the evidence of which release a seat was given.
        for (const file of files) if (file.path === "guidance/role.md") roleTexts.push(fs.readFileSync(file.absolutePath, "utf-8").trim());
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

  async function launchRig() {
    const outcome = await inst.instantiate(fs.readFileSync(linkSpec, "utf-8"), path.dirname(linkSpec), {
      cwdOverride: workdir,
    });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) throw new Error("launch failed");
    const node = rigRepo.getRig(outcome.result.rigId)!.nodes[0]!;
    delivered = [];
    roleTexts = [];
    return { rigId: outcome.result.rigId, nodeId: node.id, sessionName: "dev-impl@team" };
  }

  const storedFiles = (nodeId: string) => JSON.parse((db.prepare("SELECT resolved_files_json FROM node_startup_context WHERE node_id = ?").get(nodeId) as { resolved_files_json: string }).resolved_files_json) as ResolvedStartupFile[];
  const nodeVersion = (nodeId: string) => (db.prepare("SELECT resolved_spec_version AS v FROM nodes WHERE id = ?").get(nodeId) as { v: string }).v;
  const nodeHash = (nodeId: string) => (db.prepare("SELECT resolved_spec_hash AS h FROM nodes WHERE id = ?").get(nodeId) as { h: string }).h;
  const retarget = (sha: string) => { fs.unlinkSync(current); fs.symlinkSync(path.join(root, "releases", sha), current); };
  const down = async (rigId: string) => {
    const result = await new RigTeardownOrchestrator({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux, snapshotCapture, eventBus }).teardown(rigId);
    expect(result.snapshotId, JSON.stringify(result)).toBeTruthy();
    delivered = [];
    roleTexts = [];
    return result.snapshotId!;
  };
  const restoreFrom = (snapshotId: string, opts: { fresh?: boolean; startupFrom?: StartupFrom } = {}) => restore.restore(snapshotId, {
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

  const seatResult = (outcome: Awaited<ReturnType<RestoreOrchestrator["restore"]>>) => {
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) throw new Error("restore refused");
    return outcome.result.nodes.find((n) => n.logicalId === "dev.impl")!;
  };

  const expectRoleFrom = (version: string) => expect(roleTexts).toEqual([`# role ${version}`]);

  it("the stored startup context names the persona's role.md under the path as typed (through the link), not a release dir", async () => {
    const seat = await launchRig();
    const role = storedFiles(seat.nodeId).find((f) => f.path === "guidance/role.md")!;
    expect(role.absolutePath).toBe(path.join(current, "agents", "impl", "guidance", "role.md"));
    expect(role.ownerRoot).toBe(path.join(current, "agents", "impl"));
    const entries = JSON.parse((db.prepare("SELECT projection_entries_json AS j FROM node_startup_context WHERE node_id = ?").get(seat.nodeId) as { j: string }).j) as Array<{ category: string; sourcePath: string; absolutePath: string }>;
    // The fixture persona uses one skill and one guidance resource; without them this loop would run over nothing.
    expect(entries.map((e) => e.category).sort()).toEqual(["guidance", "skill"]);
    for (const e of entries) {
      expect(e.absolutePath.startsWith(path.join(current, "agents", "impl") + path.sep), e.absolutePath).toBe(true);
      expect(e.sourcePath, e.sourcePath).toBe(path.join(current, "agents", "impl"));
      expect(e.absolutePath.includes(`${path.sep}releases${path.sep}aaaaaaa${path.sep}`), e.absolutePath).toBe(false);
    }
  });

  it("`rig seat launch --fresh` replays the release the link points at NOW (no spec source is recorded)", async () => {
    const seat = await launchRig();
    retarget("bbbbbbb");

    const fresh = await service.launchFresh({ seatRef: seat.sessionName, fresh: true, stop: true, reason: "release b" });

    expect(fresh.ok, JSON.stringify(fresh)).toBe(true);
    expectRoleFrom("2.0.0");
  });

  // OF-122 (Jim, 2026-10-27): a launch from stored context refreshes the recorded version and hash to the release the
  // typed path reaches now, so `rig whoami` names what the seat was actually given. (Characterized as stale until then.)
  const sha256Of = (file: string) => createHash("sha256").update(fs.readFileSync(file, "utf-8")).digest("hex");

  it("after a retarget, a fresh launch replays the new release and the recorded version and hash become the new release's", async () => {
    const seat = await launchRig();
    expect(nodeVersion(seat.nodeId)).toBe("1.0.0");
    const hashBefore = nodeHash(seat.nodeId);
    expect(hashBefore).toBe(sha256Of(path.join(root, "releases", "aaaaaaa", "agents", "impl", "agent.yaml")));
    retarget("bbbbbbb");

    const fresh = await service.launchFresh({ seatRef: seat.sessionName, fresh: true, stop: true, reason: "release b" });

    expect(fresh.ok, JSON.stringify(fresh)).toBe(true);
    expectRoleFrom("2.0.0");
    expect(nodeVersion(seat.nodeId)).toBe("2.0.0");
    expect(nodeHash(seat.nodeId)).toBe(sha256Of(path.join(root, "releases", "bbbbbbb", "agents", "impl", "agent.yaml")));
    expect(nodeHash(seat.nodeId)).not.toBe(hashBefore);
  });

  // Review v7 finding 2: a context saved before OF-99 holds the release's real path, so a replay of it delivers that release;
  // refreshing from the typed path (which reaches another release now) would name a release the seat is not given.
  it("a saved context recorded under the release's real path (before OF-99) keeps its recorded version and hash", async () => {
    const seat = await launchRig();
    const hashBefore = nodeHash(seat.nodeId);
    const typedDir = path.join(current, "agents", "impl");
    const realDir = path.join(root, "releases", "aaaaaaa", "agents", "impl");
    for (const col of ["resolved_files_json", "projection_entries_json"]) {
      const text = (db.prepare(`SELECT ${col} AS v FROM node_startup_context WHERE node_id = ?`).get(seat.nodeId) as { v: string }).v;
      db.prepare(`UPDATE node_startup_context SET ${col} = ? WHERE node_id = ?`).run(text.split(typedDir).join(realDir), seat.nodeId);
    }
    retarget("bbbbbbb");

    const fresh = await service.launchFresh({ seatRef: seat.sessionName, fresh: true, stop: true, reason: "legacy row" });

    expect(fresh.ok, JSON.stringify(fresh)).toBe(true);
    expectRoleFrom("1.0.0");
    expect(nodeVersion(seat.nodeId)).toBe("1.0.0");
    expect(nodeHash(seat.nodeId)).toBe(hashBefore);
  });

  it("a seat whose agent_ref is not a typed path keeps its recorded version and hash (a local: ref has no rig root to re-read from)", async () => {
    const seat = await launchRig();
    const hashBefore = nodeHash(seat.nodeId);
    db.prepare("UPDATE nodes SET agent_ref = ? WHERE id = ?").run("local:agents/impl", seat.nodeId);
    retarget("bbbbbbb");

    const fresh = await service.launchFresh({ seatRef: seat.sessionName, fresh: true, stop: true, reason: "local ref" });

    expect(fresh.ok, JSON.stringify(fresh)).toBe(true);
    expectRoleFrom("2.0.0");
    expect(nodeVersion(seat.nodeId)).toBe("1.0.0");
    expect(nodeHash(seat.nodeId)).toBe(hashBefore);
  });

  it("a launch that fails leaves the recorded version and hash as they were", async () => {
    const seat = await launchRig();
    const hashBefore = nodeHash(seat.nodeId);
    retarget("bbbbbbb");
    tmux.createSession = vi.fn(async () => ({ ok: false as const, code: "unknown", message: "tmux refused" }));

    const fresh = await service.launchFresh({ seatRef: seat.sessionName, fresh: true, stop: true, reason: "release b" });

    expect(fresh.ok).toBe(false);
    expect(nodeVersion(seat.nodeId)).toBe("1.0.0");
    expect(nodeHash(seat.nodeId)).toBe(hashBefore);
  });

  it("a restore that starts the seat fresh replays the release the link points at NOW", async () => {
    const seat = await launchRig();
    const snapshotId = await down(seat.rigId);
    retarget("bbbbbbb");

    const node = seatResult(await restoreFrom(snapshotId));

    expect(node.status, JSON.stringify(node)).toBe("fresh-primed");
    expectRoleFrom("2.0.0");
    expect(nodeVersion(seat.nodeId)).toBe("2.0.0");
  });

  it("a restore of a seat not listed with --fresh (a compaction-style restore of its saved setup) also follows the link", async () => {
    const seat = await launchRig();
    db.prepare("UPDATE sessions SET restore_policy = 'checkpoint_only' WHERE node_id = ?").run(seat.nodeId);
    const snapshotId = await down(seat.rigId);
    retarget("ccccccc");

    const node = seatResult(await restoreFrom(snapshotId, { fresh: false }));

    expect(node.status, JSON.stringify(node)).toBe("fresh-primed");
    expectRoleFrom("3.0.0");
  });

  it("CONTROL: a path with no symlink in it is stored and replayed exactly as typed", async () => {
    fs.writeFileSync(linkSpec, RIG(`path:${path.join(root, "releases", "bbbbbbb", "agents", "impl")}`));
    const seat = await launchRig();
    const role = storedFiles(seat.nodeId).find((f) => f.path === "guidance/role.md")!;
    expect(role.absolutePath).toBe(path.join(root, "releases", "bbbbbbb", "agents", "impl", "guidance", "role.md"));
    retarget("ccccccc");
    const fresh = await service.launchFresh({ seatRef: seat.sessionName, fresh: true, stop: true, reason: "control" });
    expect(fresh.ok, JSON.stringify(fresh)).toBe(true);
    expectRoleFrom("2.0.0");
  });
});
