// OF-216: the Pi runner's pane console across resizes, through a PRIVATE hc core (own HOME, HC_SESSION and XDG paths via
// helpers/hc-scratch.ts; the host's core and app are never contacted), against an offline fake `pi`.
//
// The symptom (live, release 42, eztrack): seats launch at 200 columns and rig-here resizes them to 32x17. The core reflows the screen
// before the runner hears of it, so the 200-column rule became 7 wrapped rows and every resize left more of them: "mostly old rules".
// The pane is read as a late observer is painted it (helpers/hc-physical-screen.ts), because `hc read` joins wrapped rows into one
// logical line and trims blank rows, so it cannot show a rule that wraps. A pane is resized the only way hc offers: a writer attach
// and its RESIZE frame (there is no terminal.resize call and no CLI command).
//
// Not proven here: the Herdr app's own drawing of the pane, a real Pi, a resize WHILE a reply is streaming mid-line (the output cursor
// column is lost; the stream goes on at the start of the next row).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { HcAttach, type HcAttachment } from "../src/adapters/hc-attach.js";
import { PI_RUNNER_READY_MARKER } from "../src/adapters/pi-runner-protocol.js";
import type { HcTerminal } from "../src/adapters/hc-client.js";
import { physicalRows } from "./helpers/hc-physical-screen.js";
import { findHc, startHcScratch, type HcScratch } from "./helpers/hc-scratch.js";
import { panePi, until, type PanePi } from "./helpers/pi-runner-pane.js";

// Restated here, not imported: what the rule is for a pane `columns` wide (the label cut to the width, else the label, a space and rule characters).
const LABEL = "── verify-qa@eztrack · pi · openai-codex/gpt-6-luna:medium ──";
const ruleFor = (columns: number) => (LABEL.length >= columns ? LABEL.slice(0, columns) : `${LABEL} ${"─".repeat(columns - LABEL.length - 1)}`);

