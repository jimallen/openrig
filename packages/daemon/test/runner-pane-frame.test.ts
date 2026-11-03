// OF-213 (widened): what the Pi runner's pane console writes, without a core. Production consequence: the bottom two rows of a Pi seat's
// pane are the rule naming the seat and the input line. If the output region were wrong, a reply would overwrite the input line, or the seat
// gate's staged-paste check (seat-hops.ts looks for the message's marker on the screen) would not see a paste waiting on the line. The
// real-core proof is runner-pane-frame.real.test.ts. The escape sequences below are restated here, not imported.
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { charWidth, inputView, PaneFrame, ruleText, type FrameStream } from "../src/adapters/runner-pane-frame.js";

const ESC = "\u001b";

class FakeStream extends EventEmitter {
  rows = 24; columns = 80; isTTY = true;
  writes: unknown[][] = [];
  write = ((...args: unknown[]) => { this.writes.push(args); return true; }) as unknown as FrameStream["write"];
  off(event: "resize", listener: () => void): this { return super.off(event, listener); }
}

function rig(label = "── s@r · pi · m ──") {
  const stream = new FakeStream();
  const log: string[] = [];
  const frame = new PaneFrame({ stdout: stream as unknown as FrameStream, raw: (t) => log.push(`RAW ${JSON.stringify(t)}`), ruleLabel: label });
  return { stream, log, frame };
}
// The two bottom rows for 80 columns, 24 rows, and `input` on the input line with the cursor `col` columns into it.
const paint = (rows: number, columns: number, label: string, input: string, col: number) =>
  `${ESC}[?7l${ESC}[${rows - 1};1H${ESC}[2K${ESC}[2m${ruleText(label, columns)}${ESC}[0m${ESC}[${rows};1H${ESC}[2K❯ ${input}${ESC}[${rows};${3 + col}H${ESC}[?7h`;

describe("what the input line shows", () => {
  it("a line that fits is shown whole, the cursor where the editor has it", () => {
    expect(inputView("hello", 5, 40)).toEqual({ text: "hello", cursorColumn: 5 });
    expect(inputView("hello", 2, 40)).toEqual({ text: "hello", cursorColumn: 2 });
    expect(inputView("", 0, 40)).toEqual({ text: "", cursorColumn: 0 });
  });
  it("a longer line shows its tail, led by an ellipsis, with the cursor at its end", () => {
    const view = inputView("0123456789abcdefghij", 20, 10);
    expect(view).toEqual({ text: "…bcdefghij", cursorColumn: 10 });
  });
  it("a cursor moved left into a long line keeps the cursor on screen", () => {
    const view = inputView("0123456789abcdefghij", 12, 10);
    expect(view.text).toBe("…45678 9abc".replace(" ", ""));
    expect(view.cursorColumn).toBeLessThanOrEqual(10);
    expect(view.text.length).toBeLessThanOrEqual(10);
  });
  it("a newline is a ⏎ (CRLF one), another control character a ·, so no control byte is drawn", () => {
    expect(inputView("a\nb\r\nc\rd\u0007e\u007ff\u009cg", 0, 40).text).toBe("a⏎b⏎c⏎d·e·f·g");
  });
  it("counts a wide character as two columns and a combining mark as none", () => {
    expect(charWidth(0x4e00)).toBe(2);
    expect(charWidth(0x0301)).toBe(0);
    expect(charWidth(0x41)).toBe(1);
    expect(inputView("日本語", 3, 40)).toEqual({ text: "日本語", cursorColumn: 6 });
    expect(inputView("日本語日本語", 6, 7).text).toBe("…日本語");
  });
  it("a cursor offset after an astral character counts it as one character", () => {
    expect(inputView("a😀b", 3, 40).cursorColumn).toBe(3);
  });
  it("shows the end of a staged multi-line paste, where the daemon looks for the message's marker (seat-hops.ts: whitespace removed, then substring)", () => {
    const marker = "[openrig-msg m-1:aaaaaaaaaaaaaaaa]";
    const staged = `Message one.\nA second line of the body.\n${marker}`;
    const view = inputView(staged, staged.length, 80 - 2 - 1);
    expect(view.text.replace(/\s+/g, "")).toContain(marker.replace(/\s+/g, ""));
    expect(view.text.endsWith(marker)).toBe(true);
  });
});

describe("the rule", () => {
  it("is the label, then rule characters to the edge of the pane", () => {
    expect(ruleText("── s@r · pi ──", 30)).toBe(`── s@r · pi ── ${"─".repeat(30 - 14 - 1)}`);
    expect([...ruleText("── s@r · pi ──", 30)]).toHaveLength(30);
  });
  it("is cut to the pane's width when the label is wider", () => {
    expect(ruleText("── a-very-long-seat-name@some-rig ──", 12)).toBe("── a-very-lo");
  });
  it("carries no control character from the label", () => {
    expect(ruleText("── a\u001b[2Jb ──", 40)).not.toContain(ESC);
  });
});

