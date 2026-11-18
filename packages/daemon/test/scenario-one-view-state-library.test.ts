// workspaces-o9o.132 review (verify-qa; CoS decision A): the library scenario one-view-state-after-mutation-storm (#10) must pin the seed it
// declares. Host mode cannot arm a seed and does not bind `mutate`, so this runs the scenario FILE itself (loaded and validated as the runner
// loads it) through the real runner core and declarative normalizer, with fake surfaces: the healthy run passes, the seeded run (a queue item
// addressed to a rig `ps` does not run) fails at the equality, and so does a TUI whose view (the `tui_view` surface, its socket's OBSERVE
// verb "view", workspaces-o9o.172, ROUTING R-21) lacks the rig.
import { describe, expect, it } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadScenarioFile } from "./helpers/scenario-pipeline.js";
import { runValidatedScenario, type ActionResult } from "./helpers/scenario-runner.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(HERE, "../../test-system/scenarios/one-view-state-after-mutation-storm.yaml");
const ok: ActionResult = { code: 0, stdout: "", stderr: "" };

function run(opts: { seedPlantsForeignRig?: boolean; tuiScreen?: string; tuiMissesRig?: boolean }) {
  const loaded = loadScenarioFile(FILE);
  if (!loaded.ok) throw new Error(`#10 does not load: ${JSON.stringify(loaded.errors)}`);
  const scenario = loaded.loaded.scenario;
  let seeded = false;
  let t = 0;
  const result = runValidatedScenario(scenario, {
    runAction: async (verb) => { if (verb === "seed_regression" && opts.seedPlantsForeignRig) seeded = true; return ok; },
    observe: async (surface) => {
      if (surface === "ps") return [{ name: "mutation-pod-stub", status: "running" }];
      if (surface === "queue") {
        return [
          { qitemId: "storm-1", state: "in-progress", destinationSession: "swarm-a@mutation-pod-stub" },
          ...(seeded ? [{ qitemId: "storm-2", state: "pending", destinationSession: "swarm-a@ghost-rig" }] : []),
        ];
      }
      if (surface === "tui_view") {
        const rigs = opts.tuiMissesRig ? [] : [{ host: "local", name: "mutation-pod-stub", reachable: true, agents: [] }];
        return { ok: true, instanceId: "tui-1", view: { readAt: "2026-11-18T16:00:00.000Z", stale: false, settled: true, rigs, hostsDown: [], counts: { rigs: rigs.length, agents: 0 }, truncated: false } };
      }
      if (surface === "tui_socket") {
        const address = { instance: "tui-1", section: "topology" };
        const screen = opts.tuiScreen ?? "topology";
        return { ok: true, instanceId: "tui-1", state: { ok: true, screen, drill: [], address: { ...address, section: screen } } };
      }
      return null;
    },
    now: () => (t += 1000),
    sleep: async () => {},
    defaults: { withinMs: 3000, pollIntervalMs: 1000 },
  });
  const tuiStep = scenario.steps.findIndex((s) => "expect" in s && (s.expect as { surface?: string }).surface === "tui_socket");
  const equalityStep = scenario.steps.findIndex((s) => "expect" in s && "equals" in (s.expect as object));
  const seedStep = scenario.steps.findIndex((s) => "seed_regression" in s);
  return { result, equalityStep, seedStep, tuiStep };
}

describe("#10 one-view-state-after-mutation-storm pins the seed it declares", () => {
  it("its seed is armed before the equality it must break", () => {
    const { seedStep, equalityStep } = run({});
    expect(seedStep).toBeGreaterThanOrEqual(0);
    expect(seedStep).toBeLessThan(equalityStep);
  });

  it("healthy: ps and queue name the same rig, and the run passes", async () => {
    expect((await run({}).result).verdict).toBe("PASS");
  });

  it("seeded: a queue item addressed to a rig ps does not run fails the ps-vs-queue equality", async () => {
    const { result, equalityStep } = run({ seedPlantsForeignRig: true });
    const r = await result;
    expect(r.verdict).toBe("FAIL");
    expect(r.failedStep).toBe(equalityStep);
  });

  it("the TUI leg asserts the TUI's own state, not only ok: a TUI on another screen fails at that leg", async () => {
    const { result, tuiStep } = run({ tuiScreen: "queue" });
    const r = await result;
    expect(r.verdict).toBe("FAIL");
    expect(r.failedStep).toBe(tuiStep);
  });

  it("a TUI whose view lacks the rig ps and queue name fails the equality (R-21, o9o.172)", async () => {
    const { result, equalityStep } = run({ tuiMissesRig: true });
    const r = await result;
    expect(r.verdict).toBe("FAIL");
    expect(r.failedStep).toBe(equalityStep);
  });
});
