// workspaces-o9o.13: a Pi seat whose model connection failed recovers on its own, without a provider call of ours.
//
// Two failure classes, both read from Pi 1.4.0 (`@earendil-works/pi-ai` dist/api/openai-codex-responses.js, the same logic in 1.5.0):
//   1. Sticky HTTP fallback. A WebSocket failure records the session in a module-level Set (recordWebSocketFailure) that only a new
//      process clears; every later request goes over HTTP, and the provider rejected those with a 400 that Pi never retries
//      (verify-sec@eztrack and verify-sec@cel-identity, 2026-11-13..16). The failing turn carries a `provider_transport_failure`
//      diagnostic; later 400 turns in the same process do not. A fresh process's WebSocket request with the full history is accepted
//      (workspaces-o9o.22, one live turn by verify-ops, 2026-11-16 11:34Z). Recovery: restart pi on the same session, then one
//      OpenRig-labelled continue prompt; at most once per launch (Jim, 2026-11-16, via the CoS).
//   2. The provider's 60-minute WebSocket cap hit mid-stream ("Responses websocket connection limit reached (60 minutes)"): Pi throws
//      it as a non-transport error, so no fallback is recorded and the dropped socket is replaced on the next request, but Pi does
//      not retry it and the turn ends with the task undone (verify-qa@openrig, 2026-11-16 13:04Z, diagnostics null). Recovery: one
//      continue prompt to the same process; again only after a turn that answered.
//
// The real-runner rows run the runner entry against an offline fake `pi`: no provider, no installed Pi.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { RunnerCore, type RunnerIo } from "../src/adapters/pi-runner.js";
import { piSeatPaths, PI_RUNNER_READY_MARKER, type PiRunnerState } from "../src/adapters/pi-runner-protocol.js";
import { seatGateLogPath, SeatGateStore } from "../src/adapters/seat-gate-store.js";

/** The continue prompt, pinned word for word (Jim, 2026-11-16: one per recovery, fixed text, labelled as from OpenRig). */
const CONTINUE_PROMPT = "[OpenRig] Your last turn ended on a model-provider connection error, not on anything you did. OpenRig has reconnected you to the provider. Continue the task you were working on from where it stopped; do not repeat steps that already completed.";

const BAD_REQUEST = "{\"detail\":\"Bad Request\"}";
const CAP_ERROR = "Codex error: Responses websocket connection limit reached (60 minutes). Create a new websocket connection to continue.";
const TRANSPORT_DIAGNOSTIC = { type: "provider_transport_failure", error: "WebSocket closed 1006", details: { configuredTransport: "auto", phase: "before_message_stream_start", fallbackTransport: "sse" } };

// ── Real runner, offline fake pi ────────────────────────────────────────────

/**
 * A fake pi. Every process logs its start (pid, whether it resumed with --session) and each prompt it got to `effects`.
 * Modes (from the `mode` file, read at each process start):
 *   sticky400  - the process's first prompt fails with the transport diagnostic and a 400; every later prompt in that process
 *                fails with a bare 400 (the sticky fallback); a process started with --session answers.
 *   always400  - like sticky400, but a resumed process fails the same way too.
 *   cap        - the process's first prompt fails on the 60-minute cap (no diagnostic); later prompts answer.
 */
