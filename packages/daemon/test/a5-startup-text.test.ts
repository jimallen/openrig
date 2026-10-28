import { describe, expect, it } from "vitest";
import { inertPacketText, inertStartupText, stripPasteTerminators } from "../src/domain/packet-text.js";

// OF-169 (Jim 2026-10-28, "Strip controls, keep tab/newline"): the startup-text rule is inertPacketText's class
// minus TAB, LF and CR. Restated here code point by code point so the class cannot drift unseen.
const KEPT = new Set([0x09, 0x0a, 0x0d]);
const isControl = (c: number) => c <= 0x1f || (c >= 0x7f && c <= 0x9f);

describe("inertStartupText (OF-169)", () => {
  it("removes every C0 control except TAB, LF and CR, DEL, and every C1 control; keeps the rest", () => {
    for (let c = 0; c <= 0x9f; c++) {
      const ch = String.fromCharCode(c);
      const expected = isControl(c) && !KEPT.has(c) ? "" : ch;
      expect(inertStartupText(`<${ch}>`), `U+${c.toString(16).padStart(4, "0")}`).toBe(`<${expected}>`);
    }
  });
  it("leaves printable text, non-ASCII letters and the first code point past C1 alone", () => {
    expect(inertStartupText("naïve ¡ ✓ 日本  x")).toBe("naïve ¡ ✓ 日本  x");
  });
  it("removes both paste-end forms and cannot rejoin them (no control survives to be joined)", () => {
    expect(inertStartupText("a\u001b[201~b\u009b201~c")).toBe("a[201~b201~c");
    expect(stripPasteTerminators(inertStartupText("\u001b[2\u001b[201~01~"))).toBe("[2[201~01~");
    expect(inertStartupText("\u001b[2\u001b[201~01~")).not.toMatch(/[\u001b\u009b]/);
  });
  it("differs from inertPacketText only on CR (inertPacketText keeps TAB and LF and removes CR)", () => {
    const sample = Array.from({ length: 0xa0 }, (_, c) => String.fromCharCode(c)).join("");
    const extra = [...inertStartupText(sample)].filter(ch => !inertPacketText(sample).includes(ch));
    expect(extra.map(ch => ch.charCodeAt(0))).toEqual([0x0d]);
    expect(inertStartupText(sample)).toContain("\t");
  });
});
