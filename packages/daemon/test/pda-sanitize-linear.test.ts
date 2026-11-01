// hc-w45 (security N10): `sanitizeForPane` is linear, and it is the SAME function as before. The old regex form is restated here as
// the oracle; the new scanner must give its output on every input of a fuzz over the escape alphabet. Cost: 200 KB of unterminated
// introducers took 4.5 s with the regex.
import { describe, expect, it } from "vitest";
import { sanitizeForPane } from "../src/adapters/pda-runner-protocol.js";

// The oracle: the previous implementation, verbatim.
const OLD_ESCAPES = new RegExp([
  "\\u001b\\][\\s\\S]*?(?:\\u0007|\\u001b\\\\)",
  "\\u001b[PX^_][\\s\\S]*?\\u001b\\\\",
  "\\u001b\\[[0-?]*[ -/]*[@-~]",
  "\\u001b[ -/]*[0-~]",
  "\\u009d[\\s\\S]*?(?:\\u0007|\\u009c|\\u001b\\\\)",
  "[\\u0090\\u0098\\u009e\\u009f][\\s\\S]*?(?:\\u009c|\\u001b\\\\)",
  "\\u009b[0-?]*[ -/]*[@-~]",
].join("|"), "g");
const OLD_CONTROLS = new RegExp("[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f]", "g");
const OLD_BIDI = new RegExp("[\\u061c\\u200e\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]", "g");
const oldSanitize = (t: string): string => t.replace(OLD_ESCAPES, "").replace(OLD_CONTROLS, "").replace(OLD_BIDI, "");

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const ESC = "\u001b";
const PIECES = [
  ESC, ESC, ESC, "]", "[", "P", "X", "^", "_", "\\", "\u0007", "\u0000", "\u0008", "\u0009", "\u000a", "\u000d", "\u0018", "\u007f",
  "\u0080", "\u0090", "\u0098", "\u009b", "\u009c", "\u009d", "\u009e", "\u009f", "\u061c", "\u200e", "\u202a", "\u2066", "\u2028",
  "0", "1", ";", "?", "h", "m", "@", "~", " ", "/", "!", "a", "é", "😀", "7501;state=blocked", "\n",
];

describe("sanitizeForPane is linear and unchanged", () => {
  it("equals the previous regex implementation on 20000 random inputs over the escape alphabet", () => {
    const next = rng(0x5a17);
    let changed = 0;
    for (let n = 0; n < 20_000; n++) {
      let s = ""; const len = Math.floor(next() * 50);
      for (let i = 0; i < len; i++) s += PIECES[Math.floor(next() * PIECES.length)];
      const expected = oldSanitize(s);
      if (expected !== s) changed++;
      expect(sanitizeForPane(s), JSON.stringify(s)).toBe(expected);
    }
    expect(changed, "positive control: the fuzz really exercises removal").toBeGreaterThan(10_000);
  });
  it.each([
    ["an OSC with an ST", `a${ESC}]0;title${ESC}\\b`, "ab"],
    ["an OSC with a BEL", `a${ESC}]0;title\u0007b`, "ab"],
    ["an unterminated OSC loses only its introducer", `a${ESC}]0;title`, "a0;title"],
    ["a DCS", `a${ESC}Pq;x${ESC}\\b`, "ab"],
    ["a CSI", `a${ESC}[31mb`, "ab"],
    ["a C1 OSC", "a\u009d0;t\u009cb", "ab"],
    ["controls and bidi marks", "a\u0001\u007f\u200fb\tc\nd", "ab\tc\nd"],
  ])("%s", (_name, input, expected) => {
    expect(sanitizeForPane(input)).toBe(expected);
  });
  it.each([
    ["unterminated OSC introducers", `${ESC}]7501;x`],
    ["unterminated DCS introducers", `${ESC}Pq`],
    ["unterminated C1 OSC", "\u009d7501;x"],
    ["ESC CSI openers with no final", `${ESC}[1;2;`],
    ["ESC and spaces", `${ESC}   `],
  ])("200 KB of %s in well under a second (the regex took 4.5 s)", (_name, unit) => {
    const text = unit.repeat(Math.ceil(200_000 / unit.length));
    const started = Date.now();
    sanitizeForPane(text);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
