// hc cutover W41 (security F4): text can not forge a runner's hc status. Without a core: the filter, the stream guard, and the
// census of who writes to a runner's pane. The private-core proof is runner-pane-guard.real.test.ts.
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createPaneFilter, filterPaneText, guardPaneStream, installPaneGuard, paneGuard } from "../src/adapters/runner-pane-guard.js";
import fs from "node:fs";

const ESC = "\u001b";
const FORGED = `${ESC}]7501;state=blocked:app=evil${ESC}\\`;

/** An independent model of how a VT500-style terminal parser (vte, xterm) reads bytes, restated here and NOT imported from the guard:
 *  in the escape state a C0 control is executed and the parser STAYS there, DEL is ignored and the parser STAYS there, so
 *  `ESC <C0|DEL> ]` still opens an OSC. Returns every string-sequence introducer the output would open (security F6). */
function introducersOpened(output: string): string[] {
  let state: "ground" | "escape" | "escInter" | "csi" = "ground";
  const found: string[] = [];
  for (let i = 0; i < output.length; i++) {
    const c = output.charCodeAt(i);
    const ch = output[i]!;
    if (c === 0x18 || c === 0x1a) { state = "ground"; continue; }                 // CAN, SUB cancel
    if (c === 0x1b) { state = "escape"; continue; }                               // ESC restarts from any state
    if (state === "ground") {
      if (c === 0x9b) state = "csi";
      else if ([0x9d, 0x90, 0x98, 0x9e, 0x9f].includes(c)) found.push(`C1 U+${c.toString(16)} at ${i}`);
      continue;
    }
    if (c < 0x20) continue;                                                       // C0 executes, state unchanged
    if (c === 0x7f) continue;                                                     // DEL ignored, state unchanged
    if (state === "escape") {
      if (c >= 0x20 && c <= 0x2f) state = "escInter";
      else if (ch === "[") state = "csi";
      else if ("]PX^_".includes(ch)) { found.push(`ESC ${ch} at ${i}`); state = "ground"; }
      else state = "ground";
    } else if (state === "escInter") {
      if (c >= 0x30 && c <= 0x7e) state = "ground";
    } else if (state === "csi") {
      if (c >= 0x40 && c <= 0x7e) state = "ground";
    }
  }
  return found;
}

describe("the model of a terminal parser (the instrument the guard is judged by)", () => {
  it("POSITIVE CONTROL: it sees an introducer behind every C0 byte (ESC included) and DEL (security F6), and not behind CAN, SUB or text", () => {
    for (let sep = 0; sep < 0x20; sep++) {
      const opened = introducersOpened(`${ESC}${String.fromCharCode(sep)}]7501;state=blocked${ESC}\\`);
      const cancels = sep === 0x18 || sep === 0x1a; // ESC ESC ] still opens an OSC: the second ESC restarts the escape
      expect(opened.length > 0, `separator 0x${sep.toString(16)}`).toBe(!cancels);
    }
    expect(introducersOpened(`${ESC}\u007f]x`).length).toBe(1);
    expect(introducersOpened(`${ESC}]x`).length).toBe(1);
    expect(introducersOpened("plain ] text [ and P")).toEqual([]);
    expect(introducersOpened(`${ESC}[31m]red${ESC}[0m`)).toEqual([]);
  });
});

