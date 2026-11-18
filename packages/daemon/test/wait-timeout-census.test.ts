// workspaces-o9o.179 (the o9o.174 follow-up): every daemon test wait that gives up says how long it waited and how loaded the machine
// was, so a timeout in a loaded gate carries its own evidence. The shared waits throw through waitTimedOut (helpers/wait-timeout.ts);
// a test file that keeps its own copy of the loop must throw through it too. This census fails on any wait that still throws the
// bare "timed out waiting for" Error, naming the file and line.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const SELF = fileURLToPath(import.meta.url);
/** A wait that gives up with a plain Error whose text starts "timed out waiting for", in any quoting. */
const BARE_TIMEOUT = /new Error\(\s*[`'"]timed out waiting for/;

function testSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : testSources(full);
    return /\.(ts|mts|cts)$/.test(e.name) && full !== SELF ? [full] : [];
  });
}

export function bareTimeouts(files: Record<string, string>): string[] {
  return Object.entries(files).flatMap(([file, text]) =>
    text.split("\n").flatMap((line, i) => (BARE_TIMEOUT.test(line) ? [`${file}:${i + 1}`] : [])));
}

describe("workspaces-o9o.179: no daemon test wait gives up without its evidence", () => {
  it("the scanner finds a bare timeout and passes one that goes through waitTimedOut (its own positive and negative control)", () => {
    expect(bareTimeouts({
      "a.ts": "if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);",
      "b.ts": "if (Date.now() > end) throw waitTimedOut(`timed out waiting for ${what}`, started);",
      "c.ts": "x();\nif (late) throw new Error('timed out waiting for the pane');",
      "d.ts": 'if (late) throw new Error("timed out waiting for the pane");',
    })).toEqual(["a.ts:1", "c.ts:2", "d.ts:1"]);
  });

  it("every wait in the daemon tests throws through waitTimedOut", () => {
    const files = Object.fromEntries(testSources(TEST_DIR).map((f) => [relative(TEST_DIR, f), readFileSync(f, "utf8")]));
    expect(Object.keys(files).length).toBeGreaterThan(1000);   // the population scanned, so a clean result is not an empty walk
    expect(bareTimeouts(files)).toEqual([]);
  });
});
