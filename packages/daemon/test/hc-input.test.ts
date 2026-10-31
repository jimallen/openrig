import { describe, expect, it } from "vitest";
import type { HcClient, HcTerminal } from "../src/adapters/hc-client.js";
import { HcError, HcOutcomeUnknownError, HcUnavailableError } from "../src/adapters/hc-client.js";
import type { HcAttachEnd, HcAttachHandlers, HcAttachOpener, HcAttachParams, HcAttachment } from "../src/adapters/hc-attach.js";
import { hcTerminalName } from "../src/adapters/hc-host.js";
import { HcInput, bracketedPasteOn, mapTmuxKeys, type HcInputGuard } from "../src/adapters/hc-input.js";
import { DeliveryGuardError } from "../src/domain/seat-delivery-guard.js";
import type { TmuxFileOps } from "../src/adapters/tmux.js";

const SEAT = "qa@rig";
const ADDRESS = hcTerminalName(SEAT);

function terminal(over: Partial<HcTerminal> = {}): HcTerminal {
  return { address: "t4", name: ADDRESS, labels: {}, argv: [], cwd: "/", state: "live", created_ms: 0, screen: "exact", cols: 120, rows: 40, ...over };
}

type Call = { method: string; params: Record<string, unknown>; timeoutMs?: number };

/** A client that answers from a table of method to result-or-error, and records every call. */
function fakeClient(answers: Record<string, unknown | (() => unknown)>): { client: HcClient; calls: Call[] } {
  const calls: Call[] = [];
  const client = {
    async call(method: string, params: Record<string, unknown> = {}, options: { timeoutMs?: number } = {}) {
      calls.push({ method, params, timeoutMs: options.timeoutMs });
      const answer = answers[method];
      const value = typeof answer === "function" ? (answer as () => unknown)() : answer;
      if (value instanceof Error) throw value;
      return value;
    },
  } as unknown as HcClient;
  return { client, calls };
}

interface Attached { opened: HcAttachParams[]; written: Buffer[]; detached: number; events: string[] }

/** An opener whose attachment paints `paint` on open, records writes, and ends as `detach` says. */
function fakeAttach(paint: string | string[] | null, options: { detach?: HcAttachEnd; failOpen?: Error; endAfterPaint?: HcAttachEnd; streamEveryMs?: number } = {}): { opener: HcAttachOpener; seen: Attached } {
  const seen: Attached = { opened: [], written: [], detached: 0, events: [] };
  const opener: HcAttachOpener = {
    async open(params: HcAttachParams, handlers: HcAttachHandlers): Promise<HcAttachment> {
      if (options.failOpen) throw options.failOpen;
      seen.opened.push(params);
      seen.events.push("open");
      const chunks = paint === null ? [] : typeof paint === "string" ? [paint] : paint;
      chunks.forEach((chunk, i) => setTimeout(() => handlers.onData(Buffer.from(chunk, "latin1")), i * 12));
      // A program that never stops painting: output every few ms until the write goes in.
      if (options.streamEveryMs) {
        const timer = setInterval(() => { if (seen.written.length > 0) clearInterval(timer); else handlers.onData(Buffer.from(".")); }, options.streamEveryMs);
      }
      if (options.endAfterPaint) setTimeout(() => handlers.onEnd(options.endAfterPaint!), 0);
      return {
        terminal: terminal(), observe: false,
        write: (data) => { seen.events.push("write"); seen.written.push(typeof data === "string" ? Buffer.from(data) : data); },
        resize: () => {},
        detach: async () => { seen.detached++; seen.events.push("detach"); return options.detach ?? { reason: "detached" }; },
      };
    },
  };
  return { opener, seen };
}

const FAST = { paintSettleMs: 5, paintMaxMs: 50, paintFirstMs: 80 };
const BRACKETED_PAINT = "\x1b[!p\x1b[?2004l\x1b[H\x1b[2J\x1b[?2004hREADY";
const PLAIN_PAINT = "\x1b[!p\x1b[?2004l\x1b[H\x1b[2JREADY";

