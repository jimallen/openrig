// OF-213 (widened): the line editor and the pane console together, without a core. The editor (Node's readline) still edits; with a frame its
// echo goes nowhere and the frame draws the input row from the editor's line and cursor. Production consequence (OF-214): a pasted rig message
// was echoed into the pane BEFORE the seat gate decided, so a refused repeat stayed visible; and a typed line was overwritten by the next output.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { PaneFrame, type FrameStream } from "../src/adapters/runner-pane-frame.js";
import { createRunnerInput, type RunnerInputStream, type RunnerOutputStream } from "../src/adapters/runner-pane-io.js";

const ESC = "\u001b";

class FakeOut extends EventEmitter {
  rows = 24; columns = 80; isTTY = true; writes: string[] = [];
  write = ((chunk: unknown) => { this.writes.push(String(chunk)); return true; }) as unknown as FrameStream["write"];
}
class FakeIn extends PassThrough {
  isTTY = true; isRaw = false;
  setRawMode(mode: boolean) { this.isRaw = mode; return this; }
}

function rig() {
  const out = new FakeOut();
  const raw: string[] = [];
  const frame = new PaneFrame({ stdout: out as unknown as FrameStream, raw: (t) => raw.push(t), ruleLabel: "── s@r · pi ──" });
  frame.start();
  const input = new FakeIn();
  const submitted: string[] = [];
  const editor = createRunnerInput(input as unknown as RunnerInputStream, out as unknown as RunnerOutputStream, (block) => submitted.push(block), { frame });
  raw.length = 0;
  out.writes.length = 0;                  // the editor's own bracketed-paste mode switch, written when it was made
  const tick = () => new Promise<void>((r) => setTimeout(r, 20));
  // The input row as last drawn: the text after the prompt, up to the cursor-position sequence.
  const row = () => { const paints = raw.filter((t) => t.includes("❯ ")); const last = paints[paints.length - 1] ?? ""; return last.slice(last.lastIndexOf("❯ ") + 2).replace(/\u001b\[\d+;\d+H\u001b\[\?7h$/, ""); };
  return { out, raw, frame, input, editor, submitted, tick, row };
}

describe("the editor with a pane console", () => {
  it("typed text is drawn on the input row, and nothing the editor echoes reaches the output", async () => {
    const { out, input, tick, row } = rig();
    input.write("hello");
    await tick();
    expect(row()).toBe("hello");
    expect(out.writes, "the output stream saw no echo").toEqual([]);
  });
  it("Enter submits the line, once, and the input row is empty again", async () => {
    const { input, submitted, tick, row, out } = rig();
    input.write("hello\r");
    await tick();
    expect(submitted).toEqual(["hello"]);
    expect(row()).toBe("");
    expect(out.writes, "the submitted line was not echoed into the output").toEqual([]);
  });
  it("a bracketed paste of a marked rig message is drawn as its tail with ⏎ for newlines, submitted whole on Enter, and the row clears", async () => {
    const { input, submitted, tick, row } = rig();
    const marker = "[openrig-msg m-1:aaaaaaaaaaaaaaaa]";
    input.write(`${ESC}[200~Line one\nLine two\n${marker}${ESC}[201~`);
    await tick();
    expect(row()).toBe(`Line one⏎Line two⏎${marker}`);
    input.write("\r");
    await tick();
    expect(submitted).toEqual([`Line one\nLine two\n${marker}`]);
    expect(row()).toBe("");
  });
  it("Ctrl-C clears the line and the input row, and says so in the output region", async () => {
    const { input, tick, row, out, submitted } = rig();
    input.write("abc");
    await tick();
    input.write("\u0003");
    await tick();
    expect(row()).toBe("");
    expect(out.writes.join("")).toContain("input cleared");
    expect(submitted).toEqual(["/abort"]);
  });
  it("closing the editor gives the pane back", async () => {
    const { editor, raw, frame, tick } = rig();
    editor.close();
    await tick();
    expect(frame.active).toBe(false);
    expect(raw.join("")).toContain(`${ESC}[r${ESC}[24;1H`);
  });
  it("without a frame the editor echoes into the output as before", async () => {
    const out = new FakeOut();
    const input = new FakeIn();
    createRunnerInput(input as unknown as RunnerInputStream, out as unknown as RunnerOutputStream, () => undefined);
    input.write("hello");
    await new Promise((r) => setTimeout(r, 20));
    expect(out.writes.join("")).toContain("hello");
  });
});
