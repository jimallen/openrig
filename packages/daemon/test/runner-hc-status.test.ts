// hc cutover W37: what the pane-hosted runners tell herdr-core, without a core. Production consequence: a runner seat that
// reports no OSC 7501 stays `reported:false, turn 0` in hc, and then no `rig send` to it can ever be tied to a turn
// (hc-delivery.ts rows 3 and 5), so every Pi send ends `waiting`. The real-core proof is runner-hc-status.real.test.ts.
import { describe, expect, it } from "vitest";
import { RunnerCore, type RunnerIo } from "../src/adapters/pi-runner.js";
import { createRunnerHcStatusSink, hcAppNameForSeat, hcStateForActivity, hcStatusRecord, type RunnerHcState } from "../src/adapters/runner-hc-status.js";
import { makeRig, runEnd, runStart, snapshotEvent } from "./helpers/pda-runner-rig.js";

// Restated here on purpose (not imported from the module): the wire form hc was measured to accept, spike-hc-1-2 section 2.3.
const OSC = (state: string, app: string) => `\u001b]7501;state=${state}:app=${app}\u001b\\`;

describe("the OSC 7501 record", () => {
  it("is ESC ] 7501 ; state=<word> : app=<word> ESC \\, with no key hc would drop the record for", () => {
    expect(hcStatusRecord("working", "pi-runner")).toBe(OSC("working", "pi-runner"));
    expect(hcStatusRecord("idle", "pda-runner")).toBe(OSC("idle", "pda-runner"));
  });
  it.each(["a:b", "a;b", "a b", "", "a\u001b"])("refuses an app name hc would parse differently (%j)", (app) => {
    expect(() => hcStatusRecord("idle", app)).toThrow();
  });
});

// OF-213 (reopened): the Herdr pane header shows hc's detected program, which is the `app` of the last OSC 7501 record. The grammar
// below was measured on a private core (hc 0.1.17, Linux and macOS): letters of either case, digits and . _ + - , at most 32; any other character
// drops the app (the state is kept); 33 or more drops the whole record, so the seat would read reported:false.
describe("the app a seat reports (what the pane header shows)", () => {
  it.each([
    ["verify-qa@eztrack", "verify-qa.eztrack"],
    ["build-arch@eztrack", "build-arch.eztrack"],
    ["d-a@ot", "d-a.ot"],
    ["Verify-QA@EzTrack", "Verify-QA.EzTrack"],
    ["prüfer@team", "pr-fer.team"],
    ["a b/c%d", "a-b-c-d"],
    ["x_y+z.w", "x_y+z.w"],
  ])("names the seat %j as %j", (session, app) => {
    expect(hcAppNameForSeat(session, "pi-runner")).toBe(app);
  });
  it("cuts a long name to 32 characters, keeping its head", () => {
    const app = hcAppNameForSeat("reviewer-security@a-very-long-rig-name-indeed", "pi-runner");
    expect(app).toBe("reviewer-security.a-very-long-ri");
    expect(app).toHaveLength(32);
  });
  it("falls back to the runner's own name when nothing is left", () => {
    expect(hcAppNameForSeat("", "pi-runner")).toBe("pi-runner");
  });
  it("is always a record hc keeps whole: 1-32 of A-Z a-z 0-9 . _ + -", () => {
    for (const session of ["verify-qa@eztrack", "Ünï@çödé", "x".repeat(200), "@", "A".repeat(40) + "@" + "B".repeat(40)]) {
      expect(hcAppNameForSeat(session, "pi-runner")).toMatch(/^[A-Za-z0-9._+-]{1,32}$/);
    }
  });
  it.each(["a@b", "a b", "x".repeat(33), "a/b", "a%b", "prüfer"])("refuses an app hc would drop or take the whole record down for (%j)", (app) => {
    expect(() => hcStatusRecord("idle", app)).toThrow();
  });
  it("accepts an uppercase app (measured: hc keeps it)", () => {
    expect(hcStatusRecord("idle", "Verify-QA.EzTrack")).toBe(OSC("idle", "Verify-QA.EzTrack"));
  });
  it("accepts the longest app", () => {
    expect(hcStatusRecord("idle", "x".repeat(32))).toBe(OSC("idle", "x".repeat(32)));
  });
});

describe("which activity is a state", () => {
  it.each([
    ["active", "working"], ["PreToolUse", "working"], ["Stop", "idle"],
    ["Notification", null], ["SessionStart", null], ["", null],
  ])("%j -> %j", (hookEvent, expected) => {
    expect(hcStateForActivity(hookEvent)).toBe(expected);
  });
});

describe("the sink", () => {
  it("does not exist for a terminal herdr-core does not host (no HC_TERMINAL_ID, or an empty one)", () => {
    expect(createRunnerHcStatusSink({}, () => undefined, "pi-runner")).toBeUndefined();
    expect(createRunnerHcStatusSink({ HC_TERMINAL_ID: "" }, () => undefined, "pi-runner")).toBeUndefined();
    expect(createRunnerHcStatusSink({ TMUX: "/tmp/x,1,0" }, () => undefined, "pi-runner")).toBeUndefined();
  });
  it("writes a state once, and again when it changes", () => {
    const out: string[] = [];
    const sink = createRunnerHcStatusSink({ HC_TERMINAL_ID: "t1" }, (t) => out.push(t), "pi-runner")!;
    for (const s of ["idle", "idle", "working", "working", "idle"] as RunnerHcState[]) sink(s);
    expect(out).toEqual([OSC("idle", "pi-runner"), OSC("working", "pi-runner"), OSC("idle", "pi-runner")]);
  });
  it("survives a pane that throws on write", () => {
    const sink = createRunnerHcStatusSink({ HC_TERMINAL_ID: "t1" }, () => { throw new Error("EPIPE"); }, "pi-runner")!;
    expect(() => sink("idle")).not.toThrow();
  });
});

