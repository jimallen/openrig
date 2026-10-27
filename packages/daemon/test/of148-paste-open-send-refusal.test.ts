// OF-148 (product call, option A): a runner whose pane editor holds a bracketed paste that never closed records
// `pasteOpen: true` in its sidecar, and `rig send` to that seat refuses with the remedy instead of delivering text the
// open paste swallows (or tears, with the raw ESC[200~ in it).
// Deployed chain: startup.ts passes runnerSendReadinessFromAdapters(map) (pi, omp, pda adapters) to SessionTransport;
// its send path asks PiRuntimeAdapter / PdaRuntimeAdapter.sendReadiness, which reads the sidecar the seat's runner
// (pi-runner.ts main -> RunnerCore, pda-runner.ts main -> PdaRunner) writes; both build their pane editor with
// createRunnerInput in "content" mode (wirePiRunnerInput / wirePdaRunnerInput), which is where the paste is observed.
// Production consequence: a paste whose end marker is lost keeps Ctrl-C and Enter as pasted text. Before this, every
// later `rig send` was typed into that paste and reported delivered, with nothing on the sender's side saying why.
// The 10 s delay, the 180 s alive window and the field name are literals here; nothing imports them.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, mockTmuxAdapter } from "./helpers/test-app.js";
import { makeRig, snapshotEvent, waitFor, type Rig } from "./helpers/pda-runner-rig.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import { runnerSendReadinessFromAdapters, type RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import { PiRuntimeAdapter } from "../src/adapters/pi-runtime-adapter.js";
import { OmpRuntimeAdapter } from "../src/adapters/omp-runtime-adapter.js";
import { PdaRuntimeAdapter } from "../src/adapters/pda-runtime-adapter.js";
import { piSeatPaths, parsePiRunnerState, type PiRunnerState } from "../src/adapters/pi-runner-protocol.js";
import { pdaSeatPaths, parsePdaRunnerState, type PdaRunnerState } from "../src/adapters/pda-runner-protocol.js";
import { RunnerCore, wirePiRunnerInput, type RunnerIo } from "../src/adapters/pi-runner.js";
import { wirePdaRunnerInput } from "../src/adapters/pda-runner.js";
import { createRunnerInput } from "../src/adapters/runner-pane-io.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const START = "\u001b[200~";
const END = "\u001b[201~";
const NOW = Date.UTC(2026, 9, 27, 10, 0, 0); // far from wall clock
const iso = (ms: number) => new Date(ms).toISOString();
const SESSION_FILE = "/state/pi/dev-pi@my-rig/sessions/s.jsonl";

// A PassThrough with the three TTY members the editor reads. These guards are the one place the double is declared to
// be the runner's stdin/stdout; the editor touches nothing else (isTTY, setRawMode, isRaw, write/on).
function isTtyIn(s: PassThrough): s is PassThrough & NodeJS.ReadStream { return true; }
function isTtyOut(s: PassThrough): s is PassThrough & NodeJS.WriteStream { return true; }

function terminal() {
  const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: false,
    setRawMode: vi.fn(function (this: { isRaw: boolean }, value: boolean) { this.isRaw = value; }) });
  const out = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
  let text = "";
  out.on("data", (b) => { text += b.toString(); });
  if (!isTtyIn(input) || !isTtyOut(out)) throw new Error("unreachable: the guards are total");
  return { input, stdin: input, stdout: out, screen: () => text };
}

