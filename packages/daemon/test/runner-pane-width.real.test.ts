// OF-231: the console's character widths against a PRIVATE hc core (helpers/hc-scratch.ts; the host's core is never contacted).
// The symptom (release 55 review of the Pi console, N2): `charWidth` counted U+1F680 and the rest of the Transport and Map Symbols block as one
// cell where the core draws two, so 60 🚀 typed at 200 columns and resized to 31 left one stale rule row; widening the table moves the input
// cursor, so the cursor is pinned here too. The sweep row compares `charWidth` with the core for every code point (U+0020..U+10FFFF).
//
// Not proven here: the Herdr app's own drawing (it reads the core's screen; a font that draws an emoji wider than two cells is not measured),
// a real Pi, and any hc other than the one on PATH (0.1.16 and 0.1.17 were both measured, each on macOS, 0.1.16 also on Linux; the two versions differ, the two OSes do not: see SEQUENCES).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HcAttach, type HcAttachment } from "../src/adapters/hc-attach.js";
import { PI_RUNNER_READY_MARKER } from "../src/adapters/pi-runner-protocol.js";
import type { HcTerminal } from "../src/adapters/hc-client.js";
import { charWidth } from "../src/adapters/runner-pane-frame.js";
import { findHc, startHcScratch, type HcScratch } from "./helpers/hc-scratch.js";
import { coreSequenceWidths, paneWidthTableSource, sweepCoreWidths } from "./helpers/hc-width-sweep.js";
import { panePi, until } from "./helpers/pi-runner-pane.js";

/** hc 0.1.16 and 0.1.17 disagree on these four code points (2 cells, 1 cell); the table is 0.1.17's. Measured both ways. hc 0.1.18 (Linux, hc-hc018) gave the table's answer for every one of the 1,111,999 code points, these four included. */
const VERSION_DEPENDENT = new Set([0x302e, 0x302f, 0x16ff0, 0x16ff1]);

/** Strings whose width the core decides differently by version. [string, cells hc 0.1.16 draws it in (code points added up), cells hc 0.1.17 draws it in (one cluster)]. */
const SEQUENCES: ReadonlyArray<[string, number, number]> = [
  ["🇺🇸", 4, 2], // regional-indicator flag
  ["1️⃣", 1, 2], // keycap
  ["👨‍👩‍👧", 6, 2], // ZWJ family
  ["🏳️‍🌈", 3, 2], // ZWJ rainbow flag
  ["👍🏽", 4, 2], // skin-tone modifier
  ["❤️", 1, 2], // text-default code point + VS16
];

describe.skipIf(!findHc())("charWidth against a private hc core", () => {
  let scratch: HcScratch;
  beforeAll(() => { scratch = startHcScratch(); });
  afterAll(() => { scratch?.cleanup(); });

  // Regeneration, not a check: `cd packages/daemon && OPENRIG_WRITE_PANE_WIDTH_TABLE=1 npx vitest run test/runner-pane-width.real.test.ts -t regenerates`
  // rewrites src/adapters/runner-pane-width-table.ts from this core. The sweep row below then says whether any other hc agrees with the table.
  it.skipIf(!process.env.OPENRIG_WRITE_PANE_WIDTH_TABLE)("regenerates runner-pane-width-table.ts from this core", async () => {
    const version = spawnSync(findHc()!, ["--version"], { encoding: "utf8" }).stdout.trim();
    fs.writeFileSync(fileURLToPath(new URL("../src/adapters/runner-pane-width-table.ts", import.meta.url)), paneWidthTableSource(await sweepCoreWidths(scratch), version));
  }, 180_000);

  it("every code point from U+0020 to U+10FFFF: charWidth is the core's width (the four version-dependent code points aside)", async () => {
    const widths = await sweepCoreWidths(scratch);
    let compared = 0;
    const wrong: string[] = [];
    for (let cp = 0x20; cp <= 0x10ffff; cp++) {
      if ((cp >= 0x7f && cp <= 0x9f) || (cp >= 0xd800 && cp <= 0xdfff) || VERSION_DEPENDENT.has(cp)) continue;
      compared++;
      if (charWidth(cp) !== widths[cp]) wrong.push(`U+${cp.toString(16).toUpperCase()}: core ${widths[cp]}, charWidth ${charWidth(cp)}`);
    }
    expect(compared, "the sweep covered the whole range, less DEL, C1, surrogates and the four").toBe(0x10ffff - 0x20 + 1 - 0x21 - 0x800 - VERSION_DEPENDENT.size);
    expect(wrong.slice(0, 20), `${wrong.length} code points differ`).toEqual([]);
  }, 180_000);

  it("the code points the bug names: 🚀 and the Transport and Map block (its emoji; U+1F6C6 and U+1F6FF are one cell), ✅ ❌ ⭐ ⚡, the U+1FA70 block, a flag's letters are two cells; marks outside U+0300 are none", async () => {
    const widths = await sweepCoreWidths(scratch);
    for (const cp of [0x1f680, 0x1f6c5, 0x1f6dc, 0x1f6fc, 0x2705, 0x274c, 0x2b50, 0x26a1, 0x1fa70, 0x1faf8, 0x1f1e6]) expect([cp.toString(16), widths[cp]], `the core: U+${cp.toString(16)}`).toEqual([cp.toString(16), 2]);
    for (const cp of [0x483, 0x5b0, 0x94d, 0xe31, 0x200d, 0xfe0f, 0x20e3, 0xe0067]) expect([cp.toString(16), widths[cp]], `the core: U+${cp.toString(16)}`).toEqual([cp.toString(16), 0]);
    for (const cp of [0x1f680, 0x1f6c5, 0x1f6dc, 0x1f6fc, 0x2705, 0x274c, 0x2b50, 0x26a1, 0x1fa70, 0x1faf8, 0x1f1e6]) expect(charWidth(cp), `charWidth U+${cp.toString(16)}`).toBe(2);
    for (const cp of [0x483, 0x5b0, 0x94d, 0xe31, 0x200d, 0xfe0f, 0x20e3, 0xe0067]) expect(charWidth(cp), `charWidth U+${cp.toString(16)}`).toBe(0);
  }, 120_000);

  it("a multi-code-point sequence is drawn as the code points added up (hc 0.1.16) or as one cluster (hc 0.1.17), nothing else; charWidth adds up", async () => {
    const drawn = await coreSequenceWidths(scratch, SEQUENCES.map(([s]) => s));
    SEQUENCES.forEach(([text, added, cluster], i) => {
      const label = [...text].map((c) => c.codePointAt(0)!.toString(16)).join("+");
      expect(added, `${label}: charWidth adds the code points up`).toBe([...text].reduce((n, c) => n + charWidth(c.codePointAt(0)!), 0));
      expect([added, cluster], `${label}: the core drew ${drawn[i]} cells`).toContain(drawn[i]);
    });
  }, 90_000);
});

