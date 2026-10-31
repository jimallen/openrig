import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TranscriptStore } from "../src/domain/transcript-store.js";
import { HcAdapter } from "../src/adapters/hc-adapter.js";
import { HcClient } from "../src/adapters/hc-client.js";
import { hcTerminalName, SEAT_LABEL } from "../src/adapters/hc-host.js";
import { startTranscriptRotation, stopTranscriptRotation } from "../src/domain/transcript-rotation.js";
import { findHc, startHcScratch, type HcScratch } from "./helpers/hc-scratch.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The real client to the private core. It counts reads, notes when each began, and can hold chosen reads back (a slow capture). */
class ReadWatchingClient extends HcClient {
  starts: number[] = [];
  slowestMs = 0;
  /** Extra time to hold the nth read (1-based, over the client's life) before answering. */
  hold: (nth: number) => number = () => 0;
  override async call<T>(method: string, params: Record<string, unknown> = {}, options: { timeoutMs?: number } = {}): Promise<T> {
    if (method !== "terminal.read") return super.call<T>(method, params, options);
    this.starts.push(Date.now());
    const nth = this.starts.length;
    const began = performance.now();
    const result = await super.call<T>(method, params, options);
    this.slowestMs = Math.max(this.slowestMs, performance.now() - began);
    const held = this.hold(nth);
    if (held > 0) await wait(held);
    return result;
  }
}

