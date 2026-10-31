import { describe, expect, it } from "vitest";
import type { HcAttachHandlers, HcAttachOpener, HcAttachParams, HcAttachment } from "../src/adapters/hc-attach.js";
import { HcError, HcUnavailableError } from "../src/adapters/hc-client.js";
import { DEFAULT_MODE_TTL, HcCapture, ObserverModeProbe, type ModeSource, type ModeTtl } from "../src/adapters/hc-capture.js";
import { hcTerminalName } from "../src/adapters/hc-host.js";
import type { TerminalModes } from "../src/adapters/hc-viewer.js";
import { FakeHc, terminal } from "./helpers/hc-fake-client.js";

// terminal.read with history above the screen, on an idle full-screen app that reports the mouse, makes the core scroll the app with
// mouse-wheel events (w14, hc 0.1.15: 13 per read). The transcript rotation reads 1,000 lines of every seat every 2 to 6 s and about 49
// scrape sites read 20 to 80, so a history read must not be made on such a terminal, nor on one whose modes are not known.

const PLAIN: TerminalModes = { altScreen: false, mouse: false };
const MOUSE: TerminalModes = { altScreen: true, mouse: true };
const ALT_ONLY: TerminalModes = { altScreen: true, mouse: false };
const MOUSE_ONLY: TerminalModes = { altScreen: false, mouse: true };

/** A mode source that answers from a table, counts its questions, and can be changed between them. */
function modes(answers: Record<string, TerminalModes | null> | TerminalModes | null) {
  const asked: string[] = [];
  const source: ModeSource & { answers: Record<string, TerminalModes | null> | TerminalModes | null } = {
    answers,
    async modesOf(ref) {
      asked.push(ref);
      const a = source.answers;
      if (a === null) return null;
      return "altScreen" in a ? a : (a[ref] ?? null);
    },
  };
  return { source, asked };
}
const reads = (hc: FakeHc) => hc.calls.filter((c) => c.method === "terminal.read").map((c) => c.params.lines);
const hcReading = (how = "history") => new FakeHc({ "terminal.read": () => ({ text: "row", complete: true, how }) });
const clock = () => { const t = { now: 1_000_000 }; return { t, tick: () => t.now }; };
const TTL: ModeTtl = { safeMs: 5_000, unsafeMs: 60_000, unknownMs: 2_000 };

describe("HcCapture asks for history only where a read cannot scroll an app", () => {
  it.each([["mouse reporting and an alternate screen", MOUSE], ["an alternate screen alone", ALT_ONLY], ["mouse reporting alone", MOUSE_ONLY]])(
    "reads the screen only, never history, on %s: repeated polls send the core no lines above the screen", async (_what, unsafe) => {
      const hc = hcReading();
      const capture = new HcCapture(hc, { modes: modes(unsafe).source });
      for (let poll = 0; poll < 10; poll++) {
        await capture.capturePaneContent("qa@rig", 1000);
        await capture.capturePanesContent(["qa@rig", "dev@rig"], 80);
        await capture.capturePaneHistory("qa@rig");
      }
      expect(reads(hc).length).toBeGreaterThan(0);
      expect(reads(hc).every((lines) => lines === 0)).toBe(true);
    });

  it("passes the lines asked for on a plain terminal, whose history cannot scroll anything", async () => {
    const hc = hcReading();
    const capture = new HcCapture(hc, { modes: modes(PLAIN).source });
    await capture.capturePaneContent("qa@rig", 1000);
    await capture.capturePanesContent(["dev@rig"], 80);
    expect(reads(hc)).toEqual([1000, 80]);
  });

  it("reads the screen only when the modes are not known: a mode unknown reads as unsafe", async () => {
    const hc = hcReading();
    const capture = new HcCapture(hc, { modes: modes(null).source });
    await expect(capture.capturePaneContent("qa@rig", 1000)).resolves.toBe("row\n");
    expect(reads(hc)).toEqual([0]);
  });

  it("reads the screen only when the core cannot be asked for the modes (the default probe, no core listening)", async () => {
    const hc = hcReading();
    await new HcCapture(hc).capturePaneContent("qa@rig", 1000);
    expect(reads(hc)).toEqual([0]);
  });

  it("decides per terminal in a batch: a plain seat keeps its history, a full-screen one does not", async () => {
    const hc = hcReading();
    const answers = { [hcTerminalName("plain@rig")]: PLAIN, [hcTerminalName("tui@rig")]: MOUSE };
    await new HcCapture(hc, { modes: modes(answers).source }).capturePanesContent(["plain@rig", "tui@rig"], 1000);
    const lines = Object.fromEntries(hc.calls.map((c) => [c.params.terminal, c.params.lines]));
    expect(lines).toEqual({ [hcTerminalName("plain@rig")]: 1000, [hcTerminalName("tui@rig")]: 0 });
  });

  it("answers null for the whole history of an unsafe terminal and does not read it: a screen would pass for the whole", async () => {
    const hc = hcReading();
    await expect(new HcCapture(hc, { modes: modes(MOUSE).source }).capturePaneHistory("qa@rig")).resolves.toBeNull();
    expect(hc.calls).toEqual([]);
    const plain = hcReading();
    await expect(new HcCapture(plain, { modes: modes(PLAIN).source }).capturePaneHistory("qa@rig")).resolves.toBe("row\n");
    expect(reads(plain)[0]).toBeGreaterThanOrEqual(1_000_000);
  });

  it("looks up no modes for a screen read, a tmux pane id, or a request for no history", async () => {
    const hc = hcReading();
    const { source, asked } = modes(MOUSE);
    const capture = new HcCapture(hc, { modes: source });
    await capture.capturePaneScreen("qa@rig");
    await capture.capturePaneContent("qa@rig", 0);
    await capture.capturePaneContent("%4", 1000);
    expect(asked).toEqual([]);
  });

  it("does not hide a bug in the mode source as an unsafe terminal", async () => {
    const broken: ModeSource = { modesOf: async () => { throw new TypeError("bug"); } };
    await expect(new HcCapture(hcReading(), { modes: broken }).capturePaneContent("qa@rig", 1000)).rejects.toBeInstanceOf(TypeError);
  });
});

