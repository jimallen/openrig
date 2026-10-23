// pda runtime L2a, end to end inside the test process: the pda RuntimeAdapter (L2a) launching and reading the REAL
// PdaRunner (L1b) with the REAL client and outbox (L1a) against L1a's faithful fake pda, and the runner's usage sink
// (L2a) posting to the REAL /api/activity/pda-usage route (L2c). The pane is a fake tmux: "typing" the runner command
// starts the in-process runner the command names. No real pda, tmux, daemon or seat is touched.

import { afterEach, describe, expect, it } from "vitest";
import { makeRig, waitFor, type Rig } from "./helpers/pda-runner-rig.js";
import { PdaRuntimeAdapter } from "../src/adapters/pda-runtime-adapter.js";
import { createPdaUsagePoster, createPdaUsageSink, type PdaUsageReporter } from "../src/adapters/pda-usage-sink.js";
import { pdaUsageApp, PDA_NODE, PDA_SEAT, PDA_USAGE_TOKEN } from "./helpers/pda-usage-route.js";
import fs from "node:fs";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";

let rig: Rig | null = null;
afterEach(async () => { await rig?.cleanup(); rig = null; });

function seatAdapter(r: Rig, commands: string[]) {
  return new PdaRuntimeAdapter({
    tmux: {
      sendShellCommand: async (_t: string, command: string) => {
        commands.push(command);
        // The command names the runner's argv; the in-process runner was built from the same values.
        expect(command).toContain(`--launch-id '${r.args.launchId}'`);
        void r.start();
        return { ok: true as const };
      },
      hasSession: async () => true,
      getPaneCommand: async () => "node",
      capturePaneContent: async () => r.pane(),
    } as never,
    fsOps: {
      readFile: (p) => fs.readFileSync(p, "utf8"),
      exists: (p) => fs.existsSync(p),
      lstat: (p) => { try { return { isFile: fs.lstatSync(p).isFile() }; } catch { return null; } },
    },
    stateRoot: r.args.stateRoot,
    runnerEntryPath: "/dist/adapters/pda-runner.js",
    tokenFile: () => r.args.tokenFile,
    newLaunchId: () => r.args.launchId,
    pollMs: 5, launchWaitMs: 5000,
  });
}

const bindingFor = (r: Rig): NodeBinding => ({
  id: "b", nodeId: r.args.nodeId, tmuxSession: r.args.sessionName, tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null,
  cmuxSurface: null, updatedAt: "", cwd: "/w", pda: { agent: r.args.agent, baseUrl: r.args.baseUrl },
});

describe("the pda adapter driving the real runner against the fake pda", () => {
  it("launch reaches READY from the runner's own sidecar; send readiness follows the runner: idle, running, idle", async () => {
    rig = await makeRig({ realStreams: true });
    const commands: string[] = [];
    const adapter = seatAdapter(rig, commands);
    const launched = await adapter.launchHarness(bindingFor(rig), { name: rig.args.sessionName });
    expect(launched).toEqual({ ok: true, resumeToken: `${rig.args.baseUrl}/agents/research`, resumeType: "pda_agent" });
    expect(commands).toHaveLength(1);
    expect(rig.pane()).toContain("[pda-runner] READY agent=research");
    expect(await adapter.checkReady(bindingFor(rig))).toEqual({ ready: true });
    const ask = () => adapter.sendReadiness({ sessionName: rig!.args.sessionName, nodeId: rig!.args.nodeId });
    expect(await ask()).toMatchObject({ state: "idle", reason: "runner_idle", evidenceSource: "runner_sidecar" });
    rig.fake.emit("research", { type: "run_start", inputs: [] });
    await waitFor(() => rig!.sidecar().busy, "the runner to record the run");
    expect(await ask()).toMatchObject({ state: "running", reason: "run_active" });
    rig.fake.emit("research", { type: "run_end", inputs: [] });
    await waitFor(() => !rig!.sidecar().busy, "the run to end");
    expect(await ask()).toMatchObject({ state: "idle" });
    // Launch and readiness made no write to pda: the only requests are the runner's attach.
    expect(rig.fake.requests.filter((r) => r.method !== "GET")).toEqual([]);
  });

  it("a missing agent: the runner stops itself (exit 3) and the launch is attention_required with the pane as evidence", async () => {
    rig = await makeRig({ realStreams: true, agent: "ghost", agents: ["research"] });
    const adapter = seatAdapter(rig, []);
    const result = await adapter.launchHarness(bindingFor(rig), { name: rig.args.sessionName });
    expect(result).toMatchObject({ ok: false, recovery: "attention_required", error: expect.stringContaining("code 3"), evidence: expect.stringContaining("pda_agent_missing") });
    expect(await adapter.checkReady({ ...bindingFor(rig) })).toMatchObject({ ready: false, code: "pda_agent_missing" });
    // OpenRig never creates an agent.
    expect(rig.fake.requests.filter((r) => r.method === "POST")).toEqual([]);
  });
});

