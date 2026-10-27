// OF-119: (a) the Pi/OMP runner's sidecar has an alive tick, so `rig send` stops believing a hung runner's last
// `busy: false`; (b) an unclosed bracketed paste tells the operator what is holding Ctrl-C and Enter.
// Deployed chain: startup.ts passes runnerSendReadinessFromAdapters(map) (piAdapter, ompAdapter) to SessionTransport,
// whose send path asks PiRuntimeAdapter.sendReadiness; the seat's pi-runner main() builds RunnerCore, starts
// startAliveTick(core), writes the sidecar through writeSidecarAtomic, and builds its pane editor with
// wirePiRunnerInput (createRunnerInput, "content" mode). The pda runner shares createRunnerInput (the hint reaches its
// pane too); pda send gating is untouched.
// Production consequence (a): a runner whose event loop hangs keeps the last answer in its sidecar forever. Frozen at
// busy:false it reads idle, so a send is reported delivered into a pane that never reads it. (b): a paste whose end
// marker never arrives swallows Ctrl-C and Enter with nothing on screen saying why.
// The windows below are literals (60 s tick, 180 s alive window, 2 s hint); nothing here imports them.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
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
import { RunnerCore, startAliveTick, wirePiRunnerInput, writeSidecarAtomic, type RunnerIo } from "../src/adapters/pi-runner.js";
import { createRunnerInput } from "../src/adapters/runner-pane-io.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const SEAT = "dev-pi@my-rig";
const NOW = Date.UTC(2026, 9, 27, 10, 0, 0); // far from wall clock
const iso = (ms: number) => new Date(ms).toISOString();
const F1_FRAME = ["you ▸ plan it", "Plan drafted.", "Do you want to proceed with the migration?", "── idle ──"].join("\n");
const SESSION_FILE = "/state/pi/dev-pi@my-rig/sessions/s.jsonl";

// ── the runner writes an alive tick ──
describe("OF-119 runner: the sidecar carries aliveAt, and a ready runner ticks", () => {
  function core(runtime: "pi" | "omp", clock: { t: number }) {
    const sidecars: PiRunnerState[] = [];
    const io: RunnerIo = {
      sendRpc: () => undefined, mirrorLine: () => undefined, mirrorAppend: () => undefined,
      postActivity: () => undefined, writeSidecar: (s) => sidecars.push(s), now: () => iso(clock.t),
    };
    const c = new RunnerCore(io, { sessionName: SEAT, launchId: "l1" }, { runtime });
    return { c, sidecars, ready: () => c.handlePiLine(JSON.stringify({ type: "response", id: "pi-runner-get-state", data: { sessionFile: SESSION_FILE, sessionId: "s" } })) };
  }

  it("every write is stamped with the runner's clock, and tickAlive rewrites an idle runner's sidecar with a newer aliveAt", () => {
    const clock = { t: NOW };
    const { c, sidecars, ready } = core("pi", clock);
    c.start();
    ready();
    expect(sidecars.at(-1)).toMatchObject({ ready: true, busy: false, aliveAt: iso(NOW) });
    const before = sidecars.length;
    clock.t = NOW + 61_000;
    c.tickAlive();
    expect(sidecars.length).toBe(before + 1);
    expect(sidecars.at(-1)).toMatchObject({ ready: true, busy: false, aliveAt: iso(NOW + 61_000), updatedAt: iso(NOW + 61_000) });
  });

  it("a tick before the runner is ready writes nothing (the pending record is not an answer)", () => {
    const clock = { t: NOW };
    const { c, sidecars } = core("omp", clock);
    c.start();
    c.tickAlive();
    expect(sidecars).toEqual([]);
  });

  it("a tick after the child exited writes nothing: the exited record stays the last word", () => {
    const clock = { t: NOW };
    const { c, sidecars, ready } = core("pi", clock);
    c.start();
    ready();
    c.handlePiExit(1);
    const last = sidecars.at(-1)!;
    expect(last.exited).toMatchObject({ code: 1 });
    clock.t = NOW + 61_000;
    c.tickAlive();
    expect(sidecars.at(-1)).toBe(last);
  });

  it("a host wake (the wall clock jumps an hour while timers stood still) writes at the next 5 s check, not up to 60 s later", () => {
    vi.useFakeTimers();
    try {
      const tickAlive = vi.fn();
      const timer = startAliveTick({ tickAlive });
      vi.advanceTimersByTime(10_000);
      expect(tickAlive).toHaveBeenCalledTimes(0);
      vi.setSystemTime(Date.now() + 3_600_000); // sleep: Date moved an hour, the timers did not
      vi.advanceTimersByTime(5_000);
      expect(tickAlive).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(55_000); // the cadence restarts from the wake write
      expect(tickAlive).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(5_000);
      expect(tickAlive).toHaveBeenCalledTimes(2);
      clearInterval(timer);
    } finally { vi.useRealTimers(); }
  });

  it("a wall clock stepped back an hour also writes at the next check (aliveAt would otherwise read as the far future)", () => {
    vi.useFakeTimers();
    try {
      const tickAlive = vi.fn();
      const timer = startAliveTick({ tickAlive });
      vi.advanceTimersByTime(10_000);
      vi.setSystemTime(Date.now() - 3_600_000);
      vi.advanceTimersByTime(5_000);
      expect(tickAlive).toHaveBeenCalledTimes(1);
      clearInterval(timer);
    } finally { vi.useRealTimers(); }
  });

  it("startAliveTick ticks once per 60 s, and never keeps the process alive (unref'd)", () => {
    vi.useFakeTimers();
    try {
      const tickAlive = vi.fn();
      const timer = startAliveTick({ tickAlive });
      vi.advanceTimersByTime(59_999);
      expect(tickAlive).toHaveBeenCalledTimes(0);
      vi.advanceTimersByTime(1);
      expect(tickAlive).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(120_000);
      expect(tickAlive).toHaveBeenCalledTimes(3);
      expect(timer.hasRef()).toBe(false);
      clearInterval(timer);
    } finally { vi.useRealTimers(); }
  });
});

