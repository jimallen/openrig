import { describe, expect, it } from "vitest";
import { HcError, HcOutcomeUnknownError, HcUnavailableError } from "../src/adapters/hc-client.js";
import { HcCapture } from "../src/adapters/hc-capture.js";
import { hcTerminalName } from "../src/adapters/hc-host.js";
import { FakeHc, notFound } from "./helpers/hc-fake-client.js";

const reading = (text: string, extra: { complete?: boolean; how?: string } = {}) => ({ text, complete: true, how: "history", ...extra });
const answering = (read: (params: Record<string, unknown>) => unknown) => new FakeHc({ "terminal.read": read });
/** The ceiling on reads in flight, restated here rather than imported: it protects the core, so a change to it is a decision. */
const BATCH = 24;
const down = () => { throw new HcUnavailableError("down"); };

describe("HcCapture.capturePaneContent", () => {
  it("reads the seat's terminal with the lines asked for, as history above the screen", async () => {
    const hc = answering(() => reading("a\nb"));
    await new HcCapture(hc).capturePaneContent("qa@rig", 37);
    expect(hc.calls).toEqual([{ method: "terminal.read", params: { terminal: hcTerminalName("qa@rig"), lines: 37 } }]);
  });
  it("asks for 20 lines by default, as the tmux adapter does", async () => {
    const hc = answering(() => reading("x"));
    await new HcCapture(hc).capturePaneContent("t3");
    expect(hc.calls[0]?.params).toEqual({ terminal: "t3", lines: 20 });
  });
  it("newline-terminates the text, as capture-pane prints its lines", async () => {
    await expect(new HcCapture(answering(() => reading("one\ntwo"))).capturePaneContent("t1")).resolves.toBe("one\ntwo\n");
  });
  it("does not add a second newline", async () => {
    await expect(new HcCapture(answering(() => reading("one\n"))).capturePaneContent("t1")).resolves.toBe("one\n");
  });
  it("reads an empty screen as null", async () => {
    await expect(new HcCapture(answering(() => reading(""))).capturePaneContent("t1")).resolves.toBeNull();
  });
  it("answers null for escapes and does not ask the core: plain text must not pass for a styled capture", async () => {
    const hc = answering(() => reading("plain"));
    await expect(new HcCapture(hc).capturePaneContent("t1", 20, { escapeSequences: true })).resolves.toBeNull();
    expect(hc.calls).toEqual([]);
  });
  it("reads the same text whether or not joined lines are asked for: hc has only the joined form", async () => {
    const hc = answering(() => reading("a long line"));
    const capture = new HcCapture(hc);
    await expect(capture.capturePaneContent("t1", 30, { joinWrappedLines: true })).resolves.toBe(await capture.capturePaneContent("t1", 30));
    expect(hc.calls[0]?.params).toEqual(hc.calls[1]?.params);
  });
  it("returns an incomplete read's text: a scrape of the last lines wants what is there", async () => {
    await expect(new HcCapture(answering(() => reading("screen only", { complete: false }))).capturePaneContent("t1", 20)).resolves.toBe("screen only\n");
  });
  it("answers null for a terminal that is not there, a tmux pane id, and a core that cannot be asked", async () => {
    await expect(new HcCapture(answering(() => { throw notFound(); })).capturePaneContent("gone@r")).resolves.toBeNull();
    const hc = answering(() => reading("x"));
    await expect(new HcCapture(hc).capturePaneContent("%4")).resolves.toBeNull();
    expect(hc.calls).toEqual([]);
    await expect(new HcCapture(answering(down)).capturePaneContent("t1")).resolves.toBeNull();
    await expect(new HcCapture(answering(() => { throw new HcOutcomeUnknownError("lost", "terminal.read"); })).capturePaneContent("t1")).resolves.toBeNull();
    await expect(new HcCapture(answering(() => { throw new HcError("no", "invalid_params", -32602); })).capturePaneContent("t1")).resolves.toBeNull();
  });
  it("does not hide a bug as an empty capture", async () => {
    await expect(new HcCapture(answering(() => { throw new TypeError("bug"); })).capturePaneContent("t1")).rejects.toBeInstanceOf(TypeError);
  });
});

describe("HcCapture.capturePaneScreen", () => {
  it("reads the screen with no history", async () => {
    const hc = answering(() => reading("row1\nrow2", { how: "screen" }));
    await expect(new HcCapture(hc).capturePaneScreen("qa@rig")).resolves.toBe("row1\nrow2\n");
    expect(hc.calls[0]?.params).toEqual({ terminal: hcTerminalName("qa@rig"), lines: 0 });
  });
  it("answers null for a blank screen or a terminal that is not there", async () => {
    await expect(new HcCapture(answering(() => reading(""))).capturePaneScreen("t1")).resolves.toBeNull();
    await expect(new HcCapture(answering(() => { throw notFound(); })).capturePaneScreen("t1")).resolves.toBeNull();
  });
});

