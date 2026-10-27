// pda exclusivity II (v1): OF-112, OF-110, OF-109. One pda agent is driven by one seat, and these three close what
// OF-95/96/98 left open.
//
//   OF-112 (Jim): a pda launch claim is held until the runner's pane is confirmed gone, not released on launch failure
//     while the runner may still be retrying. A timeout and the attention outcomes say "the runner keeps retrying in the
//     pane"; the claim used to be freed there, so a second seat given a token for the same agent could launch onto it and
//     two runners would drive one pi-durable conversation. "Confirmed gone" is the seat's runner.lock naming no live
//     process (one rule, pdaRunnerLockLive, shared with the launch wait and the runner's own take).
//   OF-110: the runner takes runner.lock EXCLUSIVELY itself, so a start that bypasses launchHarness (a hand-typed runner)
//     cannot become a second live runner of the seat.
//   OF-109: which agent a seat's live runner drives is the runner's word (its sidecar). An operator-set resume token can
//     leave the database naming another agent, and the agent the runner is on was named by nothing. And bringing an
//     archived rig back checks the agents its own seats' resume tokens name, not only their saved bindings.
//
// Deployed entrypoint: edge startup.ts constructs PdaRuntimeAdapter (reserveBinding = rigRepo.reservePdaLaunch,
// runner probe = adapter.runnerAttachedTo) and the pane-hosted pda-runner.js main(), which takes the lock. Every state
// root here is a temp dir, the clock is 2031 (far from wall clock), and no pda host, tmux or daemon is contacted.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { makeRig, type Rig } from "./helpers/pda-runner-rig.js";
import { RigRepository, describePdaHolder } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { PDA_RESERVATION_LEASE_MS, PdaLaunchReservations } from "../src/domain/pda-launch-reservations.js";
import { PdaRuntimeAdapter } from "../src/adapters/pda-runtime-adapter.js";
import { acquireRunnerLock } from "../src/adapters/pda-runner.js";
import {
  buildPdaRunnerArgv, parsePdaRunnerLock, pdaRunnerLockLive, pdaSeatPaths, PDA_SIDECAR_ALIVE_WINDOW_MS, type PdaRunnerState,
} from "../src/adapters/pda-runner-protocol.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";

const PORT = "http://127.0.0.1:8150";
const X = { agent: "research", baseUrl: PORT };
const X_TOKEN = `${PORT}/agents/research`;
const Y = { agent: "other", baseUrl: PORT };
const Y_TOKEN = `${PORT}/agents/other`;
const NOW = new Date("2031-03-01T00:00:00.000Z");
const RUNNER_PID = 424242;
const RUNNER_TS = fileURLToPath(new URL("../src/adapters/pda-runner.ts", import.meta.url));

let db: Database.Database;
let repo: RigRepository;
let sessions: SessionRegistry;
let dir: string;
let stateRoot: string;
let tokenFile: string;
let clock: number;
const alive = new Set<number>();
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  db = createFullTestDb();
  clock = NOW.getTime();
  repo = new RigRepository(db, { pdaReservationNow: () => clock });
  sessions = new SessionRegistry(db);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pda-v1-"));
  stateRoot = path.join(dir, "state", "pda");
  tokenFile = path.join(dir, "token");
  fs.writeFileSync(tokenFile, "x".repeat(43), { mode: 0o600 });
  alive.clear();
});
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function seat(rigName: string, logicalId: string, sessionName: string, binding: { agent: string; baseUrl: string }) {
  const rig = repo.createRig(rigName);
  const node = repo.addNode(rig.id, logicalId, { runtime: "pda", pda: binding });
  const session = sessions.registerSession(node.id, sessionName);
  sessions.updateStatus(session.id, "running");
  sessions.updateBinding(node.id, { tmuxSession: sessionName });
  return { rigId: rig.id, nodeId: node.id, sessionId: session.id, sessionName };
}

const sidecarOf = (over: Partial<PdaRunnerState> & { launchId: string; agent: string }): PdaRunnerState => ({
  ready: false, updatedAt: NOW.toISOString(), aliveAt: NOW.toISOString(), baseUrl: PORT, connected: false, busy: false, outboxPending: 0, ...over,
});

type RunnerMode = "retrying" | "unauthorized" | "exits" | "silent" | "stale-sidecar" | "throws-after-lock" | "other-agent" | "exits-6";

/** The adapter as startup.ts wires it, over a fake tmux whose typed command "starts" a runner of the given kind: it
 *  writes the lock and sidecar the real runner writes. `alive` holds the pids the host reports as live processes. */