describe("mapTmuxKeys", () => {
  it.each([
    [["Enter"], ["enter"]], [["Escape"], ["esc"]], [["BTab"], ["shift+tab"]], [["BSpace"], ["backspace"]], [["DC"], ["delete"]], [["IC"], ["insert"]],
    [["PgUp"], ["pageup"]], [["PageDown"], ["pagedown"]], [["NPage"], ["pagedown"]], [["F5"], ["f5"]], [["Up", "Left"], ["up", "left"]],
    [["C-c"], ["ctrl+c"]], [["C-C"], ["ctrl+c"]], [["M-x"], ["alt+x"]], [["S-Up"], ["shift+up"]], [["C-Space"], ["ctrl+space"]],
    [["3"], ["3"]], [["a"], ["a"]], [["/"], ["/"]], [["-"], ["-"]],
    [["A"], ["shift+a"]], [["Z"], ["shift+z"]],
    [["", "a", ""], ["a"]], [["", ""], []],
  ])("maps %j to %j", (keys, expected) => {
    expect(mapTmuxKeys(keys)).toEqual({ ok: true, keys: expected });
  });

  it.each([["hello"], [":"], ["é"], [" "], ["M-X"], ["C-["], ["C-M-x"], ["F13"], ["KP1"], ["enter"], ["ctrl+c"]])("refuses %j, naming it", (key) => {
    expect(mapTmuxKeys(["a", key])).toEqual({ ok: false, key });
  });
});

describe("bracketedPasteOn", () => {
  it.each([
    ["\x1b[?2004h", true], ["\x1b[?2004l", false], ["", false],
    ["\x1b[?2004l\x1b[?2004h", true], ["\x1b[?2004h\x1b[?2004l", false],
    ["\x1b[?1004;2004h", true], ["\x1b[?2004;1004l", false],
    ["\x1b[?12004h", false], ["\x1b[?20040h", false], ["\x1b[2004h", false],
  ])("reads %j as %s", (bytes, on) => {
    expect(bracketedPasteOn(bytes)).toBe(on);
  });
});

