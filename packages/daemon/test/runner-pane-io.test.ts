// pda L0 (pda-runtime-design-9l Rev 2, "Input framing"; T5, T5b): the shared pane-input editor. The Pi
// default must stay what it was (Ctrl-C submits "/abort", and an ETX inside a paste still interrupts); a pda
// runner passes `onInterrupt` (Ctrl-C never stops its agent) and `interruptInsidePaste: "content"` (a paste
// is content, ETX included). The pi-runner suite exercises the rest of the editor through the re-export.
import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import { createRunnerInput, resolveActivityEndpoint, type RunnerInputOptions } from "../src/adapters/runner-pane-io.js";
import * as piRunner from "../src/adapters/pi-runner.js";

const START = "\u001b[200~";
const END = "\u001b[201~";
const ETX = "\u0003";

function terminal(options?: RunnerInputOptions) {
  const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: false,
    setRawMode: vi.fn(function (this: { isRaw: boolean }, value: boolean) { this.isRaw = value; }) });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
  const blocks: string[] = [];
  let screen = "";
  output.on("data", (chunk) => { screen += chunk.toString(); });
  const editor = createRunnerInput(input as unknown as NodeJS.ReadStream,
    output as unknown as NodeJS.WriteStream, (s) => blocks.push(s), options);
  return { input, editor, blocks, screen: () => screen };
}

const PDA: RunnerInputOptions = { label: "pda-runner", interruptInsidePaste: "content" };

describe("runner-pane-io: createRunnerInput options (pda L0)", () => {
  it("pi-runner re-exports the shared editor and endpoint lookup, not a copy", () => {
    expect(piRunner.createRunnerInput).toBe(createRunnerInput);
    expect(piRunner.MAX_PI_INPUT_BYTES).toBe(1024 * 1024);
  });

  it("T5: with onInterrupt, Ctrl-C clears the line and submits nothing", () => {
    const interrupts = vi.fn();
    const t = terminal({ ...PDA, onInterrupt: interrupts });
    try {
      t.input.write("half typed");
      t.input.write(ETX);
      t.input.write("next\r");
      expect(interrupts).toHaveBeenCalledTimes(1);
      expect(t.blocks).toEqual(["next"]);
      expect(t.screen()).not.toContain("input cleared");
    } finally { t.editor.close(); }
  });

  it("T5 equivalence: the Pi default still prints 'input cleared' and submits /abort", () => {
    const t = terminal();
    try {
      t.input.write("half typed" + ETX + "next\r");
      expect(t.blocks).toEqual(["/abort", "next"]);
      expect(t.screen()).toContain("\n[pi-runner] input cleared\n");
    } finally { t.editor.close(); }
  });

  it("T5b: in content mode an ETX inside a paste is pasted text: one block, byte included", () => {
    const t = terminal({ ...PDA, onInterrupt: () => undefined });
    try {
      t.input.write(START + "one" + ETX + "\nline two" + END + "\r");
      expect(t.blocks).toEqual(["one" + ETX + "\nline two"]);
    } finally { t.editor.close(); }
  });

  it("T5b control: the same paste without ETX is one block in both modes", () => {
    for (const options of [PDA, undefined]) {
      const t = terminal(options);
      try {
        t.input.write(START + "one\nline two" + END + "\r");
        expect(t.blocks).toEqual(["one\nline two"]);
      } finally { t.editor.close(); }
    }
  });

  it("T5b equivalence: the Pi default still treats an ETX inside a paste as Ctrl-C (the measured split)", () => {
    const t = terminal();
    try {
      t.input.write(START + "one" + ETX + "\nline two" + END + "\r");
      expect(t.blocks).toEqual(["/abort", "line two"]);
    } finally { t.editor.close(); }
  });

  it("content mode: an ETX after the paste closes is still Ctrl-C", () => {
    const interrupts = vi.fn();
    const t = terminal({ ...PDA, onInterrupt: interrupts });
    try {
      t.input.write(START + "kept" + END + ETX + "after\r");
      expect(interrupts).toHaveBeenCalledTimes(1);
      expect(t.blocks).toEqual(["after"]);
    } finally { t.editor.close(); }
  });

  it("label: the editor's own lines carry the runner's label", () => {
    const t = terminal({ ...PDA, onInterrupt: () => undefined });
    try {
      t.input.write(START + "x".repeat(1024 * 1024 + 1));
      expect(t.screen()).toContain("[pda-runner] input rejected");
      expect(t.screen()).not.toContain("[pi-runner]");
    } finally { t.editor.close(); }
  });

  it("resolveActivityEndpoint reads the env pair first", () => {
    expect(resolveActivityEndpoint({ OPENRIG_URL: "http://127.0.0.1:7433", OPENRIG_ACTIVITY_HOOK_TOKEN: "t0k" }))
      .toEqual({ baseUrl: "http://127.0.0.1:7433", token: "t0k" });
    expect(resolveActivityEndpoint({ OPENRIG_HOME: "/nonexistent-pda-l0", OPENRIG_URL: "http://127.0.0.1:7433" })).toBeNull();
  });
});
