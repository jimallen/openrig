// pda runtime L1b (pda-runtime-design-9l Rev 2, "The pda-runner"; rows T5, T5b, T7, T8, T9, T14, T30, T31, T32 on
// the runner side, plus the input wiring, the sidecar, the outbox glue and the process-level handlers).
//
// The rig (test/helpers/pda-runner-rig.ts) runs the REAL runner, client and outbox against L1a's REAL loopback
// fake pda, with only `/events` and `/transcript` scripted. What the scripted layer cannot show is stated in the
// PR body: pda's event field names are the design's vocabulary, not yet measured against a live pda.
import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  PdaRunner, pdaClientRedactions, fatalLabel, installPdaRunnerFatalHandlers, parsePdaRunnerArgv, wirePdaRunnerInput, createActivityPoster,
} from "../src/adapters/pda-runner.js";
import { PdaSseParser } from "../src/adapters/pda-sse.js";
import { PdaPane, PdaRedactor, argsFirstLine, entryView, idText } from "../src/adapters/pda-render.js";
import { buildPdaRunnerArgv, PDA_DEFAULT_BASE_URL } from "../src/adapters/pda-runner-protocol.js";
import { nonAllowlisted } from "./helpers/fake-pda.js";
import {
  BEARER, HOOK_TOKEN, LOOKALIKE, GUESSED_SHAPES, assistantEntry, assistantMessage, autoRetryStart, bareEntry, changesEvent, compactionEnd, compactionEntry, deltaEvent,
  entryAppended, makeRig, messageEnd, messageStart, nestedToolEnd, runEnd, runStart, snapshotEvent, streamEnd, submissionEvent,
  taskFailed, thinkingDeltaEvent, toolEnd, toolResultEntry, toolResultMessage, toolStart, userEntry, userMessage, waitFor, type Rig,
} from "./helpers/pda-runner-rig.js";

const ESC = "\u001b";
const REASSERT = `${ESC}[?2004h`;
/** The pane with the runner's own bracketed-paste re-assertions removed: what is left may hold no escape at all. */
const noReassert = (pane: string): string => pane.split(REASSERT).join("");

let rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs) await r.cleanup();
  rigs = [];
  vi.restoreAllMocks();
});

async function started(options: Parameters<typeof makeRig>[0] = {}): Promise<Rig> {
  const rig = await makeRig(options);
  rigs.push(rig);
  rig.start();
  return rig;
}

/** Start a rig on scripted streams and bring it to READY with the given first snapshot. */
async function attached(options: Parameters<typeof makeRig>[0] = {}, snapshot: Record<string, unknown> = snapshotEvent()) {
  const rig = await started(options);
  const stream = await rig.stream();
  stream.push(snapshot);
  await waitFor(() => rig.pane().includes("READY"), "READY");
  return { rig, stream };
}

const lines = (pane: string): string[] => noReassert(pane).split("\n");

// ── Startup, attach, READY ───────────────────────────────────────────────────

describe("pda-runner: attach (T13 runner side, design 'Reconnect')", () => {
  it("attaches in order (health, agent, events, transcript), prints READY, and writes a ready sidecar", async () => {
    const rig = await started({ realStreams: true });
    await waitFor(() => rig.pane().includes("[pda-runner] READY"), "READY");
    const sidecar = rig.sidecar();
    expect(sidecar).toMatchObject({ ready: true, connected: true, busy: false, outboxPending: 0, agent: "research", launchId: "launch-1" });
    expect(sidecar.exited).toBeUndefined();
    expect(sidecar.error).toBeUndefined();
    expect(rig.fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /health", "GET /agents/research", "GET /agents/research/events", "GET /agents/research/transcript",
    ]);
    expect(nonAllowlisted(rig.fake.requests)).toEqual([]);
    expect(rig.pane()).toContain("[pda-runner] READY agent=research");
  });

  it("a missing agent (404 at attach) exits 3 with code pda_agent_missing, 0 POSTs, and never creates the agent", async () => {
    const rig = await makeRig({ agent: "ghost", agents: ["research"], realStreams: true });
    rigs.push(rig);
    const code = await rig.start();
    expect(code).toBe(3);
    expect(rig.sidecar()).toMatchObject({ ready: false, error: { code: "pda_agent_missing" }, exited: { code: 3 } });
    expect(rig.pane()).toContain("[pda-runner] ERROR pda_agent_missing");
    expect(rig.pane()).toContain("[pda-runner] EXITED code=3");
    expect(rig.fake.requests.filter((r) => r.method !== "GET")).toEqual([]);
    expect(nonAllowlisted(rig.fake.requests)).toEqual([]);
  });

  it("an unreachable pda is retried forever with the error recorded; nothing is posted and the runner does not exit", async () => {
    const rig = await makeRig();
    rigs.push(rig);
    rig.scripted.allDown = true;
    const done = rig.start();
    await waitFor(() => rig.sidecar().error?.code === "pda_unreachable", "pda_unreachable in the sidecar");
    expect(rig.sidecar().ready).toBe(false);
    expect(rig.pane()).toContain("pda unreachable; retrying");
    await new Promise((r) => setTimeout(r, 120)); // many retries later ...
    expect(noReassert(rig.pane()).split("pda unreachable; retrying").length - 1).toBe(1); // ... still one notice a minute
    // It recovers when pda returns.
    rig.scripted.allDown = false;
    const stream = await rig.stream();
    stream.push(snapshotEvent());
    await waitFor(() => rig.sidecar().ready, "ready after recovery");
    expect(rig.sidecar().error).toBeUndefined();
    void done;
  });

  it("a token file that becomes unusable after pda rotated its token: the next re-attach re-reads it and the runner exits 4", async () => {
    const { rig, stream } = await attached();
    rig.fake.setToken("ROTATEDtoken".padEnd(43, "R")); // pda rotated its token ...
    fs.writeFileSync(rig.args.tokenFile, "garbage, not a token"); // ... and the file now holds something else
    stream.error();
    expect(await rig.done).toBe(4);
    expect(rig.pane()).toContain("[pda-runner] ERROR pda_token_format");
    expect(rig.pane()).not.toContain(BEARER);
    expect(rig.sidecar()).toMatchObject({ ready: false, error: { code: "pda_token_format" }, exited: { code: 4 } });
  });

  it("the same while a message is being sent: it stays saved and pending, the pane and sidecar say pda_token_format, and nothing is dropped", async () => {
    const { rig } = await attached();
    rig.fake.setToken("ROTATEDtoken".padEnd(43, "R"));
    fs.writeFileSync(rig.args.tokenFile, "garbage, not a token");
    rig.runner.submit("waits for a usable token");
    await waitFor(() => rig.sidecar().error?.code === "pda_token_format", "pda_token_format in the sidecar");
    expect(rig.pane()).toContain("pda_token_format: the token file is not usable; retrying");
    expect(rig.sidecar().outboxPending).toBe(1);
    expect(rig.outboxRaw()).toContain("waits for a usable token");
    // The operator repairs the file; the saved message goes out under its original id.
    fs.writeFileSync(rig.args.tokenFile, "ROTATEDtoken".padEnd(43, "R"));
    await waitFor(() => rig.fake.entries("research").length === 1, "delivered after the repair");
    expect(rig.fake.entries("research")[0]!.content).toBe("waits for a usable token");
  });

  it("a 401 that survives the token re-read is an error code, not an exit: the runner keeps retrying", async () => {
    const rig = await makeRig({ tokenFileContent: LOOKALIKE }); // valid format, wrong value
    rigs.push(rig);
    rig.start();
    await waitFor(() => rig.sidecar().error?.code === "pda_unauthorized", "pda_unauthorized in the sidecar");
    expect(rig.sidecar().exited).toBeUndefined();
    expect(rig.pane()).not.toContain(LOOKALIKE);
  });
});

// ── T10 / T11 runner side: the token ─────────────────────────────────────────

describe("pda-runner: the token (T10, T11 runner side)", () => {
  it("an interior-LF token file exits 4 with code pda_token_format, the canary is in no output, and pda is never contacted", async () => {
    const rig = await makeRig({ tokenFileContent: `${BEARER}\ntail`, realStreams: true });
    rigs.push(rig);
    const code = await rig.start();
    expect(code).toBe(4);
    expect(rig.pane()).toContain("[pda-runner] ERROR pda_token_format");
    for (const surface of [rig.pane(), rig.sidecarRaw(), rig.outboxRaw()]) expect(surface).not.toContain(BEARER);
    expect(rig.sidecar()).toMatchObject({ error: { code: "pda_token_format" }, exited: { code: 4 } });
    expect(rig.fake.requests).toEqual([]);
  });

  it.each([
    ["a mode 0644 file", { tokenMode: 0o644 }],
    ["an over-long value", { tokenFileContent: "A".repeat(600) }],
    ["a value outside base64url", { tokenFileContent: "has spaces and ! symbols 0123456789" }],
  ])("%s is refused at startup with a code only", async (_name, opts) => {
    const rig = await makeRig({ ...opts, realStreams: true });
    rigs.push(rig);
    expect(await rig.start()).toBe(4);
    expect(rig.fake.requests).toEqual([]);
    expect(rig.pane()).not.toContain("A".repeat(50));
  });

  it("positive control: a valid token is sent as the bearer, and appears in no surface", async () => {
    const rig = await started({ realStreams: true });
    await waitFor(() => rig.pane().includes("READY"), "READY");
    expect(rig.fake.authorizations).toContain(`Bearer ${BEARER}`);
    for (const surface of [rig.pane(), rig.sidecarRaw(), rig.outboxRaw(), JSON.stringify(rig.activity)]) expect(surface).not.toContain(BEARER);
  });
});

// ── Arguments ────────────────────────────────────────────────────────────────

describe("pda-runner: argv", () => {
  const good = buildPdaRunnerArgv({
    sessionName: "seat-1", stateRoot: "/state/pda", launchId: "L9", binding: { agent: "research", baseUrl: PDA_DEFAULT_BASE_URL },
    tokenFile: "/home/x/.pi-durable/token", usageFacts: true,
  });

  it("is the inverse of L0's buildPdaRunnerArgv", () => {
    expect(parsePdaRunnerArgv(good)).toEqual({
      ok: true,
      args: {
        sessionName: "seat-1", stateRoot: "/state/pda", launchId: "L9", binding: { agent: "research", baseUrl: PDA_DEFAULT_BASE_URL },
        tokenFile: "/home/x/.pi-durable/token", usageFacts: true,
      },
    });
    const without = buildPdaRunnerArgv({ sessionName: "s", stateRoot: "/r", launchId: "l", binding: { agent: "a", baseUrl: PDA_DEFAULT_BASE_URL }, tokenFile: "/t" });
    const parsed = parsePdaRunnerArgv(without);
    expect(parsed.ok && parsed.args.usageFacts).toBeFalsy();
  });

  const set = (flag: string, value: string): string[] => {
    const copy = [...good];
    copy[copy.indexOf(flag) + 1] = value;
    return copy;
  };

  it.each([
    ["an unknown flag", [...good, "--token", "SECRETVALUE"]],
    ["a flag with no value", ["--session-name", "s", "--agent"]],
    ["a repeated flag", [...good, "--agent", "other"]],
    ["a missing flag", good.filter((_, i) => i < good.indexOf("--agent") || i > good.indexOf("--agent") + 1)],
    ["agent main (J-1)", set("--agent", "main")],
    ["a bad agent name", set("--agent", "Bad Name")],
    ["localhost", set("--base-url", "http://localhost:8150")],
    ["https", set("--base-url", "https://127.0.0.1:8150")],
    ["a path in the URL", set("--base-url", "http://127.0.0.1:8150/x")],
    ["userinfo", set("--base-url", "http://u:p@127.0.0.1:8150")],
    ["a session name with a slash", set("--session-name", "../escape")],
    ["a dot session name", set("--session-name", "..")],
  ])("refuses %s, and the refusal does not echo the offending value", (_name, argv) => {
    const res = parsePdaRunnerArgv(argv);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("pda_args_invalid");
      for (const value of ["SECRETVALUE", "Bad Name", "localhost", "u:p", "../escape", "other"]) expect(res.reason).not.toContain(value);
    }
  });
});

// ── T7: busy mapping and the order of activity ───────────────────────────────

