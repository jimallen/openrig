// OPR.0.4.6.PI1 — hermetic unit tests for the pi-runner core: submitted paste
// boundaries (including delayed multi-line sends), stdin→RPC routing
// (idle→prompt / streaming→steer / prefix conventions), the event→mirror and
// event→activity mapping, the get_state identity capture + sidecar, the
// durable catch-up cursor, and honest pi-exit reporting. No live pi.

import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import {
  createRunnerInput, MAX_PI_INPUT_BYTES, RunnerCore, mapPiEvent, parseRunnerArgs,
  prepareRunnerSidecar,
  type RunnerIo,
} from "../src/adapters/pi-runner.js";
import { PI_RUNNER_READY_MARKER, PI_RUNNER_EXIT_MARKER, type PiRunnerState } from "../src/adapters/pi-runner-protocol.js";
import { extractPiUsageFacts } from "../src/domain/pi-usage-facts.js";
import { openRouterChargeTarget } from "../src/domain/openrouter-charge.js";

const SESSION = "devpi-a@some-rig";
const SESSION_FILE = "/state/pi/devpi-a@some-rig/sessions/2026_0197.jsonl";

function fakeIo() {
  const rpc: Record<string, unknown>[] = [];
  const lines: string[] = [];
  const appends: string[] = [];
  const activity: Record<string, unknown>[] = [];
  const sidecars: PiRunnerState[] = [];
  const io: RunnerIo = {
    sendRpc: (cmd) => rpc.push(cmd),
    mirrorLine: (line) => lines.push(line),
    mirrorAppend: (text) => appends.push(text),
    postActivity: (payload) => activity.push(payload),
    writeSidecar: (state) => sidecars.push(state),
    now: () => "2026-07-06T10:00:00Z",
  };
  return { io, rpc, lines, appends, activity, sidecars };
}

function readyCore(f = fakeIo()) {
  const core = new RunnerCore(f.io, { sessionName: SESSION, nodeId: "node-1", launchId: "launch-77" });
  core.start();
  core.handlePiLine(JSON.stringify({
    type: "response", id: "pi-runner-get-state",
    data: { sessionFile: SESSION_FILE, sessionId: "0197a2f0" },
  }));
  return { core, ...f };
}

// ── Actual Node line editor + framed input ──────────────────────────────────