function fakePi(dir: string) {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const session = path.join(dir, "session.jsonl");
  const effects = path.join(dir, "effects.jsonl");
  const modeFile = path.join(dir, "mode");
  fs.writeFileSync(session, `${JSON.stringify({ type: "session", version: 3, id: "offline", timestamp: "2026-01-02T03:04:05.000Z", cwd: dir })}\n`);
  fs.writeFileSync(effects, "");
  const script = `#!${process.execPath}
const fs = require("node:fs");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const log = (o) => fs.appendFileSync(${JSON.stringify(effects)}, JSON.stringify({ pid: process.pid, ...o }) + "\\n");
const mode = fs.readFileSync(${JSON.stringify(modeFile)}, "utf8").trim();
const resumed = process.argv.includes("--session");
const sessionArg = resumed ? process.argv[process.argv.indexOf("--session") + 1] : null;
log({ event: "start", resumed, sessionArg });
let prompts = 0;
let n = 0;
const entry = (message) => fs.appendFileSync(${JSON.stringify(session)}, JSON.stringify({ type: "message", id: "e" + process.pid + "-" + (++n), message }) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const cmd = JSON.parse(line);
  if (cmd.type === "get_state") { out({ type: "response", id: cmd.id, command: "get_state", success: true, data: { sessionFile: ${JSON.stringify(session)}, sessionId: "offline", isStreaming: false } }); return; }
  if (cmd.type !== "prompt" && cmd.type !== "steer" && cmd.type !== "follow_up") return;
  prompts++;
  log({ event: "prompt", type: cmd.type, message: cmd.message });
  const user = { role: "user", content: [{ type: "text", text: cmd.message }], timestamp: 1 };
  entry(user);
  out({ type: "response", id: cmd.id, command: cmd.type, success: true, data: { disposition: "started" } });
  out({ type: "agent_start" });
  out({ type: "message_start", message: user });
  out({ type: "message_end", message: user });
  let assistant;
  const failFirst = mode === "cap" ? prompts === 1 : (mode === "always400" || !resumed);
  if (!failFirst) assistant = { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", timestamp: 2 };
  else if (mode === "cap") assistant = { role: "assistant", content: [], stopReason: "error", errorMessage: ${JSON.stringify(CAP_ERROR)}, timestamp: 2 };
  else if (prompts === 1) assistant = { role: "assistant", content: [], stopReason: "error", errorMessage: ${JSON.stringify(BAD_REQUEST)}, diagnostics: [${JSON.stringify(TRANSPORT_DIAGNOSTIC)}], timestamp: 2 };
  else assistant = { role: "assistant", content: [], stopReason: "error", errorMessage: ${JSON.stringify(BAD_REQUEST)}, timestamp: 2 };
  entry(assistant);
  out({ type: "message_start", message: assistant });
  out({ type: "message_end", message: assistant });
  out({ type: "agent_end", messages: [user, assistant] });
  out({ type: "agent_settled" });
});
`;
  fs.writeFileSync(path.join(bin, "pi"), script, { mode: 0o700 });
  return { bin, session, effects, modeFile };
}

const RUNNER = fileURLToPath(new URL("../src/adapters/pi-runner.ts", import.meta.url));
let running: { child: ChildProcess; temp: string } | null = null;
afterEach(() => {
  if (!running) return;
  running.child.kill("SIGKILL");
  fs.rmSync(running.temp, { recursive: true, force: true });
  running = null;
});

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