// ── the editor reports the open paste ──
describe("OF-148 pane editor: an open paste is reported once it has stayed open, and its end is reported", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function editor(options: { content: boolean; throwing?: boolean }) {
    const t = terminal();
    const edges: boolean[] = [];
    const rl = createRunnerInput(t.stdin, t.stdout, () => undefined, {
      ...(options.content ? { interruptInsidePaste: "content" as const } : {}),
      onPasteOpenChange: (open) => { edges.push(open); if (options.throwing) throw new Error("sidecar write failed"); },
    });
    return { ...t, rl, edges };
  }

  it("reports open when the paste has stayed open 10 s (not at 9.999 s), once however long it stays", () => {
    const t = editor({ content: true });
    try {
      t.input.write(START + "torn");
      vi.advanceTimersByTime(9_999);
      expect(t.edges).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(t.edges).toEqual([true]);
      vi.advanceTimersByTime(300_000);
      expect(t.edges).toEqual([true]);
    } finally { t.rl.close(); }
  });

  it("a paste that closes in time reports nothing at all, before or after the delay", () => {
    const t = editor({ content: true });
    try {
      t.input.write(START + "fine" + END);
      vi.advanceTimersByTime(60_000);
      expect(t.edges).toEqual([]);
    } finally { t.rl.close(); }
  });

  it("the closing marker reports closed; a later paste that stays open reports open again", () => {
    const t = editor({ content: true });
    try {
      t.input.write(START + "a");
      vi.advanceTimersByTime(10_000);
      t.input.write(END);
      expect(t.edges).toEqual([true, false]);
      t.input.write(START + "b");
      vi.advanceTimersByTime(10_000);
      expect(t.edges).toEqual([true, false, true]);
    } finally { t.rl.close(); }
  });

  it("the hint's own way out (Esc, then [201~ typed by hand) reports closed", () => {
    const t = editor({ content: true });
    try {
      t.input.write(START + "torn");
      vi.advanceTimersByTime(10_000);
      t.input.write("\u001b");
      t.input.write("[201~");
      expect(t.edges).toEqual([true, false]);
    } finally { t.rl.close(); }
  });

  it("closing the editor with the paste open reports closed (the owner is not left holding true)", () => {
    const t = editor({ content: true });
    t.input.write(START + "torn");
    vi.advanceTimersByTime(10_000);
    t.rl.close();
    expect(t.edges).toEqual([true, false]);
  });

  it("closing the editor before the delay reports nothing", () => {
    const t = editor({ content: true });
    t.input.write(START + "torn");
    t.rl.close();
    vi.advanceTimersByTime(60_000);
    expect(t.edges).toEqual([]);
  });

  it("control: in the default mode a Ctrl-C ends a paste, so nothing is ever reported", () => {
    const t = editor({ content: false });
    try {
      t.input.write(START + "torn");
      vi.advanceTimersByTime(60_000);
      expect(t.edges).toEqual([]);
    } finally { t.rl.close(); }
  });

  it("a report that throws (a sidecar write failing) does not stop the on-pane hint or the editor", () => {
    const t = editor({ content: true, throwing: true });
    try {
      t.input.write(START + "torn");
      vi.advanceTimersByTime(10_000);
      expect(t.edges).toEqual([true]);
      expect(t.screen()).toContain("paste still open");
      t.input.write(END);
      expect(t.edges).toEqual([true, false]);
    } finally { t.rl.close(); }
  });
});