describe.skipIf(!findHc())("a Pi seat's pane console across resizes, through a private hc core", () => {
  let scratch: HcScratch;
  let pi: PanePi;
  let attachment: HcAttachment;
  const get = (name: string) => scratch.client().call<HcTerminal>("terminal.get", { terminal: name });
  const settle = () => new Promise((r) => setTimeout(r, 1200));
  const resize = async (columns: number, rows: number) => {
    attachment.resize(columns, rows);
    await until(() => get("seat"), (t) => t.cols === columns && t.rows === rows, `the pane to be ${columns}x${rows}`, 10_000);
    await settle();
  };
  const rowsNow = () => physicalRows(scratch.socketPath, "seat");
  /** Exactly one rule and one input row, on the last two rows, and no stale rule row anywhere above them. */
  async function expectFrame(columns: number, rows: number) {
    const screen = await rowsNow();
    expect(screen, `${columns}x${rows}: the screen has the pane's rows`).toHaveLength(rows);
    expect(screen[rows - 2], `${columns}x${rows}: the rule, one unwrapped row, on the second-last row`).toBe(ruleFor(columns));
    expect(screen[rows - 1]!.trimEnd(), `${columns}x${rows}: the input row on the last row`).toBe("❯");
    const above = screen.slice(0, rows - 2);
    expect(above.filter((r) => /^─+$/.test(r) || r.startsWith("── verify-qa")), `${columns}x${rows}: no stale rule row above the frame`).toEqual([]);
    expect(above.filter((r) => r.startsWith("❯")), `${columns}x${rows}: no stale input row above the frame`).toEqual([]);
    return screen;
  }

  beforeAll(async () => {
    scratch = startHcScratch();
    const temp = fs.mkdtempSync(path.join(scratch.root, "rz-"));
    pi = panePi(scratch, temp);
    await pi.start("seat", "verify-qa@eztrack");
    await until(() => pi.screen("seat"), (s) => s.some((l) => l.includes(PI_RUNNER_READY_MARKER)), "the READY marker");
    // 300 lines of output, so the banner has left the screen and every row above the frame is a numbered line.
    await scratch.client().call("terminal.send", { terminal: "seat", text: "flood the pane" }, { timeoutMs: 20_000 });
    await until(() => get("seat"), (t) => t.status?.state === "idle" && (t.turn ?? 0) >= 1, "the flooding turn");
    attachment = await new HcAttach(scratch.socketPath).open({ terminal: "seat", cols: 200, rows: 120 }, { onData: () => undefined, onEnd: () => undefined });
    await settle();
  }, 90_000);
  afterAll(async () => { await attachment?.detach().catch(() => undefined); scratch?.cleanup(); });

  it("the frame is right at the size the pane started at", async () => { await expectFrame(200, 120); }, 30_000);

  it("shrunk from 200x120 to 32x17 (what rig-here does): one unwrapped rule, one input row, nothing stale above them", async () => {
    await resize(32, 17);
    const screen = await expectFrame(32, 17);
    expect(screen.some((r) => r.includes("flood line 299")), "the last output is still on the screen").toBe(true);
  }, 60_000);

  it("repeated resizes (80x24, 32x17, 200x120, 80x30, 32x17) leave exactly one frame each time", async () => {
    for (const [c, r] of [[80, 24], [32, 17], [200, 120], [80, 30], [32, 17]] as const) {
      await resize(c, r);
      await expectFrame(c, r);
    }
  }, 120_000);

  it("a height change alone (same columns) redraws the frame at the new bottom", async () => {
    await resize(32, 17);
    await resize(32, 30);
    await expectFrame(32, 30);
    await resize(32, 12);
    await expectFrame(32, 12);
    // Output after a height change continues below the last line, not over it: the numbered line has scrolled up (once), the new line is there.
    const turn = (await get("seat")).turn ?? 0;
    await scratch.client().call("terminal.send", { terminal: "seat", text: "ping after height" }, { timeoutMs: 20_000 });
    await until(() => get("seat"), (t) => t.status?.state === "idle" && (t.turn ?? 0) > turn, "the turn to end");
    await settle();
    const screen = await expectFrame(32, 12);
    expect(screen.filter((r) => r.includes("you ▸ ping after height")), "the new line is on the screen once").toHaveLength(1);
    const history = (await scratch.client().call<{ text: string }>("terminal.read", { terminal: "seat", lines: 5000 })).text.split("\n");
    expect(history.filter((l) => l.trimEnd() === "[pi:err] flood line 299"), "the last numbered line is kept, once").toHaveLength(1);
  }, 60_000);

  it("the output history survives: every numbered line is in the scrollback and on the screen exactly once, in order", async () => {
    const history = (await scratch.client().call<{ text: string }>("terminal.read", { terminal: "seat", lines: 5000 })).text.split("\n");
    const seen = history.map((l) => /^\[pi:err\] flood line (\d+)$/.exec(l.trimEnd())?.[1]).filter((n): n is string => n !== undefined).map(Number);
    expect(seen, "300 lines, each once").toHaveLength(300);
    expect(seen, "in order").toEqual([...seen].sort((a, b) => a - b));
    expect(new Set(seen).size).toBe(300);
  }, 60_000);

  it("a pane resized below the frame's minimum (6 rows, 24 columns) is given back: no frame, output as plain lines; and taken again when it is large enough", async () => {
    await resize(80, 24);
    await resize(20, 5);
    const small = await rowsNow();
    expect(small.filter((r) => r.startsWith("── verify-qa") || r.startsWith("❯") || /^─+$/.test(r)), "no frame on a pane below the minimum").toEqual([]);
    await scratch.client().call("terminal.send", { terminal: "seat", text: "ping while small" }, { timeoutMs: 20_000 });
    await until(() => pi.history("seat", 50), (h) => h.some((l) => l.includes("you ▸ ping while small")), "the reply line on the small pane");
    await resize(80, 24);
    await expectFrame(80, 24);
    const history = (await scratch.client().call<{ text: string }>("terminal.read", { terminal: "seat", lines: 5000 })).text.split("\n");
    expect(history.filter((l) => l.includes("you ▸ ping while small")), "the line printed while small is kept once").toHaveLength(1);
    expect(history.filter((l) => l.trimEnd() === "[pi:err] flood line 150")).toHaveLength(1);
  }, 120_000);
});

