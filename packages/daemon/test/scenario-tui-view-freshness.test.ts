// workspaces-o9o.172 review (verify-qa2; CoS decision A): a TUI view must be FRESH to count, and agents are compared too. The runner hands each
// surface read the time its expect began; the tui_view reader marks view.confirmedDuringStep when the TUI's own readAt is at or after that
// (the runner and the TUI read one wall clock: same host; the scenario clock injection reaches only the daemon). A `join` projection lets an
// equality compare "rig/agent count" pairs (ps nodeCount vs the TUI's agentCount).
import { describe, expect, it } from "vitest";
import { validateScenario } from "./helpers/scenario-schema.js";
import { runValidatedScenario, type ActionResult } from "./helpers/scenario-runner.js";
import { annotateTuiView } from "./helpers/scenario-surfaces.js";
import { projectSurface, ProjectionError } from "./helpers/scenario-normalizer.js";

const ok: ActionResult = { code: 0, stdout: "", stderr: "" };

describe("the runner hands each surface read its expect's start time", () => {
  it("an expect's reads carry since = the runner clock when that expect began", async () => {
    const seen: Array<number | undefined> = [];
    let t = 1_000;
    const scenario = (validateScenario({ scenario: "s", topology: "./t.yaml", steps: [
      { up: {} },
      { expect: { surface: "ps", within: "1s", match: { ok: true } } },
    ] }) as { ok: true; scenario: never }).scenario;
    await runValidatedScenario(scenario, {
      runAction: async () => ok,
      observe: async (_surface, o) => { seen.push(o.since); return { ok: true }; },
      now: () => (t += 500), sleep: async () => {}, defaults: { withinMs: 1000, pollIntervalMs: 100 },
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((v) => v === 1_500)).toBe(true);
  });
});

describe("an equals expect's reads carry the same since", () => {
  it("every surface an equality reads is handed the runner clock when that expect began", async () => {
    const seen: Array<[string, number | undefined]> = [];
    let t = 1_000;
    const scenario = (validateScenario({ scenario: "s", topology: "./t.yaml", steps: [
      { up: {} },
      { expect: { surface: "ps", within: "1s", equals: { ps: { pluck: "name" }, queue: { pluck: "destinationSession", rig: true } } } },
    ] }) as { ok: true; scenario: never }).scenario;
    await runValidatedScenario(scenario, {
      runAction: async () => ok,
      observe: async (surface, o) => { seen.push([surface, o.since]); return surface === "ps" ? [{ name: "r" }] : [{ destinationSession: "a@r" }]; },
      now: () => (t += 500), sleep: async () => {}, defaults: { withinMs: 1000, pollIntervalMs: 100 },
    });
    expect(seen.map(([s]) => s).sort()).toEqual(["ps", "queue"]);
    expect(seen.every(([, v]) => v === 1_500)).toBe(true);
  });
});

describe("the tui_view reader marks a view confirmed during the step", () => {
  const reply = (readAt: string | null) => ({ ok: true, instanceId: "t", view: { readAt, stale: false, settled: true, rigs: [] } });
  const since = Date.parse("2026-11-18T18:00:00.000Z");
  it.each([
    ["read at the step's start", "2026-11-18T18:00:00.000Z", true],
    ["read after it", "2026-11-18T18:00:05.000Z", true],
    ["read before it", "2026-11-18T17:59:59.999Z", false],
    ["never read", null, false],
  ])("%s -> %s", (_name, readAt, want) => {
    expect((annotateTuiView(reply(readAt), since) as { view: { confirmedDuringStep: boolean } }).view.confirmedDuringStep).toBe(want);
  });
  it("with no step start, the reply is returned unchanged", () => {
    const r = reply("2026-11-18T18:00:00.000Z");
    expect(annotateTuiView(r, undefined)).toEqual(r);
  });
});

describe("a join projection compares field pairs", () => {
  it("joins two fields with '/' (numbers as text), as a sorted set", () => {
    expect(projectSurface([{ name: "b", nodeCount: 3 }, { name: "a", nodeCount: 2 }], { join: ["name", "nodeCount"] })).toEqual(["a/2", "b/3"]);
    expect(projectSurface({ view: { rigs: [{ name: "a", agentCount: 2 }] } }, { path: "view.rigs", join: ["name", "agentCount"] })).toEqual(["a/2"]);
  });
  it("a field that is present but null joins as 'null' (an observation that equals no count), never as a broken declaration", () => {
    // A rig whose seats the TUI has not read carries agentCount null; that must FAIL an equality with ps, not crash the run.
    expect(projectSurface({ view: { rigs: [{ name: "a", agentCount: null }] } }, { path: "view.rigs", join: ["name", "agentCount"] }, "tui_view"))
      .toEqual(["a/null"]);
  });
  it("a join that extracts nothing from real data is a broken declaration, not agreement", () => {
    expect(() => projectSurface([{ name: "a" }], { join: ["name", "nodeCount"] }, "ps")).toThrow(ProjectionError);
  });
  it("the validator accepts join (two or more field names) and refuses it with pluck, or malformed", () => {
    const steps = (proj: unknown) => [{ expect: { surface: "ps", equals: { ps: proj, queue: { pluck: "destinationSession", rig: true } } } }];
    expect(validateScenario({ scenario: "s", topology: "./t.yaml", steps: steps({ join: ["name", "nodeCount"] }) }).ok).toBe(true);
    expect(validateScenario({ scenario: "s", topology: "./t.yaml", steps: steps({ join: ["name", "nodeCount"], pluck: "name" }) }).ok).toBe(false);
    expect(validateScenario({ scenario: "s", topology: "./t.yaml", steps: steps({ join: ["name"] }) }).ok).toBe(false);
    expect(validateScenario({ scenario: "s", topology: "./t.yaml", steps: steps({ join: "name" }) }).ok).toBe(false);
  });
});