describe("OF-119 runner: the sidecar is replaced atomically", () => {
  const state = (): PiRunnerState => ({ ready: true, updatedAt: iso(NOW), busy: false });
  it("writes a temp file next to the sidecar and renames it over: the sidecar path itself is never written in place", () => {
    const calls: string[] = [];
    writeSidecarAtomic({ writeFile: (p, c) => { calls.push(`write ${p} ${c.length > 0}`); }, rename: (a, b) => { calls.push(`rename ${a} ${b}`); } }, "/s/runner-state.json", state());
    expect(calls).toEqual(["write /s/runner-state.json.tmp true", "rename /s/runner-state.json.tmp /s/runner-state.json"]);
  });

  it("a write that fails part way leaves the previous sidecar intact and throws nothing (real files)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "of119-atomic-"));
    try {
      const file = path.join(dir, "runner-state.json");
      fs.writeFileSync(file, JSON.stringify({ ready: true, updatedAt: "old", busy: true }));
      writeSidecarAtomic({ writeFile: (p) => { fs.writeFileSync(p, '{"ready":tr'); throw new Error("ENOSPC"); }, rename: (a, b) => fs.renameSync(a, b) }, file, state());
      expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ updatedAt: "old", busy: true });
      writeSidecarAtomic({ writeFile: (p, c) => fs.writeFileSync(p, c), rename: (a, b) => fs.renameSync(a, b) }, file, state());
      expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ updatedAt: iso(NOW), busy: false });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

