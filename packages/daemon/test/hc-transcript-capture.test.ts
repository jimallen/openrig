// The transcript rotation reads `lines` (1,000) of every seat every 2 to 6 s. On hc, a read with history above the screen scrolls an idle
// full-screen app that reports the mouse (w14: 13 wheel events per read). This drives the real rotation over a real HcCapture, as HcAdapter
// is wired (HcAdapter.capturePaneContent and capturePanesContent delegate to it), and counts what reaches the core.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HcCapture, type ModeSource } from "../src/adapters/hc-capture.js";
import { hcTerminalName } from "../src/adapters/hc-host.js";
import type { TerminalModes } from "../src/adapters/hc-viewer.js";
import { clearAllTranscriptRotationsForTest, startTranscriptRotation, type TranscriptHost } from "../src/domain/transcript-rotation.js";
import { FakeHc } from "./helpers/hc-fake-client.js";

const PLAIN: TerminalModes = { altScreen: false, mouse: false };
const MOUSE: TerminalModes = { altScreen: true, mouse: true };
const POLL = 2000;

async function advance(ms: number) {
  do {
    const step = Math.min(ms, 250);
    await vi.advanceTimersByTimeAsync(step);
    for (let i = 0; i <= 24; i++) await vi.advanceTimersByTimeAsync(0);
    ms -= step;
  } while (ms > 0);
}

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "hc-transcript-")); vi.useFakeTimers(); });
afterEach(async () => {
  clearAllTranscriptRotationsForTest();
  await advance(6000);
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});

/** A core that answers reads with each seat's screen, and a mode source that can be changed per seat. */
function seatHost(seats: Record<string, TerminalModes>) {
  const modeOf = new Map(Object.entries(seats).map(([seat, modes]) => [hcTerminalName(seat), modes]));
  const probed: string[] = [];
  const hc = new FakeHc({ "terminal.read": (params) => ({ text: `screen of ${String(params.terminal)}`, complete: true, how: "screen" }) });
  const source: ModeSource = { async modesOf(ref) { probed.push(ref); return modeOf.get(ref) ?? null; } };
  const capture = new HcCapture(hc, { modes: source });
  const host: TranscriptHost = {
    capturePaneContent: (...a) => capture.capturePaneContent(...a),
    capturePanesContent: (...a) => capture.capturePanesContent(...a),
  };
  const readsOf = (seat: string) => hc.calls.filter((c) => c.method === "terminal.read" && c.params.terminal === hcTerminalName(seat)).map((c) => c.params.lines);
  return { host, hc, probed, readsOf, setModes: (seat: string, modes: TerminalModes) => modeOf.set(hcTerminalName(seat), modes) };
}
const live = { lines: 1000, pollIntervalMs: POLL };
const file = (seat: string) => path.join(root, `${seat}.log`);
const startAll = async (host: TranscriptHost, seats: string[]) => {
  for (const seat of seats) startTranscriptRotation(host, seat, file(seat), { ...live }, () => live);
  await advance(0);
};

describe("transcript rotation over HcCapture", () => {
  it("sends the core no lines above the screen for a full-screen seat in 30 s of polling, and still asks a plain seat for its 1,000", async () => {
    const t = seatHost({ "shell@rig": PLAIN, "tui1@rig": MOUSE, "tui2@rig": MOUSE });
    const seats = ["shell@rig", "tui1@rig", "tui2@rig"];
    await startAll(t.host, seats);
    await advance(30_000);
    for (const tui of ["tui1@rig", "tui2@rig"]) {
      expect(t.readsOf(tui).length).toBeGreaterThanOrEqual(10);
      expect(t.readsOf(tui).every((lines) => lines === 0)).toBe(true);
    }
    expect(t.readsOf("shell@rig").length).toBeGreaterThanOrEqual(10);
    expect(t.readsOf("shell@rig").every((lines) => lines === 1000)).toBe(true);
    // The transcripts are the screens: that is what a full-screen seat's file holds on hc.
    for (const seat of seats) expect(fs.readFileSync(file(seat), "utf8")).toBe(`screen of ${hcTerminalName(seat)}\n`);
  });

  it("looks the modes up once per verdict, not once per tick: a full-screen seat once in 30 s, a plain seat once per safe TTL", async () => {
    const t = seatHost({ "shell@rig": PLAIN, "tui@rig": MOUSE });
    await startAll(t.host, ["shell@rig", "tui@rig"]);
    await advance(30_000);
    expect(t.probed.filter((ref) => ref === hcTerminalName("tui@rig"))).toHaveLength(1);
    const plain = t.probed.filter((ref) => ref === hcTerminalName("shell@rig")).length;
    expect(plain).toBeGreaterThanOrEqual(5);
    expect(plain).toBeLessThanOrEqual(7);
  });

  it("bounds a seat that starts a full-screen app: at most one safe TTL of ticks still read history, then none", async () => {
    const t = seatHost({ "late@rig": PLAIN });
    await startAll(t.host, ["late@rig"]);
    await advance(10_000);
    t.setModes("late@rig", MOUSE);
    const before = t.readsOf("late@rig").length;
    await advance(30_000);
    const after = t.readsOf("late@rig").slice(before);
    expect(after.filter((lines) => lines > 0).length).toBeLessThanOrEqual(Math.ceil(5000 / POLL));
    expect(after.slice(-5).every((lines) => lines === 0)).toBe(true);
  });
});
