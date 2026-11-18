// workspaces-o9o.91, through the real fresh-launch path (verify-sec: the arteries rule). A stub scenario cannot reach this: the
// refusal happens only when a recorded spec source is re-read (rig seat launch --fresh, a --fresh restore, spec-source set,
// set-mcp), and the scenario runner binds only up, down, send, restart and daemon (restore is unbound); nor can a scenario put
// the running install's daemon folder under a git checkout or a spec inside that install. So this file drives
// SeatLifecycleService.launchFresh -> PodRigInstantiator.readSeatStartupFromSpec -> judgeRecordedSpec (rigspec-instantiator.ts)
// with the production path judge on a real filesystem: a fake Homebrew-style install under a prefix that holds .git, in a
// trusted base outside temp, with Homebrew's modes, and the rig recorded from a spec INSIDE that install's specs folder (as the
// kernel boot records the bundled kernel spec). The install is laid out as <prefix>/opt/openrig/daemon (see build()).
import { TMP_CREDENTIAL_FILES } from "./helpers/credential-files.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
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
import { specSourceTrustOf } from "../src/domain/recorded-spec-source-judge.js";
import { DEFAULT_PATH_JUDGE_IO } from "../src/domain/codex-mcp-servers.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";
import { guardedAgentRefFsOps } from "../src/domain/agent-ref-guard.js";
import { reconcileSkillLoadout } from "../src/domain/skill-catalog.js";
import { makeTrustedBase } from "./helpers/trusted-scaffold.js";
import { tmuxStub } from "./helpers/tmux-stub.js";

const RIG = `version: "0.2"
name: team
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
const AGENT = `name: impl
version: "1.0.0"
profiles:
  default:
    uses: {}
startup:
  files:
    - path: guidance/role.md
      delivery_hint: guidance_merge
      required: true
  actions: []