// ── the adapter and the real transport believe the sidecar only while it ticks ──
describe("OF-119 adapter and transport: a sidecar that stopped ticking is no answer", () => {
  let db: Database.Database;
  let dir: string;
  let stateRoot: string;
  beforeEach(() => {
    db = createFullTestDb();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "of119-pi-send-"));
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
  const sidecar = (over: Record<string, unknown>) =>
    fs.writeFileSync(sidecarPath(), JSON.stringify({ ready: true, launchId: "l1", updatedAt: iso(NOW), busy: false, ...over }));

  function setup() {
    const sendText = vi.fn(async () => ({ ok: true as const }));
    const tmux = {
      hasSession: async () => true, probeSession: async () => ({ state: "present" as const }), sendText, sendKeys: vi.fn(async () => ({ ok: true as const })),
      capturePaneContent: async () => F1_FRAME, createSession: async () => ({ ok: true as const }), killSession: async () => ({ ok: true as const }),
      listSessions: async () => [], listWindows: async () => [], listPanes: async () => [],
      startPipePane: async () => ({ ok: true as const }), stopPipePane: async () => ({ ok: true as const }),
      getPanePid: async () => null, getPaneCommand: async () => "node",
    } as unknown as TmuxAdapter;
    const deps = {
      tmux, stateRoot, runnerEntryPath: "/x/pi-runner.js", now: () => new Date(NOW),
      fsOps: { readFile: (p: string) => fs.readFileSync(p, "utf8"), exists: (p: string) => fs.existsSync(p), writeFile: () => undefined, mkdirp: () => undefined },
    };
    const pi = new PiRuntimeAdapter(deps);
    const omp = new OmpRuntimeAdapter(deps);
    const map: Record<string, RuntimeAdapter> = { "claude-code": { runtime: "claude-code" } as RuntimeAdapter, pi, omp };
    const transport = new SessionTransport({
      db, rigRepo: new RigRepository(db), sessionRegistry: new SessionRegistry(db), tmuxAdapter: tmux,
      agentActivityStore: new AgentActivityStore({ db, eventBus: new EventBus(db) }), eventBus: new EventBus(db), waitForIdlePollMs: 1,
      now: () => new Date(NOW), runnerSendReadiness: runnerSendReadinessFromAdapters(map),
    });
    return { pi, omp, transport, sendText };
  }
  const target = { sessionName: SEAT, nodeId: null };

  it.each([
    ["just written", NOW, true],
    ["60 s old (one tick behind)", NOW - 60_000, true],
    ["exactly the 180 s window", NOW - 180_000, true],
    ["181 s old (three ticks missed)", NOW - 181_000, false],
    ["an hour old", NOW - 3_600_000, false],
    ["180 s in the future (a clock jump)", NOW + 180_000, true],
    ["181 s in the future (a forged or skewed file)", NOW + 181_000, false],
  ])("adapter: aliveAt %s", async (_name, aliveMs, believed) => {
    const { pi, omp } = setup();
    sidecar({ aliveAt: iso(aliveMs) });
    for (const adapter of [pi, omp]) {
      const answer = await adapter.sendReadiness(target);
      if (believed) expect(answer).toMatchObject({ state: "idle", reason: "runner_idle", evidenceSource: "runner_sidecar" });
      else expect(answer).toBeNull();
    }
  });

  it.each([
    ["an unparseable aliveAt", "not a time"],
    ["a non-string aliveAt", 12345],
    ["a null aliveAt", null],
  ])("adapter: %s is no answer", async (_name, aliveAt) => {
    const { pi } = setup();
    sidecar({ aliveAt });
    expect(await pi.sendReadiness(target)).toBeNull();
  });

  it("adapter: a sidecar with no aliveAt is a runner older than OF-119, believed as before from busy (idle, and running)", async () => {
    const { pi, omp } = setup();
    sidecar({ aliveAt: undefined });
    expect(await pi.sendReadiness(target)).toMatchObject({ state: "idle", reason: "runner_idle", evidenceSource: "runner_sidecar" });
    expect(await omp.sendReadiness(target)).toMatchObject({ state: "idle", reason: "runner_idle", evidenceSource: "runner_sidecar" });
    sidecar({ aliveAt: undefined, busy: true });
    expect(await pi.sendReadiness(target)).toMatchObject({ state: "running", reason: "run_active" });
  });

  it("transport: a runner started before this release (no aliveAt) still decides, so a question-ending frame does not refuse the send after the daemon is released", async () => {
    sidecar({ aliveAt: undefined });
    const { transport, sendText } = setup();
    const r = await transport.send(SEAT, "hello");
    expect(r.ok).toBe(true);
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it("adapter: a busy runner is believed running only while it ticks too", async () => {
    const { pi } = setup();
    sidecar({ busy: true, aliveAt: iso(NOW - 10_000) });
    expect(await pi.sendReadiness(target)).toMatchObject({ state: "running", reason: "run_active" });
    sidecar({ busy: true, aliveAt: iso(NOW - 600_000) });
    expect(await pi.sendReadiness(target)).toBeNull();
  });

  it("transport: a hung runner (sidecar frozen at busy:false, no tick for 10 minutes) no longer authorises the send; today's pane logic decides (the question-ending frame refuses), 0 bytes", async () => {
    sidecar({ aliveAt: iso(NOW - 600_000) });
    const { transport, sendText } = setup();
    const r = await transport.send(SEAT, "hello");
    expect(r.ok).toBe(false);
    expect(r.activity?.evidenceSource).not.toBe("runner_sidecar");
    expect(sendText).not.toHaveBeenCalled();
  });

  // OF-129: checkReady uses the same alive window as sendReadiness (the pane here shows `node`, not a shell, with a READY line in scrollback).
  const binding = { id: "b1", nodeId: "n1", tmuxSession: SEAT, tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "/p" } as never;
  it.each([
    ["just written", NOW, true],
    ["exactly the 180 s window", NOW - 180_000, true],
    ["181 s old", NOW - 181_000, false],
    ["an hour old", NOW - 3_600_000, false],
    ["180 s in the future", NOW + 180_000, true],
    ["181 s in the future", NOW + 181_000, false],
  ])("checkReady: a ready sidecar whose aliveAt is %s", async (_name, aliveMs, ready) => {
    const { pi, omp } = setup();
    sidecar({ aliveAt: iso(aliveMs) });
    for (const adapter of [pi, omp]) {
      const result = await adapter.checkReady(binding);
      if (ready) expect(result).toEqual({ ready: true });
      else expect(result).toMatchObject({ ready: false, code: "runner_stale" });
    }
  });
  it("checkReady: an unparseable aliveAt is stale; no aliveAt at all is an older runner and is believed", async () => {
    const { pi } = setup();
    sidecar({ aliveAt: "not a time" });
    expect(await pi.checkReady(binding)).toMatchObject({ ready: false, code: "runner_stale" });
    sidecar({ aliveAt: undefined });
    expect(await pi.checkReady(binding)).toEqual({ ready: true });
  });
  it("checkReady: an exited record is still reported as exited, not stale, whatever its age", async () => {
    const { pi } = setup();
    sidecar({ aliveAt: iso(NOW - 3_600_000), ready: false, exited: { code: 1, at: iso(NOW - 3_600_000) } });
    expect(await pi.checkReady(binding)).toMatchObject({ ready: false, code: "runner_exited" });
  });

  it("transport: control, the same sidecar with a fresh tick decides and the send goes", async () => {
    sidecar({ aliveAt: iso(NOW - 1_000) });
    const { transport, sendText } = setup();
    expect((await transport.send(SEAT, "hello")).ok).toBe(true);
    expect(sendText).toHaveBeenCalledTimes(1);
  });
});

// ── the unclosed-paste hint ──
describe("OF-119 pane editor: an unclosed paste says what holds Ctrl-C and Enter", () => {
  const START = "\u001b[200~";
  const END = "\u001b[201~";
  const ETX = "\u0003";
  function editor(wire: "pi" | "default") {
    const submitted: string[] = [];
    const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: false,
      setRawMode: vi.fn(function (this: { isRaw: boolean }, value: boolean) { this.isRaw = value; }) });
    const out = new PassThrough();
    const output = Object.assign(out, { isTTY: true, columns: 80 });
    let text = "";
    out.on("data", (b) => { text += b.toString(); });
    const rl = wire === "pi"
      ? wirePiRunnerInput({ handleUserBlock: (b: string) => submitted.push(b) }, input as unknown as NodeJS.ReadStream, output as unknown as NodeJS.WriteStream)
      : createRunnerInput(input as unknown as NodeJS.ReadStream, output as unknown as NodeJS.WriteStream, (b) => submitted.push(b));
    return { input, rl, submitted, hints: () => text.split("\n").filter((l) => l.includes("paste still open")) };
  }

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("a paste that stays open for 2 s prints one hint naming the held keys and the way out; not before", () => {
    const t = editor("pi");
    try {
      t.input.write(START + "torn paste");
      vi.advanceTimersByTime(1_999);
      expect(t.hints()).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(t.hints()).toHaveLength(1);
      expect(t.hints()[0]).toContain("[pi-runner] paste still open");
      expect(t.hints()[0]).toContain("Ctrl-C and Enter are pasted text");
      expect(t.hints()[0]).toContain("[201~");
      vi.advanceTimersByTime(120_000);
      expect(t.hints()).toHaveLength(1); // once per open paste
    } finally { t.rl.close(); }
  });

  it("the Pi/OMP hint says Ctrl-C also aborts the current turn; the pda editor (own interrupt) says it only clears the line", () => {
    const pi = editor("pi");
    try {
      pi.input.write(START + "torn");
      vi.advanceTimersByTime(10_000);
      expect(pi.hints()[0]).toContain("clears the line and aborts the current turn");
    } finally { pi.rl.close(); }
    const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode: vi.fn() });
    const out = new PassThrough();
    const output = Object.assign(out, { isTTY: true, columns: 80 });
    let text = "";
    out.on("data", (b) => { text += b.toString(); });
    const rl = createRunnerInput(input as unknown as NodeJS.ReadStream, output as unknown as NodeJS.WriteStream, () => undefined,
      { label: "pda-runner", interruptInsidePaste: "content", onInterrupt: () => undefined });
    try {
      input.write(START + "torn");
      vi.advanceTimersByTime(10_000);
      expect(text).toContain("[pda-runner] paste still open");
      expect(text).toContain("clears the line.");
      expect(text).not.toContain("abort");
    } finally { rl.close(); }
  });

  it("the hint's way out works: typing Esc then [201~ closes the paste, and the next Ctrl-C clears and aborts", () => {
    const t = editor("pi");
    try {
      t.input.write(START + "torn paste");
      vi.advanceTimersByTime(10_000);
      t.input.write("\u001b");
      t.input.write("[201~");
      t.input.write(ETX);
      expect(t.submitted).toEqual(["/abort"]);
    } finally { t.rl.close(); }
  });

  it("a paste that closes in time prints nothing, even long after", () => {
    const t = editor("pi");
    try {
      t.input.write(START + "fine" + END);
      vi.advanceTimersByTime(60_000);
      expect(t.hints()).toEqual([]);
    } finally { t.rl.close(); }
  });

  it("closing a paste after the hint, then opening another, arms a fresh hint", () => {
    const t = editor("pi");
    try {
      t.input.write(START + "a");
      vi.advanceTimersByTime(10_000);
      t.input.write(END);
      t.input.write(START + "b");
      vi.advanceTimersByTime(10_000);
      expect(t.hints()).toHaveLength(2);
    } finally { t.rl.close(); }
  });

  it("closing the editor with a paste open cancels the hint", () => {
    const t = editor("pi");
    t.input.write(START + "torn");
    t.rl.close();
    vi.advanceTimersByTime(60_000);
    expect(t.hints()).toEqual([]);
  });

  it("control: in the default mode a Ctrl-C ends a paste, so there is nothing to hint", () => {
    const t = editor("default");
    try {
      t.input.write(START + "torn");
      vi.advanceTimersByTime(60_000);
      expect(t.hints()).toEqual([]);
    } finally { t.rl.close(); }
  });
});