describe("runner input", () => {
  const start = "\u001b[200~";
  const end = "\u001b[201~";
  function terminal(onSubmit?: (s: string) => void) {
    const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: false,
      setRawMode: vi.fn(function (this: { isRaw: boolean }, value: boolean) { this.isRaw = value; }) });
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
    const blocks: string[] = [];
    let screen = "";
    output.on("data", chunk => { screen += chunk.toString(); });
    const editor = createRunnerInput(input as unknown as NodeJS.ReadStream,
      output as unknown as NodeJS.WriteStream, s => { blocks.push(s); onSubmit?.(s); });
    return { input, output, editor, blocks, screen: () => screen };
  }

  it.each([1011, 1012, 1023, 2048, 16384])("accepts %i bytes then abort and next", size => {
    const t = terminal();
    try {
      t.input.write(start + "x".repeat(size) + end + "\r");
      t.input.write("/abort\rnext\r");
      expect(t.blocks).toEqual(["x".repeat(size), "/abort", "next"]);
      expect(t.input.setRawMode).toHaveBeenCalledWith(true);
    } finally { t.editor.close(); }
    expect(t.input.isRaw).toBe(false);
  });

  it("holds delayed paste and preserves whitespace, Unicode and CRLF bytes", () => {
    vi.useFakeTimers();
    const t = terminal();
    try {
      t.input.write(start + " \n café\r\n\n日本語 ");
      vi.advanceTimersByTime(60_000);
      expect(t.blocks).toEqual([]);
      t.input.write(end);
      expect(t.blocks).toEqual([]);
      t.input.write("\r");
      expect(t.blocks).toEqual([" \n café\r\n\n日本語 "]);
    } finally { t.editor.close(); vi.useRealTimers(); }
  });

  it("reassembles UTF-8 and markers across single-byte chunks", () => {
    const t = terminal();
    try {
      for (const byte of Buffer.from(start + "café\n日本語" + end)) t.input.write(Buffer.from([byte]));
      expect(t.blocks).toEqual([]);
      t.input.write("\r");
      expect(t.blocks).toEqual(["café\n日本語"]);
    } finally { t.editor.close(); }
  });

  it("retains mixed typing/paste, cursor insertion, backspace and line clear", () => {
    const t = terminal();
    try {
      t.input.write("prefix " + start + "paste\n café " + end + " suffix\r");
      t.input.write("ac\u001b[Db\r"); // Node's left-arrow editing.
      t.input.write("removeX\u007f\r");
      t.input.write("clear this\u0015kept\r");
      expect(t.blocks).toEqual(["prefix paste\n café  suffix", "abc", "remove", "kept"]);
    } finally { t.editor.close(); }
  });

  it("keeps rapid submissions distinct, with current core routing", () => {
    const { core, rpc } = readyCore();
    const t = terminal(s => core.handleUserBlock(s));
    try {
      t.input.write(start + "first" + end + "\r");
      core.handlePiLine(JSON.stringify({ type: "agent_start" }));
      t.input.write(start + "second" + end + "\r/followup later\r/abort\r");
      expect(rpc.filter(x => ["prompt", "steer", "follow_up", "abort"].includes(String(x.type)))).toEqual([
        { type: "prompt", message: "first" }, { type: "steer", message: "second" },
        { type: "follow_up", message: "later" }, { type: "abort" },
      ]);
    } finally { t.editor.close(); }
  });

  it("Ctrl-C cancels an unfinished paste and leaves the next input reachable", () => {
    const t = terminal();
    try {
      t.input.write(start + "unfinished\n/abort\r");
      expect(t.blocks).toEqual([]); // Text in a paste is content, not a command.
      t.input.write("\u0003");
      expect(t.blocks).toEqual(["/abort"]);
      t.input.write(start + "next" + end + "\r");
      expect(t.blocks).toEqual(["/abort", "next"]);
      expect(t.screen()).toContain("input cleared");
    } finally { t.editor.close(); }
  });

  it("rejects an oversized paste without submitting a prefix; controls recover", () => {
    const t = terminal();
    try {
      t.input.write("prefix " + start + "x".repeat(MAX_PI_INPUT_BYTES + 1));
      expect(t.screen()).toContain("input rejected");
      expect(t.blocks).toEqual([]);
      t.input.write(end + "\r/abort\rnext\r");
      expect(t.blocks).toEqual(["/abort", "next"]);
      t.input.write(start + "x".repeat(MAX_PI_INPUT_BYTES + 1) + "\u0003next again\r");
      expect(t.blocks.slice(-2)).toEqual(["/abort", "next again"]);
    } finally { t.editor.close(); }
  });

  it("does not echo framing markers or submit empty input; EOF restores raw mode", () => {
    const t = terminal();
    t.input.write("\r" + start + end + "\r");
    expect(t.blocks).toEqual([]);
    expect(t.screen()).not.toContain(start);
    expect(t.screen()).not.toContain(end);
    t.input.write("\u0004");
    expect(t.input.isRaw).toBe(false);
  });

  it("uses newline-delimited messages for nonterminal input", () => {
    const input = new PassThrough(), output = new PassThrough(), blocks: string[] = [];
    const editor = createRunnerInput(input as unknown as NodeJS.ReadStream,
      output as unknown as NodeJS.WriteStream, block => blocks.push(block));
    input.write(" \nraw one\nraw two\n");
    expect(blocks).toEqual(["raw one", "raw two"]);
    input.end(); editor.close();
  });

  it("preserves terminal line editing under TERM=dumb, while normal terminal and piped input still behave", () => {
    try {
      // 1. Under TERM=dumb with TTY streams: editing (type, backspace, retype) must be retained
      vi.stubEnv("TERM", "dumb");
      const dumbTerm = terminal();
      dumbTerm.input.write("hello worlx\u007fd\r");
      expect(dumbTerm.blocks).toEqual(["hello world"]);
      dumbTerm.editor.close();

      // 2. Under normal terminal: editing behaves as before
      vi.stubEnv("TERM", "xterm-256color");
      const normalTerm = terminal();
      normalTerm.input.write("normal worlx\u007fd\r");
      expect(normalTerm.blocks).toEqual(["normal world"]);
      normalTerm.editor.close();

      // 3. Piped nonterminal input under TERM=dumb: newline-delimited messages behave as before
      vi.stubEnv("TERM", "dumb");
      const pipedIn = new PassThrough(), pipedOut = new PassThrough(), pipedBlocks: string[] = [];
      const pipedEditor = createRunnerInput(pipedIn as unknown as NodeJS.ReadStream,
        pipedOut as unknown as NodeJS.WriteStream, block => pipedBlocks.push(block));
      pipedIn.write("piped one\npiped two\n");
      expect(pipedBlocks).toEqual(["piped one", "piped two"]);
      pipedIn.end();
      pipedEditor.close();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

// ── stdin → RPC routing ──────────────────────────────────────────────────────

describe("RunnerCore.handleUserBlock", () => {
  it("idle → RPC prompt", () => {
    const { core, rpc } = readyCore();
    core.handleUserBlock("hello pi");
    expect(rpc.at(-1)).toEqual({ type: "prompt", message: "hello pi" });
  });

  it("streaming → RPC steer (Pi's documented mid-stream delivery)", () => {
    const { core, rpc } = readyCore();
    core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    core.handleUserBlock("change course");
    expect(rpc.at(-1)).toEqual({ type: "steer", message: "change course" });
  });

  it("back to prompt after agent_end", () => {
    const { core, rpc } = readyCore();
    core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    core.handlePiLine(JSON.stringify({ type: "agent_end" }));
    core.handleUserBlock("next task");
    expect(rpc.at(-1)).toEqual({ type: "prompt", message: "next task" });
  });

  it("/abort → RPC abort; /followup → RPC follow_up", () => {
    const { core, rpc } = readyCore();
    core.handleUserBlock("/abort");
    expect(rpc.at(-1)).toEqual({ type: "abort" });
    core.handleUserBlock("/followup after this turn");
    expect(rpc.at(-1)).toEqual({ type: "follow_up", message: "after this turn" });
  });
});

// ── identity capture + sidecar + catch-up cursor ─────────────────────────────

describe("RunnerCore identity + sidecar", () => {
  it("get_state response → READY marker + sidecar + session_identity POST with sessionFile", () => {
    const { lines, activity, sidecars } = readyCore();
    expect(lines.some((l) => l.startsWith(PI_RUNNER_READY_MARKER))).toBe(true);
    const sidecar = sidecars.at(-1)!;
    expect(sidecar).toMatchObject({ ready: true, launchId: "launch-77", sessionFile: SESSION_FILE, sessionId: "0197a2f0" });
    const identity = activity.find((a) => a.eventFamily === "session_identity")!;
    expect(identity).toMatchObject({
      runtime: "pi", sessionName: SESSION, sessionId: "0197a2f0", sessionFile: SESSION_FILE,
    });
  });

  it("start() with a catch-up cursor issues get_entries since (durable catch-up, FR-5)", () => {
    const f = fakeIo();
    const core = new RunnerCore(f.io, { sessionName: SESSION }, { catchUpSince: "entry-42" });
    core.start();
    expect(f.rpc).toContainEqual({ type: "get_entries", since: "entry-42", id: "pi-runner-catch-up" });
  });

  it("events carrying entry ids advance the sidecar cursor", () => {
    const { core, sidecars } = readyCore();
    core.handlePiLine(JSON.stringify({ type: "agent_start", entryId: "entry-7" }));
    expect(sidecars.at(-1)!.lastEntryId).toBe("entry-7");
  });

  it("pi exit → EXIT marker + sidecar exited + idle activity (honest, never frozen)", () => {
    const { core, lines, sidecars, activity } = readyCore();
    core.handlePiExit(1);
    expect(lines.some((l) => l.startsWith(PI_RUNNER_EXIT_MARKER))).toBe(true);
    expect(sidecars.at(-1)!.exited).toEqual({ code: 1, at: "2026-07-06T10:00:00Z" });
    expect(activity.at(-1)).toMatchObject({ hookEvent: "Stop", subtype: "pi_exited" });
  });

  it("non-JSON pi stdout noise is mirrored verbatim, never swallowed", () => {
    const { core, lines } = readyCore();
    core.handlePiLine("some stray warning");
    expect(lines).toContain("some stray warning");
  });
});

// ── event → mirror / activity mapping ────────────────────────────────────────

// Shapes from a real `pi --mode rpc` 0.87.1 run (OpenRig's child argv) that
// streamed a reply from a local OpenAI-compatible mock. Since Pi 0.84.0,
// message_update carries only `usage` and the `assistantMessageEvent` delta.
const PI_USAGE = {
  input: 12, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 17,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const PI_REPLY = {
  role: "assistant",
  content: [
    { type: "thinking", thinking: "User wants a greeting.", thinkingSignature: "reasoning_content" },
    { type: "text", text: "Hello from the mock server." },
  ],
  api: "openai-completions", provider: "mock", model: "mock-model", usage: PI_USAGE,
  stopReason: "stop", timestamp: 1790281248272, responseId: "chatcmpl-mock",
};
const piUpdate = (assistantMessageEvent: Record<string, unknown>) =>
  ({ type: "message_update", usage: PI_USAGE, assistantMessageEvent });
const PI_REPLY_EVENTS = [
  { type: "message_start", message: { ...PI_REPLY, content: [], stopReason: "pending" } },
  piUpdate({ type: "thinking_start", contentIndex: 0 }),
  piUpdate({ type: "thinking_delta", contentIndex: 0, delta: "User wants a greeting." }),
  piUpdate({ type: "text_start", contentIndex: 1 }),
  piUpdate({ type: "text_delta", contentIndex: 1, delta: "Hello" }),
  piUpdate({ type: "text_delta", contentIndex: 1, delta: " from the" }),
  piUpdate({ type: "text_delta", contentIndex: 1, delta: " mock server." }),
  piUpdate({ type: "thinking_end", contentIndex: 0, content: "User wants a greeting." }),
  piUpdate({ type: "text_end", contentIndex: 1, content: "Hello from the mock server." }),
  { type: "message_end", message: PI_REPLY },
];

describe("mapPiEvent", () => {
  it("agent_start/agent_end drive streaming + running/idle activity", () => {
    expect(mapPiEvent({ type: "agent_start" })).toMatchObject({
      streaming: true, activity: { hookEvent: "active", subtype: "agent_start" },
    });
    expect(mapPiEvent({ type: "agent_end" })).toMatchObject({
      streaming: false, activity: { hookEvent: "Stop", subtype: "agent_end" },
    });
  });

  it("pre-0.84 message_update appends only the delta, never the cumulative message", () => {
    const partial = { ...PI_REPLY, content: [{ type: "text", text: "Hello from the" }], stopReason: "pending" };
    const legacy = mapPiEvent({
      type: "message_update",
      message: partial,
      assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: " from the", partial },
    });
    expect(legacy.mirrorAppend).toBe(" from the");
  });

  it("tool executions render compact one-line summaries + PreToolUse activity", () => {
    const start = mapPiEvent({ type: "tool_execution_start", toolName: "bash" });
    expect(start.mirrorLines[0]).toContain("bash");
    expect(start.activity).toEqual({ hookEvent: "PreToolUse", subtype: "bash" });
    const failed = mapPiEvent({ type: "tool_execution_end", toolName: "bash", isError: true });
    expect(failed.mirrorLines[0]).toContain("FAILED");
  });

  it("compaction and retry map to their honest states", () => {
    expect(mapPiEvent({ type: "compaction_start" }).activity).toEqual({ hookEvent: "active", subtype: "compaction" });
    expect(mapPiEvent({ type: "auto_retry_start" }).activity).toEqual({ hookEvent: "active", subtype: "auto_retry" });
  });

  it("leaves auto_compaction_* unmapped for Pi so an idle seat never reads as running", () => {
    for (const type of ["auto_compaction_start", "auto_compaction_end"]) {
      expect(mapPiEvent({ type })).toEqual({ mirrorLines: [] });
      expect(mapPiEvent({ type }, "pi")).toEqual({ mirrorLines: [] });
    }
    expect(mapPiEvent({ type: "auto_compaction_start" }, "omp").activity).toEqual({ hookEvent: "active", subtype: "compaction" });
  });
});

describe("RunnerCore assistant reply mirror", () => {
  it("streams a Pi 0.84+ reply from text deltas and ends the line on message_end", () => {
    const f = fakeIo();
    const { core } = readyCore(f);
    let pane = "";
    f.io.mirrorLine = (line) => { pane += `${line}\n`; };
    f.io.mirrorAppend = (text) => { pane += text; };
    for (const event of PI_REPLY_EVENTS) core.handlePiLine(JSON.stringify(event));
    expect(pane).toBe("Hello from the mock server.\n");
  });
});

// Shapes from a real Pi 1.3.0 session (qualification run on Sparky, 2026-10-23: scratch seat, `openai-codex`
// stored sign-in, 18 assistant turns across a restart). Pi 1.3.0's stdout stream was not recorded by anything
// (the runner's transcript holds pane text only), so this is the PERSISTED form: the entries `get_entries` returns,
// which are also the `message` of each `message_end` (agent-session persists the finalized message on message_end).
// Scrubbed: ids, response ids, prompts, commands, reply text and paths are generic placeholders. What is kept
// real is every number the usage reader consumes. Per assistant turn:
// [input, output, cacheRead, reasoning, totalTokens, cost.total, stopReason, durationMs]; cacheWrite was 0 on every
// turn, and cost components other than the total are elided (only the total is read).
const PI13_TURNS: ReadonlyArray<readonly [number, number, number, number, number, number, "toolUse" | "stop", number]> = [
  [34413, 75, 0, 0, 34488, 0.0034788000000000006, "toolUse", 2481],
  [777, 36, 34304, 0, 35117, 0.00043874, "toolUse", 1323],
  [257, 35, 34944, 0, 35236, 0.00039264000000000004, "toolUse", 1888],
  [3854, 52, 35072, 0, 38978, 0.00076212, "toolUse", 1259],
  [243, 64, 38784, 0, 39091, 0.00044414000000000004, "toolUse", 1485],
  [249, 40, 38912, 0, 39201, 0.00043402, "toolUse", 1285],
  [2257, 41, 39040, 0, 41338, 0.0006366, "stop", 1375],
  [262, 44, 41216, 0, 41522, 0.00046036000000000004, "toolUse", 1311],
  [538, 50, 41344, 0, 41932, 0.00049224, "toolUse", 1038],
  [234, 68, 41728, 0, 42030, 0.00047468, "toolUse", 1657],
  [204, 39, 41856, 0, 42099, 0.00045846, "toolUse", 2266],
  [292, 66, 41856, 9, 42214, 0.00048076, "toolUse", 3189],
  [246, 21, 41984, 0, 42251, 0.00045494, "stop", 1126],
  [264, 80, 42112, 0, 42456, 0.00048752, "toolUse", 2437],
  [252, 88, 42240, 0, 42580, 0.0004916, "toolUse", 1443],
  [248, 55, 42368, 0, 42671, 0.00047598, "toolUse", 1176],
  [191, 21, 42496, 0, 42708, 0.00045456, "stop", 1160],
  [310, 27, 42496, 0, 42833, 0.00046946, "stop", 1582],
];
const PI13_TURN_WITH_THINKING = 11; // the one real turn whose content was [thinking, toolCall]
/** Pi 1.3.0 assistant message (openai-codex-responses). `rawStopReason`, `durationMs` and `thinkingLevel` are
 *  1.3.0 fields the 0.87.1 fixture above does not have. */
const pi13Assistant = (i: number) => {
  const [input, output, cacheRead, reasoning, totalTokens, total, stopReason, durationMs] = PI13_TURNS[i]!;
  const call = { type: "toolCall", id: `call_fixture_${i}|fc_fixture_${i}`, name: "bash", arguments: { command: "<scrubbed command>", timeout: 20 } };
  const content = stopReason === "stop" ? [{ type: "text", text: "<scrubbed reply>" }]
    : i === PI13_TURN_WITH_THINKING ? [{ type: "thinking", thinking: "<scrubbed>", thinkingSignature: "<scrubbed>" }, call] : [call];
  return {
    role: "assistant", content, api: "openai-codex-responses", provider: "openai-codex", model: "gpt-6-luna",
    usage: { input, output, cacheRead, cacheWrite: 0, reasoning, totalTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } },
    stopReason, timestamp: 1792768673142 + i * 3000, responseId: `resp_fixture_${i}`,
    rawStopReason: "completed", durationMs, thinkingLevel: "medium",
  };
};
/** The persisted entries: a 1.3.0 `system` message entry (role "system" with `sections` and `toolsAdded`, which
 *  carries no usage), the user prompt, then each assistant turn (toolResult entries between tool calls). */
const PI13_ENTRIES: Record<string, unknown>[] = (() => {
  const entries: Record<string, unknown>[] = [];
  const add = (message: Record<string, unknown>) => {
    const n = entries.length;
    entries.push({ type: "message", id: `f1300${String(n).padStart(3, "0")}`, parentId: n === 0 ? null : entries[n - 1]!.id,
      timestamp: new Date(Date.UTC(2026, 9, 23, 15, 17, 53) + n * 1000).toISOString(), message });
  };
  add({ role: "system", content: "", sections: { preamble: "<scrubbed>", cwd: "<scrubbed>" },
    toolsAdded: [{ name: "bash", description: "<scrubbed>", parameters: { type: "object" } }], timestamp: 1792768673128 });
  add({ role: "user", content: [{ type: "text", text: "<scrubbed prompt>" }], timestamp: 1792768673128 });
  PI13_TURNS.forEach((turn, i) => {
    add(pi13Assistant(i));
    if (turn[6] === "toolUse") {
      add({ role: "toolResult", toolCallId: `call_fixture_${i}|fc_fixture_${i}`, toolName: "bash",
        content: [{ type: "text", text: "<scrubbed output>" }], isError: false, durationMs: 477, timestamp: 1792768676103 + i * 3000 });
    }
  });
  return entries;
})();

describe("Pi 1.3.0 persisted transcript (real session shapes, scrubbed)", () => {
  it("is a Pi 1.3.0 fixture: every assistant turn carries the fields 0.87.1 messages do not", () => {
    const assistants = PI13_ENTRIES.map(e => e.message as Record<string, unknown>).filter(m => m.role === "assistant");
    expect(assistants).toHaveLength(18);
    for (const m of assistants) {
      expect(Object.keys(m)).toEqual(expect.arrayContaining(["rawStopReason", "durationMs", "thinkingLevel"]));
    }
    expect(PI13_ENTRIES.some(e => (e.message as Record<string, unknown>).role === "system")).toBe(true);
  });

  it("reads exactly what Pi's own totals count: 18 turns, 45091 in / 902 out / 682752 cache-read, no system or tool-result noise", () => {
    const { facts, malformed } = extractPiUsageFacts(PI13_ENTRIES, { createdAt: "2026-10-23T15:17:52.828Z", parentSession: null });
    expect(malformed).toBe(0);
    expect(facts).toHaveLength(18);
    expect(facts.every(f => f.kind === "assistant" && f.origin === "own")).toBe(true);
    expect(facts.reduce((n, f) => n + f.input, 0)).toBe(45091);
    expect(facts.reduce((n, f) => n + f.output, 0)).toBe(902);
    expect(facts.reduce((n, f) => n + f.cacheRead, 0)).toBe(682752);
    expect(facts.reduce((n, f) => n + f.cacheWrite, 0)).toBe(0);
    expect(facts.filter(f => f.stopReason === "toolUse")).toHaveLength(14);
    expect(facts.filter(f => f.stopReason === "stop")).toHaveLength(4);
    expect(facts[0]).toMatchObject({ provider: "openai-codex", model: "gpt-6-luna", api: "openai-codex-responses", responseId: "resp_fixture_0", costTotal: 0.0034788000000000006 });
  });

  it("never looks these turns up as OpenRouter charges, and an openai-codex-responses id would not be one either", () => {
    const { facts } = extractPiUsageFacts(PI13_ENTRIES, { createdAt: "2026-10-23T15:17:52.828Z", parentSession: null });
    for (const f of facts) expect(openRouterChargeTarget(f)).toEqual({ notCovered: "not an OpenRouter request" });
    // Control: relabel the provider and the api branch decides, so the answer above is not only the provider test.
    expect(openRouterChargeTarget({ ...facts[0]!, provider: "openrouter" }))
      .toEqual({ notCovered: "Pi's openai-codex-responses API: its response id isn't a documented OpenRouter generation id" });
  });

  it("maps a 1.3.0 assistant message_end to the same honest terminal: a line end, no error, for toolUse and stop alike", () => {
    for (const i of [0, PI13_TURN_WITH_THINKING, 6, 17]) {
      expect(mapPiEvent({ type: "message_end", message: pi13Assistant(i) })).toEqual({ mirrorLines: [""] });
    }
    // Control: the same message as a failed turn does announce itself, so the quiet result above is not blindness.
    const failed = { ...pi13Assistant(0), stopReason: "error", errorMessage: "provider said no" };
    expect(mapPiEvent({ type: "message_end", message: failed }).errorNotice).toBe("[pi-runner] ERROR provider said no");
  });
});

// A Pi 1.3.0 `pi --mode rpc` stdout stream for one prompt with a tool turn (thinking + bash call, the real turn 11
// of the qualification session) and a stop turn (the real turn 17). NOT a recorded stdout capture: producing one
// needs a model call, and the qualification run's stdout was never kept (see above). The event ORDER and FIELDS
// are taken from Pi 1.3.0's own type definitions (dist/core/agent-session.d.ts AgentSessionEvent, agent-core
// AgentEvent) and the message bodies are the scrubbed persisted turns above; ids and paths are placeholders.
const PI13_ENTRY_IDS = { user: "f13e0001", tool: "f13e0002", result: "f13e0003", stop: "f13e0004" };
const pi13Entry = (id: string, parentId: string | null, message: Record<string, unknown>) =>
  ({ type: "message", id, parentId, timestamp: "2026-10-23T15:17:54.000Z", message });
const PI13_USER = { role: "user", content: [{ type: "text", text: "<scrubbed prompt>" }], timestamp: 1792768673128 };
const PI13_RESULT = { role: "toolResult", toolCallId: "call_fixture_11|fc_fixture_11", toolName: "bash",
  content: [{ type: "text", text: "<scrubbed output>" }], isError: false, durationMs: 477, timestamp: 1792768676103 };
const PI13_TOOL_TURN = pi13Assistant(PI13_TURN_WITH_THINKING);
const PI13_STOP_TURN = pi13Assistant(17);
const PI13_RPC_TRANSCRIPT: Record<string, unknown>[] = [
  { type: "agent_start" },
  { type: "turn_start" },
  { type: "message_start", message: PI13_USER },
  { type: "message_end", message: PI13_USER },
  { type: "entry_appended", entry: pi13Entry(PI13_ENTRY_IDS.user, null, PI13_USER) },
  { type: "message_start", message: { ...PI13_TOOL_TURN, content: [], stopReason: "pending" } },
  { type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } },
  { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "<scrubbed>" } },
  { type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "<scrubbed>" } },
  { type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 1 } },
  { type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 1, toolCall: PI13_TOOL_TURN.content[1] } },
  { type: "message_end", message: PI13_TOOL_TURN },
  { type: "entry_appended", entry: pi13Entry(PI13_ENTRY_IDS.tool, PI13_ENTRY_IDS.user, PI13_TOOL_TURN) },
  { type: "tool_execution_start", toolCallId: "call_fixture_11|fc_fixture_11", toolName: "bash", args: { command: "<scrubbed command>", timeout: 20 } },
  { type: "tool_execution_update", toolCallId: "call_fixture_11|fc_fixture_11", toolName: "bash", args: { command: "<scrubbed command>" }, partialResult: { content: [{ type: "text", text: "<scrubbed partial>" }] } },
  { type: "tool_execution_end", toolCallId: "call_fixture_11|fc_fixture_11", toolName: "bash", result: { content: [{ type: "text", text: "<scrubbed output>" }] }, isError: false },
  { type: "message_start", message: PI13_RESULT },
  { type: "message_end", message: PI13_RESULT },
  { type: "entry_appended", entry: pi13Entry(PI13_ENTRY_IDS.result, PI13_ENTRY_IDS.tool, PI13_RESULT) },
  { type: "turn_end", message: PI13_TOOL_TURN, toolResults: [PI13_RESULT] },
  { type: "turn_start" },
  { type: "message_start", message: { ...PI13_STOP_TURN, content: [], stopReason: "pending" } },
  { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
  { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "<scrubbed" } },
  { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " reply>" } },
  { type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "<scrubbed reply>" } },
  { type: "message_end", message: PI13_STOP_TURN },
  { type: "entry_appended", entry: pi13Entry(PI13_ENTRY_IDS.stop, PI13_ENTRY_IDS.result, PI13_STOP_TURN) },
  { type: "turn_end", message: PI13_STOP_TURN, toolResults: [] },
  { type: "agent_end", messages: [PI13_USER, PI13_TOOL_TURN, PI13_RESULT, PI13_STOP_TURN], willRetry: false },
  { type: "agent_settled", aborted: false },
];

