// workspaces-o9o.179 (the o9o.174 follow-up): every daemon test wait that gives up says how long it waited and how loaded the machine
// was, so a timeout in a loaded gate carries its own evidence. The shared waits throw through waitTimedOut (helpers/wait-timeout.ts);
// a test file that keeps its own copy of the loop must throw through it too.
//
// The census is structural, not textual (verify-qa FAIL on the first cut: a text match on "timed out waiting for" missed waits worded
// any other way). It parses every daemon test source and finds each wait's give-up by shape:
//   1. a `throw` inside a loop, under an `if` whose condition reads the clock (`Date.now()`, `performance.now()`);
//   2. a `throw` straight after a loop that sleeps between checks (`setTimeout`, `sleep`) or whose own condition reads the clock;
//   3. a `reject(...)` inside a `setInterval` callback, under an `if` whose condition reads the clock.
// (A WaitBound's `expired()` reads the clock too.)
// A give-up must throw (or reject with) `waitTimedOut(...)`, and (workspaces-o9o.174 part 3) its guard or its loop must ask a WaitBound
// (`bound.expired()`, `bound.attempts(n)`), whose bound scales with the measured load; a raw clock comparison or a fixed count is
// "unscaled". "The bound" is decided by the TypeScript checker over the daemon's test project (tsconfig.test.json): the receiver's type
// must be the WaitBound that helpers/wait-timeout.ts declares, so a foreign object with the same method names, or an alias of one, is
// not the bound (verify-qa, round 2), and its value must be one waitBound() made: a `const` initialised by that call, or a `const`
// alias of one (workspaces-3u9; WaitBound is also nominal, so a hand-made one does not compile). A give-up that rethrows a caught
// value as it is (`throw error`) hands back the failure the wait last saw, an assertion's diff or a command's own error; those are
// listed by name below, so a new one is a decision and not a silent pass.
// Excluded as a class: one-shot setTimeout rejects are not censused. A `setTimeout(() => reject(...))` watchdog has no structure that
// tells it apart from a fake that simulates a slow dependency (hc-seat-terminal-status's "late", plugin-vendor-service's "timeout").
// The real ones known on 2026-11-19 were converted by hand (CoS ruling, verify-qa round 2): ps-summary-stall-red, slow-op-recorder,
// helpers/scenario-surfaces and staging-docker-invoker's "parent did not end"; each sets its timer to its bound's scaled `bound.ms`.
// A new one is not caught here.
import { readdirSync } from "node:fs";
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
/** Reads the clock: `Date.now()`, `performance.now()`, or a WaitBound's `expired()` (which compares the clock with its deadline). */
const readsClock = (n: ts.Node): boolean => contains(n, (x) => ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression)
  && (x.expression.name.text === "now" || x.expression.name.text === "expired"));
/** A call of `expired()` or `attempts()` on a receiver whose type, through the TypeScript checker (not its spelling), is the WaitBound
 *  that helpers/wait-timeout.ts declares (verify-qa round 2: `other.expired()` on a foreign object, or an alias of one, is not the
 *  bound), and whose value waitBound() made (workspaces-3u9). */
const inHelper = (d: ts.Node): boolean => d.getSourceFile().fileName.replace(/\\/g, "/").endsWith("/helpers/wait-timeout.ts");
/** Made by waitBound() (workspaces-3u9): a call that resolves, through the checker, to the waitBound declared in helpers/wait-timeout.ts,
 *  or a `const` whose initializer is one (followed through `const` aliases). The type alone is not enough: a hand-made object, a cast,
 *  a parameter, a reassignable `let` or another function's result can carry the type without being one waitBound() made. */
