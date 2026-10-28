// y4 (paste & typed input II): OF-148 remainder, OF-151 and OF-153, decided by Jim 2026-10-27.
//  1. OF-148: text carrying a bracketed-paste end sequence (ESC[201~, or the 8-bit CSI form) is REFUSED by `rig send`
//     (paste_terminator_in_text, nothing sent) and STRIPPED by the terminal broker's bracketed `text` call only.
//  2. OF-151: the open-paste hint/flag delay is 2 s (was 10 s). The row that pins it lives in
//     of148-paste-open-send-refusal.test.ts ("stayed open 2 s (not at 1.999 s)"), which fed the editor no delay option.
//  3. OF-153: a paste that was flagged open (hint fired) and later closed leaves its text on the editor line; the runner
//     records `pasteLeftover` and `rig send` refuses until the line is empty. Ordinary partial lines never refuse.
// Deployed chain: startup.ts passes runnerSendReadinessFromAdapters(map) (pi, omp, pda) to SessionTransport.send, which
// asks PiRuntimeAdapter / PdaRuntimeAdapter.sendReadiness (reads the sidecar RunnerCore / PdaRunner write); both runners
// build their pane editor with createRunnerInput in "content" mode (wirePiRunnerInput / wirePdaRunnerInput). routes/
// transport.ts maps the refusal reason to HTTP 400; routes/terminal-ws.ts feeds TerminalSessionBroker.input.
// Production consequence of (1): tmux frames a send as a bracketed paste and leaves the inside alone, so ESC[201~ in the
// text ends the paste early and the rest arrives as typed keys (a shell runs it on the next Enter).
// Production consequence of (3): after a recovered stuck paste, the next `rig send` was pasted after the stale text and the
// two were submitted as one message. The sequences, the 2 s delay, the 180 s alive window and the key names are
// literals here; nothing imports them.
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
import { pdaSeatPaths, parsePdaRunnerState } from "../src/adapters/pda-runner-protocol.js";
import { RunnerCore, wirePiRunnerInput, type RunnerIo } from "../src/adapters/pi-runner.js";
import { wirePdaRunnerInput } from "../src/adapters/pda-runner.js";
import { createRunnerInput } from "../src/adapters/runner-pane-io.js";
import { containsPasteTerminator, stripPasteTerminators } from "../src/domain/packet-text.js";
import { TerminalSessionBroker, type BrokerTmux } from "../src/terminal/TerminalSessionBroker.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const START = "\u001b[200~";
const END = "\u001b[201~";
const CSI8_END = "\u009b201~";
const ETX = "\u0003";
const BACKSPACE = "\u007f";
const NOW = Date.UTC(2026, 9, 27, 10, 0, 0); // far from wall clock
const iso = (ms: number) => new Date(ms).toISOString();
const SESSION_FILE = "/state/pi/dev-pi@my-rig/sessions/s.jsonl";

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

// a5 (y4 review F5): variant spellings of the end marker. xterm's ctlseqs and tmux's own framing define exactly ESC[201~;
// an application's ECMA-48 parser reads the CSI parameter as a number, so these may end a paste there. Unmeasured for
// Claude Code and Codex, so the rule is the conservative one: first parameter 201 (zeros allowed), any further parameters.
const VARIANTS: Array<[string, string]> = [
  ["a leading zero", "\u001b[0201~"],
  ["several leading zeros", "\u001b[000201~"],
  ["a trailing parameter", "\u001b[201;1~"],
  ["a trailing sub-parameter", "\u001b[201:2~"],
  ["a leading zero and several parameters", "\u001b[0201;2:3;4~"],
  ["the 8-bit CSI with a leading zero", "\u009b0201~"],
  ["the 8-bit CSI with a trailing parameter", "\u009b201;5~"],
];
// ── (1) the paste-end sequence: helpers ──
describe("OF-148 paste terminator: the two pure helpers", () => {
  it.each([
    ["the 7-bit sequence", `a${END}b`],
    ["the 8-bit CSI form", `a${CSI8_END}b`],
    ["the sequence alone", END],
    ["a sequence a removal would re-join (ESC[2 + ESC[201~ + 01~)", `\u001b[2${END}01~`],
  ])("detects and strips %s", (_name, text) => {
    expect(containsPasteTerminator(text)).toBe(true);
    const stripped = stripPasteTerminators(text);
    expect(containsPasteTerminator(stripped)).toBe(false);
    expect(stripped).not.toContain("\u001b[201~");
    expect(stripped).not.toContain("\u009b201~");
  });

  it("strips only the sequence: the rest of the text is kept byte for byte", () => {
    expect(stripPasteTerminators(`one ${END}two${CSI8_END} three\nfour`)).toBe("one two three\nfour");
  });

  it("a re-joining pair is removed to the end (nothing is left to close a paste)", () => {
    expect(stripPasteTerminators(`\u001b[2${END}01~`)).toBe("");
  });

  it.each(VARIANTS)("detects and strips a variant spelling: %s", (_name, variant) => {
    const text = `a${variant}b`;
    expect(containsPasteTerminator(text)).toBe(true);
    expect(stripPasteTerminators(text)).toBe("ab");
  });
  it("a variant a removal would re-join (ESC[0 + ESC[0201~ + 201~) is removed to the end", () => {
    expect(stripPasteTerminators("\u001b[0\u001b[0201~201~")).toBe("");
  });
  it.each([
    ["a different first parameter (2010)", "\u001b[2010~"],
    ["a different first parameter (1201)", "\u001b[1201~"],
    ["the paste START with a leading zero", "\u001b[0200~"],
    ["a private marker", "\u001b[?201~"],
    ["another final byte", "\u001b[201m"],
    ["an unfinished sequence", "\u001b[201"],
    ["the printable residue with zeros", "[0201~"],
  ])("does not touch %s", (_name, text) => {
    expect(containsPasteTerminator(text)).toBe(false);
    expect(stripPasteTerminators(text)).toBe(text);
  });

  it.each([
    ["the printable residue alone", "[201~"],
    ["the paste START sequence", `${START}text`],
    ["ESC[20~ (another code)", "\u001b[20~"],
    ["8-bit CSI with another code", "\u009b200~"],
    ["plain text", "hello world"],
  ])("does not touch %s", (_name, text) => {
    expect(containsPasteTerminator(text)).toBe(false);
    expect(stripPasteTerminators(text)).toBe(text);
  });
});

// ── (1) the terminal broker strips, in the bracketed text call only ──
describe("OF-148 TerminalSessionBroker: a text message is stripped of paste terminators; keys are not", () => {
  const liveBrokers: TerminalSessionBroker[] = [];
  afterEach(() => { for (const b of liveBrokers.splice(0)) b.dispose(); });

  function broker() {
    const sendText = vi.fn(async (_name: string, _text: string) => ({ ok: true as const }));
    const sendKeys = vi.fn(async (_name: string, _keys: string[]) => ({ ok: true as const }));
    const tmux: BrokerTmux = {
      hasSession: async () => true, setWindowOption: async () => ({ ok: true }), resizeWindow: async () => ({ ok: true }),
      startPipePane: async () => ({ ok: true }), stopPipePane: async () => ({ ok: true }), sendKeys, sendText,
      capturePaneScreen: async () => null, getPaneCursorPosition: async () => null, capturePaneContent: async () => null,
    };
    const b = new TerminalSessionBroker("dev@rig", tmux, { pollMs: 10 });
    liveBrokers.push(b);
    return { b, sendText, sendKeys };
  }

  it("a 7-bit and an 8-bit terminator in a text message never reach tmux", async () => {
    const { b, sendText } = broker();
    await b.input({ type: "text", text: `echo hi${END}; rm x` });
    await b.input({ type: "text", text: `echo hi${CSI8_END}; rm x` });
    expect(sendText.mock.calls).toEqual([["dev@rig", "echo hi; rm x"], ["dev@rig", "echo hi; rm x"]]);
  });

  it("a variant spelling of the end marker in a text message never reaches tmux either (a5, F5)", async () => {
    const { b, sendText } = broker();
    for (const [, variant] of VARIANTS) await b.input({ type: "text", text: `echo hi${variant}; rm x` });
    expect(sendText.mock.calls).toEqual(VARIANTS.map(() => ["dev@rig", "echo hi; rm x"]));
  });

  it("a text message without a terminator is forwarded unchanged (multi-line, tabs, other escapes kept)", async () => {
    const { b, sendText } = broker();
    const text = "line one\n\tline two \u001b[31mred\u001b[0m [201~";
    await b.input({ type: "text", text });
    expect(sendText.mock.calls).toEqual([["dev@rig", text]]);
  });

  it("keys messages are key input and are forwarded exactly as sent, even a key list holding the sequence", async () => {
    const { b, sendText, sendKeys } = broker();
    await b.input({ type: "keys", keys: [END, "Enter"] });
    expect(sendKeys.mock.calls).toEqual([["dev@rig", [END, "Enter"]]]);
    expect(sendText).not.toHaveBeenCalled();
  });
});

// ── (1) rig send refuses ──
describe("OF-148 rig send: text carrying a paste-end sequence is refused with a named code", () => {
  const SEAT = "dev-impl@my-rig";
  const PI_SEAT = "dev-pi@my-rig";
  // Neutral pane text: today's pane logic lets a send through, so a refusal below is the terminator rule's.
  const PANE = ["you ▸ plan it", "Plan drafted.", "── idle ──"].join("\n");
  const PICKER = ["Authorize the release?", "", "❯ 1. Authorize publish (Recommended)", "  2. Roll back"].join("\n");
  let db: Database.Database;
  let dir: string;

  beforeEach(() => {
    db = createFullTestDb();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "y4-term-"));
    const rigRepo = new RigRepository(db);
    const rig = rigRepo.createRig("my-rig");
    const sessions = new SessionRegistry(db);
    for (const [seat, logical, runtime] of [[SEAT, "dev.impl", "claude-code"], [PI_SEAT, "dev.pi", "pi"]] as const) {
      const node = rigRepo.addNode(rig.id, logical, { role: "worker", runtime });
      const session = sessions.registerSession(node.id, seat);
      sessions.updateStatus(session.id, "running");
      sessions.updateBinding(node.id, { tmuxSession: seat });
    }
  });
  afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  function setup(pane: string = PANE) {
    const sendText = vi.fn(async (..._args: unknown[]) => ({ ok: true as const }));
    const sendKeys = vi.fn(async () => ({ ok: true as const }));
    const capture = vi.fn(async (..._args: unknown[]) => pane);
    const tmux: TmuxAdapter = Object.assign(mockTmuxAdapter(), {
      hasSession: async () => true, probeSession: async () => ({ state: "present" as const }), sendText, sendKeys,
      capturePaneContent: capture, getPanePid: async () => null, getPaneCommand: async () => "node",
      stopPipePane: async () => ({ ok: true as const }),
    });
    const eventBus = new EventBus(db);
    const transport = new SessionTransport({
      db, rigRepo: new RigRepository(db), sessionRegistry: new SessionRegistry(db), tmuxAdapter: tmux,
      agentActivityStore: new AgentActivityStore({ db, eventBus }), eventBus, waitForIdlePollMs: 1, now: () => new Date(NOW),
    });
    return { transport, sendText, sendKeys, capture };
  }

  it.each([
    ["the 7-bit sequence", `please run this${END} && echo pwned`],
    ["the 8-bit CSI form", `please run this${CSI8_END} && echo pwned`],
    ["a sequence a strip would re-join", `\u001b[2${END}01~ && echo pwned`],
  ])("refuses %s with paste_terminator_in_text, the remedy, and 0 bytes written", async (_name, text) => {
    const { transport, sendText, sendKeys } = setup();
    const r = await transport.send(SEAT, text);
    expect(r.ok).toBe(false);
    expect(r.sent).toBe(false);
    expect(r.reason).toBe("paste_terminator_in_text");
    expect(r.error).toContain("paste-end sequence");
    expect(r.error).toContain("Remove the sequence");
    expect(r.error).toContain("No text was sent");
    expect(sendText).not.toHaveBeenCalled();
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it.each(VARIANTS)("refuses a variant spelling of the end marker (a5, F5): %s", async (_name, variant) => {
    const { transport, sendText, sendKeys } = setup();
    const r = await transport.send(SEAT, `please run this${variant} && echo pwned`);
    expect(r).toMatchObject({ ok: false, sent: false, reason: "paste_terminator_in_text" });
    expect(sendText).not.toHaveBeenCalled();
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it("refuses before any wait or pane read: --wait-for-idle never looks at the pane", async () => {
    const { transport, sendText, capture } = setup();
    const r = await transport.send(SEAT, `x${END}y`, { waitForIdleMs: 30_000 });
    expect(r.reason).toBe("paste_terminator_in_text");
    expect(capture).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });

  it("--force does not bypass it", async () => {
    const { transport, sendText } = setup();
    const r = await transport.send(SEAT, `x${END}y`, { force: true });
    expect(r.reason).toBe("paste_terminator_in_text");
    expect(sendText).not.toHaveBeenCalled();
  });

  it("--dangerously-interact does not open a bracketed send to it: with no prompt to drive the delivery is still refused", async () => {
    const { transport, sendText } = setup();
    const r = await transport.send(SEAT, `x${END}y`, { dangerouslyInteract: true, reason: "drive it", actorSession: "orch@my-rig" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("paste_terminator_in_text");
    expect(sendText).not.toHaveBeenCalled();
  });

  it("an audited prompt answer is unbracketed key input, so it is not this rule's: it is delivered as before", async () => {
    const { transport, sendText } = setup(PICKER);
    const r = await transport.send(SEAT, `1${END}`, { dangerouslyInteract: true, reason: "unblock the release prompt", actorSession: "orch@my-rig" });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(sendText).toHaveBeenCalledWith(SEAT, `1${END}`, undefined, { bracketed: false });
  });

  it("controls: the printable residue, the paste START sequence and plain text are delivered (the rule is not broader than the two sequences)", async () => {
    for (const text of ["see [201~ in the log", `${START}wrapped`, "hello"]) {
      const { transport, sendText } = setup();
      const r = await transport.send(SEAT, text);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(sendText).toHaveBeenCalledTimes(1);
    }
  });

  it("a runner-hosted seat gets the same rule, and it wins over a runner refusal's wording (nothing sent either way)", async () => {
    const { transport, sendText } = setup();
    const r = await transport.send(PI_SEAT, `x${END}y`);
    expect(r.reason).toBe("paste_terminator_in_text");
    expect(sendText).not.toHaveBeenCalled();
  });
});

// ── (3) the editor reports a recovered lost paste ──
describe("OF-153 pane editor: a flagged-open paste that closed leaves its text on the line, and that is reported", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function editor(options: { content?: boolean; throwing?: boolean; withInterrupt?: boolean } = {}) {
    const t = terminal();
    const events: string[] = [];
    const submitted: string[] = [];
    const rl = createRunnerInput(t.stdin, t.stdout, (block) => submitted.push(block), {
      ...(options.content === false ? {} : { interruptInsidePaste: "content" as const }),
      ...(options.withInterrupt ? { onInterrupt: () => undefined } : {}),
      onPasteOpenChange: (open) => events.push(`open:${open}`),
      onPasteLeftoverChange: (held) => { events.push(`leftover:${held}`); if (options.throwing) throw new Error("sidecar write failed"); },
    });
    return { ...t, rl, events, submitted };
  }

  it("a paste that stays open past the hint and then closes reports leftover BEFORE the open flag clears", () => {
    const t = editor();
    try {
      t.input.write(START + "stale");
      vi.advanceTimersByTime(2_000);
      expect(t.events).toEqual(["open:true"]);
      t.input.write(END);
      expect(t.events).toEqual(["open:true", "leftover:true", "open:false"]);
    } finally { t.rl.close(); }
  });

  it("a paste that closes before the hint never reports (an ordinary paste is not blocked)", () => {
    const t = editor();
    try {
      t.input.write(START + "fine" + END);
      vi.advanceTimersByTime(60_000);
      expect(t.events).toEqual([]);
    } finally { t.rl.close(); }
  });

  it("ordinary typing and a partial line never report", () => {
    const t = editor();
    try {
      t.input.write("half typed message");
      vi.advanceTimersByTime(60_000);
      expect(t.events).toEqual([]);
    } finally { t.rl.close(); }
  });

  it("the hint's own way out (Esc, then [201~ typed by hand) also leaves the line held", () => {
    const t = editor();
    try {
      t.input.write(START + "torn");
      vi.advanceTimersByTime(2_000);
      t.input.write("\u001b");
      t.input.write("[201~");
      expect(t.events).toEqual(["open:true", "leftover:true", "open:false"]);
    } finally { t.rl.close(); }
  });

  it("Ctrl-C clears the line and reports it free", () => {
    const t = editor({ withInterrupt: true });
    try {
      t.input.write(START + "stale");
      vi.advanceTimersByTime(2_000);
      t.input.write(END);
      t.input.write(ETX);
      expect(t.events).toEqual(["open:true", "leftover:true", "open:false", "leftover:false"]);
      expect(t.submitted).toEqual([]);
    } finally { t.rl.close(); }
  });

  it("Enter submits the stale text and reports the line free", () => {
    const t = editor();
    try {
      t.input.write(START + "stale");
      vi.advanceTimersByTime(2_000);
      t.input.write(END);
      t.input.write("\r");
      expect(t.submitted).toEqual(["stale"]);
      expect(t.events).toEqual(["open:true", "leftover:true", "open:false", "leftover:false"]);
    } finally { t.rl.close(); }
  });

  it("backspacing the line empty reports it free; one character left still holds it", () => {
    const t = editor();
    try {
      t.input.write(START + "ab");
      vi.advanceTimersByTime(2_000);
      t.input.write(END);
      t.input.write(BACKSPACE);
      expect(t.events.at(-1)).toBe("open:false");
      t.input.write(BACKSPACE);
      expect(t.events).toEqual(["open:true", "leftover:true", "open:false", "leftover:false"]);
    } finally { t.rl.close(); }
  });

  it("an empty lost paste and an over-limit (discarded) one leave nothing on the line, so report nothing", () => {
    const t = editor();
    try {
      t.input.write(START);
      vi.advanceTimersByTime(2_000);
      t.input.write(END);
      expect(t.events).toEqual(["open:true", "open:false"]);
      t.events.length = 0;
      t.input.write(START + "x".repeat(1024 * 1024 + 1));
      vi.advanceTimersByTime(2_000);
      t.input.write(END);
      expect(t.events).toEqual(["open:true", "open:false"]);
    } finally { t.rl.close(); }
  });

  it.each([
    ["spaces", "   "],
    ["newlines", "\n\n"],
  ])("a recovered paste of only %s still holds the line: it is text the next send would be appended to", (_name, body) => {
    const t = editor();
    try {
      t.input.write(START + body);
      vi.advanceTimersByTime(2_000);
      t.input.write(END);
      t.input.write("x"); // any later key runs the settle check again
      expect(t.events).toEqual(["open:true", "leftover:true", "open:false"]);
    } finally { t.rl.close(); }
  });

  it("closing the editor while the line is held reports it free", () => {
    const t = editor();
    t.input.write(START + "stale");
    vi.advanceTimersByTime(2_000);
    t.input.write(END);
    t.rl.close();
    expect(t.events.at(-1)).toBe("leftover:false");
  });

  it("a second lost paste after the line was cleared reports again", () => {
    const t = editor({ withInterrupt: true });
    try {
      for (let i = 0; i < 2; i++) {
        t.input.write(START + "stale");
        vi.advanceTimersByTime(2_000);
        t.input.write(END);
        t.input.write(ETX);
      }
      expect(t.events.filter((e) => e === "leftover:true")).toHaveLength(2);
      expect(t.events.filter((e) => e === "leftover:false")).toHaveLength(2);
    } finally { t.rl.close(); }
  });

  it("control: in the default (Ctrl-C ends a paste) mode nothing is ever reported", () => {
    const t = editor({ content: false });
    try {
      t.input.write(START + "stale");
      vi.advanceTimersByTime(60_000);
      t.input.write(END);
      expect(t.events).toEqual([]);
    } finally { t.rl.close(); }
  });

  it("a report that throws (a sidecar write failing) does not break the editor", () => {
    const t = editor({ throwing: true });
    try {
      t.input.write(START + "stale");
      vi.advanceTimersByTime(2_000);
      expect(() => t.input.write(END)).not.toThrow();
      t.input.write("\r");
      expect(t.submitted).toEqual(["stale"]);
    } finally { t.rl.close(); }
  });

  it("wiring: a core/runner without setPasteLeftover (an older double) is not called", () => {
    const t = terminal();
    const rl = wirePiRunnerInput({ handleUserBlock: () => undefined }, t.stdin, t.stdout);
    try {
      t.input.write(START + "stale");
      vi.advanceTimersByTime(2_000);
      expect(() => t.input.write(END)).not.toThrow();
    } finally { rl.close(); }
  });

  it("wiring: the Pi and pda wire functions pass the edge to setPasteLeftover", () => {
    const setPi = vi.fn();
    const a = terminal();
    const rlPi = wirePiRunnerInput({ handleUserBlock: () => undefined, setPasteOpen: () => undefined, setPasteLeftover: setPi }, a.stdin, a.stdout);
    const setPda = vi.fn();
    const b = terminal();
    const rlPda = wirePdaRunnerInput({ submit: () => undefined, interrupted: () => undefined, setPasteOpen: () => undefined, setPasteLeftover: setPda }, b.stdin, b.stdout);
    try {
      for (const t of [a, b]) {
        t.input.write(START + "stale");
        vi.advanceTimersByTime(2_000);
        t.input.write(END);
      }
      expect(setPi.mock.calls).toEqual([[true]]);
      expect(setPda.mock.calls).toEqual([[true]]);
    } finally { rlPi.close(); rlPda.close(); }
  });
});

// ── (3) the Pi/OMP runner records it ──
describe("OF-153 Pi/OMP runner: the sidecar carries pasteLeftover only while the line holds a recovered paste", () => {
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

  it.each(["pi", "omp"] as const)("%s: held writes at once with the key; ticks keep it; free writes at once without it", (runtime) => {
    const clock = { t: NOW };
    const { c, sidecars, ready } = core(runtime, clock);
    c.start();
    ready();
    expect("pasteLeftover" in sidecars.at(-1)!).toBe(false);
    const before = sidecars.length;
    c.setPasteLeftover(true);
    expect(sidecars.length).toBe(before + 1);
    expect(sidecars.at(-1)).toMatchObject({ ready: true, pasteLeftover: true });
    clock.t = NOW + 60_000;
    c.tickAlive();
    expect(sidecars.at(-1)).toMatchObject({ pasteLeftover: true, aliveAt: iso(NOW + 60_000) });
    c.setPasteLeftover(false);
    expect("pasteLeftover" in sidecars.at(-1)!).toBe(false);
    expect(sidecars.at(-1)).toMatchObject({ ready: true });
  });

  it("the key is independent of pasteOpen: both can be true in one record, each clears on its own", () => {
    const { c, sidecars, ready } = core("pi", { t: NOW });
    c.start();
    ready();
    c.setPasteOpen(true);
    c.setPasteLeftover(true);
    expect(sidecars.at(-1)).toMatchObject({ pasteOpen: true, pasteLeftover: true });
    c.setPasteOpen(false);
    expect(sidecars.at(-1)).toMatchObject({ pasteLeftover: true });
    expect("pasteOpen" in sidecars.at(-1)!).toBe(false);
  });

  it("the child exiting drops it: the exited record is the last word and carries no flag", () => {
    const { c, sidecars, ready } = core("pi", { t: NOW });
    c.start();
    ready();
    c.setPasteLeftover(true);
    c.handlePiExit(1);
    expect(sidecars.at(-1)).toMatchObject({ exited: { code: 1 } });
    expect("pasteLeftover" in sidecars.at(-1)!).toBe(false);
  });

  it("before ready nothing is written, but the flag is kept for the first ready write", () => {
    const { c, sidecars, ready } = core("pi", { t: NOW });
    c.start();
    const before = sidecars.length;
    c.setPasteLeftover(true);
    expect(sidecars.length).toBe(before);
    ready();
    expect(sidecars.at(-1)).toMatchObject({ ready: true, pasteLeftover: true });
  });

  it("the parsers read a boolean and refuse a non-boolean (an unreadable record is no answer, never 'free')", () => {
    const pi = { ready: true, updatedAt: iso(NOW), busy: false };
    expect(parsePiRunnerState(JSON.stringify({ ...pi, pasteLeftover: true }))).toMatchObject({ pasteLeftover: true });
    expect(parsePiRunnerState(JSON.stringify(pi))).not.toBeNull();
    expect(parsePiRunnerState(JSON.stringify({ ...pi, pasteLeftover: "yes" }))).toBeNull();
    expect(parsePiRunnerState(JSON.stringify({ ...pi, pasteLeftover: 1 }))).toBeNull();
  });
});

// ── (3) the pda runner records it ──
describe("OF-153 pda runner: the sidecar carries pasteLeftover only while the line holds a recovered paste", () => {
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

  it("held writes at once with the key; free removes it at once; the rest of the record is intact", async () => {
    const rig = await attached();
    expect(rig.sidecar()).not.toHaveProperty("pasteLeftover");
    rig.runner.setPasteLeftover(true);
    expect(rig.sidecar()).toMatchObject({ ready: true, connected: true, pasteLeftover: true });
    expect(parsePdaRunnerState(rig.sidecarRaw())).toMatchObject({ pasteLeftover: true });
    rig.runner.setPasteLeftover(false);
    expect(rig.sidecar()).not.toHaveProperty("pasteLeftover");
    expect(rig.sidecar()).toMatchObject({ ready: true });
  });

  it("after the runner finished, the exited record is the last word: nothing is rewritten and no flag appears", async () => {
    const rig = await attached();
    await rig.stop();
    const stopped = rig.sidecarRaw();
    await new Promise((r) => setTimeout(r, 25));
    rig.runner.setPasteLeftover(true);
    expect(rig.sidecarRaw()).toBe(stopped);
    expect(rig.sidecar()).not.toHaveProperty("pasteLeftover");
  });

  it("a held leftover does not survive the runner exiting: the exited record carries no flag", async () => {
    const rig = await attached();
    rig.runner.setPasteLeftover(true);
    expect(rig.sidecar()).toMatchObject({ pasteLeftover: true });
    await rig.stop();
    expect(rig.sidecar().exited).toBeDefined();
    expect(rig.sidecar()).not.toHaveProperty("pasteLeftover");
  });

  it("through the real editor: a lost paste recovered by its marker is in the sidecar until the line is cleared", async () => {
    const rig = await attached();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = terminal();
    const rl = wirePdaRunnerInput(rig.runner, t.stdin, t.stdout);
    try {
      t.input.write(START + "stale");
      vi.advanceTimersByTime(2_000);
      expect(rig.sidecar()).toMatchObject({ pasteOpen: true });
      expect(rig.sidecar()).not.toHaveProperty("pasteLeftover");
      t.input.write(END);
      expect(rig.sidecar()).toMatchObject({ pasteLeftover: true });
      expect(rig.sidecar()).not.toHaveProperty("pasteOpen");
      t.input.write(ETX);
      expect(rig.sidecar()).not.toHaveProperty("pasteLeftover");
    } finally { rl.close(); }
  });

  it("the parser reads a boolean and refuses a non-boolean", async () => {
    const rig = await attached();
    const base = rig.sidecar();
    expect(parsePdaRunnerState(JSON.stringify({ ...base, pasteLeftover: true }))).toMatchObject({ pasteLeftover: true });
    expect(parsePdaRunnerState(JSON.stringify(base))).not.toBeNull();
    expect(parsePdaRunnerState(JSON.stringify({ ...base, pasteLeftover: "yes" }))).toBeNull();
  });
});

// ── (3) the daemon refuses ──
describe("OF-153 daemon: rig send to a runner seat whose line holds a recovered paste refuses; ordinary partial lines do not", () => {
  const PI_SEAT = "dev-pi@my-rig";
  const OMP_SEAT = "dev-omp@my-rig";
  const PDA_SEAT = "dev-pda@my-rig";
  const PANE = ["you ▸ plan it", "Plan drafted.", "── idle ──"].join("\n");
  let db: Database.Database;
  let dir: string;
  let piRoot: string;
  let pdaRoot: string;

  beforeEach(() => {
    db = createFullTestDb();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "y4-left-"));
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

  function setup(options: { clock?: { t: number } } = {}) {
    const clock = options.clock ?? { t: NOW };
    const sendText = vi.fn(async (..._args: unknown[]) => ({ ok: true as const }));
    const sendKeys = vi.fn(async () => ({ ok: true as const }));
    const tmux: TmuxAdapter = Object.assign(mockTmuxAdapter(), {
      hasSession: async () => true, probeSession: async () => ({ state: "present" as const }), sendText, sendKeys,
      capturePaneContent: async () => PANE, getPanePid: async () => null, getPaneCommand: async () => "node",
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

  const SEATS = [
    ["pi", PI_SEAT, (over: Record<string, unknown> = {}) => piSidecar(PI_SEAT, over)],
    ["omp", OMP_SEAT, (over: Record<string, unknown> = {}) => piSidecar(OMP_SEAT, over)],
    ["pda", PDA_SEAT, (over: Record<string, unknown> = {}) => pdaSidecar(over)],
  ] as const;

  describe.each(SEATS)("%s seat", (runtime, seat, write) => {
    it("a default send is refused: named code, the leftover reason, 'Ctrl-C clears the line' per runtime, 0 bytes", async () => {
      write({ pasteLeftover: true });
      const { transport, sendText, sendKeys } = setup();
      const r = await transport.send(seat, "hello");
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("target_needs_input");
      expect(r.activity).toMatchObject({ state: "needs_input", reason: "paste_leftover", evidenceSource: "runner_sidecar" });
      expect(r.error).toContain(seat);
      expect(r.error).toContain("left on its runner's input line");
      expect(r.error).toContain(runtime === "pda" ? "Ctrl-C clears the line (so does" : "Ctrl-C clears the line and aborts the current turn (so does");
      if (runtime === "pda") expect(r.error).not.toContain("abort");
      expect(r.error).toContain("No text was sent");
      expect(r.error).not.toContain("--dangerously-interact");
      expect(sendText).not.toHaveBeenCalled();
      expect(sendKeys).not.toHaveBeenCalled();
    });

    it("--dangerously-interact (runner_input_no_override), --force and --wait-for-idle are refused with the same wording, 0 bytes", async () => {
      write({ pasteLeftover: true });
      const { transport, sendText } = setup();
      const interact = await transport.send(seat, "hello", { dangerouslyInteract: true, reason: "drive it" });
      expect(interact.reason).toBe("runner_input_no_override");
      const force = await transport.send(seat, "hello", { force: true });
      expect(force.reason).toBe("target_needs_input");
      const wait = await transport.send(seat, "hello", { waitForIdleMs: 50 });
      expect(wait.reason).toBe("target_needs_input");
      for (const r of [interact, force, wait]) expect(r.error).toContain("left on its runner's input line");
      expect(sendText).not.toHaveBeenCalled();
      const audits = db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'transport.prompt_override'").get() as { n: number };
      expect(audits.n).toBe(0);
    });

    it("controls: an older runner (no key), pasteLeftover false, and an ordinary partial line all deliver as today", async () => {
      for (const over of [{}, { pasteLeftover: false }]) {
        write(over);
        const t = setup();
        expect((await t.transport.send(seat, "hello")).ok).toBe(true);
        expect(t.sendText).toHaveBeenCalledTimes(1);
      }
    });

    it("once the runner rewrites the sidecar after the line was cleared, the very next send goes", async () => {
      write({ pasteLeftover: true });
      const { transport, sendText } = setup();
      expect((await transport.send(seat, "first")).ok).toBe(false);
      write({});
      const r = await transport.send(seat, "second");
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(sendText).toHaveBeenCalledTimes(1);
    });

    it("a stale flag refuses nothing forever: past the 180 s alive window there is no runner answer", async () => {
      write({ pasteLeftover: true, aliveAt: iso(NOW - 181_000) });
      const { transport, sendText } = setup();
      expect((await transport.send(seat, "hello")).ok).toBe(true);
      expect(sendText).toHaveBeenCalledTimes(1);
    });

    it("an exited or not-ready runner's stale flag is not read", async () => {
      write({ pasteLeftover: true, ready: false, exited: { code: 1, at: iso(NOW) } });
      expect((await setup().transport.send(seat, "hello")).ok).toBe(true);
      write({ pasteLeftover: true, ready: false });
      expect((await setup().transport.send(seat, "hello")).ok).toBe(true);
    });

    it("an open paste still wins: with both flags the answer and the wording are the open paste's", async () => {
      write({ pasteOpen: true, pasteLeftover: true });
      const { transport } = setup();
      const r = await transport.send(seat, "hello");
      expect(r.activity).toMatchObject({ reason: "paste_open" });
      expect(r.error).toContain("paste still open");
      expect(r.error).not.toContain("left on its runner's input line");
    });

    it("a non-boolean pasteLeftover is an unreadable record: no runner answer, so today's pane logic decides (as for a non-boolean pasteOpen, x1)", async () => {
      write({ pasteLeftover: "yes" });
      const { transport, pi, omp, pda } = setup();
      const adapter = seat === PDA_SEAT ? pda : seat === OMP_SEAT ? omp : pi;
      expect(await adapter.sendReadiness({ sessionName: seat, nodeId: null })).toBeNull();
      expect((await transport.send(seat, "hello")).ok).toBe(true);
    });
  });

  it("pda: a held message keeps its own answer over the leftover", async () => {
    pdaSidecar({ pasteLeftover: true, held: { requestId: "r1", code: "pda_message_held", at: iso(NOW) } });
    const { transport } = setup();
    const r = await transport.send(PDA_SEAT, "hello");
    expect(r.ok).toBe(false);
    expect(r.activity).toMatchObject({ state: "needs_input", reason: "pda_message_held" });
  });
});