describe("filterPaneText: plain text and a short list of CSI forms, every other ESC removed", () => {
  it("the forged record, in every form security tried, leaves no ESC and no introducer", () => {
    for (const input of [
      FORGED,
      `a${ESC}]7501;state=blocked\u0007b`,
      `${ESC}Pq;payload${ESC}\\`, `${ESC}_Gx${ESC}\\`, `${ESC}^x${ESC}\\`, `${ESC}Xy${ESC}\\`,
      "\u009d7501;state=blocked\u009c", "\u0090q;x\u009c",
      `${ESC}${ESC}]x\u0007]7501;state=blocked${ESC}\\`,
      `${ESC}]7501;state=blocked`,
    ]) {
      const out = filterPaneText(input);
      expect(out).not.toContain(ESC);
      expect(introducersOpened(out), JSON.stringify(input)).toEqual([]);
    }
  });
  it.each([...Array(0x20).keys(), 0x7f])("ESC, then byte 0x%s, then ] (F6): no ESC survives, so the ] opens nothing", (sep) => {
    const out = filterPaneText(`before ${ESC}${String.fromCharCode(sep)}]7501;state=blocked:app=f${ESC}\\ after`);
    expect(out).not.toContain(ESC);
    expect(introducersOpened(out)).toEqual([]);
    expect(out).toContain("before ");
    expect(out).toContain(" after");
  });
  it("leaves plain text, tab, LF, CR, BS, BEL, and the runner's own CSI forms exactly as they were", () => {
    const text = `hello\tworld\r\n ] [ P ^ _ \\ \u0008\u0007 ${ESC}[1G${ESC}[0J${ESC}[K${ESC}[12C${ESC}[?2004h${ESC}[?2004l ${ESC}[31;1mred${ESC}[0m emoji 😀 مرحبا`;
    expect(filterPaneText(text)).toBe(text);
  });
  it.each([
    ["a CSI form the runner does not use", `${ESC}[6n`, "[6n"],
    ["a private mode other than bracketed paste", `${ESC}[?1049h`, "[?1049h"],
    ["too many parameters", `${ESC}[${"1;".repeat(8)}m`, `[${"1;".repeat(8)}m`],
    ["a CSI with an intermediate byte", `${ESC}[ q`, "[ q"],
    ["an SS3", `${ESC}OA`, "OA"],
    ["a charset designation", `${ESC}(0`, "(0"],
    ["the C1 range as characters", "a\u0080\u009bb\u009fc", "abc"],
    ["C0 controls other than TAB LF CR BS BEL, and DEL", "a\u0000\u0001\u0003\u000b\u000c\u000e\u001f\u007fb", "ab"],
  ])("%s is not passed", (_name, input, expected) => {
    expect(filterPaneText(input)).toBe(expected);
  });
  it("a CSI form the text ends inside of is not passed by the stateless filter (nothing can complete it)", () => {
    expect(filterPaneText(`x${ESC}[1`)).toBe("x[1");
    expect(filterPaneText(`x${ESC}`)).toBe("x");
  });
});

describe("createPaneFilter: writes that split a form", () => {
  it("a record split across two writes at ESC never joins into an introducer", () => {
    const f = createPaneFilter();
    const pane = f(`before ${ESC}`) + f(`]7501;state=blocked${ESC}\\ after`);
    expect(pane).not.toContain(ESC);
    expect(introducersOpened(pane)).toEqual([]);
  });
  it("ESC NUL in one write and the record in the next (security F6's split form)", () => {
    const f = createPaneFilter();
    const pane = f(`${ESC}\u0000`) + f(`]7501;state=blocked${ESC}\\`);
    expect(introducersOpened(pane)).toEqual([]);
    expect(pane).not.toContain(ESC);
  });
  it("an allowed CSI split at every position is rejoined whole", () => {
    for (const form of [`${ESC}[1G`, `${ESC}[?2004h`, `${ESC}[31;1m`, `${ESC}[0J`]) {
      for (let cut = 1; cut < form.length; cut++) {
        const f = createPaneFilter();
        expect(f(`x${form.slice(0, cut)}`) + f(`${form.slice(cut)}y`), `${JSON.stringify(form)} cut ${cut}`).toBe(`x${form}y`);
      }
    }
  });
  it("a held prefix that turns out not to be an allowed form is released as text with its ESC removed", () => {
    const f = createPaneFilter();
    expect(f(`a${ESC}[`) + f("zb")).toBe("a[zb");
  });
  it("the held prefix is bounded: a long run of digits after ESC [ is released, not accumulated", () => {
    const f = createPaneFilter();
    const out = f(`${ESC}[${"1".repeat(40)}`) + f("m");
    expect(out).not.toContain(ESC);
    expect(out.length).toBeGreaterThan(30);
  });
});