// ── the Pi/OMP runner records it ──
describe("OF-148 Pi/OMP runner: the sidecar carries pasteOpen only while a paste is open", () => {
  function core(runtime: "pi" | "omp", clock: { t: number }) {
    const sidecars: PiRunnerState[] = [];
    const io: RunnerIo = {
      sendRpc: () => undefined, mirrorLine: () => undefined, mirrorAppend: () => undefined,
      postActivity: () => undefined, writeSidecar: (s) => sidecars.push(s), now: () => iso(clock.t),
    };
    const c = new RunnerCore(io, { sessionName: "dev-pi@my-rig", launchId: "l1" }, { runtime });
    const ready = () => c.handlePiLine(JSON.stringify({ type: "response", id: "pi-runner-get-state", data: { sessionFile: SESSION_FILE, sessionId: "s" } }));
    return { c, sidecars, ready };
  }

  it.each(["pi", "omp"] as const)("%s: open writes at once with pasteOpen true; every tick keeps it; closing writes at once without the key", (runtime) => {
    const clock = { t: NOW };
    const { c, sidecars, ready } = core(runtime, clock);
    c.start();
    ready();
    expect("pasteOpen" in sidecars.at(-1)!).toBe(false); // closed is the absence of the key, as an older runner writes it
    const before = sidecars.length;
    clock.t = NOW + 10_000;
    c.setPasteOpen(true);
    expect(sidecars.length).toBe(before + 1);
    expect(sidecars.at(-1)).toMatchObject({ ready: true, busy: false, pasteOpen: true, aliveAt: iso(NOW + 10_000) });
    clock.t = NOW + 70_000;
    c.tickAlive();
    expect(sidecars.at(-1)).toMatchObject({ pasteOpen: true, aliveAt: iso(NOW + 70_000) });
    clock.t = NOW + 80_000;
    c.setPasteOpen(false);
    expect(sidecars.length).toBe(before + 3);
    expect(sidecars.at(-1)).toMatchObject({ ready: true, aliveAt: iso(NOW + 80_000) });
    expect("pasteOpen" in sidecars.at(-1)!).toBe(false);
  });

  it("the sidecar with pasteOpen still carries what an older daemon reads (ready, busy, aliveAt, updatedAt) and parses", () => {
    const clock = { t: NOW };
    const { c, sidecars, ready } = core("pi", clock);
    c.start();
    ready();
    c.setPasteOpen(true);
    const written = sidecars.at(-1)!;
    expect(written).toMatchObject({ ready: true, busy: false, updatedAt: iso(NOW), aliveAt: iso(NOW), launchId: "l1" });
    expect(parsePiRunnerState(JSON.stringify(written))).toMatchObject({ ready: true, pasteOpen: true });
  });

  it("before the runner is ready nothing is written (the pending record stays), but the flag is kept for the first ready write", () => {
    const clock = { t: NOW };
    const { c, sidecars, ready } = core("pi", clock);
    c.start();
    const before = sidecars.length;
    c.setPasteOpen(true);
    expect(sidecars.length).toBe(before);
    ready();
    expect(sidecars.at(-1)).toMatchObject({ ready: true, pasteOpen: true });
  });

  it("after the child exited an open paste writes nothing and the exited record, without pasteOpen, stays the last word", () => {
    const clock = { t: NOW };
    const { c, sidecars, ready } = core("pi", clock);
    c.start();
    ready();
    c.setPasteOpen(true);
    c.handlePiExit(1);
    const last = sidecars.at(-1)!;
    expect(last.exited).toMatchObject({ code: 1 });
    expect("pasteOpen" in last).toBe(false);
    c.setPasteOpen(true);
    c.setPasteOpen(false);
    expect(sidecars.at(-1)).toBe(last);
  });

  it("wiring: wirePiRunnerInput reports the editor's edges to the core", () => {
    vi.useFakeTimers();
    const t = terminal();
    const setPasteOpen = vi.fn();
    const rl = wirePiRunnerInput({ handleUserBlock: () => undefined, setPasteOpen }, t.stdin, t.stdout);
    try {
      t.input.write(START + "torn");
      vi.advanceTimersByTime(10_000);
      expect(setPasteOpen.mock.calls).toEqual([[true]]);
      t.input.write(END);
      expect(setPasteOpen.mock.calls).toEqual([[true], [false]]);
    } finally { rl.close(); vi.useRealTimers(); }
  });

  it("wiring: a core without setPasteOpen (an editor built by an older test double) is not called", () => {
    vi.useFakeTimers();
    const t = terminal();
    const rl = wirePiRunnerInput({ handleUserBlock: () => undefined }, t.stdin, t.stdout);
    try {
      t.input.write(START + "torn");
      expect(() => vi.advanceTimersByTime(10_000)).not.toThrow();
    } finally { rl.close(); vi.useRealTimers(); }
  });
});