describe("HcCapture.capturePaneHistory", () => {
  it("asks for more history than any terminal keeps", async () => {
    const hc = answering(() => reading("h1\nh2"));
    await new HcCapture(hc).capturePaneHistory("t1");
    expect(hc.calls[0]?.params.lines).toBeGreaterThanOrEqual(1_000_000);
  });
  it("returns the whole text when hc says the read is complete", async () => {
    await expect(new HcCapture(answering(() => reading("h1\nh2"))).capturePaneHistory("t1")).resolves.toBe("h1\nh2\n");
  });
  it("answers null when hc says part of it may be missing, so a count against an earlier capture cannot take an old line for a new one", async () => {
    await expect(new HcCapture(answering(() => reading("h2", { complete: false }))).capturePaneHistory("t1")).resolves.toBeNull();
  });
  it("answers null when the terminal is not there", async () => {
    await expect(new HcCapture(answering(() => { throw notFound(); })).capturePaneHistory("t1")).resolves.toBeNull();
  });
});

describe("HcCapture.capturePanesContent", () => {
  const byTarget = (texts: Record<string, string | Error>) => answering((params) => {
    const found = Object.entries(texts).find(([target]) => hcTerminalName(target) === params.terminal || target === params.terminal);
    if (!found) throw notFound();
    if (found[1] instanceof Error) throw found[1];
    return reading(found[1]);
  });
  const at = new Date("2026-03-04T05:06:07.000Z");

  it("maps each target as given to its text, newline-terminated", async () => {
    const out = await new HcCapture(byTarget({ "a@r": "A1\nA2", "b@r": "B1" })).capturePanesContent(["a@r", "b@r"], 20, () => at);
    expect([...out!]).toEqual([["a@r", { text: "A1\nA2\n", capturedAt: at }], ["b@r", { text: "B1\n", capturedAt: at }]]);
  });
  it("asks each terminal once for the lines given, even when a target is repeated", async () => {
    const hc = byTarget({ "a@r": "A" });
    await new HcCapture(hc).capturePanesContent(["a@r", "a@r", "a@r"], 55);
    expect(hc.calls).toEqual([{ method: "terminal.read", params: { terminal: hcTerminalName("a@r"), lines: 55 } }]);
  });
  it("marks a terminal hc says is not there as missing, with no text", async () => {
    const out = await new HcCapture(byTarget({ "a@r": "A" })).capturePanesContent(["a@r", "gone@r"], 20, () => at);
    expect(out?.get("gone@r")).toEqual({ text: null, capturedAt: at, missing: true });
    expect(out?.get("a@r")).not.toHaveProperty("missing");
  });
  it("reads an empty capture as null text that is not missing", async () => {
    const out = await new HcCapture(byTarget({ "a@r": "" })).capturePanesContent(["a@r"], 20, () => at);
    expect(out?.get("a@r")).toEqual({ text: null, capturedAt: at });
  });
  it("leaves out a target whose read failed for another reason, for the caller to read alone", async () => {
    const out = await new HcCapture(byTarget({
      "a@r": "A", "slow@r": new HcOutcomeUnknownError("lost", "terminal.read"), "bad@r": new HcError("no", "invalid_params", -32602),
    })).capturePanesContent(["a@r", "slow@r", "bad@r"]);
    expect([...out!.keys()]).toEqual(["a@r"]);
  });
  it("answers null when the core cannot be reached and nothing was read", async () => {
    await expect(new HcCapture(answering(down)).capturePanesContent(["a@r", "b@r"])).resolves.toBeNull();
  });
  it("reads no targets as an empty map, not as an unreachable core", async () => {
    await expect(new HcCapture(answering(down)).capturePanesContent([])).resolves.toEqual(new Map());
  });
  it("keeps what it read, and reads no further chunk, once the core goes away", async () => {
    const targets = Array.from({ length: BATCH * 2 + 1 }, (_, i) => `s${i}@r`);
    let reads = 0;
    const hc = answering(() => { reads += 1; if (reads > BATCH) throw new HcUnavailableError("down"); return reading("ok"); });
    const out = await new HcCapture(hc).capturePanesContent(targets);
    expect(out?.size).toBe(BATCH);
    expect(reads).toBe(BATCH * 2);
  });
  it("reads at most 24 terminals at once, and all of them", async () => {
    const targets = Array.from({ length: BATCH * 2 + 5 }, (_, i) => `s${i}@r`);
    let inFlight = 0, peak = 0;
    const hc = answering(async () => {
      inFlight += 1; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight -= 1;
      return reading("x");
    });
    const out = await new HcCapture(hc).capturePanesContent(targets);
    expect(out?.size).toBe(targets.length);
    expect(peak).toBe(BATCH);
  });
  it("stamps each chunk with the time it was read, so a slow later chunk cannot make an earlier capture look fresh", async () => {
    const targets = Array.from({ length: BATCH + 1 }, (_, i) => `s${i}@r`);
    const times = [new Date("2026-03-04T05:00:00Z"), new Date("2026-03-04T05:00:09Z")];
    let call = 0;
    const out = await new HcCapture(answering(() => reading("x"))).capturePanesContent(targets, 20, () => times[call++]!);
    expect(out?.get(targets[0]!)?.capturedAt).toEqual(times[0]);
    expect(out?.get(targets[BATCH]!)?.capturedAt).toEqual(times[1]);
  });
  it("marks a tmux pane id as missing without asking the core", async () => {
    const hc = byTarget({});
    const out = await new HcCapture(hc).capturePanesContent(["%4"], 20, () => at);
    expect(out?.get("%4")).toEqual({ text: null, capturedAt: at, missing: true });
    expect(hc.calls).toEqual([]);
  });
});
