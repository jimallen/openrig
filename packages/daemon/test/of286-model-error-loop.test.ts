// OF-286: on 2026-11-10 verify-qa and verify-sec@eztrack (Pi, openai-codex) had a model request cut off about every 2 minutes for up to an hour. Pi retried
// each time and some steps succeeded in between, so the seat read busy, `rig ps` showed nothing, and the Chief of Staff relaunched seats blind. The rule,
// decided by Jim: a seat is flagged when it has N failed model requests within a time window, whether or not something succeeded in between (N = 3, window =
// 15 min, measured on the recorded sessions: see the commit); the flag is kept when the runtime gives up, and cleared only by a turn that completes with no
// model error. Three surfaces: a marker in `rig ps` (ATTN and the reason), one item to the rig's Chief of Staff when it starts and one when it stops, and the
// `rig health` finding.
//
// Deployed chain: startup.ts constructs PiRuntimeAdapter / OmpRuntimeAdapter (the seats' `pi-runner.js` -> RunnerCore writes the sidecar they read), passes
// their `modelErrorLoop` to AgentActivityStore (the node inventory and PsProjectionService read it from there), to SeatModelErrorLoopHealthSource (rig health)
// and to SeatModelErrorLoopNotifier (index.ts starts it after bind). The numbers 3 and 15 min, the field name `modelErrorLoop` and the detector id are literals
// in this file; nothing imports them.
//
// Event shapes. Pi 1.5.0 (agent-session.js): message_end{error} -> agent_end{willRetry:true} -> auto_retry_start -> agent_start; the last agent_end has no
// willRetry and is followed by agent_settled. OMP 18.18.6 (turn-recovery.ts, agent-session.ts): message_end{error} (or only turn_end) -> auto_retry_start ->
// agent_end{isTerminal:false, yielded:false} -> continuation; its last agent_end has isTerminal:true; no willRetry on any OMP event. The two are fed apart: the
// first draft fed Pi's shapes to the OMP runner and passed vacuously.
import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { RunnerCore, type RunnerIo } from "../src/adapters/pi-runner.js";
import type { PiRunnerState } from "../src/adapters/pi-runner-protocol.js";
import { PiRuntimeAdapter } from "../src/adapters/pi-runtime-adapter.js";
import { OmpRuntimeAdapter } from "../src/adapters/omp-runtime-adapter.js";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { PsProjectionService, seatNeedsAttention } from "../src/domain/ps-projection.js";
import { getNodeInventory, attachAgentActivity } from "../src/domain/node-inventory.js";
import { inventoryOfLiveRigs } from "../src/domain/seat-lost-health.js";
import { SeatModelErrorLoopHealthSource } from "../src/domain/seat-model-error-loop-health.js";
import { SeatModelErrorLoopNotifier, modelLoopNoticeId } from "../src/domain/seat-model-error-loop-notice.js";
import { describeModelErrorLoop, type PublishedModelErrorLoop } from "../src/domain/seat-model-error-loop.js";
import { HealthProjectionService } from "../src/domain/health-detectors.js";
import { DEFAULT_HEALTH_POLICY, HEALTH_DETECTORS } from "../src/domain/health-policy.js";
import type { NodeInventoryEntry } from "../src/domain/types.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

type AdapterClass = new (options: ConstructorParameters<typeof PiRuntimeAdapter>[0]) => PiRuntimeAdapter;
const T0 = Date.UTC(2026, 9, 27, 10, 0, 0); // far from wall clock, so a wall-clock reading shows
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

// ── runner ──────────────────────────────────────────────────────────────────────────────────────

function runner(runtime: "pi" | "omp") {
  const activity: Record<string, unknown>[] = [];
  const sidecars: PiRunnerState[] = [];
  let clock = T0;
  const io: RunnerIo = {
    sendRpc: () => undefined, mirrorLine: () => undefined, mirrorAppend: () => undefined,
    postActivity: (p) => { activity.push(p); }, writeSidecar: (s) => { sidecars.push(s); },
    sessionFileExists: () => true, now: () => iso(clock),
  };
  const core = new RunnerCore(io, { sessionName: "devpi-a@some-rig", nodeId: "node-1", generation: "g1", launchId: "l1" }, { runtime });
  core.start();
  core.handlePiLine(JSON.stringify({ type: "response", id: "pi-runner-get-state", data: { sessionFile: "/state/s.jsonl", sessionId: "s1" } }));
  activity.length = 0; sidecars.length = 0;
  return {
    core, activity, sidecars,
    /** Set the clock to `minutes` after T0, then deliver the events. */
    at(minutes: number, ...events: Record<string, unknown>[]) { clock = T0 + minutes * MIN; for (const e of events) core.handlePiLine(JSON.stringify(e)); },
    loop: () => sidecars.at(-1)?.modelErrorLoop,
    anyFlag: () => sidecars.some((s) => s.modelErrorLoop !== undefined),
  };
}
const err = (text: string) => ({ role: "assistant", stopReason: "error", errorMessage: text, content: [] });
const ok = (stopReason = "stop") => ({ role: "assistant", stopReason, content: [] });

/** Pi: one cut-off attempt, the way agent-session.js emits it, ending with the retry announced. */
const piCut = (text = "terminated") => [
  { type: "agent_start" }, { type: "message_start", message: { role: "assistant" } }, { type: "message_end", message: err(text) },
  { type: "agent_end", messages: [], willRetry: true }, { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: text },
];
/** Pi: a step that got an answer (a tool-call step, as on the recorded night). */
const piStep = [{ type: "agent_start" }, { type: "message_start", message: { role: "assistant" } }, { type: "message_end", message: ok("toolUse") }];
/** Pi: the turn's last assistant message was an answer; the run ends and settles. */
const piDone = [{ type: "message_start", message: { role: "assistant" } }, { type: "message_end", message: ok("stop") }, { type: "agent_end", messages: [] }, { type: "agent_settled" }];
/** Pi: retries ran out: the last failed message, a final agent_end (no willRetry), auto_retry_end{success:false}, agent_settled. */
const piGiveUp = (text = "terminated") => [
  { type: "agent_start" }, { type: "message_start", message: { role: "assistant" } }, { type: "message_end", message: err(text) },
  { type: "agent_end", messages: [] }, { type: "auto_retry_end", success: false, attempt: 3, finalError: text }, { type: "agent_settled" },
];

