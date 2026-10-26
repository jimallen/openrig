// OF-98: a pda restart must not start the next runner while the previous one can still write its usage spill
// (usage-pending.json) or its outbox. Before: launchHarness typed the runner command at once, and teardown returns
// when tmux has killed the session, so the old runner's bounded close (<= 5 s) raced the new runner's load.
//
// Chosen over making the writes merge-safe: the outbox is a durable log with request ids, and a union at the spill
// would still lose the old runner's facts to the new runner's unlink. One gate at the one place a runner is started
// covers both files, and every other file the old runner owns.
//
// Pins in this file (all with temp state roots, fake pda and fake daemon; no tmux, no live daemon):
//   (a) the adapter: waits while the lock's pid is live, refuses (types nothing) when it stays live, and does NOT
//       wait for a stale lock (SIGKILL / exit 70 skip the release), a reused pid, or garbage.
//   (b) the REAL runner process: SIGTERM and SIGHUP (main()'s handlers) close the sink, spill, release the lock
//       and exit 0; SIGKILL leaves the lock with a dead pid and no spill; the lock covers the whole close.
//   (c) exit 70 (the fatal handler) skips the sink's close(): the pending fact is lost, as documented.
//   (d) the restart race itself, against the real process and the real adapter.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { PdaRuntimeAdapter, type PdaRuntimeAdapterDeps } from "../src/adapters/pda-runtime-adapter.js";
import { buildPdaRunnerArgv, parsePdaRunnerLock, pdaSeatPaths, type PdaRunnerState } from "../src/adapters/pda-runner-protocol.js";
import { createPdaUsageSink, type PdaUsagePostResult } from "../src/adapters/pda-usage-sink.js";
import { acquireRunnerLock, installPdaRunnerFatalHandlers } from "../src/adapters/pda-runner.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import { assistantEntry, HOOK_TOKEN, makeRig, waitFor, type Rig } from "./helpers/pda-runner-rig.js";

const SESSION = "research@rig";
const BASE = "http://127.0.0.1:8150";
const NOW = new Date("2026-10-24T09:00:00.000Z");
const RUNNER_TS = fileURLToPath(new URL("../src/adapters/pda-runner.ts", import.meta.url));

const dirs: string[] = [];
const tmp = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "of98-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

// ── (a) the adapter ──────────────────────────────────────────────────────────