const madeByWaitBound = (checker: ts.TypeChecker) => {
  const made = (e: ts.Expression, seen: Set<ts.Symbol>): boolean => {
    if (ts.isCallExpression(e)) {
      const d = checker.getResolvedSignature(e)?.declaration;
      return d !== undefined && ts.isFunctionDeclaration(d) && d.name?.text === "waitBound" && inHelper(d);
    }
    if (!ts.isIdentifier(e)) return false;
    const symbol = checker.getSymbolAtLocation(e);
    if (!symbol || seen.has(symbol)) return false;
    seen.add(symbol);
    const d = symbol.valueDeclaration;
    return d !== undefined && ts.isVariableDeclaration(d) && d.initializer !== undefined
      && (ts.getCombinedNodeFlags(d) & ts.NodeFlags.Const) !== 0 && made(d.initializer, seen);
  };
  return (e: ts.Expression): boolean => made(e, new Set());
};
const boundCall = (checker: ts.TypeChecker) => {
  const made = madeByWaitBound(checker);
  return (x: ts.Node): boolean => {
    if (!ts.isCallExpression(x) || !ts.isPropertyAccessExpression(x.expression)) return false;
    if (x.expression.name.text !== "expired" && x.expression.name.text !== "attempts") return false;
    const type = checker.getTypeAtLocation(x.expression.expression);
    const symbol = type.aliasSymbol ?? type.getSymbol();
    return symbol?.getName() === "WaitBound" && (symbol.declarations ?? []).some(inHelper) && made(x.expression.expression);
  };
};
const RELATIONAL = new Set([ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken]);
/** Asks only a WaitBound (workspaces-o9o.174 part 3): the condition calls `bound.expired()` or `bound.attempts(n)` (every such call on
 *  the bound itself, by type), reads no raw clock
 *  (`Date.now()`, `performance.now()`), and every relational comparison in it (`<`, `<=`, `>`, `>=`) has a bound call on one side. A
 *  mixed condition, `bound.expired() || Date.now() > oldEnd` or `i < bound.attempts(9) && i < 400`, is unscaled (verify-qa, round 1). */
const asksBound = (isBoundCall: (x: ts.Node) => boolean) => (n: ts.Node | undefined): boolean => {
  if (!n || !contains(n, isBoundCall)) return false;
  // Every expired()/attempts() in the condition is the bound's: a foreign object's beside it makes the condition unscaled.
  if (contains(n, (x) => ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression)
    && (x.expression.name.text === "expired" || x.expression.name.text === "attempts") && !isBoundCall(x))) return false;
  if (contains(n, (x) => ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression) && x.expression.name.text === "now")) return false;
  return !contains(n, (x) => ts.isBinaryExpression(x) && RELATIONAL.has(x.operatorToken.kind)
    && !contains(x.left, isBoundCall) && !contains(x.right, isBoundCall));
};
const loopCondition = (loop: ts.IterationStatement): ts.Node | undefined =>
  ts.isForStatement(loop) ? loop.condition : ts.isWhileStatement(loop) || ts.isDoStatement(loop) ? loop.expression : undefined;
const sleeps = (n: ts.Node): boolean => contains(n, (x) => callsNamed(x, ["setTimeout", "sleep"]));
const isLoop = (n: ts.Node): n is ts.IterationStatement => ts.isIterationStatement(n, false);

/** Walks up from `n` to the nearest loop (or `stop`) inside the same function; the clock-reading `if` conditions that guarded it on
 *  the way (none: not a clock-guarded give-up). */
function clockGuards(n: ts.Node, stop: (p: ts.Node) => boolean): ts.Expression[] {
  const guards: ts.Expression[] = [];
  for (let p = n.parent; p; p = p.parent) {
    if (ts.isIfStatement(p) && readsClock(p.expression)) guards.push(p.expression);
    if (stop(p)) return guards;
    if (ts.isFunctionLike(p)) return [];
  }
  return [];
}
const isIntervalCallback = (p: ts.Node): boolean => ts.isFunctionLike(p) && ts.isCallExpression(p.parent) && callsNamed(p.parent, ["setInterval"]);

/** evidenced: throws waitTimedOut with a bound scaled by load; unscaled: throws waitTimedOut but its guard or loop compares the raw
 *  clock or a fixed count instead of asking the bound (part 3); rethrow: hands back a caught failure as it is; bare: any other Error. */
export interface WaitGiveUp { at: string; kind: "evidenced" | "unscaled" | "rethrow" | "bare" }