/** OMP: one failed attempt, in OMP's order: the failed message, auto_retry_start, THEN a non-terminal agent_end, then the continuation. */
const ompCut = (text = "terminated") => [
  { type: "turn_start" }, { type: "message_start", message: { role: "assistant" } }, { type: "message_end", message: err(text) },
  { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000 }, { type: "agent_end", messages: [], isTerminal: false, yielded: false },
];
const ompStep = [{ type: "turn_start" }, { type: "message_start", message: { role: "assistant" } }, { type: "message_end", message: ok("toolUse") }, { type: "turn_end", message: ok("toolUse") }];
const ompDone = [{ type: "turn_start" }, { type: "message_start", message: { role: "assistant" } }, { type: "message_end", message: ok("stop") }, { type: "turn_end", message: ok("stop") }, { type: "agent_end", messages: [], isTerminal: true }];
/** OMP gives up: the failed message, then the terminal agent_end (it ends the turn normally after a model failure). */
const ompGiveUp = (text = "terminated") => [
  { type: "turn_start" }, { type: "message_start", message: { role: "assistant" } }, { type: "message_end", message: err(text) },
  { type: "turn_end", message: err(text) }, { type: "agent_end", messages: [], isTerminal: true },
];

const SHAPES = {
  pi: { cut: piCut, step: piStep, done: piDone, giveUp: piGiveUp },
  omp: { cut: ompCut, step: ompStep, done: ompDone, giveUp: ompGiveUp },
} as const;

describe.each(["pi", "omp"] as const)("OF-286 the %s runner flags 3 failed model requests within 15 minutes", (runtime) => {
  const s = SHAPES[runtime];

  it("is silent for two, flags the third with the count, the first failure's time and the last error", () => {
    const r = runner(runtime);
    r.at(0, ...s.cut("terminated")); r.at(2, ...s.cut("WebSocket error"));
    expect(r.anyFlag()).toBe(false);
    r.at(4, ...s.cut("fetch failed"));
    expect(r.loop()).toEqual({ count: 3, total: 3, since: iso(T0), lastAt: iso(T0 + 4 * MIN), lastError: "fetch failed" });
    r.at(6, ...s.cut("terminated"));
    expect(r.loop()).toEqual({ count: 4, total: 4, since: iso(T0), lastAt: iso(T0 + 6 * MIN), lastError: "terminated" });
  });

  it("answers between the failures do not reset the count (the recorded night: a cut, a retry that works, a tool step, a cut)", () => {
    const r = runner(runtime);
    r.at(0, ...s.cut()); r.at(3, ...s.step); r.at(5, ...s.cut()); r.at(8, ...s.step, ...s.step); r.at(10, ...s.cut());
    expect(r.loop()).toMatchObject({ count: 3, total: 3, since: iso(T0) });
  });

  it("failures further apart than the window never flag: three in 16 minutes is two in any 15", () => {
    const r = runner(runtime);
    r.at(0, ...s.cut()); r.at(8, ...s.cut()); r.at(16, ...s.cut());
    expect(r.anyFlag()).toBe(false);
    r.at(18, ...s.cut()); // 8, 16, 18 is three inside 15 minutes
    expect(r.loop()).toMatchObject({ count: 3, since: iso(T0 + 8 * MIN) });
  });

  it("the window is 15 minutes: a failure exactly 15 minutes old has left it, one 14.9 minutes old has not", () => {
    const a = runner(runtime);
    a.at(0, ...s.cut()); a.at(7, ...s.cut()); a.at(15, ...s.cut());
    expect(a.anyFlag()).toBe(false);
    const b = runner(runtime);
    b.at(0, ...s.cut()); b.at(7, ...s.cut()); b.at(14.9, ...s.cut());
    expect(b.loop()).toMatchObject({ count: 3 });
  });

  it("keeps the flag when the runtime gives up, and says when", () => {
    const r = runner(runtime);
    r.at(0, ...s.cut()); r.at(2, ...s.cut()); r.at(4, ...s.cut());
    expect(r.loop()!.gaveUpAt).toBeUndefined();
    r.at(6, ...s.giveUp());
    expect(r.loop()).toMatchObject({ count: 4, total: 4, gaveUpAt: iso(T0 + 6 * MIN), since: iso(T0) });
  });

  it("a non-final agent_end is not giving up (Pi: willRetry:true; OMP: isTerminal:false)", () => {
    const r = runner(runtime);
    r.at(0, ...s.cut()); r.at(2, ...s.cut()); r.at(4, ...s.cut());
    expect(r.loop()).toBeDefined();
    expect(r.loop()!.gaveUpAt).toBeUndefined();
  });

  it("a failure after giving up drops that mark (the seat is trying again)", () => {
    const r = runner(runtime);
    r.at(0, ...s.cut()); r.at(2, ...s.cut()); r.at(4, ...s.giveUp());
    expect(r.loop()!.gaveUpAt).toBeDefined();
    r.at(20, ...s.cut());
    expect(r.loop()).toMatchObject({ total: 4, count: 1 });
    expect(r.loop()!.gaveUpAt).toBeUndefined();
  });

  it("is not cleared by answers, by a retry that got through, or by the quiet that follows", () => {
    const r = runner(runtime);
    r.at(0, ...s.cut()); r.at(2, ...s.cut()); r.at(4, ...s.cut());
    r.at(5, ...s.step, ...s.step);
    r.at(60, ...s.step);
    expect(r.loop()).toMatchObject({ total: 3, since: iso(T0) });
  });

  it("a turn that ends after failures but with an answer (the retry got through) is not a clean turn", () => {
    const r = runner(runtime);
    r.at(0, ...s.cut()); r.at(2, ...s.cut()); r.at(4, ...s.cut());
    r.at(6, ...s.done); // the same turn: a model error happened in it
    expect(r.loop()).toMatchObject({ total: 3 });
    expect(r.loop()!.gaveUpAt).toBeUndefined(); // the answer after the failures means the runtime did not give up
  });

  it("gaveUpAt does not outlive the flag: after a clean turn a new flag has none", () => {
    const r = runner(runtime);
    r.at(0, ...s.cut()); r.at(2, ...s.cut()); r.at(4, ...s.giveUp());
    expect(r.loop()!.gaveUpAt).toBeDefined();
    r.at(6, ...s.done); // the next prompt, answered, with no error
    expect(r.loop()).toBeUndefined();
    r.at(7, ...s.cut()); r.at(8, ...s.cut()); r.at(9, ...s.cut());
    expect(r.loop()).toMatchObject({ total: 3, since: iso(T0 + 7 * MIN) });
    expect(r.loop()!.gaveUpAt).toBeUndefined();
  });

  it("is cleared by the next turn that completes with no model error, and the count starts again from nothing", () => {
    const r = runner(runtime);
    r.at(0, ...s.cut()); r.at(2, ...s.cut()); r.at(4, ...s.cut()); r.at(6, ...s.done);
    r.at(8, ...s.done); // a new turn, answered, no error in it, while the three failures are still inside the window
    expect(r.loop()).toBeUndefined();
    expect(r.sidecars.at(-1)!.modelErrorLoop).toBeUndefined();
    r.at(9, ...s.cut()); r.at(10, ...s.cut());
    expect(r.loop()).toBeUndefined(); // 2 since the clean turn, not 5: the earlier failures went with the flag
    r.at(11, ...s.cut());
    expect(r.loop()).toMatchObject({ total: 3, since: iso(T0 + 9 * MIN) });
  });

  it("a turn that is ended before anything answered (an abort) is not a clean turn", () => {
    const r = runner(runtime);
    r.at(0, ...s.cut()); r.at(2, ...s.cut()); r.at(4, ...s.giveUp());
    r.at(10, runtime === "pi" ? { type: "agent_start" } : { type: "turn_start" }, runtime === "pi" ? { type: "agent_end", messages: [] } : { type: "agent_end", messages: [], isTerminal: true });
    expect(r.loop()).toBeDefined();
  });

  it("adds nothing to the seat's activity: the retries read active as before, and only OMP's existing per-error attention is raised", () => {
    const r = runner(runtime);
    r.at(0, ...s.cut()); r.at(2, ...s.cut()); r.at(4, ...s.cut()); r.at(6, ...s.cut());
    const attention = r.activity.filter((a) => a.hookEvent === "Notification").map((a) => `${a.runtime}:${a.subtype}`);
    expect(new Set(attention)).toEqual(runtime === "omp" ? new Set(["omp:runtime_error"]) : new Set());
    expect(r.activity.filter((a) => a.subtype === "auto_retry").length).toBe(4);
    expect(r.sidecars.every((x) => x.busy !== undefined)).toBe(true);
  });

  it("strips terminal controls from the error text and bounds it", () => {
    const r = runner(runtime);
    r.at(0, ...s.cut()); r.at(1, ...s.cut()); r.at(2, ...s.cut("\u001b[2Jbad\r\nrequest\u0000" + "x".repeat(1000)));
    expect(r.loop()!.lastError).toMatch(/^bad request x+$/);
    expect(r.loop()!.lastError.length).toBeLessThanOrEqual(200);
  });

  it("a periodic sidecar write while the flag lasts carries it", () => {
    const r = runner(runtime);
    r.at(0, ...s.cut()); r.at(2, ...s.cut()); r.at(4, ...s.cut());
    r.sidecars.length = 0;
    r.core.tickAlive();
    expect(r.sidecars).toHaveLength(1);
    expect(r.sidecars[0]!.modelErrorLoop).toMatchObject({ total: 3 });
  });
});

