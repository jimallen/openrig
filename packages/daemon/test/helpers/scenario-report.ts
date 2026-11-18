/**
 * workspaces-o9o.132 (CoS decision D1) — how the standalone scenario runner (scripts/run-scenarios.mjs) reports a run. Five outcomes, each in
 * its own column; only PASS is counted as passed:
 *   PASS          every step ran and held
 *   HEALTHY-ONLY  every step but an unbound seed ran and held (host mode has no seed controller; CI arms it)
 *   NOT RUN       an unbound step or fixture stopped the scenario, named with why
 *   FAIL          a step did not hold
 *   ERROR         the scenario could not be loaded or the runner threw
 * The exit status is 1 on any FAIL or ERROR, else 0.
 */
import type { RunScenarioResult } from "./scenario-runner.js";

export type ScenarioOutcome =
  | { kind: "result"; result: RunScenarioResult }
  | { kind: "error"; file: string; message: string; ran?: RunScenarioResult };

/** The ledger lines for one scenario. */
export function outcomeLines(outcome: ScenarioOutcome): string[] {
  if (outcome.kind === "error") {
    const r = outcome.ran;
    const ran = r ? [`  the run itself: ${r.verdict}${r.verdict === "FAIL" ? ` at step ${r.failedStep}: ${r.diff}` : ""}`] : [];
    return [`[ERROR] ${outcome.file}`, `  ${outcome.message}`, ...ran];
  }
  const r = outcome.result;
  switch (r.verdict) {
    case "PASS":
      return [`[PASS] ${r.scenario}`];
    case "HEALTHY_ONLY":
      return [`[HEALTHY-ONLY] ${r.scenario}`, `  seed NOT RUN at step ${r.seedNotRun?.step} (class ${r.seedNotRun?.class}): ${r.seedNotRun?.reason}`];
    case "NOT_RUN": {
      const where = r.notRun?.step === null || r.notRun?.step === undefined ? r.notRun?.verb : `step ${r.notRun.step} (${r.notRun.verb})`;
      return [`[NOT RUN] ${r.scenario}`, `  ${where}: ${r.notRun?.reason}`];
    }
    default:
      return [`[FAIL] ${r.scenario}`, `  step ${r.failedStep}: ${r.diff}`];
  }
}

export interface ScenarioTally { total: number; passed: number; healthyOnly: number; notRun: number; failed: number }

/** Counts by outcome; an ERROR is counted as failed. */
export function tally(outcomes: readonly ScenarioOutcome[]): ScenarioTally {
  const t: ScenarioTally = { total: outcomes.length, passed: 0, healthyOnly: 0, notRun: 0, failed: 0 };
  for (const o of outcomes) {
    if (o.kind === "error") t.failed++;
    else if (o.result.verdict === "PASS") t.passed++;
    else if (o.result.verdict === "HEALTHY_ONLY") t.healthyOnly++;
    else if (o.result.verdict === "NOT_RUN") t.notRun++;
    else t.failed++;
  }
  return t;
}

/** The summary line: "<n> scenarios: x passed, h healthy-only, y NOT RUN, z failed". */
export function summaryLine(t: ScenarioTally): string {
  return `${t.total} scenarios: ${t.passed} passed, ${t.healthyOnly} healthy-only, ${t.notRun} NOT RUN, ${t.failed} failed`;
}

/** 1 when anything FAILed or ERRORed, else 0. HEALTHY-ONLY and NOT RUN are reported, never counted as passed, and do not fail the run. */
export function exitCode(t: ScenarioTally): 0 | 1 {
  return t.failed > 0 ? 1 : 0;
}