// ── the pda runner records it ──
describe("OF-148 pda runner: the sidecar carries pasteOpen only while a paste is open", () => {
  let rigs: Rig[] = [];
  afterEach(async () => {
    vi.useRealTimers();
    for (const r of rigs) await r.cleanup();
    rigs = [];
  });
  async function attached() {
    const rig = await makeRig({ realStreams: false });
    rigs.push(rig);
    rig.start();
    const stream = await rig.stream();
    stream.push(snapshotEvent());
    await waitFor(() => rig.pane().includes("READY"), "READY");
    return rig;
  }

  it("an open paste past 10 s is in the sidecar at once; closing it removes the key at once", async () => {
    const rig = await attached();
    expect(rig.sidecar()).not.toHaveProperty("pasteOpen");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = terminal();
    const editor = wirePdaRunnerInput(rig.runner, t.stdin, t.stdout);
    try {
      t.input.write(START + "torn");
      vi.advanceTimersByTime(9_999);
      expect(rig.sidecar()).not.toHaveProperty("pasteOpen");
      vi.advanceTimersByTime(1);
      expect(rig.sidecar()).toMatchObject({ ready: true, connected: true, busy: false, pasteOpen: true });
      t.input.write(END);
      expect(rig.sidecar()).not.toHaveProperty("pasteOpen");
      expect(rig.sidecar()).toMatchObject({ ready: true });
    } finally { editor.close(); }
  });

  it("a paste that closes in time never touches the sidecar's key", async () => {
    const rig = await attached();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = terminal();
    const editor = wirePdaRunnerInput(rig.runner, t.stdin, t.stdout);
    try {
      t.input.write(START + "fine" + END);
      vi.advanceTimersByTime(60_000);
      expect(rig.sidecar()).not.toHaveProperty("pasteOpen");
    } finally { editor.close(); }
  });

  it("after the runner stopped, an open paste is not written and the exited record carries no pasteOpen", async () => {
    const rig = await attached();
    rig.runner.setPasteOpen(true);
    expect(rig.sidecar()).toMatchObject({ pasteOpen: true });
    await rig.stop();
    const stopped = rig.sidecarRaw();
    expect(rig.sidecar().exited).toBeDefined();
    expect(rig.sidecar()).not.toHaveProperty("pasteOpen");
    await new Promise((r) => setTimeout(r, 25)); // the runner stamps with the wall clock: a rewrite would carry a later aliveAt
    rig.runner.setPasteOpen(true);
    expect(rig.sidecarRaw()).toBe(stopped);
  });
});