describe("OF-286 a Pi run aborted during the retry backoff", () => {
  it("ends with auto_retry_end{success:false} and agent_settled only (no final agent_end); the next answered turn is then a clean turn", () => {
    const r = runner("pi");
    r.at(0, ...piCut()); r.at(2, ...piCut()); r.at(4, ...piCut());
    r.at(5, { type: "auto_retry_end", success: false, finalError: "aborted" }, { type: "agent_settled", aborted: true });
    expect(r.loop()).toBeDefined();
    expect(r.loop()!.gaveUpAt).toBeUndefined(); // aborted by an operator, not given up
    r.at(30, ...piDone);
    expect(r.loop()).toBeUndefined();
  });
});

describe("OF-286 OMP's own event order", () => {
  it("auto_retry_start followed by a non-terminal agent_end does not reset the count (the first draft reset on every OMP retry and could never publish)", () => {
    const r = runner("omp");
    for (let i = 0; i < 5; i++) r.at(i * 2, ...ompCut());
    expect(r.loop()).toMatchObject({ total: 5 });
  });

  it("an OMP failure that appears only on turn_end counts once", () => {
    const r = runner("omp");
    const onlyOnTurnEnd = (t: number) => r.at(t, { type: "turn_start" }, { type: "turn_end", message: err("terminated") }, { type: "auto_retry_start", attempt: 1 }, { type: "agent_end", messages: [], isTerminal: false });
    onlyOnTurnEnd(0); onlyOnTurnEnd(1);
    expect(r.anyFlag()).toBe(false);
    onlyOnTurnEnd(2);
    expect(r.loop()).toMatchObject({ total: 3 });
  });

  it("an OMP failure announced on message_end and again on turn_end counts once", () => {
    const r = runner("omp");
    r.at(0, ...ompGiveUp()); r.at(1, ...ompGiveUp());
    expect(r.anyFlag()).toBe(false); // two failures, each repeated on turn_end: 2, not 4
    r.at(2, ...ompGiveUp());
    expect(r.loop()).toMatchObject({ total: 3 });
  });

  it("OMP's terminal agent_end after a failure is giving up; its non-terminal one is not", () => {
    const r = runner("omp");
    r.at(0, ...ompCut()); r.at(1, ...ompCut()); r.at(2, ...ompCut());
    expect(r.loop()!.gaveUpAt).toBeUndefined();
    r.at(3, ...ompGiveUp());
    expect(r.loop()!.gaveUpAt).toBe(iso(T0 + 3 * MIN));
  });
});

describe("OF-286 the one definition of a final agent_end", () => {
  it("Pi's willRetry and OMP's isTerminal are not interchangeable: each runtime reads its own", async () => {
    const { isFinalAgentEnd } = await import("../src/adapters/pi-model-error-loop.js");
    expect(isFinalAgentEnd({ type: "agent_end", willRetry: true }, "pi")).toBe(false);
    expect(isFinalAgentEnd({ type: "agent_end" }, "pi")).toBe(true);
    expect(isFinalAgentEnd({ type: "agent_end", isTerminal: false }, "omp")).toBe(false);
    expect(isFinalAgentEnd({ type: "agent_end", isTerminal: true }, "omp")).toBe(true);
    expect(isFinalAgentEnd({ type: "agent_end" }, "omp")).toBe(true);
    expect(isFinalAgentEnd({ type: "agent_end", willRetry: true }, "omp")).toBe(true); // OMP has no willRetry
    expect(isFinalAgentEnd({ type: "agent_end", isTerminal: false }, "pi")).toBe(true); // Pi has no isTerminal
    expect(isFinalAgentEnd({ type: "turn_end" }, "pi")).toBe(false);
  });
});