describe("Pi 1.3.0 RPC stdout transcript through RunnerCore (one tool turn, one stop turn)", () => {
  const run = (events: Record<string, unknown>[]) => {
    const f = fakeIo();
    const { core } = readyCore(f);
    let pane = "";
    f.io.mirrorLine = (line) => { pane += `${line}\n`; };
    f.io.mirrorAppend = (text) => { pane += text; };
    f.activity.length = 0; f.rpc.length = 0; f.sidecars.length = 0;
    for (const event of events) core.handlePiLine(JSON.stringify(event));
    return { ...f, pane };
  };

  it("shows the tool call and the reply, and posts active, PreToolUse, then exactly one Stop", () => {
    // The tool turn is the real thinking turn: its content is [thinking, toolCall] (index 11 of the 18).
    expect(PI13_TOOL_TURN.content.map(c => c.type)).toEqual(["thinking", "toolCall"]);
    expect(PI13_STOP_TURN.content.map(c => c.type)).toEqual(["text"]);
    const r = run(PI13_RPC_TRANSCRIPT);
    // The thinking turn prints nothing of its thinking, only its tool; the stop turn prints its text once. The blank
    // lines are message_end's line terminators (the user and tool-result messages also end with one, as before).
    expect(r.pane).toBe("\n\n  ⚙ bash …\n  ⚙ bash done\n\n<scrubbed reply>\n\n");
    expect(r.activity.map(a => [a.hookEvent, a.subtype])).toEqual([
      ["active", "agent_start"], ["PreToolUse", "bash"], ["Stop", "agent_end"],
    ]);
    // agent_settled is the quiet tail: it adds no second Stop and no activity of its own.
    expect(r.activity.filter(a => a.hookEvent === "Stop")).toHaveLength(1);
  });

  it("refreshes the cursor once, after agent_end, and advances it through each appended entry to the last", () => {
    const r = run(PI13_RPC_TRANSCRIPT);
    expect(r.rpc).toEqual([{ type: "get_entries", id: "pi-runner-cursor-refresh" }]);
    expect(r.sidecars.map(s => s.lastEntryId)).toEqual(
      [PI13_ENTRY_IDS.user, PI13_ENTRY_IDS.tool, PI13_ENTRY_IDS.result, PI13_ENTRY_IDS.stop]);
  });

  it("maps every Pi 1.3.0 session event the runner leaves quiet to nothing, by name", () => {
    for (const type of ["agent_settled", "entry_appended", "tool_execution_update", "session_info_changed", "thinking_level_changed",
      "summarization_retry_scheduled", "summarization_retry_attempt_start", "summarization_retry_finished", "bash_execution_update"]) {
      expect(mapPiEvent({ type }), type).toEqual({ mirrorLines: [] });
    }
  });

  it("does not take bash_execution_update's command id for a session-entry id", () => {
    const r = run([{ type: "entry_appended", entry: pi13Entry("f13e0009", null, PI13_USER) },
      { type: "bash_execution_update", id: "cmd-not-an-entry", delta: "<scrubbed>" }]);
    expect(r.sidecars.map(s => s.lastEntryId)).toEqual(["f13e0009"]);
  });
});

