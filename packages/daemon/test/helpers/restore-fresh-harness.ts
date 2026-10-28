// Shared fixture for tests that run the REAL restore orchestrator and the restore-check over the same seat states
// (restore-check-predicts-refusals.test.ts). Same world as restore-fresh-reread.test.ts: a spec library link, three
// releases, a Claude adapter that records what it delivers, an in-memory tmux.
import { vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./test-app.js";
import { RigRepository } from "../../src/domain/rig-repository.js";
import { PodRepository } from "../../src/domain/pod-repository.js";
import { SessionRegistry } from "../../src/domain/session-registry.js";
import { EventBus } from "../../src/domain/event-bus.js";
import { NodeLauncher } from "../../src/domain/node-launcher.js";
import { StartupOrchestrator } from "../../src/domain/startup-orchestrator.js";
import { PodRigInstantiator } from "../../src/domain/rigspec-instantiator.js";
import { FIXTURE_SPEC_SOURCE_TRUST } from "./spec-source-trust.js";
import type { SpecSourceTrust } from "../../src/domain/recorded-spec-source-judge.js";
import { SnapshotRepository } from "../../src/domain/snapshot-repository.js";
import { SnapshotCapture } from "../../src/domain/snapshot-capture.js";
import { CheckpointStore } from "../../src/domain/checkpoint-store.js";
import { RigTeardownOrchestrator } from "../../src/domain/rig-teardown.js";
import { RestoreOrchestrator } from "../../src/domain/restore-orchestrator.js";
import type { RuntimeAdapter, ResolvedStartupFile } from "../../src/domain/runtime-adapter.js";
import type { TmuxAdapter, TmuxResult } from "../../src/adapters/tmux.js";
import { guardedAgentRefFsOps } from "../../src/domain/agent-ref-guard.js";
import { mergeManagedBlock } from "../../src/domain/managed-blocks.js";

const blockFs = {
  exists: (p: string) => fs.existsSync(p),
  readFile: (p: string) => fs.readFileSync(p, "utf-8"),
  writeFile: (p: string, c: string) => fs.writeFileSync(p, c),
  mkdirp: (p: string) => fs.mkdirSync(p, { recursive: true }),
};

export const RIG = (name = "team") => `version: "0.2"
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
export const AGENT = (version: string) => `name: impl
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

export function writeRelease(dir: string, version: string) {
  fs.mkdirSync(path.join(dir, "agents", "impl", "guidance"), { recursive: true });
  fs.writeFileSync(path.join(dir, "rig.yaml"), RIG());
  fs.writeFileSync(path.join(dir, "CULTURE.md"), `# culture ${version}\n`);
  fs.writeFileSync(path.join(dir, "agents", "impl", "agent.yaml"), AGENT(version));
  fs.writeFileSync(path.join(dir, "agents", "impl", "guidance", "role.md"), `# role ${version}\n`);
}


export interface RestoreHarness {
  root: string; current: string; linkSpec: string; workdir: string;
  db: Database.Database; rigRepo: RigRepository; snapshotRepo: SnapshotRepository; sessionRegistry: SessionRegistry;
  snapshotCapture: SnapshotCapture; tmux: TmuxAdapter; adapter: RuntimeAdapter; inst: PodRigInstantiator;
  restore: RestoreOrchestrator; delivered: ResolvedStartupFile[][];
  /** The trust the instantiator judges a recorded spec source by; a row that needs an untrusted source empties `roots`. */
  specSourceTrust: SpecSourceTrust;
  launchRig(opts?: { record?: boolean }): Promise<{ rigId: string; nodeId: string; sessionName: string }>;
  down(rigId: string): Promise<string>;
  retarget(sha: string): void;
  cleanup(): void;
}

export function createRestoreHarness(): RestoreHarness {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "of32-restorecheck-")));
  for (const [sha, version] of [["aaaaaaa", "1.0.0"], ["bbbbbbb", "2.0.0"], ["ccccccc", "3.0.0"]] as const) {
    writeRelease(path.join(root, "releases", sha, "rigs", "team"), version);
  }
  const current = path.join(root, "releases", "current");
  fs.symlinkSync(path.join(root, "releases", "aaaaaaa"), current);
  fs.mkdirSync(path.join(root, "library"));
  fs.symlinkSync(path.join(current, "rigs", "team"), path.join(root, "library", "team"));
  const linkSpec = path.join(root, "library", "team", "rig.yaml");
  const workdir = path.join(root, "work");
  fs.mkdirSync(workdir);

  const db = createFullTestDb();
  const rigRepo = new RigRepository(db);
  const sessionRegistry = new SessionRegistry(db);
  const eventBus = new EventBus(db);
  const snapshotRepo = new SnapshotRepository(db);
  const checkpointStore = new CheckpointStore(db);
  const snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });
  const alive = new Set<string>();
  const panes = new Map<string, string>();
  // a2: session options live with the session, as in tmux: a new (or recreated) session starts with none.
  const options = new Map<string, Map<string, string>>();
  const tmux = {
    createSession: vi.fn(async (name: string) => {
      if (alive.has(name)) return { ok: false as const, code: "duplicate_session", message: "duplicate" };
      alive.add(name);
      panes.set(name, "%fresh");
      options.set(name, new Map());
      return { ok: true as const };
    }),
    killSession: vi.fn(async (name: string): Promise<TmuxResult> => { alive.delete(name); panes.delete(name); options.delete(name); return { ok: true }; }),
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
    setSessionOption: vi.fn(async (name: string, key: string, value: string) => {
      if (!alive.has(name)) return { ok: false as const, code: "session_not_found", message: "no session" };
      options.get(name)!.set(key, value);
      return { ok: true as const };
    }),
    readSessionOption: vi.fn(async (name: string, key: string) =>
      alive.has(name) ? { ok: true as const, value: options.get(name)?.get(key) || null } : { ok: false as const, error: `can't find session: ${name}` }),
  } as unknown as TmuxAdapter;
  const delivered: ResolvedStartupFile[][] = [];
  const adapter: RuntimeAdapter = {
    runtime: "claude-code",
    listInstalled: async () => [],
    project: async () => ({ projected: [], skipped: [], failed: [] }),
    deliverStartup: async (files, binding) => {
      delivered.push(files);
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
  const specSourceTrust: SpecSourceTrust = { ...FIXTURE_SPEC_SOURCE_TRUST };
  const inst = new PodRigInstantiator({
    specSourceTrust,
    db, rigRepo, podRepo: new PodRepository(db), sessionRegistry, eventBus, nodeLauncher, startupOrchestrator,
    fsOps: { ...guardedAgentRefFsOps, readFile: (p: string) => fs.readFileSync(p, "utf-8"), exists: (p: string) => fs.existsSync(p) },
    adapters: { "claude-code": adapter },
    tmuxAdapter: tmux,
    onboardingEnabledResolver: () => false,
  } as never);
  const restore = new RestoreOrchestrator({
    db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture, checkpointStore, nodeLauncher, tmuxAdapter: tmux,
    claudeResume: { canResume: () => false, resume: vi.fn() } as never,
    codexResume: { canResume: () => false, resume: vi.fn() } as never,
    listProcesses: async () => [],
    seatStartupSource: inst,
  } as never);
  const harness: RestoreHarness = {
    root, current, linkSpec, workdir, db, rigRepo, snapshotRepo, sessionRegistry, snapshotCapture, tmux, adapter, inst, restore, delivered, specSourceTrust,
    async launchRig(opts) {
      const realSpec = fs.realpathSync(linkSpec);
      const outcome = await inst.instantiate(fs.readFileSync(realSpec, "utf-8"), path.dirname(realSpec), {
        cwdOverride: workdir,
        ...(opts?.record === false ? {} : { specSourcePath: linkSpec }),
      });
      if (!outcome.ok) throw new Error(`launch failed: ${JSON.stringify(outcome)}`);
      const node = rigRepo.getRig(outcome.result.rigId)!.nodes[0]!;
      delivered.length = 0;
      return { rigId: outcome.result.rigId, nodeId: node.id, sessionName: "dev-impl@team" };
    },
    async down(rigId) {
      const result = await new RigTeardownOrchestrator({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux, snapshotCapture, eventBus }).teardown(rigId);
      if (!result.snapshotId) throw new Error(`teardown wrote no snapshot: ${JSON.stringify(result)}`);
      delivered.length = 0;
      return result.snapshotId;
    },
    retarget(sha) { fs.unlinkSync(current); fs.symlinkSync(path.join(root, "releases", sha), current); },
    cleanup() { db.close(); fs.rmSync(root, { recursive: true, force: true }); },
  };
  return harness;
}