// ── adapter ─────────────────────────────────────────────────────────────────────────────────────

describe("OF-286 the adapters read the flag only from a live sidecar", () => {
  const NOW = T0 + 3_600_000;
  const loop = { count: 4, total: 11, since: iso(NOW - 600_000), lastAt: iso(NOW - 60_000), lastError: "terminated" };
  const adapterFor = (sidecar: Record<string, unknown> | null, Adapter: AdapterClass = PiRuntimeAdapter) => new Adapter({
    tmux: {} as TmuxAdapter, stateRoot: "/state", runnerEntryPath: "/x/pi-runner.js", now: () => new Date(NOW),
    fsOps: { readFile: () => JSON.stringify(sidecar), exists: () => sidecar !== null, writeFile: () => undefined, mkdirp: () => undefined },
  });
  const live = { ready: true, updatedAt: iso(NOW - 1000), aliveAt: iso(NOW - 1000), busy: true };

  it("returns the flag of a live, ready sidecar, with the give-up time when it has one", () => {
    expect(adapterFor({ ...live, modelErrorLoop: loop }).readModelErrorLoop("s@r")).toEqual({ observed: true, loop });
    const gave = { ...loop, gaveUpAt: iso(NOW - 30_000) };
    expect(adapterFor({ ...live, modelErrorLoop: gave }).modelErrorLoop("s@r")).toEqual(gave);
  });
  it("OMP's adapter inherits it", () => {
    expect(adapterFor({ ...live, modelErrorLoop: loop }, OmpRuntimeAdapter).modelErrorLoop("s@r")).toEqual(loop);
  });
  it("reports the launch id of the runner it read, with or without a flag", () => {
    expect(adapterFor({ ...live, launchId: "L7", modelErrorLoop: loop }).readModelErrorLoop("s@r")).toEqual({ observed: true, loop, launchId: "L7" });
    expect(adapterFor({ ...live, launchId: "L7" }).readModelErrorLoop("s@r")).toEqual({ observed: true, loop: null, launchId: "L7" });
  });
  it("a live sidecar with no flag is observed, with no loop: that is what a recovery looks like", () => {
    expect(adapterFor(live).readModelErrorLoop("s@r")).toEqual({ observed: true, loop: null });
  });
  it.each([
    ["no sidecar", null],
    ["a stale alive tick (a dead or hung runner)", { ...live, aliveAt: iso(NOW - 600_000), modelErrorLoop: loop }],
    ["an exited runner", { ...live, exited: { code: 1, at: iso(NOW) }, modelErrorLoop: loop }],
    ["a runner not ready", { ...live, ready: false, modelErrorLoop: loop }],
  ])("%s is not observed: neither looping nor recovered", (_name, sidecar) => {
    expect(adapterFor(sidecar as Record<string, unknown> | null).readModelErrorLoop("s@r")).toEqual({ observed: false, loop: null });
  });
  it.each([
    ["total as text", { ...loop, total: "11" }],
    ["a zero count", { ...loop, count: 0 }],
    ["since not a time", { ...loop, since: "yesterday" }],
    ["lastAt missing", { ...loop, lastAt: undefined }],
    ["gaveUpAt not a time", { ...loop, gaveUpAt: "soon" }],
    ["lastError not text", { ...loop, lastError: 7 }],
  ])("a malformed flag (%s) is observed but reads as no flag", (_name, bad) => {
    expect(adapterFor({ ...live, modelErrorLoop: bad }).readModelErrorLoop("s@r")).toEqual({ observed: true, loop: null });
  });
  it("the flag never reaches send readiness: the same sidecar with and without it reads the same", async () => {
    const target = { sessionName: "s@r", nodeId: null };
    const withFlag = await adapterFor({ ...live, modelErrorLoop: loop }).sendReadiness(target);
    const without = await adapterFor(live).sendReadiness(target);
    expect(withFlag).toEqual(without);
  });
});

// ── health ──────────────────────────────────────────────────────────────────────────────────────

