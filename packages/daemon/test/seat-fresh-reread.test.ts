// OF-32 stage 2: `rig seat launch --fresh` re-reads the rig's spec as it is now. The live failure: a rig launched
// from a spec library link (library -> current -> release <sha>) kept delivering the first release's role and
// culture to every fresh seat, because fresh launch replayed the absolute paths stored at first launch.
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
import type { RuntimeAdapter, ResolvedStartupFile } from "../src/domain/runtime-adapter.js";
import type { ProjectionPlan } from "../src/domain/projection-planner.js";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";
import { reanchorShippedSpecPath } from "../src/domain/builtin-startup-files.js";
import { guardedAgentRefFsOps } from "../src/domain/agent-ref-guard.js";
import { reconcileSkillLoadout } from "../src/domain/skill-catalog.js";

const RIG = (name = "team", agentRef = "local:agents/impl", extra = "") => `version: "0.2"
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
        cwd: .${extra}
    edges: []
edges: []
`;
const AGENT = (version: string) => `name: impl
version: "${version}"
resources:
  skills:
    - id: team-skill
      path: skills/team-skill
profiles:
  default:
    uses:
      skills: [team-skill]
startup:
  files:
    - path: guidance/role.md
      delivery_hint: guidance_merge
      required: true
  actions: []
`;

/** One release folder: rig.yaml, CULTURE.md and the agent with its role file. */
function writeRelease(dir: string, version: string, rigYaml = RIG()) {
  fs.mkdirSync(path.join(dir, "agents", "impl", "guidance"), { recursive: true });
  fs.writeFileSync(path.join(dir, "rig.yaml"), rigYaml);
  fs.writeFileSync(path.join(dir, "CULTURE.md"), `# culture ${version}\n`);
  fs.writeFileSync(path.join(dir, "agents", "impl", "agent.yaml"), AGENT(version));
  fs.writeFileSync(path.join(dir, "agents", "impl", "guidance", "role.md"), `# role ${version}\n`);
  fs.mkdirSync(path.join(dir, "agents", "impl", "skills", "team-skill"), { recursive: true });
  fs.writeFileSync(path.join(dir, "agents", "impl", "skills", "team-skill", "SKILL.md"), `---\nname: team-skill\ndescription: fixture ${version}\n---\n`);
}

