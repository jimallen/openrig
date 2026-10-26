// OF-93: the pda usage sink at runner stop, and its answer-status table.
//   (a) facts still pending when the runner exits were lost: nothing flushed on stop, nothing persisted.
//   (b) every non-503 4xx dropped its facts for good, though 408 and 429 are transient.
//   (c) the dropped counter counted one fact more than once.
// Fakes only: a fake fetch / the real /pda-usage route over an in-memory db, and a temp directory per row.

import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPdaUsagePoster, createPdaUsageSink, type PdaUsagePostResult } from "../src/adapters/pda-usage-sink.js";
import type { PdaUsagePayload } from "../src/adapters/pda-runner-protocol.js";
import { assistantEntry, makeRig, waitFor, type Rig } from "./helpers/pda-runner-rig.js";
import { pdaUsageApp, PDA_NODE, PDA_SEAT, PDA_USAGE_TOKEN } from "./helpers/pda-usage-route.js";

const priced = (id: number) => assistantEntry(id, "TEXT", {
  usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 18, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } },
});
const unbuildable = (id: number) => assistantEntry(id, "TEXT", { usage: { input: 1.5, output: 1, cacheRead: 0, cacheWrite: 0 } });

const dirs: string[] = [];
const tmp = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "of93-")); dirs.push(d); return d; };
let rig: Rig | null = null;
afterEach(async () => {
  await rig?.cleanup(); rig = null;
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const endpoint = { baseUrl: "http://127.0.0.1:7433", token: "hook-tok" };
const fetchWith = (status: number): typeof fetch => (async () => new Response("{}", { status })) as unknown as typeof fetch;
const fetchThrowing: typeof fetch = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;

function sinkOver(post: (p: PdaUsagePayload) => Promise<PdaUsagePostResult>, extra: { spillPath?: string; maxPending?: number; log?: (l: string) => void } = {}) {
  return createPdaUsageSink({ sessionName: "seat@rig", nodeId: "n1", generation: "g1", agent: "research", isOwnSubmission: () => true, post, ...extra });
}
const runOne = async (s: ReturnType<typeof sinkOver>, id: number) => {
  s.onRunStart!({ type: "run_start", inputs: [1] } as never);
  s.onAssistantEntry!(priced(id));
  s.onRunEnd!({ type: "run_end", inputs: [1] } as never);
  await s.settled();
};

describe("(b) the answer-status table: transient statuses keep the fact for a retry, permanent ones drop it with a counted reason", () => {
  // One row per status. The expectation is the decision: keep (still pending, nothing dropped) or drop (gone, counted once, reason).
  const KEEP: Array<[string, number]> = [["request timeout", 408], ["too many requests", 429], ["service unavailable", 503], ["internal error", 500], ["bad gateway", 502]];
  const DROP: Array<[string, number]> = [["bad request", 400], ["unauthorized", 401], ["forbidden", 403], ["not found", 404], ["payload too large", 413], ["unprocessable", 422]];

  it.each(KEEP)("%s (%i) keeps the fact pending and drops nothing", async (_n, status) => {
    const lines: string[] = [];
    const s = sinkOver(createPdaUsagePoster(endpoint, fetchWith(status)), { log: (l) => lines.push(l) });
    await runOne(s, 1);
    expect(s.pending().map((f) => f.entryId)).toEqual(["1"]);
    expect(s.dropped()).toBe(0);
    expect(s.droppedReasons()).toEqual({});
    expect(lines).toEqual([]);
  });

  it.each(DROP)("%s (%i) drops the fact once, with its http_ reason, logged", async (_n, status) => {
    const lines: string[] = [];
    const s = sinkOver(createPdaUsagePoster(endpoint, fetchWith(status)), { log: (l) => lines.push(l) });
    await runOne(s, 1);
    expect(s.pending()).toEqual([]);
    expect(s.dropped()).toBe(1);
    expect(s.droppedReasons()).toEqual({ [`http_${status}`]: 1 });
    expect(lines).toEqual([`[pda-runner] usage facts dropped: reason=http_${status} count=1`]);
  });

  it("a network error keeps the fact pending", async () => {
    const s = sinkOver(createPdaUsagePoster(endpoint, fetchThrowing));
    await runOne(s, 1);
    expect(s.pending()).toHaveLength(1);
    expect(s.dropped()).toBe(0);
  });

  it("the poster names the decision per status: 2xx stored, 408/429/503/5xx keep, the permanent four-hundreds refuse with their status", async () => {
    const payload = { sessionName: "s", agent: "a", facts: [] } as PdaUsagePayload;
    expect(await createPdaUsagePoster(endpoint, fetchWith(200))(payload)).toBe("stored");
    for (const status of [408, 429, 503, 500, 599]) expect(await createPdaUsagePoster(endpoint, fetchWith(status))(payload)).toBe("keep");
    for (const status of [400, 401, 403, 404, 413, 422]) expect(await createPdaUsagePoster(endpoint, fetchWith(status))(payload)).toEqual({ outcome: "refused", status });
  });

  it("a decision derived from the status, not constant: 429 then 404 in one sink retries the first and drops the second", async () => {
    const statuses = [429, 404];
    const s = sinkOver(createPdaUsagePoster(endpoint, (async () => new Response("{}", { status: statuses.shift()! })) as unknown as typeof fetch));
    await runOne(s, 1);
    expect(s.pending()).toHaveLength(1);
    await runOne(s, 2);
    expect(s.pending()).toEqual([]);
    expect(s.droppedReasons()).toEqual({ http_404: 2 }); // fact 1 was kept by the 429 and rides the 404 batch with fact 2
    expect(s.dropped()).toBe(2);
  });
});

describe("(c) the dropped counter counts a fact once", () => {
  it("an entry the sink cannot build, seen live and again by a gap fill, is one drop", () => {
    const s = sinkOver(async () => "stored");
    s.onAssistantEntry!(unbuildable(5));
    s.onGapEntry!(unbuildable(5));
    expect(s.dropped()).toBe(1);
    expect(s.droppedReasons()).toEqual({ unbuildable: 1 });
    s.onGapEntry!(unbuildable(6));
    expect(s.dropped()).toBe(2);
    s.onAssistantEntry!(unbuildable(7));
    expect(s.dropped()).toBe(3);
  });

  it("a fact the daemon refused and the stream replays, refused again, is one drop", async () => {
    const s = sinkOver(async () => "refused");
    await runOne(s, 1);
    await runOne(s, 1);
    expect(s.dropped()).toBe(1);
    expect(s.droppedReasons()).toEqual({ refused: 1 });
  });

  it("a fact pushed out past the bound and replayed past it again is one drop", () => {
    const s = sinkOver(async () => "keep", { maxPending: 1 });
    s.onGapEntry!(priced(1));
    s.onGapEntry!(priced(2)); // 1 out
    s.onGapEntry!(priced(1)); // 1 back, 2 out
    s.onGapEntry!(priced(2)); // 2 back, 1 out again
    expect(s.droppedReasons()).toEqual({ pending_overflow: 2 });
    expect(s.dropped()).toBe(2);
  });
});

describe("(a) facts pending when the runner stops", () => {
  it("close() posts what is pending once more: a kept fact the daemon now takes is stored, nothing is left", async () => {
    const answers: PdaUsagePostResult[] = ["keep", "stored"];
    const posts: number[] = [];
    const s = sinkOver(async (p) => { posts.push(p.facts.length); await new Promise((r) => setTimeout(r, 25)); return answers.shift() ?? "stored"; });
    await runOne(s, 1);
    expect(s.pending()).toHaveLength(1);
    await s.close();
    expect(posts).toEqual([1, 1]);
    expect(s.pending()).toEqual([]);
  });

  it("close() twice (the run loop's finally, then main's backstop) posts once and persists once", async () => {
    const spillPath = path.join(tmp(), "usage-pending.json");
    let posts = 0;
    const s = sinkOver(async () => { posts += 1; return "keep"; }, { spillPath });
    await runOne(s, 1);
    expect(posts).toBe(1);
    await s.close(50);
    expect(posts).toBe(2);                        // the close flush, once
    fs.rmSync(spillPath);
    await s.close(50);
    expect(posts).toBe(2);
    expect(fs.existsSync(spillPath)).toBe(false); // the second close wrote nothing
  });

  it("close() waits only the budget for a daemon that never answers, then returns with the fact still pending", async () => {
    const s = sinkOver(() => new Promise<PdaUsagePostResult>(() => undefined));
    s.onAssistantEntry!(priced(1));
    const t0 = Date.now();
    await s.close(60);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(s.pending()).toHaveLength(1);
  });

  it("what is still unsent after the wait is persisted to the spill file; the next start loads it and sends it, once", async () => {
    const spillPath = path.join(tmp(), "usage-pending.json");
    const first = sinkOver(async () => "keep", { spillPath });
    await runOne(first, 1);
    await first.close(50);
    expect(fs.existsSync(spillPath)).toBe(true);
    expect(fs.statSync(spillPath).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(`${spillPath}.tmp`)).toBe(false);

    const sent: string[][] = [];
    const second = sinkOver(async (p) => { sent.push(p.facts.map((f) => f.entryId)); return "stored"; }, { spillPath });
    expect(second.pending().map((f) => f.entryId)).toEqual(["1"]);
    second.flush!();
    await second.settled();
    expect(sent).toEqual([["1"]]);
    await second.close();
    expect(fs.existsSync(spillPath)).toBe(false); // nothing left to carry
  });

  it("a spill file that is unreadable or holds a fact L0 refuses is skipped, never fatal, and never sent", () => {
    const spillPath = path.join(tmp(), "usage-pending.json");
    fs.writeFileSync(spillPath, "{not json");
    expect(sinkOver(async () => "stored", { spillPath }).pending()).toEqual([]);
    fs.writeFileSync(spillPath, JSON.stringify({ v: 1, facts: [{ conversationId: "1", entryId: "1" }] }));
    expect(sinkOver(async () => "stored", { spillPath }).pending()).toEqual([]);
  });

  it("end to end: the real runner stopped while the daemon had the setting off persists the fact; the next runner start stores it once", async () => {
    const app = pdaUsageApp({ setting: false });
    const dir = tmp();
    const spillPath = path.join(dir, "usage-pending.json");
    const fetchApp = (async (input: string | URL | Request, init?: RequestInit) => app.hono.request(new URL(String(input)).pathname, init)) as typeof fetch;
    const mkSink = () => {
      let owner: { isOwnSubmission(id: string): boolean } | null = null;
      const sink = createPdaUsageSink({
        sessionName: PDA_SEAT, nodeId: PDA_NODE, generation: "gen-7", agent: "research", spillPath,
        isOwnSubmission: (id) => owner?.isOwnSubmission(id) ?? false,
        post: createPdaUsagePoster({ baseUrl: "http://daemon.invalid", token: PDA_USAGE_TOKEN }, fetchApp),
      });
      return { sink, own: (r: { isOwnSubmission(id: string): boolean }) => { owner = r; } };
    };

    const a = mkSink();
    rig = await makeRig({ realStreams: true, usage: a.sink, usageFacts: true });
    a.own(rig.runner);
    const done = rig.start();
    await waitFor(() => rig!.pane().includes("READY"), "the runner to attach");
    rig.runner.submit("please answer");
    await waitFor(() => rig!.fake.entries("research").length === 1 && rig!.pane().includes("queued (submission"), "admitted");
    rig.fake.streamReply("research", ["hello"]);
    await waitFor(() => rig!.pane().includes("── idle ──"), "the run to end");
    await a.sink.settled();
    expect(app.rows()).toEqual([]);
    rig.runner.stop();
    expect(await done).toBe(0);
    expect(app.rows()).toEqual([]);                       // the setting is still off: nothing could be stored
    expect(fs.existsSync(spillPath)).toBe(true);          // ... so the fact was persisted, not lost

    app.setSetting(true);
    const b = mkSink();
    expect(b.sink.pending()).toHaveLength(1);
    b.sink.flush!();
    await b.sink.settled();
    b.sink.flush!();                                      // a second start-up flush resends nothing new
    await b.sink.settled();
    expect(app.rows()).toHaveLength(1);
    expect(app.rows()[0]).toMatchObject({ origin: "own", entry_id: expect.any(String) });
    await b.sink.close();
    expect(fs.existsSync(spillPath)).toBe(false);
  });

  it("end to end: the runner stopping while a fact is kept flushes it first when the daemon has come back", async () => {
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
    const done = rig.start();
    await waitFor(() => rig!.pane().includes("READY"), "the runner to attach");
    rig.runner.submit("please answer");
    await waitFor(() => rig!.fake.entries("research").length === 1 && rig!.pane().includes("queued (submission"), "admitted");
    rig.fake.streamReply("research", ["hello"]);
    await waitFor(() => rig!.pane().includes("── idle ──"), "the run to end");
    await sink.settled();
    expect(sink.pending()).toHaveLength(1);
    app.setSetting(true);                                 // the daemon is back; no further run_end will come
    rig.runner.stop();
    await done;
    expect(app.rows()).toHaveLength(1);
    expect(sink.pending()).toEqual([]);
  });

  it("the runner asks the sink to post at start (facts a prior launch left unsent) and to close at stop", async () => {
    const calls: string[] = [];
    rig = await makeRig({ realStreams: true, usage: { flush: () => { calls.push("flush"); }, close: async () => { calls.push("close"); } } });
    const done = rig.start();
    await waitFor(() => rig!.pane().includes("READY"), "the runner to attach");
    expect(calls).toEqual(["flush"]);
    rig.runner.stop();
    await done;
    expect(calls).toEqual(["flush", "close"]);
  });
});