describe("pda-runner: busy/idle and activity (T7)", () => {
  it("maps run_start/run_end and the snapshot's run to busy, and posts activity in the event order", async () => {
    const { rig, stream } = await attached();
    expect(rig.sidecar()).toMatchObject({ busy: false, connected: true });
    stream.push(runStart());
    await waitFor(() => rig.sidecar().busy, "busy after run_start");
    stream.push({ type: "tool_execution_start", toolName: "bash", toolCallId: "t1", args: { command: "ls" } });
    stream.push(runEnd());
    await waitFor(() => !rig.sidecar().busy, "idle after run_end");
    expect(rig.activity.map((a) => `${a.hookEvent}/${a.subtype}`)).toEqual([
      "Stop/attached_idle", "active/run_start", "PreToolUse/bash", "Stop/run_end",
    ]);
    expect(rig.pane()).toContain("── idle ──");
    // Every post carries the seat's identity and the pda runtime.
    for (const a of rig.activity) expect(a).toMatchObject({ sessionName: "seat-under-test", nodeId: "node-under-test", generation: "gen-7", runtime: "pda" });
  });

  it("a snapshot with a run in flight is busy, posts attached_busy once, and a repeat posts nothing", async () => {
    const { rig, stream } = await attached({}, snapshotEvent({ run: [1] }));
    expect(rig.sidecar().busy).toBe(true);
    stream.push(snapshotEvent({ run: [1] }));
    stream.push(runEnd());
    await waitFor(() => !rig.sidecar().busy, "idle");
    expect(rig.activity.map((a) => `${a.hookEvent}/${a.subtype}`)).toEqual(["active/attached_busy", "Stop/run_end"]);
  });

  it("a lost stream posts Notification/pda_disconnected, and the next snapshot re-asserts the state", async () => {
    const { rig, stream } = await attached();
    stream.error();
    await waitFor(() => rig.activity.some((a) => a.subtype === "pda_disconnected"), "pda_disconnected");
    expect(rig.sidecar().connected).toBe(false);
    expect(rig.sidecar().ready).toBe(true); // readiness is not lost with the connection
    const second = await rig.stream(2);
    second.push(snapshotEvent());
    await waitFor(() => rig.sidecar().connected, "reconnected");
    expect(rig.activity.map((a) => `${a.hookEvent}/${a.subtype}`)).toEqual([
      "Stop/attached_idle", "Notification/pda_disconnected", "Stop/attached_idle",
    ]);
    expect(rig.pane()).toContain("[pda-runner] stream lost; reconnecting");
    expect(rig.pane()).toContain("[pda-runner] reconnected");
  });

  it("nested tool calls and unknown events render nothing and post nothing", async () => {
    const { rig, stream } = await attached();
    stream.push(toolStart("t1/k", "inner", {}, "t1"));
    stream.push(nestedToolEnd("t1/k", "inner", "t1", "NESTEDOUTPUT"));
    const quiet = rig.pane();
    stream.push({ type: "something_new_in_pda_1_4" });
    stream.raw("data: not json at all\n\n");
    stream.raw(": keep-alive\n\n");
    await new Promise((r) => setTimeout(r, 40));
    expect(rig.pane()).toBe(quiet); // an ignored event writes nothing, not even a bracketed-paste re-assertion
    stream.push(runStart());
    await waitFor(() => rig.sidecar().busy, "run_start after the noise");
    expect(rig.pane()).not.toContain("inner");
    expect(rig.pane()).not.toContain("NESTEDOUTPUT");
    expect(rig.activity.map((a) => a.subtype)).toEqual(["attached_idle", "run_start"]);
  });
});

// ── T8: reconnect after a pda restart ────────────────────────────────────────

describe("pda-runner: reconnect (T8)", () => {
  it("after the stream dies mid-run and pda restarts, entries are rendered once, in order, from the cursor", async () => {
    const rig = await started();
    rig.scripted.transcript = [userEntry(103, "first question"), assistantEntry(100, "first answer")];
    const s1 = await rig.stream();
    s1.push(snapshotEvent());
    await waitFor(() => rig.pane().includes("READY"), "READY");
    expect(rig.pane()).toContain("other ▸ first question");
    expect(rig.pane()).toContain("first answer");
    // A live reply, streamed and finished.
    s1.push(runStart());
    s1.push(deltaEvent("second "));
    s1.push(deltaEvent("answer"));
    s1.push({ type: "message_end", entry: assistantEntry(101, "second answer") });
    await waitFor(() => rig.sidecar().lastEntryId === "101", "cursor e3");
    // pda restarts: the stream dies, pda is down for a while, and e4 is produced meanwhile.
    rig.scripted.eventsDown = true;
    s1.error();
    await waitFor(() => !rig.sidecar().connected, "disconnected");
    rig.scripted.transcript = [
      userEntry(103, "first question"), assistantEntry(100, "first answer"),
      assistantEntry(101, "second answer"), assistantEntry(102, "answer given while the runner was away"),
    ];
    rig.scripted.eventsDown = false;
    const s2 = await rig.stream(2);
    s2.push(snapshotEvent());
    await waitFor(() => rig.sidecar().connected && rig.sidecar().lastEntryId === "102", "caught up to e4");
    const pane = noReassert(rig.pane());
    for (const [text, expected] of [["first question", 1], ["first answer", 1], ["second answer", 1], ["answer given while the runner was away", 1]] as const) {
      expect(pane.split(text).length - 1, `'${text}' appears ${expected} time(s)`).toBe(expected);
    }
    expect(pane.indexOf("first answer")).toBeLessThan(pane.indexOf("second answer"));
    expect(pane.indexOf("second answer")).toBeLessThan(pane.indexOf("answer given while"));
    // The reconnect fetched the narrow window and found the cursor in it.
    expect(rig.scripted.transcriptLimits).toEqual([50, 50]);
  });

  it("when the cursor is not in the newest 50 it looks at 500 and renders only what is newer than the cursor", async () => {
    const rig = await makeRig();
    rigs.push(rig);
    fs_writeSidecar(rig, "1010");
    rig.scripted.transcript = Array.from({ length: 80 }, (_, i) => assistantEntry(1000 + i, `reply ${i}.`));
    rig.start();
    const s = await rig.stream();
    s.push(snapshotEvent());
    await waitFor(() => rig.pane().includes("READY"), "READY");
    expect(rig.scripted.transcriptLimits).toEqual([50, 500]);
    expect(rig.pane()).toContain("reply 11.");
    expect(rig.pane()).toContain("reply 79.");
    expect(rig.pane()).not.toContain("reply 10.");
    expect(rig.pane()).not.toContain("(gap:");
    expect(rig.sidecar().lastEntryId).toBe("1079");
  });

  it("a prior launch's cursor (same binding) means only newer entries are rendered after a runner restart", async () => {
    const rig = await makeRig();
    rigs.push(rig);
    fs_writeSidecar(rig, "100");
    rig.scripted.transcript = [assistantEntry(103, "old one"), assistantEntry(100, "old two"), assistantEntry(101, "new three")];
    rig.start();
    const s = await rig.stream();
    s.push(snapshotEvent());
    await waitFor(() => rig.pane().includes("READY"), "READY");
    expect(rig.pane()).toContain("new three");
    expect(rig.pane()).not.toContain("old one");
    expect(rig.pane()).not.toContain("old two");
    expect(rig.pane()).not.toContain("showing the newest");
  });

  it("a cursor that is nowhere in 500 entries prints the gap marker and the newest 20", async () => {
    const rig = await makeRig();
    rigs.push(rig);
    fs_writeSidecar(rig, "999999");
    rig.scripted.transcript = Array.from({ length: 60 }, (_, i) => assistantEntry(2000 + i, `message ${i}.`));
    rig.start();
    const s = await rig.stream();
    s.push(snapshotEvent());
    await waitFor(() => rig.pane().includes("READY"), "READY");
    expect(rig.pane()).toContain("(gap: entries before these were not retrieved) showing the newest 20");
    expect(rig.pane()).toContain("message 59.");
    expect(rig.pane()).toContain("message 40.");
    expect(rig.pane()).not.toContain("message 39.");
    expect(rig.scripted.transcriptLimits).toEqual([50, 500]);
  });

  it("a stream_end event leaves the stream and reconnects", async () => {
    const { rig, stream } = await attached();
    stream.push({ type: "stream_end" });
    const second = await rig.stream(2);
    expect(rig.scripted.streams[0]!.closedByClient).toBe(true);
    second.push(snapshotEvent());
    await waitFor(() => rig.pane().includes("reconnected"), "reconnected");
  });

  it("a malformed snapshot (run is not an object) is pda_protocol: no READY, the stream is dropped, and it retries", async () => {
    const rig = await started();
    const s = await rig.stream();
    s.push({ type: "snapshot", run: 5 });
    await waitFor(() => rig.sidecar().error?.code === "pda_protocol", "pda_protocol");
    expect(rig.sidecar().ready).toBe(false);
    expect(rig.pane()).not.toContain("READY");
    await rig.stream(2);
  });
});

function fs_writeSidecar(rig: Rig, lastEntryId: string): void {
  fs.writeFileSync(rig.paths.runnerStatePath, JSON.stringify({
    ready: true, launchId: "previous-launch", updatedAt: "2026-01-01T00:00:00.000Z", aliveAt: "2026-01-01T00:00:00.000Z",
    agent: rig.args.agent, baseUrl: rig.args.baseUrl, connected: true, busy: false, outboxPending: 0, lastEntryId,
  }), { mode: 0o600 });
}

// ── T9: a resync without a reconnect, and in the middle of a message ─────────

