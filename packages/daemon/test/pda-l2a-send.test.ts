// pda runtime L2a: `rig send` to a pda seat, through the REAL chain production wires: the real PdaRuntimeAdapter
// reading a real sidecar file, runnerSendReadinessFromAdapters over an adapter map (as startup.ts builds it), and the
// real SessionTransport (L0's seam). Design T17, T26, T28 and the null fallback. tmux is a stub; nothing is sent
// anywhere but into its recorder.
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
import { PdaRuntimeAdapter } from "../src/adapters/pda-runtime-adapter.js";
import { pdaSeatPaths, type PdaRunnerState } from "../src/adapters/pda-runner-protocol.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const SEAT = "dev-research@my-rig";
// The review's frame F1: a reply ending in a question, which the pane classifier reads as a permission prompt.
const F1_FRAME = ["you ▸ plan it", "Plan drafted.", "Do you want to proceed with the migration?", "── idle ──"].join("\n");

let db: Database.Database;
let dir: string;
let stateRoot: string;
beforeEach(() => {
  db = createFullTestDb();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pda-l2a-send-"));
  stateRoot = path.join(dir, "state", "pda");
  fs.mkdirSync(pdaSeatPaths(stateRoot, SEAT).seatRoot, { recursive: true });
  const rigRepo = new RigRepository(db);
  const rig = rigRepo.createRig("my-rig");
  const node = rigRepo.addNode(rig.id, "dev.research", { role: "worker", runtime: "pda" });
  const sessions = new SessionRegistry(db);
  const session = sessions.registerSession(node.id, SEAT);
  sessions.updateStatus(session.id, "running");
  sessions.updateBinding(node.id, { tmuxSession: SEAT });
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function sidecar(over: Partial<PdaRunnerState> = {}): void {
  const at = new Date().toISOString();
  fs.writeFileSync(pdaSeatPaths(stateRoot, SEAT).runnerStatePath, JSON.stringify({
    ready: true, launchId: "l1", updatedAt: at, aliveAt: at, agent: "research", baseUrl: "http://127.0.0.1:8150",
    connected: true, busy: false, outboxPending: 0, ...over,
  }));
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
  const pda = new PdaRuntimeAdapter({
    tmux, stateRoot, runnerEntryPath: "/x/pda-runner.js", tokenFile: () => "/nope",
    fsOps: { readFile: (p) => fs.readFileSync(p, "utf8"), exists: (p) => fs.existsSync(p), lstat: () => null },
  });
  // As startup.ts builds it: the factory over a map holding every runtime; only pda declares sendReadiness.
  const map: Record<string, RuntimeAdapter> = { "claude-code": { runtime: "claude-code" } as RuntimeAdapter, pda };
  const eventBus = new EventBus(db);
  const transport = new SessionTransport({
    db, rigRepo: new RigRepository(db), sessionRegistry: new SessionRegistry(db), tmuxAdapter: tmux,
    agentActivityStore: new AgentActivityStore({ db, eventBus }), eventBus, waitForIdlePollMs: 1,
    runnerSendReadiness: runnerSendReadinessFromAdapters(map),
  });
  return { transport, sendText, sendKeys };
}

describe("rig send to a pda seat, answered by its runner's sidecar", () => {
  it("T26: an idle, alive runner decides; the F1 frame on screen does not refuse the send", async () => {
    sidecar();
    const { transport, sendText } = setup("node");
    const r = await transport.send(SEAT, "hello");
    expect(r.ok).toBe(true);
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it("T17: the pane back at zsh (runner gone, sidecar still ready): refused, 0 bytes", async () => {
    sidecar();
    const { transport, sendText, sendKeys } = setup("-zsh");
    const r = await transport.send(SEAT, "rm -rf ./build");
    expect(r.ok).toBe(false);
    expect(r.sent).toBe(false);
    expect(sendText).not.toHaveBeenCalled();
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it("T24/T28: a held message refuses with its code, and --dangerously-interact is refused too", async () => {
    sidecar({ held: { requestId: "openrig/n/l/1", code: "pda_message_held", at: new Date().toISOString() } });
    const { transport, sendText } = setup("node");
    const r = await transport.send(SEAT, "next");
    expect(r.ok).toBe(false);
    expect(r.activity).toMatchObject({ state: "needs_input", reason: "pda_message_held", evidenceSource: "runner_sidecar" });
    const forced = await transport.send(SEAT, "next", { dangerouslyInteract: true, reason: "drive it" });
    expect(forced.ok).toBe(false);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("a stale sidecar is no answer (null): today's pane logic decides, and reads the F1 frame as a prompt", async () => {
    sidecar({ aliveAt: new Date(Date.now() - 10 * 60_000).toISOString() });
    const { transport, sendText } = setup("node");
    const r = await transport.send(SEAT, "hello");
    expect(r.ok).toBe(false);
    expect(r.activity?.evidenceSource).not.toBe("runner_sidecar");
    expect(sendText).not.toHaveBeenCalled();
  });
});