describe("the mode check costs a probe once per verdict, not once per read", () => {
  it("shares one probe across 24 reads of a terminal in flight, and 50 polls inside the TTL", async () => {
    const { source, asked } = modes(PLAIN);
    const { tick } = clock();
    const capture = new HcCapture(hcReading(), { modes: source, ttl: TTL, tick });
    await Promise.all(Array.from({ length: 24 }, () => capture.capturePaneContent("qa@rig", 1000)));
    for (let poll = 0; poll < 50; poll++) await capture.capturePaneContent("qa@rig", 1000);
    expect(asked).toEqual([hcTerminalName("qa@rig")]);
  });

  it("believes a plain verdict for the safe TTL and then looks again: a seat can start a full-screen app at any moment", async () => {
    const { source, asked } = modes(PLAIN);
    const { t, tick } = clock();
    const hc = hcReading();
    const capture = new HcCapture(hc, { modes: source, ttl: TTL, tick });
    await capture.capturePaneContent("qa@rig", 1000);
    t.now += TTL.safeMs - 1;
    await capture.capturePaneContent("qa@rig", 1000);
    expect(asked).toHaveLength(1);
    source.answers = MOUSE;
    t.now += 1;
    await capture.capturePaneContent("qa@rig", 1000);
    expect(asked).toHaveLength(2);
    expect(reads(hc)).toEqual([1000, 1000, 0]);
  });

  it("believes an unsafe verdict far longer than a plain one: a stale unsafe costs history, a stale plain scrolls an app", async () => {
    const { source, asked } = modes(MOUSE);
    const { t, tick } = clock();
    const capture = new HcCapture(hcReading(), { modes: source, ttl: TTL, tick });
    await capture.capturePaneContent("qa@rig", 1000);
    t.now += TTL.safeMs + 1;
    await capture.capturePaneContent("qa@rig", 1000);
    expect(asked).toHaveLength(1);
    t.now += TTL.unsafeMs;
    await capture.capturePaneContent("qa@rig", 1000);
    expect(asked).toHaveLength(2);
  });

  it("asks again soon after an unknown, and not on every read", async () => {
    const { source, asked } = modes(null);
    const { t, tick } = clock();
    const capture = new HcCapture(hcReading(), { modes: source, ttl: TTL, tick });
    await capture.capturePaneContent("qa@rig", 1000);
    await capture.capturePaneContent("qa@rig", 1000);
    expect(asked).toHaveLength(1);
    t.now += TTL.unknownMs;
    await capture.capturePaneContent("qa@rig", 1000);
    expect(asked).toHaveLength(2);
  });

  it("keeps each terminal's verdict apart", async () => {
    const { source, asked } = modes({ [hcTerminalName("a@rig")]: MOUSE, [hcTerminalName("b@rig")]: PLAIN });
    const hc = hcReading();
    const capture = new HcCapture(hc, { modes: source });
    await capture.capturePaneContent("a@rig", 100);
    await capture.capturePaneContent("b@rig", 100);
    await capture.capturePaneContent("a@rig", 100);
    await capture.capturePaneContent("b@rig", 100);
    expect(asked).toHaveLength(2);
    expect(reads(hc)).toEqual([0, 100, 0, 100]);
  });

  it("marks a terminal unsafe at once when the core had to scroll it to read it (stitched), whatever the probe said", async () => {
    const { source, asked } = modes(PLAIN);
    const hc = hcReading("stitched");
    const capture = new HcCapture(hc, { modes: source });
    await capture.capturePaneContent("qa@rig", 1000);
    await capture.capturePaneContent("qa@rig", 1000);
    expect(reads(hc)).toEqual([1000, 0]);
    expect(asked).toHaveLength(1);
  });

  it("has defaults of a short plain TTL, a long unsafe one, and a short unknown one", () => {
    expect(DEFAULT_MODE_TTL.safeMs).toBeLessThan(DEFAULT_MODE_TTL.unsafeMs);
    expect(DEFAULT_MODE_TTL.unknownMs).toBeLessThan(DEFAULT_MODE_TTL.unsafeMs);
    expect(DEFAULT_MODE_TTL.safeMs).toBeLessThanOrEqual(10_000);
  });
});