describe("pda-runner: snapshot resync (T9)", () => {
  const FULL = "The quick brown fox jumps over the lazy dog, then it rests.";

  it("an overflow snapshot without a reconnect fills the gap once and does not duplicate what the stream already showed", async () => {
    const { rig, stream } = await attached();
    rig.scripted.transcript = [userEntry(123, "question typed in pda chat")];
    stream.push(snapshotEvent()); // the server overflowed: a fresh snapshot, same connection
    await waitFor(() => rig.pane().includes("other ▸ question typed in pda chat"), "gap-filled entry");
    stream.push(messageEnd(userEntry(123, "question typed in pda chat"))); // the same entry again, live: shown once
    stream.push(runStart());
    await waitFor(() => rig.sidecar().busy, "later events still processed");
    expect(rig.scripted.streams).toHaveLength(1); // no reconnect
    expect(noReassert(rig.pane()).split("question typed in pda chat").length - 1).toBe(1);
    expect(rig.scripted.transcriptLimits).toEqual([50, 50]); // the resync ran
  });

  it("a resync in the middle of a message: the reply is printed again in full after the marker, and the pane holds all of it", async () => {
    const { rig, stream } = await attached();
    stream.push(runStart());
    stream.push(deltaEvent("The quick "));
    // Deltas "brown fox jumps over " were lost in the overflow; a fresh snapshot arrives with the run still going.
    stream.push(snapshotEvent({ run: [1] }));
    stream.push(deltaEvent("the lazy dog, then it rests."));
    stream.push({ type: "message_end", entry: assistantEntry(104, FULL) });
    await waitFor(() => rig.sidecar().lastEntryId === "104", "message_end processed");
    const pane = noReassert(rig.pane());
    const marker = pane.indexOf("[pda-runner] (reply resent in full after resync)");
    expect(marker).toBeGreaterThan(-1);
    expect(pane.slice(marker)).toContain(FULL); // the whole reply, after the marker
    expect(pane.slice(0, marker)).not.toContain("brown fox"); // before it, the deltas lost in the overflow were never shown: only fragments
  });

  it("a snapshot taken while a run is in flight marks the next reply dirty even if its first deltas were lost before the snapshot", async () => {
    const { rig, stream } = await attached();
    stream.push(runStart());
    // The first half of the reply was lost in an overflow; the snapshot says a run is in flight; the tail streams.
    stream.push(snapshotEvent({ run: [1] }));
    stream.push(deltaEvent("...and the end of it."));
    stream.push({ type: "message_end", entry: assistantEntry(105, "Here is the beginning ...and the end of it.") });
    await waitFor(() => rig.sidecar().lastEntryId === "105", "message_end processed");
    const pane = noReassert(rig.pane());
    expect(pane).toContain("(reply resent in full after resync)");
    expect(pane).toContain("Here is the beginning ...and the end of it.");
  });

  it("when the gap fill itself already holds the finished reply, it is printed once more at most, never twice from the transcript and the event", async () => {
    const { rig, stream } = await attached();
    stream.push(runStart());
    stream.push(deltaEvent("Partial reply "));
    rig.scripted.transcript = [assistantEntry(106, "Partial reply, now complete.")];
    stream.push(snapshotEvent());
    await waitFor(() => rig.pane().includes("now complete"), "gap fill printed the finished reply");
    stream.push({ type: "message_end", entry: assistantEntry(106, "Partial reply, now complete.") });
    stream.push(runEnd());
    await waitFor(() => rig.pane().includes("── idle ──"), "run_end");
    const pane = noReassert(rig.pane());
    expect(pane.split("now complete").length - 1).toBe(1);
    expect(pane).toContain("(reply resent in full after resync)");
  });

  it("an entry the gap fill printed whole is not printed again when its message_end arrives later with no deltas seen", async () => {
    const { rig, stream } = await attached();
    stream.push(runStart());
    rig.scripted.transcript = [assistantEntry(107, "finished while we were resyncing")];
    stream.push(snapshotEvent());
    await waitFor(() => rig.pane().includes("finished while we were resyncing"), "gap fill");
    stream.push({ type: "message_end", entry: assistantEntry(107, "finished while we were resyncing") });
    stream.push(runEnd());
    await waitFor(() => rig.pane().includes("── idle ──"), "run_end");
    expect(noReassert(rig.pane()).split("finished while we were resyncing").length - 1).toBe(1);
  });

  it("a run that ends without a reply does not leave the next reply marked for a resend", async () => {
    const { rig, stream } = await attached({}, snapshotEvent({ run: [1] })); // a snapshot with a run in flight
    stream.push(runEnd()); // aborted: no message_end ever came
    stream.push(runStart());
    stream.push(deltaEvent("a fresh reply"));
    stream.push({ type: "message_end", entry: assistantEntry(108, "a fresh reply") });
    await waitFor(() => rig.sidecar().lastEntryId === "108", "message_end");
    expect(rig.pane()).not.toContain("resent");
    expect(noReassert(rig.pane()).split("a fresh reply").length - 1).toBe(1);
  });

  it("without a resync, a streamed reply is NOT printed a second time at message_end", async () => {
    const { rig, stream } = await attached();
    stream.push(runStart());
    stream.push(deltaEvent("streamed once "));
    stream.push(deltaEvent("only"));
    stream.push({ type: "message_end", entry: assistantEntry(109, "streamed once only") });
    await waitFor(() => rig.sidecar().lastEntryId === "109", "message_end");
    expect(noReassert(rig.pane()).split("streamed once only").length - 1).toBe(1);
    expect(rig.pane()).not.toContain("resent");
  });

  it("a reply that arrived with no deltas at all is printed whole at message_end", async () => {
    const { rig, stream } = await attached();
    stream.push({ type: "message_end", entry: assistantEntry(110, "never streamed") });
    await waitFor(() => rig.pane().includes("never streamed"), "printed whole");
  });
});

// ── T14: full output ─────────────────────────────────────────────────────────

describe("pda-runner: full output (T14, Jim's J-2)", () => {
  it("a 300-line tool result and a long assistant reply appear in full", async () => {
    const { rig, stream } = await attached();
    const output = Array.from({ length: 300 }, (_, i) => `line ${i} of the build log`).join("\n");
    const reply = "word ".repeat(8000).trim(); // 39,999 characters, no newline
    stream.push(runStart());
    stream.push({ type: "tool_execution_start", toolName: "bash", toolCallId: "c1", args: { command: "make" } });
    stream.push(toolEnd("c1", "bash", toolResultEntry(501, "c1", output)));
    stream.push(deltaEvent(reply));
    stream.push({ type: "message_end", entry: assistantEntry(111, reply) });
    await waitFor(() => rig.sidecar().lastEntryId === "111", "done");
    const pane = noReassert(rig.pane());
    for (let i = 0; i < 300; i++) expect(pane).toContain(`  │ line ${i} of the build log\n`);
    expect(pane).toContain(`  ⚙ bash: {"command":"make"}`);
    expect(pane).toContain(reply);
  });

  it("a tool call's arguments show their first line, at most 160 characters; the output is not capped by that", async () => {
    const { rig, stream } = await attached();
    stream.push({ type: "tool_execution_start", toolName: "bash", toolCallId: "g1", args: { command: "x".repeat(500) } });
    stream.push({ type: "tool_execution_start", toolName: "write", toolCallId: "g2", args: "first line\nsecond line SHOULD-NOT-SHOW" });
    stream.push(runStart());
    await waitFor(() => rig.sidecar().busy, "processed");
    const line = noReassert(rig.pane()).split("\n").find((l) => l.startsWith("  ⚙ bash: "))!;
    expect(line.length).toBe("  ⚙ bash: ".length + 160);
    expect(rig.pane()).toContain("  ⚙ write: first line\n");
    expect(rig.pane()).not.toContain("SHOULD-NOT-SHOW");
  });

  it("an error result is marked, and an empty one says so; thinking is never shown", async () => {
    const { rig, stream } = await attached();
    stream.push(toolEnd("c2", "bash", toolResultEntry(502, "c2", "boom\nsecond line", true)));
    stream.push(toolEnd("c3", "bash", toolResultEntry(503, "c3", "")));
    stream.push(thinkingDeltaEvent("THINKING DELTA SECRET"));
    stream.push({ type: "message_end", entry: { id: 128, kind: "pi.assistant", model: [{ role: "assistant", content: [
      { type: "thinking", thinking: "SECRET INNER MONOLOGUE" }, { type: "text", text: "visible" }] }] } });
    await waitFor(() => rig.sidecar().lastEntryId === "128", "done");
    const pane = noReassert(rig.pane());
    expect(pane).toContain("  ✗ boom\n  ✗ second line\n");
    expect(pane).toContain("  │ (no output)\n");
    expect(pane).toContain("visible");
    expect(pane).not.toContain("SECRET INNER MONOLOGUE");
    expect(pane).not.toContain("THINKING DELTA SECRET");
  });

  it("a tool result is rendered once whether it arrives live or in a gap fill", async () => {
    const { rig, stream } = await attached();
    stream.push(toolEnd("dup1", "bash", toolResultEntry(504, "dup1", "only-once-output")));
    await waitFor(() => rig.pane().includes("only-once-output"), "live");
    rig.scripted.transcript = [toolResultEntry(112, "dup1", "only-once-output")];
    stream.push(snapshotEvent());
    await waitFor(() => rig.scripted.transcriptLimits.length >= 2, "resync");
    stream.push(runStart());
    await waitFor(() => rig.sidecar().busy, "after resync");
    expect(noReassert(rig.pane()).split("only-once-output").length - 1).toBe(1);
  });
});

// ── T30: sanitiser, runner side ──────────────────────────────────────────────

describe("pda-runner: no control sequence reaches the pane (T30)", () => {
  const HOSTILE = [
    `turn bracketed paste off ${ESC}[?2004l and`,
    `clipboard ${ESC}]52;c;ZXZpbA==\u0007 write and`,
    `bell \u0007 and C1 CSI \u009b31m red and CR\rback and a lone ${ESC} escape and bidi ‮ reversed`,
    "and ETX \u0003 done",
  ].join("\n");

  const forbidden = (pane: string): string[] => {
    const bare = noReassert(pane);
    return [ESC, "\u0007", "\r", "\u009b", "‮", "\u0003"].filter((c) => bare.includes(c));
  };

  it("assistant text (streamed and in the final entry) and tool output are stripped; the text around survives", async () => {
    const { rig, stream } = await attached();
    stream.push(toolEnd("h1", "bash", toolResultEntry(505, "h1", HOSTILE)));
    stream.push(deltaEvent(HOSTILE));
    stream.push({ type: "message_end", entry: assistantEntry(113, HOSTILE) });
    await waitFor(() => rig.sidecar().lastEntryId === "113", "done");
    expect(forbidden(rig.pane())).toEqual([]);
    const pane = noReassert(rig.pane());
    for (const kept of ["turn bracketed paste off", "clipboard", "write and", "red and CRback and a lone", "bidi", "reversed", "and ETX", "done"]) {
      // once in the tool output (prefixed) and once in the streamed reply
      expect(pane.split(kept).length - 1, kept).toBeGreaterThanOrEqual(2);
    }
    expect(rig.pane().endsWith(REASSERT)).toBe(true);
  });

  it("the same is true of a gap-filled entry, a user line from another client, the tool name and its arguments, and pda's own strings", async () => {
    const { rig, stream } = await attached();
    rig.scripted.transcript = [
      userEntry(124, HOSTILE),
      { id: 129, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "toolCall", name: `ba${ESC}[2Jsh`, arguments: { command: `echo ${ESC}[?2004l` } }, { type: "text", text: HOSTILE }] }] },
      toolResultEntry(114, "tc1", HOSTILE),
    ];
    stream.push(snapshotEvent());
    stream.push({ type: "tool_execution_start", toolName: `to${ESC}]52;c;AAAA\u0007ol`, toolCallId: "h2", args: { x: `${ESC}[?2004l` } });
    stream.push(taskFailed(`failed ${ESC}[?2004l here`));
    stream.push(runStart());
    await waitFor(() => rig.sidecar().busy && rig.pane().includes("task failed"), "all processed");
    expect(forbidden(rig.pane())).toEqual([]);
    expect(noReassert(rig.pane())).toContain('  ⚙ bash: {"command":"echo \\u001b[?2004l"}'); // the gap-filled call: name sanitised; JSON escapes the ESC in its arguments to inert text
    expect(rig.activity.map((a) => String(a.subtype))).toContain("tool"); // the tool name was sanitised before it left the process
    expect(JSON.stringify(rig.activity)).not.toContain(ESC);
  });

  it("the runner re-asserts bracketed paste after an output batch, and writes no other escape itself", async () => {
    const { rig, stream } = await attached();
    const before = rig.pane().length;
    stream.push(toolEnd("ra1", "bash", toolResultEntry(506, "ra1", "plain")));
    await waitFor(() => rig.pane().length > before && rig.pane().includes("plain"), "batch written");
    expect(rig.pane().endsWith(`  │ plain\n${REASSERT}`)).toBe(true);
    expect(forbidden(rig.pane())).toEqual([]);
  });
});

// ── T31: exact-value redaction ───────────────────────────────────────────────