describe("OF-32 fresh launch re-reads the rig's spec source", () => {
  let root: string;
  let releaseA: string;
  let releaseB: string;
  let current: string;
  let linkSpec: string;
  let workdir: string;
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let alive: Set<string>;
  let tmux: TmuxAdapter;
  let adapter: RuntimeAdapter;
  let delivered: ResolvedStartupFile[][];
  let projected: ProjectionPlan[];
  let inst: PodRigInstantiator;
  let service: SeatLifecycleService;
  let reconciler: ReturnType<typeof vi.fn<typeof reconcileSkillLoadout>>;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "of32-fresh-")));
    releaseA = path.join(root, "releases", "aaaaaaa", "rigs", "team");
    releaseB = path.join(root, "releases", "bbbbbbb", "rigs", "team");
    writeRelease(releaseA, "1.0.0");
    writeRelease(releaseB, "2.0.0");
    // ~/.agents-release/current -> <sha>; the library links through current, as on Jim's machine.
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
    const eventBus = new EventBus(db);
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
      sendText: vi.fn(async () => ({ ok: true as const })),
      sendKeys: vi.fn(async () => ({ ok: true as const })),
      setSessionOption: vi.fn(async () => ({ ok: true as const })),
    } as unknown as TmuxAdapter;
    delivered = [];
    projected = [];
    reconciler = vi.fn(reconcileSkillLoadout);
    adapter = {
      runtime: "claude-code",
      listInstalled: async () => [],
      project: async (plan) => { projected.push(plan); return { projected: [], skipped: [], failed: [] }; },
      deliverStartup: async (files) => { delivered.push(files); return { delivered: files.length, failed: [] }; },
      launchHarness: async () => ({ ok: true, resumeToken: "native-uuid", resumeType: "claude_session_id" }),
      checkReady: async () => ({ ready: true }),
    };
    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    const startupOrchestrator = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux, sleep: async () => undefined });
    inst = new PodRigInstantiator({
      db, rigRepo, podRepo: new PodRepository(db), sessionRegistry, eventBus, nodeLauncher, startupOrchestrator,
      // The production agent-ref guard (OF-16): realpath confinement and the guarded agent.yaml read.
      fsOps: { ...guardedAgentRefFsOps, readFile: (p: string) => fs.readFileSync(p, "utf-8"), exists: (p: string) => fs.existsSync(p) },
      adapters: { "claude-code": adapter },
      tmuxAdapter: tmux,
      onboardingEnabledResolver: () => false,
      // The production S04 reconciler, against an explicitly empty catalog.
      skillsRootResolver: () => path.join(root, "no-catalog"),
      skillReconciler: reconciler,
    } as never);
    service = new SeatLifecycleService({
      db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux, nodeLauncher, startupOrchestrator,
      runtimeAdapters: { "claude-code": adapter },
      listProcesses: async () => [],
      seatStartupSource: inst,
    } as never);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Launch the rig as `rig up team` does: from the real file, recording the library link. */
  async function launchRig(opts?: { record?: boolean; cwdOverride?: string }) {
    const realSpec = fs.realpathSync(linkSpec);
    const outcome = await inst.instantiate(fs.readFileSync(realSpec, "utf-8"), path.dirname(realSpec), {
      cwdOverride: opts?.cwdOverride ?? workdir,
      ...(opts?.record === false ? {} : { specSourcePath: linkSpec }),
    });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) throw new Error("launch failed");
    const node = rigRepo.getRig(outcome.result.rigId)!.nodes[0]!;
    const firstLaunchPlan = projected.at(-1);
    delivered = [];
    projected = [];
    return { rigId: outcome.result.rigId, node, sessionName: "dev-impl@team", firstLaunchPlan };
  }

  const releaseOf = (files: ResolvedStartupFile[]) => files
    .filter((f) => f.path === "guidance/role.md" || f.path === "CULTURE.md")
    .map((f) => `${f.path}:${f.absolutePath.includes(`${path.sep}bbbbbbb${path.sep}`) ? "B" : f.absolutePath.includes(`${path.sep}aaaaaaa${path.sep}`) ? "A" : f.absolutePath}`)
    .sort();
  const storedFiles = (nodeId: string) => JSON.parse((db.prepare("SELECT resolved_files_json FROM node_startup_context WHERE node_id = ?").get(nodeId) as { resolved_files_json: string }).resolved_files_json) as ResolvedStartupFile[];
  const nodeSpec = (nodeId: string) => db.prepare("SELECT resolved_spec_version AS version, resolved_spec_hash AS hash FROM nodes WHERE id = ?").get(nodeId) as { version: string; hash: string };
  const retarget = (sha: string) => { fs.unlinkSync(current); fs.symlinkSync(path.join(root, "releases", sha), current); };

  it("a fresh seat delivers the release the library link points at now, and records it", async () => {
    const seat = await launchRig();
    expect(releaseOf(storedFiles(seat.node.id))).toEqual(["CULTURE.md:A", "guidance/role.md:A"]);
    expect(nodeSpec(seat.node.id).version).toBe("1.0.0");
    retarget("bbbbbbb");

    const result = await service.launchFresh({ seatRef: seat.sessionName, fresh: true, stop: true, reason: "new persona release" });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    // What the new occupant was given: release B's role and culture, not the first launch's.
    expect(releaseOf(delivered.flat())).toEqual(["CULTURE.md:B", "guidance/role.md:B"]);
    // What the next fresh or restore replay starts from, and the agent provenance, moved together.
    expect(releaseOf(storedFiles(seat.node.id))).toEqual(["CULTURE.md:B", "guidance/role.md:B"]);
    expect(nodeSpec(seat.node.id).version).toBe("2.0.0");
    expect(result).toMatchObject({ startupSource: { kind: "spec", specSource: linkSpec, specPath: path.join(releaseB, "rig.yaml") } });
    const event = db.prepare("SELECT payload FROM events WHERE type = 'seat.fresh_launched' ORDER BY seq DESC LIMIT 1").get() as { payload: string };
    expect(JSON.parse(event.payload)).toMatchObject({ startupSource: "spec", specSource: linkSpec });
    // The seat keeps its own working folder; the spec's `cwd: .` does not move it.
    expect(projected.at(-1)?.cwd).toBe(workdir);
    // OF-32 N6, the one sanctioned change of this pin. Stage 2 pinned "the live skill set is not reinstalled": a re-read
    // projected no skill at all, so a release that added or changed a skill was delivered only in part. The plan's
    // skill entries still stay out of the adapter's projection (S04's reconciler owns the live skill set, as on the
    // stored path); what changed is that the re-read now runs that reconciler, as first launch does: checked before
    // the stop (apply false), applied before the launch (apply true), same cwd and same owner as first launch.
    // Delivery itself is pinned in reread-skill-reconcile.test.ts.
    expect(seat.firstLaunchPlan?.entries.some((e) => e.category === "skill")).toBe(true);
    expect(projected.at(-1)?.entries.some((e) => e.category === "skill")).toBe(false);
    expect(reconciler.mock.calls.map(([call]) => `${call.apply}:${call.cwd}:${call.topologyOwner}`)).toEqual([
      `true:${workdir}:dev-impl@team`, `false:${workdir}:dev-impl@team`, `true:${workdir}:dev-impl@team`,
    ]);
  });

  it("the new context row and the agent provenance are written together or not at all", async () => {
    const seat = await launchRig();
    retarget("bbbbbbb");
    db.exec("CREATE TRIGGER of32_refuse_provenance BEFORE UPDATE OF resolved_spec_hash ON nodes BEGIN SELECT RAISE(ABORT, 'fixture: provenance write refused'); END;");
    const result = await service.launchFresh({ seatRef: seat.sessionName, fresh: true, stop: true, reason: "release b" });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("Startup context persistence failed");
    // Neither half landed: the saved context still names release A, and the provenance is A's.
    expect(releaseOf(storedFiles(seat.node.id))).toEqual(["CULTURE.md:A", "guidance/role.md:A"]);
    expect(nodeSpec(seat.node.id).version).toBe("1.0.0");
  });

  it("the policy hash a fresh launch reports is the hash of the context it saved", async () => {
    const seat = await launchRig();
    retarget("bbbbbbb");
    const fresh = await service.launchFresh({ seatRef: seat.sessionName, fresh: true, stop: true, reason: "release b" });
    const replay = await service.planFresh({ seatRef: seat.sessionName, fresh: true, stop: true, startupFrom: "stored" });
    expect(fresh.ok && replay.ok).toBe(true);
    if (!fresh.ok || !replay.ok) return;
    // planFresh does not echo the hash; launch again from stored and compare the reported hashes.
    const again = await service.launchFresh({ seatRef: seat.sessionName, fresh: true, stop: true, reason: "replay", startupFrom: "stored" });
    expect(again.ok && again.startupPolicyHash).toBe(fresh.startupPolicyHash);
  });

  it("--startup-from stored replays the first launch's files and leaves provenance alone", async () => {
    const seat = await launchRig();
    retarget("bbbbbbb");
    const result = await service.launchFresh({ seatRef: seat.sessionName, fresh: true, stop: true, reason: "keep persona", startupFrom: "stored" });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(releaseOf(delivered.flat())).toEqual(["CULTURE.md:A", "guidance/role.md:A"]);
    expect(nodeSpec(seat.node.id).version).toBe("1.0.0");
    expect(result).toMatchObject({ startupSource: { kind: "stored", reason: "requested" } });
  });

  it.each([
    ["the release folder was deleted", () => fs.rmSync(path.join(root, "releases", "bbbbbbb"), { recursive: true }), "startup_source_unavailable", "no longer exists"],
    ["the library link was removed", () => fs.unlinkSync(path.join(root, "library", "team")), "startup_source_unavailable", "no longer exists"],
    ["the spec no longer parses", () => fs.writeFileSync(path.join(releaseB, "rig.yaml"), "pods: [unclosed"), "startup_source_unavailable", "parse"],
    ["the seat's agent is gone", () => fs.rmSync(path.join(releaseB, "agents"), { recursive: true }), "startup_source_unavailable", "local:agents/impl"],
    ["the seat's agent ref changed", () => fs.writeFileSync(path.join(releaseB, "rig.yaml"), RIG("team", "local:agents/other")), "startup_source_changed", "agent_ref local:agents/other"],
    ["the seat's runtime changed", () => fs.writeFileSync(path.join(releaseB, "rig.yaml"), RIG().replace("runtime: claude-code", "runtime: codex")), "startup_source_changed", "runtime codex"],
    ["the seat's profile changed", () => fs.writeFileSync(path.join(releaseB, "rig.yaml"), RIG().replace("profile: default", "profile: other")), "startup_source_changed", "profile other"],
    // OF-16 parity on the re-read: the agent folder may not leave the spec tree, as at first launch.
    ["the seat's agent folder links outside the spec tree", () => {
      const outside = path.join(root, "outside", "impl");
      fs.mkdirSync(path.join(outside, "guidance"), { recursive: true });
      fs.writeFileSync(path.join(outside, "agent.yaml"), AGENT("9.9.9"));
      fs.writeFileSync(path.join(outside, "guidance", "role.md"), "# outside\n");
      fs.rmSync(path.join(releaseB, "agents", "impl"), { recursive: true });
      fs.symlinkSync(outside, path.join(releaseB, "agents", "impl"));
    }, "startup_source_unavailable", "outside"],
    // The first-launch preflight, for this seat, before anything is stopped.
    ["the culture file is over the size limit", () => fs.writeFileSync(path.join(releaseB, "CULTURE.md"), "x".repeat(300 * 1024)), "startup_source_unavailable", "preflight"],
    ["the culture file is hard-linked", () => {
      const other = path.join(root, "other-culture.md");
      fs.writeFileSync(other, "# other\n");
      fs.rmSync(path.join(releaseB, "CULTURE.md"));
      fs.linkSync(other, path.join(releaseB, "CULTURE.md"));
    }, "startup_source_unavailable", "preflight"],
    ["a required startup file is missing", () => fs.rmSync(path.join(releaseB, "agents", "impl", "guidance", "role.md")), "startup_source_unavailable", "required startup file guidance/role.md"],
    // OF-63: the seat's recorded working folder is part of the first-launch preflight too (tmux would start the seat in $HOME).
    ["the seat's working folder was deleted", () => fs.rmSync(workdir, { recursive: true }), "startup_source_unavailable", "work' does not exist; a seat launched there would silently start in $HOME"],
  ] as const)("refuses with the reason, before stopping anything, when %s", async (_label, damage, code, reason) => {
    const seat = await launchRig();
    retarget("bbbbbbb");
    damage();
    const stopped = vi.mocked(tmux.killSession).mock.calls.length;

    const plan = await service.planFresh({ seatRef: seat.sessionName, fresh: true, stop: true });
    const result = await service.launchFresh({ seatRef: seat.sessionName, fresh: true, stop: true, reason: "release b" });

    expect(result).toMatchObject({ ok: false, code, guidance: expect.stringContaining("--startup-from stored") });
    expect(!result.ok && result.message).toContain(linkSpec);
    expect(!result.ok && result.message).toContain(reason);
    expect(plan).toMatchObject({ ok: false, code, launchable: false });
    // The live occupant was not touched and nothing was delivered.
    expect(vi.mocked(tmux.killSession).mock.calls.length).toBe(stopped);
    expect(alive.has(seat.sessionName)).toBe(true);
    expect(delivered).toEqual([]);
    expect(releaseOf(storedFiles(seat.node.id))).toEqual(["CULTURE.md:A", "guidance/role.md:A"]);
  });

  // OF-38: the TUI's explicit-fresh action cannot pass `startupFrom`, so a refusal there must not tell the operator to
  // "run again with --startup-from stored". It names the CLI command that starts the seat on the stored files instead.
  // The CLI and the HTTP seat route can pass the option, and keep the flag wording.
  it.each([
    ["the release folder was deleted", () => fs.rmSync(path.join(root, "releases", "bbbbbbb"), { recursive: true }), "no longer exists"],
    ["a required startup file is missing", () => fs.rmSync(path.join(releaseB, "agents", "impl", "guidance", "role.md")), "required startup file guidance/role.md"],
    ["the spec no longer parses", () => fs.writeFileSync(path.join(releaseB, "rig.yaml"), "pods: [unclosed"), "parse"],
  ] as const)("OF-38: when %s, a surface that cannot pass --startup-from is told the CLI command, not the flag", async (_label, damage, reason) => {
    const seat = await launchRig();
    retarget("bbbbbbb");
    damage();
    const command = `rig seat launch 'dev.impl@team' --fresh --startup-from stored --reason "<why>"`;

    const tui = await service.launchFresh({ seatRef: seat.sessionName, fresh: true, stop: false, reason: "tui", storedEscape: "command" });
    const cli = await service.launchFresh({ seatRef: seat.sessionName, fresh: true, stop: true, reason: "cli" });

    expect(!tui.ok && tui.message).toContain(reason);
    expect(!tui.ok && "guidance" in tui && tui.guidance).toBe(`Restore or fix the spec at that path, or start only this seat with the startup files saved at its last successful launch: ${command}.`);
    expect(!cli.ok && "guidance" in cli && cli.guidance).toBe("Restore or fix the spec at that path, or run again with --startup-from stored to replay the startup files saved at the seat's last successful launch.");
  });

  it("control: an agent folder linked to a sibling inside the spec tree is accepted", async () => {
    const seat = await launchRig();
    retarget("bbbbbbb");
    const inside = path.join(releaseB, "agents", "impl-real");
    fs.renameSync(path.join(releaseB, "agents", "impl"), inside);
    fs.symlinkSync(inside, path.join(releaseB, "agents", "impl"));
    const result = await service.launchFresh({ seatRef: seat.sessionName, fresh: true, stop: true, reason: "inside link" });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    // As at first launch, the agent is resolved through the guard's realpath: the saved role file names the real folder.
    const role = storedFiles(seat.node.id).find((f) => f.path === "guidance/role.md")!;
    expect(role.absolutePath).toBe(path.join(inside, "guidance", "role.md"));
  });

  // N1: a launch that fails leaves the saved context (what --startup-from stored and restore replay) as it was.
  it("a fresh launch that fails keeps the saved startup files and provenance, so stored still replays them", async () => {
    const seat = await launchRig();
    retarget("bbbbbbb");
    adapter.launchHarness = async () => ({ ok: false, error: "fixture: harness refused", recovery: "none" } as never);
    const failed = await service.launchFresh({ seatRef: seat.sessionName, fresh: true, stop: true, reason: "release b" });
    expect(failed.ok).toBe(false);
    expect(releaseOf(storedFiles(seat.node.id))).toEqual(["CULTURE.md:A", "guidance/role.md:A"]);
    expect(nodeSpec(seat.node.id).version).toBe("1.0.0");
    adapter.launchHarness = async () => ({ ok: true, resumeToken: "native-uuid-2", resumeType: "claude_session_id" });
    delivered = [];
    const replay = await service.launchFresh({ seatRef: seat.sessionName, fresh: true, stop: true, reason: "back", startupFrom: "stored" });
    expect(replay.ok, JSON.stringify(replay)).toBe(true);
    expect(releaseOf(delivered.flat())).toEqual(["CULTURE.md:A", "guidance/role.md:A"]);
  });

  // N3: a seat the spec does not declare has only its saved files; it replays them with a warning instead of refusing,
  // so the TUI fresh choice and the rig up / rig start accept-fresh path (which cannot pass a flag) keep working.
  it("a seat the spec no longer declares replays its saved files with a warning", async () => {
    const seat = await launchRig();
    retarget("bbbbbbb");
    fs.writeFileSync(path.join(releaseB, "rig.yaml"), RIG().replace("id: impl", "id: other"));
    const result = await service.launchFresh({ seatRef: seat.sessionName, fresh: true, stop: true, reason: "dropped" });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(releaseOf(delivered.flat())).toEqual(["CULTURE.md:A", "guidance/role.md:A"]);
    expect(result).toMatchObject({ startupSource: { kind: "stored", reason: "not_in_spec" } });
    expect(result.warnings?.[0]).toContain(`does not declare dev.impl`);
  });

  it("a seat added with rig add after launch replays its saved files with a warning", async () => {
    const seat = await launchRig();
    const added = await inst.addMemberToPod(seat.rigId, "dev", { id: "extra", agent_ref: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: "." },
      path.dirname(fs.realpathSync(linkSpec)), { cwdOverride: workdir });
    expect(added.ok, JSON.stringify(added)).toBe(true);
    retarget("bbbbbbb");
    delivered = [];
    const plan = await service.planFresh({ seatRef: "dev-extra@team", fresh: true, stop: true });
    const result = await service.launchFresh({ seatRef: "dev-extra@team", fresh: true, stop: true, reason: "added seat" });
    expect(plan).toMatchObject({ ok: true, startup: { source: { kind: "stored", reason: "not_in_spec" } } });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result).toMatchObject({ startupSource: { kind: "stored", reason: "not_in_spec" } });
    expect(result.warnings?.[0]).toContain("does not declare dev.extra");
  });

  // X4: the identity a re-read delivers names the rig, not the spec (a project rig is named after its project).
  it("the re-read uses the rig's own name, not the name inside the spec", async () => {
    const seat = await launchRig();
    retarget("bbbbbbb");
    fs.writeFileSync(path.join(releaseB, "rig.yaml"), RIG("renamed-in-spec"));
    const result = await service.launchFresh({ seatRef: seat.sessionName, fresh: true, stop: true, reason: "release b" });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const actions = JSON.parse((db.prepare("SELECT startup_actions_json FROM node_startup_context WHERE node_id = ?").get(seat.node.id) as { startup_actions_json: string }).startup_actions_json) as Array<{ builtin?: string; value: string }>;
    const identity = actions.find((a) => a.builtin === "session_identity")!.value;
    expect(identity).toContain("- rig: team");
    expect(identity).not.toContain("renamed-in-spec");
  });

  // N5: a relative recorded source would depend on the daemon's working folder; it is refused.
  it("refuses a relative recorded spec source", async () => {
    const seat = await launchRig();
    rigRepo.setRigSpecSource(seat.rigId, "library/team/rig.yaml");
    const plan = await service.planFresh({ seatRef: seat.sessionName, fresh: true, stop: true });
    const result = await service.launchFresh({ seatRef: seat.sessionName, fresh: true, stop: true, reason: "relative" });
    expect(plan).toMatchObject({ ok: false, code: "startup_source_unavailable", launchable: false });
    expect(result).toMatchObject({ ok: false, code: "startup_source_unavailable" });
    expect(!result.ok && result.message).toContain("not an absolute path");
    expect(alive.has(seat.sessionName)).toBe(true);
  });

  it("a rig with no recorded source replays the stored files and says so", async () => {
    const seat = await launchRig({ record: false });
    retarget("bbbbbbb");
    const result = await service.launchFresh({ seatRef: seat.sessionName, fresh: true, stop: true, reason: "legacy rig" });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(releaseOf(delivered.flat())).toEqual(["CULTURE.md:A", "guidance/role.md:A"]);
    expect(result).toMatchObject({ startupSource: { kind: "stored", reason: "no_recorded_source" } });
    expect(result.warnings?.[0]).toContain("records no spec source");
  });

  it("the preview reports the source and counts of the re-read, without writing", async () => {
    const seat = await launchRig();
    retarget("bbbbbbb");
    const before = storedFiles(seat.node.id);
    const plan = await service.planFresh({ seatRef: seat.sessionName, fresh: true, stop: true });
    expect(plan).toMatchObject({ ok: true, startup: { source: { kind: "spec", specSource: linkSpec, specPath: path.join(releaseB, "rig.yaml") } } });
    expect(storedFiles(seat.node.id)).toEqual(before);
    expect(nodeSpec(seat.node.id).version).toBe("1.0.0");
    expect(delivered).toEqual([]);
  });
});

describe("OF-32 a recorded shipped spec source follows the running install", () => {
  const running = "/opt/new/node_modules/@openrig/cli/daemon/specs";
  it.each([
    ["a packaged install, even while it exists", "/opt/old/node_modules/@openrig/cli/daemon/specs/rigs/launch/kernel/rig-claude-only.yaml", () => true, `${running}/rigs/launch/kernel/rig-claude-only.yaml`],
    ["a dev checkout whose file is gone", "/src/openrig/packages/daemon/specs/rigs/starter/rig.yaml", () => false, `${running}/rigs/starter/rig.yaml`],
    ["a dev checkout whose file is present", "/src/openrig/packages/daemon/specs/rigs/starter/rig.yaml", () => true, "/src/openrig/packages/daemon/specs/rigs/starter/rig.yaml"],
    ["a library link outside any install", "/home/u/.openrig/specs/team/rig.yaml", () => false, "/home/u/.openrig/specs/team/rig.yaml"],
  ] as const)("%s", (_label, recorded, exists, expected) => {
    expect(reanchorShippedSpecPath(recorded, running, exists)).toBe(expected);
  });
});
