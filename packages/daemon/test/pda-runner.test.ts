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
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  PdaRunner, fatalLabel, installPdaRunnerFatalHandlers, parsePdaRunnerArgv, wirePdaRunnerInput, createActivityPoster,
} from "../src/adapters/pda-runner.js";
import { PdaPane, PdaRedactor, argsFirstLine, entryView } from "../src/adapters/pda-render.js";
import { buildPdaRunnerArgv, PDA_DEFAULT_BASE_URL } from "../src/adapters/pda-runner-protocol.js";
import { nonAllowlisted } from "./helpers/fake-pda.js";
import {
  BEARER, HOOK_TOKEN, LOOKALIKE, assistantEntry, makeRig, toolResultEntry, userEntry, waitFor, type Rig,
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
async function attached(options: Parameters<typeof makeRig>[0] = {}, snapshot: Record<string, unknown> = { type: "snapshot", run: null }) {
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
    stream.push({ type: "snapshot", run: null });
    await waitFor(() => rig.sidecar().ready, "ready after recovery");
    expect(rig.sidecar().error).toBeUndefined();
    void done;
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
    stream.push({ type: "run_start", inputs: [] });
    await waitFor(() => rig.sidecar().busy, "busy after run_start");
    stream.push({ type: "tool_execution_start", toolName: "bash", toolCallId: "t1", args: { command: "ls" } });
    stream.push({ type: "run_end" });
    await waitFor(() => !rig.sidecar().busy, "idle after run_end");
    expect(rig.activity.map((a) => `${a.hookEvent}/${a.subtype}`)).toEqual([
      "Stop/attached_idle", "active/run_start", "PreToolUse/bash", "Stop/run_end",
    ]);
    expect(rig.pane()).toContain("── idle ──");
    // Every post carries the seat's identity and the pda runtime.
    for (const a of rig.activity) expect(a).toMatchObject({ sessionName: "seat-under-test", nodeId: "node-under-test", generation: "gen-7", runtime: "pda" });
  });

  it("a snapshot with a run in flight is busy, posts attached_busy once, and a repeat posts nothing", async () => {
    const { rig, stream } = await attached({}, { type: "snapshot", run: { id: "r1" } });
    expect(rig.sidecar().busy).toBe(true);
    stream.push({ type: "snapshot", run: { id: "r1" } });
    stream.push({ type: "run_end" });
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
    second.push({ type: "snapshot", run: null });
    await waitFor(() => rig.sidecar().connected, "reconnected");
    expect(rig.activity.map((a) => `${a.hookEvent}/${a.subtype}`)).toEqual([
      "Stop/attached_idle", "Notification/pda_disconnected", "Stop/attached_idle",
    ]);
    expect(rig.pane()).toContain("[pda-runner] stream lost; reconnecting");
    expect(rig.pane()).toContain("[pda-runner] reconnected");
  });

  it("nested tool calls and unknown events render nothing and post nothing", async () => {
    const { rig, stream } = await attached();
    stream.push({ type: "tool_execution_start", toolName: "inner", toolCallId: "t2", parentToolCallId: "t1", args: {} });
    stream.push({ type: "tool_execution_end", toolCallId: "t2", parentToolCallId: "t1", result: "NESTEDOUTPUT" });
    const quiet = rig.pane();
    stream.push({ type: "something_new_in_pda_1_4" });
    stream.raw("data: not json at all\n\n");
    stream.raw(": keep-alive\n\n");
    await new Promise((r) => setTimeout(r, 40));
    expect(rig.pane()).toBe(quiet); // an ignored event writes nothing, not even a bracketed-paste re-assertion
    stream.push({ type: "run_start" });
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
    rig.scripted.transcript = [userEntry("e1", "first question", { requestId: "elsewhere/1" }), assistantEntry("e2", "first answer")];
    const s1 = await rig.stream();
    s1.push({ type: "snapshot", run: null });
    await waitFor(() => rig.pane().includes("READY"), "READY");
    expect(rig.pane()).toContain("other ▸ first question");
    expect(rig.pane()).toContain("first answer");
    // A live reply, streamed and finished.
    s1.push({ type: "run_start" });
    s1.push({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "second " } });
    s1.push({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "answer" } });
    s1.push({ type: "message_end", entry: assistantEntry("e3", "second answer") });
    await waitFor(() => rig.sidecar().lastEntryId === "e3", "cursor e3");
    // pda restarts: the stream dies, pda is down for a while, and e4 is produced meanwhile.
    rig.scripted.eventsDown = true;
    s1.error();
    await waitFor(() => !rig.sidecar().connected, "disconnected");
    rig.scripted.transcript = [
      userEntry("e1", "first question", { requestId: "elsewhere/1" }), assistantEntry("e2", "first answer"),
      assistantEntry("e3", "second answer"), assistantEntry("e4", "answer given while the runner was away"),
    ];
    rig.scripted.eventsDown = false;
    const s2 = await rig.stream(2);
    s2.push({ type: "snapshot", run: null });
    await waitFor(() => rig.sidecar().connected && rig.sidecar().lastEntryId === "e4", "caught up to e4");
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
    fs_writeSidecar(rig, "n10");
    rig.scripted.transcript = Array.from({ length: 80 }, (_, i) => assistantEntry(`n${i}`, `reply ${i}.`));
    rig.start();
    const s = await rig.stream();
    s.push({ type: "snapshot", run: null });
    await waitFor(() => rig.pane().includes("READY"), "READY");
    expect(rig.scripted.transcriptLimits).toEqual([50, 500]);
    expect(rig.pane()).toContain("reply 11.");
    expect(rig.pane()).toContain("reply 79.");
    expect(rig.pane()).not.toContain("reply 10.");
    expect(rig.pane()).not.toContain("(gap:");
    expect(rig.sidecar().lastEntryId).toBe("n79");
  });

  it("a prior launch's cursor (same binding) means only newer entries are rendered after a runner restart", async () => {
    const rig = await makeRig();
    rigs.push(rig);
    fs_writeSidecar(rig, "e2");
    rig.scripted.transcript = [assistantEntry("e1", "old one"), assistantEntry("e2", "old two"), assistantEntry("e3", "new three")];
    rig.start();
    const s = await rig.stream();
    s.push({ type: "snapshot", run: null });
    await waitFor(() => rig.pane().includes("READY"), "READY");
    expect(rig.pane()).toContain("new three");
    expect(rig.pane()).not.toContain("old one");
    expect(rig.pane()).not.toContain("old two");
    expect(rig.pane()).not.toContain("showing the newest");
  });

  it("a cursor that is nowhere in 500 entries prints the gap marker and the newest 20", async () => {
    const rig = await makeRig();
    rigs.push(rig);
    fs_writeSidecar(rig, "vanished");
    rig.scripted.transcript = Array.from({ length: 60 }, (_, i) => assistantEntry(`m${i}`, `message ${i}.`));
    rig.start();
    const s = await rig.stream();
    s.push({ type: "snapshot", run: null });
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
    second.push({ type: "snapshot", run: null });
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
    rig.scripted.transcript = [userEntry("u1", "question typed in pda chat", { requestId: "other/1" })];
    stream.push({ type: "snapshot", run: null }); // the server overflowed: a fresh snapshot, same connection
    await waitFor(() => rig.pane().includes("other ▸ question typed in pda chat"), "gap-filled entry");
    stream.push({ type: "entry_appended", entry: userEntry("u1", "question typed in pda chat", { requestId: "other/1" }) });
    stream.push({ type: "run_start" });
    await waitFor(() => rig.sidecar().busy, "later events still processed");
    expect(rig.scripted.streams).toHaveLength(1); // no reconnect
    expect(noReassert(rig.pane()).split("question typed in pda chat").length - 1).toBe(1);
    expect(rig.scripted.transcriptLimits).toEqual([50, 50]); // the resync ran
  });

  it("a resync in the middle of a message: the reply is printed again in full after the marker, and the pane holds all of it", async () => {
    const { rig, stream } = await attached();
    stream.push({ type: "run_start" });
    stream.push({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "The quick " } });
    // Deltas "brown fox jumps over " were lost in the overflow; a fresh snapshot arrives with the run still going.
    stream.push({ type: "snapshot", run: { id: "r1" } });
    stream.push({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "the lazy dog, then it rests." } });
    stream.push({ type: "message_end", entry: assistantEntry("a1", FULL) });
    await waitFor(() => rig.sidecar().lastEntryId === "a1", "message_end processed");
    const pane = noReassert(rig.pane());
    const marker = pane.indexOf("[pda-runner] (reply resent in full after resync)");
    expect(marker).toBeGreaterThan(-1);
    expect(pane.slice(marker)).toContain(FULL); // the whole reply, after the marker
    expect(pane.slice(0, marker)).not.toContain("brown fox"); // before it, the deltas lost in the overflow were never shown: only fragments
  });

  it("a snapshot taken while a run is in flight marks the next reply dirty even if its first deltas were lost before the snapshot", async () => {
    const { rig, stream } = await attached();
    stream.push({ type: "run_start" });
    // The first half of the reply was lost in an overflow; the snapshot says a run is in flight; the tail streams.
    stream.push({ type: "snapshot", run: { id: "r2" } });
    stream.push({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "...and the end of it." } });
    stream.push({ type: "message_end", entry: assistantEntry("a2", "Here is the beginning ...and the end of it.") });
    await waitFor(() => rig.sidecar().lastEntryId === "a2", "message_end processed");
    const pane = noReassert(rig.pane());
    expect(pane).toContain("(reply resent in full after resync)");
    expect(pane).toContain("Here is the beginning ...and the end of it.");
  });

  it("when the gap fill itself already holds the finished reply, it is printed once more at most, never twice from the transcript and the event", async () => {
    const { rig, stream } = await attached();
    stream.push({ type: "run_start" });
    stream.push({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Partial reply " } });
    rig.scripted.transcript = [assistantEntry("a3", "Partial reply, now complete.")];
    stream.push({ type: "snapshot", run: null });
    await waitFor(() => rig.pane().includes("now complete"), "gap fill printed the finished reply");
    stream.push({ type: "message_end", entry: assistantEntry("a3", "Partial reply, now complete.") });
    stream.push({ type: "run_end" });
    await waitFor(() => rig.pane().includes("── idle ──"), "run_end");
    const pane = noReassert(rig.pane());
    expect(pane.split("now complete").length - 1).toBe(1);
    expect(pane).toContain("(reply resent in full after resync)");
  });

  it("without a resync, a streamed reply is NOT printed a second time at message_end", async () => {
    const { rig, stream } = await attached();
    stream.push({ type: "run_start" });
    stream.push({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "streamed once " } });
    stream.push({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "only" } });
    stream.push({ type: "message_end", entry: assistantEntry("a4", "streamed once only") });
    await waitFor(() => rig.sidecar().lastEntryId === "a4", "message_end");
    expect(noReassert(rig.pane()).split("streamed once only").length - 1).toBe(1);
    expect(rig.pane()).not.toContain("resent");
  });

  it("a reply that arrived with no deltas at all is printed whole at message_end", async () => {
    const { rig, stream } = await attached();
    stream.push({ type: "message_end", entry: assistantEntry("a5", "never streamed") });
    await waitFor(() => rig.pane().includes("never streamed"), "printed whole");
  });
});

