import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultHostDaemon, runScenarioFile } from "./helpers/scenario-pipeline.js";
import { findHc } from "./helpers/hc-scratch.js";

// workspaces-o9o.29: the two launch-failure library scenarios, run in host mode on the scenario's own private hc core.
// After the scenario's last step (its `down`) and BEFORE the pipeline tears the scaffold down, this checks what the
// scenario grammar cannot say: no stub runner of this scenario is still running, and the scenario's private core has no
// live terminal. Checked at teardown time so the answer is down's, not teardown's.

const here = dirname(fileURLToPath(import.meta.url));
const rigBin = resolve(here, "../../cli/dist/bin-wrapper.js");
const library = resolve(here, "../../test-system/scenarios");
const hc = findHc();

/** What is left of a scenario: its stub runners (by the scaffold path in their arguments) and its core's live terminals. */
function leftovers(scaffoldRoot: string, env: Record<string, string | undefined>): { runners: string[]; terminals: unknown[] } {
  const ps = spawnSync("ps", ["-eo", "args="], { encoding: "utf8" });
  if (ps.status !== 0) throw new Error(`ps failed: ${ps.stderr}`);
  const processes = ps.stdout.split("\n");
  // Positive control: the table holds this test's own process, so an empty match is an absence, not a failed read.
  if (!processes.some((line) => line.includes(String(process.pid)) || line.includes("vitest") || line.includes("node"))) {
    throw new Error("the process table read found no node process at all");
  }
  const runners = processes.filter((line) => line.includes("stub-runner") && line.includes(scaffoldRoot));
  const ls = spawnSync(hc!, ["ls", "--json"], { encoding: "utf8", env: { ...env } as NodeJS.ProcessEnv });
  if (ls.status !== 0) throw new Error(`hc ls failed on the scenario's core: ${ls.stderr}`);
  // `hc ls --json` answers { terminals: [...live], hidden_finished: <count> } (measured); only live terminals count.
  const answer = JSON.parse(ls.stdout) as { terminals?: unknown };
  if (!Array.isArray(answer.terminals)) throw new Error(`hc ls --json carried no terminals list: ${ls.stdout}`);
  return { runners, terminals: answer.terminals };
}

async function runWithLeftoverCheck(file: string) {
  let seen: { runners: string[]; terminals: unknown[] } | undefined;
  const result = await runScenarioFile(resolve(library, file), {
    rigBin,
    daemon: async (scaffold, opts) => {
      const daemon = await defaultHostDaemon(scaffold, opts);
      return {
        ...daemon,
        stop: async () => {
          // The daemon is stopped whatever the check finds or throws: a check must never leave a scenario running.
          try {
            seen = leftovers(scaffold.root, daemon.readEnv);
          } finally {
            await daemon.stop();
          }
        },
      };
    },
  });
  return { result, seen };
}

describe.runIf(hc !== null)("o9o.29 launch-failure scenarios (host mode, private hc core)", () => {
  it("a seat held short of ready: up fails with the timeout, the pane shows the held line, and down leaves nothing running", async () => {
    const { result, seen } = await runWithLeftoverCheck("launch-held-short-of-ready.yaml");
    expect(result).toEqual({ scenario: "launch-held-short-of-ready", verdict: "PASS" });
    expect(seen).toEqual({ runners: [], terminals: [] });
  }, 180_000);

  it("a runner that exits before ready: up fails quoting its ERROR line, and down leaves nothing running", async () => {
    const { result, seen } = await runWithLeftoverCheck("launch-runner-exits-before-ready.yaml");
    expect(result).toEqual({ scenario: "launch-runner-exits-before-ready", verdict: "PASS" });
    expect(seen).toEqual({ runners: [], terminals: [] });
  }, 180_000);
});
