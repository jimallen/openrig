// S2: the gate inside RunnerCore, for both runtimes, with the RPC faked and a real store on disk. The kills are in
// seat-gate-crash.real.test.ts; this pins the routes those rows don't take.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunnerCore, type RunnerIo } from "../src/adapters/pi-runner.js";
import type { PiRunnerState, RunnerRuntime } from "../src/adapters/pi-runner-protocol.js";
import { gateLogRecord, seatGateLogPath, SeatGateStore } from "../src/adapters/seat-gate-store.js";

const NONCE = "0123456789abcdef";
const M = { id: "m1", nonce: NONCE };
const marked = (text: string, id = "m1") => `${text}\n[openrig-msg ${id}:${NONCE}]`;

describe.each<RunnerRuntime>(["pi", "omp"])("the gate in RunnerCore, %s", (runtime) => {
  let dir: string;
  let log: string;
  let session: string;
  let rpc: Array<Record<string, unknown>>;
  let lines: string[];
  let sidecars: PiRunnerState[];
  let core: RunnerCore;

  const io = (): RunnerIo => ({
    sendRpc: (cmd) => { rpc.push(cmd); }, mirrorLine: (line) => { lines.push(line); }, mirrorAppend: () => undefined,
    postActivity: () => undefined, writeSidecar: (state) => { sidecars.push(state); }, sessionFileExists: () => true, now: () => "2026-02-03T04:05:06Z",
  });
  const launch = () => {
    core = new RunnerCore(io(), { sessionName: "s", launchId: "l" }, { runtime, gate: SeatGateStore.open(log) });
    core.start();
  };
  const ready = () => core.handlePiLine(JSON.stringify({ type: "response", id: "pi-runner-get-state", data: { sessionFile: session, sessionId: "x" } }));
  const started = (text: string) => core.handlePiLine(JSON.stringify({ type: "message_start", message: { role: "user", content: [{ type: "text", text }] } }));
  const inputs = () => rpc.filter((cmd) => cmd.type !== "get_state" && cmd.type !== "get_entries");
  const seen = () => gateLogRecord(fs.readFileSync(log, "utf8"), M) !== null;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-"));
    log = seatGateLogPath(dir);
    session = path.join(dir, "s.jsonl");
    rpc = []; lines = []; sidecars = [];
    launch();
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("declares the gate on the sidecar", () => {
    ready();
    expect(sidecars.at(-1)?.seatGate).toBe(1);
  });

  it("a marked block waits for the session, then goes through the gate once", () => {
    core.handleUserBlock(marked("early"));
    expect(inputs()).toEqual([]);
    ready();
    expect(inputs()).toMatchObject([{ type: "prompt", message: "early" }]);
  });

  it("an unmarked block does not wait, and carries no RPC id", () => {
    core.handleUserBlock("plain");
    expect(inputs()).toEqual([{ type: "prompt", message: "plain" }]);
  });

  it("the record comes from message_start, not from sending; another user's text records nothing", () => {
    ready();
    core.handleUserBlock(marked("hello"));
    expect(seen()).toBe(false);
    started("someone else");
    expect(seen()).toBe(false);
    started("hello");
    expect(seen()).toBe(true);
  });

  it("a repeat in flight, before message_start, is dropped", () => {
    ready();
    core.handleUserBlock(marked("hello"));
    core.handleUserBlock(marked("hello"));
    expect(inputs()).toHaveLength(1);
    expect(lines.some((line) => line.includes("repeat dropped: m1"))).toBe(true);
  });

  it("mid-turn it steers with the text alone, and /followup keeps its meaning, recorded by the message Pi shows", () => {
    ready();
    core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    core.handleUserBlock(marked("steer me", "m2"));
    core.handleUserBlock(marked("/followup later"));
    expect(inputs()).toMatchObject([{ type: "steer", message: "steer me" }, { type: "follow_up", message: "later" }]);
    started("later");
    expect(seen()).toBe(true);
  });

  it("the pane line holds the text, never the marker", () => {
    ready();
    core.handleUserBlock(marked("hello"));
    expect(lines.join("\n")).not.toContain("openrig-msg");
  });

  it("Pi's `handled` answer is the record: no message_start will come", () => {
    ready();
    core.handleUserBlock(marked("hello"));
    core.handlePiLine(JSON.stringify({ type: "response", id: inputs()[0]!.id, success: true, data: { disposition: "handled" } }));
    expect(seen()).toBe(true);
  });

  it("`started` records nothing by itself", () => {
    ready();
    core.handleUserBlock(marked("hello"));
    core.handlePiLine(JSON.stringify({ type: "response", id: inputs()[0]!.id, success: true, data: { disposition: "started" } }));
    expect(seen()).toBe(false);
  });

  it("a marked /abort is a command: sent, recorded at once, and not repeated", () => {
    ready();
    core.handleUserBlock(marked("/abort"));
    expect(seen()).toBe(true);
    core.handleUserBlock(marked("/abort"));
    expect(rpc.filter((cmd) => cmd.type === "abort")).toHaveLength(1);
  });

  it("a marker with no message reaches nothing", () => {
    ready();
    core.handleUserBlock(`[openrig-msg m1:${NONCE}]`);
    expect(inputs()).toEqual([]);
  });

  it("when the intent can't be made durable nothing is sent, and the pane says so", () => {
    ready();
    fs.mkdirSync(log);
    core.handleUserBlock(marked("hello"));
    expect(inputs()).toEqual([]);
    expect(lines.some((line) => line.includes("NOT sent"))).toBe(true);
  });

  it("a restart settles before READY, against the session file the intent named", () => {
    ready();
    core.handleUserBlock(marked("landed"));
    fs.writeFileSync(session, `${JSON.stringify({ type: "message", message: { role: "user", content: "landed" } })}\n`);
    rpc = []; lines = [];
    launch();
    expect(seen()).toBe(false);
    session = path.join(dir, "another-session.jsonl");
    ready();
    expect(seen()).toBe(true);
    core.handleUserBlock(marked("landed"));
    expect(inputs()).toEqual([]);
  });

  it("a session file it can't read keeps the id in flight and says so", () => {
    session = dir; // a directory: read fails with something other than absence
    ready();
    core.handleUserBlock(marked("x"));
    rpc = []; lines = [];
    launch();
    ready();
    expect(lines.some((line) => line.includes("could not read the session file"))).toBe(true);
    core.handleUserBlock(marked("x"));
    expect(inputs()).toEqual([]);
  });
});