describe.skipIf(!findHc())("hc transcript capture against a private core", () => {
  let scratch: HcScratch;
  beforeAll(() => { scratch = startHcScratch(); }, 60_000);
  afterAll(() => scratch?.cleanup());

  /** A seat that echoes what it is sent (`cat` on the terminal's tty), so a sent line shows twice: typed, then printed. */
  async function catSeat(name: string): Promise<void> {
    await scratch.client().call("terminal.run", {
      argv: ["cat"], name: hcTerminalName(name), labels: { [SEAT_LABEL]: name }, cwd: scratch.root, no_parent: true, no_notify: true, outlive_parent: true,
    });
  }
  const say = (name: string, text: string) => scratch.client().call("terminal.send", { terminal: hcTerminalName(name), text });
  const until = async (f: () => boolean, what: string) => {
    const deadline = Date.now() + 30_000;
    while (!f()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await wait(25);
    }
  };

  it("preserves the exact trailing buffer of the pane and recovers an idle pane on output", async () => {
    const root = mkdtempSync(join(tmpdir(), "capture-hc-"));
    const client = new ReadWatchingClient(scratch.socketPath);
    const adapter = new HcAdapter(client);
    const file = join(root, "seat.log");
    try {
      await catSeat("seat-a");
      await say("seat-a", "seed αβ");
      await wait(100);
      startTranscriptRotation(adapter, "seat-a", file, { lines: 1000, pollIntervalMs: 200 });
      await wait(2400);
      // hc has no activity clock (hc-identity.ts), so an idle pane gives no signal to back off on and the transcript keeps its full
      // cadence: a 200 ms poll reads at least 10 times in this window. tmux read fewer than 10 here, by backing off on an unchanged
      // `window_activity`. Whether hc should back off (observer, or hook state) is a product call; this pins what it does.
      expect(client.starts.length).toBeGreaterThanOrEqual(10);
      await say("seat-a", "new output γδ");
      const deadline = Date.now() + 9000;
      // The line lands twice: the tty echoes it as typed, then cat prints it after Enter. Wait for both, or a capture taken between
      // them leaves the transcript one line behind the pane.
      const landed = () => readFileSync(file, "utf8").split("new output γδ").length - 1 >= 2;
      while (Date.now() < deadline && !landed()) await wait(50);
      stopTranscriptRotation("seat-a");
      const expected = await adapter.capturePaneContent("seat-a", 1000);
      expect(readFileSync(file, "utf8")).toBe(expected);
      expect(expected).toContain("new output γδ");
      expect(expected).toContain("seed αβ");
    } finally {
      stopTranscriptRotation("seat-a");
      await adapter.killSession("seat-a");
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("retains active output before a normal stop despite capture latency", async () => {
    const root = mkdtempSync(join(tmpdir(), "capture-cadence-hc-"));
    const client = new ReadWatchingClient(scratch.socketPath);
    // Exercise a nonzero capture duration, retaining the actual bytes.
    client.hold = () => 100;
    const adapter = new HcAdapter(client);
    const file = join(root, "seat.log");
    const transcriptHas = (text: string) => { try { return readFileSync(file, "utf8").includes(text); } catch { return false; } };
    try {
      await catSeat("seat-b");
      startTranscriptRotation(adapter, "seat-b", file, { lines: 1000, pollIntervalMs: 2000 }, () => ({ lines: 1000, pollIntervalMs: 2000 }));
      await until(() => client.starts.length > 0, "the first capture");
      await say("seat-b", "first activity");
      // Send the final output just after a capture has landed, so the next capture is a full cadence step away. A fixed schedule of
      // waits drifts on a loaded host until the send falls on the wrong side of a capture.
      await until(() => transcriptHas("first activity"), "a capture of the first activity");
      await say("seat-b", "final active output αβ");
      await until(() => transcriptHas("final active output αβ"), "the final output in the transcript");
      stopTranscriptRotation("seat-b");
      // The capture that landed it is the latest to have started. Starts are one 2000 ms cadence step apart, quantized to the 1000 ms
      // timer step; the capture's own latency must not stretch that. The allowance beyond the step is the slowest read this host took,
      // three times over.
      const [previousStart, landingStart] = client.starts.slice(-2) as [number, number];
      expect(landingStart - previousStart).toBeLessThanOrEqual(2000 + 1000 + 3 * (client.slowestMs + 100));
      expect(readFileSync(file, "utf8")).toContain("final active output αβ");
    } finally {
      stopTranscriptRotation("seat-b");
      await adapter.killSession("seat-b");
      rmSync(root, { recursive: true, force: true });
    }
  }, 45_000);

  it("keeps real idle transcript health fresh across a variable 4.2s capture", async () => {
    const root = mkdtempSync(join(tmpdir(), "capture-fresh-hc-"));
    const client = new ReadWatchingClient(scratch.socketPath);
    let slowCompleted = false;
    client.hold = (nth) => {
      if (nth !== 5) return 0;
      setTimeout(() => { slowCompleted = true; }, 4200);
      return 4200;
    };
    const adapter = new HcAdapter(client);
    const store = new TranscriptStore({ transcriptsRoot: root });
    const file = store.getTranscriptPath("rig", "seat");
    try {
      await catSeat("seat");
      await say("seat", "idle seed αβ");
      await wait(100);
      startTranscriptRotation(adapter, "seat", file, { lines: 1000, pollIntervalMs: 2000 }, () => ({ lines: 1000, pollIntervalMs: 2000 }));
      // The first capture runs a read and a write before the transcript exists (until then health reads capture_missing). Wait for that
      // condition, not a fixed time: a loaded runner can take well over 200 ms.
      const firstBy = Date.now() + 10_000;
      let first = store.getIngestHealth("rig", "seat");
      while (first.reason !== "capture_fresh" && Date.now() < firstBy) {
        await wait(50);
        first = store.getIngestHealth("rig", "seat");
      }
      expect(first, "the first capture landed within 10 s").toMatchObject({ state: "live", reason: "capture_fresh" });
      const until = Date.now() + 25_000;
      while (Date.now() < until) {
        expect(store.getIngestHealth("rig", "seat")).toMatchObject({ state: "live", reason: "capture_fresh" });
        await wait(100);
      }
      expect(slowCompleted).toBe(true);
      stopTranscriptRotation("seat");
      expect(readFileSync(file, "utf8")).toBe(await adapter.capturePaneContent("seat", 1000));
    } finally {
      stopTranscriptRotation("seat");
      await adapter.killSession("seat");
      rmSync(root, { recursive: true, force: true });
    }
  }, 45_000);
});