describe("HcInput.sendText", () => {
  const live = { "terminal.get": terminal() };

  it("attaches as a writer at the terminal's own size, brackets for a bracketed program, and detaches", async () => {
    const { client, calls } = fakeClient(live);
    const { opener, seen } = fakeAttach(BRACKETED_PAINT);
    await expect(new HcInput(client, opener, FAST).sendText(SEAT, "hello")).resolves.toEqual({ ok: true });
    expect(calls).toEqual([{ method: "terminal.get", params: { terminal: ADDRESS }, timeoutMs: undefined }]);
    expect(seen.opened).toEqual([{ terminal: "t4", cols: 120, rows: 40 }]);
    expect(seen.written.map((b) => b.toString())).toEqual(["\x1b[200~hello\x1b[201~"]);
    expect(seen.events.slice(0, 3)).toEqual(["open", "write", "detach"]);
  });

  it("waits out a first paint that comes in pieces, so a mode stated in a later piece still counts", async () => {
    const { opener, seen } = fakeAttach(["\x1b[!p\x1b[?2004l\x1b[H", "READY\x1b[?2004h"]);
    await new HcInput(fakeClient(live).client, opener, { paintSettleMs: 40, paintMaxMs: 400, paintFirstMs: 200 }).sendText(SEAT, "x");
    expect(seen.written.map((b) => b.toString())).toEqual(["\x1b[200~x\x1b[201~"]);
  });

  it("stops waiting for the paint of a program that never stops writing, after paintMaxMs", async () => {
    const { opener, seen } = fakeAttach(["\x1b[?2004h"], { streamEveryMs: 3 });
    await new HcInput(fakeClient(live).client, opener, { paintSettleMs: 30, paintMaxMs: 90, paintFirstMs: 200 }).sendText(SEAT, "x");
    expect(seen.written.map((b) => b.toString())).toEqual(["\x1b[200~x\x1b[201~"]);
  });

  it("writes the text as it stands to a program that did not turn bracketed paste on", async () => {
    const { opener, seen } = fakeAttach(PLAIN_PAINT);
    await new HcInput(fakeClient(live).client, opener, FAST).sendText(SEAT, "a\nb");
    expect(seen.written.map((b) => b.toString())).toEqual(["a\nb"]);
  });

  it("never brackets key input, and does not wait for a paint it does not need", async () => {
    const { opener, seen } = fakeAttach(null);
    await expect(new HcInput(fakeClient(live).client, opener, FAST).sendText(SEAT, "3", undefined, { bracketed: false })).resolves.toEqual({ ok: true });
    expect(seen.written.map((b) => b.toString())).toEqual(["3"]);
  });

  it("writes nothing and says why when no first paint tells the paste mode", async () => {
    const { opener, seen } = fakeAttach(null);
    await expect(new HcInput(fakeClient(live).client, opener, FAST).sendText(SEAT, "x")).resolves.toMatchObject({ ok: false, code: "paste_mode_unknown" });
    expect(seen.written).toEqual([]);
    expect(seen.detached).toBeGreaterThan(0);
  });

  it("refuses text that holds the paste-end sequence only when it would bracket it", async () => {
    const text = "a\x1b[201~b";
    const bracketed = fakeAttach(BRACKETED_PAINT);
    await expect(new HcInput(fakeClient(live).client, bracketed.opener, FAST).sendText(SEAT, text)).resolves.toMatchObject({ ok: false, code: "paste_terminator" });
    expect(bracketed.seen.written).toEqual([]);
    const plain = fakeAttach(PLAIN_PAINT);
    await expect(new HcInput(fakeClient(live).client, plain.opener, FAST).sendText(SEAT, text)).resolves.toEqual({ ok: true });
    expect(plain.seen.written.map((b) => b.toString())).toEqual([text]);
  });

  it("does nothing for empty text", async () => {
    const { client, calls } = fakeClient(live);
    const { opener, seen } = fakeAttach(PLAIN_PAINT);
    await expect(new HcInput(client, opener, FAST).sendText(SEAT, "")).resolves.toEqual({ ok: true });
    expect(calls).toEqual([]);
    expect(seen.opened).toEqual([]);
  });

  it("refuses a blocked program by default, naming what it asked, and writes nothing", async () => {
    const blocked = terminal({ status: { state: "blocked", kind: "permission" } });
    const { opener, seen } = fakeAttach(PLAIN_PAINT);
    const result = await new HcInput(fakeClient({ "terminal.get": blocked }).client, opener, FAST).sendText(SEAT, "x");
    expect(result).toMatchObject({ ok: false, code: "seat_blocked" });
    expect(result.ok === false && result.message).toContain("permission");
    expect(seen.opened).toEqual([]);
    const allowed = fakeAttach(PLAIN_PAINT);
    await expect(new HcInput(fakeClient({ "terminal.get": blocked }).client, allowed.opener, FAST).sendText(SEAT, "x", undefined, { blocked: "allow" })).resolves.toEqual({ ok: true });
  });

  it("reads a finished terminal as session_not_found", async () => {
    const { opener } = fakeAttach(PLAIN_PAINT);
    await expect(new HcInput(fakeClient({ "terminal.get": terminal({ state: "finished", reason: "killed" }) }).client, opener, FAST).sendText(SEAT, "x"))
      .resolves.toMatchObject({ ok: false, code: "session_not_found" });
  });

  it("treats a failed attach as nothing delivered, whatever the failure", async () => {
    const reasons: Array<[Error, string]> = [
      [new HcUnavailableError("no socket"), "transport_unavailable"],
      [new HcOutcomeUnknownError("no reply", "terminal.attach"), "transport_unavailable"],
      [new HcError("m", "finished", -32000), "session_not_found"],
    ];
    for (const [failOpen, code] of reasons) {
      const { opener } = fakeAttach(PLAIN_PAINT, { failOpen });
      await expect(new HcInput(fakeClient(live).client, opener, FAST).sendText(SEAT, "x")).resolves.toMatchObject({ ok: false, code });
    }
  });

  it("does not call a write a success when the core never confirmed it", async () => {
    for (const detach of [{ reason: "no_answer" }, { reason: "core_lost" }] as HcAttachEnd[]) {
      const { opener } = fakeAttach(PLAIN_PAINT, { detach });
      await expect(new HcInput(fakeClient(live).client, opener, FAST).sendText(SEAT, "x")).resolves.toMatchObject({ ok: false, code: "delivery_outcome_unknown" });
    }
    const ended = fakeAttach(PLAIN_PAINT, { detach: { reason: "program_ended", exitCode: 0, signal: null, endReason: "exited", finishedMs: 1 } });
    await expect(new HcInput(fakeClient(live).client, ended.opener, FAST).sendText(SEAT, "x")).resolves.toMatchObject({ ok: false, code: "session_not_found" });
  });

  it("writes nothing when the program ended before the write", async () => {
    const { opener, seen } = fakeAttach(PLAIN_PAINT, { endAfterPaint: { reason: "program_ended", exitCode: 0, signal: null, endReason: "exited", finishedMs: 1 } });
    await expect(new HcInput(fakeClient(live).client, opener, FAST).sendText(SEAT, "x")).resolves.toMatchObject({ ok: false, code: "session_not_found" });
    expect(seen.written).toEqual([]);
  });
});

