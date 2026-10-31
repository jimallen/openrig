// @vitest-environment jsdom

// A terminal on herdr-core has no fixed geometry: the daemon tells the socket its size as one whole JSON text frame
// ({"type":"size","cols":N,"rows":M}, terminal-ws.ts terminalSizeFrame, restated here), and FocusedTerminal draws at that size.
// Anything else is terminal output and is written to the xterm as it came.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import React from "react";

const instances: MockWS[] = [];

class MockWS {
  readyState = 1;
  onopen: ((evt?: unknown) => void) | null = null;
  onclose: ((evt: { code: number; reason: string }) => void) | null = null;
  onmessage: ((evt: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    instances.push(this);
    setTimeout(() => this.onopen?.(), 0);
  }
  send(_data: string) {}
  close() { this.readyState = 3; }
  static OPEN = 1;
}
vi.stubGlobal("WebSocket", MockWS);

const { MockTerminal, terminals } = vi.hoisted(() => {
  const terminals: MockTerminal[] = [];
  class MockTerminal {
    written: string[] = [];
    resizes: Array<[number, number]> = [];
    options: Record<string, unknown>;
    child: HTMLElement | null = null;
    constructor(options: Record<string, unknown>) {
      this.options = { fontSize: 12, ...options };
      terminals.push(this);
    }
    open(el: HTMLElement) { this.child = document.createElement("div"); el.appendChild(this.child); }
    write(data: string) { this.written.push(data); }
    resize(cols: number, rows: number) { this.resizes.push([cols, rows]); }
    onData(_cb: (data: string) => void) {}
    focus() {}
    scrollToBottom() {}
    attachCustomWheelEventHandler(_h: (ev: WheelEvent) => boolean) {}
    dispose() { this.child?.remove(); this.child = null; }
  }
  return { MockTerminal, terminals };
});
vi.mock("@xterm/xterm", () => ({ Terminal: class extends MockTerminal {} }));

import { FocusedTerminal, MAX_TERMINAL_CELLS, parseTerminalSizeFrame } from "../src/components/terminal/FocusedTerminal.js";

async function mount() {
  render(<FocusedTerminal sessionName="dev-a@rig" />);
  await act(async () => { await vi.runOnlyPendingTimersAsync(); });
  const ws = instances[0]!;
  const term = terminals[0]!;
  const deliver = (data: unknown) => act(async () => { ws.onmessage?.({ data }); });
  return { ws, term, deliver };
}

describe("parseTerminalSizeFrame", () => {
  it("reads the whole frame the daemon sends", () => {
    expect(parseTerminalSizeFrame('{"type":"size","cols":200,"rows":120}')).toEqual({ cols: 200, rows: 120 });
    expect(parseTerminalSizeFrame('{"type":"size","cols":90,"rows":27}')).toEqual({ cols: 90, rows: 27 });
  });
  it.each([
    ["terminal output", "hello world\r\n"],
    ["JSON of another type", '{"type":"keys","cols":10,"rows":10}'],
    ["a size frame with a missing dimension", '{"type":"size","cols":10}'],
    ["a fractional dimension", '{"type":"size","cols":10.5,"rows":10}'],
    ["a string dimension", '{"type":"size","cols":"10","rows":10}'],
    ["a zero dimension", '{"type":"size","cols":0,"rows":10}'],
    ["a negative dimension", '{"type":"size","cols":10,"rows":-1}'],
    ["an absurd grid", `{"type":"size","cols":${MAX_TERMINAL_CELLS + 1},"rows":10}`],
    ["output that begins like the frame but is cut off", '{"type":"size","cols":10,"ro'],
    ["output that merely contains the frame", 'x{"type":"size","cols":10,"rows":10}'],
  ])("takes %s for output", (_what, data) => {
    expect(parseTerminalSizeFrame(data)).toBeNull();
  });
  it("accepts the largest grid it allows", () => {
    expect(parseTerminalSizeFrame(`{"type":"size","cols":${MAX_TERMINAL_CELLS},"rows":${MAX_TERMINAL_CELLS}}`)).toEqual({ cols: MAX_TERMINAL_CELLS, rows: MAX_TERMINAL_CELLS });
  });
});

describe("FocusedTerminal follows the terminal's size", () => {
  beforeEach(() => { vi.useFakeTimers(); instances.length = 0; terminals.length = 0; });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("starts at 90x27, as the tmux host pins it", async () => {
    const { term } = await mount();
    expect(term.options.cols).toBe(90);
    expect(term.options.rows).toBe(27);
    expect(term.resizes).toEqual([]);
  });

  it("resizes the xterm to a size frame, and does not write the frame as output", async () => {
    const { term, deliver } = await mount();
    await deliver('{"type":"size","cols":200,"rows":120}');
    expect(term.resizes).toEqual([[200, 120]]);
    expect(term.written).toEqual([]);
  });

  it("follows each change of size, in order", async () => {
    const { term, deliver } = await mount();
    await deliver('{"type":"size","cols":200,"rows":120}');
    await deliver("prompt $ ");
    await deliver('{"type":"size","cols":100,"rows":30}');
    expect(term.resizes).toEqual([[200, 120], [100, 30]]);
    expect(term.written).toEqual(["prompt $ "]);
  });

  it("writes terminal output as it came, and never resizes for it", async () => {
    const { term, deliver } = await mount();
    await deliver("hello\r\n");
    await deliver('{"type":"keys","cols":10,"rows":10}');
    await deliver('{"type":"size","cols":0,"rows":10}');
    expect(term.resizes).toEqual([]);
    expect(term.written).toEqual(["hello\r\n", '{"type":"keys","cols":10,"rows":10}', '{"type":"size","cols":0,"rows":10}']);
  });
});
