// pda runtime L2a, end to end inside the test process: the pda RuntimeAdapter (L2a) launching and reading the REAL
// PdaRunner (L1b) with the REAL client and outbox (L1a) against L1a's faithful fake pda, and the runner's usage sink
// (L2a) posting to the REAL /api/activity/pda-usage route (L2c). The pane is a fake tmux: "typing" the runner command
// starts the in-process runner the command names. No real pda, tmux, daemon or seat is touched.

import { afterEach, describe, expect, it } from "vitest";
import { BEARER, HOOK_TOKEN, makeRig, waitFor, type Rig } from "./helpers/pda-runner-rig.js";
import { buildPdaRunnerArgv } from "../src/adapters/pda-runner-protocol.js";
import { assistantEntry, messageEnd, runEnd, runStart, snapshotEvent } from "./helpers/pda-real-shapes.js";
import { spawn } from "node:child_process";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
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

// ── Gap-filled entries (review section 8): what the runner recovers after a reconnect is posted too ─────────────

describe("the usage sink: entries recovered by a gap fill reach the route, once, with honest attribution", () => {
  async function scriptedUsageRig() {
    const app = pdaUsageApp({ setting: true });
    let owner: { isOwnSubmission(id: string): boolean } | null = null;
    const sink = createPdaUsageSink({
      sessionName: PDA_SEAT, nodeId: PDA_NODE, generation: "gen-7", agent: "research",
      isOwnSubmission: (id) => owner?.isOwnSubmission(id) ?? false,
      post: createPdaUsagePoster({ baseUrl: "http://daemon.invalid", token: PDA_USAGE_TOKEN },
        (async (input: string | URL | Request, init?: RequestInit) => app.hono.request(new URL(String(input)).pathname, init)) as typeof fetch),
    });
    rig = await makeRig({ usage: sink, usageFacts: true });
    owner = rig.runner;
    void rig.start();
    return { app, sink };
  }

  it("an entry produced while the runner was detached is posted once, origin unknown; a later reconnect posts nothing more", async () => {
    const { app, sink } = await scriptedUsageRig();
    const s1 = await rig!.stream(1);
    s1.push(snapshotEvent());
    await waitFor(() => rig!.pane().includes("READY"), "attach");
    rig!.scripted.transcript = [assistantEntry(7, "made while detached")];
    s1.end();
    const s2 = await rig!.stream(2);
    s2.push(snapshotEvent());
    await waitFor(() => rig!.pane().includes("made while detached"), "the gap fill to print it");
    await waitFor(() => app.rows().length === 1, "the gap-filled entry to be stored");
    await sink.settled();
    expect(app.rows().map((r) => [r.entry_id, r.origin])).toEqual([["7", "unknown"]]);
    s2.end();
    const s3 = await rig!.stream(3);
    s3.push(snapshotEvent());
    await waitFor(() => (rig!.pane().match(/reconnected/g) ?? []).length >= 2, "the second reconnect");
    await sink.settled();
    expect(app.rows()).toHaveLength(1);
    expect(sink.pending()).toEqual([]);
  });

  it("an entry the gap fill printed during this seat's own run, then seen live, settles to own (unknown is upgraded, never doubled)", async () => {
    const { app, sink } = await scriptedUsageRig();
    const s1 = await rig!.stream(1);
    s1.push(snapshotEvent());
    await waitFor(() => rig!.pane().includes("READY"), "attach");
    rig!.runner.submit("mine");
    await waitFor(() => rig!.pane().includes("queued (submission"), "the ack");
    const submissionId = rig!.fake.entries("research")[0]!.submissionId;
    s1.push(runStart([submissionId]));
    rig!.scripted.transcript = [assistantEntry(20, "reply printed by an overflow resync")];
    s1.push(snapshotEvent({ run: [submissionId] })); // an overflow snapshot mid-run: the gap fill prints entry 20
    await waitFor(() => rig!.pane().includes("reply printed by an overflow resync"), "the gap fill");
    s1.push(messageEnd(assistantEntry(20, "reply printed by an overflow resync")));
    s1.push(runEnd([submissionId]));
    await waitFor(() => rig!.pane().includes("── idle ──"), "run end");
    await waitFor(() => app.rows().length === 1 && app.rows()[0]!.origin === "own", "the entry to settle as own");
    await sink.settled();
    expect(app.rows().map((r) => [r.entry_id, r.origin])).toEqual([["20", "own"]]);
  });
});

// ── The real process: main() installs the sink only with --usage-facts, and it posts with the hook token ─────────

const RUNNER_TS = fileURLToPath(new URL("../src/adapters/pda-runner.ts", import.meta.url));

describe("the real runner process (node --import tsx) posts usage facts only with --usage-facts", () => {
  it.each([true, false])("--usage-facts %s: own run -> one pda-usage post with the hook token (and none without the flag)", async (usageFacts) => {
    const posts: Array<{ url: string | undefined; auth: string | undefined; body: Record<string, unknown> }> = [];
    const daemon = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        if (req.url === "/api/activity/pda-usage") posts.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(raw || "{}") as Record<string, unknown> });
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise<void>((resolve) => daemon.listen(0, "127.0.0.1", resolve));
    rig = await makeRig({ realStreams: true });
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "pda-l2a-proc-"));
    const argv = buildPdaRunnerArgv({
      sessionName: rig.args.sessionName, stateRoot: rig.args.stateRoot, launchId: "proc-usage",
      binding: { agent: "research", baseUrl: rig.args.baseUrl }, tokenFile: rig.args.tokenFile, usageFacts,
    });
    const child = spawn(process.execPath, ["--import", "tsx", RUNNER_TS, ...argv], {
      env: {
        PATH: process.env.PATH ?? "", HOME: home, OPENRIG_HOME: home, OPENRIG_NODE_ID: "proc-node", OPENRIG_ACTIVITY_HOOK_TOKEN: HOOK_TOKEN,
        OPENRIG_URL: `http://127.0.0.1:${(daemon.address() as AddressInfo).port}`,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c) => { out += c.toString(); });
    const exit = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    try {
      await waitFor(() => out.includes("[pda-runner] READY agent=research"), "READY", 20000);
      child.stdin.write("count my usage\n");
      await waitFor(() => out.includes("queued (submission"), "the ack", 10000);
      rig.fake.streamReply("research", ["usage reply"]);
      await waitFor(() => out.includes("── idle ──"), "the run to end", 10000);
      if (usageFacts) {
        await waitFor(() => posts.length >= 1, "a pda-usage post", 10000);
        expect(posts[0]).toMatchObject({ auth: `Bearer ${HOOK_TOKEN}`, body: { sessionName: rig.args.sessionName, nodeId: "proc-node", agent: "research" } });
        expect((posts[0]!.body.facts as Array<Record<string, unknown>>).map((f) => [f.origin, f.costBasis])).toEqual([["own", "declared_zero_price"]]);
        expect(JSON.stringify(posts)).not.toContain(BEARER);
      } else {
        await new Promise((r) => setTimeout(r, 300));
        expect(posts).toEqual([]);
      }
    } finally {
      child.kill("SIGTERM");
      await exit;
      await new Promise<void>((resolve) => daemon.close(() => resolve()));
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 60000);
});