/** The delivery guard: the lease wraps the work and the synchronous check comes right before the write. */
describe("the delivery guard", () => {
  function guardLog(checkError?: Error): { guard: HcInputGuard; log: string[] } {
    const log: string[] = [];
    const guard: HcInputGuard = {
      input: async (name, fn) => { log.push(`input:${name}`); const out = await fn(); log.push("input-done"); return out; },
      checkInput: (name) => { log.push(`check:${name}`); if (checkError) throw checkError; },
    };
    return { guard, log };
  }

  it("takes the lease for the seat, checks just before the write, then calls beforeInput", async () => {
    const { guard, log } = guardLog();
    const { client } = fakeClient({ "terminal.get": terminal() });
    const { opener, seen } = fakeAttach(PLAIN_PAINT);
    await new HcInput(client, opener, { ...FAST, guard }).sendText(SEAT, "x", () => { log.push("before"); seen.events.push("before"); });
    expect(log).toEqual([`input:${SEAT}`, `check:${SEAT}`, "before", "input-done"]);
    expect(seen.events.indexOf("before")).toBeGreaterThan(seen.events.indexOf("open"));
    expect(seen.events.indexOf("before")).toBeLessThan(seen.events.indexOf("write"));
  });

  it.each(["sendText", "sendKeys", "sendShellCommand", "submitText"] as const)("%s writes nothing when the last check refuses, and returns the guard's own code", async (method) => {
    const { guard } = guardLog(new DeliveryGuardError("guard_target_changed", "Input target changed; no input written."));
    const { client, calls } = fakeClient({ "terminal.get": terminal(), "terminal.keys": {}, "terminal.send": { turn: 0 } });
    const { opener, seen } = fakeAttach(PLAIN_PAINT);
    const input = new HcInput(client, opener, { ...FAST, guard, fileOps: noFiles() });
    const result = method === "sendText" ? await input.sendText(SEAT, "x")
      : method === "sendKeys" ? await input.sendKeys(SEAT, ["Enter"])
      : method === "sendShellCommand" ? await input.sendShellCommand(SEAT, "echo hi")
      : await input.submitText(SEAT, "x");
    expect(result).toMatchObject({ ok: false, code: "guard_target_changed" });
    expect(seen.written).toEqual([]);
    expect(calls.filter((c) => c.method === "terminal.keys" || c.method === "terminal.send")).toEqual([]);
  });

  it("returns the lease's refusal when the guard will not give one", async () => {
    const guard: HcInputGuard = { input: async () => { throw new DeliveryGuardError("typing_guard_enabled", "paused"); }, checkInput: () => {} };
    const { client, calls } = fakeClient({ "terminal.keys": {} });
    await expect(new HcInput(client, fakeAttach(null).opener, { guard }).sendKeys(SEAT, ["Enter"])).resolves.toMatchObject({ ok: false, code: "typing_guard_enabled" });
    expect(calls).toEqual([]);
  });
});

