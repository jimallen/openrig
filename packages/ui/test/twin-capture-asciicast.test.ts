// OPR.0.4.1.11.2 (FR-3) — CLI-medium capture. asciinema is NOT on this host, so rather than fake a
// capture we emit the documented asciicast v2 format directly (zero-dep, "or equivalent" per the
// impl-prd): a JSON header line followed by [time, "o", data] output-event lines. A real `asciinema
// rec` interactive session still works where the binary is installed; this zero-dep path covers
// command-output capture everywhere and is deterministic (no wall-clock unless a timestamp is given).
import { describe, it, expect } from "vitest";
import { buildAsciicast, captureCommandCast } from "../twin/capture/asciicast.js";
import { at } from "./helpers/at.js";

describe("buildAsciicast (OPR.0.4.1.11.2 FR-3: zero-dep asciicast v2 CLI artifact)", () => {
  it("emits a valid asciicast v2 header line + output event lines", () => {
    const cast = buildAsciicast({
      width: 80,
      height: 24,
      events: [
        { time: 0, data: "hello\r\n" },
        { time: 0.5, data: "world\r\n" },
      ],
    });
    const lines = cast.trim().split("\n");
    expect(JSON.parse(at(lines, 0))).toMatchObject({ version: 2, width: 80, height: 24 });
    expect(JSON.parse(at(lines, 1))).toEqual([0, "o", "hello\r\n"]);
    expect(JSON.parse(at(lines, 2))).toEqual([0.5, "o", "world\r\n"]);
  });

  it("is deterministic when no timestamp is provided (no wall-clock leaks into output)", () => {
    const a = buildAsciicast({ width: 80, height: 24, events: [{ time: 0, data: "x" }] });
    const b = buildAsciicast({ width: 80, height: 24, events: [{ time: 0, data: "x" }] });
    expect(a).toBe(b);
  });

  it("includes the timestamp in the header only when explicitly provided", () => {
    const withTs = buildAsciicast({ width: 80, height: 24, events: [], timestamp: 1700000000 });
    expect(JSON.parse(at(withTs.trim().split("\n"), 0))).toMatchObject({ version: 2, timestamp: 1700000000 });
    const without = buildAsciicast({ width: 80, height: 24, events: [] });
    expect(JSON.parse(at(without.trim().split("\n"), 0)).timestamp).toBeUndefined();
  });

  it("captureCommandCast wraps a real command's output into a valid cast (zero-dep capture path)", () => {
    const cast = captureCommandCast({
      command: process.execPath, // node — guaranteed present
      args: ["-e", "process.stdout.write('hello\\nworld\\n')"],
    });
    const lines = cast.trim().split("\n");
    expect(JSON.parse(at(lines, 0))).toMatchObject({ version: 2 });
    const event = JSON.parse(at(lines, 1));
    expect(event[1]).toBe("o");
    expect(event[2]).toContain("hello");
    expect(event[2]).toContain("world");
  });
});
