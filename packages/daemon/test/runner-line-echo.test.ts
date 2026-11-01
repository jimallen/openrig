// hc cutover W47 (security N11): the shared line editor echoes a message with no ESC byte of its own making. In-process on a fake
// tty; the real-core rows are in runner-line-echo.real.test.ts. The editor's redraw escapes (cursor, erase) are the runner's and stay.
import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import { createRunnerInput, type RunnerInputOptions } from "../src/adapters/runner-pane-io.js";

const ESC = "\u001b";
const START = `${ESC}[200~`;
const END = `${ESC}[201~`;

function terminal(options?: RunnerInputOptions) {
  const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: false,
    setRawMode: vi.fn(function (this: { isRaw: boolean }, value: boolean) { this.isRaw = value; }) });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
  const blocks: string[] = [];
  let screen = "";
  output.on("data", (chunk) => { screen += chunk.toString(); });
  const editor = createRunnerInput(input, output, (s) => blocks.push(s), options);
  return { input, editor, blocks, screen: () => screen };
}
const escCount = (s: string) => s.split(ESC).length - 1;

/** Hostile texts, each a form the review measured or a neighbour of one. Every ESC is replaced by "~" in the control text. */
const HOSTILE = [
  `before ${ESC}[2J${ESC}[H after`,
  `${ESC}[1G${ESC}[2K${ESC}[1A${ESC}[2K[pi-runner] ERROR forged`,
  `x${ESC}[8m hidden ${ESC}[0m`,
  `${ESC}]7501;state=blocked:app=f${ESC}\\ tail`,
  `${ESC}[?1049h alt screen`,
  `${ESC}c reset`,
];

describe.each([
  ["pi defaults", undefined],
  ["pda options", { label: "pda-runner", interruptInsidePaste: "content", onInterrupt: () => undefined } satisfies RunnerInputOptions],
])("line editor echo of a message (%s)", (_name, options) => {
  it.each(HOSTILE)("a pasted message %j echoes no ESC of its own: the redraw has exactly the ESC count of the same text with '~' for ESC", (text) => {
    const hostile = terminal(options);
    const control = terminal(options);
    try {
      hostile.input.write(START + text + END);
      control.input.write(START + text.replaceAll(ESC, "~") + END);
      expect(escCount(hostile.screen()), "same redraw, none of the message's own").toBe(escCount(control.screen()));
      for (const form of ["[2J", "[H", "[8m", "]7501", "[?1049h", "c reset"]) {
        if (text.includes(`${ESC}${form}`)) expect(hostile.screen(), `${form} is not on the screen as an escape`).not.toContain(`${ESC}${form}`);
      }
    } finally { hostile.editor.close(); control.editor.close(); }
  });

  it("the submitted block is the pasted text without its ESC bytes (the line is what is echoed and what is sent)", () => {
    const t = terminal(options);
    try {
      t.input.write(START + `go ${ESC}[2J now` + END);
      t.input.write("\r");
      expect(t.blocks).toEqual(["go [2J now"]);
    } finally { t.editor.close(); }
  });

  it("a message typed as plain bytes (no paste framing) puts none of its own escapes on the pane: the editor parses them as keys", () => {
    for (const text of HOSTILE) {
      const t = terminal(options);
      try {
        t.input.write(text);
        // Past the editor's own mode switch-on, a single-row message is echoed as its printable text and nothing else
        // (a form that is a key, such as ESC[H or ESC[8m, moves the cursor and is not asserted here: the pasted rows cover it).
        for (const form of ["[2J", "]7501", "[?1049h", "c "]) expect(t.screen(), `${JSON.stringify(text)}: ${form}`).not.toContain(`${ESC}${form}`);
      } finally { t.editor.close(); }
    }
  });

  it("editing keys still work: arrows, Home/End, Backspace, Delete, Ctrl-A/E/U/W, then Enter submits the edited line", () => {
    const t = terminal(options);
    try {
      const LEFT = `${ESC}[D`, RIGHT = `${ESC}[C`, HOME = `${ESC}[H`, END_KEY = `${ESC}[F`, DEL = `${ESC}[3~`;
      t.input.write(`abcd${LEFT}${LEFT}\u007fx\r`);      // ab|cd -> a|cd -> ax|cd
      t.input.write(`hello${HOME}>${END_KEY}!\r`);        // >hello!
      t.input.write(`abc${HOME}${DEL}${RIGHT}Z\r`);       // |abc -> |bc -> bZc
      t.input.write("one two\u0017X\r");                  // Ctrl-W deletes "two"
      t.input.write("junk\u0015kept\r");                  // Ctrl-U clears the line
      t.input.write("tail\u0001<\u0005>\r");              // Ctrl-A start, Ctrl-E end
      expect(t.blocks).toEqual(["axcd", ">hello!", "bZc", "one X", "kept", "<tail>"]);
    } finally { t.editor.close(); }
  });

  it("a paste with ESC bytes lands at the cursor, which sits after the text actually inserted: typing continues there", () => {
    const t = terminal(options);
    try {
      t.input.write(`abXY${ESC}[D${ESC}[D${START}${ESC}[2J-${END}c\r`);
      expect(t.blocks).toEqual(["ab[2J-cXY"]);
    } finally { t.editor.close(); }
  });
});