function pda(mode: RunnerMode, opts?: { readLockThrows?: boolean; oldRunnerWaitMs?: number; runnerProbe?: boolean }) {
  const typed: string[] = [];
  let launches = 0;
  const adapter = new PdaRuntimeAdapter({
    tmux: {
      sendShellCommand: async (session: string, command: string) => {
        typed.push(command);
        if (mode === "silent") return { ok: true as const };
        const argv = command.split(" ").map((part) => part.replace(/^'|'$/g, ""));
        const value = (flag: string) => argv[argv.indexOf(flag) + 1]!;
        const paths = pdaSeatPaths(stateRoot, session);
        fs.mkdirSync(paths.seatRoot, { recursive: true });
        const launchId = value("--launch-id");
        const agent = value("--agent");
        fs.writeFileSync(paths.runnerLockPath, JSON.stringify({ pid: RUNNER_PID, launchId, at: NOW.toISOString() }));
        alive.add(RUNNER_PID);
        const state = mode === "other-agent" ? sidecarOf({ launchId, agent: "someone-else" })
          : mode === "unauthorized" ? sidecarOf({ launchId, agent, error: { code: "pda_unauthorized", at: NOW.toISOString() } })
          : mode === "exits-6" ? sidecarOf({ launchId, agent, exited: { code: 6, at: NOW.toISOString() } })
          : mode === "exits" ? sidecarOf({ launchId, agent, exited: { code: 3, at: NOW.toISOString() } })
            : mode === "stale-sidecar" ? sidecarOf({ launchId, agent, aliveAt: new Date(NOW.getTime() - 10 * PDA_SIDECAR_ALIVE_WINDOW_MS).toISOString() })
              : sidecarOf({ launchId, agent, error: { code: "pda_unreachable", at: NOW.toISOString() } });
        fs.writeFileSync(paths.runnerStatePath, JSON.stringify(state));
        if (mode === "throws-after-lock") throw new Error("tmux went away");
        return { ok: true as const };
      },
      hasSession: async () => true, getPaneCommand: async () => "node", capturePaneContent: async () => "",
    } as never,
    fsOps: {
      readFile: (p) => { if (opts?.readLockThrows && p.endsWith("runner.lock")) throw Object.assign(new Error("EACCES"), { code: "EACCES" }); return fs.readFileSync(p, "utf8"); },
      exists: (p) => fs.existsSync(p),
      lstat: (p) => { try { return { isFile: fs.lstatSync(p).isFile() }; } catch { return null; } },
    },
    stateRoot, runnerEntryPath: "/opt/openrig/dist/adapters/pda-runner.js", tokenFile: () => tokenFile,
    reserveBinding: (binding, nodeId) => repo.reservePdaLaunch(binding, nodeId),
    newLaunchId: () => `launch-${++launches}`, sleep: async () => {}, pollMs: 1, launchWaitMs: 5,
    oldRunnerWaitMs: opts?.oldRunnerWaitMs ?? 3,
    pidAlive: (pid) => alive.has(pid), now: () => NOW,
  });
  if (opts?.runnerProbe) repo.setPdaRunnerProbe((sessionName) => adapter.runnerAttachedTo(sessionName)); // OF-109 is its own layer: the OF-112 rows run without it, or it would hold the agent on its own
  return { adapter, typed };
}

const nodeBinding = (s: { nodeId: string; sessionName: string }): NodeBinding => ({
  id: "b", nodeId: s.nodeId, tmuxSession: s.sessionName, tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null,
  updatedAt: "", cwd: "/work", pda: { agent: `own-${s.nodeId.slice(-4)}`, baseUrl: PORT },
});
const launch = (p: ReturnType<typeof pda>, s: { nodeId: string; sessionName: string }, token: string) =>
  p.adapter.launchHarness(nodeBinding(s), { name: s.sessionName, resumeToken: token });

// ── OF-112 ───────────────────────────────────────────────────────────────────