describe.each(["pi", "omp"] as const)("%s terminal diagnostic fallbacks", runtime => {
  const notice = (detail: string) => `[${runtime}-runner] ERROR ${detail}`;
  const unusable = ["", " \n\t ", "\u001b[2J\u001b]0;title\u0007\u202e", null, undefined, {}, 7];
  const failure = (errorMessage: unknown, error: unknown, eventError: unknown) => ({
    type: "message_end", error: eventError,
    message: { role: "assistant", stopReason: "error", errorMessage, error },
  });

  it.each(unusable)(
    "skips unusable diagnostic %j before later message and event details", detail => {
      expect(mapPiEvent(failure(detail, "message detail", "event detail"), runtime).errorNotice)
        .toBe(notice("message detail"));
      expect(mapPiEvent(failure(detail, detail, "event detail"), runtime).errorNotice)
        .toBe(notice("event detail"));
      expect(mapPiEvent(failure(detail, detail, detail), runtime).errorNotice)
        .toBe(notice("request failed"));
    },
  );

  it.each(unusable)("skips unusable finalError %j before a later retry detail", detail => {
    expect(mapPiEvent({ type: "auto_retry_end", success: false, finalError: detail, error: "retry detail" }, runtime).errorNotice)
      .toBe(notice("retry detail"));
    expect(mapPiEvent({ type: "auto_retry_end", success: false, finalError: detail, error: detail }, runtime).errorNotice)
      .toBe(notice("request failed"));
  });

  it("keeps the first usable detail and ignores errors on successful events", () => {
    expect(mapPiEvent(failure("first detail", "message detail", "event detail"), runtime).errorNotice)
      .toBe(notice("first detail"));
    expect(mapPiEvent(failure("request failed", "message detail", "event detail"), runtime).errorNotice)
      .toBe(notice("request failed"));
    expect(mapPiEvent({ type: "auto_retry_end", success: false, finalError: "final detail", error: "retry detail" }, runtime).errorNotice)
      .toBe(notice("final detail"));
    expect(mapPiEvent({ type: "auto_retry_end", success: true, finalError: "", error: "retry detail" }, runtime).errorNotice)
      .toBeUndefined();
    const event = failure("", "message detail", "event detail");
    expect(mapPiEvent({ ...event, message: { ...event.message, stopReason: "stop" } }, runtime).errorNotice)
      .toBeUndefined();
    expect(mapPiEvent({ ...event, type: "turn_end" }, runtime).errorNotice)
      .toBe(runtime === "omp" ? notice("message detail") : undefined);
  });

  it("cleans and bounds the selected fallback just like the primary detail", () => {
    const detail = "\u001b[2J\u001b]0;title\u0007bad\r\nrequest\u0000\u202e" + "x".repeat(1000);
    const expected = notice(("bad request " + "x".repeat(1000)).slice(0, 400));
    expect(mapPiEvent(failure("", detail, "event detail"), runtime).errorNotice).toBe(expected);
    expect(mapPiEvent({ type: "auto_retry_end", success: false, finalError: "", error: detail }, runtime).errorNotice)
      .toBe(expected);
  });

  it("coalesces fallback failures and resets for a later turn", () => {
    const { io, lines } = fakeIo();
    const core = new RunnerCore(io, { sessionName: SESSION, nodeId: "node-1", launchId: "launch-77" }, { runtime });
    const event = failure("", "message detail", "event detail");
    const retry = { type: "auto_retry_end", success: false, finalError: "", error: "retry detail" };
    for (const next of [event, { ...event, type: "turn_end" }, retry, retry]) core.handlePiLine(JSON.stringify(next));
    expect(lines.filter(line => line.startsWith(notice("")))).toEqual([notice("message detail")]);
    core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    core.handlePiLine(JSON.stringify(retry));
    expect(lines.filter(line => line.startsWith(notice("")))).toEqual([notice("message detail"), notice("retry detail")]);
  });
});

