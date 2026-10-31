import { expect, it } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TranscriptStore } from "../src/domain/transcript-store.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { startTranscriptRotation, stopTranscriptRotation } from "../src/domain/transcript-rotation.js";
import { stopOwnedTmuxServer } from "./helpers/orphan-reaper.js";

let nativeAvailable = process.platform !== "win32";
try { execFileSync("tmux", ["-V"], { timeout: 2000, stdio: "ignore" }); } catch { nativeAvailable = false; }

it.skipIf(!nativeAvailable)("preserves the exact native trailing buffer and recovers idle panes on output", async () => {
  const root = mkdtempSync(join(tmpdir(), "capture-native-"));
  const socket = join(root, "tmux.sock"); // an owned -S socket: a -L name lives in the shared per-user directory
  const exec = promisify(execFile);
  const run = async (...args: string[]) => (await exec("tmux", ["-S", socket, "-f", "/dev/null", ...args], { timeout: 5000 })).stdout;
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  let captures = 0;
  const adapter = new TmuxAdapter(async () => { throw new Error("expected argv transport"); }, undefined, async (argv) => {
    if (argv[1] === "capture-pane") captures += 1;
    return run(...argv.slice(1));
  });
  const file = join(root, "seat.log");
  try {
    await run("new-session", "-d", "-s", "seat", "-x", "100", "-y", "30", "cat");
    await run("send-keys", "-t", "seat", "-l", "seed αβ"); await run("send-keys", "-t", "seat", "Enter");
    await wait(100);
    startTranscriptRotation(adapter, "seat", file, { lines: 1000, pollIntervalMs: 200 });
    await wait(2400);
    // A fixed 200ms poll would read at least 12 times during this idle window.
    expect(captures).toBeLessThan(10);
    await run("send-keys", "-t", "seat", "-l", "new output γδ"); await run("send-keys", "-t", "seat", "Enter");
    const deadline = Date.now() + 9000;
    // The line lands twice: the tty echoes it as typed, then cat prints it after Enter. Wait for
    // both, or a capture taken between them leaves the transcript one line behind the pane.
    const landed = () => readFileSync(file, "utf8").split("new output γδ").length - 1 >= 2;
    while (Date.now() < deadline && !landed()) await wait(50);
    const expected = await run("capture-pane", "-p", "-t", "seat", "-S", "-1000");
    expect(readFileSync(file, "utf8")).toBe(expected);
    expect(expected).toContain("new output γδ");
  } finally {
    stopTranscriptRotation("seat");
    await stopOwnedTmuxServer(socket, process.env);
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

it.skipIf(!nativeAvailable)("retains active native output before a normal stop despite capture latency", async () => {
  const root = mkdtempSync(join(tmpdir(), "capture-cadence-native-"));
  const socket = join(root, "tmux.sock"); // an owned -S socket: a -L name lives in the shared per-user directory
  const exec = promisify(execFile);
  const run = async (...args: string[]) => (await exec("tmux", ["-S", socket, "-f", "/dev/null", ...args], { timeout: 5000 })).stdout;
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const captureStarts: number[] = [];
  let slowestExecMs = 0;
  const adapter = new TmuxAdapter(async () => { throw new Error("expected argv transport"); }, undefined, async (argv) => {
    if (argv[1] === "capture-pane") captureStarts.push(Date.now());
    const began = performance.now();
    const result = await run(...argv.slice(1));
    slowestExecMs = Math.max(slowestExecMs, performance.now() - began);
    // Exercise a nonzero capture duration, retaining the actual tmux bytes.
    if (argv[1] === "capture-pane") await wait(100);
    return result;
  });
  const file = join(root, "seat.log");
  const transcriptHas = (text: string) => { try { return readFileSync(file, "utf8").includes(text); } catch { return false; } };
  // A condition wait: it resolves the moment `f` holds; the ceiling only bounds a genuine hang.
  const until = async (f: () => boolean, what: string) => {
    const deadline = Date.now() + 30_000;
    while (!f()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await wait(25);
    }
  };
  try {
    await run("new-session", "-d", "-s", "seat", "-x", "100", "-y", "30", "cat");
    startTranscriptRotation(adapter, "seat", file, { lines: 1000, pollIntervalMs: 2000 }, () => ({ lines: 1000, pollIntervalMs: 2000 }));
    await until(() => captureStarts.length > 0, "the first capture");
    await run("send-keys", "-t", "seat", "-l", "first activity"); await run("send-keys", "-t", "seat", "Enter");
    // Send the final output just after a capture has landed, so the next capture is a full cadence step away. A fixed
    // schedule of waits drifts on a loaded host until the send falls on the wrong side of a capture, and the output
    // then lands a whole step later than the cadence says: that is the schedule moving, not the capture.
    await until(() => transcriptHas("first activity"), "a capture of the first activity");
    await run("send-keys", "-t", "seat", "-l", "final active output αβ"); await run("send-keys", "-t", "seat", "Enter");
    await until(() => transcriptHas("final active output αβ"), "the final output in the transcript");
    stopTranscriptRotation("seat");
    // The capture that landed it is the latest to have started (a capture takes over 100 ms here, a poll 25 ms).
    // Capture starts are one 2000 ms cadence step apart, quantized to the 1000 ms timer step; the capture's own latency
    // must not stretch that. The allowance beyond the step is the slowest tmux call this host took, three times over
    // (the activity listing before a capture, the capture, a late timer).
    const [previousStart, landingStart] = captureStarts.slice(-2) as [number, number];
    expect(landingStart - previousStart).toBeLessThanOrEqual(2000 + 1000 + 3 * slowestExecMs);
    expect(readFileSync(file, "utf8")).toContain("final active output αβ");
  } finally {
    stopTranscriptRotation("seat");
    await stopOwnedTmuxServer(socket, process.env);
    rmSync(root, { recursive: true, force: true });
  }
}, 45_000);


it.skipIf(!nativeAvailable)("keeps real idle transcript health fresh across a variable 4.2s capture", async () => {
  const root = mkdtempSync(join(tmpdir(), "capture-fresh-native-"));
  const socket = join(root, "tmux.sock"); // an owned -S socket: a -L name lives in the shared per-user directory
  const exec = promisify(execFile);
  const run = async (...args: string[]) => (await exec("tmux", ["-S", socket, "-f", "/dev/null", ...args], { timeout: 5000 })).stdout;
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  let captures = 0;
  let slowCompleted = false;
  const adapter = new TmuxAdapter(async () => { throw new Error("expected argv transport"); }, undefined, async (argv) => {
    const result = await run(...argv.slice(1));
    if (argv[1] === "capture-pane" && ++captures === 5) {
      await wait(4200);
      slowCompleted = true;
    }
    return result;
  });
  const store = new TranscriptStore({ transcriptsRoot: root });
  const file = store.getTranscriptPath("rig", "seat");
  try {
    await run("new-session", "-d", "-s", "seat", "-x", "100", "-y", "30", "cat");
    await run("send-keys", "-t", "seat", "-l", "idle seed αβ"); await run("send-keys", "-t", "seat", "Enter");
    await wait(100);
    startTranscriptRotation(adapter, "seat", file, { lines: 1000, pollIntervalMs: 2000 }, () => ({ lines: 1000, pollIntervalMs: 2000 }));
    // The first capture runs two real tmux execs and a write before the transcript exists (until then health reads
    // capture_missing). Wait for that condition, not a fixed time: a loaded runner can take well over 200 ms.
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
    expect(readFileSync(file, "utf8")).toBe(await run("capture-pane", "-p", "-t", "seat", "-S", "-1000"));
  } finally {
    stopTranscriptRotation("seat");
    await stopOwnedTmuxServer(socket, process.env);
    rmSync(root, { recursive: true, force: true });
  }
}, 45_000);