describe("OF-112: a failed launch whose runner may still be retrying keeps its claim until the pane is confirmed gone", () => {
  it("reported symptom: A's launch times out while its runner retries; B (a token for the same agent) is refused and nothing is typed for B", async () => {
    const a = seat("rig-a", "dev.a", "dev-a@rig-a", { agent: "own-a", baseUrl: PORT });
    const b = seat("rig-b", "dev.b", "dev-b@rig-b", { agent: "own-b", baseUrl: PORT });
    const p = pda("retrying");
    const lost = await launch(p, a, X_TOKEN);
    expect(lost).toMatchObject({ ok: false, error: expect.stringContaining("the runner keeps retrying in the pane") });
    const second = await launch(p, b, X_TOKEN);
    expect(second).toMatchObject({ ok: false, error: expect.stringContaining('seat "dev.a" in rig "rig-a"') });
    expect((second as { error: string }).error).toContain("its launch failed, but its runner may still be running in the pane and retrying");
    expect((second as { error: string }).error).not.toContain("/agents/"); // never the token
    expect(p.typed, "B must not be typed onto an agent A's runner is still retrying against").toHaveLength(1);
  });

  it("the claim has no lease while the runner lives, and ends the moment the runner is gone (not after any lease)", async () => {
    const a = seat("rig-a", "dev.a", "dev-a@rig-a", { agent: "own-a", baseUrl: PORT });
    const b = seat("rig-b", "dev.b", "dev-b@rig-b", { agent: "own-b", baseUrl: PORT });
    const p = pda("retrying");
    await launch(p, a, X_TOKEN);
    clock += 10 * PDA_RESERVATION_LEASE_MS;
    expect(repo.findPdaLaunchConflicts(X, b.nodeId), "a live runner holds the agent however long it takes").toHaveLength(1);
    alive.delete(RUNNER_PID); // the pane is gone
    expect(repo.findPdaLaunchConflicts(X, b.nodeId)).toEqual([]);
    const okRunner = pda("retrying");
    expect(await launch(okRunner, b, X_TOKEN)).toMatchObject({ ok: false }); // B launches (and times out for its own reasons)
    expect(okRunner.typed).toHaveLength(1);
  });

  it("the attention outcome (pda refused the token; the runner keeps retrying) holds the claim as well", async () => {
    const a = seat("rig-a", "dev.a", "dev-a@rig-a", { agent: "own-a", baseUrl: PORT });
    const b = seat("rig-b", "dev.b", "dev-b@rig-b", { agent: "own-b", baseUrl: PORT });
    const p = pda("unauthorized");
    expect(await launch(p, a, X_TOKEN)).toMatchObject({ ok: false, recovery: "attention_required", error: expect.stringContaining("keeps retrying") });
    expect(await launch(p, b, X_TOKEN)).toMatchObject({ ok: false, error: expect.stringContaining('seat "dev.a"') });
    expect(p.typed).toHaveLength(1);
  });

  it("a runner that stopped ITSELF (exited sidecar) frees the claim at once: it no longer drives the agent", async () => {
    const a = seat("rig-a", "dev.a", "dev-a@rig-a", { agent: "own-a", baseUrl: PORT });
    const b = seat("rig-b", "dev.b", "dev-b@rig-b", { agent: "own-b", baseUrl: PORT });
    const p = pda("exits");
    expect(await launch(p, a, X_TOKEN)).toMatchObject({ ok: false, recovery: "attention_required", error: expect.stringContaining("the runner stopped (code 3)") });
    expect(alive.has(RUNNER_PID), "positive control: its lock names a process the host still reports live").toBe(true);
    expect(repo.findPdaLaunchConflicts(X, b.nodeId)).toEqual([]);
  });

  it("a runner that reports ANOTHER agent than the one launched does not hold this agent (it drives the other one)", async () => {
    const a = seat("rig-a", "dev.a", "dev-a@rig-a", { agent: "own-a", baseUrl: PORT });
    const b = seat("rig-b", "dev.b", "dev-b@rig-b", { agent: "own-b", baseUrl: PORT });
    const p = pda("other-agent");
    expect(await launch(p, a, X_TOKEN)).toMatchObject({ ok: false, error: expect.stringContaining("another binding than the one launched") });
    expect(alive.has(RUNNER_PID), "positive control: its runner is alive").toBe(true);
    expect(repo.findPdaLaunchConflicts(X, b.nodeId)).toEqual([]);
  });

  it("F4: a runner that exited with code 6 (another runner holds the seat) is said in words, not 'see the pane'", async () => {
    const a = seat("rig-a", "dev.a", "dev-a@rig-a", { agent: "own-a", baseUrl: PORT });
    const result = await launch(pda("exits-6"), a, X_TOKEN);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("the runner stopped (code 6): another runner already holds this seat") });
    expect((result as { error: string }).error).not.toContain("see the pane");
  });

  it("nothing typed (no token file) claims nothing: control, the agent is free at once", async () => {
    const a = seat("rig-a", "dev.a", "dev-a@rig-a", { agent: "own-a", baseUrl: PORT });
    const b = seat("rig-b", "dev.b", "dev-b@rig-b", { agent: "own-b", baseUrl: PORT });
    fs.rmSync(tokenFile);
    const p = pda("retrying");
    expect(await launch(p, a, X_TOKEN)).toMatchObject({ ok: false, error: expect.stringContaining("nothing was started") });
    expect(p.typed).toHaveLength(0);
    expect(repo.findPdaLaunchConflicts(X, b.nodeId)).toEqual([]);
  });

  it("the retry of the SAME seat, refused because its previous runner is still alive, does not release the held claim", async () => {
    const a = seat("rig-a", "dev.a", "dev-a@rig-a", { agent: "own-a", baseUrl: PORT });
    const b = seat("rig-b", "dev.b", "dev-b@rig-b", { agent: "own-b", baseUrl: PORT });
    const p = pda("retrying");
    await launch(p, a, X_TOKEN);
    const retry = await launch(p, a, X_TOKEN); // OF-98: its previous runner is still running, so nothing is typed
    expect(retry).toMatchObject({ ok: false, error: expect.stringContaining("is still running") });
    expect(p.typed).toHaveLength(1);
    expect(await launch(p, b, X_TOKEN)).toMatchObject({ ok: false, error: expect.stringContaining('seat "dev.a"') });
    expect(p.typed).toHaveLength(1);
  });

  it("fail closed: a lock that cannot be read counts as a runner still there", async () => {
    const a = seat("rig-a", "dev.a", "dev-a@rig-a", { agent: "own-a", baseUrl: PORT });
    const b = seat("rig-b", "dev.b", "dev-b@rig-b", { agent: "own-b", baseUrl: PORT });
    // No lock exists at the launch wait, so the runner is typed; the lock the runner then writes cannot be read by the claim's probe.
    const p = pda("retrying", { readLockThrows: true });
    expect(await launch(p, a, X_TOKEN)).toMatchObject({ ok: false, error: expect.stringContaining("timed out") });
    expect(alive.has(RUNNER_PID) && fs.existsSync(pdaSeatPaths(stateRoot, a.sessionName).runnerLockPath), "positive control: a lock is there").toBe(true);
    alive.delete(RUNNER_PID); // even a dead pid: the unreadable lock is never judged
    expect(await launch(p, b, X_TOKEN)).toMatchObject({ ok: false, error: expect.stringContaining('seat "dev.a"') });
    expect(p.typed).toHaveLength(1);
  });

  it("a send that throws after the runner started still holds the claim (the runner is in the pane), and the throw propagates", async () => {
    const a = seat("rig-a", "dev.a", "dev-a@rig-a", { agent: "own-a", baseUrl: PORT });
    const b = seat("rig-b", "dev.b", "dev-b@rig-b", { agent: "own-b", baseUrl: PORT });
    const p = pda("throws-after-lock");
    await expect(launch(p, a, X_TOKEN)).rejects.toThrow("tmux went away");
    expect(repo.findPdaLaunchConflicts(X, b.nodeId)).toHaveLength(1);
  });

  it("a reused pid (its sidecar stopped ticking) is not a live runner: the claim ends", async () => {
    const a = seat("rig-a", "dev.a", "dev-a@rig-a", { agent: "own-a", baseUrl: PORT });
    const b = seat("rig-b", "dev.b", "dev-b@rig-b", { agent: "own-b", baseUrl: PORT });
    const p = pda("stale-sidecar");
    expect((await launch(p, a, X_TOKEN)).ok).toBe(false);
    expect(alive.has(RUNNER_PID)).toBe(true); // the pid answers signal 0, but the lock's own sidecar is long quiet
    expect(repo.findPdaLaunchConflicts(X, b.nodeId)).toEqual([]);
  });

  it("the seat's own claim never blocks its own relaunch of the agent", async () => {
    const a = seat("rig-a", "dev.a", "dev-a@rig-a", { agent: "own-a", baseUrl: PORT });
    const p = pda("retrying");
    await launch(p, a, X_TOKEN);
    expect(repo.findPdaLaunchConflicts(X, a.nodeId)).toEqual([]);
  });

  it("the three claim phases say three different true things (OF-96 review F2)", () => {
    const holder = { nodeId: "n", rigId: "r", rigName: "rig-a", logicalId: "dev.a", viaLaunch: true as const };
    const inFlight = describePdaHolder(X, { ...holder, launchPhase: "in_flight" });
    const returned = describePdaHolder(X, { ...holder, launchPhase: "returned" });
    const retrying = describePdaHolder(X, { ...holder, launchPhase: "runner_may_live" });
    expect(inFlight).toContain("its launch is under way");
    expect(returned).toContain("it was just launched and its resume token is not recorded yet");
    expect(returned).not.toContain("under way");
    expect(retrying).toContain("runner may still be running in the pane and retrying");
    expect(retrying).not.toContain("under way");
    expect(new Set([inFlight, returned, retrying]).size).toBe(3);
  });
});