describe("pda-runner: exact-value redaction (T31)", () => {
  it("the bearer and the hook token in tool output, assistant text and a final entry are replaced by their markers", async () => {
    const { rig, stream } = await attached();
    const leak = `key ${BEARER} and hook ${HOOK_TOKEN} end`;
    stream.push(toolEnd("k1", "bash", toolResultEntry(507, "k1", leak)));
    stream.push({ type: "message_end", entry: assistantEntry(115, leak) });
    await waitFor(() => rig.sidecar().lastEntryId === "115", "done");
    const pane = rig.pane();
    expect(pane).not.toContain(BEARER);
    expect(pane).not.toContain(HOOK_TOKEN);
    expect(pane).toContain("  │ key [redacted:pda-token] and hook [redacted:openrig-hook-token] end");
  });

  it("a secret with a terminal sequence spliced through it is still caught: redaction runs AFTER sanitising", async () => {
    const { rig, stream } = await attached();
    const spliced = `${BEARER.slice(0, 10)}${ESC}[0m${BEARER.slice(10, 30)}\u0007${BEARER.slice(30)}`;
    stream.push(toolEnd("sp1", "bash", toolResultEntry(508, "sp1", `spliced: ${spliced}`)));
    stream.push(taskFailed(`failed: ${spliced}`));
    stream.push({ type: "message_end", entry: assistantEntry(116, `reply: ${spliced}`) });
    await waitFor(() => rig.sidecar().lastEntryId === "116", "done");
    const pane = noReassert(rig.pane());
    expect(pane).toContain("[pda-runner] task failed (pi.generation): failed: [redacted:pda-token]\n"); // a single-line string (line()), not only block bodies
    expect(pane).toContain("  │ spliced: [redacted:pda-token]\n");
    expect(pane).toContain("reply: [redacted:pda-token]\n");
    expect(pane).not.toContain(BEARER.slice(0, 10));
  });

  it("a secret split across two text_deltas is still caught, and the text around it is preserved in order", async () => {
    const { rig, stream } = await attached();
    for (const at of [1, 7, 20, BEARER.length - 1]) {
      stream.push(deltaEvent(`before-${at} ${BEARER.slice(0, at)}`));
      stream.push(deltaEvent(`${BEARER.slice(at)} after-${at}\n`));
    }
    stream.push(deltaEvent(`${HOOK_TOKEN.slice(0, 5)}`));
    stream.push(deltaEvent(`${HOOK_TOKEN.slice(5)} tail`));
    stream.push({ type: "message_end", entry: assistantEntry(117, "irrelevant") });
    await waitFor(() => rig.sidecar().lastEntryId === "117", "done");
    const pane = noReassert(rig.pane());
    expect(pane).not.toContain(BEARER);
    for (const at of [1, 7, 20, BEARER.length - 1]) expect(pane).toContain(`before-${at} [redacted:pda-token] after-${at}\n`);
    expect(pane).toContain("[redacted:openrig-hook-token] tail");
    expect(pane).not.toContain(HOOK_TOKEN);
  });

  it("a partial secret at the very end of a message is flushed as ordinary text when the message ends", async () => {
    const { rig, stream } = await attached();
    stream.push(deltaEvent(`ends with a prefix ${BEARER.slice(0, 10)}`));
    stream.push({ type: "message_end", entry: assistantEntry(118, "x") });
    await waitFor(() => rig.sidecar().lastEntryId === "118", "done");
    expect(noReassert(rig.pane())).toContain(`ends with a prefix ${BEARER.slice(0, 10)}\n`);
  });

  it("control: a DIFFERENT 43-character base64url string is not redacted (nothing else is pattern-redacted)", async () => {
    const { rig, stream } = await attached();
    stream.push(toolEnd("l1", "bash", toolResultEntry(509, "l1", `looks like a token: ${LOOKALIKE}`)));
    stream.push(deltaEvent(`and ${LOOKALIKE}\n`));
    stream.push({ type: "message_end", entry: assistantEntry(119, "x") });
    await waitFor(() => rig.sidecar().lastEntryId === "119", "done");
    expect(LOOKALIKE).toHaveLength(BEARER.length);
    expect(LOOKALIKE).not.toBe(BEARER);
    expect(noReassert(rig.pane())).toContain(`  │ looks like a token: ${LOOKALIKE}\n`);
    expect(noReassert(rig.pane())).toContain(`and ${LOOKALIKE}\n`);
  });

  it("the redactor and the pane, directly: marker text is not re-scanned into a secret, and surrogate pairs are never cut", () => {
    const secrets = [{ value: "SECRETVALUE0123456", marker: "[M]" }];
    const out: string[] = [];
    const pane = new PdaPane((t) => out.push(t), () => secrets);
    pane.append("😀😀😀SECRETVALUE0123456😀 SECRETVALUE");
    pane.append("0123456");
    pane.closeLine();
    expect(out.join("")).toBe("😀😀😀[M]😀 [M]\n");
    // Every chunk the pane emits is well-formed UTF-16, wherever the hold-back boundary falls.
    for (const hold of ["abc", "abcdef"]) {
      const chunks: string[] = [];
      const p2 = new PdaPane((t) => chunks.push(t), () => [{ value: hold, marker: "[M]" }]);
      for (const piece of ["😀", "x😀😀", "😀y😀", "😀😀😀"]) p2.append(piece);
      p2.closeLine();
      for (const c of chunks) expect(c.isWellFormed(), JSON.stringify(c)).toBe(true);
      expect(chunks.join("")).toBe("😀x😀😀😀y😀😀😀😀\n");
    }
    expect(new PdaRedactor(() => [{ value: "", marker: "[M]" }]).redact("anything")).toBe("anything");
  });
});

// ── T32: where tool output never goes ────────────────────────────────────────

describe("pda-runner: tool output stays in the pane (T32)", () => {
  it("a canary in tool output is in the pane and absent from the sidecar, outbox, own-submissions, and every activity payload", async () => {
    const { rig, stream } = await attached();
    const CANARY_OUT = "TOOLOUTPUT-CANARY-9f3a1c";
    const CANARY_ARGS = "ARGS-CANARY-77be02";
    stream.push(runStart());
    stream.push({ type: "tool_execution_start", toolName: "bash", toolCallId: "z1", args: { command: `echo ${CANARY_ARGS}` } });
    stream.push(toolEnd("z1", "bash", toolResultEntry(510, "z1", `${CANARY_OUT}\nmore`)));
    stream.push({ type: "message_end", entry: assistantEntry(120, `the answer mentions ${CANARY_OUT}`) });
    stream.push(runEnd());
    await waitFor(() => !rig.sidecar().busy && rig.pane().includes("── idle ──"), "run finished");
    expect(rig.pane()).toContain(CANARY_OUT);
    for (const canary of [CANARY_OUT, CANARY_ARGS]) {
      for (const [name, surface] of [
        ["sidecar", rig.sidecarRaw()], ["outbox", rig.outboxRaw()], ["own-submissions", rig.ownSubmissionsRaw()], ["activity", JSON.stringify(rig.activity)],
      ] as const) expect(surface, `${canary} in ${name}`).not.toContain(canary);
    }
    // The activity names the tool, not its arguments.
    expect(rig.activity.find((a) => a.hookEvent === "PreToolUse")).toMatchObject({ subtype: "bash" });
  });

  it("the sidecar carries codes and counts only: its keys are exactly the L0 set", async () => {
    const { rig } = await attached();
    const allowed = new Set(["ready", "launchId", "updatedAt", "aliveAt", "agent", "baseUrl", "connected", "busy", "lastEntryId", "outboxPending", "held", "setAside", "usage", "error", "exited"]);
    for (const key of Object.keys(rig.sidecar())) expect(allowed.has(key), key).toBe(true);
  });
});

// ── Input: one paste, one message; Ctrl-C; no slash commands ─────────────────

function terminal(runner: PdaRunner) {
  const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: false,
    setRawMode: vi.fn(function (this: { isRaw: boolean }, value: boolean) { this.isRaw = value; }) });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
  let screen = "";
  output.on("data", (c) => { screen += c.toString(); });
  const editor = wirePdaRunnerInput(runner, input as unknown as NodeJS.ReadStream, output as unknown as NodeJS.WriteStream);
  return { input, editor, screen: () => screen };
}

const START = "\u001b[200~";
const END = "\u001b[201~";
const ETX = "\u0003";

describe("pda-runner: input (T1, T2, T5, T5b wiring)", () => {
  it("one bracketed paste plus Enter is ONE message: one POST, content byte-equal, LF kept", async () => {
    const { rig } = await attached({ realStreams: false });
    const t = terminal(rig.runner);
    try {
      const body = "From: a\nTo: b\n---\nline one\nline two";
      t.input.write(START + body + END + "\r");
      await waitFor(() => rig.fake.entries("research").length === 1, "one entry");
      expect(rig.fake.entries("research")[0]!.content).toBe(body);
      expect(rig.fake.postBodies).toHaveLength(1);
      expect(rig.pane()).toContain("you ▸ From: a\n      To: b\n");
    } finally { t.editor.close(); }
  });

  it("the echo of a large paste is capped on the pane; the whole message is still what is sent", async () => {
    const { rig } = await attached();
    const big = `${"y".repeat(5000)}END`;
    rig.runner.submit(big);
    await waitFor(() => rig.fake.entries("research").length === 1, "sent");
    expect(rig.fake.entries("research")[0]!.content).toBe(big);
    const pane = noReassert(rig.pane());
    expect(pane).toContain(`you ▸ ${"y".repeat(4000)} … (1003 more characters)\n`);
    expect(pane).not.toContain("END");
  });

  it("T5: Ctrl-C clears the line, posts nothing, and says Ctrl-C never stops the agent", async () => {
    const { rig } = await attached();
    const t = terminal(rig.runner);
    try {
      t.input.write("half typed");
      t.input.write(ETX);
      await waitFor(() => rig.pane().includes("input cleared (Ctrl-C never stops the agent)"), "interrupt notice");
      expect(rig.fake.postBodies).toEqual([]);
      expect(nonAllowlisted(rig.fake.requests)).toEqual([]);
      // The cleared text is not sent by a later Enter.
      t.input.write("next\r");
      await waitFor(() => rig.fake.entries("research").length === 1, "next message");
      expect(rig.fake.entries("research")[0]!.content).toBe("next");
    } finally { t.editor.close(); }
  });

  it("T5b: an ETX inside a paste is content: one POST whose content holds the byte; control without it is also one POST", async () => {
    const { rig } = await attached();
    const t = terminal(rig.runner);
    try {
      t.input.write(START + "one" + ETX + "\nline two" + END + "\r");
      await waitFor(() => rig.fake.entries("research").length === 1, "one entry");
      expect(rig.fake.entries("research")[0]!.content).toBe("one" + ETX + "\nline two");
      t.input.write(START + "plain\nbody" + END + "\r");
      await waitFor(() => rig.fake.entries("research").length === 2, "second entry");
      expect(rig.fake.entries("research")[1]!.content).toBe("plain\nbody");
      expect(rig.fake.postBodies).toHaveLength(2);
    } finally { t.editor.close(); }
  });

  it("T2: slash and bang lines are content: posted as followUp text, and no route outside the five is ever requested", async () => {
    const { rig } = await attached();
    const t = terminal(rig.runner);
    try {
      const lines = ["/abort", "/reset", "/compact", "!rm -rf x", "/quit"];
      for (const l of lines) t.input.write(l + "\r");
      await waitFor(() => rig.fake.entries("research").length === lines.length, "all five posted");
      expect(rig.fake.entries("research").map((e) => e.content)).toEqual(lines);
      for (const body of rig.fake.postBodies) expect(JSON.parse(body).mode).toBe("followUp");
      expect(nonAllowlisted(rig.fake.requests)).toEqual([]);
    } finally { t.editor.close(); }
  });

  it("a message too large for pda is refused with a pane line and nothing is written to the outbox", async () => {
    const { rig } = await attached();
    rig.runner.submit("x".repeat(1_048_576));
    await waitFor(() => rig.pane().includes("too large for pda"), "refusal");
    expect(rig.outboxRaw()).toBe("");
    expect(rig.fake.postBodies).toEqual([]);
  });
});

// ── The outbox glue: ack, own-submissions, held, release ─────────────────────