describe("the usage sink: the real runner's facts reach the real /pda-usage route", () => {
  async function usageRig(): Promise<{ app: ReturnType<typeof pdaUsageApp>; sink: PdaUsageReporter }> {
    const app = pdaUsageApp({ setting: false });
    let owner: { isOwnSubmission(id: string): boolean } | null = null;
    const sink = createPdaUsageSink({
      sessionName: PDA_SEAT, nodeId: PDA_NODE, generation: "gen-7", agent: "research",
      isOwnSubmission: (id) => owner?.isOwnSubmission(id) ?? false,
      post: createPdaUsagePoster({ baseUrl: "http://daemon.invalid", token: PDA_USAGE_TOKEN },
        (async (input: string | URL | Request, init?: RequestInit) => app.hono.request(new URL(String(input)).pathname, init)) as typeof fetch),
    });
    rig = await makeRig({ realStreams: true, usage: sink, usageFacts: true });
    owner = rig.runner;
    void rig.start();
    await waitFor(() => rig!.pane().includes("READY"), "the runner to attach");
    return { app, sink };
  }

  it("own run: kept on 503 (setting off), stored once on the next run_end after it is on; NULL cost, declared_zero_price", async () => {
    const { app, sink } = await usageRig();
    rig!.runner.submit("please answer");
    await waitFor(() => rig!.fake.entries("research").length === 1 && rig!.pane().includes("queued (submission"), "the message to be admitted");
    rig!.fake.streamReply("research", ["hello ", "there"]);
    await waitFor(() => rig!.pane().includes("── idle ──"), "the run to end");
    await sink.settled();
    expect(app.rows()).toEqual([]);                  // 503: nothing stored ...
    expect(sink.pending()).toHaveLength(1);           // ... and the fact is kept
    expect(sink.pending()[0]).toMatchObject({ origin: "own", costTotal: null, costBasis: "declared_zero_price", input: 1, output: 1 });

    app.setSetting(true);
    rig!.fake.streamReply("research", ["again"]);
    await waitFor(() => (rig!.pane().match(/── idle ──/g) ?? []).length === 2, "the second run to end");
    await sink.settled();
    expect(sink.pending()).toEqual([]);
    const rows = app.rows();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.origin)).toEqual(["own", "own"]);
    expect(rows.every((r) => r.cost_total === null && r.cost_basis === "declared_zero_price")).toBe(true);
    expect(rows.every((r) => r.seat_session === PDA_SEAT && r.agent === "research")).toBe(true);
    expect(sink.dropped()).toBe(0);
  });

  it("a run that took only another client's input is 'other'; usage facts carry no text", async () => {
    const { app, sink } = await usageRig();
    app.setSetting(true);
    rig!.fake.injectOtherClientMessage("research", "from the laptop: SECRET-TEXT-CANARY");
    rig!.fake.streamReply("research", ["REPLY-TEXT-CANARY"]);
    await waitFor(() => rig!.pane().includes("── idle ──"), "the run to end");
    await sink.settled();
    const rows = app.rows();
    expect(rows.map((r) => r.origin)).toEqual(["other"]);
    expect(JSON.stringify(rows)).not.toMatch(/CANARY/);
  });
});