describe("OF-112: the claim registry's runner-held claim", () => {
  it("is asked at every read; a probe that throws counts as 'not gone' (the claim stays)", () => {
    const registry = new PdaLaunchReservations(() => 1_000);
    let gone = false;
    let throws = true;
    registry.claim(X, "node-1").heldWhileRunnerLives(() => { if (throws) throw new Error("unreadable"); return gone; });
    expect(registry.claimants(X)).toEqual([{ nodeId: "node-1", launched: false, phase: "runner_may_live" }]);
    throws = false;
    expect(registry.claimants(X)).toEqual([{ nodeId: "node-1", launched: false, phase: "runner_may_live" }]);
    gone = true;
    expect(registry.claimants(X)).toEqual([]);
  });

  it("a stale handle cannot turn a newer claim by the same seat into a runner-held one", () => {
    const registry = new PdaLaunchReservations(() => 1_000);
    const older = registry.claim(X, "node-1");
    registry.claim(X, "node-1");
    older.heldWhileRunnerLives(() => false);
    expect(registry.claimants(X)).toEqual([{ nodeId: "node-1", launched: false, phase: "in_flight" }]);
  });
});

// ── the one rule ─────────────────────────────────────────────────────────────

describe("pdaRunnerLockLive: the one rule for a runner that is still there", () => {
  const lock = { pid: 7, launchId: "L", at: NOW.toISOString() };
  const sidecarAt = (aliveAt: Date, launchId = "L"): PdaRunnerState => sidecarOf({ launchId, agent: "research", aliveAt: aliveAt.toISOString() });
  const live = (side: PdaRunnerState | null, nowMs = NOW.getTime(), pidAlive = true) => pdaRunnerLockLive(lock, side, nowMs, () => pidAlive);

  it("a dead pid is gone; a live pid with a ticking sidecar of that launch is there", () => {
    expect(live(sidecarAt(NOW), NOW.getTime(), false)).toBe(false);
    expect(live(sidecarAt(NOW))).toBe(true);
  });
  it("a sidecar of that launch that stopped ticking is a reused pid; one of ANOTHER launch is no evidence either way", () => {
    expect(live(sidecarAt(new Date(NOW.getTime() - PDA_SIDECAR_ALIVE_WINDOW_MS - 1)))).toBe(false);
    expect(live(sidecarAt(new Date(NOW.getTime() - PDA_SIDECAR_ALIVE_WINDOW_MS)))).toBe(true); // the boundary is inclusive
    expect(live(sidecarAt(new Date(NOW.getTime() - 10 * PDA_SIDECAR_ALIVE_WINDOW_MS), "OTHER"))).toBe(true); // lock itself is fresh
  });
  it("F2: a lock whose time cannot be read is not judged old: a live pid with no sidecar stays a runner (fail closed)", () => {
    const garbage = { pid: 7, launchId: "L", at: "not a date" };
    expect(pdaRunnerLockLive(garbage, null, NOW.getTime() + 1000 * PDA_SIDECAR_ALIVE_WINDOW_MS, () => true)).toBe(true);
    expect(pdaRunnerLockLive(garbage, null, NOW.getTime(), () => false)).toBe(false); // positive control: a dead pid still ends it
  });
  it("no sidecar of the lock's launch: the lock's own age decides", () => {
    expect(live(null, NOW.getTime() + PDA_SIDECAR_ALIVE_WINDOW_MS)).toBe(true);
    expect(live(null, NOW.getTime() + PDA_SIDECAR_ALIVE_WINDOW_MS + 1)).toBe(false);
  });
});