/** mulberry32: a seeded generator, so a failing case is the same case next run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const PIECES = [
  ESC, ESC, ESC, "]", "[", "P", "X", "^", "_", "\\", "7501;state=blocked:app=f", "state=working", "2004", "?", "h", "l", "m", ";", "1", "12", "0",
  "\u0000", "\u0001", "\u0007", "\u0008", "\u000a", "\u000d", "\u0018", "\u001a", "\u001f", "\u007f",
  "\u0080", "\u0090", "\u0098", "\u009b", "\u009c", "\u009d", "\u009e", "\u009f", " ", "a", "Z", "~", "@", "é", "漢", "😀",
];
function randomText(next: () => number): string {
  let s = ""; const len = Math.floor(next() * 60);
  for (let i = 0; i < len; i++) s += PIECES[Math.floor(next() * PIECES.length)];
  return s;
}
function randomSplits(text: string, next: () => number): string[] {
  const cuts = new Set<number>(); const k = 1 + Math.floor(next() * 5);
  for (let i = 0; i < k; i++) cuts.add(Math.floor(next() * (text.length + 1)));
  const sorted = [...cuts].sort((a, b) => a - b);
  const out: string[] = []; let prev = 0;
  for (const c of sorted) { out.push(text.slice(prev, c)); prev = c; }
  out.push(text.slice(prev));
  return out;
}

describe("fuzz: whatever bytes go in, no introducer comes out, however the writes are split", () => {
  it("5000 random inputs over the escape alphabet, each split at random positions, through the stateful filter", () => {
    const next = rng(0x0f6f6);
    let rawFlagged = 0;
    for (let n = 0; n < 5000; n++) {
      const input = randomText(next);
      if (introducersOpened(input).length > 0) rawFlagged++;
      const f = createPaneFilter();
      const out = randomSplits(input, next).map((chunk) => f(chunk)).join("") + f("");
      const opened = introducersOpened(out);
      if (opened.length > 0 || /[\u0080-\u009f]/.test(out)) throw new Error(`case ${n}: ${JSON.stringify(input)} -> ${JSON.stringify(out)}: ${opened.join(", ")}`);
      // every ESC left is the start of an allowed CSI form, whole
      for (const m of out.matchAll(/\u001b/g)) expect(/^\u001b\[(?:[0-9;]{0,12}[ABCDGHJKm]|\?2004[hl])/.test(out.slice(m.index!)), `case ${n} ESC at ${m.index}`).toBe(true);
    }
    expect(rawFlagged, "positive control: the generator makes many inputs a terminal would read as an introducer").toBeGreaterThan(500);
  });
  it("the stateless filter holds the same invariant", () => {
    const next = rng(0xbeef);
    for (let n = 0; n < 5000; n++) {
      const input = randomText(next);
      const out = filterPaneText(input);
      expect(introducersOpened(out), JSON.stringify(input)).toEqual([]);
    }
  });
});

describe("cost: linear in the text (security N10: the regex form took 4.5 s on 200 KB)", () => {
  const big = (unit: string) => unit.repeat(Math.ceil(200_000 / unit.length));
  it.each([
    ["unterminated OSC introducers", `${ESC}]7501;x`],
    ["unterminated DCS introducers", `${ESC}Pq`],
    ["ESC CSI openers with no final", `${ESC}[1;2;`],
    ["ESC and spaces", `${ESC}   `],
    ["plain text", "hello world "],
  ])("200 KB of %s through the filter, stateless and stateful, in well under a second", (_name, unit) => {
    const text = big(unit);
    const started = Date.now();
    filterPaneText(text);
    const f = createPaneFilter();
    for (let i = 0; i < text.length; i += 4096) f(text.slice(i, i + 4096));
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe("guardPaneStream", () => {
  function fake() {
    const out = new PassThrough();
    const seen: string[] = [];
    out.on("data", (d: Buffer) => seen.push(d.toString("utf8")));
    return { stream: out, text: () => seen.join("") };
  }
  it("filters string and Buffer writes, with and without a callback, and returns the status writer that does not filter", async () => {
    const f = fake();
    const statusWrite = guardPaneStream(f.stream);
    f.stream.write(`one ${FORGED}\n`);
    f.stream.write(Buffer.from(`two ${FORGED}\n`));
    await new Promise<void>((resolve) => { f.stream.write(`three ${FORGED}\n`, () => resolve()); });
    statusWrite(`${ESC}]7501;state=idle:app=pi-runner${ESC}\\`);
    await new Promise((r) => setTimeout(r, 10));
    // the status writer's record is the only ESC on the stream; the forged text is left as inert characters
    const text = f.text();
    const record = `${ESC}]7501;state=idle:app=pi-runner${ESC}\\`;
    expect(text.endsWith(record)).toBe(true);
    expect(text.slice(0, -record.length)).not.toContain(ESC);
    expect(text.slice(0, -record.length)).toBe("one ]7501;state=blocked:app=evil\\\ntwo ]7501;state=blocked:app=evil\\\nthree ]7501;state=blocked:app=evil\\\n");
  });
  it("a multi-byte character split across two Buffer writes survives", async () => {
    const f = fake();
    guardPaneStream(f.stream);
    const bytes = Buffer.from("é漢");
    f.stream.write(bytes.subarray(0, 1));
    f.stream.write(bytes.subarray(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(f.text()).toBe("é漢");
  });
});

describe("installPaneGuard", () => {
  it("guards BOTH the pane's stdout and stderr, and hands the status sink the unfiltered stdout writer only", async () => {
    const out = new PassThrough(); const err = new PassThrough();
    const seenOut: string[] = []; const seenErr: string[] = [];
    out.on("data", (d: Buffer) => seenOut.push(d.toString())); err.on("data", (d: Buffer) => seenErr.push(d.toString()));
    const original = paneGuard.statusWrite;
    try {
      installPaneGuard(out, err);
      out.write(`o ${FORGED}`); err.write(`e ${FORGED}`);
      paneGuard.statusWrite(`${ESC}]7501;state=idle:app=x${ESC}\\`);
      await new Promise((r) => setTimeout(r, 10));
      const status1 = `${ESC}]7501;state=idle:app=x${ESC}\\`;
      expect(seenOut.join("")).toBe(`o ]7501;state=blocked:app=evil\\${status1}`);
      expect(seenErr.join("")).toBe("e ]7501;state=blocked:app=evil\\");
      // a second install on the same streams changes nothing
      installPaneGuard(out, err);
      out.write(`again ${FORGED}`);
      paneGuard.statusWrite(`${ESC}]7501;state=working:app=x${ESC}\\`); // the status writer must still be the original, not the guarded one
      await new Promise((r) => setTimeout(r, 10));
      expect(seenOut.join("")).toBe(`o ]7501;state=blocked:app=evil\\${status1}again ]7501;state=blocked:app=evil\\${ESC}]7501;state=working:app=x${ESC}\\`);
    } finally { paneGuard.statusWrite = original; }
  });
});

// The census. Every runner entry that has a pane: the guard is installed first, only the status sink writes raw, and no file
// the runners load writes to the pane behind process.stdout/stderr (fd writes, /dev/tty, inherited child stdio).
describe("census of the runners' pane writers (source)", () => {
  const dir = new URL("../src/adapters/", import.meta.url);
  const src = (name: string) => fs.readFileSync(new URL(name, dir), "utf8");
  const ENTRY = ["pi-runner.ts", "pda-runner.ts", "stub-runner.ts"];
  const LOADED = ["pi-runner.ts", "pda-runner.ts", "stub-runner.ts", "runner-pane-io.ts", "pda-render.ts", "runner-hc-status.ts", "pi-readiness.ts", "pda-usage-sink.ts", "pda-outbox.ts", "pda-client.ts", "pda-sse.ts", "pi-openrouter-charge.ts"];

  it.each(ENTRY)("%s installs the pane guard in its direct-execution entry", (name) => {
    expect(src(name)).toMatch(/if \(invokedDirectly\) \{\s*(?:\/\/[^\n]*\n\s*)*installPaneGuard\(\);/);
  });
  it.each(["pi-runner.ts", "pda-runner.ts"])("%s hands the status sink the guard's raw writer, not process.stdout", (name) => {
    const text = src(name);
    expect(text).toMatch(/createRunnerHcStatusSink\(process\.env, \(text\) => \{ paneGuard\.statusWrite\(text\); \}/);
    expect(text).not.toMatch(/createRunnerHcStatusSink\(process\.env, \(text\) => \{ process\.stdout/);
  });
  it("no runner file writes to the pane by a route the guard does not cover", () => {
    for (const name of LOADED) {
      const text = src(name);
      expect(text, `${name} writeSync to fd 1/2`).not.toMatch(/writeSync\(\s*[12]\s*,/);
      expect(text, `${name} /dev/tty`).not.toMatch(/\/dev\/tty/);
      expect(text, `${name} inherited stdio`).not.toMatch(/stdio:\s*(?:"inherit"|\[[^\]]*"inherit")/);
    }
  });
  it("every Pi-runner write of text it did not author is sanitised where it is handed to the pane", () => {
    const text = src("pi-runner.ts");
    for (const site of [
      "notice: (line) => { process.stdout.write(`${sanitizeForPane(line)}\\n`); }",
      "mirrorLine: (line) => process.stdout.write(`${sanitizeForPane(line)}\\n`)",
      "mirrorAppend: (text) => process.stdout.write(sanitizeForPane(text))",
      "process.stdout.write(`[${runtime}:err] ${sanitizeForPane(line)}\\n`)",
      "process.stdout.write(`[pi-runner] ${sanitizeForPane(detail)}\\n`)",
    ]) expect(text, site).toContain(site);
  });
});