describe("RunnerCore terminal assistant failures", () => {
  const failure = (errorMessage?: unknown, content: unknown[] = []) => ({
    type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage, content },
  });
  const errors = (lines: string[]) => lines.filter(line => line.startsWith("[pi-runner] ERROR"));

  it.each([
    ["openrouter", "OPENROUTER_API_KEY"], ["zai", "ZAI_API_KEY"], ["kimi-coding", "KIMI_API_KEY"],
  ])("explains the existing %s credential route at RPC and model failure", (provider, key) => {
    const { core, lines } = readyCore();
    const detail = `No API key found for ${provider}.`;
    core.handlePiLine(JSON.stringify({ type: "response", command: "prompt", success: false, error: detail }));
    core.handlePiLine(JSON.stringify(failure(detail)));
    const notices = errors(lines);
    expect(notices).toHaveLength(2);
    for (const notice of notices) {
      expect(notice).toContain(detail);
      expect(notice).toContain(`set ${key} in the daemon environment`);
      expect(notice).toContain(`add ${key} to recovery.provider_auth_env_allowlist`);
      expect(notice).toContain(`model ${provider}/<id>`);
      expect(notice).toContain("restart the daemon and relaunch the seat");
      expect(notice).toContain("Default Pi logins are not automatically shared");
    }
  });

  it("keeps missing-credentials get_state unready while giving the same route", () => {
    const { core, lines, sidecars } = readyCore();
    core.handlePiLine(JSON.stringify({ type: "response", id: "pi-runner-get-state", success: false, error: "No API key found for openrouter." }));
    expect(errors(lines)[0]).toContain("recovery.provider_auth_env_allowlist");
    expect(core.isReady()).toBe(false);
    expect(sidecars.at(-1)?.ready).toBe(false);
  });

  it("does not suggest an unsupported provider environment key", () => {
    const { core, lines } = readyCore();
    core.handlePiLine(JSON.stringify(failure("No API key found for custom-provider.")));
    expect(errors(lines)[0]).toContain("PI_CODING_AGENT_DIR (auth.json or models.json)");
    expect(errors(lines)[0]).not.toContain("provider_auth_env_allowlist");
    expect(errors(lines)[0]).not.toContain("CUSTOM_PROVIDER_API_KEY");
  });

  it("keeps unrelated errors, OMP diagnostics and successful Pi replies unchanged", () => {
    for (const detail of ["401 Unauthorized", "No model found", "Network unavailable", "API key rejected"]) {
      expect(mapPiEvent(failure(detail)).errorNotice).toBe(`[pi-runner] ERROR ${detail}`);
    }
    const detail = "No API key found for openrouter.";
    expect(mapPiEvent(failure(detail), "omp").errorNotice).toBe(`[omp-runner] ERROR ${detail}`);
    expect(mapPiEvent({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: detail }] } }).errorNotice).toBeUndefined();
  });

  it("shows an empty native error and ends partial text without replaying its content", () => {
    const { core, lines, appends } = readyCore();
    core.handlePiLine(JSON.stringify(failure('400 "field_not_allowed"')));
    expect(errors(lines)).toEqual(['[pi-runner] ERROR 400 "field_not_allowed"']);
    core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    core.handlePiLine(JSON.stringify(piUpdate({ type: "text_delta", delta: "Partial answer" })));
    core.handlePiLine(JSON.stringify(failure("connection ended", [{ type: "text", text: "Partial answer" }])));
    expect(appends).toEqual(["Partial answer"]);
    expect(lines.slice(-2)).toEqual(["", "[pi-runner] ERROR connection ended"]);
  });

  it.each([undefined, null, {}, 7, "", " \n\t "])("uses a useful fallback for invalid error detail %j", (detail) => {
    const { core, lines } = readyCore();
    core.handlePiLine(JSON.stringify(failure(detail)));
    expect(errors(lines)).toEqual(["[pi-runner] ERROR request failed"]);
  });

  it("extracts fallback error detail from message.error or event.error when errorMessage is missing", () => {
    const { core, lines } = readyCore();
    // Fallback to message.error
    core.handlePiLine(JSON.stringify({
      type: "message_end",
      message: { role: "assistant", stopReason: "error", error: "backend stream broke" },
    }));
    // Fallback to event.error
    core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    core.handlePiLine(JSON.stringify({
      type: "message_end",
      error: "upstream service unavailable",
      message: { role: "assistant", stopReason: "error" },
    }));
    // auto_retry_end fallback to event.error
    core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    core.handlePiLine(JSON.stringify({
      type: "auto_retry_end",
      success: false,
      error: "retry limit reached",
    }));
    expect(errors(lines)).toEqual([
      "[pi-runner] ERROR backend stream broke",
      "[pi-runner] ERROR upstream service unavailable",
      "[pi-runner] ERROR retry limit reached",
    ]);
  });

  it("ignores malformed message envelopes and does not dump thinking or tool arguments", () => {
    const { core, lines, appends } = readyCore();
    for (const message of [undefined, null, 7, [], { role: "user", stopReason: "error" }]) {
      core.handlePiLine(JSON.stringify({ type: "message_end", message }));
    }
    core.handlePiLine(JSON.stringify(piUpdate({ type: "thinking_delta", delta: "private-thought" })));
    core.handlePiLine(JSON.stringify(piUpdate({ type: "toolcall_delta", delta: "private-arguments" })));
    core.handlePiLine(JSON.stringify(failure(undefined, [
      { type: "thinking", thinking: "private-thought" }, { type: "toolCall", arguments: "private-arguments" },
    ])));
    expect(errors(lines)).toEqual(["[pi-runner] ERROR request failed"]);
    expect(appends).toEqual([]);
    expect(lines.join("\n")).not.toMatch(/private-thought|private-arguments/);
  });

  it("strips terminal controls, flattens newlines and bounds error notices", () => {
    const { core, lines } = readyCore();
    core.handlePiLine(JSON.stringify(failure("\u001b[2J\u001b]0;title\u0007bad\r\nrequest\u0000\u202e" + "x".repeat(1000))));
    const notice = errors(lines)[0]!;
    expect(notice).toContain("bad request");
    expect(notice).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    expect(notice).not.toContain("title");
    expect(notice.length).toBeLessThanOrEqual(420);
  });

  it("shows standalone exhausted retry once and suppresses its duplicate terminal notice", () => {
    const { core, lines } = readyCore();
    const retryEnd = { type: "auto_retry_end", success: false, finalError: "busy" };
    core.handlePiLine(JSON.stringify(retryEnd));
    core.handlePiLine(JSON.stringify(retryEnd));
    expect(errors(lines)).toEqual(["[pi-runner] ERROR busy"]);
    core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    core.handlePiLine(JSON.stringify(failure("busy")));
    core.handlePiLine(JSON.stringify({ type: "agent_end" }));
    core.handlePiLine(JSON.stringify({ type: "auto_retry_end", success: false }));
    expect(errors(lines)).toEqual(["[pi-runner] ERROR busy", "[pi-runner] ERROR busy"]);
  });

  it("resets for a subsequent successful turn and a later independent failure", () => {
    const { core, lines, appends, activity, sidecars } = readyCore();
    core.handlePiLine(JSON.stringify(failure("first failure")));
    core.handlePiLine(JSON.stringify({ type: "agent_end" }));
    core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    for (const event of PI_REPLY_EVENTS) core.handlePiLine(JSON.stringify(event));
    core.handlePiLine(JSON.stringify({ type: "auto_retry_end", success: true }));
    core.handlePiLine(JSON.stringify({ type: "agent_end" }));
    expect(appends.join("")).toBe("Hello from the mock server.");
    expect(errors(lines)).toEqual(["[pi-runner] ERROR first failure"]);
    expect(activity.at(-1)).toMatchObject({ hookEvent: "Stop", subtype: "agent_end" });
    expect(sidecars.at(-1)).toMatchObject({ ready: true, sessionFile: SESSION_FILE, launchId: "launch-77" });
    core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    core.handlePiLine(JSON.stringify({ type: "auto_retry_end", success: false, finalError: "first failure" }));
    expect(errors(lines)).toHaveLength(2);
  });
});