// ---- the probe ----------------------------------------------------------------------------------------------------------------

/** An opener whose attach delivers `frames` and records what it was asked. */
function opener(frames: (string | Buffer)[] | Error, record: { opened: HcAttachParams[]; detached: number } = { opened: [], detached: 0 }) {
  const impl: HcAttachOpener = {
    async open(params: HcAttachParams, handlers: HcAttachHandlers): Promise<HcAttachment> {
      record.opened.push(params);
      if (frames instanceof Error) throw frames;
      const attachment: HcAttachment = {
        terminal: terminal({ address: "t1" }), observe: params.observe ?? false,
        write: () => { throw new Error("an observer does not type"); }, resize: () => { throw new Error("an observer does not resize"); },
        detach: async () => { record.detached += 1; return { reason: "detached" }; },
      };
      queueMicrotask(() => { for (const frame of frames) handlers.onData(Buffer.from(frame, "latin1")); });
      return attachment;
    },
  };
  return { impl, record };
}
const FAST = { settleMs: 5, maxMs: 50, firstMs: 60 };
const PAINT_START = "\x1b[!p";

describe("ObserverModeProbe reads the modes from an observer's first paint", () => {
  it("reads alternate screen and mouse reporting from the paint, and watches as an observer that it detaches", async () => {
    const { impl, record } = opener([`${PAINT_START}\x1b[?1049h\x1b[?1000h\x1b[?1006h`, "ROW1"]);
    await expect(new ObserverModeProbe(impl, FAST).modesOf("t1")).resolves.toEqual(MOUSE);
    expect(record.opened).toEqual([expect.objectContaining({ terminal: "t1", observe: true })]);
    expect(record.detached).toBe(1);
  });

  it("reads a mode sequence split across two frames", async () => {
    const { impl } = opener([`${PAINT_START}\x1b[?10`, "00h\x1b[?10", "49h"]);
    await expect(new ObserverModeProbe(impl, FAST).modesOf("t1")).resolves.toEqual(MOUSE);
  });

  it("reads a plain paint as no modes, and an alternate screen without the mouse as that", async () => {
    await expect(new ObserverModeProbe(opener([`${PAINT_START}prompt $ `]).impl, FAST).modesOf("t1")).resolves.toEqual(PLAIN);
    await expect(new ObserverModeProbe(opener([`${PAINT_START}\x1b[?1049h`]).impl, FAST).modesOf("t1")).resolves.toEqual(ALT_ONLY);
  });

  it("reads a mode turned on and off again as off", async () => {
    await expect(new ObserverModeProbe(opener([`${PAINT_START}\x1b[?1000h\x1b[?1000l`]).impl, FAST).modesOf("t1")).resolves.toEqual(PLAIN);
  });

  it("is unknown when no paint comes", async () => {
    const { impl, record } = opener([]);
    await expect(new ObserverModeProbe(impl, FAST).modesOf("t1")).resolves.toBeNull();
    expect(record.detached).toBe(1);
  });

  it("is unknown when the terminal is not there or the core cannot be reached, and plain when the terminal has finished", async () => {
    await expect(new ObserverModeProbe(opener(new HcError("gone", "not_found", -32000)).impl, FAST).modesOf("t1")).resolves.toBeNull();
    await expect(new ObserverModeProbe(opener(new HcUnavailableError("down")).impl, FAST).modesOf("t1")).resolves.toBeNull();
    await expect(new ObserverModeProbe(opener(new HcError("done", "finished", -32000)).impl, FAST).modesOf("t1")).resolves.toEqual(PLAIN);
  });

  it("does not hide a bug as unknown", async () => {
    await expect(new ObserverModeProbe(opener(new TypeError("bug")).impl, FAST).modesOf("t1")).rejects.toBeInstanceOf(TypeError);
  });

  it("serves HcCapture end to end: the paint of a full-screen app keeps a 1,000-line read from being asked", async () => {
    const hc = hcReading();
    const capture = new HcCapture(hc, { modes: new ObserverModeProbe(opener([`${PAINT_START}\x1b[?1049h\x1b[?1000h`]).impl, FAST) });
    await capture.capturePaneContent("tui@rig", 1000);
    expect(reads(hc)).toEqual([0]);
  });
});
