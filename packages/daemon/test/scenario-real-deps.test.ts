import { describe, it, expect, vi } from "vitest";
import { buildRealDeps, UnboundActionError } from "./helpers/scenario-real-deps.js";
import type { RigResult } from "./helpers/scenario-daemon.js";

// Slice 51-02 — the REAL-DEPS adapter: it binds the dumb runner core to a live
// ScenarioDaemon. runAction maps each action verb to the SHIPPED `rig` invocation
// (the product-is-truth transport); observe binds to readSurface; the daemon verb
// drives the scenario-local daemon lifecycle (never a rig subprocess). Unbound v1
// verbs FAIL LOUD (mirrors the FLAG-1 proof-surface floor — never fabricate).

function fakeDaemon(over: Record<string, unknown> = {}) {
  return {
    readEnv: { OPENRIG_URL: "http://127.0.0.1:9", HOME: "/x" } as Record<string, string | undefined>,
    baseUrl: "http://127.0.0.1:9",
    sigterm: vi.fn(async () => {}),
    restart: vi.fn(async () => {}),
    ...over,
  };
}

const ok = (stdout = ""): RigResult => ({ code: 0, stdout, stderr: "" });

describe("buildRealDeps runAction verb->rig map", () => {
  it("maps up to `rig up <topology> --json --yes` and captures rigId/rigName", async () => {
    const calls: string[][] = [];
    const runRig = vi.fn(async (args: string[]) => { calls.push(args); return ok(JSON.stringify({ rigId: "r-1", rigName: "demo" })); });
    const deps = buildRealDeps({ daemon: fakeDaemon(), rigBin: "/bin/rig", topologyPath: "/t/spec.yaml", runRig });
    const r = await deps.runAction("up", {}, undefined);
    expect(r.code).toBe(0);
    expect(calls[0]).toEqual(["up", "/t/spec.yaml", "--json", "--yes"]);
  });

  it("appends `--cwd <seatCwd>` to up so seat writes land in scratch (no launch-cwd pollution)", async () => {
    const calls: string[][] = [];
    const runRig = vi.fn(async (args: string[]) => { calls.push(args); return ok(JSON.stringify({ rigId: "r-1", rigName: "demo" })); });
    const deps = buildRealDeps({ daemon: fakeDaemon(), rigBin: "/bin/rig", topologyPath: "/t/spec.yaml", seatCwd: "/scratch/seat", runRig });
    await deps.runAction("up", {}, undefined);
    expect(calls[0]).toEqual(["up", "/t/spec.yaml", "--json", "--yes", "--cwd", "/scratch/seat"]);
  });

  it("maps send to `rig send <to> <text> --json` (recipient from payload.to or the seat)", async () => {
    const calls: string[][] = [];
    const runRig = vi.fn(async (args: string[]) => { calls.push(args); return ok(); });
    const deps = buildRealDeps({ daemon: fakeDaemon(), rigBin: "/bin/rig", topologyPath: "/t/spec.yaml", runRig });
    await deps.runAction("send", { to: "a@r", text: "hello" }, undefined);
    expect(calls[0]).toEqual(["send", "a@r", "hello", "--json"]);
  });

  it("maps restart <seat> to `rig launch <rigId> <seat> --json` after up captured the rigId", async () => {
    const calls: string[][] = [];
    const runRig = vi.fn(async (args: string[]) => { calls.push(args); return args[0] === "up" ? ok(JSON.stringify({ rigId: "r-9", rigName: "demo" })) : ok(); });
    const deps = buildRealDeps({ daemon: fakeDaemon(), rigBin: "/bin/rig", topologyPath: "/t/spec.yaml", runRig });
    await deps.runAction("up", {}, undefined);
    await deps.runAction("restart", "seat-a", "seat-a");
    expect(calls[1]).toEqual(["launch", "r-9", "seat-a", "--json"]);
  });

  it("maps down to `rig down <rigName> --json --force` using the captured rig", async () => {
    const calls: string[][] = [];
    const runRig = vi.fn(async (args: string[]) => { calls.push(args); return args[0] === "up" ? ok(JSON.stringify({ rigId: "r-9", rigName: "demo" })) : ok(); });
    const deps = buildRealDeps({ daemon: fakeDaemon(), rigBin: "/bin/rig", topologyPath: "/t/spec.yaml", runRig });
    await deps.runAction("up", {}, undefined);
    await deps.runAction("down", {}, undefined);
    expect(calls[1]).toEqual(["down", "demo", "--json", "--force"]);
  });

  it("drives the scenario-local daemon lifecycle for the daemon verb, never a rig subprocess", async () => {
    const runRig = vi.fn(async () => ok());
    const daemon = fakeDaemon();
    const deps = buildRealDeps({ daemon, rigBin: "/bin/rig", topologyPath: "/t/spec.yaml", runRig });
    expect((await deps.runAction("daemon", { op: "sigterm" }, undefined)).code).toBe(0);
    expect(daemon.sigterm).toHaveBeenCalledOnce();
    expect((await deps.runAction("daemon", { op: "restart" }, undefined)).code).toBe(0);
    expect(daemon.restart).toHaveBeenCalledOnce();
    expect(runRig).not.toHaveBeenCalled();
  });

  it("FAILs down when no rig was brought up — no fabricated target", async () => {
    const runRig = vi.fn(async () => ok());
    const deps = buildRealDeps({ daemon: fakeDaemon(), rigBin: "/bin/rig", topologyPath: "/t/spec.yaml", runRig });
    const r = await deps.runAction("down", {}, undefined);
    expect(r.code).not.toBe(0);
    expect(runRig).not.toHaveBeenCalled();
  });

  it("throws UnboundActionError for a v1-unbound verb (restore/emit/mutate/policy/seed_regression) — fail loud", async () => {
    const runRig = vi.fn(async () => ok());
    const deps = buildRealDeps({ daemon: fakeDaemon(), rigBin: "/bin/rig", topologyPath: "/t/spec.yaml", runRig });
    await expect(deps.runAction("emit", { seat: "a@r", behavior: "restore" }, "a@r")).rejects.toBeInstanceOf(UnboundActionError);
    await expect(deps.runAction("seed_regression", { class: "x" }, undefined)).rejects.toBeInstanceOf(UnboundActionError);
    expect(runRig).not.toHaveBeenCalled();
  });

  it("exposes injectable clock/sleep and the default within/poll pair", async () => {
    const deps = buildRealDeps({ daemon: fakeDaemon(), rigBin: "/bin/rig", topologyPath: "/t/spec.yaml", now: () => 42, sleep: async () => {} });
    expect(deps.now()).toBe(42);
    expect(deps.defaults.withinMs).toBeGreaterThan(0);
    expect(deps.defaults.pollIntervalMs).toBeGreaterThan(0);
  });

  it("binds a named seed to the caller's fault controller and preserves its failure", async () => {
    const result = { code: 1, stdout: "", stderr: "fault could not be armed" };
    const seedRegression = vi.fn(async () => result);
    const runRig = vi.fn(async () => ok());
    const deps = buildRealDeps({ daemon: fakeDaemon(), rigBin: "/bin/rig", topologyPath: "/t.yaml", runRig, seedRegression });
    expect(await deps.runAction("seed_regression", { class: "baton-drop" })).toBe(result);
    expect(seedRegression).toHaveBeenCalledExactlyOnceWith("baton-drop");
    expect(runRig).not.toHaveBeenCalled();
  });

  it("rejects a malformed seed before invoking the fault controller", async () => {
    const seedRegression = vi.fn(async () => ok());
    const deps = buildRealDeps({ daemon: fakeDaemon(), rigBin: "/bin/rig", topologyPath: "/t.yaml", seedRegression });
    for (const payload of [undefined, {}, { class: "" }, { class: 42 }]) {
      expect((await deps.runAction("seed_regression", payload)).code).toBe(1);
    }
    expect(seedRegression).not.toHaveBeenCalled();
  });
});

