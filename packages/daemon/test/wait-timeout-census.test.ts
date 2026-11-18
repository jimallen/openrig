// workspaces-o9o.179 (the o9o.174 follow-up): every daemon test wait that gives up says how long it waited and how loaded the machine
// was, so a timeout in a loaded gate carries its own evidence. The shared waits throw through waitTimedOut (helpers/wait-timeout.ts);
// a test file that keeps its own copy of the loop must throw through it too.
//
// The census is structural, not textual (verify-qa FAIL on the first cut: a text match on "timed out waiting for" missed waits worded
// any other way). It parses every daemon test source and finds each wait's give-up by shape:
//   1. a `throw` inside a loop, under an `if` whose condition reads the clock (`Date.now()`, `performance.now()`);
//   2. a `throw` straight after a loop that sleeps between checks (`setTimeout`, `sleep`) or whose own condition reads the clock;
//   3. a `reject(...)` inside a `setInterval` callback, under an `if` whose condition reads the clock.
// A give-up must throw (or reject with) `waitTimedOut(...)`. A give-up that rethrows a caught value as it is (`throw error`) hands back
// the failure the wait last saw, an assertion's diff or a command's own error; those are listed by name below, so a new one is a
// decision and not a silent pass. Out of shape, and so not claimed: a one-shot `setTimeout(() => reject(...))`, which no structure
// tells apart from a fake that simulates a slow dependency.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));

function testSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : testSources(full);
    return /\.(ts|mts|cts)$/.test(e.name) ? [full] : [];
  });
}

function contains(node: ts.Node, match: (n: ts.Node) => boolean): boolean {
  let found = false;
  const visit = (n: ts.Node): void => { if (found) return; if (match(n)) found = true; else ts.forEachChild(n, visit); };
  visit(node);
  return found;
}
const callsNamed = (n: ts.Node, names: readonly string[]): boolean => ts.isCallExpression(n)
  && ((ts.isIdentifier(n.expression) && names.includes(n.expression.text))
    || (ts.isPropertyAccessExpression(n.expression) && names.includes(n.expression.name.text)));
const readsClock = (n: ts.Node): boolean => contains(n, (x) => ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression)
  && x.expression.name.text === "now");
const sleeps = (n: ts.Node): boolean => contains(n, (x) => callsNamed(x, ["setTimeout", "sleep"]));
const isLoop = (n: ts.Node): n is ts.IterationStatement => ts.isIterationStatement(n, false);

/** Walks up from `n` to the nearest loop (or `stop`) inside the same function; whether a clock-reading `if` guarded it on the way. */
function clockGuarded(n: ts.Node, stop: (p: ts.Node) => boolean): boolean {
  let guarded = false;
  for (let p = n.parent; p; p = p.parent) {
    if (ts.isIfStatement(p) && readsClock(p.expression)) guarded = true;
    if (stop(p)) return guarded;
    if (ts.isFunctionLike(p)) return false;
  }
  return false;
}
const isIntervalCallback = (p: ts.Node): boolean => ts.isFunctionLike(p) && ts.isCallExpression(p.parent) && callsNamed(p.parent, ["setInterval"]);

export interface WaitGiveUp { at: string; kind: "evidenced" | "rethrow" | "bare" }

/** Every wait give-up in `files` (name → source), classified by what it throws. */
export function waitGiveUps(files: Record<string, string>): WaitGiveUp[] {
  return Object.entries(files).flatMap(([file, text]) => {
    const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const out: WaitGiveUp[] = [];
    const record = (site: ts.Node, error: ts.Expression | undefined): void => {
      const kind = error && ts.isCallExpression(error) && ts.isIdentifier(error.expression) && error.expression.text === "waitTimedOut"
        ? "evidenced" : error && ts.isIdentifier(error) ? "rethrow" : "bare";
      out.push({ at: `${file}:${src.getLineAndCharacterOfPosition(site.getStart(src)).line + 1}`, kind });
    };
    const visit = (n: ts.Node): void => {
      if (ts.isThrowStatement(n)) {
        const holder = n.parent;
        const before = ts.isBlock(holder) || ts.isSourceFile(holder) ? holder.statements[holder.statements.indexOf(n) - 1] : undefined;
        if (clockGuarded(n, isLoop) || (before && isLoop(before) && (sleeps(before) || readsClock(before)))) record(n, n.expression);
      } else if (callsNamed(n, ["reject"]) && clockGuarded(n, isIntervalCallback)) {
        record(n, (n as ts.CallExpression).arguments[0]);
      }
      ts.forEachChild(n, visit);
    };
    visit(src);
    return out;
  });
}

const at = (rows: WaitGiveUp[], kind: WaitGiveUp["kind"]): string[] => rows.filter((r) => r.kind === kind).map((r) => r.at);