/** The cursor cell (1-based row, column) the core reports for `terminal`: the observer attach is painted the screen and closes with a cursor position. */
async function cursorCell(socketPath: string, terminal: string): Promise<[number, number]> {
  let paint = "";
  const observer = await new HcAttach(socketPath).open({ terminal, cols: 80, rows: 24, observe: true }, { onData: (b) => { paint += b.toString("utf8"); }, onEnd: () => undefined });
  await new Promise((r) => setTimeout(r, 700));
  await observer.detach();
  const cups = [...paint.matchAll(new RegExp(`${String.fromCharCode(27)}\\[(\\d+);(\\d+)H`, "g"))];
  const last = cups[cups.length - 1];
  if (!last) throw new Error(`no cursor position in the paint: ${JSON.stringify(paint.slice(-200))}`);
  return [Number(last[1]), Number(last[2])];
}

describe.skipIf(!findHc())("the input cursor on a line of emoji, through a private hc core", () => {
  let scratch: HcScratch;
  let attachment: HcAttachment;
  const settle = () => new Promise((r) => setTimeout(r, 1000));
  beforeAll(async () => {
    scratch = startHcScratch();
    const pi = panePi(scratch, fs.mkdtempSync(path.join(scratch.root, "cu-")));
    await pi.start("seat", "verify-qa@eztrack");
    await until(() => pi.screen("seat"), (s) => s.some((l) => l.includes(PI_RUNNER_READY_MARKER)), "the READY marker");
    attachment = await new HcAttach(scratch.socketPath).open({ terminal: "seat", cols: 80, rows: 24 }, { onData: () => undefined, onEnd: () => undefined });
    await settle();
  }, 90_000);
  afterAll(async () => { await attachment?.detach().catch(() => undefined); scratch?.cleanup(); });
  const get = () => scratch.client().call<HcTerminal>("terminal.get", { terminal: "seat" });

  it("🚀🚀x then two steps left: the cursor is where the core draws the character, at the end (column 8) and inside the line (column 5)", async () => {
    attachment.write("🚀🚀x");
    await settle();
    // Prompt "❯ " is two cells, 🚀🚀 four, x one: the cursor sits after them at 0-based cell 7, so 1-based column 8, on the last row.
    expect(await cursorCell(scratch.socketPath, "seat"), "at the end of the line").toEqual([24, 8]);
    attachment.write("\u001b[D\u001b[D");
    await settle();
    // Two steps left: before the second 🚀 (x, then 🚀): cell 2 + 2 = 4, so column 5.
    expect(await cursorCell(scratch.socketPath, "seat"), "two characters left").toEqual([24, 5]);
    expect((await get()).rows).toBe(24);
  }, 60_000);
});