describe("(a) launchHarness waits, bounded, for the seat's previous runner to finish closing", () => {
  let stateRoot: string;
  let lockPath: string;
  beforeEach(() => {
    const dir = tmp();
    stateRoot = path.join(dir, "state", "pda");
    fs.writeFileSync(path.join(dir, "token"), "x".repeat(43), { mode: 0o600 });
    const paths = pdaSeatPaths(stateRoot, SESSION);
    fs.mkdirSync(paths.seatRoot, { recursive: true });
    lockPath = paths.runnerLockPath;
  });

  const binding = (): NodeBinding => ({
    id: "b1", nodeId: "node-1", tmuxSession: SESSION, tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null,
    updatedAt: "", cwd: "/work", pda: { agent: "research", baseUrl: BASE },
  });
  const writeLock = (over: Record<string, unknown> = {}) =>
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 4242, launchId: "old-launch", at: NOW.toISOString(), ...over }));
  const writeSidecar = (over: Partial<PdaRunnerState> = {}) => fs.writeFileSync(pdaSeatPaths(stateRoot, SESSION).runnerStatePath, JSON.stringify({
    ready: false, launchId: "old-launch", updatedAt: NOW.toISOString(), aliveAt: NOW.toISOString(), agent: "research", baseUrl: BASE,
    connected: false, busy: false, outboxPending: 0, exited: { code: 0, at: NOW.toISOString() }, ...over,
  }));

  function adapterWith(over: Partial<PdaRuntimeAdapterDeps> = {}) {
    const log: string[] = [];
    const deps: PdaRuntimeAdapterDeps = {
      tmux: {
        sendShellCommand: async () => { log.push("typed"); return { ok: true as const }; },
        hasSession: async () => true, getPaneCommand: async () => "node", capturePaneContent: async () => "",
      } as unknown as PdaRuntimeAdapterDeps["tmux"],
      fsOps: {
        readFile: (p) => fs.readFileSync(p, "utf8"), exists: (p) => fs.existsSync(p),
        lstat: (p) => { try { return { isFile: fs.lstatSync(p).isFile() }; } catch { return null; } },
      },
      stateRoot, runnerEntryPath: "/opt/openrig/dist/adapters/pda-runner.js", tokenFile: () => path.join(path.dirname(path.dirname(stateRoot)), "token"),
      newLaunchId: () => "new-launch", now: () => NOW,
      sleep: async () => { log.push("slept"); },
      pollMs: 10, launchWaitMs: 20, oldRunnerWaitMs: 100,
      ...over,
    };
    return { adapter: new PdaRuntimeAdapter(deps), log };
  }

  it("a live previous runner: nothing is typed until its lock is gone, then the new runner starts", async () => {
    writeLock();
    let sleeps = 0;
    const { adapter, log } = adapterWith({
      pidAlive: () => true,
      sleep: async () => { sleeps += 1; log.push("slept"); if (sleeps === 3) fs.rmSync(lockPath); },
    });
    await adapter.launchHarness(binding(), { name: "x" });
    expect(log.indexOf("typed")).toBe(3);                       // three polls of the live lock, then the lock cleared
    expect(log.slice(0, 3)).toEqual(["slept", "slept", "slept"]);
  });

  it("a previous runner that stays live past the bound: the launch is refused, nothing is typed, the pid is named", async () => {
    writeLock({ pid: 31337 });
    const { adapter, log } = adapterWith({ pidAlive: () => true });
    const result = await adapter.launchHarness(binding(), { name: "x" });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("pid 31337");
    expect((result as { error: string }).error).toContain("nothing was typed");
    expect(log).not.toContain("typed");
    expect(log.filter((l) => l === "slept").length).toBe(10);   // 100 ms / 10 ms polls: bounded, not forever
  });

  it("SIGKILL / exit 70 leave the lock behind with a dead pid: no wait, the launch proceeds at once", async () => {
    writeLock();
    const { adapter, log } = adapterWith({ pidAlive: () => false });
    await adapter.launchHarness(binding(), { name: "x" });
    expect(log[0]).toBe("typed");
  });

  it("a live pid whose sidecar stopped ticking (a reused pid) is stale: no wait", async () => {
    writeLock();
    writeSidecar({ aliveAt: new Date(NOW.getTime() - 3_600_000).toISOString() });
    const { adapter, log } = adapterWith({ pidAlive: () => true });
    await adapter.launchHarness(binding(), { name: "x" });
    expect(log[0]).toBe("typed");
  });

  it("no lock, or a lock that is not a lock: no wait", async () => {
    const none = adapterWith({ pidAlive: () => true });
    await none.adapter.launchHarness(binding(), { name: "x" });
    expect(none.log[0]).toBe("typed");
    fs.writeFileSync(lockPath, "{not json");
    const garbage = adapterWith({ pidAlive: () => true });
    await garbage.adapter.launchHarness(binding(), { name: "x" });
    expect(garbage.log[0]).toBe("typed");
  });

  it("a launch refused for another reason (no binding) never reads the lock", async () => {
    writeLock();
    const { adapter, log } = adapterWith({ pidAlive: () => true });
    const result = await adapter.launchHarness({ ...binding(), pda: undefined }, { name: "x" });
    expect(result.ok).toBe(false);
    expect(log).toEqual([]);
  });

  it("the lock parser accepts only a positive integer pid with a launch id and a time", () => {
    expect(parsePdaRunnerLock(JSON.stringify({ pid: 7, launchId: "l", at: "t" }))).toEqual({ pid: 7, launchId: "l", at: "t" });
    const rest = { launchId: "l", at: "t" };
    for (const bad of [{ pid: 0, ...rest }, { pid: -1, ...rest }, { pid: 1.5, ...rest }, { pid: "7", ...rest }, { pid: 7 }, { pid: 7, launchId: "l" }, { pid: 7, at: "t" }, []]) {
      expect(parsePdaRunnerLock(JSON.stringify(bad))).toBeNull();
    }
    expect(parsePdaRunnerLock("nope")).toBeNull();
  });
});

// ── (b), (d) the real runner process ─────────────────────────────────────────