describe("HcInput.sendKeys", () => {
  it("presses the mapped keys on the seat's terminal, with the delivery deadline", async () => {
    const { client, calls } = fakeClient({ "terminal.get": terminal(), "terminal.keys": { turn: 0 } });
    await expect(new HcInput(client, fakeAttach(null).opener, { deliveryTimeoutMs: 1234 }).sendKeys(SEAT, ["C-c", "A", "Enter"])).resolves.toEqual({ ok: true });
    expect(calls.at(-1)).toEqual({ method: "terminal.keys", params: { terminal: ADDRESS, keys: ["ctrl+c", "shift+a", "enter"] }, timeoutMs: 1234 });
  });

  it("refuses an unsupported key before it reads or presses anything", async () => {
    const { client, calls } = fakeClient({});
    await expect(new HcInput(client, fakeAttach(null).opener).sendKeys(SEAT, ["a", "hello"])).resolves.toMatchObject({ ok: false, code: "unsupported_key" });
    expect(calls).toEqual([]);
  });

  it("refuses a blocked program by default and presses nothing; allowed, it does not even read the status", async () => {
    const blocked = terminal({ status: { state: "blocked", kind: null } });
    const refuse = fakeClient({ "terminal.get": blocked, "terminal.keys": {} });
    await expect(new HcInput(refuse.client, fakeAttach(null).opener).sendKeys(SEAT, ["Enter"])).resolves.toMatchObject({ ok: false, code: "seat_blocked" });
    expect(refuse.calls.map((c) => c.method)).toEqual(["terminal.get"]);
    const allow = fakeClient({ "terminal.get": blocked, "terminal.keys": {} });
    await expect(new HcInput(allow.client, fakeAttach(null).opener).sendKeys(SEAT, ["Enter"], undefined, { blocked: "allow" })).resolves.toEqual({ ok: true });
    expect(allow.calls.map((c) => c.method)).toEqual(["terminal.keys"]);
  });

  it("does not refuse a program that never reported a status, or one that is merely working", async () => {
    for (const status of [undefined, null, { state: "working" }, { state: "idle" }]) {
      const { client } = fakeClient({ "terminal.get": terminal({ status }), "terminal.keys": {} });
      await expect(new HcInput(client, fakeAttach(null).opener).sendKeys(SEAT, ["Enter"])).resolves.toEqual({ ok: true });
    }
  });

  it("presses nothing for only empty names, and runs beforeInput right before a real press", async () => {
    const quiet = fakeClient({});
    await expect(new HcInput(quiet.client, fakeAttach(null).opener).sendKeys(SEAT, ["", ""])).resolves.toEqual({ ok: true });
    expect(quiet.calls).toEqual([]);
    const order: string[] = [];
    const { client } = fakeClient({ "terminal.get": terminal(), "terminal.keys": () => { order.push("keys"); return {}; } });
    await new HcInput(client, fakeAttach(null).opener).sendKeys(SEAT, ["Enter"], () => order.push("before"));
    expect(order).toEqual(["before", "keys"]);
  });

  it("reads a reply that never came as an unknown outcome to verify, and unreachable as nothing sent", async () => {
    const unknown = fakeClient({ "terminal.get": terminal(), "terminal.keys": new HcOutcomeUnknownError("terminal.keys: no reply in 5 ms", "terminal.keys") });
    const result = await new HcInput(unknown.client, fakeAttach(null).opener).sendKeys(SEAT, ["Enter"]);
    expect(result).toMatchObject({ ok: false, code: "delivery_outcome_unknown" });
    expect(result.ok === false && result.message).toContain("verify");
    const gone = fakeClient({ "terminal.get": new HcUnavailableError("down") });
    await expect(new HcInput(gone.client, fakeAttach(null).opener).sendKeys(SEAT, ["Enter"])).resolves.toMatchObject({ ok: false, code: "transport_unavailable" });
  });

  it.each([
    ["not_found", "session_not_found"], ["finished", "session_not_found"], ["unavailable", "transport_unavailable"],
    ["blocked", "seat_blocked"], ["status_mismatch", "status_mismatch"], ["invalid_params", "unknown"],
  ])("maps hc's %s to %s without echoing the core's text", async (kind, code) => {
    const { client } = fakeClient({ "terminal.get": terminal(), "terminal.keys": new HcError("SECRET-IN-CORE-TEXT", kind, -32000) });
    const result = await new HcInput(client, fakeAttach(null).opener).sendKeys(SEAT, ["Enter"]);
    expect(result).toMatchObject({ ok: false, code });
    expect(JSON.stringify(result)).not.toContain("SECRET-IN-CORE-TEXT");
  });
});