// ── argv contract ────────────────────────────────────────────────────────────

describe("parseRunnerArgs", () => {
  const base = ["--session-name", SESSION, "--state-root", "/sr", "--cwd", "/work", "--launch-id", "launch-77"];

  it("requires --launch-id (launch-attempt scoping, guard fold)", () => {
    const noLaunch = ["--session-name", SESSION, "--state-root", "/sr", "--cwd", "/work", "--approve"];
    expect(() => parseRunnerArgs(noLaunch)).toThrow(/--launch-id is required/);
  });

  it("requires an EXPLICIT trust flag (BR-5)", () => {
    expect(() => parseRunnerArgs(base)).toThrow(/explicit trust flag/);
    expect(parseRunnerArgs([...base, "--no-approve"]).trust).toBe("no-approve");
    expect(parseRunnerArgs([...base, "--approve"]).trust).toBe("approve");
  });

  it("refuses --session + --fork together", () => {
    expect(() => parseRunnerArgs([...base, "--approve", "--session", "/a.jsonl", "--fork", "/b.jsonl"]))
      .toThrow(/mutually exclusive/);
  });

  it("rejects unknown flags loudly", () => {
    expect(() => parseRunnerArgs([...base, "--approve", "--resume"])).toThrow(/unknown flag/);
  });
});

