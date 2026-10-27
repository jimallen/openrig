// OF-96: "no other seat drives this pda agent" and "launch onto it" must be one step. The check ran, the runner was typed
// and waited for (up to 30 s), and only afterwards the seat's token was recorded, so two seats given tokens for one free
// agent could both pass the check and both drive it.
//
// Production consequence these rows pin: two OpenRig seats typing into one pi-durable conversation. The adapter is wired
// exactly as startup.ts wires it (`reserveBinding: rigRepo.reservePdaLaunch`) over a fake tmux whose send can be held
// open, which is the window the race lives in. Nothing here talks to a pda host or a tmux server.
//
// Census of production launch doors that reach PdaRuntimeAdapter.launchHarness (instrument: graph search for callers of
// launchHarness at 18f46db6): StartupOrchestrator (fresh launch, pod-aware restore), PdaResumeAdapter (legacy restore),
// SuccessorSessionLauncher (adapter-generic; a pda seat has no successor path, see its row below). All three reach the
// ONE check in the adapter, so the claim is taken there once; no door has its own copy.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { PdaRuntimeAdapter } from "../src/adapters/pda-runtime-adapter.js";
import { PdaResumeAdapter } from "../src/adapters/pda-resume.js";
import { pdaSeatPaths } from "../src/adapters/pda-runner-protocol.js";
import { PDA_RESERVATION_LEASE_MS, PdaLaunchReservations } from "../src/domain/pda-launch-reservations.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";

const PORT = "http://127.0.0.1:8150";
const X = { agent: "research", baseUrl: PORT };
const X_TOKEN = `${PORT}/agents/research`;
const Y_TOKEN = `${PORT}/agents/other`;

let db: Database.Database;
let repo: RigRepository;
let sessions: SessionRegistry;
let dir: string;
let stateRoot: string;
let tokenFile: string;
let clock: number;