describe("workspaces-o9o.179: no daemon test wait gives up without its evidence", () => {
  it("the scanner finds each give-up shape and tells waitTimedOut, a rethrow and a bare Error apart (its own controls)", () => {
    const rows = waitGiveUps({
      "clock.ts": "async function w() { const end = Date.now() + 9; for (;;) { if (ok()) return; if (Date.now() > end) throw new Error(`x`); await nap(); } }",
      "evidenced.ts": "async function w() { const end = Date.now() + 9; for (;;) { if (Date.now() > end) throw waitTimedOut(`x`, s); await nap(); } }",
      "counted.ts": "async function w() {\n  for (let i = 0; i < 9; i++) { if (ok()) return; await new Promise((r) => setTimeout(r, 5)); }\n  throw new Error('x');\n}",
      "clock-loop.ts": "async function w() { while (Date.now() < end) { if (ok()) return; } throw new Error('x'); }",
      "interval.ts": "new Promise((resolve, reject) => { const iv = setInterval(() => { if (ok()) resolve(); else if (Date.now() - s > 9) reject(new Error('x')); }, 5); });",
      "rethrow.ts": "async function w() { for (;;) { try { a(); return; } catch (error) { if (Date.now() > end) throw error; } await nap(); } }",
      // Not give-ups: a retry with no clock and no sleep; a failure the loop meets before its deadline; a reject outside an interval.
      "retry.ts": "async function w() { for (let i = 0; i < 3; i++) { if (await probe()) return; }\nthrow new Error('x'); }",
      "failure.ts": "async function w() { for (;;) { if (bad()) throw new Error('x'); if (Date.now() > end) return; await nap(); } }",
      "oneshot.ts": "new Promise((_, reject) => setTimeout(() => { if (Date.now() > 0) reject(new Error('late')); }, 9));",
    });
    expect(rows).toEqual([
      { at: "clock.ts:1", kind: "bare" },
      { at: "evidenced.ts:1", kind: "evidenced" },
      { at: "counted.ts:3", kind: "bare" },
      { at: "clock-loop.ts:1", kind: "bare" },
      { at: "interval.ts:1", kind: "bare" },
      { at: "rethrow.ts:1", kind: "rethrow" },
    ]);
  });

  // Each row is a wait the first, textual census passed (verify-qa's five), in the shape it had at d9ed29975.
  it.each([
    ["pda-seat-e2e (\"timed out after\")", "async function w() { const end = Date.now() + ms;\n  for (;;) {\n    try { return await probe(); } catch (e) { last = e; }\n    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for: ${what}`);\n    await new Promise((r) => setTimeout(r, 200));\n  }\n}", 4],
    ["stub-runner-clock (\"sidecar not ready within\")", "async function w() { const deadline = Date.now() + timeoutMs;\n  while (true) {\n    if (existsSync(p)) return;\n    if (Date.now() > deadline) throw new Error(`sidecar not ready within ${timeoutMs}ms: ${p}`);\n    await new Promise((r) => setTimeout(r, 25));\n  }\n}", 4],
    ["stub-runner-restore-e2e (\"condition not met within\")", "async function w() { const deadline = Date.now() + timeoutMs;\n  while (true) {\n    if (cond()) return;\n    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`);\n    await new Promise((r) => setTimeout(r, 25));\n  }\n}", 4],
    ["stub-runner-compaction-e2e (\"file not produced within\")", "async function w() { const deadline = Date.now() + timeoutMs;\n  while (true) {\n    if (existsSync(p)) return;\n    if (Date.now() > deadline) throw new Error(`file not produced within ${timeoutMs}ms: ${p}`);\n    await new Promise((r) => setTimeout(r, 25));\n  }\n}", 4],
    ["claude-interactive-isolation (throw Error without new)", "async function until(f:()=>boolean){for(let i=0;i<240;i++){if(f())return;await new Promise(r=>setTimeout(r,25));}throw Error('private pane did not produce receipt');}", 1],
  ])("the census catches a wait the textual census missed: %s", (_name, source, line) => {
    expect(waitGiveUps({ "site.ts": source })).toEqual([{ at: `site.ts:${line}`, kind: "bare" }]);
  });

  it("every wait in the daemon tests gives up through waitTimedOut", () => {
    const files = Object.fromEntries(testSources(TEST_DIR).map((f) => [relative(TEST_DIR, f), readFileSync(f, "utf8")]));
    expect(Object.keys(files).length).toBeGreaterThan(1000);   // the population scanned, so a clean result is not an empty walk
    const rows = waitGiveUps(files);
    expect(at(rows, "bare")).toEqual([]);
    expect(at(rows, "evidenced").length).toBeGreaterThanOrEqual(40);   // the give-ups found, so a clean result is not a blind scanner
    // Rethrows hand back the failure the wait last saw (an assertion's diff; the CLI's own error after its retries), kept as it is.
    expect(at(rows, "rethrow").sort()).toEqual(["helpers/eval-rig-session.ts:285", "pi-usage-cost.test.ts:168"]);
  });
});