/** The declarations the in-memory rows type-check against: the real WaitBound's shape at helpers/wait-timeout.ts, and globals a row may
 *  use: `bound` (a WaitBound that waitBound() made), `other` (a foreign object with the same method names), `WB` (the WaitBound type). */
const ROW_PRELUDE: Record<string, string> = {
  "/mem/helpers/wait-timeout.ts": "declare class WaitBound { #now: () => number; readonly deadline: number; readonly ms: number; expired(): boolean;"
    + " attempts(n: number): number }\nexport type { WaitBound };\nexport declare function waitBound(ms: number): WaitBound;\n",
  "/mem/globals.ts": "declare const waitBound: typeof import(\"./helpers/wait-timeout\").waitBound;\n"
    + "const bound = waitBound(9);\n"
    + "declare const other: { readonly deadline: number; expired(): boolean; attempts(n: number): number };\n"
    + "type WB = import(\"./helpers/wait-timeout\").WaitBound;\n",
};

/** A program over in-memory row sources (keyed by bare names) plus ROW_PRELUDE, for the scanner's own rows. */
function rowProgram(files: Record<string, string>): { program: ts.Program; names: string[] } {
  const all: Record<string, string> = { ...ROW_PRELUDE };
  for (const [name, text] of Object.entries(files)) all[`/mem/${name}`] = text;
  const options: ts.CompilerOptions = {
    noLib: true, types: [], target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
  };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (fileName, target) => (fileName in all ? ts.createSourceFile(fileName, all[fileName]!, target, true) : undefined);
  host.fileExists = (fileName) => fileName in all;
  host.readFile = (fileName) => all[fileName];
  host.directoryExists = (dir) => Object.keys(all).some((f) => f.startsWith(`${dir.replace(/\/$/, "")}/`));
  host.realpath = (path) => path;
  host.getCurrentDirectory = () => "/mem";
  return { program: ts.createProgram(Object.keys(all), options, host), names: Object.keys(files).map((n) => `/mem/${n}`) };
}

/** The daemon's test project (tsconfig.test.json), type-checked as the type check does. */
function testProgram(): ts.Program {
  const configPath = join(TEST_DIR, "..", "tsconfig.test.json");
  const parsed = ts.parseJsonConfigFileContent(ts.readConfigFile(configPath, ts.sys.readFile).config, ts.sys, join(TEST_DIR, ".."));
  return ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true });
}

/** Every wait give-up in the given files of `program` (or, given sources, of an in-memory program over them), classified by what it
 *  throws and whether it asks a load-scaled WaitBound. Sites are named relative to `root` (the bare row names for in-memory rows). */
export function waitGiveUps(files: Record<string, string>, given?: { program: ts.Program; fileNames: string[]; root: string }): WaitGiveUp[] {
  const { program, names, root } = given
    ? { program: given.program, names: given.fileNames, root: given.root } : { ...rowProgram(files), root: "/mem" };
  const checker = program.getTypeChecker();
  const scaled = asksBound(boundCall(checker));
  return names.flatMap((fileName) => {
    const src = program.getSourceFile(fileName);
    if (!src) throw new Error(`not in the program: ${fileName}`);
    const file = relative(root, fileName);
    const out: WaitGiveUp[] = [];
    const record = (site: ts.Node, error: ts.Expression | undefined, scaled: boolean): void => {
      const kind = error && ts.isCallExpression(error) && ts.isIdentifier(error.expression) && error.expression.text === "waitTimedOut"
        ? (scaled ? "evidenced" : "unscaled") : error && ts.isIdentifier(error) ? "rethrow" : "bare";
      out.push({ at: `${file}:${src.getLineAndCharacterOfPosition(site.getStart(src)).line + 1}`, kind });
    };
    const visit = (n: ts.Node): void => {
      if (ts.isThrowStatement(n)) {
        const holder = n.parent;
        const before = ts.isBlock(holder) || ts.isSourceFile(holder) ? holder.statements[holder.statements.indexOf(n) - 1] : undefined;
        const guards = clockGuards(n, isLoop);
        if (guards.length > 0) record(n, n.expression, guards.every(scaled));
        else if (before && isLoop(before) && (sleeps(before) || readsClock(before))) record(n, n.expression, scaled(loopCondition(before)));
      } else if (callsNamed(n, ["reject"])) {
        const guards = clockGuards(n, isIntervalCallback);
        if (guards.length > 0) record(n, (n as ts.CallExpression).arguments[0], guards.every(scaled));
      }
      ts.forEachChild(n, visit);
    };
    visit(src);
    return out;
  });
}