// ── T14: full output ─────────────────────────────────────────────────────────

describe("pda-runner: full output (T14, Jim's J-2)", () => {
  it("a 300-line tool result and a long assistant reply appear in full", async () => {
    const { rig, stream } = await attached();
    const output = Array.from({ length: 300 }, (_, i) => `line ${i} of the build log`).join("\n");
    const reply = "word ".repeat(8000).trim(); // 39,999 characters, no newline
    stream.push({ type: "run_start" });
    stream.push({ type: "tool_execution_start", toolName: "bash", toolCallId: "c1", args: { command: "make" } });
    stream.push({ type: "tool_execution_end", toolCallId: "c1", result: { content: [{ type: "text", text: output }] } });
    stream.push({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: reply } });
    stream.push({ type: "message_end", entry: assistantEntry("a6", reply) });
    await waitFor(() => rig.sidecar().lastEntryId === "a6", "done");
    const pane = noReassert(rig.pane());
    for (let i = 0; i < 300; i++) expect(pane).toContain(`  │ line ${i} of the build log\n`);
    expect(pane).toContain(`  ⚙ bash: {"command":"make"}`);
    expect(pane).toContain(reply);
  });

  it("a tool call's arguments show their first line, at most 160 characters; the output is not capped by that", async () => {
    const { rig, stream } = await attached();
    stream.push({ type: "tool_execution_start", toolName: "bash", toolCallId: "g1", args: { command: "x".repeat(500) } });
    stream.push({ type: "tool_execution_start", toolName: "write", toolCallId: "g2", args: "first line\nsecond line SHOULD-NOT-SHOW" });
    stream.push({ type: "run_start" });
    await waitFor(() => rig.sidecar().busy, "processed");
    const line = noReassert(rig.pane()).split("\n").find((l) => l.startsWith("  ⚙ bash: "))!;
    expect(line.length).toBe("  ⚙ bash: ".length + 160);
    expect(rig.pane()).toContain("  ⚙ write: first line\n");
    expect(rig.pane()).not.toContain("SHOULD-NOT-SHOW");
  });

  it("an error result is marked, and an empty one says so; thinking is never shown", async () => {
    const { rig, stream } = await attached();
    stream.push({ type: "tool_execution_end", toolCallId: "c2", isError: true, result: "boom\nsecond line" });
    stream.push({ type: "tool_execution_end", toolCallId: "c3", result: "" });
    stream.push({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "THINKING DELTA SECRET" } });
    stream.push({ type: "message_end", entry: { id: "a7", model: [{ role: "assistant", content: [
      { type: "thinking", thinking: "SECRET INNER MONOLOGUE" }, { type: "text", text: "visible" }] }] } });
    await waitFor(() => rig.sidecar().lastEntryId === "a7", "done");
    const pane = noReassert(rig.pane());
    expect(pane).toContain("  ✗ boom\n  ✗ second line\n");
    expect(pane).toContain("  │ (no output)\n");
    expect(pane).toContain("visible");
    expect(pane).not.toContain("SECRET INNER MONOLOGUE");
    expect(pane).not.toContain("THINKING DELTA SECRET");
  });

  it("a tool result is rendered once whether it arrives live or in a gap fill", async () => {
    const { rig, stream } = await attached();
    stream.push({ type: "tool_execution_end", toolCallId: "dup1", result: "only-once-output" });
    await waitFor(() => rig.pane().includes("only-once-output"), "live");
    rig.scripted.transcript = [toolResultEntry("tr1", "dup1", "only-once-output")];
    stream.push({ type: "snapshot", run: null });
    await waitFor(() => rig.scripted.transcriptLimits.length >= 2, "resync");
    stream.push({ type: "run_start" });
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
    stream.push({ type: "tool_execution_end", toolCallId: "h1", result: HOSTILE });
    stream.push({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: HOSTILE } });
    stream.push({ type: "message_end", entry: assistantEntry("h-a", HOSTILE) });
    await waitFor(() => rig.sidecar().lastEntryId === "h-a", "done");
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
      userEntry("hu", HOSTILE, { requestId: "other/1" }),
      { id: "hc", model: [{ role: "assistant", content: [{ type: "toolCall", name: `ba${ESC}[2Jsh`, arguments: { command: `echo ${ESC}[?2004l` } }, { type: "text", text: HOSTILE }] }] },
      toolResultEntry("hr", "tc1", HOSTILE),
    ];
    stream.push({ type: "snapshot", run: null });
    stream.push({ type: "tool_execution_start", toolName: `to${ESC}]52;c;AAAA\u0007ol`, toolCallId: "h2", args: { x: `${ESC}[?2004l` } });
    stream.push({ type: "task_failed", error: `failed ${ESC}[?2004l here` });
    stream.push({ type: "run_start" });
    await waitFor(() => rig.sidecar().busy && rig.pane().includes("task failed"), "all processed");
    expect(forbidden(rig.pane())).toEqual([]);
    expect(noReassert(rig.pane())).toContain('  ⚙ bash: {"command":"echo \\u001b[?2004l"}'); // the gap-filled call: name sanitised; JSON escapes the ESC in its arguments to inert text
    expect(rig.activity.map((a) => String(a.subtype))).toContain("tool"); // the tool name was sanitised before it left the process
    expect(JSON.stringify(rig.activity)).not.toContain(ESC);
  });

  it("the runner re-asserts bracketed paste after an output batch, and writes no other escape itself", async () => {
    const { rig, stream } = await attached();
    const before = rig.pane().length;
    stream.push({ type: "tool_execution_end", toolCallId: "ra1", result: "plain" });
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
    stream.push({ type: "tool_execution_end", toolCallId: "k1", result: leak });
    stream.push({ type: "message_end", entry: assistantEntry("k-a", leak) });
    await waitFor(() => rig.sidecar().lastEntryId === "k-a", "done");
    const pane = rig.pane();
    expect(pane).not.toContain(BEARER);
    expect(pane).not.toContain(HOOK_TOKEN);
    expect(pane).toContain("  │ key [redacted:pda-token] and hook [redacted:openrig-hook-token] end");
  });

  it("a secret with a terminal sequence spliced through it is still caught: redaction runs AFTER sanitising", async () => {
    const { rig, stream } = await attached();
    const spliced = `${BEARER.slice(0, 10)}${ESC}[0m${BEARER.slice(10, 30)}\u0007${BEARER.slice(30)}`;
    stream.push({ type: "tool_execution_end", toolCallId: "sp1", result: `spliced: ${spliced}` });
    stream.push({ type: "message_end", entry: assistantEntry("sp-a", `reply: ${spliced}`) });
    await waitFor(() => rig.sidecar().lastEntryId === "sp-a", "done");
    const pane = noReassert(rig.pane());
    expect(pane).toContain("  │ spliced: [redacted:pda-token]\n");
    expect(pane).toContain("reply: [redacted:pda-token]\n");
    expect(pane).not.toContain(BEARER.slice(0, 10));
  });

  it("a secret split across two text_deltas is still caught, and the text around it is preserved in order", async () => {
    const { rig, stream } = await attached();
    for (const at of [1, 7, 20, BEARER.length - 1]) {
      stream.push({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `before-${at} ${BEARER.slice(0, at)}` } });
      stream.push({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `${BEARER.slice(at)} after-${at}\n` } });
    }
    stream.push({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `${HOOK_TOKEN.slice(0, 5)}` } });
    stream.push({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `${HOOK_TOKEN.slice(5)} tail` } });
    stream.push({ type: "message_end", entry: assistantEntry("s-a", "irrelevant") });
    await waitFor(() => rig.sidecar().lastEntryId === "s-a", "done");
    const pane = noReassert(rig.pane());
    expect(pane).not.toContain(BEARER);
    for (const at of [1, 7, 20, BEARER.length - 1]) expect(pane).toContain(`before-${at} [redacted:pda-token] after-${at}\n`);
    expect(pane).toContain("[redacted:openrig-hook-token] tail");
    expect(pane).not.toContain(HOOK_TOKEN);
  });

  it("a partial secret at the very end of a message is flushed as ordinary text when the message ends", async () => {
    const { rig, stream } = await attached();
    stream.push({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `ends with a prefix ${BEARER.slice(0, 10)}` } });
    stream.push({ type: "message_end", entry: assistantEntry("e-a", "x") });
    await waitFor(() => rig.sidecar().lastEntryId === "e-a", "done");
    expect(noReassert(rig.pane())).toContain(`ends with a prefix ${BEARER.slice(0, 10)}\n`);
  });

  it("control: a DIFFERENT 43-character base64url string is not redacted (nothing else is pattern-redacted)", async () => {
    const { rig, stream } = await attached();
    stream.push({ type: "tool_execution_end", toolCallId: "l1", result: `looks like a token: ${LOOKALIKE}` });
    stream.push({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `and ${LOOKALIKE}\n` } });
    stream.push({ type: "message_end", entry: assistantEntry("l-a", "x") });
    await waitFor(() => rig.sidecar().lastEntryId === "l-a", "done");
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
    stream.push({ type: "run_start" });
    stream.push({ type: "tool_execution_start", toolName: "bash", toolCallId: "z1", args: { command: `echo ${CANARY_ARGS}` } });
    stream.push({ type: "tool_execution_end", toolCallId: "z1", result: `${CANARY_OUT}\nmore` });
    stream.push({ type: "message_end", entry: assistantEntry("z-a", `the answer mentions ${CANARY_OUT}`) });
    stream.push({ type: "run_end" });
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
    await waitFor(() => rig.pane().includes("queued (submission sub-1)"), "ack echo");
    expect(JSON.parse(rig.ownSubmissionsRaw())).toEqual({ version: 1, ids: ["sub-1"] });
    await waitFor(() => rig.sidecar().outboxPending === 0, "pending 0");
    expect(rig.fake.entries("research")).toHaveLength(1);
    expect(fs.statSync(rig.paths.ownSubmissionsPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(rig.paths.runnerStatePath).mode & 0o777).toBe(0o600);
  });

  it("own-submissions.json keeps the newest 500 ids, from acks and from own submission events", async () => {
    const { rig, stream } = await attached();
    for (let i = 0; i < 520; i++) stream.push({ type: "submission", requestId: `openrig/node-under-test/launch-1/${i}`, submissionId: `s-${i}` });
    stream.push({ type: "submission", requestId: "someone-else/1", submissionId: "foreign-1" });
    stream.push({ type: "run_start" });
    await waitFor(() => rig.sidecar().busy, "all processed");
    const ids = JSON.parse(rig.ownSubmissionsRaw()).ids as string[];
    expect(ids).toHaveLength(500);
    expect(ids[0]).toBe("s-20");
    expect(ids[499]).toBe("s-519");
    expect(ids).not.toContain("foreign-1");
  });

  it("an unanswered own submission is reported; a foreign one is not", async () => {
    const { rig, stream } = await attached();
    stream.push({ type: "submission", requestId: "foreign/1", submissionId: "f1", outcome: "unanswered", reason: "x" });
    stream.push({ type: "submission", requestId: "openrig/node-under-test/launch-1/9", submissionId: "m1", outcome: "unanswered", reason: "agent was reset" });
    stream.push({ type: "run_start" });
    await waitFor(() => rig.sidecar().busy, "processed");
    expect(rig.pane()).toContain("[pda-runner] not answered: agent was reset");
    expect(noReassert(rig.pane()).split("not answered").length - 1).toBe(1);
  });

  it("this seat's own user entries are not echoed a second time as 'other'; a foreign one is", async () => {
    const { rig, stream } = await attached();
    stream.push({ type: "entry_appended", entry: userEntry("u-own", "OWN TEXT", { requestId: "openrig/node-under-test/launch-1/3" }) });
    stream.push({ type: "submission", requestId: "openrig/node-under-test/launch-1/4", submissionId: "sub-known" });
    stream.push({ type: "entry_appended", entry: userEntry("u-sub", "SUBMITTED TEXT", { submissionId: "sub-known" }) });
    stream.push({ type: "entry_appended", entry: userEntry("u-foreign", "FOREIGN TEXT", { requestId: "pda-chat/1" }) });
    stream.push({ type: "run_start" });
    await waitFor(() => rig.sidecar().busy, "processed");
    expect(rig.pane()).toContain("other ▸ FOREIGN TEXT");
    expect(rig.pane()).not.toContain("OWN TEXT");
    expect(rig.pane()).not.toContain("SUBMITTED TEXT");
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
    s2.push({ type: "snapshot", run: null });
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
    s.push({ type: "snapshot", run: null });
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
    s2.push({ type: "snapshot", run: null });
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
    s2.push({ type: "snapshot", run: null });
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
    s.push({ type: "snapshot", run: null });
    await waitFor(() => rig.pane().includes("READY"), "READY");
    expect(rig.pane()).toContain("1 message(s) read for another pda binding are held and will not be sent to research");
    expect(rig.sidecar()).toMatchObject({ setAside: 1, outboxPending: 0, error: { code: "pda_outbox_binding_mismatch" } });
    expect(rig.fake.postBodies).toEqual([]);
    expect(rig.outboxRaw()).toContain("meant for the other agent");
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
    stream.push({ type: "run_start", inputs: [] });
    stream.push({ type: "message_end", entry: assistantEntry("u-a", "hi", { usage: { input: 1 } }) });
    stream.push({ type: "run_end" });
    await waitFor(() => !rig.sidecar().busy && calls.includes("run_end"), "run finished");
    expect(calls).toEqual(["run_start", "entry:u-a", "run_end"]);
    expect(rig.sidecar().usage).toBeUndefined();
    expect(rig.activity.every((a) => a.hookEvent !== "usage")).toBe(true);
  });
});

// ── Normalisers ──────────────────────────────────────────────────────────────

describe("pda-render: entry views", () => {
  it("reads text parts only, tool calls, ids, and the kind marker; anything else is 'other'", () => {
    expect(entryView(assistantEntry("a", "hi"))).toMatchObject({ id: "a", role: "assistant", text: "hi", toolCalls: [] });
    expect(entryView({ id: "k", type: "pi.reset", model: [{ role: "system" }] })).toMatchObject({ role: "other", kind: "pi.reset" });
    expect(entryView({ id: "t", model: [{ role: "toolResult", toolCallId: "c", isError: true, content: "plain string" }] }))
      .toMatchObject({ role: "toolResult", toolCallId: "c", isError: true, text: "plain string" });
    expect(entryView(null)).toBeNull();
    expect(entryView("x")).toBeNull();
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