describe("pda-runner: the outbox glue", () => {
  it("an ack is echoed, recorded in own-submissions.json, and the sidecar's outboxPending returns to 0", async () => {
    const { rig } = await attached();
    rig.runner.submit("hello pda");
    await waitFor(() => rig.pane().includes("queued (submission 1)"), "ack echo"); // pda's id is the number 1
    expect(JSON.parse(rig.ownSubmissionsRaw())).toEqual({ version: 1, ids: ["1"], entries: [] });
    await waitFor(() => rig.sidecar().outboxPending === 0, "pending 0");
    expect(rig.fake.entries("research")).toHaveLength(1);
    expect(fs.statSync(rig.paths.ownSubmissionsPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(rig.paths.runnerStatePath).mode & 0o777).toBe(0o600);
  });

  it("own-submissions.json keeps the newest 500 ids, from acks and from own submission events", async () => {
    const { rig, stream } = await attached();
    for (let i = 0; i < 520; i++) stream.push(submissionEvent({ id: 3000 + i, requestId: `openrig/node-under-test/launch-1/${i}`, status: "queued" }));
    stream.push(submissionEvent({ id: 9999, requestId: "someone-else/1", status: "queued" }));
    stream.push(runStart());
    await waitFor(() => rig.sidecar().busy, "all processed");
    const ids = JSON.parse(rig.ownSubmissionsRaw()).ids as string[];
    expect(ids).toHaveLength(500);
    expect(ids[0]).toBe("3020"); // pda's ids are numbers; the file holds them as text
    expect(ids[499]).toBe("3519");
    expect(ids).not.toContain("9999");
  });

  it("an unanswered own submission is reported; a foreign one is not", async () => {
    const { rig, stream } = await attached();
    stream.push(submissionEvent({ id: 41, requestId: "foreign/1", status: "unanswered", reason: "x" }));
    stream.push(submissionEvent({ id: 42, requestId: "openrig/node-under-test/launch-1/9", status: "unanswered", reason: "agent was reset" }));
    stream.push(runStart());
    await waitFor(() => rig.sidecar().busy, "processed");
    expect(rig.pane()).toContain("[pda-runner] not answered: agent was reset");
    expect(noReassert(rig.pane()).split("not answered").length - 1).toBe(1);
  });

  it("M3/M5: a user message arrives as message_end; this seat's own is recognised through the submission record that names its entry, another client's is shown", async () => {
    const { rig, stream } = await attached();
    // One batch, in pda's order (events.js:205-222, then :263-264): the entries, then their submissions.
    stream.push(messageStart(userMessage("OWN TEXT")));
    stream.push(messageEnd(userEntry(125, "OWN TEXT")));
    stream.push(messageEnd(userEntry(127, "FOREIGN TEXT")));
    stream.push(submissionEvent({ id: 7, requestId: "openrig/node-under-test/launch-1/4", status: "placed", entry: 125 }));
    stream.push(submissionEvent({ id: 8, requestId: "pda-chat/laptop/1", status: "placed", entry: 127 }));
    stream.push(runStart([7, 8]));
    await waitFor(() => rig.pane().includes("other ▸ FOREIGN TEXT"), "the other client's message");
    expect(rig.pane()).not.toContain("OWN TEXT");
    expect(rig.sidecar().lastEntryId).toBe("127");
    expect(JSON.parse(rig.ownSubmissionsRaw())).toEqual({ version: 1, ids: ["7"], entries: ["125"] });
  });

  it("M3: an own user entry whose submission is never seen is shown after the hold, as another client's (documented limit)", async () => {
    const { rig, stream } = await attached();
    stream.push(messageEnd(userEntry(130, "ORPHAN TEXT")));
    await waitFor(() => rig.pane().includes("other ▸ ORPHAN TEXT"), "shown after the hold");
  });

  it("M3: after a restart the entries this seat sent are still its own: the gap fill does not show them as 'other'", async () => {
    const rig = await makeRig();
    rigs.push(rig);
    fs.writeFileSync(rig.paths.ownSubmissionsPath, JSON.stringify({ version: 1, ids: ["7"], entries: ["125"] }), { mode: 0o600 });
    rig.scripted.transcript = [userEntry(125, "WE SENT THIS"), assistantEntry(126, "and the answer"), userEntry(127, "SOMEONE ELSE SENT THIS")];
    rig.start();
    const s = await rig.stream();
    s.push(snapshotEvent());
    await waitFor(() => rig.pane().includes("READY"), "READY");
    expect(rig.pane()).not.toContain("WE SENT THIS");
    expect(rig.pane()).toContain("and the answer");
    expect(rig.pane()).toContain("other ▸ SOMEONE ELSE SENT THIS");
  });

  it("a paste typed while pda is unreachable is saved, pending in the sidecar, and delivered once on return (T4 runner side)", async () => {
    const { rig, stream } = await attached();
    rig.scripted.allDown = true;
    stream.error();
    await waitFor(() => !rig.sidecar().connected, "disconnected");
    rig.runner.submit("typed during the outage");
    await waitFor(() => rig.sidecar().outboxPending === 1, "saved");
    expect(rig.outboxRaw()).toContain("typed during the outage");
    expect(rig.fake.postBodies).toEqual([]);
    rig.scripted.allDown = false;
    const s2 = await rig.stream(2);
    s2.push(snapshotEvent());
    await waitFor(() => rig.fake.entries("research").length === 1, "delivered");
    expect(rig.fake.entries("research")[0]!.content).toBe("typed during the outage");
    await waitFor(() => rig.sidecar().outboxPending === 0, "pending 0");
    expect(rig.fake.postBodies).toHaveLength(1);
  });

  it("T24 runner side: six 5xx hold the head and raise `held`; the next message waits behind it; release.request retries it", async () => {
    const { rig } = await attached();
    const five = { action: "status" as const, status: 500, body: { error: "conversation missing" } };
    rig.fake.script(five, five, five, five, five, five);
    rig.runner.submit("poison");
    rig.runner.submit("behind it");
    await waitFor(() => rig.sidecar().held !== undefined, "held in the sidecar");
    expect(rig.sidecar().held).toMatchObject({ code: "pda_message_held" });
    expect(rig.pane()).toContain("pda_message_held");
    expect(rig.pane()).toContain("rig seat pda-release");
    await new Promise((r) => setTimeout(r, 100));
    expect(rig.fake.entries("research")).toEqual([]); // FIFO: nothing behind the held head was posted
    expect(rig.sidecar().outboxPending).toBe(2);
    // The operator releases through the control file; the runner polls it and removes it.
    fs.writeFileSync(rig.paths.releaseRequestPath, "", { mode: 0o600 });
    await waitFor(() => rig.fake.entries("research").length === 2, "both delivered after release");
    expect(rig.fake.entries("research").map((e) => e.content)).toEqual(["poison", "behind it"]);
    expect(fs.existsSync(rig.paths.releaseRequestPath)).toBe(false);
    await waitFor(() => rig.sidecar().held === undefined && rig.sidecar().outboxPending === 0, "cleared");
  });

  it("a release request with nothing held is consumed and says so, and a symlinked or oversized one is consumed and ignored", async () => {
    const { rig } = await attached();
    fs.writeFileSync(rig.paths.releaseRequestPath, "");
    await waitFor(() => rig.pane().includes("no message is held"), "nothing held");
    expect(fs.existsSync(rig.paths.releaseRequestPath)).toBe(false);
    fs.writeFileSync(rig.paths.releaseRequestPath, "x".repeat(5000));
    await waitFor(() => !fs.existsSync(rig.paths.releaseRequestPath), "oversized consumed");
    expect(noReassert(rig.pane()).split("no message is held").length - 1).toBe(1);
  });

  it("release.request is also polled on attach: a hold from a previous launch is released by the first reconnect", async () => {
    const id = "openrig/node-under-test/launch-0/1";
    const rig = await started({
      aliveIntervalMs: 600_000, // the tick cannot be what releases it
      preseedRelease: true,
      preseedOutbox: (baseUrl) => [
        JSON.stringify({ op: "enq", requestId: id, agent: "research", baseUrl, content: "held from before", at: "2026-01-01T00:00:00.000Z" }),
        JSON.stringify({ op: "hold", requestId: id, code: "pda_message_held", status: 500, attempts: 6, at: "2026-01-01T00:00:01.000Z" }),
      ].join("\n") + "\n",
    });
    expect(rig.sidecar().held).toMatchObject({ requestId: id });
    const s = await rig.stream();
    s.push(snapshotEvent());
    await waitFor(() => rig.fake.entries("research").length === 1, "released and delivered by the attach-time poll");
    expect(rig.fake.entries("research")[0]!.content).toBe("held from before");
    expect(fs.existsSync(rig.paths.releaseRequestPath)).toBe(false);
  });

  it("the alive tick rewrites the sidecar: aliveAt advances while nothing else happens", async () => {
    const { rig } = await attached();
    const first = rig.sidecar().aliveAt;
    await waitFor(() => rig.sidecar().aliveAt !== first, "aliveAt to advance");
    expect(Date.parse(rig.sidecar().aliveAt)).toBeGreaterThan(Date.parse(first));
    expect(rig.sidecar().ready).toBe(true);
  });

  it("while the stream is down but pda is reachable, a saved message is NOT posted until the runner has re-attached", async () => {
    const { rig, stream } = await attached();
    rig.scripted.eventsDown = true; // /health, the agent and POSTs still work; only the stream is refused
    stream.error();
    await waitFor(() => !rig.sidecar().connected, "disconnected");
    rig.runner.submit("typed while detached");
    await waitFor(() => rig.sidecar().outboxPending === 1, "saved");
    await new Promise((r) => setTimeout(r, 120));
    expect(rig.fake.postBodies).toEqual([]);
    rig.scripted.eventsDown = false;
    const s2 = await rig.stream(2);
    s2.push(snapshotEvent());
    await waitFor(() => rig.fake.entries("research").length === 1, "delivered after the re-attach");
    expect(rig.fake.postBodies).toHaveLength(1);
  });

  it("a symlinked release.request is consumed (the link, not its target) and never applied", async () => {
    const { rig } = await attached();
    const five = { action: "status" as const, status: 500 };
    rig.fake.script(five, five, five, five, five, five);
    rig.runner.submit("held message");
    await waitFor(() => rig.sidecar().held !== undefined, "held");
    const target = path.join(rig.dir, "elsewhere");
    fs.writeFileSync(target, "operator note");
    fs.symlinkSync(target, rig.paths.releaseRequestPath);
    await waitFor(() => !fs.existsSync(rig.paths.releaseRequestPath), "link consumed");
    await new Promise((r) => setTimeout(r, 120));
    expect(fs.readFileSync(target, "utf8")).toBe("operator note");
    expect(rig.sidecar().held).toBeDefined();
    expect(rig.fake.entries("research")).toEqual([]);
    expect(rig.pane()).not.toContain("release requested");
  });

  it("a held head is retried after a reconnect that follows a stream loss (in memory only)", async () => {
    const { rig, stream } = await attached();
    const five = { action: "status" as const, status: 500 };
    rig.fake.script(five, five, five, five, five, five);
    rig.runner.submit("will be held");
    await waitFor(() => rig.sidecar().held !== undefined, "held");
    stream.error();
    const s2 = await rig.stream(2);
    s2.push(snapshotEvent());
    await waitFor(() => rig.fake.entries("research").length === 1, "retried after the reconnect");
    await waitFor(() => rig.sidecar().held === undefined && rig.sidecar().outboxPending === 0, "hold cleared and acked");
    // Not written down: the log still holds the hold record until the ack compacts it; the ack is what ended it.
    expect(rig.outboxRaw()).toContain('"op":"ack"');
  });

  it("a 404 on POST holds with pda_agent_missing and the pane says the agent does not exist", async () => {
    const { rig } = await attached();
    rig.fake.script({ action: "status", status: 404 });
    rig.runner.submit("to nowhere");
    await waitFor(() => rig.sidecar().held?.code === "pda_agent_missing", "pda_agent_missing held");
    expect(rig.pane()).toContain("pda_agent_missing: the pda agent does not exist");
  });

  it("a 400 is rejected, not held: the pane says so and the next message proceeds", async () => {
    const { rig } = await attached();
    rig.fake.script({ action: "status", status: 400, body: { error: "content required" } });
    rig.runner.submit("bad");
    rig.runner.submit("good");
    await waitFor(() => rig.fake.entries("research").length === 1, "next proceeds");
    expect(rig.pane()).toContain("ERROR not delivered: 400 content required");
    expect(rig.sidecar().held).toBeUndefined();
  });

  it("T23 runner side: records read for another agent are set aside, announced, flagged in the sidecar, and never posted", async () => {
    const stale = JSON.stringify({ op: "enq", requestId: "openrig/node-under-test/old/1", agent: "other-agent", baseUrl: "http://127.0.0.1:1", content: "meant for the other agent", at: "2026-01-01T00:00:00.000Z" });
    const rig = await started({ preseedOutbox: `${stale}\n` });
    const s = await rig.stream();
    s.push(snapshotEvent());
    await waitFor(() => rig.pane().includes("READY"), "READY");
    expect(rig.pane()).toContain("1 message(s) read for another pda binding are held and will not be sent to research");
    expect(rig.sidecar()).toMatchObject({ setAside: 1, outboxPending: 0, error: { code: "pda_outbox_binding_mismatch" } });
    expect(rig.fake.postBodies).toEqual([]);
    expect(rig.outboxRaw()).toContain("meant for the other agent");
  });
});

// ── A poisoned outbox (L1a 0d1ff178): stop with a code, never retry on a possibly torn log ──

describe("pda-runner: a poisoned outbox ends the runner with a code", () => {
  const POISON_LINE = "[pda-runner] ERROR pda_outbox_poisoned";

  it("a failed append while saving a message: exit 5, a code on the pane, the message is not posted, nothing retried, and the canary in the error is nowhere", async () => {
    const { rig } = await attached();
    rig.fault.failWhen = (data) => data.includes('"op":"enq"');
    rig.runner.submit("this cannot be saved");
    expect(await rig.done).toBe(5);
    expect(rig.pane()).toContain(POISON_LINE);
    expect(rig.pane()).toContain("[pda-runner] EXITED code=5");
    // Outcome unknown: it must not claim the message was dropped, and says it is not re-sent by the runner.
    expect(rig.pane()).toContain("may or may not have been queued");
    expect(rig.pane()).toContain("NOT being sent again automatically");
    expect(rig.pane()).not.toMatch(/was NOT saved|not been saved|dropped|lost/);
    expect(rig.pane()).not.toContain("pda_outbox_write_failed"); // the generic failure is not what is said
    for (const surface of [rig.pane(), rig.sidecarRaw()]) { expect(surface).not.toContain(BEARER); expect(surface).not.toContain("ENOSPC"); }
    expect(rig.sidecar()).toMatchObject({ ready: false, exited: { code: 5 } });
    expect(rig.fake.postBodies).toEqual([]);
    // The runner is finished: a second paste is ignored rather than retried on top of the log.
    const before = rig.pane();
    rig.runner.submit("typed after the failure");
    expect(rig.pane()).toBe(before);
    expect(rig.outboxRaw()).not.toContain("typed after the failure");
  });

  it("after the runner has finished for any reason, a paste is not saved and nothing is printed", async () => {
    const { rig } = await attached();
    rig.runner.fatal("TEST");
    const before = rig.pane();
    rig.runner.submit("typed too late");
    expect(rig.pane()).toBe(before);
    expect(rig.outboxRaw()).not.toContain("typed too late");
    expect(await rig.done).toBe(70);
  });

  it("a failed ack append after pda admitted the message: exit 5, and the log keeps the enq with no ack, so a restart replays it under the same id", async () => {
    const { rig } = await attached();
    rig.fault.failWhen = (data) => data.includes('"op":"ack"');
    rig.runner.submit("admitted but not acked");
    expect(await rig.done).toBe(5);
    expect(rig.pane()).toContain(POISON_LINE);
    expect(rig.fake.entries("research")).toHaveLength(1); // pda has it ...
    const log = rig.outboxRaw();
    expect(log).toContain('"op":"enq"');
    expect(log).not.toContain('"op":"ack"'); // ... and the log will say "pending", so the replay is exactly-once by requestId
    expect(rig.pane()).not.toContain("internal (delivery)");
    expect(rig.fake.postBodies).toHaveLength(1);
  });

  it("a failed release append (from release.request): exit 5", async () => {
    const { rig } = await attached();
    const five = { action: "status" as const, status: 500 };
    rig.fake.script(five, five, five, five, five, five);
    rig.runner.submit("held first");
    await waitFor(() => rig.sidecar().held !== undefined, "held");
    rig.fault.failWhen = (data) => data.includes('"op":"release"');
    fs.writeFileSync(rig.paths.releaseRequestPath, "", { mode: 0o600 });
    expect(await rig.done).toBe(5);
    expect(rig.pane()).toContain(POISON_LINE);
    expect(rig.fake.entries("research")).toEqual([]);
  });

  it("an enqueue error that is NOT a poisoned log (the size pre-check is fine, the request-id counter cannot be saved) says so plainly and keeps running", async () => {
    const { rig } = await attached();
    rig.fault.failWhen = (data) => /^[0-9]+\n$/.test(data); // only the .seq counter write
    rig.runner.submit("counter cannot be saved");
    await waitFor(() => rig.pane().includes("pda_outbox_write_failed"), "the generic failure");
    expect(rig.pane()).not.toContain(POISON_LINE);
    expect(rig.sidecar().exited).toBeUndefined();
    rig.fault.failWhen = null;
    rig.runner.submit("next one is fine");
    await waitFor(() => rig.fake.entries("research").length === 1, "delivered");
  });
});

describe("pda-runner: what the client is told to redact", () => {
  it("names the hook token's marker, and nothing when there is no hook token", async () => {
    expect(pdaClientRedactions("")).toEqual([]);
    expect(pdaClientRedactions(HOOK_TOKEN)).toEqual([{ value: HOOK_TOKEN, marker: "[redacted:openrig-hook-token]" }]);
  });

  it("a pda error naming both tokens reaches the pane with each token's own marker", async () => {
    const { rig } = await attached();
    rig.fake.script({ action: "status", status: 400, body: { error: `bad request ${HOOK_TOKEN} and ${BEARER}` } });
    rig.runner.submit("provokes a 400");
    await waitFor(() => rig.pane().includes("not delivered: 400"), "rejection line");
    expect(noReassert(rig.pane())).toContain("not delivered: 400 bad request [redacted:openrig-hook-token] and [redacted:pda-token]\n");
  });
});

// ── Fatal handlers ───────────────────────────────────────────────────────────

describe("pda-runner: uncaughtException and unhandledRejection print codes only", () => {
  it("fatalLabel is a code or 'unexpected', never the message", () => {
    expect(fatalLabel(Object.assign(new Error(`secret ${BEARER}`), { code: "ECONNRESET" }))).toBe("ECONNRESET");
    expect(fatalLabel(new Error(`secret ${BEARER}`))).toBe("unexpected");
    expect(fatalLabel(Object.assign(new Error("x"), { code: `lower case ${BEARER}` }))).toBe("unexpected");
    expect(fatalLabel(`a thrown string ${BEARER}`)).toBe("unexpected");
    expect(fatalLabel(null)).toBe("unexpected");
  });

  it.each(["uncaughtException", "unhandledRejection"] as const)("%s: the pane gets a code, the sidecar records the exit, the process exits 70, the canary is nowhere", async (kind) => {
    const rig = await makeRig({ realStreams: true });
    rigs.push(rig);
    rig.start();
    await waitFor(() => rig.pane().includes("READY"), "READY");
    const handlers = new Map<string, (r: unknown) => void>();
    const exit = vi.fn();
    installPdaRunnerFatalHandlers({ on: (e, l) => { handlers.set(e, l); }, exit }, (label) => rig.runner.fatal(label));
    expect([...handlers.keys()].sort()).toEqual(["uncaughtException", "unhandledRejection"]);
    const err = Object.assign(new Error(`Headers rejected: Bearer ${BEARER}\ntail`), { stack: `stack with ${BEARER}` });
    handlers.get(kind)!(err);
    expect(exit).toHaveBeenCalledWith(70);
    expect(rig.pane()).toContain("[pda-runner] ERROR internal (unexpected)");
    expect(rig.pane()).toContain("[pda-runner] EXITED code=70");
    expect(rig.pane()).not.toContain(BEARER);
    expect(rig.sidecar()).toMatchObject({ ready: false, exited: { code: 70 } });
    expect(rig.sidecarRaw()).not.toContain(BEARER);
  });

  it("a thrown error with an errno-style code reports that code", async () => {
    const rig = await makeRig({ realStreams: true });
    rigs.push(rig);
    rig.start();
    await waitFor(() => rig.pane().includes("READY"), "READY");
    const handlers = new Map<string, (r: unknown) => void>();
    installPdaRunnerFatalHandlers({ on: (e, l) => { handlers.set(e, l); }, exit: vi.fn() }, (label) => rig.runner.fatal(label));
    handlers.get("uncaughtException")!(Object.assign(new Error("boom"), { code: "ENOSPC" }));
    expect(rig.pane()).toContain("[pda-runner] ERROR internal (ENOSPC)");
  });
});

// ── --usage-facts: a stub for L2c ────────────────────────────────────────────

describe("pda-runner: --usage-facts is a stub for L2c", () => {
  it("passes raw events to the sink and posts nothing of its own", async () => {
    const calls: string[] = [];
    const { rig, stream } = await attached({ usageFacts: true, usage: {
      onRunStart: () => calls.push("run_start"),
      onAssistantEntry: (e) => calls.push(`entry:${(e as { id: string }).id}`),
      onRunEnd: () => calls.push("run_end"),
    } });
    stream.push(runStart());
    stream.push({ type: "message_end", entry: assistantEntry(121, "hi", { usage: { input: 1 } }) });
    stream.push(runEnd());
    await waitFor(() => !rig.sidecar().busy && calls.includes("run_end"), "run finished");
    expect(calls).toEqual(["run_start", "entry:121", "run_end"]);
    expect(rig.sidecar().usage).toBeUndefined();
    expect(rig.activity.every((a) => a.hookEvent !== "usage")).toBe(true);
  });
});

// ── pda's REAL shapes (review of 591e89fb: M1-M8). Every fixture is built in helpers/pda-real-shapes.ts from the
// declaration it cites; the loopback fake speaks the same shapes (numeric ids, the real snapshot, `message_end` for
// user messages, `submission{record}`), so these rows run the runner against a pda-shaped server, not a guess. ──

describe("pda-runner against the real wire shapes (M1-M8)", () => {
  /** The runner attached to the fake's OWN event stream (real snapshot, real events) and its own transcript. */
  async function onRealFake() {
    const rig = await started({ realStreams: true });
    await waitFor(() => rig.pane().includes("READY"), "READY");
    return rig;
  }

  it("a message round trip: acked (numeric id), the seat's own message is not echoed as 'other', no 'did not take the message' retry", async () => {
    const rig = await onRealFake();
    rig.runner.submit("hello pda");
    await waitFor(() => rig.pane().includes("queued (submission 1)"), "the ack");
    await waitFor(() => rig.sidecar().outboxPending === 0 && rig.sidecar().lastEntryId !== undefined, "pending 0 and the user entry seen");
    await new Promise((r) => setTimeout(r, 120)); // longer than the user-message hold
    const pane = noReassert(rig.pane());
    expect(pane).toContain("you ▸ hello pda");
    expect(pane).not.toContain("other ▸");
    expect(pane).not.toContain("did not take the message");
    expect(rig.fake.postBodies).toHaveLength(1); // not re-posted
    const entry = rig.fake.entries("research")[0]!;
    expect(typeof entry.submissionId).toBe("number");
    expect(JSON.parse(rig.ownSubmissionsRaw())).toEqual({ version: 1, ids: [String(entry.submissionId)], entries: [String(entry.entryId)] });
    expect(rig.sidecar().lastEntryId).toBe(String(entry.entryId)); // a string in the sidecar, from a numeric id
    expect(rig.sidecar().held).toBeUndefined();
  });

  it("streaming is visible: the reply appears from text_delta changes, once, and the sidecar goes busy then idle", async () => {
    const rig = await onRealFake();
    rig.fake.streamReply("research", ["Hel", "lo wor", "ld, streamed."]);
    await waitFor(() => rig.pane().includes("── idle ──"), "run_end");
    const pane = noReassert(rig.pane());
    expect(pane).toContain("Hello world, streamed.\n");
    expect(pane.split("Hello world, streamed.").length - 1).toBe(1); // streamed, and not printed again at message_end
    expect(rig.sidecar().busy).toBe(false);
    expect(rig.activity.map((a) => `${a.hookEvent}/${a.subtype}`)).toEqual(["Stop/attached_idle", "active/run_start", "Stop/run_end"]);
  });

  it("another client's message is visible, live, from message_end", async () => {
    const rig = await onRealFake();
    const { entryId } = rig.fake.injectOtherClientMessage("research", "typed on the laptop with pda chat");
    await waitFor(() => rig.pane().includes("other ▸ typed on the laptop with pda chat"), "the other client's message");
    expect(rig.sidecar().lastEntryId).toBe(String(entryId));
    expect(JSON.parse(rig.ownSubmissionsRaw() || "{}").ids ?? []).toEqual([]); // not ours
  });

  it("a waiting user message is shown before later output: pda's order is kept", async () => {
    const { rig, stream } = await attached();
    stream.push(messageEnd(userEntry(270, "question from another client")));
    stream.push(submissionEvent({ id: 71, requestId: "pda-chat/1", status: "placed", entry: 270 }));
    stream.push(deltaEvent("the answer starts"));
    stream.push(messageEnd(assistantEntry(271, "the answer starts")));
    await waitFor(() => rig.sidecar().lastEntryId === "271", "message_end");
    const pane = noReassert(rig.pane());
    expect(pane.indexOf("other ▸ question from another client")).toBeGreaterThan(-1);
    expect(pane.indexOf("other ▸ question from another client")).toBeLessThan(pane.indexOf("the answer starts"));
  });

  it("a reconnect replays nothing: every entry already shown stays shown once, and the cursor is a text id", async () => {
    const rig = await onRealFake();
    rig.runner.submit("first question");
    await waitFor(() => rig.pane().includes("queued (submission 1)"), "ack");
    rig.fake.streamReply("research", ["the ", "first answer"]);
    rig.fake.injectOtherClientMessage("research", "a remark from another client");
    await waitFor(() => rig.pane().includes("other ▸ a remark from another client"), "all shown");
    const newest = rig.fake.transcriptOf("research").length;
    rig.fake.dropStreams(); // pda restarted: the socket dies with no stream_end
    await waitFor(() => rig.pane().includes("[pda-runner] reconnected"), "reconnected");
    await new Promise((r) => setTimeout(r, 120));
    const pane = noReassert(rig.pane());
    for (const once of ["you ▸ first question", "the first answer", "other ▸ a remark from another client"]) {
      expect(pane.split(once).length - 1, once).toBe(1);
    }
    expect(pane.split("first question").length - 1).toBe(1); // not re-shown as 'other ▸ first question' either
    expect(rig.sidecar().lastEntryId).toBe(String(newest));
    expect(rig.fake.postBodies).toHaveLength(1);
  });

  it("M1, negative: the guessed streaming shape (assistantMessageEvent) shows nothing", async () => {
    const { rig, stream } = await attached();
    const before = rig.pane();
    stream.push(GUESSED_SHAPES.delta("SHOULD NOT STREAM"));
    await new Promise((r) => setTimeout(r, 60));
    expect(rig.pane()).toBe(before);
  });

  it("M2/M3, negative: the guessed submission shape and string-id entries record no ownership", async () => {
    const { rig, stream } = await attached();
    stream.push(GUESSED_SHAPES.submission("openrig/node-under-test/launch-1/1", "sub-1"));
    stream.push(runStart());
    await waitFor(() => rig.sidecar().busy, "processed");
    expect(rig.ownSubmissionsRaw()).toBe("");
  });

  it("M1: text_start's initial text, a message_start partial that already holds text, and many deltas in one update are all shown, once", async () => {
    const { rig, stream } = await attached();
    stream.push(messageStart(assistantMessage([{ type: "text", text: "partial " }])));
    stream.push(changesEvent([{ type: "text_delta", contentIndex: 0, delta: "one " }, { type: "text_delta", contentIndex: 0, delta: "two " }]));
    stream.push(changesEvent([{ type: "text_start", contentIndex: 1, block: { type: "text", text: "three " } }, { type: "thinking_delta", contentIndex: 2, delta: "HIDDEN" }]));
    stream.push(messageEnd(assistantEntry(210, "partial one two three ")));
    await waitFor(() => rig.sidecar().lastEntryId === "210", "message_end");
    const pane = noReassert(rig.pane());
    expect(pane).toContain("partial one two three \n");
    expect(pane.split("partial one two three").length - 1).toBe(1);
    expect(pane).not.toContain("HIDDEN");
  });

  it("M1: a block or a whole-message change replaces what was streamed, so the reply is shown whole at message_end", async () => {
    const { rig, stream } = await attached();
    stream.push(deltaEvent("start of "));
    stream.push(changesEvent([{ type: "block", contentIndex: 0, block: { type: "text", text: "start of a replaced block" } }]));
    stream.push(messageEnd(assistantEntry(211, "start of a replaced block")));
    await waitFor(() => rig.sidecar().lastEntryId === "211", "message_end");
    const pane = noReassert(rig.pane());
    expect(pane).toContain("[pda-runner] (reply resent in full after resync)\nstart of a replaced block\n");
  });

  it("M2: a submission record that is unanswered is reported by its reason; placed, done and queued say nothing", async () => {
    const { rig, stream } = await attached();
    stream.push(submissionEvent({ id: 51, requestId: "openrig/node-under-test/launch-1/1", status: "queued" }));
    stream.push(submissionEvent({ id: 51, requestId: "openrig/node-under-test/launch-1/1", status: "placed", entry: 301 }));
    stream.push(submissionEvent({ id: 51, requestId: "openrig/node-under-test/launch-1/1", status: "done", entry: 301, answer: 302 }));
    stream.push(submissionEvent({ id: 52, requestId: "openrig/node-under-test/launch-1/2", status: "unanswered", reason: "the conversation was reset" }));
    stream.push(runStart());
    await waitFor(() => rig.sidecar().busy, "processed");
    expect(noReassert(rig.pane()).split("not answered").length - 1).toBe(1);
    expect(rig.pane()).toContain("[pda-runner] not answered: the conversation was reset");
    expect(JSON.parse(rig.ownSubmissionsRaw())).toEqual({ version: 1, ids: ["51", "52"], entries: ["301"] });
  });

  it("M2: an own submission is also recognised by the id pda returned to the POST, when its record carries no requestId", async () => {
    const { rig, stream } = await attached();
    rig.runner.submit("sent by us");
    await waitFor(() => rig.pane().includes("queued (submission 1)"), "ack");
    stream.push(submissionEvent({ id: 1, status: "unanswered", reason: "no one answered" })); // no requestId on this record
    stream.push(runStart());
    await waitFor(() => rig.sidecar().busy, "processed");
    expect(rig.pane()).toContain("not answered: no one answered");
  });

  it("M5: entries without a model message arrive as entry_appended: a reset is announced, a compaction entry (it has a model) as message_end", async () => {
    const { rig, stream } = await attached();
    stream.push(entryAppended(bareEntry(220, "pi.reset")));
    stream.push(messageEnd(compactionEntry(221, "SUMMARY TEXT THAT IS NOT A USER MESSAGE")));
    stream.push(runStart());
    await waitFor(() => rig.sidecar().busy, "processed");
    await new Promise((r) => setTimeout(r, 60));
    const pane = noReassert(rig.pane());
    expect(pane).toContain("[pda-runner] conversation was reset");
    expect(pane).toContain("── context compacted ──");
    expect(pane).not.toContain("SUMMARY TEXT");
    expect(pane).not.toContain("other ▸");
  });

  it("M6: task_failed carries message and kind; auto_retry_start carries errorMessage; compaction_end carries error", async () => {
    const { rig, stream } = await attached();
    stream.push(taskFailed("model returned 500", "pi.generation"));
    stream.push(autoRetryStart("429 Too Many Requests"));
    stream.push(compactionEnd("summary too large"));
    stream.push(compactionEnd());
    stream.push(runStart());
    await waitFor(() => rig.sidecar().busy, "processed");
    const pane = noReassert(rig.pane());
    expect(pane).toContain("[pda-runner] task failed (pi.generation): model returned 500\n");
    expect(pane).toContain("[pda-runner] transient error; retrying: 429 Too Many Requests\n");
    expect(pane).toContain("[pda-runner] compaction failed: summary too large\n");
    expect(pane).toContain("[pda-runner] compaction finished\n");
  });

  it("M7: a top-level tool end carries the result ENTRY; the same entry arrives as message_end and is shown once; no entry means no result", async () => {
    const { rig, stream } = await attached();
    const result = toolResultEntry(230, "call-1", "line one\nFULL OUTPUT line two");
    stream.push(toolStart("call-1", "bash", { command: "make" }));
    stream.push(toolEnd("call-1", "bash", result));
    stream.push(messageStart(toolResultMessage("call-1", "line one\nFULL OUTPUT line two")));
    stream.push(messageEnd(result)); // pda emits the result's message right after the tool's end (events.js:205-222)
    stream.push(toolStart("call-2", "bash", { command: "boom" }));
    stream.push(toolEnd("call-2", "bash")); // the task faulted: no entry
    stream.push(runStart());
    await waitFor(() => rig.sidecar().busy, "processed");
    const pane = noReassert(rig.pane());
    expect(pane).toContain("  │ line one\n  │ FULL OUTPUT line two\n");
    expect(pane.split("FULL OUTPUT line two").length - 1).toBe(1);
    expect(pane).toContain("  ✗ bash: no result (the tool task faulted or the run ended)\n");
  });

  it("M8: an assistant message that failed shows its errorMessage, live and in a gap fill", async () => {
    const { rig, stream } = await attached();
    stream.push(messageEnd(assistantEntry(240, "", { errorMessage: "provider said 503 overloaded", stopReason: "error" })));
    await waitFor(() => rig.sidecar().lastEntryId === "240", "message_end");
    expect(noReassert(rig.pane())).toContain("  ! provider said 503 overloaded\n");
    rig.scripted.transcript = [assistantEntry(240, "", { errorMessage: "provider said 503 overloaded" }), assistantEntry(241, "later", { errorMessage: "second failure" })];
    stream.push(snapshotEvent());
    await waitFor(() => rig.pane().includes("later"), "gap fill");
    const pane = noReassert(rig.pane());
    expect(pane.split("provider said 503 overloaded").length - 1).toBe(1);
    expect(pane).toContain("  ! second failure\n");
  });

  it("a verbatim batch in pda's emission order (events.js:205-264) renders as one coherent exchange", async () => {
    const { rig, stream } = await attached();
    const user = userEntry(260, "what is in the repo?");
    const call = toolResultEntry(262, "call-9", "README.md\nsrc");
    const answer = assistantEntry(263, "It has a README and a src directory.");
    // commit 1: the input is placed
    stream.push(messageStart(userMessage("what is in the repo?")));
    stream.push(messageEnd(user));
    stream.push(submissionEvent({ id: 61, requestId: "openrig/node-under-test/launch-1/1", status: "placed", entry: 260 }));
    stream.push(runStart([61]));
    // commit 2: a tool call and its result
    stream.push(toolStart("call-9", "bash", { command: "ls" }));
    stream.push(toolEnd("call-9", "bash", call));
    stream.push(messageStart(toolResultMessage("call-9", "README.md\nsrc")));
    stream.push(messageEnd(call));
    // commit 3: the streamed answer, then its entry, the run's end and the submission's settlement
    stream.push(deltaEvent("It has a README "));
    stream.push(deltaEvent("and a src directory."));
    stream.push(messageEnd(answer));
    stream.push(runEnd([61]));
    stream.push(submissionEvent({ id: 61, requestId: "openrig/node-under-test/launch-1/1", status: "done", entry: 260, answer: 263 }));
    await waitFor(() => rig.sidecar().lastEntryId === "263" && !rig.sidecar().busy, "the whole batch");
    await new Promise((r) => setTimeout(r, 60));
    const pane = noReassert(rig.pane());
    const order = ["  ⚙ bash: {\"command\":\"ls\"}", "  │ README.md", "It has a README and a src directory.", "── idle ──"].map((t) => pane.indexOf(t));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(pane).not.toContain("what is in the repo?"); // our own message was echoed as 'you ▸' at submit time only
    expect(pane).not.toContain("other ▸");
    expect(rig.activity.map((a) => `${a.hookEvent}/${a.subtype}`)).toEqual(["Stop/attached_idle", "active/run_start", "PreToolUse/bash", "Stop/run_end"]);
  });
});

// ── The SSE parser's cost ────────────────────────────────────────────────────

describe("pda-sse: the cost of one event is linear in its size, however it is cut (review nit)", () => {
  function timeOne(megabytes: number): number {
    const body = `data: ${"x".repeat(megabytes * 1024 * 1024)}\n\n`;
    const bytes = new TextEncoder().encode(body);
    const parser = new PdaSseParser({ maxEventBytes: 64 * 1024 * 1024 });
    let events = 0;
    const t0 = performance.now();
    for (let at = 0; at < bytes.length; at += 16 * 1024) events += parser.push(bytes.subarray(at, at + 16 * 1024)).length;
    const ms = performance.now() - t0;
    expect(events).toBe(1);
    return ms;
  }

  it("4x the event costs about 4x, not 16x (the quadratic version took 14x)", () => {
    timeOne(1); // warm up
    const best = (mb: number) => Math.min(timeOne(mb), timeOne(mb), timeOne(mb));
    const small = best(2);
    const large = best(8);
    expect(large / Math.max(small, 1)).toBeLessThan(9);
    expect(large).toBeLessThan(2000);
  });
});

// ── Normalisers ──────────────────────────────────────────────────────────────

describe("pda-render: entry views", () => {
  it("reads text parts only, tool calls, ids, and the kind marker; anything else is 'other'", () => {
    expect(entryView(assistantEntry(122, "hi"))).toMatchObject({ id: "122", role: "assistant", text: "hi", toolCalls: [] });
    expect(entryView(bareEntry(5, "pi.reset"))).toMatchObject({ id: "5", role: "other", kind: "pi.reset", text: "" });
    expect(entryView({ id: 6, kind: "pi.assistant", model: [{ role: "assistant", content: [], errorMessage: "429 rate limited" }] })).toMatchObject({ errorMessage: "429 rate limited" });
    expect(entryView({ id: 130, kind: "pi.assistant", model: [{ role: "toolResult", toolCallId: "c", isError: true, content: "plain string" }] }))
      .toMatchObject({ role: "toolResult", toolCallId: "c", isError: true, text: "plain string" });
    expect(entryView(null)).toBeNull();
    expect(entryView("x")).toBeNull();
    // Ids: pda's are numbers; they become text once, here. A string is accepted; anything else is no id.
    expect(entryView({ id: 0, model: [] })?.id).toBe("0");
    expect(entryView({ id: 12, model: [] })?.id).toBe("12");
    expect(entryView({ id: "17", model: [] })?.id).toBe("17");
    for (const bad of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2, null, true, {}, "", undefined]) {
      expect(entryView({ id: bad, model: [] })?.id, String(bad)).toBeNull();
    }
    expect(idText(41)).toBe("41");
    expect(argsFirstLine({ command: "x".repeat(500) }, 160)).toHaveLength(160);
    expect(argsFirstLine("first\nsecond")).toBe("first");
  });
});