describe("the Pi runner core", () => {
  const SESSION_FILE = "/state/s.jsonl";
  function pi(runtime: "pi" | "omp" = "pi") {
    // The production sink, writing to a string: the states are read back from the bytes the pane would get.
    const states: string[] = [];
    const sink = createRunnerHcStatusSink({ HC_TERMINAL_ID: "t1" }, (text) => states.push(/state=(\w+)/.exec(text)![1]!), "pi-runner");
    const io: RunnerIo = {
      sendRpc: () => undefined, mirrorLine: () => undefined, mirrorAppend: () => undefined,
      postActivity: () => undefined, writeSidecar: () => undefined, reportHcStatus: sink, now: () => "2026-11-01T10:00:00Z",
    };
    const core = new RunnerCore(io, { sessionName: "s", nodeId: "n", launchId: "l", generation: "g" }, { runtime });
    core.start();
    const feed = (...events: Record<string, unknown>[]) => { for (const e of events) core.handlePiLine(JSON.stringify(e)); };
    const ready = () => feed({ type: "response", id: "pi-runner-get-state", data: { sessionFile: SESSION_FILE, sessionId: "s1" } });
    return { states, feed, ready };
  }

  it("says nothing before Pi is ready, then idle: a seat that has said nothing is silent to hc", () => {
    const r = pi();
    expect(r.states).toEqual([]);
    r.ready();
    expect(r.states).toEqual(["idle"]);
  });
  it("is working from agent_start and idle again at agent_end, once per change", () => {
    const r = pi();
    r.ready();
    r.feed({ type: "agent_start" }, { type: "tool_execution_start", toolName: "bash" }, { type: "agent_end", messages: [], willRetry: false });
    expect(r.states).toEqual(["idle", "working", "idle"]);
  });
  it("a second turn is a second working", () => {
    const r = pi();
    r.ready();
    for (let i = 0; i < 2; i++) r.feed({ type: "agent_start" }, { type: "agent_end", messages: [], willRetry: false });
    expect(r.states).toEqual(["idle", "working", "idle", "working", "idle"]);
  });
  it("a dialog the pane cannot answer keeps the daemon's activity on the notice, but hc still sees the run end", () => {
    const r = pi();
    r.ready();
    r.feed({ type: "agent_start" }, { type: "extension_ui_request", id: "d1", method: "confirm", title: "Allow?" }, { type: "agent_end", messages: [], willRetry: false });
    expect(r.states).toEqual(["idle", "working", "idle"]);
  });
  it("a runner that becomes ready while a turn is open does not claim idle", () => {
    const r = pi();
    r.feed({ type: "agent_start" });
    r.ready();
    expect(r.states).toEqual(["working"]);
  });
  it("QA A2: a compaction outside a run returns the seat to idle at its end (it was left working until the next run)", () => {
    const r = pi();
    r.ready();
    r.feed({ type: "compaction_start" }, { type: "compaction_end" });
    expect(r.states).toEqual(["idle", "working", "idle"]);
  });
  it("QA A2: a compaction inside a run does not end the run: the run's own Stop does", () => {
    const r = pi();
    r.ready();
    r.feed({ type: "agent_start" }, { type: "compaction_start" }, { type: "compaction_end" });
    expect(r.states).toEqual(["idle", "working"]);
    r.feed({ type: "agent_end", messages: [], willRetry: false });
    expect(r.states).toEqual(["idle", "working", "idle"]);
  });
  it("QA A2: OMP's automatic compaction outside a run likewise ends idle", () => {
    const r = pi("omp");
    r.ready();
    r.feed({ type: "auto_compaction_start" }, { type: "auto_compaction_end" });
    expect(r.states).toEqual(["idle", "working", "idle"]);
  });
  it("is not reported when the host has no sink (reportHcStatus absent)", () => {
    const io: RunnerIo = { sendRpc: () => undefined, mirrorLine: () => undefined, mirrorAppend: () => undefined, postActivity: () => undefined, writeSidecar: () => undefined, now: () => "t" };
    const core = new RunnerCore(io, { sessionName: "s" });
    core.start();
    expect(() => core.handlePiLine(JSON.stringify({ type: "agent_start" }))).not.toThrow();
  });
});

describe("the pda runner", () => {
  it("reports idle on attach, working for a run and idle at its end", async () => {
    const states: RunnerHcState[] = [];
    const rig = await makeRig({ reportHcStatus: (s) => states.push(s) });
    try {
      void rig.start();
      const stream = await rig.stream();
      stream.push(snapshotEvent());
      await until(() => states.length >= 1);
      expect(states).toEqual(["idle"]);
      stream.push(runStart());
      await until(() => states.length >= 2);
      expect(states).toEqual(["idle", "working"]);
      stream.push(runEnd());
      await until(() => states.length >= 3);
      expect(states).toEqual(["idle", "working", "idle"]);
    } finally {
      await rig.cleanup();
    }
  });
});

async function until(cond: () => boolean): Promise<void> {
  const end = Date.now() + 5000;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
