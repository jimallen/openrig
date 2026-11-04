// OF-213 (widened): what the Pi runner's pane console writes, without a core. Production consequence: the bottom two rows of a Pi seat's
// pane are the rule naming the seat and the input line. If the output region were wrong, a reply would overwrite the input line, or the seat
// gate's staged-paste check (seat-hops.ts looks for the message's marker on the screen) would not see a paste waiting on the line. The
// real-core proof is runner-pane-frame.real.test.ts. The escape sequences below are restated here, not imported.
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { charWidth, inputView, PaneFrame, reflowedRows, ruleText } from "../src/adapters/runner-pane-frame.js";

const ESC = "\u001b";

class FakeStream extends EventEmitter {
  rows = 24; columns = 80; isTTY = true;
  writes: unknown[][] = [];
  write = (...args: unknown[]): boolean => { this.writes.push(args); return true; };
}

function rig(label = "── s@r · pi · m ──") {
  const stream = new FakeStream();
  const log: string[] = [];
  const frame = new PaneFrame({ stdout: stream, raw: (t) => log.push(`RAW ${JSON.stringify(t)}`), ruleLabel: label });
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

describe("the rows a drawn line reflows to (OF-218)", () => {
  it("ASCII is ceil(width / columns), and a line that exactly fills the columns is one row", () => {
    expect(reflowedRows("", 31)).toBe(1);
    expect(reflowedRows("x".repeat(31), 31)).toBe(1);
    expect(reflowedRows("x".repeat(32), 31)).toBe(2);
    expect(reflowedRows("x".repeat(62), 31)).toBe(2);
    expect(reflowedRows("x".repeat(63), 31)).toBe(3);
  });
  it("a wide character that does not fit at the edge moves whole to the next row, leaving a blank cell (60 あ after a 2-column prompt at 31: 5 rows; at 32: 4)", () => {
    expect(reflowedRows(`❯ ${"あ".repeat(60)}`, 31)).toBe(5);
    expect(reflowedRows(`❯ ${"あ".repeat(60)}`, 32)).toBe(4);
    expect(reflowedRows("あ".repeat(2), 3)).toBe(2);
  });
  it("a zero-width character (a combining mark) takes no cell, even at the edge", () => {
    expect(reflowedRows("e\u0301".repeat(31), 31)).toBe(1);
    expect(reflowedRows(`${"x".repeat(30)}e\u0301`, 31)).toBe(1);
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
    stream.write = (...a: unknown[]): boolean => { seen.push(a); log.push("EMIT"); return true; };
    frame.start(); frame.wrap(stream); log.length = 0;
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
  // OF-216. The core reflows the old frame before the runner hears of the resize; the stale rows are the old rule and input row at their
  // old logical widths, ceil(width / newColumns) rows each, ending at the last row. The frame erases them and paints at the new bottom.
  const L = "── s@r · pi · m ──";
  it("a shrink erases the reflowed old frame (80 columns at 32: 3 rows for the rule, 1 for the input), opens the region again, continues output on the first freed row, and paints at the new bottom", () => {
    const { stream, log, frame } = rig();
    frame.start(); log.length = 0;
    stream.rows = 17; stream.columns = 32;
    stream.emit("resize");
    expect(log).toEqual([`RAW ${JSON.stringify(`${ESC}[1;15r${ESC}[14;1H${ESC}[J${ESC}[14;1H${ESC}7${paint(17, 32, L, "", 0)}`)}`]);
  });
  it("a shrink counts the input row's own width: a typed line of 40 characters at 32 columns is 2 rows more", () => {
    const { stream, log, frame } = rig();
    frame.start(); frame.setInput("x".repeat(40), 40); log.length = 0;
    stream.rows = 17; stream.columns = 32;
    stream.emit("resize");
    // rule 80 -> 3 rows, input "❯ " + 40 = 42 -> 2 rows: 5 stale rows, the first at row 13
    expect(log[0]!.startsWith(`RAW ${JSON.stringify(`${ESC}[1;15r${ESC}[13;1H${ESC}[J${ESC}[13;1H${ESC}7`).slice(0, -1)}`)).toBe(true);
  });
  // OF-218 (review of216 F1). A wide character cannot split at the wrap: the core leaves the last cell of the row blank and moves it to the next
  // row, so a row of wide characters reflows to MORE rows than ceil(width / columns). Measured on a private core (hc 0.1.17): 60 あ typed at
  // 200x40 (the input row is "❯ " and 120 columns), resized to 31x20: the input row reflows to 5 rows (14 characters, then 15 per row), not
  // ceil(122 / 31) = 4. Counted by the old frame as 4, the erase started one row too low and one rule row stayed on the screen.
  it("a shrink counts the rows a line of wide characters reflows to (60 あ at 31 columns is 5 rows, not ceil(122/31)): the erase starts at the first stale row", () => {
    const { stream, log, frame } = rig();
    stream.rows = 40; stream.columns = 200;
    frame.start(); frame.setInput("あ".repeat(60), 60); log.length = 0;
    stream.rows = 20; stream.columns = 31;
    stream.emit("resize");
    // rule 200 columns -> 7 rows, input row 5 rows: 12 stale rows, the first at row 20 - 12 + 1 = 9
    expect(log[0]!.startsWith(`RAW ${JSON.stringify(`${ESC}[1;18r${ESC}[9;1H${ESC}[J${ESC}[9;1H${ESC}7`).slice(0, -1)}`)).toBe(true);
  });
  // OF-218, second cause (measured on the same core, ASCII only): the core reflows the input row together with the cursor cell. A line that fills
  // the row to columns-1 with the cursor at its end occupies `columns` cells, so at one column less it is two rows; with the cursor inside the line
  // it stays one. 29 x typed at 32 columns, resized to 31x20: the frame counted 1 row for the input and left one rule row.
  it("a shrink counts the cursor's cell at the end of the input row: 29 characters at 32 columns, resized to 31, are 2 rows (and 2 for the rule)", () => {
    const { stream, log, frame } = rig();
    stream.rows = 20; stream.columns = 32;
    frame.start(); frame.setInput("x".repeat(29), 29); log.length = 0;
    stream.columns = 31;
    stream.emit("resize");
    // rule 32 columns -> 2 rows, input row ("❯ " + 29 + the cursor cell = 32 cells) 2 rows: 4 stale rows, the first at row 17
    expect(log[0]!.startsWith(`RAW ${JSON.stringify(`${ESC}[1;18r${ESC}[17;1H${ESC}[J${ESC}[17;1H${ESC}7`).slice(0, -1)}`)).toBe(true);
  });
  it("a cursor inside the line adds no cell: the same line with the cursor at column 5 is 1 row at 31 columns (3 stale rows, the first at row 18)", () => {
    const { stream, log, frame } = rig();
    stream.rows = 20; stream.columns = 32;
    frame.start(); frame.setInput("x".repeat(29), 5); log.length = 0;
    stream.columns = 31;
    stream.emit("resize");
    expect(log[0]!.startsWith(`RAW ${JSON.stringify(`${ESC}[1;18r${ESC}[18;1H${ESC}[J${ESC}[18;1H${ESC}7`).slice(0, -1)}`)).toBe(true);
  });
  it("a growth in width (the frame was drawn at 32 columns, one row each) erases two rows and opens a line at the bottom of the region so the last output line is kept", () => {
    const { stream, log, frame } = rig();
    stream.columns = 32; stream.rows = 17;
    frame.start(); log.length = 0;
    stream.columns = 80; stream.rows = 24;
    stream.emit("resize");
    expect(log).toEqual([`RAW ${JSON.stringify(`${ESC}[1;22r${ESC}[23;1H${ESC}[J${ESC}[22;1H\n${ESC}7${paint(24, 80, L, "", 0)}`)}`]);
  });
  it("a height change alone does the same at the new bottom", () => {
    const { stream, log, frame } = rig();
    frame.start(); log.length = 0;
    stream.rows = 30;
    stream.emit("resize");
    expect(log).toEqual([`RAW ${JSON.stringify(`${ESC}[1;28r${ESC}[29;1H${ESC}[J${ESC}[28;1H\n${ESC}7${paint(30, 80, L, "", 0)}`)}`]);
  });
  it("two resizes in a row model the frame each time was drawn at (the second erases what the first painted, not the original)", () => {
    const { stream, log, frame } = rig();
    frame.start();
    stream.rows = 17; stream.columns = 32; stream.emit("resize");
    log.length = 0;
    stream.rows = 24; stream.columns = 80; stream.emit("resize");
    // drawn at 32 columns: one row for each of the rule and the input: top = 24 - 2 + 1 = 23
    expect(log).toEqual([`RAW ${JSON.stringify(`${ESC}[1;22r${ESC}[23;1H${ESC}[J${ESC}[22;1H\n${ESC}7${paint(24, 80, L, "", 0)}`)}`]);
  });
  it("a pane resized below the minimum is given back: the frame is erased, the region reset, the cursor left where output continues, and writes are unframed", () => {
    const { stream, log, frame } = rig();
    frame.start(); log.length = 0;
    stream.rows = 5; stream.columns = 20;
    stream.emit("resize");
    // the frame drawn at 80 columns is 4 + 1 rows at 20, the whole 5-row pane
    expect(log).toEqual([`RAW ${JSON.stringify(`${ESC}[1;1H${ESC}[J${ESC}[r${ESC}[1;1H`)}`]);
    expect(frame.active).toBe(false);
    log.length = 0;
    frame.write(() => { log.push("EMIT"); return true; });
    frame.setInput("x", 1);
    expect(log).toEqual(["EMIT"]);
  });
  it.each([
    ["too few rows only (5 rows, 80 columns)", 5, 80],
    ["too few columns only (24 rows, 23 columns)", 24, 23],
  ])("%s: the pane is given back", (_name, rows, columns) => {
    const { stream, frame } = rig();
    frame.start();
    stream.rows = rows; stream.columns = columns; stream.emit("resize");
    expect(frame.active).toBe(false);
  });
  it("the smallest pane that holds the frame (6 rows, 24 columns) keeps it after a resize", () => {
    const { stream, log, frame } = rig();
    frame.start(); log.length = 0;
    stream.rows = 6; stream.columns = 24; stream.emit("resize");
    expect(frame.active).toBe(true);
    expect(log).toHaveLength(1);
  });
  it("giving the pane back erases from the first stale row, not from the top of the pane (review F2): a frame drawn at 32 columns, a pane resized to 23x40", () => {
    const { stream, log, frame } = rig();
    stream.rows = 40; stream.columns = 32;
    frame.start(); log.length = 0;
    stream.columns = 23; stream.emit("resize");
    // the rule drawn 32 wide is 2 rows at 23 columns, the input row 1: 3 stale rows, the first at 40 - 3 + 1 = 38
    expect(log).toEqual([`RAW ${JSON.stringify(`${ESC}[38;1H${ESC}[J${ESC}[r${ESC}[38;1H`)}`]);
    expect(frame.active).toBe(false);
  });
  it("at exactly three stale rows the first stale row is the region's last row, and output continues there without opening a line (review F3)", () => {
    const { stream, log, frame } = rig();
    frame.start(); log.length = 0;
    stream.columns = 40; stream.emit("resize");
    // rule 80 wide is 2 rows at 40 columns, input 1: 3 stale rows, top = 24 - 3 + 1 = 22 = rows - 2
    expect(log).toEqual([`RAW ${JSON.stringify(`${ESC}[1;22r${ESC}[22;1H${ESC}[J${ESC}[22;1H${ESC}7${paint(24, 40, L, "", 0)}`)}`]);
  });
  it("a pane still below the minimum on the next resize changes nothing", () => {
    const { stream, log, frame } = rig();
    frame.start();
    stream.rows = 5; stream.columns = 20; stream.emit("resize");
    log.length = 0;
    stream.rows = 4; stream.emit("resize");
    expect(log).toEqual([]);
  });
  it("a pane taken again scrolls three rows up (two for the frame, one for the output), sets the region and paints", () => {
    const { stream, log, frame } = rig();
    frame.start();
    stream.rows = 5; stream.columns = 20; stream.emit("resize");
    log.length = 0;
    stream.rows = 24; stream.columns = 80; stream.emit("resize");
    expect(log).toEqual([`RAW ${JSON.stringify(`${ESC}[24;1H\n\n\n${ESC}[1;22r${ESC}[22;1H${ESC}7${paint(24, 80, L, "", 0)}`)}`]);
    expect(frame.active).toBe(true);
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
