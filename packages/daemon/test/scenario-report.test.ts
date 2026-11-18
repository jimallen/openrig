// workspaces-o9o.132 (CoS decision D1): the standalone runner reports HEALTHY-ONLY and NOT RUN in their own columns, never as passed, and
// exits 1 only on a FAIL or an ERROR.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exitCode, outcomeLines, summaryLine, tally, type ScenarioOutcome } from "./helpers/scenario-report.js";

const pass: ScenarioOutcome = { kind: "result", result: { scenario: "a", verdict: "PASS" } };
const healthy: ScenarioOutcome = { kind: "result", result: { scenario: "b", verdict: "HEALTHY_ONLY", seedNotRun: { step: 3, class: "c1", reason: "host mode has no seed controller; CI arms it" } } };
const notRunStep: ScenarioOutcome = { kind: "result", result: { scenario: "c", verdict: "NOT_RUN", notRun: { step: 2, verb: "mutate", reason: "no binding at v1" } } };
const notRunEnv: ScenarioOutcome = { kind: "result", result: { scenario: "d", verdict: "NOT_RUN", notRun: { step: null, verb: "env.pre_existing_tmux", reason: "R-14" } } };
const failed: ScenarioOutcome = { kind: "result", result: { scenario: "e", verdict: "FAIL", failedStep: 1, diff: "x" } };
const errored: ScenarioOutcome = { kind: "error", file: "/f.yaml", message: "could not load" };

describe("the runner's ledger lines", () => {
  it.each([
    [pass, ["[PASS] a"]],
    [healthy, ["[HEALTHY-ONLY] b", "  seed NOT RUN at step 3 (class c1): host mode has no seed controller; CI arms it"]],
    [notRunStep, ["[NOT RUN] c", "  step 2 (mutate): no binding at v1"]],
    [notRunEnv, ["[NOT RUN] d", "  env.pre_existing_tmux: R-14"]],
    [failed, ["[FAIL] e", "  step 1: x"]],
    [errored, ["[ERROR] /f.yaml", "  could not load"]],
  ])("%#", (outcome, lines) => {
    expect(outcomeLines(outcome)).toEqual(lines);
  });
});

describe("the summary and the exit status", () => {
  it("counts each outcome in its own column; an ERROR is counted as failed", () => {
    expect(summaryLine(tally([pass, healthy, notRunStep, notRunEnv, failed, errored]))).toBe("6 scenarios: 1 passed, 1 healthy-only, 2 NOT RUN, 2 failed");
  });

  it("HEALTHY-ONLY and NOT RUN do not fail the run; a FAIL or an ERROR does", () => {
    expect(exitCode(tally([pass, healthy, notRunStep]))).toBe(0);
    expect(exitCode(tally([pass, failed]))).toBe(1);
    expect(exitCode(tally([pass, errored]))).toBe(1);
  });

  it("nothing but PASS is counted as passed", () => {
    expect(tally([healthy, notRunStep, notRunEnv]).passed).toBe(0);
  });
});

describe("run-scenarios.mjs end to end", () => {
  it("a scenario needing the pre-existing tmux fixture prints [NOT RUN] with R-14, the new summary, and exits 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "o9o132-report-"));
    try {
      const p = join(dir, "needs-tmux.yaml");
      writeFileSync(p, "scenario: needs-tmux\ntopology: ./unused.yaml\nenv:\n  pre_existing_tmux: true\nsteps:\n  - up: {}\n");
      const runner = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts/run-scenarios.mjs");
      const r = spawnSync(process.execPath, ["--import", "tsx", runner, p], { encoding: "utf8", env: { HOME: dir, PATH: process.env.PATH, TERM: "xterm" }, timeout: 60_000 });
      expect(r.stdout).toContain("[NOT RUN] needs-tmux");
      expect(r.stdout).toContain("R-14");
      expect(r.stdout).toContain("1 scenarios: 0 passed, 0 healthy-only, 1 NOT RUN, 0 failed");
      expect(r.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