// ── the daemon refuses ──
describe("OF-148 daemon: rig send to a runner seat with an open paste refuses with the remedy", () => {
  const PI_SEAT = "dev-pi@my-rig";
  const OMP_SEAT = "dev-omp@my-rig";
  const PDA_SEAT = "dev-pda@my-rig";
  // Neutral pane text: when the runner gives no answer, today's pane logic lets a send through (so a refusal here is the sidecar's).
  const PANE = ["you ▸ plan it", "Plan drafted.", "── idle ──"].join("\n");
  let db: Database.Database;
  let dir: string;
  let piRoot: string;
  let pdaRoot: string;

  beforeEach(() => {
    db = createFullTestDb();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "of148-"));
    piRoot = path.join(dir, "state", "pi");
    pdaRoot = path.join(dir, "state", "pda");
    const rigRepo = new RigRepository(db);
    const rig = rigRepo.createRig("my-rig");
    const sessions = new SessionRegistry(db);
    for (const [seat, logical, runtime, root, paths] of [
      [PI_SEAT, "dev.pi", "pi", piRoot, piSeatPaths],
      [OMP_SEAT, "dev.omp", "omp", piRoot, piSeatPaths],
      [PDA_SEAT, "dev.pda", "pda", pdaRoot, pdaSeatPaths],
    ] as const) {
      fs.mkdirSync(paths(root, seat).seatRoot, { recursive: true });
      const node = rigRepo.addNode(rig.id, logical, { role: "worker", runtime });
      const session = sessions.registerSession(node.id, seat);
      sessions.updateStatus(session.id, "running");
      sessions.updateBinding(node.id, { tmuxSession: seat });
    }
  });
  afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const piSidecar = (seat: string, over: Record<string, unknown> = {}) =>
    fs.writeFileSync(piSeatPaths(piRoot, seat).runnerStatePath, JSON.stringify({ ready: true, launchId: "l1", updatedAt: iso(NOW), aliveAt: iso(NOW), busy: false, ...over }));
  const pdaSidecar = (over: Record<string, unknown> = {}) =>
    fs.writeFileSync(pdaSeatPaths(pdaRoot, PDA_SEAT).runnerStatePath, JSON.stringify({
      ready: true, launchId: "l1", updatedAt: iso(NOW), aliveAt: iso(NOW), agent: "research", baseUrl: "http://127.0.0.1:8150",
      connected: true, busy: false, outboxPending: 0, ...over,
    }));

  function setup(options: { paneCommand?: string; clock?: { t: number } } = {}) {
    const clock = options.clock ?? { t: NOW };
    const sendText = vi.fn(async () => ({ ok: true as const }));
    const sendKeys = vi.fn(async () => ({ ok: true as const }));
    const tmux: TmuxAdapter = Object.assign(mockTmuxAdapter(), {
      hasSession: async () => true, probeSession: async () => ({ state: "present" as const }), sendText, sendKeys,
      capturePaneContent: async () => PANE, getPanePid: async () => null, getPaneCommand: async () => options.paneCommand ?? "node",
      stopPipePane: async () => ({ ok: true as const }),
    });
    const piDeps = {
      tmux, stateRoot: piRoot, runnerEntryPath: "/x/pi-runner.js", now: () => new Date(clock.t),
      fsOps: { readFile: (p: string) => fs.readFileSync(p, "utf8"), exists: (p: string) => fs.existsSync(p), writeFile: () => undefined, mkdirp: () => undefined },
    };
    const pda = new PdaRuntimeAdapter({
      tmux, stateRoot: pdaRoot, runnerEntryPath: "/x/pda-runner.js", tokenFile: () => "/nope", now: () => new Date(clock.t),
      fsOps: { readFile: (p) => fs.readFileSync(p, "utf8"), exists: (p) => fs.existsSync(p), lstat: () => null },
    });
    const pi = new PiRuntimeAdapter(piDeps);
    const omp = new OmpRuntimeAdapter(piDeps);
    const map: Record<string, Pick<RuntimeAdapter, "sendReadiness">> = { pi, omp, pda };
    const eventBus = new EventBus(db);
    const transport = new SessionTransport({
      db, rigRepo: new RigRepository(db), sessionRegistry: new SessionRegistry(db), tmuxAdapter: tmux,
      agentActivityStore: new AgentActivityStore({ db, eventBus }), eventBus, waitForIdlePollMs: 1,
      now: () => new Date(clock.t), runnerSendReadiness: runnerSendReadinessFromAdapters(map),
    });
    return { transport, sendText, sendKeys, pi, omp, pda, clock };
  }

  const REMEDY = "Esc then [201~";
  const SEATS = [
    ["pi", PI_SEAT, (over: Record<string, unknown> = {}) => piSidecar(PI_SEAT, over)],
    ["omp", OMP_SEAT, (over: Record<string, unknown> = {}) => piSidecar(OMP_SEAT, over)],
    ["pda", PDA_SEAT, (over: Record<string, unknown> = {}) => pdaSidecar(over)],
  ] as const;

  describe.each(SEATS)("%s seat", (runtime, seat, write) => {
    // What Ctrl-C does once the paste is closed differs by runtime: Pi and OMP also run /abort (the runner's own hint
    // says "aborts the current turn"), pda only clears the line. The refusal must not send a Pi user to abort a turn unwarned.
    it("the refusal words what Ctrl-C does for this runtime, on the default, override and wait-for-idle refusals alike", async () => {
      write({ pasteOpen: true });
      const { transport } = setup();
      const ends = runtime === "pda" ? "then Ctrl-C clears the line. No override" : "then Ctrl-C clears the line and aborts the current turn. No override";
      const results = [
        await transport.send(seat, "hello"),
        await transport.send(seat, "hello", { dangerouslyInteract: true, reason: "drive it" }),
        await transport.send(seat, "hello", { waitForIdleMs: 50 }),
      ];
      for (const r of results) {
        expect(r.ok).toBe(false);
        expect(r.error).toContain(ends);
        if (runtime === "pda") expect(r.error).not.toContain("abort");
      }
    });

    it("a default send is refused with the remedy, names the unclosed paste, and writes 0 bytes", async () => {
      write({ pasteOpen: true });
      const { transport, sendText, sendKeys } = setup();
      const r = await transport.send(seat, "hello");
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("target_needs_input");
      expect(r.activity).toMatchObject({ state: "needs_input", reason: "paste_open", evidenceSource: "runner_sidecar" });
      expect(r.error).toContain(seat);
      expect(r.error).toContain("paste still open");
      expect(r.error).toContain(REMEDY);
      expect(r.error).toContain("No text was sent");
      expect(r.error).not.toContain("--dangerously-interact"); // no override is offered
      expect(sendText).not.toHaveBeenCalled();
      expect(sendKeys).not.toHaveBeenCalled();
    });

    it("control: the same sidecar without the key (an older runner), and with pasteOpen false, delivers as today", async () => {
      write({});
      const first = setup();
      expect((await first.transport.send(seat, "hello")).ok).toBe(true);
      expect(first.sendText).toHaveBeenCalledTimes(1);
      write({ pasteOpen: false });
      const second = setup();
      expect((await second.transport.send(seat, "hello")).ok).toBe(true);
      expect(second.sendText).toHaveBeenCalledTimes(1);
    });

    it("--dangerously-interact is refused too (runner_input_no_override), with the paste remedy, no audit and 0 bytes", async () => {
      write({ pasteOpen: true });
      const { transport, sendText } = setup();
      const r = await transport.send(seat, "hello", { dangerouslyInteract: true, reason: "drive it" });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("runner_input_no_override");
      expect(r.error).toContain(REMEDY);
      expect(sendText).not.toHaveBeenCalled();
      const audits = db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'transport.prompt_override'").get() as { n: number };
      expect(audits.n).toBe(0);
    });

    it("--force does not bypass it", async () => {
      write({ pasteOpen: true });
      const { transport, sendText } = setup();
      const r = await transport.send(seat, "hello", { force: true });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("target_needs_input");
      expect(sendText).not.toHaveBeenCalled();
    });

    it("--wait-for-idle refuses at once with the remedy (an open paste does not close by waiting), 0 bytes", async () => {
      write({ pasteOpen: true });
      const { transport, sendText } = setup();
      const r = await transport.send(seat, "hello", { waitForIdleMs: 50 });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("target_needs_input");
      expect(r.error).toContain(REMEDY);
      expect(sendText).not.toHaveBeenCalled();
    });

    it("the race: once the runner rewrites the sidecar after the paste closed, the very next send goes", async () => {
      write({ pasteOpen: true });
      const { transport, sendText } = setup();
      expect((await transport.send(seat, "first")).ok).toBe(false);
      write({}); // the runner's write on the closing marker (the key is absent when closed)
      const r = await transport.send(seat, "second");
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(sendText).toHaveBeenCalledTimes(1);
    });

    it("a stale flag refuses nothing forever: past the 180 s alive window the runner gives no answer and today's logic decides", async () => {
      write({ pasteOpen: true, aliveAt: iso(NOW - 181_000) });
      const { transport, sendText } = setup();
      const r = await transport.send(seat, "hello");
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(sendText).toHaveBeenCalledTimes(1);
    });

    it("the window is the alive window and no more: 180 s old still refuses, and the refusal ends as the clock passes 181 s", async () => {
      write({ pasteOpen: true, aliveAt: iso(NOW - 180_000) });
      const setupAt = setup();
      expect((await setupAt.transport.send(seat, "hello")).ok).toBe(false);
      setupAt.clock.t = NOW + 2_000;
      expect((await setupAt.transport.send(seat, "hello")).ok).toBe(true);
    });

    it("the runner died (exited record) or never got ready: the stale flag is not read", async () => {
      write({ pasteOpen: true, ready: false, exited: { code: 1, at: iso(NOW) } });
      const exited = setup();
      expect((await exited.transport.send(seat, "hello")).ok).toBe(true);
      write({ pasteOpen: true, ready: false });
      const notReady = setup();
      expect((await notReady.transport.send(seat, "hello")).ok).toBe(true);
    });

    it("the runner was killed and the pane is back at a shell: refused by the existing foreground guard, not as a paste (nothing here widens or reorders it)", async () => {
      write({ pasteOpen: true });
      const { transport, sendText } = setup({ paneCommand: "-zsh" });
      const r = await transport.send(seat, "hello");
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("target_runtime_unverified");
      expect(r.error).not.toContain("paste still open");
      expect(sendText).not.toHaveBeenCalled();
    });

    it("a pasteOpen that is not a boolean is a record the daemon does not understand: no runner answer, and nothing is read as open or closed", async () => {
      write({ pasteOpen: "yes" });
      const { transport, pi, omp, pda } = setup();
      const adapter = seat === PDA_SEAT ? pda : seat === OMP_SEAT ? omp : pi;
      expect(await adapter.sendReadiness({ sessionName: seat, nodeId: null })).toBeNull();
      // And the send falls to today's logic, which this neutral pane lets through.
      expect((await transport.send(seat, "hello")).ok).toBe(true);
    });
  });

  it("pi: an open paste refuses even while the agent is busy (a busy runner otherwise only advises)", async () => {
    piSidecar(PI_SEAT, { busy: true, pasteOpen: true });
    const { transport, sendText } = setup();
    const r = await transport.send(PI_SEAT, "hello");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("target_needs_input");
    expect(sendText).not.toHaveBeenCalled();
    piSidecar(PI_SEAT, { busy: true });
    expect((await setup().transport.send(PI_SEAT, "hello")).ok).toBe(true); // control: busy alone goes in with an advisory
  });

  it("pda: a disconnected runner with an open paste refuses; disconnected alone goes in with an advisory (unchanged)", async () => {
    pdaSidecar({ connected: false, pasteOpen: true });
    const refused = setup();
    expect((await refused.transport.send(PDA_SEAT, "hello")).ok).toBe(false);
    expect(refused.sendText).not.toHaveBeenCalled();
    pdaSidecar({ connected: false });
    expect((await setup().transport.send(PDA_SEAT, "hello")).ok).toBe(true);
  });

  it("pda: a held message keeps its own answer and refusal when a paste is also open (gating for a hold is unchanged)", async () => {
    pdaSidecar({ held: { requestId: "openrig/n/l/1", code: "pda_message_held", at: iso(NOW) }, pasteOpen: true });
    const { pda, transport } = setup();
    expect(await pda.sendReadiness({ sessionName: PDA_SEAT, nodeId: null })).toMatchObject({ state: "needs_input", reason: "pda_message_held" });
    const r = await transport.send(PDA_SEAT, "hello");
    expect(r.ok).toBe(false);
    expect(r.error).not.toContain("paste still open");
  });

  it("pi: the flag is read only from a parseable record: an unparseable sidecar still means no runner answer", async () => {
    fs.writeFileSync(piSeatPaths(piRoot, PI_SEAT).runnerStatePath, "{\"pasteOpen\": true");
    const { pi } = setup();
    expect(await pi.sendReadiness({ sessionName: PI_SEAT, nodeId: null })).toBeNull();
  });

  it("parsers: a boolean pasteOpen is kept, a non-boolean refuses the whole record (both runners' protocols)", () => {
    const piBase = { ready: true, updatedAt: iso(NOW), busy: false };
    expect(parsePiRunnerState(JSON.stringify({ ...piBase, pasteOpen: true }))).toMatchObject({ pasteOpen: true });
    expect(parsePiRunnerState(JSON.stringify({ ...piBase, pasteOpen: 1 }))).toBeNull();
    const pdaBase: PdaRunnerState = {
      ready: true, launchId: "l", updatedAt: iso(NOW), aliveAt: iso(NOW), agent: "a", baseUrl: "http://127.0.0.1:1", connected: true, busy: false, outboxPending: 0,
    };
    expect(parsePdaRunnerState(JSON.stringify({ ...pdaBase, pasteOpen: true }))).toMatchObject({ pasteOpen: true });
    expect(parsePdaRunnerState(JSON.stringify({ ...pdaBase, pasteOpen: "true" }))).toBeNull();
    expect(parsePdaRunnerState(JSON.stringify(pdaBase))).not.toBeNull(); // control: absent is an older runner
  });
});