// OF-218 (review of216 F1, measured). The old frame's rows are counted by walking cell widths at the new column count, because the core cannot
// split a 2-column character at the wrap: it leaves the last cell of the row blank and wraps early. The reviewer's exact case: 60 あ typed into
// the input row at 200x40, resized to 31x20. The input row (2 + 120 = 122 columns) reflows to 5 rows (14 characters, then 15 per row), not
// ceil(122 / 31) = 4, so counting 4 left one rule row on the screen (row 9). Clean at 32 columns and with ASCII input at base too: the odd
// width is what makes a wide character straddle the edge.
function typedLineAcrossResizes(title: string, typed: string, mark: string, first: readonly [number, number], then: ReadonlyArray<readonly [number, number]>) {
describe.skipIf(!findHc())(title, () => {
  let scratch: HcScratch;
  let attachment: HcAttachment;
  const get = () => scratch.client().call<HcTerminal>("terminal.get", { terminal: "seat" });
  const settle = () => new Promise((r) => setTimeout(r, 1200));
  const resize = async (columns: number, rows: number) => {
    attachment.resize(columns, rows);
    await until(get, (t) => t.cols === columns && t.rows === rows, `the pane to be ${columns}x${rows}`, 10_000);
    await settle();
  };
  /** The rule on the second-last row, the input row on the last (with the typed line's tail), and nothing of an old frame above them. */
  async function expectFrameWithInput(columns: number, rows: number) {
    const screen = await physicalRows(scratch.socketPath, "seat");
    const at = `${columns}x${rows}`;
    expect(screen, `${at}: the screen has the pane's rows`).toHaveLength(rows);
    expect(screen[rows - 2], `${at}: the rule, one unwrapped row, on the second-last row`).toBe(ruleFor(columns));
    expect(screen[rows - 1]!.startsWith("❯ "), `${at}: the input row on the last row`).toBe(true);
    expect(screen[rows - 1]!.includes(mark), `${at}: the typed line is still on the input row`).toBe(true);
    const above = screen.slice(0, rows - 2);
    expect(above.filter((r) => /^─+$/.test(r) || r.startsWith("── verify-qa")), `${at}: no stale rule row above the frame`).toEqual([]);
    expect(above.filter((r) => r.startsWith("❯") || r.includes(mark)), `${at}: no stale input row above the frame`).toEqual([]);
  }

  beforeAll(async () => {
    scratch = startHcScratch();
    const pi = panePi(scratch, fs.mkdtempSync(path.join(scratch.root, "wz-")));
    await pi.start("seat", "verify-qa@eztrack");
    await until(() => pi.screen("seat"), (s) => s.some((l) => l.includes(PI_RUNNER_READY_MARKER)), "the READY marker");
    attachment = await new HcAttach(scratch.socketPath).open({ terminal: "seat", cols: 200, rows: 40 }, { onData: () => undefined, onEnd: () => undefined });
    await settle();
    attachment.write(typed);
    await settle();
  }, 90_000);
  afterAll(async () => { await attachment?.detach().catch(() => undefined); scratch?.cleanup(); });

  it(`typed at 200x40, resized to ${first[0]}x${first[1]}: one rule, one input row, nothing stale above them`, async () => {
    await expectFrameWithInput(200, 40);
    await resize(first[0], first[1]);
    await expectFrameWithInput(first[0], first[1]);
  }, 60_000);

  it(`and through ${then.map(([c, r]) => `${c}x${r}`).join(", ")}, and back to 200x40`, async () => {
    for (const [c, r] of [...then, [200, 40]] as const) {
      await resize(c, r);
      await expectFrameWithInput(c, r);
    }
  }, 120_000);
});
}

typedLineAcrossResizes("60 あ in the input line across resizes to odd widths, through a private hc core (OF-218, wide characters)", "あ".repeat(60), "あ", [31, 20], [[27, 20], [45, 25], [32, 20], [31, 20]]);
// The second cause (measured): the core reflows the input row with the cursor's cell. 29 x at 32 columns fill 31 cells, the cursor is the 32nd, and
// at 31 columns the row is two. ASCII only; the same stale rule row as the wide case, and the frame had counted one row.
typedLineAcrossResizes("29 x in the input line across resizes to 32 and 31 columns, through a private hc core (OF-218, the cursor's cell)", "x".repeat(29), "x", [32, 20], [[31, 20], [32, 20], [31, 20]]);

// OF-231 (review of the Pi console N2, then measured): the same case with emoji the old width table counted as one cell and the core draws as two.
// 60 🚀 (U+1F680, Transport and Map Symbols) at 200x40, resized to 31x20: the input row is 2 + 120 cells and reflows to 5 rows, not the 4 the old table
// counted, which left one rule row on the screen. ✅ (U+2705, Emoji_Presentation in Dingbats) and 🩰 (U+1FA70 block) are the other two ranges.
typedLineAcrossResizes("60 🚀 in the input line across resizes to odd widths, through a private hc core (OF-231, Transport and Map Symbols)", "🚀".repeat(60), "🚀", [31, 20], [[27, 20], [45, 25], [32, 20], [31, 20]]);
typedLineAcrossResizes("60 ✅ in the input line across resizes to odd widths, through a private hc core (OF-231, Dingbats emoji)", "✅".repeat(60), "✅", [31, 20], [[27, 20], [45, 25], [32, 20], [31, 20]]);
typedLineAcrossResizes("60 🩰 in the input line across resizes to odd widths, through a private hc core (OF-231, U+1FA70 block)", "🩰".repeat(60), "🩰", [31, 20], [[27, 20], [45, 25], [32, 20], [31, 20]]);