const at = (rows: WaitGiveUp[], kind: WaitGiveUp["kind"]): string[] => rows.filter((r) => r.kind === kind).map((r) => r.at);

describe("workspaces-o9o.179: no daemon test wait gives up without its evidence", () => {
  it("the scanner finds each give-up shape and tells a scaled waitTimedOut, an unscaled one, a rethrow and a bare Error apart (its own controls)", () => {
    const rows = waitGiveUps({
      "clock.ts": "async function w() { const end = Date.now() + 9; for (;;) { if (ok()) return; if (Date.now() > end) throw new Error(`x`); await nap(); } }",
      "evidenced.ts": "async function w() { const bound = waitBound(9); for (;;) { if (bound.expired()) throw waitTimedOut(`x`, bound); await nap(); } }",
      "unscaled.ts": "async function w() { const end = Date.now() + 9; for (;;) { if (Date.now() > end) throw waitTimedOut(`x`, b); await nap(); } }",
      "counted-scaled.ts": "async function w() {\n  for (let i = 0; i < bound.attempts(9); i++) { await sleep(5); }\n  throw waitTimedOut('x', bound);\n}",
      "counted-fixed.ts": "async function w() {\n  for (let i = 0; i < 9; i++) { await sleep(5); }\n  throw waitTimedOut('x', bound);\n}",
      "interval-scaled.ts": "new Promise((resolve, reject) => { setInterval(() => { if (bound.expired()) reject(waitTimedOut('x', bound)); }, 5); });",
      "mixed.ts": "async function w() { for (;;) { if (bound.expired() || Date.now() > oldEnd) throw waitTimedOut('x', bound); await nap(); } }",
      "mixed-count.ts": "async function w() {\n  for (let i = 0; i < bound.attempts(9) && i < 400; i++) { await sleep(5); }\n  throw waitTimedOut('x', bound);\n}",
      "exit-or-bound.ts": "async function w() { for (;;) { if (gone !== null || bound.expired()) throw waitTimedOut('x', bound); await nap(); } }",
      "clock-call.ts": "async function w() { for (;;) { if (bound.expired() || overdue(Date.now())) throw waitTimedOut('x', bound); await nap(); } }",
      "flag-loop.ts": "async function w() {\n  while (!done) { await sleep(5); }\n  throw waitTimedOut('x', bound);\n}",
      "foreign.ts": "async function w() { for (;;) { if (bound.expired() || other.expired()) throw waitTimedOut('x', bound); await nap(); } }",
      "foreign-only.ts": "async function w() { for (;;) { if (other.expired()) throw waitTimedOut('x', bound); await nap(); } }",
      "foreign-alias.ts": "async function w() { const b2 = other; for (;;) { if (b2.expired()) throw waitTimedOut('x', bound); await nap(); } }",
      "foreign-count.ts": "async function w() {\n  for (let i = 0; i < other.attempts(9); i++) { await sleep(5); }\n  throw waitTimedOut('x', bound);\n}",
      "lookalike.ts": "interface WaitBound { expired(): boolean }\ndeclare const fake: WaitBound;\nasync function w() { for (;;) { if (fake.expired()) throw waitTimedOut('x', bound); await nap(); } }",
      "bound-alias.ts": "async function w() { const b3 = bound; for (;;) { if (b3.expired()) throw waitTimedOut('x', b3); await nap(); } }",
      // workspaces-3u9: the bound's type is not enough; the receiver must come from a waitBound() call, through const aliases only.
      "typed-fake.ts": "declare const typed: WB;\nasync function w() { for (;;) { if (typed.expired()) throw waitTimedOut('x', typed); await nap(); } }",
      "cast-fake.ts": "const cast = {} as WB;\nasync function w() { for (;;) { if (cast.expired()) throw waitTimedOut('x', cast); await nap(); } }",
      "let-bound.ts": "async function w() { let b4 = waitBound(9); b4 = other as WB; for (;;) { if (b4.expired()) throw waitTimedOut('x', b4); await nap(); } }",
      "param-bound.ts": "async function w(b5: WB) { for (;;) { if (b5.expired()) throw waitTimedOut('x', b5); await nap(); } }",
      "foreign-maker.ts": "declare function makeBound(ms: number): WB;\nasync function w() { const b6 = makeBound(9); for (;;) { if (b6.expired()) throw waitTimedOut('x', b6); await nap(); } }",
      "fake-alias.ts": "declare const typed2: WB;\nasync function w() { const b7 = typed2; for (;;) { if (b7.expired()) throw waitTimedOut('x', b7); await nap(); } }",
      "nested.ts": "async function w() { for (;;) { if (Date.now() > end) { if (bound.expired()) throw waitTimedOut('x', bound); } await nap(); } }",
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
      { at: "unscaled.ts:1", kind: "unscaled" },
      { at: "counted-scaled.ts:3", kind: "evidenced" },
      { at: "counted-fixed.ts:3", kind: "unscaled" },
      { at: "interval-scaled.ts:1", kind: "evidenced" },
      { at: "mixed.ts:1", kind: "unscaled" },
      { at: "mixed-count.ts:3", kind: "unscaled" },
      { at: "exit-or-bound.ts:1", kind: "evidenced" },
      { at: "clock-call.ts:1", kind: "unscaled" },   // a raw clock read outside any comparison
      { at: "flag-loop.ts:3", kind: "unscaled" },    // a sleeping loop whose condition asks no bound at all
      { at: "foreign.ts:1", kind: "unscaled" },        // a foreign object's expired() beside the bound's (verify-qa round 2)
      { at: "foreign-only.ts:1", kind: "unscaled" },   // the method names alone are not the bound
      { at: "foreign-alias.ts:1", kind: "unscaled" },  // an alias of a foreign object stays foreign: the checker follows it
      { at: "foreign-count.ts:3", kind: "unscaled" },
      { at: "lookalike.ts:3", kind: "unscaled" },      // a type named WaitBound declared anywhere else is not the bound
      { at: "bound-alias.ts:1", kind: "evidenced" },   // an alias of the bound is the bound
      { at: "typed-fake.ts:2", kind: "unscaled" },     // typed WaitBound but never made by waitBound() (workspaces-3u9)
      { at: "cast-fake.ts:2", kind: "unscaled" },      // a cast to WaitBound is not a waitBound()
      { at: "let-bound.ts:1", kind: "unscaled" },      // a reassignable binding can stop being the bound it was made as
      { at: "param-bound.ts:1", kind: "unscaled" },    // a parameter's caller is not seen: make the bound where the wait is
      { at: "foreign-maker.ts:2", kind: "unscaled" },  // another function returning WaitBound is not waitBound()
      { at: "fake-alias.ts:2", kind: "unscaled" },     // an alias of a fake stays a fake
      { at: "nested.ts:1", kind: "unscaled" },       // every clock guard on the path must be the bound, not just the innermost
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

  // workspaces-3u9: verify-qa's attempt-3 repro (o9o174-part3-attempt3-e100c037/fake-wait-bound-repro.ts), byte for byte below its
  // header comment, placed where verify-qa placed it. A hand-made WaitBound whose expired() reads a fixed deadline: it must not compile
  // (WaitBound is nominal, made only by waitBound()), and the census must not credit it even where type errors are tolerated (the daemon
  // test type check is a ratchet, not a gate on zero).
  it("a hand-made WaitBound does not compile, and the census does not credit it (verify-qa's attempt-3 fake)", () => {
    const fakePath = join(TEST_DIR, "__review-fake-wait-bound.ts");
    const fakeSource = [
      'import { waitTimedOut, type WaitBound } from "./helpers/wait-timeout.js";',
      "",
      "const oldDeadline = Date.now() + 1_000;",
      "const fake: WaitBound = {",
      "  startedAt: Date.now(),",
      "  baseMs: 1_000,",
      "  ms: 1_000,",
      "  scale: 1,",
      "  reading: { load1: 0, cores: 20 },",
      "  deadline: oldDeadline,",
      "  expired: () => Date.now() > oldDeadline,",
      "  attempts: (n) => n,",
      "};",
      "",
      "async function waitForFakeWaitBound(): Promise<never> {",
      "  for (;;) {",
      '    if (fake.expired()) throw waitTimedOut("fake WaitBound probe", fake);',
      "    await new Promise((resolve) => setTimeout(resolve, 5));",
      "  }",
      "}",
      "void waitForFakeWaitBound;",
      "",
    ].join("\n");
    const configPath = join(TEST_DIR, "..", "tsconfig.test.json");
    const parsed = ts.parseJsonConfigFileContent(ts.readConfigFile(configPath, ts.sys.readFile).config, ts.sys, join(TEST_DIR, ".."));
    const options = { ...parsed.options, noEmit: true };
    // And nothing outside helpers/wait-timeout.ts can construct one: the class is exported as a type only.
    const constructPath = join(TEST_DIR, "__review-construct-wait-bound.ts");
    const constructSource = 'import { WaitBound } from "./helpers/wait-timeout.js";\n'
      + "export const made = new WaitBound(0, 1_000, { load1: 0, cores: 20 }, () => 0);\n";
    const virtual: Record<string, string> = { [fakePath]: fakeSource, [constructPath]: constructSource };
    const host = ts.createCompilerHost(options);
    const read = host.getSourceFile.bind(host);
    host.getSourceFile = (fileName, target, ...rest) =>
      (fileName in virtual ? ts.createSourceFile(fileName, virtual[fileName]!, target, true) : read(fileName, target, ...rest));
    const fileExists = host.fileExists.bind(host);
    host.fileExists = (fileName) => fileName in virtual || fileExists(fileName);
    const program = ts.createProgram([join(TEST_DIR, "helpers", "wait-timeout.ts"), fakePath, constructPath], options, host);
    const errors = (path: string) => program.getSemanticDiagnostics(program.getSourceFile(path)).map((d) => ({
      line: d.file!.getLineAndCharacterOfPosition(d.start!).line + 1, code: d.code,
      message: ts.flattenDiagnosticMessageText(d.messageText, "\n").split("\n")[0],
    }));
    // TS2741 on `const fake: WaitBound`: the private brand, which only a WaitBound that waitBound() made carries, is missing.
    expect(errors(fakePath)).toEqual([{ line: 4, code: 2741, message: expect.stringContaining("Property '#now' is missing") }]);
    expect(errors(constructPath)).toEqual([{ line: 2, code: 1362, message: expect.stringContaining("exported using 'export type'") }]);
    expect(waitGiveUps({}, { program, fileNames: [fakePath], root: TEST_DIR })).toEqual([
      { at: "__review-fake-wait-bound.ts:17", kind: "unscaled" },
    ]);
  });

  it("every wait in the daemon tests gives up through waitTimedOut", () => {
    const fileNames = testSources(TEST_DIR);
    expect(fileNames.length).toBeGreaterThan(1000);   // the population scanned, so a clean result is not an empty walk
    const program = testProgram();
    expect(fileNames.filter((f) => !program.getSourceFile(f))).toEqual([]);   // every test source is type-checked, none skipped
    const rows = waitGiveUps({}, { program, fileNames, root: TEST_DIR });
    expect(at(rows, "bare")).toEqual([]);
    expect(at(rows, "unscaled")).toEqual([]);   // part 3: every give-up asks a load-scaled bound, never the raw clock or a fixed count
    expect(at(rows, "evidenced").length).toBeGreaterThanOrEqual(40);   // the give-ups found, so a clean result is not a blind scanner
    // Rethrows hand back the failure the wait last saw (an assertion's diff; the CLI's own error after its retries), kept as it is.
    expect(at(rows, "rethrow").sort()).toEqual(["helpers/eval-rig-session.ts:285", "pi-usage-cost.test.ts:168"]);
  }, 300_000);   // type-checks the whole test project once
});