describe("the frame's writes", () => {
  it("start: the screen is pushed up, the region is rows 1..R-2, the cursor is saved at the top, and the two rows are drawn", () => {
    const { log, frame } = rig();
    frame.start();
    expect(log).toEqual([`RAW ${JSON.stringify(`${"\n".repeat(24)}${ESC}[1;22r${ESC}[1;1H${ESC}7${paint(24, 80, "── s@r · pi · m ──", "", 0)}`)}`]);
  });
  it("text goes between a restore and a save of the output cursor, and the rows are redrawn after it", () => {
    const { log, frame } = rig();
    frame.start(); log.length = 0;
    frame.write(() => { log.push("EMIT"); return true; });
    expect(log).toEqual([`RAW ${JSON.stringify(`${ESC}8`)}`, "EMIT", `RAW ${JSON.stringify(`${ESC}7${paint(24, 80, "── s@r · pi · m ──", "", 0)}`)}`]);
  });
  it("wrap: a stream's write (with its encoding and callback) is the text emitted in that place", () => {
    const { stream, log, frame } = rig();
    const original = stream.write;
    const seen: unknown[][] = [];
    stream.write = ((...a: unknown[]) => { seen.push(a); log.push("EMIT"); return true; }) as unknown as FrameStream["write"];
    frame.start(); frame.wrap(stream as unknown as Pick<NodeJS.WriteStream, "write">); log.length = 0;
    const cb = () => undefined;
    stream.write("reply\n", "utf8", cb);
    expect(seen).toEqual([["reply\n", "utf8", cb]]);
    expect(log[0]).toBe(`RAW ${JSON.stringify(`${ESC}8`)}`);
    expect(log[1]).toBe("EMIT");
    expect(log[2]!.startsWith(`RAW ${JSON.stringify(`${ESC}7${ESC}[?7l`).slice(0, -1)}`)).toBe(true);
    expect(log).toHaveLength(3);
    void original;
  });
  it("setInput: the input row shows the text and the cursor sits where the editor's cursor is", () => {
    const { log, frame } = rig();
    frame.start(); log.length = 0;
    frame.setInput("abc", 1);
    expect(log).toEqual([`RAW ${JSON.stringify(paint(24, 80, "── s@r · pi · m ──", "abc", 1))}`]);
  });
  it("a resize sets the region again for the new height, puts the output cursor at its bottom, and draws the rows there", () => {
    const { stream, log, frame } = rig();
    frame.start(); log.length = 0;
    stream.rows = 30; stream.columns = 100;
    stream.emit("resize");
    expect(log).toEqual([`RAW ${JSON.stringify(`${ESC}[1;28r${ESC}[28;1H${ESC}7${paint(30, 100, "── s@r · pi · m ──", "", 0)}`)}`]);
  });
  it("a resize to a pane too small for the frame changes nothing", () => {
    const { stream, log, frame } = rig();
    frame.start(); log.length = 0;
    stream.rows = 4;
    stream.emit("resize");
    expect(log).toEqual([]);
  });
  it("stop: the region is reset and the cursor goes to the last row, once", () => {
    const { log, frame } = rig();
    frame.start(); log.length = 0;
    frame.stop(); frame.stop();
    expect(log).toEqual([`RAW ${JSON.stringify(`${ESC}[r${ESC}[24;1H${ESC}[2K\n`)}`]);
    expect(frame.active).toBe(false);
  });
  it("after stop, text is emitted as it comes and nothing is drawn", () => {
    const { log, frame } = rig();
    frame.start(); frame.stop(); log.length = 0;
    frame.write(() => { log.push("EMIT"); return true; });
    frame.setInput("x", 1);
    expect(log).toEqual(["EMIT"]);
  });
});

describe("when the pane cannot hold the frame", () => {
  it.each([
    ["not a tty", { isTTY: false }],
    ["fewer than 6 rows", { rows: 5 }],
    ["fewer than 24 columns", { columns: 23 }],
  ])("%s: not usable, start draws nothing and text is emitted as it comes", (_name, change) => {
    const { stream, log, frame } = rig();
    Object.assign(stream, change);
    expect(frame.usable).toBe(false);
    frame.start();
    expect(frame.active).toBe(false);
    frame.write(() => { log.push("EMIT"); return true; });
    expect(log).toEqual(["EMIT"]);
  });
  it("6 rows and 24 columns are the smallest pane that holds it", () => {
    const { stream, frame } = rig();
    stream.rows = 6; stream.columns = 24;
    expect(frame.usable).toBe(true);
  });
});