describe("OF-286 SeatModelErrorLoopHealthSource: one finding per looping seat", () => {
  const NOW = new Date(T0 + 3_600_000);
  const seat = (over: Partial<NodeInventoryEntry> = {}) => ({
    rigId: "rig-1", rigName: "eztrack", nodeId: "node-1", logicalId: "verify.qa", canonicalSessionName: "verify-qa@eztrack",
    runtime: "pi", storedSessionStatus: "running", ...over,
  }) as NodeInventoryEntry;
  const loop: PublishedModelErrorLoop = { count: 4, total: 11, since: iso(NOW.getTime() - 3_000_000), lastAt: iso(NOW.getTime() - 100_000), lastError: "terminated" };
  const records = (seats: NodeInventoryEntry[], loops: Record<string, PublishedModelErrorLoop | null>, disabled: string[] = []) => {
    const source = new SeatModelErrorLoopHealthSource({ inventory: () => seats, modelErrorLoop: (_rt, s) => loops[s] ?? null, now: () => NOW });
    const policy = { version: "t", policy: { ...DEFAULT_HEALTH_POLICY, disabledDetectors: disabled }, contextPressure: { warningPercent: 95, criticalPercent: 99 } };
    return new HealthProjectionService([source], () => policy).records();
  };

  it("names the seat, the failed requests, the last error and since when, scoped to the seat", () => {
    const found = records([seat()], { "verify-qa@eztrack": loop });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ detector: "seat.model-error-loop", category: "process", status: "active", severity: "warning",
      scope: { type: "seat", rigId: "rig-1", seatId: "node-1" }, startedAt: loop.since, lastObservedAt: loop.lastAt });
    expect(found[0]!.summary).toContain("verify.qa@eztrack");
    expect(found[0]!.summary).toContain("11 failed model requests");
    expect(found[0]!.summary).toContain("terminated");
    expect(found[0]!.summary).toContain(loop.since);
    expect(found[0]!.suggestedInspection).toContain("rig capture verify-qa@eztrack");
    expect(found[0]!.threshold).toBe("3 failed model requests within 15 minutes, whatever succeeded in between; kept when the runtime gives up; cleared when a turn completes with no model error");
  });
  it("a flag whose last failure is old is still an active finding: the flag is read from a live sidecar, so its freshness is the read's, not the failure's", () => {
    const old = { ...loop, lastAt: iso(NOW.getTime() - 2 * 3_600_000), since: iso(NOW.getTime() - 3 * 3_600_000) };
    const found = records([seat()], { "verify-qa@eztrack": old });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ status: "active", lastObservedAt: old.lastAt });
  });
  it("says when the runtime gave up", () => {
    const gave = records([seat()], { "verify-qa@eztrack": { ...loop, gaveUpAt: iso(NOW.getTime() - 50_000) } })[0]!;
    expect(gave.summary).toContain("gave up");
    expect(gave.explanation).toContain("idle with its task undone");
    expect(records([seat()], { "verify-qa@eztrack": loop })[0]!.summary).not.toContain("gave up");
  });
  it("covers an OMP seat the same way", () => {
    expect(records([seat({ runtime: "omp" })], { "verify-qa@eztrack": loop })[0]!.summary).toContain("(omp)");
  });
  it("says nothing for a seat with no flag, so it clears when the runner drops the field", () => {
    expect(records([seat()], { "verify-qa@eztrack": loop })).toHaveLength(1);
    expect(records([seat()], { "verify-qa@eztrack": null })).toEqual([]);
  });
  it.each([
    ["a claude-code seat", { runtime: "claude-code" }],
    ["a seat not recorded running", { storedSessionStatus: "exited" }],
    ["a seat with no session name", { canonicalSessionName: null }],
  ])("does not read the sidecar of %s", (_name, over) => {
    expect(records([seat(over as Partial<NodeInventoryEntry>)], { "verify-qa@eztrack": loop })).toEqual([]);
  });
  it("one looping seat among healthy ones yields one finding for that seat", () => {
    const found = records([seat(), seat({ nodeId: "node-2", logicalId: "verify.sec", canonicalSessionName: "verify-sec@eztrack" })], { "verify-sec@eztrack": loop });
    expect(found).toHaveLength(1);
    expect(found[0]!.scope).toMatchObject({ seatId: "node-2" });
  });
  it("a policy can disable the detector, which is a known detector id", () => {
    expect(HEALTH_DETECTORS).toContain("seat.model-error-loop");
    expect(records([seat()], { "verify-qa@eztrack": loop }, ["seat.model-error-loop"])).toEqual([]);
  });
  it("a reader that throws is no finding rather than a failed health read", () => {
    const source = new SeatModelErrorLoopHealthSource({ inventory: () => [seat()], modelErrorLoop: () => { throw new Error("boom"); }, now: () => NOW });
    expect(source.read()).toEqual([]);
  });
});

// ── rig ps: the marker, and what it must not change ──────────────────────────────────────────────

