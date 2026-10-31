import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type HermeticScaffold } from "./helpers/hermetic-env.js";
import { installTrustedScenario, prepareTrustedHermeticEnv } from "./helpers/trusted-scaffold.js";
import { runRig, spawnScenarioDaemon, type ScenarioDaemon } from "./helpers/scenario-daemon.js";
import { findHc, startHcScratch, type HcScratch } from "./helpers/hc-scratch.js";
import { hcTerminalName, SEAT_LABEL } from "../src/adapters/hc-host.js";
import type { HcTerminal } from "../src/adapters/hc-client.js";

const here = dirname(fileURLToPath(import.meta.url));
const rigBin = resolve(here, "../../cli/dist/bin-wrapper.js");
const topology = resolve(here, "../../test-system/scenarios/dev-pair-stub.yaml");
const rigName = "dev-pair-stub";
const worker = `dev-impl@${rigName}`;
const reviewer = `dev-qa@${rigName}`;

interface RigSummary {
  rigId: string;
  rigName: string;
  lifecycleState: string;
  nodeCount: number;
  runningCount: number;
  status: string;
}

interface SeatSummary {
  canonicalSessionName: string;
  sessionStatus: string;
  intentionallyStopped?: boolean;
}

// Real CLI, daemon, SQLite, and a private hc core; no provider credentials.
// The YAML scenario DSL has no seat-stop verb, so drive that shipped command
// through the same hermetic harness used by the scenario runner.
describe.runIf(findHc() !== null)("intentional seat stop CLI journey", () => {
  let core: HcScratch | undefined;
  let scaffold: HermeticScaffold | undefined;
  let daemon: ScenarioDaemon | undefined;
  let launched = false;
  let reviewerCrashed = false;

  async function cli<T>(args: string[], timeoutMs = 30_000): Promise<T> {
    const result = await runRig(args, daemon!.readEnv, rigBin, timeoutMs);
    expect(result.code, JSON.stringify({ args, ...result })).toBe(0);
    return JSON.parse(result.stdout) as T;
  }

  async function summary(): Promise<RigSummary> {
    const rigs = await cli<RigSummary[]>(["ps", "--json"]);
    return rigs.find((rig) => rig.rigName === rigName)!;
  }

  async function reviewerSummary(): Promise<SeatSummary> {
    const seats = await cli<SeatSummary[]>(["ps", "--nodes", "--rig", rigName, "--json"]);
    return seats.find((seat) => seat.canonicalSessionName === reviewer)!;
  }

  /** The seats with a live terminal on the private core, by canonical name. */
  async function sessions(): Promise<string[]> {
    const { terminals } = await core!.client().call<{ terminals: HcTerminal[] }>("terminal.list", {});
    return terminals.filter((t) => t.state === "live" && t.labels[SEAT_LABEL]).map((t) => t.labels[SEAT_LABEL]!).sort();
  }

  beforeAll(async () => {
    core = startHcScratch();
    scaffold = prepareTrustedHermeticEnv({ baseEnv: { PATH: process.env.PATH, TERM: "xterm-256color" } });
    // The daemon and its CLI find the seat host by these, as a daemon finds it in production.
    Object.assign(scaffold.env, { HC_SESSION: core.session, XDG_RUNTIME_DIR: core.env.XDG_RUNTIME_DIR, HC_SOCKET: core.socketPath });
    daemon = await spawnScenarioDaemon(scaffold, { rigBin });
    const cwd = join(scaffold.root, "project");
    mkdirSync(cwd);
    await cli(["up", installTrustedScenario(scaffold, topology), "--cwd", cwd, "--json", "--yes"], 120_000);
    launched = true;
  }, 120_000);

  afterAll(async () => {
    if (!daemon) { scaffold?.cleanup(); core?.cleanup(); return; }
    try {
      // Clear the crashed row while its sibling still keeps the seat host busy.
      if (reviewerCrashed) await cli(["seat", "clean", reviewer, "--reason", "fixture crash cleanup", "--json"]);
      if (launched) await cli(["down", rigName, "--json", "--force"]);
    } finally {
      try { await daemon.stop(); } finally { core?.cleanup(); }
    }
  }, 60_000);

  it("persists an intentional stop across daemon restart, then detects a fresh occupant's crash", async () => {
    const initial = await summary();
    expect(initial).toMatchObject({ lifecycleState: "running", nodeCount: 2, runningCount: 2 });
    expect(await sessions()).toEqual([worker, reviewer].sort());
    const snapshot = await runRig(["snapshot", initial.rigId], daemon!.readEnv, rigBin);
    expect(snapshot.code, JSON.stringify(snapshot)).toBe(0);

    const stopped = await cli<{ sessionId: string }>([
      "seat", "stop", reviewer, "--reason", "review runs on demand", "--json",
    ]);
    expect(await sessions()).toEqual([worker]);
    expect(await summary()).toMatchObject({
      lifecycleState: "running", status: "partial", nodeCount: 2, runningCount: 1,
    });
    expect(await reviewerSummary()).toMatchObject({ sessionStatus: "exited", intentionallyStopped: true });

    for (const selection of [["--last"], ["--rigs", rigName]]) {
      const start = await runRig(["start", ...selection, "--json"], daemon!.readEnv, rigBin);
      expect(start.code, JSON.stringify({ selection, ...start })).toBe(1);
      const result = JSON.parse(start.stdout);
      expect(result.candidates).toEqual([{ rigName, lifecycleState: "degraded" }]);
      expect(result.restoredRigs).toEqual([{ rigName, status: "rig_not_stopped", nodes: [] }]);
      expect(await sessions()).toEqual([worker]);
    }

    await daemon!.restart();
    expect(await sessions()).toEqual([worker]);
    expect(await summary()).toMatchObject({ lifecycleState: "running", runningCount: 1 });
    expect(await reviewerSummary()).toMatchObject({ sessionStatus: "exited", intentionallyStopped: true });

    const fresh = await cli<{ sessionId: string }>([
      "seat", "launch", reviewer, "--fresh", "--reason", "next review", "--json",
    ], 120_000);
    expect(fresh.sessionId).toBeTruthy();
    expect(fresh.sessionId).not.toBe(stopped.sessionId);
    expect(await sessions()).toEqual([worker, reviewer].sort());
    expect(await reviewerSummary()).toMatchObject({ sessionStatus: "running", intentionallyStopped: false });
    expect(await summary()).toMatchObject({ lifecycleState: "running", status: "running", runningCount: 2 });

    // Kill only the new reviewer's terminal on our private core, without a supported stop.
    await core!.client().call("terminal.kill", { terminal: hcTerminalName(reviewer) });
    reviewerCrashed = true;
    await expect.poll(summary, { timeout: 30_000 }).toMatchObject({
      lifecycleState: "degraded", status: "partial", runningCount: 1,
    });
    expect(await sessions()).toEqual([worker]);
    expect((await reviewerSummary()).intentionallyStopped).toBe(false);
  }, 180_000);
});
