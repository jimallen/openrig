import { describe, expect, it, vi } from "vitest";
import { validateScenario } from "./helpers/scenario-schema.js";
import { runValidatedScenario, type ScenarioRunnerDeps } from "./helpers/scenario-runner.js";
import { buildRealDeps } from "./helpers/scenario-real-deps.js";
import type { RunRecord } from "./helpers/scenario-run-record.js";
import type { RigResult } from "./helpers/scenario-daemon.js";

// workspaces-o9o.29: `up: { fails: { contains } }` lets a scenario expect a launch to fail and say what the failure must
// report. Before it, any non-zero `up` failed the scenario, so no scenario could reach a launch failure.

const validate = (up: unknown) => validateScenario({ scenario: "s", topology: "t.yaml", steps: [{ up }, { down: {} }] });

describe("o9o.29: the validator's up.fails", () => {
  it.each([
    ["an empty up", {}],
    ["an up naming a topology", { topology: "./other.yaml" }],
    ["an up expected to fail with a text", { fails: { contains: "timed out" } }],
  ])("accepts %s", (_label, up) => {
    expect(validate(up)).toMatchObject({ ok: true });
  });

  it.each([
    ["fails as a bare true", { fails: true }],
    ["fails with no contains", { fails: {} }],
    ["fails with an empty contains", { fails: { contains: "" } }],
    ["fails with a non-string contains", { fails: { contains: 3 } }],
    ["fails with another key beside contains", { fails: { contains: "x", exitCode: 1 } }],
  ])("refuses %s, naming UP_FAILS_INVALID at steps[0].up.fails", (_label, up) => {
    const result = validate(up);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([expect.objectContaining({ code: "UP_FAILS_INVALID", path: "steps[0].up.fails" })]);
  });
});

function runnerDeps(up: RigResult): ScenarioRunnerDeps & { records: RunRecord[]; verbs: string[] } {
  const records: RunRecord[] = [];
  const verbs: string[] = [];
  let t = 0;
  return {
    runAction: vi.fn(async (verb: string) => { verbs.push(verb); return verb === "up" ? up : { code: 0, stdout: "", stderr: "" }; }),
    observe: vi.fn(async () => ({})),
    now: () => (t += 1000),
    sleep: async () => {},
    appendRecord: (r: RunRecord) => records.push(r),
    defaults: { withinMs: 1000, pollIntervalMs: 100 },
    records,
    verbs,
  };
}

function scenarioWith(up: unknown) {
  const result = validate(up);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.scenario;
}

describe("o9o.29: the runner's up.fails", () => {
  const expected = { fails: { contains: "pane tail not stored" } };

  it("passes when up fails saying the text, and runs the next step", async () => {
    const deps = runnerDeps({ code: 1, stdout: '{"reason":"timed out — pane tail not stored"}', stderr: "" });
    expect(await runValidatedScenario(scenarioWith(expected), deps)).toEqual({ scenario: "s", verdict: "PASS" });
    expect(deps.verbs).toEqual(["up", "down"]);
  });

  it("finds the text in stderr too", async () => {
    const deps = runnerDeps({ code: 1, stdout: "", stderr: "pane tail not stored" });
    expect((await runValidatedScenario(scenarioWith(expected), deps)).verdict).toBe("PASS");
  });

  it("fails at step 0 when up succeeds", async () => {
    const deps = runnerDeps({ code: 0, stdout: "{}", stderr: "" });
    const result = await runValidatedScenario(scenarioWith(expected), deps);
    expect(result).toMatchObject({ verdict: "FAIL", failedStep: 0 });
    expect(result.diff).toContain("action `up` was expected to fail and exited 0");
    expect(deps.verbs).toEqual(["up"]);
  });

  it("fails at step 0 when up fails without the text, quoting what it said", async () => {
    const deps = runnerDeps({ code: 1, stdout: "some other failure", stderr: "" });
    const result = await runValidatedScenario(scenarioWith(expected), deps);
    expect(result).toMatchObject({ verdict: "FAIL", failedStep: 0 });
    expect(result.diff).toContain('its output does not contain "pane tail not stored": some other failure');
  });

  it("an up with no fails still fails the scenario when it exits non-zero (unchanged)", async () => {
    const deps = runnerDeps({ code: 1, stdout: "", stderr: "pane tail not stored" });
    const result = await runValidatedScenario(scenarioWith({}), deps);
    expect(result).toMatchObject({ verdict: "FAIL", failedStep: 0 });
    expect(result.diff).toContain("action `up` failed (exit 1)");
  });
});

describe("o9o.29: a failed up's rig is still the one down stops", () => {
  it("captures the rig id from a failed up's output, so down targets it", async () => {
    const calls: string[][] = [];
    const runRig = vi.fn(async (args: string[]): Promise<RigResult> => {
      calls.push(args);
      if (args[0] === "up") return { code: 1, stdout: JSON.stringify({ status: "partial", rigId: "rig-held-1" }), stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const daemon = {
      readEnv: { OPENRIG_URL: "http://127.0.0.1:9", HOME: "/x" } as Record<string, string | undefined>,
      baseUrl: "http://127.0.0.1:9",
      sigterm: vi.fn(async () => {}),
      restart: vi.fn(async () => {}),
    };
    const deps = buildRealDeps({ daemon, rigBin: "/bin/rig", topologyPath: "/t/spec.yaml", runRig });
    expect((await deps.runAction("up", { fails: { contains: "x" } }, undefined)).code).toBe(1);
    expect((await deps.runAction("down", {}, undefined)).code).toBe(0);
    expect(calls[1]).toEqual(["down", "rig-held-1", "--json", "--force"]);
  });
});
