// OF-88: Pi and OMP `rig send` readiness comes from the runner's sidecar, not the pane classifier. Production
// consequence: a runner pane whose last reply ends in a question read as an interactive prompt, so `rig send`
// refused once the hook went 15 s stale and --wait-for-idle timed out after 5 minutes idle.
// Deployed chain: startup.ts builds runtimeAdapterMap (piAdapter, ompAdapter) and passes
// runnerSendReadinessFromAdapters(map) to SessionTransport; the runner (pi-runner.ts RunnerCore) writes the sidecar.
// Three layers here: the runner writes busy/attention; the adapter reads them; the real transport acts on the answer.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import { runnerSendReadinessFromAdapters, type RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import { PiRuntimeAdapter } from "../src/adapters/pi-runtime-adapter.js";
import { OmpRuntimeAdapter } from "../src/adapters/omp-runtime-adapter.js";
import { piSeatPaths, type PiRunnerState } from "../src/adapters/pi-runner-protocol.js";
import { RunnerCore, type RunnerIo } from "../src/adapters/pi-runner.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const SEAT = "dev-pi@my-rig";
// A reply ending in a question: the pane classifier reads it as a permission prompt.
const F1_FRAME = ["you ▸ plan it", "Plan drafted.", "Do you want to proceed with the migration?", "── idle ──"].join("\n");
const SESSION_FILE = "/state/pi/dev-pi@my-rig/sessions/s.jsonl";

