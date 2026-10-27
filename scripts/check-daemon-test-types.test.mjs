// OF-78: the ratchet that keeps daemon test type errors from growing. The end-to-end behaviour (a real
// tsc run over packages/daemon/tsconfig.test.json) is what `npm run lint` exercises; these rows pin the
// counting and the comparison rule, which are where a ratchet can silently stop biting.
import assert from "node:assert/strict";
import test from "node:test";
import { NO_FILE, compareToBaseline, countAsAnyByFile, countErrorsByFile, unrecognisedErrorLines, tighten } from "./check-daemon-test-types.mjs";

const OUTPUT = [
  "test/a.test.ts(10,5): error TS2322: Type 'null' is not assignable to type 'string'.",
  "test/a.test.ts(11,5): error TS18046: 'x' is of type 'unknown'.",
  "  Continuation line that is not an error",
  "../cli/src/client.ts(3,29): error TS6059: File is not under rootDir.",
  "test/b.test.ts(1,1): error TS2304: Cannot find name 'q'.",
  "Found 4 errors in 3 files.",
].join("\n");

test("counts error lines per file and ignores continuation and summary lines", () => {
  assert.deepEqual(countErrorsByFile(OUTPUT), { "test/a.test.ts": 2, "../cli/src/client.ts": 1, "test/b.test.ts": 1 });
  assert.deepEqual(countErrorsByFile(""), {});
});

test("a file above its baseline count is a regression", () => {
  const { regressions } = compareToBaseline({ "test/a.test.ts": 3 }, { "test/a.test.ts": 2 });
  assert.deepEqual(regressions, [{ file: "test/a.test.ts", allowed: 2, count: 3 }]);
});

test("a file with errors and no baseline entry is a regression (new test files start at zero)", () => {
  const { regressions } = compareToBaseline({ "test/new.test.ts": 1 }, {});
  assert.deepEqual(regressions, [{ file: "test/new.test.ts", allowed: 0, count: 1 }]);
});

test("at baseline is clean; below baseline is an improvement, never a regression", () => {
  const same = compareToBaseline({ "test/a.test.ts": 2 }, { "test/a.test.ts": 2 });
  assert.deepEqual(same, { regressions: [], improvements: [] });
  const better = compareToBaseline({ "test/a.test.ts": 1 }, { "test/a.test.ts": 2, "test/gone.test.ts": 4 });
  assert.deepEqual(better.regressions, []);
  assert.deepEqual(better.improvements, [
    { file: "test/a.test.ts", allowed: 2, count: 1 },
    { file: "test/gone.test.ts", allowed: 4, count: 0 },
  ]);
});

test("one file shrinking does not pay for another growing", () => {
  const { regressions } = compareToBaseline({ "test/a.test.ts": 1, "test/b.test.ts": 5 }, { "test/a.test.ts": 9, "test/b.test.ts": 4 });
  assert.deepEqual(regressions, [{ file: "test/b.test.ts", allowed: 4, count: 5 }]);
});

// OF-127: errors without a file position were ignored once positioned errors existed.
test("errors with no file position count under (no file) instead of vanishing", () => {
  const out = [
    "error TS5083: Cannot read file '/x/tsconfig.json'.",
    "tsconfig.test.json: error TS18003: No inputs were found.",
    "test/a.test.ts(1,1): error TS2304: Cannot find name 'q'.",
  ].join("\n");
  assert.deepEqual(countErrorsByFile(out), { [NO_FILE]: 1, "tsconfig.test.json": 1, "test/a.test.ts": 1 });
});

test("an error line in a shape the parser does not know is surfaced, not dropped", () => {
  assert.deepEqual(unrecognisedErrorLines(OUTPUT), []);
  assert.deepEqual(unrecognisedErrorLines("weird <stdin> :: error TS9999: something new"), ["weird <stdin> :: error TS9999: something new"]);
});

test("a file-less error is a regression against an empty baseline", () => {
  const { regressions } = compareToBaseline({ [NO_FILE]: 1 }, {});
  assert.deepEqual(regressions, [{ file: NO_FILE, allowed: 0, count: 1 }]);
});

// OF-127: a file that improved must tighten the baseline, never loosen it.
test("tighten lowers improved entries, drops zeros, and never raises or adds an entry", () => {
  const next = tighten({ "a": 5, "b": 2, "c": 1 }, { "a": 3, "b": 0, "c": 4, "new": 9 });
  assert.deepEqual(next, { a: 3, c: 1 });
});

// OF-127: no new `as any`.
test("counts `as any` per file, whole word only, and omits files with none", () => {
  const counts = countAsAnyByFile({
    "test/a.test.ts": "const x = y as any; const z = (w as any).q; const k = v as anyThing;",
    "test/b.test.ts": "const ok = y as unknown as Foo;",
  });
  assert.deepEqual(counts, { "test/a.test.ts": 2 });
});

test("a new `as any` in a file with no allowance is a regression; fewer is an improvement", () => {
  assert.deepEqual(compareToBaseline({ "test/n.test.ts": 1 }, {}).regressions, [{ file: "test/n.test.ts", allowed: 0, count: 1 }]);
  assert.deepEqual(compareToBaseline({ "test/a.test.ts": 1 }, { "test/a.test.ts": 3 }).improvements, [{ file: "test/a.test.ts", allowed: 3, count: 1 }]);
});