describe("OF-286 rig ps marks the seat and changes nothing else about it", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  function world() {
    const db = createFullTestDb();
    const rigs = new RigRepository(db); const sessions = new SessionRegistry(db);
    const rig = rigs.createRig("eztrack");
    const mk = (logicalId: string, runtime: string, session: string) => { const n = rigs.addNode(rig.id, logicalId, { runtime }); sessions.updateStatus(sessions.registerSession(n.id, session).id, "running"); return n; };
    mk("verify.qa", "pi", "verify-qa@eztrack"); mk("verify.sec", "pi", "verify-sec@eztrack"); mk("build.omp", "omp", "build-omp@eztrack"); mk("exec.cos", "claude-code", "exec-cos@eztrack");
    return { db, rig };
  }
  const NOW = new Date(T0 + MIN * 120);
  const flag = (over: Partial<PublishedModelErrorLoop> = {}): PublishedModelErrorLoop => ({ count: 3, total: 11, since: iso(T0 + 60 * MIN), lastAt: iso(T0 + 100 * MIN), lastError: "terminated", ...over });
  const store = (db: Database.Database, flags: Record<string, PublishedModelErrorLoop | null>) =>
    new AgentActivityStore({ db, eventBus: new EventBus(db), now: () => NOW, modelErrorLoop: (s) => flags[s] ?? null });

  it("ATTN counts a flagged Pi seat and an OMP seat once each, and a seat with no flag not at all", () => {
    const { db } = world();
    const ps = new PsProjectionService({ db, agentActivity: store(db, { "verify-qa@eztrack": flag(), "build-omp@eztrack": flag() }) });
    expect(ps.getEntries().find((e) => e.name === "eztrack")!.attentionCount).toBe(2);
    expect(new PsProjectionService({ db, agentActivity: store(db, {}) }).getEntries().find((e) => e.name === "eztrack")!.attentionCount).toBe(0);
    db.close();
  });

  it("the node inventory carries the flag and its line on the flagged seat only; the seat's own activity fields are not touched", async () => {
    const { db, rig } = world();
    const activityStore = store(db, { "verify-qa@eztrack": flag({ gaveUpAt: iso(T0 + 101 * MIN) }) });
    const base = getNodeInventory(db, rig.id);
    const attached = await attachAgentActivity(base, { tmuxAdapter: {} as TmuxAdapter, activityStore, now: NOW });
    const qa = attached.find((e) => e.logicalId === "verify.qa")!;
    expect(qa.modelErrorLoop).toEqual(describeModelErrorLoop(flag({ gaveUpAt: iso(T0 + 101 * MIN) }), NOW.getTime()));
    expect(qa.modelErrorLoop!.line).toBe('looping on model errors: 11 failed requests since 11:00Z (60m), last "terminated" 20m ago; the runtime gave up at 11:41Z');
    expect(attached.find((e) => e.logicalId === "verify.sec")!.modelErrorLoop).toBeUndefined();
    const plain = await attachAgentActivity(base, { tmuxAdapter: {} as TmuxAdapter, activityStore: store(db, {}), now: NOW });
    for (const key of ["agentActivity", "lifecycleState", "startupStatus", "sessionStatus", "latestError", "heldReason"] as const) {
      expect(qa[key], key).toEqual(plain.find((e) => e.logicalId === "verify.qa")![key]);
    }
    db.close();
  });

  it("a seat that is no longer running is not counted, whatever its sidecar says", () => {
    const { db } = world();
    db.prepare("UPDATE sessions SET status = 'exited' WHERE session_name = 'verify-qa@eztrack'").run();
    const ps = new PsProjectionService({ db, agentActivity: store(db, { "verify-qa@eztrack": flag() }) });
    expect(ps.getEntries().find((e) => e.name === "eztrack")!.attentionCount).toBe(0);
    db.close();
  });

  it("the line says how long and what, for one request and for many, and shortens a long error", () => {
    expect(describeModelErrorLoop(flag({ total: 1 }), NOW.getTime()).line).toContain("1 failed request since");
    expect(describeModelErrorLoop(flag({ lastAt: iso(NOW.getTime() - 3 * MIN) }), NOW.getTime()).line).toContain('last "terminated" 3m ago');
    expect(describeModelErrorLoop(flag({ lastError: "e".repeat(100) }), NOW.getTime()).line).toContain(`"${"e".repeat(59)}…"`);
  });

  it("only a Pi or OMP seat can be marked: a claude-code seat is never asked", () => {
    const { db } = world();
    const asked: string[] = [];
    const s = new AgentActivityStore({ db, eventBus: new EventBus(db), now: () => NOW, modelErrorLoop: (session) => { asked.push(session); return flag(); } });
    expect(s.modelErrorLoopFor("exec-cos@eztrack", "claude-code", NOW)).toBeNull();
    expect(s.modelErrorLoopFor("x@y", null, NOW)).toBeNull();
    expect(asked).toEqual([]);
    expect(s.modelErrorLoopFor("verify-qa@eztrack", "pi", NOW)).not.toBeNull();
    db.close();
  });

  it("a reader that throws marks nothing instead of failing the listing", () => {
    const { db } = world();
    const s = new AgentActivityStore({ db, eventBus: new EventBus(db), now: () => NOW, modelErrorLoop: () => { throw new Error("boom"); } });
    expect(s.modelErrorLoopFor("verify-qa@eztrack", "pi", NOW)).toBeNull();
    db.close();
  });

  it("seatNeedsAttention counts the flag as attention and nothing else about the seat changes", () => {
    const { db, rig } = world();
    const qa = getNodeInventory(db, rig.id).find((e) => e.logicalId === "verify.qa")!;
    expect(seatNeedsAttention(qa, null, null)).toBe(false);
    expect(seatNeedsAttention(qa, null, null, flag())).toBe(true);
    db.close();
  });

  it("send gating does not read the marker: a sidecar with the flag and one without give the same readiness, for Pi and for OMP", async () => {
    const home = mkdtempSync(join(tmpdir(), "of286-"));
    dirs.push(home);
    const write = (stateRoot: string, session: string, withFlag: boolean) => {
      mkdirSync(join(stateRoot, session), { recursive: true });
      const sidecar = { ready: true, busy: true, updatedAt: iso(NOW.getTime()), aliveAt: iso(NOW.getTime()), ...(withFlag ? { modelErrorLoop: flag() } : {}) };
      writeFileSync(join(stateRoot, session, "runner-state.json"), JSON.stringify(sidecar));
    };
    for (const [Adapter, name] of [[PiRuntimeAdapter, "pi"], [OmpRuntimeAdapter, "omp"]] as Array<[AdapterClass, string]>) {
      const stateRoot = join(home, name);
      write(stateRoot, "a@r", true); write(stateRoot, "b@r", false);
      const a = new Adapter({ tmux: {} as TmuxAdapter, stateRoot, runnerEntryPath: "/x", now: () => NOW,
        fsOps: { readFile: (p: string) => readFileSync(p, "utf-8"), exists: () => true, writeFile: () => undefined, mkdirp: () => undefined } });
      expect(await a.sendReadiness({ sessionName: "a@r", nodeId: null }), name).toEqual(await a.sendReadiness({ sessionName: "b@r", nodeId: null }));
      expect(a.modelErrorLoop("a@r"), name).not.toBeNull();
      expect(a.modelErrorLoop("b@r"), name).toBeNull();
    }
  });
});

// ── the Chief of Staff is told ──────────────────────────────────────────────────────────────────
// What the Chief of Staff receives is the ROWS in its queue, not the calls to create(): an id reused across episodes is absorbed by the queue (no row,
// no wake) and a call-counting test cannot see it.

