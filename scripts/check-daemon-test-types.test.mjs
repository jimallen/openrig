// OF-78: the ratchet that keeps daemon test type errors from growing. The end-to-end behaviour (a real
// tsc run over packages/daemon/tsconfig.test.json) is what `npm run lint` exercises; these rows pin the
// counting and the comparison rule, which are where a ratchet can silently stop biting.
import assert from "node:assert/strict";
import test from "node:test";
import { compareToBaseline, countErrorsByFile } from "./check-daemon-test-types.mjs";

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