// ── OF-110 ───────────────────────────────────────────────────────────────────

describe("OF-110: the runner takes runner.lock exclusively", () => {
  const files = () => {
    const root = path.join(dir, "seat");
    fs.mkdirSync(root, { recursive: true });
    return { lockPath: path.join(root, "runner.lock"), sidecarPath: path.join(root, "runner-state.json") };
  };
  const held = (lockPath: string, over: Record<string, unknown> = {}) => {
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 4242, launchId: "theirs", at: NOW.toISOString(), ...over }));
    return fs.readFileSync(lockPath, "utf8");
  };

  it("another runner's live lock refuses the take, names the holder, and is left byte-for-byte alone", () => {
    const f = files();
    const before = held(f.lockPath);
    const taken = acquireRunnerLock(f.lockPath, "mine", { ...f, nowMs: () => NOW.getTime(), pidAlive: () => true });
    expect(taken).toMatchObject({ ok: false, heldBy: { pid: 4242, launchId: "theirs" } });
    expect(fs.readFileSync(f.lockPath, "utf8")).toBe(before);
    expect(fs.readdirSync(path.dirname(f.lockPath)).filter((name) => name.includes(".tmp"))).toEqual([]); // no litter
  });

  it("a stale lock is replaced: a dead pid, garbage, an own-pid leftover, a reused pid, and a lock too old to trust", () => {
    const f = files();
    const mine = (): boolean => parsePdaRunnerLock(fs.readFileSync(f.lockPath, "utf8"))?.launchId === "mine";
    const take = (pidAlive: boolean) => acquireRunnerLock(f.lockPath, "mine", { ...f, nowMs: () => NOW.getTime(), pidAlive: () => pidAlive });

    held(f.lockPath);
    expect(take(false).ok).toBe(true); expect(mine()).toBe(true); // dead pid
    fs.writeFileSync(f.lockPath, "{not json");
    expect(take(true).ok).toBe(true); expect(mine()).toBe(true); // garbage
    held(f.lockPath, { pid: process.pid });
    expect(take(true).ok).toBe(true); expect(mine()).toBe(true); // this very process (a re-take)
    held(f.lockPath);
    fs.writeFileSync(f.sidecarPath, JSON.stringify(sidecarOf({ launchId: "theirs", agent: "research", aliveAt: new Date(NOW.getTime() - 10 * PDA_SIDECAR_ALIVE_WINDOW_MS).toISOString() })));
    expect(take(true).ok).toBe(true); expect(mine()).toBe(true); // reused pid: the lock's own sidecar went quiet
    fs.rmSync(f.sidecarPath);
    held(f.lockPath, { at: new Date(NOW.getTime() - PDA_SIDECAR_ALIVE_WINDOW_MS - 1).toISOString() });
    expect(take(true).ok).toBe(true); expect(mine()).toBe(true); // no sidecar of that launch, and the lock is older than the window
  });

  it("F2: a lock with an unreadable time held by a live pid refuses the take", () => {
    const f = files();
    const before = held(f.lockPath, { at: "not a date" });
    const taken = acquireRunnerLock(f.lockPath, "mine", { ...f, nowMs: () => NOW.getTime() + 1000 * PDA_SIDECAR_ALIVE_WINDOW_MS, pidAlive: () => true });
    expect(taken).toMatchObject({ ok: false, heldBy: { pid: 4242 } });
    expect(fs.readFileSync(f.lockPath, "utf8")).toBe(before);
  });

  it("F2: the stale lock is removed only if it is still the lock that was judged (a racer's fresh lock in between survives)", () => {
    const f = files();
    held(f.lockPath); // pid 4242: judged stale below (dead)
    const racer = JSON.stringify({ pid: 5555, launchId: "racer", at: NOW.toISOString() });
    const taken = acquireRunnerLock(f.lockPath, "mine", {
      ...f, nowMs: () => NOW.getTime(), pidAlive: (pid) => pid === 5555,
      afterJudgedStale: () => { fs.writeFileSync(f.lockPath, racer); }, // another runner takes the lock between our judgement and our unlink
    });
    expect(taken).toMatchObject({ ok: false, heldBy: { pid: 5555, launchId: "racer" } });
    expect(fs.readFileSync(f.lockPath, "utf8")).toBe(racer);
  });

  it("F3: a hard link that fails for a reason other than 'exists' (no hard links here) still leaves the lock PRESENT, says so, and is not exclusive", () => {
    const f = files();
    const note = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const noLinks = () => { throw Object.assign(new Error("not supported"), { code: "EPERM" }); };
      const taken = acquireRunnerLock(f.lockPath, "mine", { ...f, linkFile: noLinks });
      expect(taken.ok).toBe(true);
      expect(parsePdaRunnerLock(fs.readFileSync(f.lockPath, "utf8"))).toMatchObject({ pid: process.pid, launchId: "mine" });
      expect(note).toHaveBeenCalledWith(expect.stringContaining("without exclusivity"));
      expect(String(note.mock.calls[0]![0])).toContain("EPERM");
      // The documented loss: with no hard links a live foreign lock is overwritten, not refused.
      held(f.lockPath);
      expect(acquireRunnerLock(f.lockPath, "second", { ...f, linkFile: noLinks, nowMs: () => NOW.getTime(), pidAlive: () => true }).ok).toBe(true);
      expect(parsePdaRunnerLock(fs.readFileSync(f.lockPath, "utf8"))?.launchId).toBe("second");
      expect(fs.readdirSync(path.dirname(f.lockPath)).filter((name) => name.includes(".tmp"))).toEqual([]);
    } finally { note.mockRestore(); }
  });

  it("F3: an error that DOES say 'exists' is judged as a held lock, not mistaken for a missing capability", () => {
    const f = files();
    held(f.lockPath);
    const note = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const exists = () => { throw Object.assign(new Error("exists"), { code: "EEXIST" }); };
      const taken = acquireRunnerLock(f.lockPath, "mine", { ...f, linkFile: exists, nowMs: () => NOW.getTime(), pidAlive: () => true });
      expect(taken).toMatchObject({ ok: false, heldBy: { pid: 4242 } });
      expect(note).not.toHaveBeenCalled();
    } finally { note.mockRestore(); }
  });

  it("a free lock is taken whole, with a release that removes only this pid's lock", () => {
    const f = files();
    const taken = acquireRunnerLock(f.lockPath, "mine", f);
    expect(taken.ok).toBe(true);
    expect(parsePdaRunnerLock(fs.readFileSync(f.lockPath, "utf8"))).toMatchObject({ pid: process.pid, launchId: "mine" });
    held(f.lockPath);
    if (taken.ok) taken.release();
    expect(fs.existsSync(f.lockPath)).toBe(true); // theirs, untouched
  });

  describe("the real runner process", () => {
    let rig: Rig;
    afterEach(async () => { await rig?.cleanup(); });

    function runnerProcess(over: { tokenFileContent?: string }) {
      return makeRig({ realStreams: true, ...over });
    }
    function spawnReal(rig: Rig) {
      const argv = buildPdaRunnerArgv({
        sessionName: rig.args.sessionName, stateRoot: rig.args.stateRoot, launchId: "second",
        binding: { agent: "research", baseUrl: rig.args.baseUrl }, tokenFile: rig.args.tokenFile,
      });
      const child = spawn(process.execPath, ["--import", "tsx", RUNNER_TS, ...argv], {
        env: { PATH: process.env.PATH ?? "", HOME: rig.dir, OPENRIG_HOME: rig.dir, OPENRIG_NODE_ID: "proc-node" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let out = "";
      child.stdout!.on("data", (c) => { out += c.toString(); });
      child.stderr!.on("data", (c) => { out += c.toString(); });
      const exit = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
      return { exit, out: () => out };
    }

    it("a hand-typed second runner while another runner of the seat is alive exits 6, says so, and touches neither the lock nor the live runner's sidecar", async () => {
      rig = await runnerProcess({ tokenFileContent: "not-a-pda-token" });
      // The live runner is THIS test process (its pid answers signal 0), with a fresh sidecar of its own launch.
      const lockText = JSON.stringify({ pid: process.pid, launchId: "first", at: new Date().toISOString() });
      fs.writeFileSync(rig.paths.runnerLockPath, lockText);
      const sidecarText = JSON.stringify(sidecarOf({ launchId: "first", agent: "research", aliveAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
      fs.writeFileSync(rig.paths.runnerStatePath, sidecarText);
      const p = spawnReal(rig);
      expect(await p.exit).toBe(6);
      expect(p.out()).toContain("[pda-runner] ERROR pda_runner_locked");
      expect(p.out()).not.toContain("READY");
      expect(fs.readFileSync(rig.paths.runnerLockPath, "utf8")).toBe(lockText);
      expect(fs.readFileSync(rig.paths.runnerStatePath, "utf8")).toBe(sidecarText); // no `exited` record over the live runner's word
    }, 60000);

    it("control: the same start over a lock left by a dead process runs on (exit 4 for its bad token file, not 6) and releases its own lock", async () => {
      rig = await runnerProcess({ tokenFileContent: "not-a-pda-token" });
      const dead = spawn(process.execPath, ["-e", ""]);
      const deadPid = dead.pid!;
      await new Promise((resolve) => dead.on("exit", resolve));
      fs.writeFileSync(rig.paths.runnerLockPath, JSON.stringify({ pid: deadPid, launchId: "first", at: new Date().toISOString() }));
      const p = spawnReal(rig);
      expect(await p.exit).toBe(4);
      expect(fs.existsSync(rig.paths.runnerLockPath)).toBe(false);
    }, 60000);
  });
});

// ── OF-109 ───────────────────────────────────────────────────────────────────

describe("OF-109: the runner's own word about its agent, and the archived rig's own tokens", () => {
  it("reported symptom: an operator-set token points A at Y after its runner launched on X; a launch of B onto X is refused for A's live runner", async () => {
    const a = seat("rig-a", "dev.a", "dev-a@rig-a", { agent: "own-a", baseUrl: PORT });
    const b = seat("rig-b", "dev.b", "dev-b@rig-b", { agent: "own-b", baseUrl: PORT });
    const p = pda("retrying");
    expect(await launch(p, a, X_TOKEN)).toMatchObject({ ok: false }); // A's runner started on X (and is alive)
    // The operator points A's resume token at Y; the claim of the failed launch is no longer the only memory of X.
    sessions.updateResumeToken(a.sessionId, "pda_agent", Y_TOKEN, "operator");
    expect(repo.findPdaDrivers(Y).map((holder) => holder.logicalId)).toEqual(["dev.a"]); // the database's word
    const holders = repo.findPdaDrivers(X, { excludeNodeId: b.nodeId });
    expect(holders).toMatchObject([{ nodeId: a.nodeId, viaLaunch: true }]);
    // Drop the in-memory claim's memory (a daemon restart): the sidecar alone must still hold X.
    const fresh = new RigRepository(db, { pdaReservationNow: () => clock });
    fresh.setPdaRunnerProbe((s) => p.adapter.runnerAttachedTo(s));
    expect(fresh.findPdaDrivers(X, { excludeNodeId: b.nodeId })).toMatchObject([{ nodeId: a.nodeId, viaRunner: true }]);
    const refusal = fresh.findPdaLaunchConflicts(X, b.nodeId).join(" ");
    expect(refusal).toContain('seat "dev.a"');
    expect(refusal).toContain("pda runner is attached to it");
    expect(refusal).not.toContain("/agents/");
  });

  it("the runner holder is exactly the live runner's sidecar agent: another agent, an exited runner, a dead pid and no sidecar of the lock's launch hold nothing", async () => {
    const a = seat("rig-a", "dev.a", "dev-a@rig-a", { agent: "own-a", baseUrl: PORT });
    const probeAdapter = pda("silent", { runnerProbe: true }).adapter;
    const paths = pdaSeatPaths(stateRoot, a.sessionName);
    fs.mkdirSync(paths.seatRoot, { recursive: true });
    const writeLock = (launchId: string) => fs.writeFileSync(paths.runnerLockPath, JSON.stringify({ pid: RUNNER_PID, launchId, at: NOW.toISOString() }));
    alive.add(RUNNER_PID);
    writeLock("L");
    fs.writeFileSync(paths.runnerStatePath, JSON.stringify(sidecarOf({ launchId: "L", agent: "research" })));
    expect(repo.findPdaDrivers(X).map((h) => h.logicalId), "positive control: the live runner on X holds X").toEqual(["dev.a"]);
    expect(probeAdapter.runnerAttachedTo(a.sessionName)).toEqual(X);
    // another agent than the one asked about, and the same name at another port (the agent is the pair)
    expect(repo.findPdaDrivers({ agent: "elsewhere", baseUrl: PORT })).toEqual([]);
    expect(repo.findPdaDrivers({ agent: "research", baseUrl: "http://127.0.0.1:8151" })).toEqual([]);
    // the runner has begun to exit
    fs.writeFileSync(paths.runnerStatePath, JSON.stringify(sidecarOf({ launchId: "L", agent: "research", exited: { code: 0, at: NOW.toISOString() } })));
    expect(repo.findPdaDrivers(X)).toEqual([]);
    // a sidecar of another launch than the lock's
    fs.writeFileSync(paths.runnerStatePath, JSON.stringify(sidecarOf({ launchId: "OTHER", agent: "research" })));
    expect(repo.findPdaDrivers(X)).toEqual([]);
    // a dead pid
    fs.writeFileSync(paths.runnerStatePath, JSON.stringify(sidecarOf({ launchId: "L", agent: "research" })));
    expect(repo.findPdaDrivers(X)).toHaveLength(1);
    alive.delete(RUNNER_PID);
    expect(repo.findPdaDrivers(X)).toEqual([]);
  });

  it("F1: a runner.lock that exists but cannot be read holds the agent for its seat (fail closed, as the claim's probe does), for ANY agent", () => {
    const a = seat("rig-a", "dev.a", "dev-a@rig-a", { agent: "own-a", baseUrl: PORT });
    const b = seat("rig-b", "dev.b", "dev-b@rig-b", { agent: "own-b", baseUrl: PORT });
    const readable = pda("silent", { runnerProbe: true });
    const paths = pdaSeatPaths(stateRoot, a.sessionName);
    fs.mkdirSync(paths.seatRoot, { recursive: true });
    fs.writeFileSync(paths.runnerLockPath, JSON.stringify({ pid: RUNNER_PID, launchId: "L", at: NOW.toISOString() }));
    alive.add(RUNNER_PID);
    expect(readable.adapter.runnerAttachedTo(a.sessionName), "positive control: readable, no sidecar of that launch = nothing known").toBeNull();
    expect(repo.findPdaLaunchConflicts(X, b.nodeId)).toEqual([]);
    const unreadable = pda("silent", { runnerProbe: true, readLockThrows: true });
    expect(unreadable.adapter.runnerAttachedTo(a.sessionName)).toBe("unknown");
    const refusal = repo.findPdaLaunchConflicts(X, b.nodeId).join(" ");
    expect(refusal).toContain('seat "dev.a"');
    expect(refusal).toContain("runner whose lock cannot be read");
    expect(refusal).not.toContain("/agents/");
    expect(repo.findPdaLaunchConflicts(Y, b.nodeId)).toHaveLength(1); // it may drive any agent
    expect(repo.findPdaDrivers(X, { excludeNodeId: a.nodeId })).toEqual([]); // but never blocks the seat itself
  });

  it("a seat in an archived rig, or the asking seat itself, or a rig being replaced, is not held by its runner", async () => {
    const a = seat("rig-a", "dev.a", "dev-a@rig-a", { agent: "own-a", baseUrl: PORT });
    const p = pda("retrying");
    await launch(p, a, X_TOKEN);
    const fresh = new RigRepository(db, { pdaReservationNow: () => clock });
    fresh.setPdaRunnerProbe((s) => p.adapter.runnerAttachedTo(s));
    expect(fresh.findPdaDrivers(X)).toHaveLength(1);
    expect(fresh.findPdaDrivers(X, { excludeNodeId: a.nodeId })).toEqual([]);
    expect(fresh.findPdaDrivers(X, { excludeRigIds: [a.rigId] })).toEqual([]);
    fresh.archiveRig(a.rigId);
    expect(fresh.findPdaDrivers(X)).toEqual([]);
  });

  it("unarchive checks the agents the rig's OWN seats' resume tokens name, not only their saved bindings", () => {
    const a = seat("rig-a", "dev.a", "dev-a@rig-a", { agent: "own-a", baseUrl: PORT });
    const other = seat("rig-b", "dev.b", "dev-b@rig-b", { agent: "own-b", baseUrl: PORT });
    // A's operator-set token names Y; B (a live rig) holds Y through its own binding... via its token
    sessions.updateResumeToken(a.sessionId, "pda_agent", Y_TOKEN, "operator");
    sessions.updateResumeToken(other.sessionId, "pda_agent", Y_TOKEN, "scrape");
    repo.archiveRig(a.rigId);
    const result = repo.unarchiveRigUnlessPdaConflict(a.rigId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflicts).toMatchObject([{ seat: "dev.a", binding: Y, holder: { logicalId: "dev.b", rigName: "rig-b" } }]);
    }
    expect(db.prepare("SELECT archived_at FROM rigs WHERE id = ?").get(a.rigId)).not.toMatchObject({ archived_at: null }); // still archived
  });

  it("unarchive reads each own seat's CURRENT token only: a superseded session's token names nothing", () => {
    const a = seat("rig-a", "dev.a", "dev-a@rig-a", { agent: "own-a", baseUrl: PORT });
    const other = seat("rig-b", "dev.b", "dev-b@rig-b", { agent: "own-b", baseUrl: PORT });
    sessions.updateResumeToken(other.sessionId, "pda_agent", Y_TOKEN, "scrape"); // B holds Y
    sessions.updateResumeToken(a.sessionId, "pda_agent", Y_TOKEN, "scrape");      // A's OLD session named Y
    db.prepare("UPDATE sessions SET created_at = '2031-01-01 00:00:00' WHERE id = ?").run(a.sessionId);
    const newer = sessions.registerSession(a.nodeId, "dev-a@rig-a");
    sessions.updateResumeToken(newer.id, "pda_agent", `${PORT}/agents/free`, "scrape"); // A's current token names a free agent
    db.prepare("UPDATE sessions SET created_at = '2031-02-01 00:00:00' WHERE id = ?").run(newer.id);
    repo.archiveRig(a.rigId);
    expect(repo.findPdaBindingConflictsForRig(a.rigId)).toEqual([]);
  });

  it("unarchive: a token that names the same agent as the binding is checked once; a token of another resume type or no token adds nothing; a free agent unarchives", () => {
    const a = seat("rig-a", "dev.a", "dev-a@rig-a", { agent: "own-a", baseUrl: PORT });
    const b = seat("rig-b", "dev.b", "dev-b@rig-b", { agent: "own-b", baseUrl: PORT });
    sessions.updateResumeToken(a.sessionId, "pda_agent", `${PORT}/agents/own-a`, "scrape"); // same as its binding
    sessions.updateResumeToken(b.sessionId, "pda_agent", `${PORT}/agents/own-a`, "scrape"); // B holds A's binding agent
    repo.archiveRig(a.rigId);
    const refused = repo.findPdaBindingConflictsForRig(a.rigId);
    expect(refused).toHaveLength(1); // once, not twice
    expect(refused[0]).toMatchObject({ seat: "dev.a", holder: { logicalId: "dev.b" } });
    sessions.updateResumeToken(b.sessionId, "pda_agent", `${PORT}/agents/own-b`, "operator");
    expect(repo.unarchiveRigUnlessPdaConflict(a.rigId)).toEqual({ ok: true, changed: true });
  });
});
