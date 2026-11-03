// OF-213 (review N2): openPaneFrame, the part of the pane console that hands the pane back on every exit road. Production consequence: a
// runner killed by SIGTERM or SIGHUP, or exiting, that did not reset the scroll region leaves the terminal with its bottom two rows cut off;
// a `hc keep` shell that replaces the program would inherit it. The signal handlers must also re-raise the signal, or the runner would no
// longer die of it. process.once and process.kill are stubbed here, so nothing is registered on the test worker and no signal is sent.
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openPaneFrame } from "../src/adapters/pi-runner.js";
import { guardPaneStream } from "../src/adapters/runner-pane-guard.js";

const ESC = "\u001b";

class FakeTty extends EventEmitter {
  rows = 24; columns = 80; isTTY = true; writes: string[] = [];
  write = (chunk: unknown): boolean => { this.writes.push(String(chunk)); return true; };
}

function rig(options: { guarded?: boolean; stdinTty?: boolean } = {}) {
  const stdout = new FakeTty();
  const stderr = new FakeTty();
  // The guard keeps the stream's original writer as the "raw" one; what it receives is what the frame's own sequences look like.
  if (options.guarded !== false) guardPaneStream(stdout);
  const handlers = new Map<string | symbol, () => void>();
  vi.spyOn(process, "once").mockImplementation((event, listener) => { handlers.set(event, () => { listener(); }); return process; });
  const kills: Array<[number, string | number | undefined]> = [];
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => { kills.push([pid, signal]); return true; });
  const frame = openPaneFrame("── s@r · pi · m ──", stdout, stderr, { isTTY: options.stdinTty ?? true });
  const resets = () => stdout.writes.filter((w) => w.startsWith(`${ESC}[r`));
  return { frame, stdout, handlers, kills, resets };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("openPaneFrame", () => {
  it("on a guarded TTY pane it takes the pane and gives it back on exit, SIGTERM and SIGHUP: three handlers, no more", () => {
    const { frame, handlers } = rig();
    expect(frame).not.toBeNull();
    expect([...handlers.keys()].sort()).toEqual(["SIGHUP", "SIGTERM", "exit"]);
  });
  it("process exit resets the scroll region and puts the cursor on the last row", () => {
    const { handlers, resets, stdout } = rig();
    expect(resets()).toEqual([]);
    handlers.get("exit")!();
    expect(stdout.writes.filter((w) => w.startsWith(`${ESC}[r`))).toEqual([`${ESC}[r${ESC}[24;1H${ESC}[2K\n`]);
  });
  it.each(["SIGTERM", "SIGHUP"])("%s resets the pane first, then raises the same signal on this process", (signal) => {
    const { handlers, resets, kills } = rig();
    handlers.get(signal)!();
    expect(resets()).toEqual([`${ESC}[r${ESC}[24;1H${ESC}[2K\n`]);
    expect(kills).toEqual([[process.pid, signal]]);
  });
  it("a stdin that is not a TTY leaves the pane alone: no frame, nothing drawn, no handler", () => {
    const { frame, handlers, stdout } = rig({ stdinTty: false });
    expect(frame).toBeNull();
    expect(stdout.writes).toEqual([]);
    expect(handlers.size).toBe(0);
  });
  it("a stdout the pane guard does not wrap has no raw writer: no frame", () => {
    const { frame, handlers, stdout } = rig({ guarded: false });
    expect(frame).toBeNull();
    expect(stdout.writes).toEqual([]);
    expect(handlers.size).toBe(0);
  });
});