describe("HcInput.submitText", () => {
  const sent = { started: true, status: "idle", turn: 3, wait: null };

  it("sends exactly the terminal and text, and returns what hc reported", async () => {
    const { client, calls } = fakeClient({ "terminal.send": sent });
    await expect(new HcInput(client, fakeAttach(null).opener, { deliveryTimeoutMs: 777 }).submitText(SEAT, "hi")).resolves.toEqual({ ok: true, started: true, status: "idle", turn: 3 });
    expect(calls).toEqual([{ method: "terminal.send", params: { terminal: ADDRESS, text: "hi" }, timeoutMs: 777 }]);
  });

  it("takes a deadline of its own over the default", async () => {
    const { client, calls } = fakeClient({ "terminal.send": sent });
    await new HcInput(client, fakeAttach(null).opener, { deliveryTimeoutMs: 777 }).submitText(SEAT, "hi", { timeoutMs: 55 });
    expect(calls[0]!.timeoutMs).toBe(55);
  });

  it("passes force, if and wait through, and lets the wait's own timeout extend the call's deadline", async () => {
    const { client, calls } = fakeClient({ "terminal.send": { ...sent, wait: { ended: true } } });
    const result = await new HcInput(client, fakeAttach(null).opener, { deliveryTimeoutMs: 1000 }).submitText(SEAT, "hi", { force: true, ifStatus: "idle", wait: true, waitTimeoutSec: 9 });
    expect(result).toEqual({ ok: true, started: true, status: "idle", turn: 3, wait: { ended: true } });
    expect(calls[0]).toEqual({ method: "terminal.send", params: { terminal: ADDRESS, text: "hi", force: true, if: "idle", wait: true, timeout: 9 }, timeoutMs: 10_000 });
  });

  it("returns null for a program that reports no status, not false", async () => {
    const { client } = fakeClient({ "terminal.send": { turn: 0 } });
    await expect(new HcInput(client, fakeAttach(null).opener).submitText(SEAT, "hi")).resolves.toEqual({ ok: true, started: null, status: null, turn: 0 });
  });

  it("reads a timeout as an unknown outcome, never a failure to retry", async () => {
    const { client } = fakeClient({ "terminal.send": new HcOutcomeUnknownError("terminal.send: no reply in 5 ms", "terminal.send") });
    const result = await new HcInput(client, fakeAttach(null).opener).submitText(SEAT, "hi");
    expect(result).toMatchObject({ ok: false, code: "delivery_outcome_unknown" });
    expect(result.ok === false && result.message).toMatch(/verify before sending again/);
  });

  it("maps hc's own refusals: blocked and status_mismatch both mean nothing was typed", async () => {
    const blocked = fakeClient({ "terminal.send": new HcError("t1 is blocked", "blocked", -32000, "read its screen first") });
    await expect(new HcInput(blocked.client, fakeAttach(null).opener).submitText(SEAT, "hi")).resolves.toMatchObject({ ok: false, code: "seat_blocked" });
    const mismatch = fakeClient({ "terminal.send": new HcError("t1 is working", "status_mismatch", -32000) });
    await expect(new HcInput(mismatch.client, fakeAttach(null).opener).submitText(SEAT, "hi", { ifStatus: "idle" })).resolves.toMatchObject({ ok: false, code: "status_mismatch" });
  });
});

function noFiles(): TmuxFileOps {
  return { writeFile: async () => {}, unlink: async () => {}, tmpName: () => "/tmp/openrig-tmux-send-1-00000000-0000-0000-0000-000000000000.txt", bufferName: () => "b" };
}