describe("OF-286 the Chief of Staff is told every time a seat starts looping, and when it stops", () => {
  type Created = Parameters<QueueRepository["create"]>[0];
  type Read = { observed: boolean; loop: PublishedModelErrorLoop | null; launchId?: string };
  const open: Database.Database[] = [];
  afterEach(() => { for (const d of open.splice(0)) d.close(); });

  function setup(opts: { cos?: boolean; queueFails?: { n: number } } = {}) {
    const db = createFullTestDb(); open.push(db);
    const rigs = new RigRepository(db); const sessions = new SessionRegistry(db); const eventBus = new EventBus(db);
    const queue = new QueueRepository(db, eventBus, { validateRig: (d: string) => /^[^@]+@[^@]+$/.test(d) && !!db.prepare("SELECT 1 FROM rigs WHERE name = ? AND archived_at IS NULL").get(d.split("@")[1]) });
    const rig = rigs.createRig("eztrack");
    const cos = rigs.addNode(rig.id, "exec.cos", { runtime: "claude-code" });
    const run = (nodeId: string, session: string) => sessions.updateStatus(sessions.registerSession(nodeId, session).id, "running");
    if (opts.cos !== false) run(cos.id, "exec-cos@eztrack");
    for (const [i, id] of ["verify.qa", "verify.sec"].entries()) {
      const n = rigs.addNode(rig.id, id, { runtime: i === 1 ? "omp" : "pi" });
      run(n.id, `${id.replace(".", "-")}@eztrack`);
      rigs.addEdge(rig.id, cos.id, n.id, "delegates_to");
    }
    const created: Created[] = []; const log: string[] = [];
    const reads: Record<string, Read> = {};
    let now = T0 + 120 * MIN;
    const notifier = new SeatModelErrorLoopNotifier({
      db, queue: { create: async (input) => { created.push(input); if (opts.queueFails && opts.queueFails.n-- > 0) throw new Error("queue down"); return queue.create(input); } },
      inventory: () => inventoryOfLiveRigs(db), read: (_rt, s) => reads[s] ?? { observed: true, loop: null }, now: () => new Date(now), log: (l) => log.push(l),
    });
    const flagged = (since = T0 + 100 * MIN): PublishedModelErrorLoop => ({ count: 3, total: 4, since: iso(since), lastAt: iso(since + 4 * MIN), lastError: "terminated" });
    return { db, queue, notifier, created, log, reads, flagged, advance: (m: number) => { now += m * MIN; } };
  }
  const rows = (db: Database.Database, session = "exec-cos@eztrack") => db.prepare("SELECT qitem_id, tags, body, source_session FROM queue_items WHERE destination_session = ? ORDER BY ts_created, qitem_id").all(session) as Array<{ qitem_id: string; tags: string; body: string; source_session: string }>;
  const QA = "verify-qa@eztrack";

  it("files one row to the rig's Chief of Staff from the daemon when a seat's flag appears, and wakes it", async () => {
    const w = setup();
    w.reads[QA] = { observed: true, loop: w.flagged(), launchId: "L1" };
    await w.notifier.tick();
    const got = rows(w.db);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ qitem_id: modelLoopNoticeId("looping", QA, iso(T0 + 100 * MIN)), source_session: "daemon@kernel" });
    expect(got[0]!.body).toContain("verify.qa@eztrack");
    expect(w.created[0]!.summary).toContain("verify.qa@eztrack");
    expect(got[0]!.body).toContain("4 failed model requests");
    expect(got[0]!.body).toContain("terminated");
    expect(got[0]!.body).toContain("rig capture verify-qa@eztrack");
    expect(w.created[0]!.nudge).not.toBe(false);
  });

  it("shell-quotes the seat's session in the command it gives", async () => {
    const { modelLoopStartBody } = await import("../src/domain/seat-model-error-loop-notice.js");
    expect(modelLoopStartBody("x@y", "odd name@rig", flagLike())).toContain("rig capture 'odd name@rig'");
    function flagLike(): PublishedModelErrorLoop { return { count: 3, total: 3, since: iso(T0), lastAt: iso(T0), lastError: "e" }; }
  });

  it("says it once while the flag lasts, however many passes see it", async () => {
    const w = setup();
    w.reads[QA] = { observed: true, loop: w.flagged(), launchId: "L1" };
    await w.notifier.tick(); await w.notifier.tick(); await w.notifier.tick();
    expect(rows(w.db)).toHaveLength(1);
    expect(w.created).toHaveLength(1);
  });

  it("files a recovery row, without waking, when the same runner's flag is gone; the recovery is a row of its own", async () => {
    const w = setup();
    w.reads[QA] = { observed: true, loop: w.flagged(), launchId: "L1" };
    await w.notifier.tick();
    w.reads[QA] = { observed: true, loop: null, launchId: "L1" };
    await w.notifier.tick(); await w.notifier.tick();
    const got = rows(w.db);
    expect(got).toHaveLength(2);
    expect(got.map((r) => r.qitem_id)).toEqual([modelLoopNoticeId("looping", QA, iso(T0 + 100 * MIN)), modelLoopNoticeId("recovered", QA, iso(T0 + 100 * MIN))]);
    expect(new Set(got.map((r) => r.qitem_id)).size).toBe(2);
    expect(got[1]!.body).toContain("no longer flagged");
    expect(w.created[1]!.nudge).toBe(false);
  });

  it("every episode is announced, however soon the last one ended: three loops and two recoveries are five rows", async () => {
    const w = setup();
    const L = (n: number) => w.flagged(T0 + (100 + n) * MIN);
    w.reads[QA] = { observed: true, loop: L(0), launchId: "L1" }; await w.notifier.tick();
    w.reads[QA] = { observed: true, loop: null, launchId: "L1" }; await w.notifier.tick();
    w.advance(5);
    w.reads[QA] = { observed: true, loop: L(10), launchId: "L1" }; await w.notifier.tick();
    w.reads[QA] = { observed: true, loop: null, launchId: "L1" }; await w.notifier.tick();
    w.advance(5);
    w.reads[QA] = { observed: true, loop: L(20), launchId: "L1" }; await w.notifier.tick();
    const got = rows(w.db);
    expect(got).toHaveLength(5);
    expect(new Set(got.map((r) => r.qitem_id)).size).toBe(5);
    expect(got.filter((r) => r.tags.includes("state:looping"))).toHaveLength(3);
    expect(got.filter((r) => r.tags.includes("state:recovered"))).toHaveLength(2);
  });

  it("a relaunch is not a recovery: the runner going away sends nothing, and a loop after it is announced as a new start", async () => {
    const w = setup();
    w.reads[QA] = { observed: true, loop: w.flagged(), launchId: "L1" }; await w.notifier.tick();
    w.reads[QA] = { observed: false, loop: null }; await w.notifier.tick();            // the pending sidecar of the new launch
    w.reads[QA] = { observed: true, loop: null, launchId: "L2" }; await w.notifier.tick(); // the new runner: ready, no flag
    expect(rows(w.db)).toHaveLength(1);
    w.advance(20);
    w.reads[QA] = { observed: true, loop: w.flagged(T0 + 135 * MIN), launchId: "L2" }; await w.notifier.tick();
    const got = rows(w.db);
    expect(got).toHaveLength(2);
    expect(got.every((r) => r.tags.includes("state:looping"))).toBe(true);
  });

  it("a relaunch that fell between two passes (another launch id, no flag) is not a recovery either", async () => {
    const w = setup();
    w.reads[QA] = { observed: true, loop: w.flagged(), launchId: "L1" }; await w.notifier.tick();
    w.reads[QA] = { observed: true, loop: null, launchId: "L2" }; await w.notifier.tick();
    expect(rows(w.db)).toHaveLength(1);
    expect(rows(w.db)[0]!.tags).toContain("state:looping");
  });

  it("a new loop of a new launch is announced even when the old flag was never seen clearing", async () => {
    const w = setup();
    w.reads[QA] = { observed: true, loop: w.flagged(), launchId: "L1" }; await w.notifier.tick();
    w.reads[QA] = { observed: true, loop: w.flagged(T0 + 110 * MIN), launchId: "L2" }; await w.notifier.tick();
    expect(rows(w.db)).toHaveLength(2);
  });

  it("a loop that starts between two passes (another first failure, no clear seen) is a new episode with its own row, and no recovery for the first", async () => {
    const w = setup();
    w.reads[QA] = { observed: true, loop: w.flagged(), launchId: "L1" }; await w.notifier.tick();
    w.reads[QA] = { observed: true, loop: w.flagged(T0 + 112 * MIN), launchId: "L1" }; await w.notifier.tick();
    const got = rows(w.db);
    expect(got).toHaveLength(2);
    expect(got.every((r) => r.tags.includes("state:looping"))).toBe(true);
    expect(new Set(got.map((r) => r.qitem_id)).size).toBe(2);
  });

  it("an unobserved runner is neither looping nor recovered; when it is observed again with the same flag the queue absorbs the repeat", async () => {
    const w = setup();
    w.reads[QA] = { observed: true, loop: w.flagged(), launchId: "L1" }; await w.notifier.tick();
    w.reads[QA] = { observed: false, loop: null }; await w.notifier.tick();
    w.reads[QA] = { observed: true, loop: w.flagged(), launchId: "L1" }; await w.notifier.tick();
    expect(rows(w.db)).toHaveLength(1);
  });

  it("a runner that publishes no launch id (an older one) and goes unobserved is not recovered either", async () => {
    const w = setup();
    w.reads[QA] = { observed: true, loop: w.flagged() }; await w.notifier.tick();
    w.reads[QA] = { observed: false, loop: null }; await w.notifier.tick();
    w.reads[QA] = { observed: true, loop: null }; await w.notifier.tick();
    expect(rows(w.db)).toHaveLength(1);
  });

  it("a start item that could not be filed is tried again on the next pass, and the failure is logged", async () => {
    const w = setup({ queueFails: { n: 1 } });
    w.reads[QA] = { observed: true, loop: w.flagged(), launchId: "L1" };
    await w.notifier.tick();
    expect(rows(w.db)).toHaveLength(0);
    expect(w.log.join("\n")).toContain("queue down");
    await w.notifier.tick();
    expect(rows(w.db)).toHaveLength(1);
    await w.notifier.tick();
    expect(rows(w.db)).toHaveLength(1);
  });

  it("a recovery follows only a start that was filed: a flag that clears before its start went out sends nothing", async () => {
    const w = setup({ queueFails: { n: 1 } });
    w.reads[QA] = { observed: true, loop: w.flagged(), launchId: "L1" }; await w.notifier.tick();
    w.reads[QA] = { observed: true, loop: null, launchId: "L1" }; await w.notifier.tick();
    expect(rows(w.db)).toHaveLength(0);
  });

  it("a daemon restart inside an episode files the same item again, which the queue absorbs", async () => {
    const w = setup();
    w.reads[QA] = { observed: true, loop: w.flagged(), launchId: "L1" };
    await w.notifier.tick();
    const restarted = new SeatModelErrorLoopNotifier({ db: w.db, queue: w.queue, inventory: () => inventoryOfLiveRigs(w.db), read: (_rt, s) => w.reads[s] ?? { observed: true, loop: null }, now: () => new Date(T0 + 130 * MIN), log: () => undefined });
    await restarted.tick();
    expect(rows(w.db)).toHaveLength(1);
  });

  it("files nothing when the rig has no Chief of Staff, logs why once, and tells it once one exists", async () => {
    const w = setup({ cos: false });
    w.reads[QA] = { observed: true, loop: w.flagged(), launchId: "L1" };
    await w.notifier.tick(); await w.notifier.tick();
    expect(w.created).toEqual([]);
    expect(w.log.filter((l) => l.includes("no Chief of Staff"))).toHaveLength(1);
    const cosNode = w.db.prepare("SELECT id FROM nodes WHERE logical_id = 'exec.cos'").get() as { id: string };
    const sessions = new SessionRegistry(w.db);
    sessions.updateStatus(sessions.registerSession(cosNode.id, "exec-cos@eztrack").id, "running");
    await w.notifier.tick();
    expect(rows(w.db)).toHaveLength(1);
  });

  it("files nothing when the looping seat is the Chief of Staff itself", async () => {
    const w = setup();
    w.db.prepare("UPDATE nodes SET runtime = 'pi' WHERE logical_id = 'exec.cos'").run();
    w.reads["exec-cos@eztrack"] = { observed: true, loop: w.flagged(), launchId: "L1" };
    await w.notifier.tick();
    expect(w.created).toEqual([]);
    expect(w.log.join("\n")).toContain("it is the Chief of Staff");
  });

  it("a seat that stops running is forgotten without a recovery item, also when it returns", async () => {
    const w = setup();
    w.reads[QA] = { observed: true, loop: w.flagged(), launchId: "L1" }; await w.notifier.tick();
    w.db.prepare("UPDATE sessions SET status = 'exited' WHERE session_name = 'verify-qa@eztrack'").run();
    w.reads[QA] = { observed: true, loop: null, launchId: "L1" }; await w.notifier.tick();
    w.db.prepare("UPDATE sessions SET status = 'running' WHERE session_name = 'verify-qa@eztrack'").run();
    await w.notifier.tick();
    expect(rows(w.db)).toHaveLength(1);
  });

  it("only Pi and OMP seats are read; a failing reader never throws out of a pass", async () => {
    const w = setup();
    const asked: string[] = [];
    const n = new SeatModelErrorLoopNotifier({ db: w.db, queue: w.queue, inventory: () => inventoryOfLiveRigs(w.db),
      read: (_rt, s) => { asked.push(s); if (s === "verify-sec@eztrack") throw new Error("boom"); return { observed: true, loop: w.flagged(), launchId: "L1" }; }, now: () => new Date(T0), log: (l) => w.log.push(l) });
    await expect(n.tick()).resolves.toBeUndefined();
    expect(asked.sort()).toEqual(["verify-qa@eztrack", "verify-sec@eztrack"]);
    expect(rows(w.db)).toHaveLength(1);
  });

  it("start() runs passes on its timer and stop() ends them", async () => {
    const w = setup();
    w.reads[QA] = { observed: true, loop: w.flagged(), launchId: "L1" };
    const n = new SeatModelErrorLoopNotifier({ db: w.db, queue: w.queue, inventory: () => inventoryOfLiveRigs(w.db), read: (_rt, s) => w.reads[s] ?? { observed: true, loop: null }, intervalMs: 5, log: () => undefined, now: () => new Date(T0 + 130 * MIN) });
    n.start();
    await new Promise((r) => setTimeout(r, 60));
    n.stop();
    expect(rows(w.db)).toHaveLength(1);
    w.reads["verify-sec@eztrack"] = { observed: true, loop: w.flagged(T0 + 101 * MIN), launchId: "L1" };
    await new Promise((r) => setTimeout(r, 40));
    expect(rows(w.db)).toHaveLength(1); // stopped: the second seat is not seen
  });
});