// ── The activity poster ──────────────────────────────────────────────────────

describe("pda-runner: the activity poster", () => {
  it("posts in order, one at a time, even when an earlier post is slow; a failure is dropped; no endpoint is a no-op", async () => {
    const seen: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      const body = JSON.parse(String(init?.body)) as { n: number };
      await new Promise((r) => setTimeout(r, body.n === 1 ? 40 : 1));
      seen.push(`${body.n}:${(init?.headers as Record<string, string>).authorization}`);
      inFlight--;
      if (body.n === 2) throw new TypeError("fetch failed");
      return new Response("{}");
    }) as typeof fetch;
    const post = createActivityPoster({ baseUrl: "http://127.0.0.1:9", token: "tok" }, fetchImpl);
    for (const n of [1, 2, 3]) post({ n });
    await waitFor(() => seen.length === 3, "three attempts");
    expect(seen).toEqual(["1:Bearer tok", "2:Bearer tok", "3:Bearer tok"]);
    expect(maxInFlight).toBe(1);
    expect(() => createActivityPoster(null)({ n: 1 })).not.toThrow();
  });
});

// ── The real process ─────────────────────────────────────────────────────────

const RUNNER_TS = fileURLToPath(new URL("../src/adapters/pda-runner.ts", import.meta.url));