// ── FR-5: prepareRunnerSidecar + cursor seed (guard re-verdict fold) ─────────

describe("prepareRunnerSidecar — the cursor survives the runner's own reset", () => {
  function memFsOps(files: Record<string, string>) {
    return {
      files,
      readFile: (p: string) => { if (!(p in files)) throw new Error("ENOENT"); return files[p]!; },
      writeFile: (p: string, c: string) => { files[p] = c; },
      exists: (p: string) => p in files,
    };
  }
  const PATH = "/seat/runner-state.json";
  const prior = JSON.stringify({ ready: true, launchId: "old", lastEntryId: "entry-42", updatedAt: "t" });

  it("reads the prior cursor BEFORE overwriting, carries it in the pending record, returns it when resuming", () => {
    const fs = memFsOps({ [PATH]: prior });
    const { catchUpSince } = prepareRunnerSidecar(fs, PATH, "launch-9", true, () => "t2");
    expect(catchUpSince).toBe("entry-42");
    expect(JSON.parse(fs.files[PATH]!)).toEqual({ ready: false, launchId: "launch-9", lastEntryId: "entry-42", updatedAt: "t2" });
  });

  it("fresh/fork (not resuming) returns no catch-up but still preserves the record's cursor", () => {
    const fs = memFsOps({ [PATH]: prior });
    const { catchUpSince } = prepareRunnerSidecar(fs, PATH, "launch-9", false, () => "t2");
    expect(catchUpSince).toBeUndefined();
    expect(JSON.parse(fs.files[PATH]!).lastEntryId).toBe("entry-42");
  });

  it("absent/unreadable prior sidecar -> pending without cursor, no catch-up", () => {
    const fs = memFsOps({});
    const { catchUpSince } = prepareRunnerSidecar(fs, PATH, "launch-9", true, () => "t2");
    expect(catchUpSince).toBeUndefined();
    expect(JSON.parse(fs.files[PATH]!)).toEqual({ ready: false, launchId: "launch-9", updatedAt: "t2" });
  });

  it("COMPOSED (the guard's red-green case): prior cursor -> prepare -> RunnerCore.start sends get_entries since", () => {
    const fs = memFsOps({ [PATH]: prior });
    const { catchUpSince } = prepareRunnerSidecar(fs, PATH, "launch-9", true, () => "t2");
    const f = fakeIo();
    const core = new RunnerCore(f.io, { sessionName: SESSION, launchId: "launch-9" }, { catchUpSince });
    core.start();
    expect(f.rpc).toContainEqual({ type: "get_entries", since: "entry-42", id: "pi-runner-catch-up" });
  });

  it("the seeded cursor survives the core's own post-get_state sidecar write", () => {
    const f = fakeIo();
    const core = new RunnerCore(f.io, { sessionName: SESSION, launchId: "launch-9" }, { catchUpSince: "entry-42" });
    core.start();
    core.handlePiLine(JSON.stringify({
      type: "response", id: "pi-runner-get-state",
      data: { sessionFile: SESSION_FILE, sessionId: "0197a2f0" },
    }));
    expect(f.sidecars.at(-1)).toMatchObject({ ready: true, launchId: "launch-9", lastEntryId: "entry-42" });
  });
});

