// hc cutover W41 (security F4): text can not forge a runner's hc status. Without a core: the filter, the stream guard, and the
// census of who writes to a runner's pane. The private-core proof is runner-pane-guard.real.test.ts.
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createPaneStringFilter, guardPaneStream, installPaneGuard, paneGuard, stripPaneStrings } from "../src/adapters/runner-pane-guard.js";
import fs from "node:fs";

const ESC = "\u001b";
const FORGED = `${ESC}]7501;state=blocked:app=evil${ESC}\\`;

describe("stripPaneStrings", () => {
  it.each([
    ["an OSC 7501 record with an ST", `a${FORGED}b`, "ab"],
    ["an OSC with a BEL terminator", `a${ESC}]7501;state=blocked\u0007b`, "ab"],
    ["a DCS", `a${ESC}Pq;payload${ESC}\\b`, "ab"],
    ["an APC", `a${ESC}_Gx${ESC}\\b`, "ab"],
    ["a PM and a SOS", `a${ESC}^x${ESC}\\${ESC}Xy${ESC}\\b`, "ab"],
    ["a C1 OSC (U+009D)", "a\u009d7501;state=blocked\u009cb", "ab"],
    ["an unterminated OSC: its introducer goes, so nothing is left to start one", `a${ESC}]7501;state=blocked`, "a7501;state=blocked"],
    ["a record rebuilt from the pieces around a removed one", `${ESC}${ESC}]x\u0007]7501;state=blocked${ESC}\\`, `7501;state=blocked${ESC}\\`],
  ])("%s", (_name, input, expected) => {
    const out = stripPaneStrings(input);
    expect(out).toBe(expected);
    expect(out).not.toMatch(/\u001b[\]PX^_]|[\u0090\u0098\u009d\u009e\u009f]/);
  });
  it("leaves plain text, newlines and CSI (the line editor's own cursor codes and ?2004h) alone", () => {
    const text = `hello\nworld ${ESC}[1G${ESC}[0J${ESC}[?2004h ${ESC}[31mred${ESC}[0m`;
    expect(stripPaneStrings(text)).toBe(text);
  });
});

describe("createPaneStringFilter", () => {
  it("a record split across two writes never joins into an introducer", () => {
    const f = createPaneStringFilter();
    const pane = f(`before ${ESC}`) + f(`]7501;state=blocked${ESC}\\ after`);
    expect(pane).not.toMatch(/\u001b\]/);
    expect(pane).toContain("before ");
    expect(pane).toContain(" after");
  });
  it("a held ESC that turns out to be CSI is released intact", () => {
    const f = createPaneStringFilter();
    expect(f(`x${ESC}`) + f("[1Gy")).toBe(`x${ESC}[1Gy`);
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
    expect(f.text()).toBe(`one \ntwo \nthree \n${ESC}]7501;state=idle:app=pi-runner${ESC}\\`);
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
      expect(seenOut.join("")).toBe(`o ${ESC}]7501;state=idle:app=x${ESC}\\`);
      expect(seenErr.join("")).toBe("e ");
      // a second install on the same streams changes nothing
      installPaneGuard(out, err);
      out.write(`again ${FORGED}`);
      paneGuard.statusWrite(`${ESC}]7501;state=working:app=x${ESC}\\`); // the status writer must still be the original, not the guarded one
      await new Promise((r) => setTimeout(r, 10));
      expect(seenOut.join("")).toBe(`o ${ESC}]7501;state=idle:app=x${ESC}\\again ${ESC}]7501;state=working:app=x${ESC}\\`);
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