describe("D2 — the unbound-verb message states WHY and names the v1 path", () => {
  it("emit's refusal names the missing input channel and points at env.stub_scripts", async () => {
    const deps = buildRealDeps({
      daemon: { readEnv: {}, baseUrl: "http://127.0.0.1:1", sigterm: async () => {}, restart: async () => {} },
      rigBin: "/bin/rig",
      topologyPath: "/t.yaml",
    });
    let msg = "";
    try { await deps.runAction("emit", { seat: "a@r", behavior: "compaction" }, "a@r"); } catch (e) { msg = (e as Error).message; }
    // the measured reason: the stub runner has no stdin/input channel, so a
    // step-time emit cannot be honestly bound without 51-01 source work
    expect(msg).toContain("input channel");
    // and the path that DOES work today
    expect(msg).toContain("env.stub_scripts");
    expect(msg.toLowerCase()).toContain("launch");
  });
});

// workspaces-o9o.132 (ROUTING R-12): a scenario brings up a second rig with a per-step `up: {topology: <path>}`, the path relative to the
// scenario file. The runner used to ignore it and re-up the scenario's own topology (ps-scope-honesty failed with rig_name_running).
describe("a per-step up topology (R-12)", () => {
  const upAs = (name: string, id: string) => ok(JSON.stringify({ rigId: id, rigName: name }));

  it("brings up the named topology, resolved against the scenario's folder; a plain up still brings up the scenario's own", async () => {
    const calls: string[][] = [];
    const runRig = vi.fn(async (args: string[]) => { calls.push(args); return args[1] === "/s/rig-beta.yaml" ? upAs("rig-beta", "r-b") : upAs("rig-alpha", "r-a"); });
    const deps = buildRealDeps({ daemon: fakeDaemon(), rigBin: "/bin/rig", topologyPath: "/t/rig-alpha.yaml", scenarioDir: "/s", runRig } as never);
    await deps.runAction("up", {}, undefined);
    await deps.runAction("up", { topology: "./rig-beta.yaml" }, undefined);
    expect(calls.map((c) => c.slice(0, 2))).toEqual([["up", "/t/rig-alpha.yaml"], ["up", "/s/rig-beta.yaml"]]);
  });

  it("down stops every rig the run brought up, the later one first; restart still targets the scenario's own rig", async () => {
    const calls: string[][] = [];
    const runRig = vi.fn(async (args: string[]) => { calls.push(args); return args[0] === "up" ? (args[1] === "/s/rig-beta.yaml" ? upAs("rig-beta", "r-b") : upAs("rig-alpha", "r-a")) : ok(); });
    const deps = buildRealDeps({ daemon: fakeDaemon(), rigBin: "/bin/rig", topologyPath: "/t/rig-alpha.yaml", scenarioDir: "/s", runRig } as never);
    await deps.runAction("up", {}, undefined);
    await deps.runAction("up", { topology: "./rig-beta.yaml" }, undefined);
    await deps.runAction("restart", "w", "w");
    const r = await deps.runAction("down", {}, undefined);
    expect(r.code).toBe(0);
    expect(calls.filter((c) => c[0] === "launch").map((c) => c[1])).toEqual(["r-a"]);
    expect(calls.filter((c) => c[0] === "down").map((c) => c[1])).toEqual(["rig-beta", "rig-alpha"]);
  });

  it("a per-step topology with no scenario folder to resolve it against fails loud, running nothing", async () => {
    const runRig = vi.fn(async () => ok());
    const deps = buildRealDeps({ daemon: fakeDaemon(), rigBin: "/bin/rig", topologyPath: "/t/rig-alpha.yaml", runRig });
    const r = await deps.runAction("up", { topology: "./rig-beta.yaml" }, undefined);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("per-step topology");
    expect(runRig).not.toHaveBeenCalled();
  });
});

// workspaces-o9o.132: an unbound verb says why, so host mode can report it NOT RUN with its reason.
describe("an unbound verb names why it is unbound", () => {
  it.each([
    ["seed_regression", { class: "x" }, "no seed controller"],
    ["emit", { seat: "a@r", behavior: "restore" }, "R-01"],
    ["mutate", { op: "add_member" }, "no binding"],
    ["policy", {}, "no binding"],
    ["restore", {}, "no binding"],
  ])("%s", async (verb, payload, reason) => {
    const deps = buildRealDeps({ daemon: fakeDaemon(), rigBin: "/bin/rig", topologyPath: "/t/spec.yaml", runRig: vi.fn(async () => ok()) });
    const err = await deps.runAction(verb, payload, undefined).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnboundActionError);
    expect((err as UnboundActionError & { verb: string }).verb).toBe(verb);
    expect(String((err as { reason?: unknown }).reason)).toContain(reason);
  });
});
