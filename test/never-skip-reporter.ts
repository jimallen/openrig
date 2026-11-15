// Never-skip guard (Jim, 2026-11-15: "tests must never be skipped"; conditional skips are fine).
//
// A vitest reporter, registered by the root and every package config next to the default one. When the run ends it fails the
// run (exit code 1, with one line per finding) on:
//   - a todo test (`it.todo`);
//   - an expected-failure test (`it.fails`): it counts as a pass while the defect it names is there;
//   - a skipped test that no entry of test/never-skip-allowlist.json covers.
// An entry names one conditional skip site the rule allows (a platform, a missing tool, an opt-in env): the file, the title path of
// the task the marker sits on (`describe title > it title`, as written; `taskPattern` is a regex for a title built at run time from a
// template, never a whole file), the marker's `kind` and its condition `when` (read with the kind: a runIf's `when` is the condition
// it RUNS under). A skipped test is covered when the task that put it in skip mode is listed: the test itself (it.skipIf, ctx.skip()), or an
// enclosing describe that is itself skipped (describe.skipIf). A describe that RAN does not cover a skip inside it, so an `it.skip`
// added under a listed describe.skipIf is caught on every host where that describe runs.
//
// Off for a run filtered by test name (`-t`): vitest marks every unmatched test skipped there. File filters skip nothing.
// Not caught here: a test that passes by returning early, and a skip whose condition is listed but always true on our hosts
// (the list says what each entry waits for, so review can judge it).
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { Reporter, TestModule, Vitest } from "vitest/node";

/** The parts of vitest's reported TestCase / TestSuite / TestModule the rule reads (vitest's own classes satisfy them). */
export interface ReportedModule { readonly type: "module" }
export interface ReportedSuite { readonly type: "suite"; readonly name: string; readonly parent: ReportedSuite | ReportedModule; readonly options: { readonly mode: string } }
export interface ReportedTest {
  readonly type: "test"; readonly name: string; readonly parent: ReportedSuite | ReportedModule;
  readonly options: { readonly mode: string; readonly fails?: boolean | undefined }; result(): { readonly state: string };
}

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const ALLOWLIST_PATH = join(REPO_ROOT, "test", "never-skip-allowlist.json");

/** How to read `when`: skipIf = the task is skipped WHEN it holds; runIf = it runs only when it holds (skipped when it does not);
 *  ctx.skip = the test body calls ctx.skip() under it; skip-in-if = an it.skip registered only inside `if (when)`. */
export const ALLOW_KINDS = ["skipIf", "runIf", "ctx.skip", "skip-in-if"] as const;
export interface AllowEntry { file: string; kind: (typeof ALLOW_KINDS)[number]; task?: string; taskPattern?: string; when: string }

export function loadAllowlist(path = ALLOWLIST_PATH): AllowEntry[] {
  const entries = JSON.parse(readFileSync(path, "utf8")) as AllowEntry[];
  for (const e of entries) {
    if (typeof e.file !== "string" || typeof e.when !== "string" || !ALLOW_KINDS.includes(e.kind)
      || (typeof e.task === "string") === (typeof e.taskPattern === "string")) {
      throw new Error(`never-skip allow-list: each entry needs file, kind (${ALLOW_KINDS.join(", ")}), when, and exactly one of task / taskPattern: ${JSON.stringify(e)}`);
    }
  }
  return entries;
}

/** The title path of a test or suite: its own name after every enclosing describe's, joined with " > ". */
export function titlePath(task: ReportedTest | ReportedSuite): string {
  const names: string[] = [];
  for (let t: ReportedTest | ReportedSuite | ReportedModule = task; t.type !== "module"; t = t.parent) names.unshift(t.name);
  return names.join(" > ");
}

function covers(entry: AllowEntry, file: string, path: string): boolean {
  if (entry.file !== file) return false;
  return entry.task !== undefined ? entry.task === path : new RegExp(`^(?:${entry.taskPattern})$`).test(path);
}

/** The findings for one finished test, against the allow-list: [] when the test is fine. */
export function findingsFor(test: ReportedTest, file: string, allow: readonly AllowEntry[]): string[] {
  const out: string[] = [];
  const path = titlePath(test);
  if (test.options.fails) out.push(`${file} > ${path}: it.fails (an expected failure counts as a pass); fix the behaviour or delete the test`);
  if (test.options.mode === "todo") out.push(`${file} > ${path}: todo; write the test or delete it`);
  else if (test.result().state === "skipped") {
    const markers: Array<ReportedTest | ReportedSuite> = [test];
    for (let p = test.parent; p.type !== "module"; p = p.parent) if (p.options.mode === "skip") markers.push(p);
    if (!markers.some((m) => allow.some((e) => covers(e, file, titlePath(m))))) {
      out.push(`${file} > ${path}: skipped, and no allow-list entry covers it (test/never-skip-allowlist.json)`);
    }
  }
  return out;
}

export default class NeverSkipReporter implements Reporter {
  private vitest: Vitest | undefined;

  onInit(vitest: Vitest): void { this.vitest = vitest; }

  onTestRunEnd(modules: ReadonlyArray<TestModule>): void {
    if (this.vitest?.config.testNamePattern) {
      console.log("never-skip guard: off for this run (filtered by test name with -t)");
      return;
    }
    const allow = loadAllowlist();
    const findings: string[] = [];
    for (const mod of modules) {
      const file = relative(REPO_ROOT, mod.moduleId);
      for (const test of mod.children.allTests()) findings.push(...findingsFor(test, file, allow));
    }
    if (findings.length === 0) return;
    console.error(`\nnever-skip guard: ${findings.length} finding(s). Tests must not be skipped, todo or expected to fail; a skip conditioned on a platform, a missing tool or an opt-in env is listed in test/never-skip-allowlist.json.`);
    for (const f of findings) console.error(`  ${f}`);
    process.exitCode = 1;
  }
}