beforeEach(() => {
  db = createFullTestDb();
  clock = Date.parse("2031-03-01T00:00:00.000Z"); // far from wall clock
  repo = new RigRepository(db, { pdaReservationNow: () => clock });
  sessions = new SessionRegistry(db);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pda-of96-"));
  stateRoot = path.join(dir, "state", "pda");
  tokenFile = path.join(dir, "token");
  fs.writeFileSync(tokenFile, "x".repeat(43), { mode: 0o600 });
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function seat(rigName: string, logicalId: string, sessionName: string, binding: { agent: string; baseUrl: string }) {
  const rig = repo.createRig(rigName);
  const node = repo.addNode(rig.id, logicalId, { runtime: "pda", pda: binding });
  const session = sessions.registerSession(node.id, sessionName);
  sessions.updateStatus(session.id, "running");
  return { rigId: rig.id, nodeId: node.id, sessionId: session.id, sessionName };
}

/** The adapter as startup.ts wires it, over a fake tmux. `hold` keeps every send open until `open()`; `attach`
 *  decides whether the runner then attaches (writes the ready sidecar of the launch it was typed) or never does. */
function pda(opts?: { hold?: boolean; attach?: boolean; sendThrows?: boolean }) {
  const typed: string[] = [];
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  let launches = 0;
  const adapter = new PdaRuntimeAdapter({
    tmux: {
      sendShellCommand: async (session: string, command: string) => {
        if (opts?.sendThrows) throw new Error("tmux went away");
        typed.push(command);
        if (opts?.hold) await gate;
        if (opts?.attach !== false) {
          const argv = command.split(" ").map((part) => part.replace(/^'|'$/g, ""));
          const value = (flag: string) => argv[argv.indexOf(flag) + 1]!;
          const paths = pdaSeatPaths(stateRoot, session);
          fs.mkdirSync(paths.seatRoot, { recursive: true });
          const at = "2026-10-26T09:00:00.000Z";
          fs.writeFileSync(paths.runnerStatePath, JSON.stringify({
            ready: true, launchId: value("--launch-id"), updatedAt: at, aliveAt: at, agent: value("--agent"), baseUrl: value("--base-url"),
            connected: true, busy: false, outboxPending: 0,
          }));
        }
        return { ok: true as const };
      },
      hasSession: async () => true, getPaneCommand: async () => "node", capturePaneContent: async () => "",
    } as never,
    fsOps: { readFile: (p) => fs.readFileSync(p, "utf8"), exists: (p) => fs.existsSync(p), lstat: (p) => { try { return { isFile: fs.lstatSync(p).isFile() }; } catch { return null; } } },
    stateRoot, runnerEntryPath: "/opt/openrig/dist/adapters/pda-runner.js", tokenFile: () => tokenFile,
    reserveBinding: (binding, nodeId) => repo.reservePdaLaunch(binding, nodeId),
    newLaunchId: () => `launch-${++launches}`, sleep: async () => {}, pollMs: 1, launchWaitMs: 5,
    now: () => new Date("2026-10-26T09:00:00.000Z"),
  });
  return { adapter, typed, open };
}

const nodeBinding = (s: { nodeId: string; sessionName: string }, bound: { agent: string; baseUrl: string }): NodeBinding => ({
  id: "b", nodeId: s.nodeId, tmuxSession: s.sessionName, tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null,
  updatedAt: "", cwd: "/work", pda: bound,
});
const launchWithToken = (p: ReturnType<typeof pda>, s: { nodeId: string; sessionName: string }, token: string) =>
  p.adapter.launchHarness(nodeBinding(s, { agent: `own-${s.nodeId.slice(-4)}`, baseUrl: PORT }), { name: s.sessionName, resumeToken: token });
/** Lets a started launch run to its first await (the held send). */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

describe("OF-96: two seats given tokens for one free agent cannot both launch", () => {
  it("reported symptom: while A's launch is in flight, B's launch onto the same agent is refused with 0 keystrokes; exactly one runner is typed", async () => {
    const a = seat("rig-a", "dev.a", "dev-a@rig-a", { agent: "own-a", baseUrl: PORT });
    const b = seat("rig-b", "dev.b", "dev-b@rig-b", { agent: "own-b", baseUrl: PORT });
    const p = pda({ hold: true });
    const first = launchWithToken(p, a, X_TOKEN);
    await settle();
    expect(p.typed).toHaveLength(1); // A is typed and waiting: no token has been recorded for it yet
    const secondLaunch = launchWithToken(p, b, X_TOKEN);
    await settle();
    expect(p.typed, "B must not be typed onto the agent A is taking").toHaveLength(1);
    p.open();
    const second = await secondLaunch;
    expect(second).toMatchObject({ ok: false, error: expect.stringContaining('seat "dev.a" in rig "rig-a"') });
    expect((second as { error: string }).error).toContain("its launch is under way");
    expect((second as { error: string }).error).toContain('seat "dev.b" in rig "rig-b" cannot take it');
    expect((second as { error: string }).error).not.toContain("/agents/research"); // never the token
    expect(second).not.toHaveProperty("recovery");
    expect(await first).toMatchObject({ ok: true, resumeToken: X_TOKEN });
    expect(p.typed).toHaveLength(1);
  });

  it("through the legacy restore door (PdaResumeAdapter) as well: the same claim", async () => {
    const a = seat("rig-a", "dev.a", "dev-a@rig-a", { agent: "own-a", baseUrl: PORT });
    const b = seat("rig-b", "dev.b", "dev-b@rig-b", { agent: "own-b", baseUrl: PORT });
    const p = pda({ hold: true });
    const first = launchWithToken(p, a, X_TOKEN);
    await settle();
    const resuming = new PdaResumeAdapter(p.adapter).resume(b.nodeId, b.sessionName, "pda_agent", X_TOKEN, "/work");
    await settle();
    expect(p.typed, "the legacy restore must not type onto the agent A is taking").toHaveLength(1);
    p.open();
    const resumed = await resuming;
    expect(resumed).toMatchObject({ ok: false, code: "resume_failed", message: expect.stringContaining("its launch is under way") });
    p.open();
    await first;
    expect(p.typed).toHaveLength(1);
  });

  it("the claim outlives a SUCCESSFUL launch until the token is recorded, and then the token holds the agent", async () => {
    const a = seat("rig-a", "dev.a", "dev-a@rig-a", { agent: "own-a", baseUrl: PORT });
    const b = seat("rig-b", "dev.b", "dev-b@rig-b", { agent: "own-b", baseUrl: PORT });
    const p = pda();
    expect(await launchWithToken(p, a, X_TOKEN)).toMatchObject({ ok: true });
    // The launch returned; the caller has not recorded A's token yet.
    const gap = await launchWithToken(p, b, X_TOKEN);
    expect(gap).toMatchObject({ ok: false, error: expect.stringContaining("it was just launched and its resume token is not recorded yet") }); // OF-96 review F2: a returned launch is not "under way"
    expect((gap as { error: string }).error).not.toContain("under way");
    sessions.updateResumeToken(a.sessionId, "pda_agent", X_TOKEN, "scrape"); // the caller records it
    const after = await launchWithToken(p, b, X_TOKEN);
    expect(after).toMatchObject({ ok: false, error: expect.stringContaining("that seat's resume token names it") });
    expect(p.typed).toHaveLength(1);
  });

  it("a launch that FAILS frees the agent at once (the runner never attached)", async () => {
    const a = seat("rig-a", "dev.a", "dev-a@rig-a", { agent: "own-a", baseUrl: PORT });
    const b = seat("rig-b", "dev.b", "dev-b@rig-b", { agent: "own-b", baseUrl: PORT });
    const failing = pda({ attach: false });
    const lost = await launchWithToken(failing, a, X_TOKEN);
    expect(lost.ok).toBe(false);
    expect(repo.findPdaLaunchConflicts(X, b.nodeId)).toEqual([]);
    const ok = pda();
    expect(await launchWithToken(ok, b, X_TOKEN)).toMatchObject({ ok: true });
  });

  it("a launch that THROWS frees the agent too (the claim never outlives the launch)", async () => {
    const a = seat("rig-a", "dev.a", "dev-a@rig-a", { agent: "own-a", baseUrl: PORT });
    const b = seat("rig-b", "dev.b", "dev-b@rig-b", { agent: "own-b", baseUrl: PORT });
    await expect(launchWithToken(pda({ sendThrows: true }), a, X_TOKEN)).rejects.toThrow("tmux went away");
    expect(repo.findPdaLaunchConflicts(X, b.nodeId)).toEqual([]);
  });

  it("a refused launch claims nothing: a third seat is refused for the real holder, not for the refused one", async () => {
    const a = seat("rig-a", "dev.a", "dev-a@rig-a", { agent: "own-a", baseUrl: PORT });
    const b = seat("rig-b", "dev.b", "dev-b@rig-b", { agent: "own-b", baseUrl: PORT });
    const c = seat("rig-c", "dev.c", "dev-c@rig-c", { agent: "own-c", baseUrl: PORT });
    const p = pda({ hold: true });
    const first = launchWithToken(p, a, X_TOKEN);
    await settle();
    const secondLaunch = launchWithToken(p, b, X_TOKEN);
    const thirdLaunch = launchWithToken(p, c, X_TOKEN);
    await settle();
    expect(p.typed).toHaveLength(1);
    p.open();
    await secondLaunch;
    const third = await thirdLaunch;
    const error = (third as { error: string }).error;
    expect(error).toContain('seat "dev.a"');
    expect(error).not.toContain('seat "dev.b" in rig "rig-b" is');
    expect(error.match(/is being taken by/g)).toHaveLength(1);
    await first;
  });

  it("different agents are independent: two seats launching different agents at once both start", async () => {
    const a = seat("rig-a", "dev.a", "dev-a@rig-a", { agent: "own-a", baseUrl: PORT });
    const b = seat("rig-b", "dev.b", "dev-b@rig-b", { agent: "own-b", baseUrl: PORT });
    const p = pda({ hold: true });
    const first = launchWithToken(p, a, X_TOKEN);
    const second = launchWithToken(p, b, Y_TOKEN);
    await settle();
    p.open();
    expect(await first).toMatchObject({ ok: true });
    expect(await second).toMatchObject({ ok: true });
    expect(p.typed).toHaveLength(2);
  });

  it("the agent is the pair: the same name at another port is another agent", async () => {
    const a = seat("rig-a", "dev.a", "dev-a@rig-a", { agent: "own-a", baseUrl: PORT });
    const b = seat("rig-b", "dev.b", "dev-b@rig-b", { agent: "own-b", baseUrl: PORT });
    const p = pda({ hold: true });
    const first = launchWithToken(p, a, X_TOKEN);
    const second = launchWithToken(p, b, "http://127.0.0.1:8151/agents/research");
    await settle();
    p.open();
    expect(await first).toMatchObject({ ok: true });
    expect(await second).toMatchObject({ ok: true });
  });

  it("a seat re-launching its OWN agent is not blocked by its own claim", async () => {
    const a = seat("rig-a", "dev.a", "dev-a@rig-a", { agent: "own-a", baseUrl: PORT });
    const p = pda();
    expect(await launchWithToken(p, a, X_TOKEN)).toMatchObject({ ok: true });
    expect(await launchWithToken(p, a, X_TOKEN)).toMatchObject({ ok: true });
  });

  it("the lease: a launched claim whose token was never recorded ends after the lease, and not a moment before", async () => {
    const a = seat("rig-a", "dev.a", "dev-a@rig-a", { agent: "own-a", baseUrl: PORT });
    const b = seat("rig-b", "dev.b", "dev-b@rig-b", { agent: "own-b", baseUrl: PORT });
    const p = pda();
    expect(await launchWithToken(p, a, X_TOKEN)).toMatchObject({ ok: true });
    clock += PDA_RESERVATION_LEASE_MS - 1;
    expect(repo.findPdaLaunchConflicts(X, b.nodeId)).toHaveLength(1);
    clock += 1;
    expect(repo.findPdaLaunchConflicts(X, b.nodeId)).toEqual([]);
  });

  it("an IN-FLIGHT claim has no lease: a slow launch keeps its claim however long it takes", async () => {
    const a = seat("rig-a", "dev.a", "dev-a@rig-a", { agent: "own-a", baseUrl: PORT });
    const b = seat("rig-b", "dev.b", "dev-b@rig-b", { agent: "own-b", baseUrl: PORT });
    const p = pda({ hold: true });
    const first = launchWithToken(p, a, X_TOKEN);
    await settle();
    clock += 10 * PDA_RESERVATION_LEASE_MS;
    expect(repo.findPdaLaunchConflicts(X, b.nodeId)).toHaveLength(1);
    p.open();
    await first;
  });

  it("a claim by a seat in an archived rig holds nothing", async () => {
    const a = seat("rig-a", "dev.a", "dev-a@rig-a", { agent: "own-a", baseUrl: PORT });
    const b = seat("rig-b", "dev.b", "dev-b@rig-b", { agent: "own-b", baseUrl: PORT });
    const p = pda();
    await launchWithToken(p, a, X_TOKEN);
    repo.archiveRig(a.rigId);
    expect(repo.findPdaLaunchConflicts(X, b.nodeId)).toEqual([]);
  });

  it("the doors see an in-flight launch too (rig up / unarchive count a seat that is taking the agent)", async () => {
    const a = seat("rig-a", "dev.a", "dev-a@rig-a", { agent: "own-a", baseUrl: PORT });
    const p = pda({ hold: true });
    const first = launchWithToken(p, a, X_TOKEN);
    await settle();
    expect(repo.findPdaDrivers(X)).toMatchObject([{ nodeId: a.nodeId, rigName: "rig-a", logicalId: "dev.a", viaLaunch: true }]);
    p.open();
    await first;
  });

  it("a settled claim does not outlive its token: once A's token is recorded and then re-pointed elsewhere, the old agent is free at once (not after the lease)", async () => {
    const a = seat("rig-a", "dev.a", "dev-a@rig-a", { agent: "own-a", baseUrl: PORT });
    const b = seat("rig-b", "dev.b", "dev-b@rig-b", { agent: "own-b", baseUrl: PORT });
    const p = pda();
    expect(await launchWithToken(p, a, X_TOKEN)).toMatchObject({ ok: true });
    sessions.updateResumeToken(a.sessionId, "pda_agent", X_TOKEN, "scrape");
    expect(repo.findPdaLaunchConflicts(X, b.nodeId)).toHaveLength(1); // the token holds it (and settles the claim)
    sessions.updateResumeToken(a.sessionId, "pda_agent", Y_TOKEN, "operator"); // the operator points A elsewhere
    expect(repo.findPdaLaunchConflicts(X, b.nodeId)).toEqual([]);
  });

  it("rig up replacing the claimant's rig: the claim of a seat about to be archived holds nothing (excludeRigIds)", async () => {
    const a = seat("rig-a", "dev.a", "dev-a@rig-a", { agent: "own-a", baseUrl: PORT });
    const p = pda({ hold: true });
    const first = launchWithToken(p, a, X_TOKEN);
    await settle();
    expect(repo.findPdaDrivers(X)).toHaveLength(1);
    expect(repo.findPdaDrivers(X, { excludeRigIds: [a.rigId] })).toEqual([]);
    p.open();
    await first;
  });
});

describe("OF-96: the claim registry itself", () => {
  it("a stale claim handle cannot release or stamp a newer claim by the same seat on the same agent", () => {
    let now = 1_000;
    const registry = new PdaLaunchReservations(() => now);
    const older = registry.claim(X, "node-1");
    const newer = registry.claim(X, "node-1");
    older.failed(); // the older launch fails after the newer one took over
    expect(registry.claimants(X)).toEqual([{ nodeId: "node-1", launched: false, phase: "in_flight" }]);
    older.launched(); // and a late success of the older launch must not mark the newer one launched
    expect(registry.claimants(X)).toEqual([{ nodeId: "node-1", launched: false, phase: "in_flight" }]);
    newer.launched();
    now += PDA_RESERVATION_LEASE_MS;
    expect(registry.claimants(X)).toEqual([]);
  });

  it("settle drops a launched claim; claims on other agents and other seats are untouched", () => {
    const registry = new PdaLaunchReservations(() => 1_000);
    registry.claim(X, "node-1").launched();
    registry.claim(X, "node-2");
    registry.claim({ agent: "other", baseUrl: PORT }, "node-1");
    registry.settle(X, "node-1");
    expect(registry.claimants(X)).toEqual([{ nodeId: "node-2", launched: false, phase: "in_flight" }]);
    expect(registry.claimants({ agent: "other", baseUrl: PORT })).toEqual([{ nodeId: "node-1", launched: false, phase: "in_flight" }]);
  });
});
