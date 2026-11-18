#!/usr/bin/env -S node --import tsx
/*
 * Slice 51-02 - the STANDALONE scenario runner entry (config-wrapper-code; NOT a
 * rig-test verb). Runs one or more scenario YAML files against a forced-local,
 * hermetic scenario-local daemon and prints a PASS/FAIL results ledger.
 *
 * Usage (the tsx loader is needed for the TS pipeline import; the shebang wires it
 * when the file is executed directly, otherwise invoke via node --import tsx):
 *   packages/daemon/scripts/run-scenarios.mjs [scenario.yaml ...]
 *   node --import tsx packages/daemon/scripts/run-scenarios.mjs [scenario.yaml ...]
 *
 * With no args it runs the committed evidence scenarios under
 * test/fixtures/scenarios/. Prerequisite: the built rig bin (npm run build -w
 * packages/cli and -w packages/daemon). The up step stands up real tmux seats on a
 * server the hermetic scaffold OWNS (it sets TMUX_TMPDIR itself), so a run cannot
 * reach the operator/fleet server. This runner passes the scaffold only HOME, PATH
 * and TERM, so an ambient TMUX (and any daemon variable) is dropped rather than
 * refused, and running from inside tmux is safe.
 *
 * The equals mode compares surfaces through the DECLARATIVE mapping each scenario
 * declares (`equals: {<surface>: {pluck, path, rig}}`, scenario-normalizer.ts), the
 * only form the validator accepts (51-03, R-13): scenario-runner.ts builds the
 * normalizer from that mapping, and the `normalizer` passed below is used only for
 * a bare list, which never passes validation. What keeps the one-view-state scenario
 * (#10) from running in host mode is its unbound `mutate` step (reported NOT RUN),
 * not its equality.
 */
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runScenarioFile } from "../test/helpers/scenario-pipeline.ts";
import { exitCode, outcomeLines, summaryLine, tally } from "../test/helpers/scenario-report.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DAEMON_ROOT = resolve(HERE, "..");
const RIG_BIN = resolve(DAEMON_ROOT, "..", "cli", "dist", "bin-wrapper.js");
const FIXTURES = join(DAEMON_ROOT, "test", "fixtures", "scenarios");

const argv = process.argv.slice(2);

// B12-S safety refusal (ruled). This runner takes scenario YAML paths ONLY. Before this
// guard, a dash-prefixed arg was resolve()'d into a bogus path that threw mid-loop and was
// counted as one failed "scenario" WHILE the remaining files still ran in host-mode — so
// `run-scenarios.mjs --container x.yaml` printed one [ERROR] plus a partial-success summary
// that a reader could mistake for container mode having run. Refuse BEFORE anything executes
// so an unknown flag runs ZERO scenarios (no PASS/FAIL lines, no partial summary). A flagless
// invocation is byte-identical to before.
const flagArg = argv.find((a) => a.startsWith("-"));
if (flagArg) {
  console.error(`[REFUSED] unknown flag '${flagArg}' — this runner takes scenario YAML paths only; container mode is not a flag (see slice 15).`);
  process.exit(2);
}

const files = argv.length > 0
  ? argv.map((a) => resolve(a))
  : readdirSync(FIXTURES).filter((f) => /^scenario-.*\.ya?ml$/.test(f)).sort().map((f) => join(FIXTURES, f));

const baseEnv = { HOME: process.env.HOME, PATH: process.env.PATH, TERM: "xterm" };
// Used only by a bare `equals` list, which the validator rejects; a declared mapping builds its own normalizer.
const deps = { normalizer: (_surface, value) => value };

const outcomes = [];
for (const file of files) {
  let outcome;
  try {
    outcome = { kind: "result", result: await runScenarioFile(file, { rigBin: RIG_BIN, baseEnv, deps }) };
  } catch (err) {
    // A teardown failure after a returned run carries that run's result (ScenarioTeardownError): show it too.
    outcome = { kind: "error", file, message: String((err && err.message) || err), ...(err && err.result ? { ran: err.result } : {}) };
  }
  outcomes.push(outcome);
  console.log(outcomeLines(outcome).join("\n"));
}
// workspaces-o9o.132 (CoS decision D1): HEALTHY-ONLY and NOT RUN have their own columns and are never counted as passed.
const counts = tally(outcomes);
console.log(`\n${summaryLine(counts)}`);
process.exit(exitCode(counts));
