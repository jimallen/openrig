// OF-71 / OF-69: a kernel-shaped rig (a builtin:terminal seat) re-reads its spec on `rig up --existing --fresh` and
// `rig seat launch --fresh`. The live failure (Sparky, 2026-10-21): the re-read resolved every member's agent_ref, and
// builtin:terminal has no agent to resolve, so the fresh start was refused with "Cannot resolve agent_ref" although the
// same seat had started at first boot. It worked only through `--startup-from stored`.
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
import { TerminalAdapter } from "../src/adapters/terminal-adapter.js";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";
import { guardedAgentRefFsOps } from "../src/domain/agent-ref-guard.js";

const KERNEL = (command: string) => `version: "0.2"
name: kernel
culture_file: CULTURE.md
pods:
  - id: operator
    label: Operator
    members:
      - id: human
        agent_ref: "builtin:terminal"
        profile: none
        runtime: terminal
        cwd: .
        startup:
          files: []
          actions:
            - type: send_text
              value: "${command}"
              phase: after_ready
              idempotent: true
              applies_on: [fresh_start]
    edges: []
edges: []
`;

describe("OF-71 a builtin:terminal seat starts fresh from its re-read spec", () => {
  let root: string;
  let specPath: string;
  let workdir: string;
  let db: Database.Database;
  let rigRepo: RigRepository;
  let alive: Set<string>;
  let tmux: TmuxAdapter;
  let sent: string[];
  let inst: PodRigInstantiator;
  let service: SeatLifecycleService;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "u12-terminal-")));
    fs.writeFileSync(path.join(root, "CULTURE.md"), "# culture\n");
    specPath = path.join(root, "rig.yaml");
    fs.writeFileSync(specPath, KERNEL("echo first"));
    workdir = path.join(root, "work");
    fs.mkdirSync(workdir);

    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    alive = new Set();
    sent = [];
    tmux = {
      createSession: vi.fn(async (name: string) => {
        if (alive.has(name)) return { ok: false as const, code: "duplicate_session", message: "duplicate" };
        alive.add(name);
        return { ok: true as const };
      }),
      killSession: vi.fn(async (name: string): Promise<TmuxResult> => { alive.delete(name); return { ok: true }; }),
      probeSession: vi.fn(async (name: string) => alive.has(name) ? { state: "present" as const } : { state: "absent" as const }),
      hasSession: vi.fn(async (name: string) => alive.has(name)),
      startServer: vi.fn(async (): Promise<TmuxResult> => ({ ok: true })),
      listSessions: vi.fn(async () => [...alive].map((name) => ({ name, windows: 1, created: "", attached: false }))),
      listWindows: vi.fn(async () => []),
      listPanes: vi.fn(async (name: string) => alive.has(name) ? [{ id: "%t", index: 0, cwd: workdir, width: 80, height: 24, active: true }] : []),
      getPanePid: vi.fn(async () => 4242),
      getPaneCommand: vi.fn(async () => "zsh"),
      sendText: vi.fn(async (_name: string, text: string) => { sent.push(text); return { ok: true as const }; }),
      sendKeys: vi.fn(async () => ({ ok: true as const })),
      setSessionOption: vi.fn(async () => ({ ok: true as const })),
    } as unknown as TmuxAdapter;
    const terminal = new TerminalAdapter();
    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    const startupOrchestrator = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux, sleep: async () => undefined });
    inst = new PodRigInstantiator({
      specSourceTrust: { ...FIXTURE_SPEC_SOURCE_TRUST, roots: () => [root] },
      db, rigRepo, podRepo: new PodRepository(db), sessionRegistry, eventBus, nodeLauncher, startupOrchestrator,
      fsOps: { ...guardedAgentRefFsOps, readFile: (p: string) => fs.readFileSync(p, "utf-8"), exists: (p: string) => fs.existsSync(p) },
      adapters: { terminal },
      tmuxAdapter: tmux,
      onboardingEnabledResolver: () => false,
      skillsRootResolver: () => path.join(root, "no-catalog"),
    } as never);
    service = new SeatLifecycleService({
      db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux, nodeLauncher, startupOrchestrator,
      runtimeAdapters: { terminal },
      listProcesses: async () => [],
      seatStartupSource: inst,
    } as never);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function launchKernel() {
    const outcome = await inst.instantiate(fs.readFileSync(specPath, "utf-8"), root, { cwdOverride: workdir, specSourcePath: specPath });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) throw new Error("first launch failed");
    sent = [];
    return { rigId: outcome.result.rigId, nodeId: rigRepo.getRig(outcome.result.rigId)!.nodes[0]!.id, sessionName: "operator-human@kernel" };
  }
  const storedActions = (nodeId: string) => (db.prepare("SELECT startup_actions_json AS a FROM node_startup_context WHERE node_id = ?").get(nodeId) as { a: string }).a;

  it("a fresh launch of the terminal seat succeeds and delivers the CURRENT spec's start command, not the saved one", async () => {
    const seat = await launchKernel();
    expect(storedActions(seat.nodeId)).toContain("echo first");
    fs.writeFileSync(specPath, KERNEL("echo second"));

    const result = await service.launchFresh({ seatRef: seat.sessionName, fresh: true, stop: true, reason: "kernel restore" });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result).toMatchObject({ startupSource: { kind: "spec", specPath } });
    expect(sent.join("\n")).toContain("echo second");
    expect(sent.join("\n")).not.toContain("echo first");
    expect(storedActions(seat.nodeId)).toContain("echo second");
  });

  it("the plan says the same: launchable from the spec", async () => {
    const seat = await launchKernel();
    const plan = await service.planFresh({ seatRef: seat.sessionName, fresh: true, stop: true });
    expect(plan).toMatchObject({ ok: true, startup: { source: { kind: "spec", specPath } } });
  });

  it("a terminal seat's missing folder still refuses the fresh launch before stopping anything", async () => {
    const seat = await launchKernel();
    fs.rmSync(workdir, { recursive: true });
    const stopped = vi.mocked(tmux.killSession).mock.calls.length;

    const result = await service.launchFresh({ seatRef: seat.sessionName, fresh: true, stop: true, reason: "kernel restore" });

    expect(result).toMatchObject({ ok: false, code: "startup_source_unavailable" });
    expect(!result.ok && result.message).toContain("does not exist");
    expect(vi.mocked(tmux.killSession).mock.calls.length).toBe(stopped);
    expect(alive.has(seat.sessionName)).toBe(true);
  });

  // OF-69: the stored route, the one the operator was sent to for OF-71, no longer skips the folder check.
  // The launcher is the backstop when the folder goes between the early check and the launch: its code must survive.
  it("OF-69: the launcher's seat_cwd_unusable refusal keeps its code through the fresh launch (not launch_failed)", async () => {
    const seat = await launchKernel();
    vi.spyOn(NodeLauncher.prototype, "launchNode").mockResolvedValueOnce({ ok: false, code: "seat_cwd_unusable", message: "fixture: folder went away" });

    const result = await service.launchFresh({ seatRef: seat.sessionName, fresh: true, stop: true, reason: "kernel restore", startupFrom: "stored" });

    expect(result).toMatchObject({ ok: false, code: "seat_cwd_unusable", message: "fixture: folder went away" });
  });

  it("OF-69: --startup-from stored with a deleted seat folder is refused BEFORE the live occupant is stopped, and the plan says so", async () => {
    const seat = await launchKernel();
    fs.rmSync(workdir, { recursive: true });
    const created = vi.mocked(tmux.createSession).mock.calls.length;
    const killed = vi.mocked(tmux.killSession).mock.calls.length;
    const sessionRows = () => db.prepare("SELECT id, status FROM sessions ORDER BY id").all();
    const rowsBefore = sessionRows();

    // The preview must not promise a launch the execution refuses (review F1: it said launchable:true, wouldStop:true).
    const plan = await service.planFresh({ seatRef: seat.sessionName, fresh: true, stop: true, startupFrom: "stored" });
    expect(plan).toMatchObject({ ok: true, launchable: false, wouldStop: false });
    expect(plan.ok && plan.blockers.map((b) => b.code)).toContain("seat_cwd_unusable");

    const result = await service.launchFresh({ seatRef: seat.sessionName, fresh: true, stop: true, reason: "kernel restore", startupFrom: "stored" });

    // The seat is the way it was: still alive, nothing killed, no session row touched, nothing started.
    expect(result).toMatchObject({ ok: false, code: "seat_cwd_unusable" });
    expect(!result.ok && result.message).toContain(`its cwd '${workdir}' does not exist`);
    expect(!result.ok && "guidance" in result && result.guidance).toContain(`Create the folder ${workdir}`);
    expect(alive.has(seat.sessionName)).toBe(true);
    expect(vi.mocked(tmux.killSession).mock.calls.length).toBe(killed);
    expect(vi.mocked(tmux.createSession).mock.calls.length).toBe(created);
    expect(sessionRows()).toEqual(rowsBefore);
  });
});