// ── Layer 1: what the runner writes ──
describe("OF-88 runner: the sidecar carries the runner's turn state", () => {
  function core(runtime: "pi" | "omp") {
    const sidecars: PiRunnerState[] = [];
    const io: RunnerIo = {
      sendRpc: () => undefined, mirrorLine: () => undefined, mirrorAppend: () => undefined,
      postActivity: () => undefined, writeSidecar: (s) => sidecars.push(s), now: () => "2026-10-27T10:00:00Z",
    };
    const c = new RunnerCore(io, { sessionName: SEAT, launchId: "l1" }, { runtime });
    c.start();
    c.handlePiLine(JSON.stringify({ type: "response", id: "pi-runner-get-state", data: { sessionFile: SESSION_FILE, sessionId: "s" } }));
    return { c, last: () => sidecars.at(-1)! };
  }

  it("ready and idle at start; busy from agent_start until agent_end", () => {
    const { c, last } = core("pi");
    expect(last()).toMatchObject({ ready: true, busy: false });
    c.handlePiLine(JSON.stringify({ type: "agent_start" }));
    expect(last()).toMatchObject({ ready: true, busy: true });
    c.handlePiLine(JSON.stringify({ type: "agent_end" }));
    expect(last()).toMatchObject({ ready: true, busy: false });
  });

  it("OMP: a cancelled approval is attention in the sidecar, through the end of the turn, cleared by the next agent_start", () => {
    const { c, last } = core("omp");
    c.handlePiLine(JSON.stringify({ type: "agent_start" }));
    c.handlePiLine(JSON.stringify({ type: "extension_ui_request", method: "confirm", id: "a1" }));
    expect(last()).toMatchObject({ attention: "permission_prompt" });
    c.handlePiLine(JSON.stringify({ type: "agent_end" }));
    expect(last()).toMatchObject({ busy: false, attention: "permission_prompt" });
    c.handlePiLine(JSON.stringify({ type: "agent_start" }));
    expect(last().attention).toBeUndefined();
  });

  it("OMP: a successful automatic retry clears the runtime_error attention from the sidecar (no agent_start in between)", () => {
    const { c, last } = core("omp");
    c.handlePiLine(JSON.stringify({ type: "agent_start" }));
    c.handlePiLine(JSON.stringify({ type: "turn_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "529 overloaded" } }));
    expect(last()).toMatchObject({ attention: "runtime_error" });
    c.handlePiLine(JSON.stringify({ type: "auto_retry_start" }));
    expect(last().attention).toBeUndefined();
  });
});

// ── Layer 2 and 3: the adapter and the real transport over a real sidecar file ──
describe("OF-88 adapter and transport: rig send to a Pi/OMP seat answered by the sidecar", () => {
  let db: Database.Database;
  let dir: string;
  let stateRoot: string;
  beforeEach(() => {
    db = createFullTestDb();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "of88-pi-send-"));
    stateRoot = path.join(dir, "state", "pi");
    fs.mkdirSync(piSeatPaths(stateRoot, SEAT).seatRoot, { recursive: true });
    const rigRepo = new RigRepository(db);
    const rig = rigRepo.createRig("my-rig");
    const node = rigRepo.addNode(rig.id, "dev.pi", { role: "worker", runtime: "pi" });
    const sessions = new SessionRegistry(db);
    const session = sessions.registerSession(node.id, SEAT);
    sessions.updateStatus(session.id, "running");
    sessions.updateBinding(node.id, { tmuxSession: SEAT });
  });
  afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const sidecarPath = () => piSeatPaths(stateRoot, SEAT).runnerStatePath;
  function sidecar(over: Record<string, unknown> | null = {}): void {
    if (over === null) { fs.rmSync(sidecarPath(), { force: true }); return; }
    fs.writeFileSync(sidecarPath(), JSON.stringify({ ready: true, launchId: "l1", updatedAt: new Date().toISOString(), busy: false, ...over }));
  }

  function setup(paneCommand: string) {
    const sendText = vi.fn(async () => ({ ok: true as const }));
    const sendKeys = vi.fn(async () => ({ ok: true as const }));
    const tmux = {
      hasSession: async () => true, probeSession: async () => ({ state: "present" as const }), sendText, sendKeys,
      capturePaneContent: async () => F1_FRAME, createSession: async () => ({ ok: true as const }), killSession: async () => ({ ok: true as const }),
      listSessions: async () => [], listWindows: async () => [], listPanes: async () => [],
      startPipePane: async () => ({ ok: true as const }), stopPipePane: async () => ({ ok: true as const }),
      getPanePid: async () => null, getPaneCommand: async () => paneCommand,
    } as unknown as TmuxAdapter;
    const deps = {
      tmux, stateRoot, runnerEntryPath: "/x/pi-runner.js",
      fsOps: { readFile: (p: string) => fs.readFileSync(p, "utf8"), exists: (p: string) => fs.existsSync(p),
        writeFile: () => undefined, mkdirp: () => undefined },
    };
    const pi = new PiRuntimeAdapter(deps);
    const omp = new OmpRuntimeAdapter(deps);
    // As startup.ts builds it: the factory over the map holding every runtime.
    const map: Record<string, RuntimeAdapter> = { "claude-code": { runtime: "claude-code" } as RuntimeAdapter, pi, omp };
    const transport = new SessionTransport({
      db, rigRepo: new RigRepository(db), sessionRegistry: new SessionRegistry(db), tmuxAdapter: tmux,
      agentActivityStore: new AgentActivityStore({ db, eventBus: new EventBus(db) }), eventBus: new EventBus(db), waitForIdlePollMs: 1,
      runnerSendReadiness: runnerSendReadinessFromAdapters(map),
    });
    return { pi, omp, map, transport, sendText, sendKeys };
  }
  const target = { sessionName: SEAT, nodeId: null };

  it("the factory over the adapter map asks pi and omp, and only the runner runtimes", () => {
    const { map } = setup("node");
    expect([...runnerSendReadinessFromAdapters(map).runtimes].sort()).toEqual(["omp", "pi"]);
  });

  it("adapter: idle, running, attention read from the sidecar; evidence is the runner sidecar", async () => {
    const { pi, omp } = setup("node");
    sidecar();
    expect(await pi.sendReadiness(target)).toMatchObject({ state: "idle", reason: "runner_idle", evidenceSource: "runner_sidecar", runtime: "pi" });
    sidecar({ busy: true });
    expect(await pi.sendReadiness(target)).toMatchObject({ state: "running", reason: "run_active" });
    sidecar({ attention: "runtime_error" });
    expect(await omp.sendReadiness(target)).toMatchObject({ state: "needs_input", reason: "runtime_error", runtime: "omp" });
  });

  it.each([
    ["no sidecar", null],
    ["not ready", { ready: false }],
    ["exited", { exited: { code: 1, at: "2026-10-27T10:00:00Z" } }],
    ["a sidecar from a runner older than OF-88 (no busy field)", { busy: undefined }],
  ])("adapter: %s is no runner answer (null), so today's logic decides", async (_name, over) => {
    const { pi } = setup("node");
    sidecar(over as Record<string, unknown> | null);
    expect(await pi.sendReadiness(target)).toBeNull();
  });

  it("adapter: an unparseable sidecar is no answer, not a throw", async () => {
    const { pi } = setup("node");
    fs.writeFileSync(sidecarPath(), "{not json");
    expect(await pi.sendReadiness(target)).toBeNull();
  });

  it("transport: an idle runner decides; the question-ending frame on screen does not refuse the send", async () => {
    sidecar();
    const { transport, sendText } = setup("node");
    const r = await transport.send(SEAT, "hello");
    expect(r.ok).toBe(true);
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it("transport: a busy runner does not refuse a default send (the runner steers it); the adapter row above pins running", async () => {
    sidecar({ busy: true });
    const { transport, sendText } = setup("node");
    const r = await transport.send(SEAT, "hello");
    expect(r.ok).toBe(true);
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it("transport: the pane back at a shell (runner killed, sidecar still ready) refuses, 0 bytes", async () => {
    sidecar();
    const { transport, sendText, sendKeys } = setup("-zsh");
    const r = await transport.send(SEAT, "hello");
    expect(r.ok).toBe(false);
    expect(sendText).not.toHaveBeenCalled();
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it("transport: runner needs-input offers no unbracketed override: --dangerously-interact is refused, 0 bytes", async () => {
    sidecar({ attention: "permission_prompt" });
    const { transport, sendText } = setup("node");
    const r = await transport.send(SEAT, "next");
    expect(r.ok).toBe(false);
    expect(r.activity).toMatchObject({ state: "needs_input", reason: "permission_prompt", evidenceSource: "runner_sidecar" });
    const forced = await transport.send(SEAT, "next", { dangerouslyInteract: true, reason: "drive it" });
    expect(forced.ok).toBe(false);
    expect(forced.reason).toBe("runner_input_no_override");
    expect(sendText).not.toHaveBeenCalled();
  });

  it("transport: an old-runner sidecar (no busy) falls back to the pane logic, which reads the question frame as a prompt (today's behaviour)", async () => {
    sidecar({ busy: undefined });
    const { transport, sendText } = setup("node");
    const r = await transport.send(SEAT, "hello");
    expect(r.ok).toBe(false);
    expect(r.activity?.evidenceSource).not.toBe("runner_sidecar");
    expect(sendText).not.toHaveBeenCalled();
  });
});