/** Start the real runner on a fake pi in `mode`, wait for READY, send one task, and settle. */
async function runSeat(mode: "sticky400" | "always400" | "cap") {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "o9o13-"));
  const pi = fakePi(temp);
  fs.writeFileSync(pi.modeFile, mode);
  const stateRoot = path.join(temp, "state");
  const child = spawn(process.execPath, ["--import", "tsx", RUNNER,
    "--session-name", "fixture", "--state-root", stateRoot, "--cwd", temp, "--launch-id", "launch-1", "--no-approve"], {
    env: { PATH: pi.bin + path.delimiter + path.dirname(process.execPath), HOME: temp, OPENRIG_HOME: path.join(temp, "home") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  running = { child, temp };
  let output = "";
  child.stdout!.on("data", (d) => { output += d.toString(); });
  child.stderr!.on("data", (d) => { output += d.toString(); });
  expect(await until(() => output.includes(PI_RUNNER_READY_MARKER), 15_000), output).toBe(true);
  child.stdin!.write("do the task\n");
  const effects = () => fs.readFileSync(pi.effects, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  const state = () => JSON.parse(fs.readFileSync(piSeatPaths(stateRoot, "fixture").runnerStatePath, "utf8")) as PiRunnerState & Record<string, unknown>;
  return { pi, child, effects, state, output: () => output };
}

describe("o9o.13: a Pi seat recovers from a failed model connection (real runner, offline fake pi)", () => {
  it("sticky HTTP fallback: the 400 after a transport failure restarts pi on the same session and the task continues there", async () => {
    const seat = await runSeat("sticky400");
    const continued = () => seat.effects().some((e) => e.event === "prompt" && e.message === CONTINUE_PROMPT);
    expect(await until(continued, 15_000), `no continue prompt reached pi:\n${seat.output()}`).toBe(true);
    const starts = seat.effects().filter((e) => e.event === "start");
    expect(starts).toHaveLength(2);
    expect(starts[1]).toMatchObject({ resumed: true, sessionArg: seat.pi.session });
    const cont = seat.effects().find((e) => e.event === "prompt" && e.message === CONTINUE_PROMPT)!;
    expect(cont.pid, "the continue prompt went to the restarted process").toBe(starts[1]!.pid);
    expect(cont.type).toBe("prompt");
    // The restarted process answered: the turn after the reset is clean.
    expect(await until(() => seat.state().busy === false && !seat.state().modelErrorLoop, 5_000), JSON.stringify(seat.state())).toBe(true);
    const state = seat.state();
    expect(state.exited, "a deliberate restart is not the runner's exit").toBeUndefined();
    expect(state).toMatchObject({ ready: true, launchId: "launch-1", sessionFile: seat.pi.session });
    expect(state.transportRecovery).toMatchObject({ kind: "transport_reset", outcome: "resumed" });
    expect(seat.child.exitCode).toBeNull();
  }, 40_000);

  it("the reset happens at most once per launch: a restarted pi that fails the same way is left for a fresh relaunch", async () => {
    const seat = await runSeat("always400");
    expect(await until(() => seat.effects().filter((e) => e.event === "prompt" && e.message === CONTINUE_PROMPT).length === 1, 15_000), seat.output()).toBe(true);
    expect(await until(() => seat.output().includes("relaunch the seat fresh"), 10_000), seat.output()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(seat.effects().filter((e) => e.event === "start")).toHaveLength(2);
    expect(seat.effects().filter((e) => e.event === "prompt" && e.message === CONTINUE_PROMPT)).toHaveLength(1);
    expect(seat.state().modelErrorLoop).toMatchObject({ reason: "provider-rejected" });
    expect(seat.state().exited).toBeUndefined();
  }, 40_000);

  it("the 60-minute WebSocket cap: pi is asked once to continue, in the same process, and answers", async () => {
    const seat = await runSeat("cap");
    const continued = () => seat.effects().some((e) => e.event === "prompt" && e.message === CONTINUE_PROMPT);
    expect(await until(continued, 15_000), `no continue prompt reached pi:\n${seat.output()}`).toBe(true);
    const starts = seat.effects().filter((e) => e.event === "start");
    expect(starts, "no restart for the cap: the next request opens a new connection").toHaveLength(1);
    expect(await until(() => seat.state().busy === false, 5_000)).toBe(true);
    expect(seat.state().transportRecovery).toMatchObject({ kind: "connection_cap_continue", outcome: "resumed" });
    expect(seat.state().exited).toBeUndefined();
  }, 40_000);
});

// ── The rules, on the core with fake effects ────────────────────────────────

function core() {
  const rpc: Array<Record<string, unknown>> = [];
  const lines: string[] = [];
  const sidecars: PiRunnerState[] = [];
  const restarts: string[] = [];
  const io: RunnerIo = {
    sendRpc: (cmd) => { rpc.push(cmd); },
    mirrorLine: (line) => { lines.push(line); },
    mirrorAppend: () => {},
    postActivity: () => {},
    writeSidecar: (state) => { sidecars.push(state); },
    now: () => "2026-11-16T21:00:00.000Z",
    restartChild: (sessionFile: string) => { restarts.push(sessionFile); },
  } as RunnerIo;
  const c = new RunnerCore(io, { sessionName: "fixture", launchId: "launch-1" }, { runtime: "pi" });
  const feed = (o: Record<string, unknown>) => c.handlePiLine(JSON.stringify(o));
  c.start();
  feed({ type: "response", id: "pi-runner-get-state", success: true, data: { sessionFile: "/s/session.jsonl", sessionId: "sid" } });
  /** One run: a user prompt, then the assistant messages given, then the run's end. */
  const turn = (...assistant: Array<Record<string, unknown>>) => {
    feed({ type: "agent_start" });
    for (const a of assistant) {
      feed({ type: "message_start", message: { role: "assistant", ...a } });
      feed({ type: "message_end", message: { role: "assistant", ...a } });
    }
    feed({ type: "agent_end", messages: [] });
    feed({ type: "agent_settled" });
  };
  const continues = () => rpc.filter((r) => r.type === "prompt" && r.message === CONTINUE_PROMPT);
  return { c, io, rpc, lines, sidecars, restarts, feed, turn, continues };
}

const answer = { stopReason: "stop", content: [{ type: "text", text: "ok" }] };
const rejected = (diagnostics?: unknown[]) => ({ stopReason: "error", errorMessage: BAD_REQUEST, ...(diagnostics ? { diagnostics } : {}) });

describe("o9o.13: when the runner recovers, and when it does not", () => {
  it("a 400 with no transport failure in this process (still on WebSocket) is not a transport problem: no restart, no prompt", () => {
    const s = core();
    s.turn(rejected());
    expect(s.restarts).toEqual([]);
    expect(s.continues()).toEqual([]);
  });

  it("a transport failure on an earlier turn, then a 400 turn: the restart resumes the same session file", () => {
    const s = core();
    s.turn({ stopReason: "error", errorMessage: "WebSocket closed 1006", diagnostics: [TRANSPORT_DIAGNOSTIC] });
    expect(s.restarts, "a transport failure alone ends no task on a 400").toEqual([]);
    s.turn(rejected());
    expect(s.restarts).toEqual(["/s/session.jsonl"]);
  });

  it("after a transport failure, a turn that ends on another error (an exhausted 500) restarts nothing", () => {
    const s = core();
    s.turn({ stopReason: "error", errorMessage: "500 Internal Server Error", diagnostics: [TRANSPORT_DIAGNOSTIC] });
    expect(s.restarts).toEqual([]);
    expect(s.continues()).toEqual([]);
  });

  it("the restarted process is asked to continue once, after its get_state names the same session file", () => {
    const s = core();
    s.turn(rejected([TRANSPORT_DIAGNOSTIC]));
    expect(s.restarts).toHaveLength(1);
    expect(s.continues(), "nothing is sent before the new process answers get_state").toEqual([]);
    s.c.childRestarted();
    expect(s.rpc.at(-1)).toMatchObject({ type: "get_state" });
    s.feed({ type: "response", id: "pi-runner-get-state", success: true, data: { sessionFile: "/s/session.jsonl", sessionId: "sid" } });
    expect(s.continues()).toHaveLength(1);
  });

  it("a restarted process on another session file gets no prompt, and the pane says so", () => {
    const s = core();
    s.turn(rejected([TRANSPORT_DIAGNOSTIC]));
    s.c.childRestarted();
    s.feed({ type: "response", id: "pi-runner-get-state", success: true, data: { sessionFile: "/s/other.jsonl", sessionId: "x" } });
    expect(s.continues()).toEqual([]);
    expect(s.lines.join("\n")).toMatch(/ERROR .*restarted pi opened \/s\/other\.jsonl, not \/s\/session\.jsonl/);
    expect(s.sidecars.at(-1)?.transportRecovery).toMatchObject({ kind: "transport_reset", outcome: "session_mismatch" });
  });

  it("a message that arrives while pi restarts is held, sent to the new process, and replaces the continue prompt", () => {
    const s = core();
    s.turn(rejected([TRANSPORT_DIAGNOSTIC]));
    const before = s.rpc.length;
    s.c.handleUserBlock("the operator's next instruction");
    expect(s.rpc.length, "nothing is written to the old process's pipe").toBe(before);
    s.c.childRestarted();
    s.feed({ type: "response", id: "pi-runner-get-state", success: true, data: { sessionFile: "/s/session.jsonl", sessionId: "sid" } });
    expect(s.rpc.filter((r) => r.type === "prompt").map((r) => r.message)).toEqual(["the operator's next instruction"]);
    expect(s.continues()).toEqual([]);
  });

  it("the 60-minute cap: one continue prompt, and none again until a turn has answered", () => {
    const s = core();
    s.turn({ stopReason: "error", errorMessage: CAP_ERROR });
    expect(s.restarts).toEqual([]);
    expect(s.continues()).toHaveLength(1);
    s.turn({ stopReason: "error", errorMessage: CAP_ERROR });
    expect(s.continues(), "the continue turn failed the same way: no second prompt").toHaveLength(1);
    s.turn(answer);
    s.turn({ stopReason: "error", errorMessage: CAP_ERROR });
    expect(s.continues(), "a turn answered since: the next cap is recovered again").toHaveLength(2);
  });

  it("an OMP seat is left alone", () => {
    const rpc: Array<Record<string, unknown>> = [];
    const restarts: string[] = [];
    const io = { sendRpc: (c: Record<string, unknown>) => { rpc.push(c); }, mirrorLine: () => {}, mirrorAppend: () => {}, postActivity: () => {},
      writeSidecar: () => {}, now: () => "2026-11-16T21:00:00.000Z", restartChild: (f: string) => { restarts.push(f); } } as RunnerIo;
    const c = new RunnerCore(io, { sessionName: "fixture" }, { runtime: "omp" });
    const feed = (o: Record<string, unknown>) => c.handlePiLine(JSON.stringify(o));
    feed({ type: "response", id: "pi-runner-get-state", success: true, data: { sessionFile: "/s/session.jsonl", sessionId: "sid" } });
    feed({ type: "agent_start" });
    feed({ type: "message_end", message: { role: "assistant", ...rejected([TRANSPORT_DIAGNOSTIC]) } });
    feed({ type: "agent_end", messages: [], isTerminal: true });
    feed({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: CAP_ERROR } });
    feed({ type: "agent_end", messages: [], isTerminal: true });
    expect(restarts).toEqual([]);
    expect(rpc.filter((r) => r.type === "prompt")).toEqual([]);
  });
});

describe("o9o.13: what a recovery leaves behind", () => {
  it("a run that starts before Pi settles (a queued follow-up) cancels the pending recovery: no continue prompt after it", () => {
    const s = core();
    s.feed({ type: "agent_start" });
    s.feed({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: CAP_ERROR } });
    s.feed({ type: "agent_end", messages: [] });
    // Pi runs the queued follow-up before it settles: a new run, which answers.
    s.feed({ type: "agent_start" });
    s.feed({ type: "message_end", message: { role: "assistant", ...answer } });
    s.feed({ type: "agent_end", messages: [] });
    s.feed({ type: "agent_settled" });
    expect(s.continues()).toEqual([]);
  });

  it("a message sent to the old pi that never reached its session is released by the restart, so the daemon can send it again", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "o9o13-gate-"));
    try {
      const session = path.join(dir, "s.jsonl");
      fs.writeFileSync(session, `${JSON.stringify({ type: "session", version: 3, id: "x", timestamp: "2026-01-02T03:04:05.000Z", cwd: dir })}\n`);
      const log = seatGateLogPath(dir);
      const rpc: Array<Record<string, unknown>> = [];
      const io = { sendRpc: (c: Record<string, unknown>) => { rpc.push(c); }, mirrorLine: () => {}, mirrorAppend: () => {}, postActivity: () => {},
        writeSidecar: () => {}, now: () => "2026-11-16T21:00:00.000Z", restartChild: () => {} } as RunnerIo;
      const c = new RunnerCore(io, { sessionName: "s", launchId: "l" }, { runtime: "pi", gate: SeatGateStore.open(log) });
      const feed = (o: Record<string, unknown>) => c.handlePiLine(JSON.stringify(o));
      c.start();
      feed({ type: "response", id: "pi-runner-get-state", success: true, data: { sessionFile: session, sessionId: "x" } });
      c.handleUserBlock("lost in the old pipe\n[openrig-msg m1:0123456789abcdef]");
      expect(rpc.at(-1)).toMatchObject({ type: "prompt", message: "lost in the old pipe" });
      feed({ type: "agent_start" });
      feed({ type: "message_end", message: { role: "assistant", ...rejected([TRANSPORT_DIAGNOSTIC]) } });
      feed({ type: "agent_end", messages: [] });
      feed({ type: "agent_settled" });
      c.childRestarted();
      feed({ type: "response", id: "pi-runner-get-state", success: true, data: { sessionFile: session, sessionId: "x" } });
      expect(fs.readFileSync(log, "utf8")).toContain("restart_not_in_session");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
