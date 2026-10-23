// pda runtime L1b (pda-runtime-design-9l Rev 2, "Reconnect"): the incremental SSE parser. The property that
// matters to the runner: the events do not depend on where the network happened to cut the bytes.
import { describe, it, expect } from "vitest";
import { PdaSseParser, PdaSseOverflowError, parsePdaEventData } from "../src/adapters/pda-sse.js";

const enc = new TextEncoder();

function parseAll(chunks: Uint8Array[], maxEventBytes?: number): string[] {
  const p = new PdaSseParser({ maxEventBytes });
  const out: string[] = [];
  for (const c of chunks) for (const m of p.push(c)) out.push(m.data);
  for (const m of p.end()) out.push(m.data);
  return out;
}

function cutAt(bytes: Uint8Array, cuts: number[]): Uint8Array[] {
  const points = [0, ...cuts.filter((c) => c > 0 && c < bytes.length).sort((a, b) => a - b), bytes.length];
  const out: Uint8Array[] = [];
  for (let i = 0; i < points.length - 1; i++) out.push(bytes.slice(points[i]!, points[i + 1]!));
  return out;
}

describe("pda-sse: framing", () => {
  const STREAM = [
    ": keep-alive",
    "",
    `data: {"type":"snapshot","note":"héllo ✓ 🚀"}`,
    "",
    "event: ignored",
    "id: 7",
    "retry: 100",
    "data: line one",
    "data:line two",
    "",
    "data",
    "",
    "",
  ].join("\n");

  it("dispatches on a blank line, joins data lines with LF, drops comments and non-data fields", () => {
    expect(parseAll([enc.encode(STREAM)])).toEqual([
      `{"type":"snapshot","note":"héllo ✓ 🚀"}`,
      "line one\nline two",
      "",
    ]);
  });

  it("gives the same events however the bytes are cut: every single cut point, and every byte alone", () => {
    const bytes = enc.encode(STREAM);
    const expected = parseAll([bytes]);
    for (let i = 1; i < bytes.length; i++) expect(parseAll(cutAt(bytes, [i]))).toEqual(expected);
    expect(parseAll(cutAt(bytes, Array.from({ length: bytes.length }, (_, i) => i)))).toEqual(expected);
  });

  it("treats CRLF, lone CR and LF alike, including a CRLF cut between its two bytes", () => {
    const lf = enc.encode("data: a\n\ndata: b\n\n");
    const crlf = enc.encode("data: a\r\n\r\ndata: b\r\n\r\n");
    const cr = enc.encode("data: a\r\rdata: b\r\r");
    expect(parseAll([lf])).toEqual(["a", "b"]);
    expect(parseAll([crlf])).toEqual(["a", "b"]);
    expect(parseAll([cr])).toEqual(["a", "b"]);
    for (let i = 1; i < crlf.length; i++) expect(parseAll(cutAt(crlf, [i]))).toEqual(["a", "b"]);
  });

  it("a CRLF cut between its CR and its LF is ONE line end: two data lines of one event stay one event", () => {
    const bytes = enc.encode("data: a\r\ndata: b\r\n\r\n");
    expect(parseAll([bytes])).toEqual(["a\nb"]);
    for (let i = 1; i < bytes.length; i++) expect(parseAll(cutAt(bytes, [i])), `cut at ${i}`).toEqual(["a\nb"]);
  });

  it("strips one leading BOM and one leading space after the colon", () => {
    expect(parseAll([enc.encode("\ufeffdata:  two spaces\n\n")])).toEqual([" two spaces"]);
    // A byte-order mark split across two chunks is still the stream's first character.
    const bom = enc.encode("\ufeffdata: x\n\n");
    expect(parseAll([bom.slice(0, 1), bom.slice(1)])).toEqual(["x"]);
  });

  it("never dispatches an event the stream ended in the middle of", () => {
    expect(parseAll([enc.encode("data: whole\n\ndata: half")])).toEqual(["whole"]);
    expect(parseAll([enc.encode("data: whole\n\ndata: half\n")])).toEqual(["whole"]);
  });

  it("refuses an event over the limit instead of truncating it", () => {
    const p = new PdaSseParser({ maxEventBytes: 64 });
    expect(() => p.push(enc.encode(`data: ${"x".repeat(200)}\n`))).toThrow(PdaSseOverflowError);
    const q = new PdaSseParser({ maxEventBytes: 64 });
    expect(() => q.push(enc.encode(`data: ${"x".repeat(200)}`))).toThrow(PdaSseOverflowError); // unfinished line counts too
    const whole = new PdaSseParser({ maxEventBytes: 64 });
    expect(() => whole.push(enc.encode(`data: ${"x".repeat(200)}\n\n`))).toThrow(PdaSseOverflowError); // a complete oversized event in one chunk
    const ok = new PdaSseParser({ maxEventBytes: 64 });
    expect(ok.push(enc.encode(`data: ${"x".repeat(40)}\n\n`)).map((m) => m.data)).toEqual(["x".repeat(40)]);
  });

  it("the overflow error names no stream content", () => {
    const p = new PdaSseParser({ maxEventBytes: 8 });
    try { p.push(enc.encode("data: SECRETSECRETSECRET\n")); } catch (err) {
      expect(String((err as Error).message)).not.toContain("SECRET");
      return;
    }
    throw new Error("expected an overflow");
  });
});

describe("pda-sse: event data", () => {
  it("accepts a JSON object with a string type and nothing else", () => {
    expect(parsePdaEventData(`{"type":"run_start","inputs":[1]}`)).toEqual({ type: "run_start", inputs: [1] });
    for (const bad of ["", "not json", "[]", "5", "null", `{"type":5}`, `{"type":""}`, `{"kind":"x"}`, `"run_start"`]) {
      expect(parsePdaEventData(bad)).toBeNull();
    }
  });
});