`;

/** Remove group and other write everywhere under `root` (this host's umask is 0002; Homebrew installs 0755/0644). */
function homebrewModes(root: string): void {
  const st = fs.lstatSync(root);
  if (st.isSymbolicLink()) return;
  fs.chmodSync(root, st.mode & 0o755);
  if (st.isDirectory()) for (const name of fs.readdirSync(root)) homebrewModes(path.join(root, name));
}

describe("o9o.91: a fresh launch from the running install's own spec, under a git-checkout prefix", () => {
  let base: string;
  let daemonDir: string;
  let spec: string;
  let workdir: string;
  let db: Database.Database;
  let alive: Set<string>;
  let tmux: TmuxAdapter;

  /** The service and instantiator, with the production judge; `runningInstall` as startup would pass it, or none. */
  function wire(runningInstall: (() => string) | null) {
    const rigRepo = new RigRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    const adapter: RuntimeAdapter = {
      runtime: "claude-code",
      listInstalled: async () => [],
      project: async () => ({ projected: [], skipped: [], failed: [] }),
      deliverStartup: async (files) => ({ delivered: files.length, failed: [] }),
      launchHarness: async () => ({ ok: true, resumeToken: "native-uuid", resumeType: "claude_session_id" }),
      checkReady: async () => ({ ready: true }),
    };
    const specRoots = () => [path.join(daemonDir, "specs")];
    const trust = specSourceTrustOf({ specRoots, io: DEFAULT_PATH_JUDGE_IO, ...(runningInstall ? { runningInstall } : {}) });
    const nodeLauncher = new NodeLauncher({ credentialFiles: TMP_CREDENTIAL_FILES, db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    const startupOrchestrator = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux, sleep: async () => undefined });
    const inst = new PodRigInstantiator({
      specSourceTrust: trust,
      db, rigRepo, podRepo: new PodRepository(db), sessionRegistry, eventBus, nodeLauncher, startupOrchestrator,
      fsOps: { ...guardedAgentRefFsOps, readFile: (p: string) => fs.readFileSync(p, "utf-8"), exists: (p: string) => fs.existsSync(p) },
      adapters: { "claude-code": adapter },
      tmuxAdapter: tmux,
      onboardingEnabledResolver: () => false,
      skillsRootResolver: () => path.join(base, "no-catalog"),
      skillReconciler: vi.fn(reconcileSkillLoadout),
    } as never);
    const service = new SeatLifecycleService({
      db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux, nodeLauncher, startupOrchestrator,
      runtimeAdapters: { "claude-code": adapter },
      listProcesses: async () => [],
      seatStartupSource: inst,
      mcpTrust: { io: DEFAULT_PATH_JUDGE_IO, specRoots, ...(runningInstall ? { runningInstall } : {}) },
    } as never);
    return { inst, service };
  }

  /** Launch as the kernel boot does: from the install's own spec, recording that path as the rig's spec source. */
  async function launchFromInstall(inst: PodRigInstantiator) {
    const outcome = await inst.instantiate(fs.readFileSync(spec, "utf-8"), path.dirname(spec), { cwdOverride: workdir, specSourcePath: spec });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    return "dev-impl@team";
  }

  function build(opts: { prefixGit: boolean }) {
    base = makeTrustedBase("o9o91-fresh-");
    const prefix = path.join(base, "homebrew");
    if (opts.prefixGit) fs.mkdirSync(path.join(prefix, ".git"), { recursive: true });
    // Not the @openrig/cli/daemon layout: a launch re-anchors a path in a RECOGNISED install layout onto the running daemon's own
    // specs (here, this checkout's), which in production are the same folder. The trust decision does not depend on the layout
    // (the install is injected and matched by identity); the Homebrew layout itself is covered through the judge in
    // running-install-spec-trust.test.ts.
    daemonDir = path.join(prefix, "opt", "openrig", "daemon");
    const rigDir = path.join(daemonDir, "specs", "rigs", "team");
    fs.mkdirSync(path.join(rigDir, "agents", "impl", "guidance"), { recursive: true });
    fs.mkdirSync(path.join(daemonDir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(rigDir, "rig.yaml"), RIG);
    fs.writeFileSync(path.join(rigDir, "CULTURE.md"), "# culture\n");
    fs.writeFileSync(path.join(rigDir, "agents", "impl", "agent.yaml"), AGENT);
    fs.writeFileSync(path.join(rigDir, "agents", "impl", "guidance", "role.md"), "# role\n");
    spec = path.join(rigDir, "rig.yaml");
    workdir = path.join(base, "work");
    fs.mkdirSync(workdir);
    homebrewModes(base);
  }

  beforeEach(() => {
    db = createFullTestDb();
    alive = new Set();
    tmux = tmuxStub({
      createSession: vi.fn(async (name: string) => { alive.add(name); return { ok: true as const }; }),
      killSession: vi.fn(async (name: string): Promise<TmuxResult> => { alive.delete(name); return { ok: true }; }),
      probeSession: vi.fn(async (name: string) => alive.has(name) ? { state: "present" as const } : { state: "absent" as const }),
      hasSession: vi.fn(async (name: string) => alive.has(name)),
      startServer: vi.fn(async (): Promise<TmuxResult> => ({ ok: true })),
      listSessions: vi.fn(async () => [...alive].map((name) => ({ name, windows: 1, created: "", attached: false }))),
      listWindows: vi.fn(async () => []),
      listPanes: vi.fn(async (name: string) => alive.has(name) ? [{ id: "%fresh", index: 0, cwd: workdir, width: 80, height: 24, active: true }] : []),
      getPanePid: vi.fn(async () => 4242),
      getPaneCommand: vi.fn(async () => "claude"),
      sendText: vi.fn(async () => ({ ok: true as const })),
      sendKeys: vi.fn(async () => ({ ok: true as const })),
      setSessionOption: vi.fn(async () => ({ ok: true as const })),
    });
  });
  afterEach(() => {
    db.close();
    if (base) fs.rmSync(base, { recursive: true, force: true });
  });

  it("with the running install named (as startup names it), the fresh relaunch re-reads the recorded spec and launches", async () => {
    build({ prefixGit: true });
    const { inst, service } = wire(() => daemonDir);
    const seat = await launchFromInstall(inst);
    const result = await service.launchFresh({ seatRef: seat, fresh: true, stop: true, reason: "o9o.91" });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  });

  it("without it (the behaviour before o9o.91), the same relaunch is refused with startup_source_untrusted, naming the git tree", async () => {
    build({ prefixGit: true });
    const { inst, service } = wire(null);
    const seat = await launchFromInstall(inst);
    const result = await service.launchFresh({ seatRef: seat, fresh: true, stop: true, reason: "o9o.91" });
    expect(result).toMatchObject({ ok: false, code: "startup_source_untrusted" });
    expect(!result.ok && result.message).toContain("lies inside the git work tree");
  });

  it("control: with no .git at the prefix, the relaunch launches even with no install named", async () => {
    build({ prefixGit: false });
    const { inst, service } = wire(null);
    const seat = await launchFromInstall(inst);
    const result = await service.launchFresh({ seatRef: seat, fresh: true, stop: true, reason: "o9o.91" });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  });
});