interface Proc { child: ChildProcess; out: () => string; exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }> }
function spawnRunner(argv: string[], home: string, daemonPort: number): Proc {
  const child = spawn(process.execPath, ["--import", "tsx", RUNNER_TS, ...argv], {
    env: {
      PATH: process.env.PATH ?? "", HOME: home, OPENRIG_HOME: home, OPENRIG_NODE_ID: "proc-node", OPENRIG_ACTIVITY_HOOK_TOKEN: HOOK_TOKEN,
      OPENRIG_URL: `http://127.0.0.1:${daemonPort}`,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  child.stdout!.on("data", (c) => { out += c.toString(); });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  return { child, out: () => out, exit };
}

/** A fake daemon: every route answers 200 except /api/activity/pda-usage, which answers `usage` ("503" or "hang"). */
async function fakeDaemon(usage: "200" | "503" | "hang") {
  const usagePosts: string[] = [];
  const sockets = new Set<import("node:net").Socket>();
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      if (req.url === "/api/activity/pda-usage") {
        usagePosts.push(raw);
        if (usage === "hang") return; // never answers: the sink's close() must run out its own budget
        if (usage === "200") { res.writeHead(200, { "content-type": "application/json" }); return res.end("{}"); }
        res.writeHead(503, { "content-type": "application/json" });
        return res.end("{}");
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port, usagePosts,
    close: async () => { for (const s of sockets) s.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

/** Start the real runner with --usage-facts, run one own run to its end so one fact is pending (the daemon never stores it). */
async function runnerWithPendingFact(rig: Rig, daemon: Awaited<ReturnType<typeof fakeDaemon>>, launchId: string): Promise<Proc> {
  const home = tmp();
  const argv = buildPdaRunnerArgv({
    sessionName: rig.args.sessionName, stateRoot: rig.args.stateRoot, launchId,
    binding: { agent: "research", baseUrl: rig.args.baseUrl }, tokenFile: rig.args.tokenFile, usageFacts: true,
  });
  const p = spawnRunner(argv, home, daemon.port);
  await waitFor(() => p.out().includes("[pda-runner] READY agent=research"), "READY", 20000);
  p.child.stdin!.write("count my usage\n");
  await waitFor(() => p.out().includes("queued (submission"), "the ack", 10000);
  rig.fake.streamReply("research", ["usage reply"]);
  await waitFor(() => p.out().includes("── idle ──"), "the run to end", 10000);
  await waitFor(() => daemon.usagePosts.length >= 1, "the usage post", 10000);
  return p;
}

describe("(b) the real runner process: main()'s signal handlers, the SIGKILL path, and the lock", () => {
  let rig: Rig;
  let daemon: Awaited<ReturnType<typeof fakeDaemon>>;
  afterEach(async () => { await rig?.cleanup(); await daemon?.close(); });

  it.each(["SIGTERM", "SIGHUP"] as const)("%s: the runner stops, the usage close spills the pending fact, the lock is released, exit 0", async (signal) => {
    rig = await makeRig({ realStreams: true });
    daemon = await fakeDaemon("503");
    const p = await runnerWithPendingFact(rig, daemon, `proc-${signal}`);
    const lock = parsePdaRunnerLock(fs.readFileSync(rig.paths.runnerLockPath, "utf8"));
    expect(lock).toMatchObject({ pid: p.child.pid, launchId: `proc-${signal}` });     // present for the runner's whole life
    expect(fs.existsSync(rig.paths.usagePendingPath)).toBe(false);
    p.child.kill(signal);
    expect(await p.exit).toEqual({ code: 0, signal: null });
    expect(p.out()).toContain("[pda-runner] EXITED code=0");
    const spill = JSON.parse(fs.readFileSync(rig.paths.usagePendingPath, "utf8"));
    expect(JSON.stringify(spill)).toContain('"entryId"');                              // the fact survived the stop
    expect(fs.existsSync(rig.paths.runnerLockPath)).toBe(false);                       // and the lock went last
    expect(JSON.parse(fs.readFileSync(rig.paths.runnerStatePath, "utf8"))).toMatchObject({ exited: { code: 0 } });
  }, 60000);

  it("the release removes this process's lock and never a successor's", () => {
    const lockPath = path.join(tmp(), "runner.lock");
    const release = acquireRunnerLock(lockPath, "mine");
    expect(parsePdaRunnerLock(fs.readFileSync(lockPath, "utf8"))).toMatchObject({ pid: process.pid, launchId: "mine" });
    release();
    expect(fs.existsSync(lockPath)).toBe(false);
    const releaseAgain = acquireRunnerLock(lockPath, "mine");
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid + 1, launchId: "successor", at: NOW.toISOString() }));
    releaseAgain();
    expect(parsePdaRunnerLock(fs.readFileSync(lockPath, "utf8"))?.launchId).toBe("successor");
  });

  it("a runner that stops before its run loop (exit 4, a bad token file) still closes the usage sink: main()'s backstop posts the facts a prior stop spilled, and clears the spill", async () => {
    rig = await makeRig({ realStreams: true, tokenFileContent: "not-a-pda-token" });
    daemon = await fakeDaemon("200");
    // A prior stop's spill, written by the real sink under the envelope this process will run with.
    const prior = createPdaUsageSink({
      sessionName: rig.args.sessionName, nodeId: "proc-node", generation: null, agent: "research", baseUrl: rig.args.baseUrl,
      isOwnSubmission: () => true, post: async () => "keep", spillPath: rig.paths.usagePendingPath,
    });
    prior.onRunStart!({ type: "run_start", inputs: [1] } as never);
    prior.onAssistantEntry!(assistantEntry(7, "T", { usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 18, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } } }));
    prior.onRunEnd!({ type: "run_end", inputs: [1] } as never);
    await prior.settled();
    await prior.close(50);
    expect(fs.existsSync(rig.paths.usagePendingPath)).toBe(true);
    const argv = buildPdaRunnerArgv({
      sessionName: rig.args.sessionName, stateRoot: rig.args.stateRoot, launchId: "proc-exit4",
      binding: { agent: "research", baseUrl: rig.args.baseUrl }, tokenFile: rig.args.tokenFile, usageFacts: true,
    });
    const p = spawnRunner(argv, tmp(), daemon.port);
    expect((await p.exit).code).toBe(4);
    expect(daemon.usagePosts).toHaveLength(1);
    expect(JSON.stringify(JSON.parse(daemon.usagePosts[0]!))).toContain('"7"');
    expect(fs.existsSync(rig.paths.usagePendingPath)).toBe(false);
    expect(fs.existsSync(rig.paths.runnerLockPath)).toBe(false);   // the early exit releases the lock too
  }, 60000);

  it("SIGKILL: no close, no spill, no exit marker; the lock stays with a pid that is dead, and a launch is not held up by it", async () => {
    rig = await makeRig({ realStreams: true });
    daemon = await fakeDaemon("503");
    const p = await runnerWithPendingFact(rig, daemon, "proc-kill");
    const pid = p.child.pid!;
    p.child.kill("SIGKILL");
    expect(await p.exit).toEqual({ code: null, signal: "SIGKILL" });
    expect(p.out()).not.toContain("EXITED");
    expect(fs.existsSync(rig.paths.usagePendingPath)).toBe(false);                     // the pending fact is lost: a kill skips close()
    expect(JSON.parse(fs.readFileSync(rig.paths.runnerStatePath, "utf8")).exited).toBeUndefined();
    expect(parsePdaRunnerLock(fs.readFileSync(rig.paths.runnerLockPath, "utf8"))?.pid).toBe(pid);
    const typedAt: number[] = [];
    const adapter = new PdaRuntimeAdapter({
      tmux: { sendShellCommand: async () => { typedAt.push(Date.now()); return { ok: true as const }; }, hasSession: async () => true, getPaneCommand: async () => "node", capturePaneContent: async () => "" } as never,
      fsOps: { readFile: (f) => fs.readFileSync(f, "utf8"), exists: (f) => fs.existsSync(f), lstat: (f) => { try { return { isFile: fs.lstatSync(f).isFile() }; } catch { return null; } } },
      stateRoot: rig.args.stateRoot, runnerEntryPath: "/dist/pda-runner.js", tokenFile: () => rig.args.tokenFile,
      pollMs: 10, launchWaitMs: 20, oldRunnerWaitMs: 30_000,                        // real pid check: the dead pid must end the wait at once
    });
    const t0 = Date.now();
    await adapter.launchHarness({ id: "b", nodeId: "n", tmuxSession: rig.args.sessionName, tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "/", pda: { agent: "research", baseUrl: rig.args.baseUrl } }, { name: "x" });
    expect(typedAt).toHaveLength(1);
    expect(typedAt[0]! - t0).toBeLessThan(2000);
  }, 60000);
});

describe("(d) the restart race: the next runner is not started until the old one has spilled and released", () => {
  let rig: Rig;
  let daemon: Awaited<ReturnType<typeof fakeDaemon>>;
  afterEach(async () => { await rig?.cleanup(); await daemon?.close(); });

  it("old runner mid-close (its post hangs, so close() runs its 5 s budget): launchHarness types only after the spill is on disk and the lock is gone", async () => {
    rig = await makeRig({ realStreams: true });
    daemon = await fakeDaemon("hang");
    const p = await runnerWithPendingFact(rig, daemon, "old-runner");
    let atTyping: { spill: boolean; lock: boolean } | null = null;
    const adapter = new PdaRuntimeAdapter({
      tmux: {
        sendShellCommand: async () => { atTyping = { spill: fs.existsSync(rig.paths.usagePendingPath), lock: fs.existsSync(rig.paths.runnerLockPath) }; return { ok: true as const }; },
        hasSession: async () => true, getPaneCommand: async () => "node", capturePaneContent: async () => "",
      } as never,
      fsOps: { readFile: (f) => fs.readFileSync(f, "utf8"), exists: (f) => fs.existsSync(f), lstat: (f) => { try { return { isFile: fs.lstatSync(f).isFile() }; } catch { return null; } } },
      stateRoot: rig.args.stateRoot, runnerEntryPath: "/dist/pda-runner.js", tokenFile: () => rig.args.tokenFile,
      pollMs: 25, launchWaitMs: 20,
    });
    p.child.kill("SIGHUP");                  // what tmux kill-session does to the pane's foreground process
    const result = await adapter.launchHarness({ id: "b", nodeId: "n", tmuxSession: rig.args.sessionName, tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "/", pda: { agent: "research", baseUrl: rig.args.baseUrl } }, { name: "x" });
    expect(result.ok).toBe(false);           // the fake pane starts no new runner, so the attach wait times out: only the typing moment matters
    expect(atTyping).toEqual({ spill: true, lock: false });
    expect(await p.exit).toEqual({ code: 0, signal: null });
  }, 60000);
});

// ── (c) exit 70 ──────────────────────────────────────────────────────────────

describe("(c) exit 70: the fatal handler records the exit and leaves, without the usage sink's close()", () => {
  it("a pending usage fact is NOT spilled (documented: 'a hard crash or proc.exit(70) skips close()'), and the process is told to exit 70", async () => {
    const spillPath = path.join(tmp(), "usage-pending.json");
    const post = async (): Promise<PdaUsagePostResult> => "keep";
    const usage = createPdaUsageSink({ sessionName: SESSION, nodeId: "n1", generation: "g1", agent: "research", baseUrl: BASE, isOwnSubmission: () => true, post, spillPath });
    usage.onRunStart!({ type: "run_start", inputs: [1] } as never);
    usage.onAssistantEntry!(assistantEntry(1, "T", { usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 18, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } } }));
    usage.onRunEnd!({ type: "run_end", inputs: [1] } as never);
    await usage.settled();
    expect(usage.pending()).toHaveLength(1);
    const rig = await makeRig({ realStreams: true, usage });
    try {
      rig.start();
      await waitFor(() => rig.pane().includes("READY"), "READY");
      const handlers = new Map<string, (r: unknown) => void>();
      const exits: number[] = [];
      installPdaRunnerFatalHandlers({ on: (e, l) => { handlers.set(e, l); }, exit: (c) => { exits.push(c); } }, (label) => rig.runner.fatal(label));
      handlers.get("uncaughtException")!(new Error("boom"));
      expect(exits).toEqual([70]);
      expect(rig.sidecar()).toMatchObject({ exited: { code: 70 } });
      expect(fs.existsSync(spillPath)).toBe(false);
      expect(usage.pending()).toHaveLength(1);
    } finally { await rig.cleanup(); }
  }, 30000);
});