// ── QA RED fold: the cursor refreshes from get_entries, not live-event guesses ─

describe("cursor refresh via get_entries (QA RED, qitem-20260707020922)", () => {
  it("agent_end triggers a cursor-refresh get_entries request", () => {
    const { core, rpc } = readyCore();
    core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    core.handlePiLine(JSON.stringify({ type: "agent_end" }));
    expect(rpc).toContainEqual({ type: "get_entries", id: "pi-runner-cursor-refresh" });
  });

  it("the refresh response advances lastEntryId from the LAST entry and persists it", () => {
    const { core, sidecars } = readyCore();
    core.handlePiLine(JSON.stringify({
      type: "response", id: "pi-runner-cursor-refresh",
      data: { entries: [{ id: "e1" }, { id: "e2" }, { id: "e9" }] },
    }));
    expect(sidecars.at(-1)).toMatchObject({ lastEntryId: "e9", launchId: "launch-77" });
  });

  it("the catch-up response also advances the cursor (restart path)", () => {
    const f = fakeIo();
    const core = new RunnerCore(f.io, { sessionName: SESSION, launchId: "launch-9" }, { catchUpSince: "e1" });
    core.start();
    core.handlePiLine(JSON.stringify({
      type: "response", id: "pi-runner-catch-up",
      entries: [{ id: "e2" }, { id: "e3" }],
    }));
    expect(f.sidecars.at(-1)!.lastEntryId).toBe("e3");
  });

  it("an empty/id-less entries response leaves the cursor untouched (never regresses)", () => {
    const f = fakeIo();
    const core = new RunnerCore(f.io, { sessionName: SESSION, launchId: "launch-9" }, { catchUpSince: "e5" });
    core.start();
    core.handlePiLine(JSON.stringify({ type: "response", id: "pi-runner-cursor-refresh", data: { entries: [] } }));
    core.handlePiLine(JSON.stringify({
      type: "response", id: "pi-runner-get-state",
      data: { sessionFile: SESSION_FILE, sessionId: "x" },
    }));
    expect(f.sidecars.at(-1)!.lastEntryId).toBe("e5");
  });
});