describe("HcInput.sendShellCommand", () => {
  const PATH = "/tmp/openrig-tmux-send-1-00000000-0000-0000-0000-000000000000.txt";

  function files(): { ops: TmuxFileOps; written: Array<{ path: string; content: string; mode?: number; flag?: string }>; unlinked: string[] } {
    const written: Array<{ path: string; content: string; mode?: number; flag?: string }> = [];
    const unlinked: string[] = [];
    return {
      written, unlinked,
      ops: {
        writeFile: async (path, content, options) => { written.push({ path, content, mode: options?.mode, flag: options?.flag }); },
        unlink: async (path) => { unlinked.push(path); },
        tmpName: () => PATH, bufferName: () => "b",
      },
    };
  }
  const shell = (name: string) => terminal({ foreground: { pid: 1, name, argv: [name], cwd: "/" } });

  it("stages the command in a private script that removes itself, and types only /bin/sh <script>", async () => {
    const f = files();
    const { client, calls } = fakeClient({ "terminal.send": { turn: 0 } });
    await expect(new HcInput(client, fakeAttach(null).opener, { fileOps: f.ops }).sendShellCommand(SEAT, "echo SECRET-VALUE")).resolves.toEqual({ ok: true });
    expect(f.written).toEqual([{ path: PATH, content: `/bin/rm -f -- '${PATH}'\necho SECRET-VALUE\n`, mode: 0o600, flag: "wx" }]);
    expect(calls).toEqual([{ method: "terminal.send", params: { terminal: ADDRESS, text: `/bin/sh ${PATH}` }, timeoutMs: 30_000 }]);
    expect(JSON.stringify(calls)).not.toContain("SECRET-VALUE");
    expect(f.unlinked).toEqual([]);
  });

  it("replaces the staging shell with the command for execInScript", async () => {
    const f = files();
    await new HcInput(fakeClient({ "terminal.send": { turn: 0 } }).client, fakeAttach(null).opener, { fileOps: f.ops }).sendShellCommand(SEAT, "pi run", undefined, { execInScript: true });
    expect(f.written[0]!.content).toBe(`/bin/rm -f -- '${PATH}'\nexec pi run\n`);
  });

  it("types a short, widget-safe, single-line command as it stands for stageIfLong, and stages every other", async () => {
    const cases: Array<[string, boolean]> = [
      ["pi --continue", false], ["pi (x)", true], ["pi 'x'", true], ["a\nb", true], ["a\tb", true], ["x".repeat(513), true], ["x".repeat(512), false],
    ];
    for (const [command, staged] of cases) {
      const f = files();
      const { client, calls } = fakeClient({ "terminal.send": { turn: 0 } });
      await new HcInput(client, fakeAttach(null).opener, { fileOps: f.ops }).sendShellCommand(SEAT, command, undefined, { stageIfLong: true });
      expect({ command: command.slice(0, 20), staged: f.written.length > 0 }).toEqual({ command: command.slice(0, 20), staged });
      expect(calls.at(-1)!.params.text).toBe(staged ? `/bin/sh ${PATH}` : command);
    }
  });

  it("sources the script in a POSIX pane shell for sourceInPane, with the command in a file of its own", async () => {
    const f = files();
    const { client, calls } = fakeClient({ "terminal.get": shell("-zsh"), "terminal.send": { turn: 0 } });
    await new HcInput(client, fakeAttach(null).opener, { fileOps: f.ops }).sendShellCommand(SEAT, "claude --resume", undefined, { sourceInPane: true });
    expect(f.written).toEqual([
      { path: `${PATH}.cmd`, content: `/bin/rm -f -- '${PATH}.cmd'\nclaude --resume\n`, mode: 0o600, flag: "wx" },
      { path: PATH, content: `/bin/rm -f -- '${PATH}'\n( . '${PATH}.cmd' )\n`, mode: 0o600, flag: "wx" },
    ]);
    expect(calls.at(-1)!.params.text).toBe(`. ${PATH}`);
  });

  it.each(["fish", "nu", "claude", ""])("runs the script with /bin/sh for sourceInPane when the pane's program is %j", async (name) => {
    const f = files();
    const { client, calls } = fakeClient({ "terminal.get": name ? shell(name) : terminal(), "terminal.send": { turn: 0 } });
    await new HcInput(client, fakeAttach(null).opener, { fileOps: f.ops }).sendShellCommand(SEAT, "x", undefined, { sourceInPane: true });
    expect(calls.at(-1)!.params.text).toBe(`/bin/sh ${PATH}`);
    expect(f.written).toHaveLength(1);
  });

  it("refuses a script path too long to type, writing nothing", async () => {
    const f = files();
    f.ops.tmpName = () => `/tmp/${"d".repeat(600)}`;
    const { client, calls } = fakeClient({ "terminal.send": { turn: 0 } });
    await expect(new HcInput(client, fakeAttach(null).opener, { fileOps: f.ops }).sendShellCommand(SEAT, "x")).resolves.toMatchObject({ ok: false, code: "launch_path_too_long" });
    expect(f.written).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("removes the staged files when nothing consumed them: a refusal, an unreachable core, or an unknown outcome", async () => {
    for (const error of [new HcError("m", "blocked", -32000), new HcUnavailableError("down"), new HcOutcomeUnknownError("no reply", "terminal.send")]) {
      const f = files();
      const { client } = fakeClient({ "terminal.get": shell("zsh"), "terminal.send": error });
      const result = await new HcInput(client, fakeAttach(null).opener, { fileOps: f.ops }).sendShellCommand(SEAT, "x", undefined, { sourceInPane: true });
      expect(result.ok).toBe(false);
      expect(f.unlinked.sort()).toEqual([PATH, `${PATH}.cmd`].sort());
    }
  });

  it("removes them when beforeInput refuses, too", async () => {
    const f = files();
    const { client, calls } = fakeClient({ "terminal.send": { turn: 0 } });
    const result = await new HcInput(client, fakeAttach(null).opener, { fileOps: f.ops }).sendShellCommand(SEAT, "x", () => { throw new DeliveryGuardError("guard_target_changed", "changed"); });
    expect(result).toMatchObject({ ok: false, code: "guard_target_changed" });
    expect(f.unlinked).toEqual([PATH]);
    expect(calls).toEqual([]);
  });
});
