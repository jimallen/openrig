// workspaces-o9o.132 review (verify-qa; CoS decision A): the library scenario one-view-state-after-mutation-storm (#10) must pin the seed it
// declares. Host mode cannot arm a seed and does not bind `mutate`, so this runs the scenario FILE itself (loaded and validated as the runner
// loads it) through the real runner core and declarative normalizer, with fake surfaces: the healthy run passes, the seeded run (a queue item
// addressed to a rig `ps` does not run) fails at the equality, and so does a TUI whose view (the `tui_view` surface, its socket's OBSERVE
// verb "view", workspaces-o9o.172, ROUTING R-21) lacks the rig. The fake TUI behaves as a real one was measured to: it reads a rig's seats
// only once a `tui` action drilled it into that rig, and until then the rig's agentCount is null.
import { describe, expect, it } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadScenarioFile } from "./helpers/scenario-pipeline.js";
import { runValidatedScenario, type ActionResult } from "./helpers/scenario-runner.js";
import { annotateTuiView } from "./helpers/scenario-surfaces.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(HERE, "../../test-system/scenarios/one-view-state-after-mutation-storm.yaml");
const ok: ActionResult = { code: 0, stdout: "", stderr: "" };

function run(opts: { seedPlantsForeignRig?: boolean; tuiScreen?: string; tuiMissesRig?: boolean; tuiStale?: boolean; tuiReadBeforeStep?: boolean; tuiFewerAgents?: boolean;
  dropDrill?: boolean; drillOtherRig?: boolean }) {
  const loaded = loadScenarioFile(FILE);
  if (!loaded.ok) throw new Error(`#10 does not load: ${JSON.stringify(loaded.errors)}`);
  const file = loaded.loaded.scenario;
  const steps = file.steps
    .filter((s) => !(opts.dropDrill && "tui" in s))
    .map((s) => (opts.drillOtherRig && "tui" in s ? { tui: { rig: "other-rig" } } : s));
  const scenario = { ...file, steps };
  let seeded = false;
  let drilledRig: unknown = null;
  let t = 0;
  const result = runValidatedScenario(scenario, {
    runAction: async (verb, payload) => {
      if (verb === "seed_regression" && opts.seedPlantsForeignRig) seeded = true;
      if (verb === "tui") drilledRig = (payload as { rig?: unknown }).rig;
      return ok;
    },
    observe: async (surface, o) => {
      if (surface === "ps") return [{ name: "mutation-pod-stub", status: "running", nodeCount: 3 }];
      if (surface === "queue") {
        return [
          { qitemId: "storm-1", state: "in-progress", destinationSession: "swarm-a@mutation-pod-stub" },
          ...(seeded ? [{ qitemId: "storm-2", state: "pending", destinationSession: "swarm-a@ghost-rig" }] : []),
        ];
      }
      if (surface === "tui_view") {
        // The reader's own annotation (annotateTuiView) runs on this reply, with the step's start time the runner handed over.
        const inventory = drilledRig === "mutation-pod-stub" ? "read" : "not-loaded";
        const agentCount = inventory !== "read" ? null : opts.tuiFewerAgents ? 2 : 3;
        const rigs = opts.tuiMissesRig ? [] : [{ host: "local", name: "mutation-pod-stub", reachable: true, inventory, agentCount, agents: [] }];
        const readAt = new Date((o.since ?? 0) + (opts.tuiReadBeforeStep ? -1 : 1)).toISOString();
        return annotateTuiView({ ok: true, instanceId: "tui-1", view: { readAt, stale: opts.tuiStale === true, settled: true, rigs, hostsDown: [], counts: { rigs: rigs.length, agents: agentCount ?? 0 }, truncated: false } }, o.since);
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
  const agentEqualityStep = scenario.steps.findIndex((s, i) => i > equalityStep && "expect" in s && "equals" in (s.expect as object));
  const freshnessStep = scenario.steps.findIndex((s) => "expect" in s && (s.expect as { surface?: string }).surface === "tui_view");
  const seedStep = scenario.steps.findIndex((s) => "seed_regression" in s);
  const drillStep = scenario.steps.findIndex((s) => "tui" in s);
  return { result, equalityStep, seedStep, tuiStep, agentEqualityStep, freshnessStep, drillStep };
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

  it("a TUI whose view lacks the rig fails the rig-and-agents equality (R-21, o9o.172)", async () => {
    const { result, agentEqualityStep } = run({ tuiMissesRig: true });
    const r = await result;
    expect(r.verdict).toBe("FAIL");
    expect(r.failedStep).toBe(agentEqualityStep);
  });

  // verify-qa2 review (o9o.172): a TUI view counts only when fresh, and agents are compared too.
  it("a STALE snapshot with the same rigs fails the freshness leg", async () => {
    const { result, freshnessStep } = run({ tuiStale: true });
    const r = await result;
    expect(r.verdict).toBe("FAIL");
    expect(r.failedStep).toBe(freshnessStep);
  });

  it("a view last confirmed BEFORE the step began fails the freshness leg", async () => {
    const { result, freshnessStep } = run({ tuiReadBeforeStep: true });
    const r = await result;
    expect(r.verdict).toBe("FAIL");
    expect(r.failedStep).toBe(freshnessStep);
  });

  it("the same rigs with fewer agents in the TUI fails the rig-and-agents equality", async () => {
    const { result, agentEqualityStep } = run({ tuiFewerAgents: true });
    const r = await result;
    expect(r.verdict).toBe("FAIL");
    expect(r.failedStep).toBe(agentEqualityStep);
  });

  it("drills the TUI into its rig before it reads the TUI's view (so the TUI holds the rig's seats)", () => {
    const { drillStep, freshnessStep } = run({});
    expect(drillStep).toBeGreaterThanOrEqual(0);
    expect(drillStep).toBeLessThan(freshnessStep);
  });

  it("without the drill the TUI never reads the rig's seats, and the rig-and-agents equality fails", async () => {
    const { result, agentEqualityStep, drillStep } = run({ dropDrill: true });
    expect(drillStep).toBe(-1);
    const r = await result;
    expect(r.verdict).toBe("FAIL");
    expect(r.failedStep).toBe(agentEqualityStep);
  });

  it("a drill into another rig leaves this rig's seats unread, and the rig-and-agents equality fails", async () => {
    const { result, agentEqualityStep } = run({ drillOtherRig: true });
    const r = await result;
    expect(r.verdict).toBe("FAIL");
    expect(r.failedStep).toBe(agentEqualityStep);
  });
});
