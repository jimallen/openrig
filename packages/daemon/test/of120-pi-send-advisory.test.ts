// OF-120: a plain `rig send` to a Pi/OMP seat whose runner is idle or busy but whose latest report is an attention
// (runtime_error: a model or provider error; permission_prompt: an approval the runner cancelled) is sent with an
// advisory, so the sender is told the seat last hit that. Production consequence: after OF-88 the send goes through
// silently; an agent re-sending an instruction to an OMP seat that just failed its last turn heard nothing about it.
// The attention stays display evidence: it never refuses, and the advisory goes only on a runner-answered send.
// Deployed chain: startup.ts passes runnerSendReadinessFromAdapters(map) to SessionTransport; the seat's pi-runner
// posts Notification/<attention> to /api/activity/hook, which AgentActivityStore.recordHookEvent stores; the send path
// (SessionTransport.send) reads the store's latest hook. These rows record the hook through the real store.
// pda is not touched: the advisory is limited to the pi and omp runtimes, and pda-held-send-gate.test.ts (unchanged)
// pins the pda gate.
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
import { piSeatPaths } from "../src/adapters/pi-runner-protocol.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const SEAT = "dev-pi@my-rig";
const NOW = Date.UTC(2026, 9, 27, 10, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();

describe("OF-120: a send to a Pi/OMP seat with a reported attention carries an advisory", () => {
  let db: Database.Database;
  let dir: string;
  let stateRoot: string;
  let store: AgentActivityStore;
  beforeEach(() => {
    db = createFullTestDb();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "of120-"));
    stateRoot = path.join(dir, "state", "pi");
    fs.mkdirSync(piSeatPaths(stateRoot, SEAT).seatRoot, { recursive: true });
    const rigRepo = new RigRepository(db);
    const rig = rigRepo.createRig("my-rig");
    const node = rigRepo.addNode(rig.id, "dev.pi", { role: "worker", runtime: "omp" });
    const sessions = new SessionRegistry(db);
    const session = sessions.registerSession(node.id, SEAT);
    sessions.updateStatus(session.id, "running");
    sessions.updateBinding(node.id, { tmuxSession: SEAT });
    store = new AgentActivityStore({ db, eventBus: new EventBus(db), now: () => new Date(NOW) });
  });
  afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const sidecar = (busy: boolean) => fs.writeFileSync(piSeatPaths(stateRoot, SEAT).runnerStatePath,
    JSON.stringify({ ready: true, launchId: "l1", updatedAt: iso(NOW), aliveAt: iso(NOW), busy }));
  const hook = (hookEvent: string, subtype: string | null, atMs = NOW - 1000) =>
    expect(store.recordHookEvent({ sessionName: SEAT, runtime: "omp", hookEvent, subtype, occurredAt: iso(atMs) }).ok).toBe(true);

  function setup(over: { store?: AgentActivityStore; extra?: Record<string, RuntimeAdapter> } = {}) {
    const sendText = vi.fn(async () => ({ ok: true as const }));
    const tmux = {
      hasSession: async () => true, probeSession: async () => ({ state: "present" as const }), sendText, sendKeys: vi.fn(async () => ({ ok: true as const })),
      capturePaneContent: async () => "idle", createSession: async () => ({ ok: true as const }), killSession: async () => ({ ok: true as const }),
      listSessions: async () => [], listWindows: async () => [], listPanes: async () => [],
      startPipePane: async () => ({ ok: true as const }), stopPipePane: async () => ({ ok: true as const }),
      getPanePid: async () => null, getPaneCommand: async () => "node",
    } as unknown as TmuxAdapter;
    const deps = {
      tmux, stateRoot, runnerEntryPath: "/x/pi-runner.js", now: () => new Date(NOW),
      fsOps: { readFile: (p: string) => fs.readFileSync(p, "utf8"), exists: (p: string) => fs.existsSync(p), writeFile: () => undefined, mkdirp: () => undefined },
    };
    const map: Record<string, RuntimeAdapter> = { "claude-code": { runtime: "claude-code" } as RuntimeAdapter, pi: new PiRuntimeAdapter(deps), omp: new OmpRuntimeAdapter(deps), ...over.extra };
    const transport = new SessionTransport({
      db, rigRepo: new RigRepository(db), sessionRegistry: new SessionRegistry(db), tmuxAdapter: tmux,
      agentActivityStore: over.store ?? store, eventBus: new EventBus(db), waitForIdlePollMs: 1,
      now: () => new Date(NOW), runnerSendReadiness: runnerSendReadinessFromAdapters(map),
    });
    return { transport, sendText };
  }

  it("runtime_error: the send goes, and the sender is told the seat's last turn hit a model or runtime error", async () => {
    sidecar(false);
    hook("Notification", "runtime_error");
    const { transport, sendText } = setup();
    const r = await transport.send(SEAT, "re-send a safe instruction");
    expect(r.ok).toBe(true);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(r.warning).toContain("runtime_error");
    expect(r.warning).toContain("sent anyway");
  });

  it("permission_prompt: the send goes, and the sender is told a cancelled approval request is outstanding", async () => {
    sidecar(false);
    hook("Notification", "permission_prompt");
    const { transport, sendText } = setup();
    const r = await transport.send(SEAT, "re-send a safe instruction");
    expect(r.ok).toBe(true);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(r.warning).toContain("cancelled an approval request");
    expect(r.warning).toContain("permission_prompt");
  });

  it("a busy runner (a steer into a running turn after a cancelled approval) carries the attention advisory and the mid-task one", async () => {
    sidecar(true);
    hook("Notification", "permission_prompt");
    const { transport } = setup();
    const r = await transport.send(SEAT, "steer");
    expect(r.ok).toBe(true);
    expect(r.warning).toContain("permission_prompt");
    expect(r.warning).toContain("mid-task");
  });

  it("the attention is still current long after the report (a stale retained hook)", async () => {
    sidecar(false);
    hook("Notification", "runtime_error", NOW - 3_600_000);
    const { transport } = setup();
    expect((await transport.send(SEAT, "hello")).warning).toContain("runtime_error");
  });

  it("control: once the next turn has posted its Stop (or work), the attention is cleared and the send carries no advisory", async () => {
    sidecar(false);
    hook("Notification", "runtime_error", NOW - 5000);
    hook("Stop", "omp_turn", NOW - 1000);
    const { transport, sendText } = setup();
    const r = await transport.send(SEAT, "hello");
    expect(r.ok).toBe(true);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(r.warning).toBeUndefined();
  });

  it("control: a seat with no attention gets no advisory", async () => {
    sidecar(false);
    const { transport } = setup();
    const r = await transport.send(SEAT, "hello");
    expect(r.ok).toBe(true);
    expect(r.warning).toBeUndefined();
  });

  it("control: --dangerously-interact still sends, with the same advisory", async () => {
    sidecar(false);
    hook("Notification", "runtime_error");
    const { transport, sendText } = setup();
    const r = await transport.send(SEAT, "driven", { dangerouslyInteract: true, reason: "drive it" });
    expect(r.ok).toBe(true);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(r.warning).toContain("runtime_error");
  });

  it("an attention reported by a prior occupant (generation mismatch) is not the seat's: no advisory", async () => {
    const live = new AgentActivityStore({ db, eventBus: new EventBus(db), now: () => new Date(NOW),
      resolveOccupantGeneration: () => "gen-live", isRegisteredOccupantGeneration: () => true });
    sidecar(false);
    expect(live.recordHookEvent({ sessionName: SEAT, runtime: "omp", hookEvent: "Notification", subtype: "runtime_error", occurredAt: iso(NOW - 1000), generation: "gen-old" }).ok).toBe(true);
    const { transport } = setup({ store: live });
    const r = await transport.send(SEAT, "hello");
    expect(r.ok).toBe(true);
    expect(r.warning).toBeUndefined();
  });

  it("only the pi and omp runtimes are worded: a runner-answered pda seat with the same hook gets no attention advisory", async () => {
    db.prepare("UPDATE nodes SET runtime = 'pda'").run();
    const pdaIdle = { runtime: "pda", sendReadiness: async () => ({ state: "idle" as const, reason: "runner_idle", evidenceSource: "runner_sidecar" as const, sampledAt: iso(NOW), evidence: null, runtime: "pda" }) } as unknown as RuntimeAdapter;
    expect(store.recordHookEvent({ sessionName: SEAT, runtime: "pda", hookEvent: "Notification", subtype: "permission_prompt", occurredAt: iso(NOW - 1000) }).ok).toBe(true);
    const { transport, sendText } = setup({ extra: { pda: pdaIdle } });
    const r = await transport.send(SEAT, "hello");
    expect(r.ok).toBe(true);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(r.warning).toBeUndefined();
  });
});