const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "pda-runner-home-"));

function runProcess(argv: string[], env: Record<string, string> = {}) {
  const child = spawn(process.execPath, ["--import", "tsx", RUNNER_TS, ...argv], {
    // HOME and OPENRIG_HOME point at an empty temp dir: the child must find no activity endpoint and no live daemon.
    env: { PATH: process.env.PATH ?? "", HOME: isolatedHome, OPENRIG_HOME: isolatedHome, ...env }, stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (c) => { out += c.toString(); });
  child.stderr.on("data", (c) => { err += c.toString(); });
  const exit = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, exit, out: () => out, err: () => err };
}

describe("pda-runner: the real process (node --import tsx)", () => {
  it("bad arguments exit 2 with a code and no echoed value", async () => {
    const argv = buildPdaRunnerArgv({ sessionName: "s", stateRoot: isolatedHome, launchId: "l", binding: { agent: "main", baseUrl: "http://localhost:1" }, tokenFile: "/nope" });
    const p = runProcess(argv);
    expect(await p.exit).toBe(2);
    expect(p.err()).toContain("[pda-runner] ERROR pda_args_invalid");
    expect(p.err()).not.toContain("localhost");
  }, 30000);

  it("end to end against the fake: READY, a stdin line becomes one message, SIGTERM exits 0 with the exit marker and an exited sidecar", async () => {
    const rig = await makeRig({ realStreams: true });
    rigs.push(rig);
    const argv = buildPdaRunnerArgv({
      sessionName: rig.args.sessionName, stateRoot: rig.args.stateRoot, launchId: "proc-launch",
      binding: { agent: "research", baseUrl: rig.args.baseUrl }, tokenFile: rig.args.tokenFile,
    });
    fs.chmodSync(rig.paths.seatRoot, 0o755); // a directory made too open by someone else: the runner closes it
    const p = runProcess(argv, { OPENRIG_NODE_ID: "proc-node", OPENRIG_ACTIVITY_HOOK_TOKEN: HOOK_TOKEN });
    try {
      await waitFor(() => p.out().includes("[pda-runner] READY agent=research"), "READY from the real process", 20000);
      const secretLine = `paste: ${BEARER} and ${HOOK_TOKEN}`;
      p.child.stdin.write(`${secretLine}\n`);
      await waitFor(() => p.out().includes("you ▸ paste: [redacted:pda-token] and [redacted:openrig-hook-token]"), "the echo, redacted", 10000);
      await waitFor(() => rig.fake.entries("research").some((e) => e.content === secretLine), "the line as typed reached pda", 10000); // the operator's own input is sent as typed
      p.child.stdin.write("hello from stdin\n");
      await waitFor(() => rig.fake.entries("research").some((e) => e.content === "hello from stdin"), "the message arrived", 10000);
      const entry = rig.fake.entries("research").find((e) => e.content === "hello from stdin")!;
      expect(entry.requestId).toMatch(/^openrig\/proc-node\/proc-launch\/\d+$/);
      // The real process, against pda-shaped events: the ack (a numeric id), no 'other' echo of our own line, streaming.
      await waitFor(() => p.out().includes("queued (submission 2)"), "the ack of the second line, id 2 (the first line was id 1)", 10000);
      rig.fake.streamReply("research", ["streamed ", "by the fake"]);
      await waitFor(() => p.out().includes("streamed by the fake"), "the streamed reply in the real process's stdout", 10000);
      expect(p.out()).not.toContain("other ▸");
      expect(p.out()).not.toContain("did not take the message");
      expect(p.out()).not.toContain(BEARER);
      expect(p.err()).not.toContain(BEARER);
      expect(fs.statSync(rig.paths.seatRoot).mode & 0o777).toBe(0o700);
    } finally { p.child.kill("SIGTERM"); }
    expect(await p.exit).toBe(0);
    expect(p.out()).toContain("[pda-runner] EXITED code=0");
    const side = JSON.parse(fs.readFileSync(rig.paths.runnerStatePath, "utf8"));
    expect(side).toMatchObject({ ready: false, exited: { code: 0 }, launchId: "proc-launch" });
    expect(nonAllowlisted(rig.fake.requests)).toEqual([]);
  }, 60000);

  it("the real process posts activity to the daemon endpoint it is given, with the hook token as bearer", async () => {
    const hooks: Array<{ url: string | undefined; auth: string | undefined; body: Record<string, unknown> }> = [];
    const daemon = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        hooks.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(raw || "{}") as Record<string, unknown> });
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise<void>((resolve) => daemon.listen(0, "127.0.0.1", resolve));
    const rig = await makeRig({ realStreams: true });
    rigs.push(rig);
    const argv = buildPdaRunnerArgv({
      sessionName: rig.args.sessionName, stateRoot: rig.args.stateRoot, launchId: "proc-launch-3",
      binding: { agent: "research", baseUrl: rig.args.baseUrl }, tokenFile: rig.args.tokenFile,
    });
    const p = runProcess(argv, {
      OPENRIG_NODE_ID: "proc-node-3", OPENRIG_OCCUPANT_GENERATION: "gen-9", OPENRIG_ACTIVITY_HOOK_TOKEN: HOOK_TOKEN,
      OPENRIG_URL: `http://127.0.0.1:${(daemon.address() as AddressInfo).port}`,
    });
    try {
      await waitFor(() => hooks.length >= 1, "an activity post", 20000);
      expect(hooks[0]).toMatchObject({
        url: "/api/activity/hooks", auth: `Bearer ${HOOK_TOKEN}`,
        body: { sessionName: rig.args.sessionName, nodeId: "proc-node-3", generation: "gen-9", runtime: "pda", hookEvent: "Stop", subtype: "attached_idle" },
      });
      expect(JSON.stringify(hooks)).not.toContain(BEARER);
    } finally {
      p.child.kill("SIGTERM");
      await p.exit;
      await new Promise<void>((resolve) => daemon.close(() => resolve()));
    }
  }, 60000);

  it("a message log that cannot be opened at startup: exit 5, a code only (no path, no content), an exited sidecar, and pda is never contacted", async () => {
    const rig = await makeRig({ realStreams: true });
    rigs.push(rig);
    fs.mkdirSync(path.join(rig.dir, "elsewhere"));
    const stateRoot = path.join(rig.dir, "fresh-state");
    const seatRoot = path.join(stateRoot, rig.args.sessionName);
    fs.mkdirSync(seatRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(seatRoot, "outbox.log")); // a directory where the log should be: reading it fails
    const argv = buildPdaRunnerArgv({
      sessionName: rig.args.sessionName, stateRoot, launchId: "proc-launch-4",
      binding: { agent: "research", baseUrl: rig.args.baseUrl }, tokenFile: rig.args.tokenFile,
    });
    const p = runProcess(argv);
    expect(await p.exit).toBe(5);
    const out = p.out() + p.err();
    expect(out).toContain("[pda-runner] ERROR pda_outbox_unopenable (EISDIR)");
    expect(out).toContain("[pda-runner] EXITED code=5");
    expect(out).not.toContain(seatRoot); // no path
    expect(out).not.toContain(BEARER);
    expect(JSON.parse(fs.readFileSync(path.join(seatRoot, "runner-state.json"), "utf8"))).toMatchObject({ ready: false, launchId: "proc-launch-4", exited: { code: 5 } });
    expect(rig.fake.requests).toEqual([]);
  }, 60000);

  it("a request-id counter file that does not parse: exit 5 with the code pda_outbox_seq_corrupt, and its content is not echoed", async () => {
    const rig = await makeRig({ realStreams: true });
    rigs.push(rig);
    const stateRoot = path.join(rig.dir, "fresh-state-2");
    const seatRoot = path.join(stateRoot, rig.args.sessionName);
    fs.mkdirSync(seatRoot, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(seatRoot, "outbox.log.seq"), `not-a-number ${BEARER}`, { mode: 0o600 });
    const argv = buildPdaRunnerArgv({
      sessionName: rig.args.sessionName, stateRoot, launchId: "proc-launch-5",
      binding: { agent: "research", baseUrl: rig.args.baseUrl }, tokenFile: rig.args.tokenFile,
    });
    const p = runProcess(argv);
    expect(await p.exit).toBe(5);
    const out = p.out() + p.err();
    expect(out).toContain("[pda-runner] ERROR pda_outbox_unopenable (pda_outbox_seq_corrupt)");
    expect(out).not.toContain("not-a-number");
    expect(out).not.toContain(BEARER);
    expect(JSON.parse(fs.readFileSync(path.join(seatRoot, "runner-state.json"), "utf8"))).toMatchObject({ ready: false, exited: { code: 5 } });
    expect(fs.readFileSync(path.join(seatRoot, "outbox.log.seq"), "utf8")).toBe(`not-a-number ${BEARER}`); // left for a person to fix
    expect(rig.fake.requests).toEqual([]);
  }, 60000);

  it("a token file with an interior LF: exit 4, a code on the pane, the canary in no output", async () => {
    const rig = await makeRig({ realStreams: true, tokenFileContent: `${BEARER}\ntail` });
    rigs.push(rig);
    const argv = buildPdaRunnerArgv({
      sessionName: rig.args.sessionName, stateRoot: rig.args.stateRoot, launchId: "proc-launch-2",
      binding: { agent: "research", baseUrl: rig.args.baseUrl }, tokenFile: rig.args.tokenFile,
    });
    const p = runProcess(argv);
    expect(await p.exit).toBe(4);
    expect(p.out()).toContain("[pda-runner] ERROR pda_token_format");
    expect(p.out() + p.err()).not.toContain(BEARER);
    expect(rig.fake.requests).toEqual([]);
  }, 60000);
});
