// OF-90 (runner side): the daemon now answers 413 to a usage post of more than 5000 facts or 4 MiB. Production
// consequence: a Pi session with more than 5000 unposted usage facts (a long session, or a runner restarted late)
// would be refused on every refresh and re-sent forever, and its cost would never be recorded. The Pi runner
// therefore posts in chunks of at most 5000 facts within 3 MiB, and gives up a chunk the daemon refuses with 413
// (logging the daemon's code) instead of re-sending it on every refresh.
//
// Deployed entrypoint: the seat's pi-runner (`pi-runner.ts`, started with --usage-facts) builds RunnerCore, whose
// reportUsageFacts posts to the daemon's /api/activity/pi-usage; with --openrouter-charge the same runner's
// OpenRouterChargeLookup posts to /pi-usage-charges. The limits below are written out literally; nothing here
// imports them.
import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { activityRoutes } from "../src/routes/activity.js";
import { RunnerCore, interpretChargesReply, interpretUsageFactsReply, type RunnerIo } from "../src/adapters/pi-runner.js";
import { OpenRouterChargeLookup } from "../src/adapters/pi-openrouter-charge.js";
import { chunkUsagePost } from "../src/domain/usage-post-limits.js";

const SESSION = "devpi-a@rig";
const TOKEN = "hook-token";
const dbs: Database.Database[] = [];
afterEach(() => { for (const d of dbs.splice(0)) d.close(); });
const settleAll = async () => { for (let i = 0; i < 40; i += 1) await new Promise((r) => setTimeout(r, 0)); };

const BASE = Date.UTC(2026, 9, 26, 10, 0, 0);
const entry = (i: number) => ({
  type: "message", id: `e${i}`, parentId: null, timestamp: new Date(BASE + 1000 + i).toISOString(),
  message: { role: "assistant", provider: "openrouter", model: "m-1", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 }, stopReason: "stop" },
});
const entries = (n: number) => Array.from({ length: n }, (_, i) => entry(i));
const HEADER = JSON.stringify({ type: "session", version: 3, id: "0197a2f0", timestamp: new Date(BASE).toISOString(), cwd: "/w" });

/** A runner whose posts go to the REAL pi-usage route (when `viaRoute`) or to a scripted reply. */
function runner(script?: (payload: Record<string, any>, n: number) => boolean | { refused: string } | { charged: string[]; rejected?: number }) {
  const d = createDb(); migrate(d, ALL_MIGRATIONS); dbs.push(d);
  const hono = new Hono();
  hono.use("*", async (c, next) => {
    c.set("agentActivityStore" as never, { resolveSession: () => ({ sessionId: "sid", rigId: "r", nodeId: "node-1", sessionName: SESSION, runtime: "pi" }) } as never);
    c.set("activityHookToken" as never, TOKEN as never);
    c.set("sessionRegistry" as never, { db: d } as never);
    await next();
  });
  hono.route("/api/activity", activityRoutes);
  const posts: Array<{ facts: number; bytes: number; status: number | null }> = [];
  const lines: string[] = [];
  const io: RunnerIo = {
    sendRpc: () => {}, mirrorLine: (l) => lines.push(l), mirrorAppend: () => {}, postActivity: () => {}, writeSidecar: () => {},
    sessionFileExists: () => true, now: () => new Date(BASE).toISOString(), readFirstLine: () => HEADER,
    postUsageFacts: async (payload) => {
      if (script) {
        const r = script(payload as Record<string, any>, posts.length);
        posts.push({ facts: (payload as any).facts.length, bytes: 0, status: null });
        return r;
      }
      const body = JSON.stringify(payload);
      const res = await hono.request("/api/activity/pi-usage", {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body });
      posts.push({ facts: (payload as any).facts.length, bytes: Buffer.byteLength(body), status: res.status });
      return interpretUsageFactsReply(res);
    },
  };
  const core = new RunnerCore(io, { sessionName: SESSION, nodeId: "node-1", generation: "gen-2" }, { usageFacts: true, runtime: "pi" });
  core.start();
  core.handlePiLine(JSON.stringify({ type: "response", id: "pi-runner-get-state", success: true, data: { sessionFile: "/s/f.jsonl", sessionId: "0197a2f0" } }));
  const refresh = async (list: unknown[]) => {
    core.handlePiLine(JSON.stringify({ type: "response", id: "pi-runner-cursor-refresh", success: true, command: "get_entries", data: { entries: list, leafId: null } }));
    await settleAll();
  };
  const stored = () => (d.prepare("SELECT count(*) AS n FROM pi_usage_entries").get() as { n: number }).n;
  return { refresh, posts, lines, stored };
}

describe("OF-90 runner: more than 5000 unposted facts post in chunks and all land", () => {
  it("12001 facts reach the real route as 5000 + 5000 + 2001, every post accepted, all 12001 stored", async () => {
    const r = runner();
    await r.refresh(entries(12001));
    expect(r.posts.map((p) => p.facts)).toEqual([5000, 5000, 2001]);
    expect(r.posts.map((p) => p.status)).toEqual([200, 200, 200]);
    expect(r.stored()).toBe(12001);
    for (const p of r.posts) expect(p.bytes).toBeLessThan(4 * 1024 * 1024);
  });

  it("a settled backlog is not posted again on the next refresh", async () => {
    const r = runner();
    await r.refresh(entries(5001));
    await r.refresh(entries(5001));
    expect(r.posts.map((p) => p.facts)).toEqual([5000, 1]);
  });

  it("a chunk that fails (daemon down) stops the run; the next refresh sends the unsettled chunks, none twice", async () => {
    const r = runner((_p, n) => n !== 1); // the second post of the run fails once, then the daemon is back
    await r.refresh(entries(10001)); // chunk 0 ok, chunk 1 fails -> stop (chunk 2 waits)
    expect(r.posts.map((p) => p.facts)).toEqual([5000, 5000]);
    await r.refresh(entries(10001));
    expect(r.posts.map((p) => p.facts)).toEqual([5000, 5000, 5000, 1]);
  });
});

describe("OF-90 runner: a 413 is given up with a logged code, never retried endlessly", () => {
  it("a refused chunk is posted once; the next refreshes do not send it again; the code is logged", async () => {
    const r = runner(() => ({ refused: "usage_body_too_large" }));
    await r.refresh(entries(3));
    await r.refresh(entries(3));
    await r.refresh(entries(3));
    expect(r.posts).toHaveLength(1);
    expect(r.lines.filter((l) => l.includes("usage_body_too_large"))).toEqual(["[pi-runner] usage facts refused: code=usage_body_too_large count=3; not retried"]);
  });

  it("only the refused chunk is given up: the chunks around it are posted and settled", async () => {
    const r = runner((_p, n) => (n === 1 ? { refused: "usage_facts_too_many" } : true));
    await r.refresh(entries(12000));
    await r.refresh(entries(12000));
    expect(r.posts.map((p) => p.facts)).toEqual([5000, 5000, 2000]);
    expect(r.lines.filter((l) => l.includes("refused"))).toEqual(["[pi-runner] usage facts refused: code=usage_facts_too_many count=5000; not retried"]);
  });

  it("the wire reading: a 413 reply is { refused: code } (a bare 413 is http_413), any other failure is false, never refused", async () => {
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    expect(await interpretUsageFactsReply(json(413, { ok: false, code: "usage_facts_too_many" }))).toEqual({ refused: "usage_facts_too_many" });
    expect(await interpretUsageFactsReply(new Response("", { status: 413 }))).toEqual({ refused: "http_413" });
    expect(await interpretUsageFactsReply(json(503, {}))).toBe(false);
    expect(await interpretUsageFactsReply(json(401, {}))).toBe(false);
    expect(await interpretUsageFactsReply(json(200, { charged: ["a", 1] }))).toEqual({ charged: ["a"] });
    expect(await interpretChargesReply(json(413, { code: "usage_body_too_large" }))).toEqual({ refused: "usage_body_too_large" });
    expect(await interpretChargesReply(json(500, {}))).toBe(false);
    expect([...(await interpretChargesReply(json(200, { acknowledged: ["x"] })) as Set<string>)]).toEqual(["x"]);
  });
});

describe("OF-90 runner: a fact the daemon would refuse is never lost silently (review N1)", () => {
  const withCounts = (i: number, usage: Record<string, unknown>) => ({ ...entry(i), message: { ...entry(i).message, usage } });
  it("a fractional or 2**53 token count is skipped before posting and logged once with a code; the good fact still posts", async () => {
    const r = runner();
    const list = [entry(0), withCounts(1, { input: 1.5, output: 5 }), withCounts(2, { input: 10, output: 5, cacheRead: 2 ** 53 }), entry(3)];
    await r.refresh(list);
    await r.refresh(list);
    // e0 and e3 once; the second refresh posts no facts, only the standing `malformed` count (as before this change)
    expect(r.posts.map((p) => p.facts)).toEqual([2, 0]);
    expect(r.stored()).toBe(2);
    expect(r.lines.filter((l) => l.includes("usage_count_not_safe_integer"))).toEqual([
      "[pi-runner] usage fact skipped: code=usage_count_not_safe_integer entry=e1",
      "[pi-runner] usage fact skipped: code=usage_count_not_safe_integer entry=e2",
    ]);
  });
  it("a post the daemon answers with rejected > 0 is logged with the count", async () => {
    // a daemon stricter than the runner would otherwise drop these silently: the runner settles them as posted
    const r = runner(() => ({ charged: [], rejected: 2 }));
    await r.refresh([entry(1), entry(2)]);
    expect(r.lines.filter((l) => l.includes("rejected"))).toEqual(["[pi-runner] usage facts rejected by the daemon: code=usage_fact_rejected count=2"]);
    const clean = runner(); // control: a post with nothing rejected logs nothing
    await clean.refresh([entry(1)]);
    expect(clean.lines.filter((l) => l.includes("rejected"))).toEqual([]);
    // and the wire reading carries the daemon's count through
    expect(await interpretUsageFactsReply(new Response(JSON.stringify({ ok: true, charged: [], stored: 0, rejected: 2 }), { status: 200 }))).toEqual({ charged: [], rejected: 2 });
    expect(await interpretUsageFactsReply(new Response(JSON.stringify({ ok: true, charged: [], rejected: 0 }), { status: 200 }))).toEqual({ charged: [] });
  });
});

describe("OF-90 poster rule: chunkUsagePost", () => {
  it("at most 5000 per chunk, order kept, nothing lost", () => {
    const items = Array.from({ length: 12001 }, (_, i) => i);
    const chunks = chunkUsagePost(items);
    expect(chunks.map((c) => c.length)).toEqual([5000, 5000, 2001]);
    expect(chunks.flat()).toEqual(items);
    expect(chunkUsagePost([])).toEqual([]);
    expect(chunkUsagePost([1]).length).toBe(1);
  });
  it("splits by bytes too: items of ~1.1 MB go two to a 3 MiB chunk", () => {
    const big = (i: number) => ({ i, pad: "x".repeat(1_100_000) });
    const chunks = chunkUsagePost(Array.from({ length: 5 }, (_, i) => big(i)));
    expect(chunks.map((c) => c.map((x) => x.i))).toEqual([[0, 1], [2, 3], [4]]);
  });
  it("counts bytes, not characters", () => {
    const wide = (i: number) => ({ i, pad: "é".repeat(800_000) }); // 800k characters = 1.6 MB each; two (3.2 MB) overflow the 3 MiB (3.146 MB) budget, but 1.6M characters would not
    const chunks = chunkUsagePost(Array.from({ length: 4 }, (_, i) => wide(i)));
    expect(chunks.map((c) => c.length)).toEqual([1, 1, 1, 1]);
  });
  it("an item over the whole budget is a chunk of its own and does not take its neighbours with it", () => {
    const items = [{ i: 0 }, { i: 1, pad: "x".repeat(4 * 1024 * 1024) }, { i: 2 }];
    expect(chunkUsagePost(items).map((c) => c.map((x) => x.i))).toEqual([[0], [1], [2]]);
  });
});

describe("OF-90 charges poster: same rule", () => {
  const fact = (i: number) => ({ entryId: `e${i}`, entryTimestamp: "2026-10-26T10:00:00.000Z", kind: "assistant" as const, origin: "own" as const,
    input: 1, output: 1, parentEntryId: null, usageCategory: null, provider: "openrouter", model: "m", cacheRead: 0, cacheWrite: 0,
    costTotal: null, stopReason: "stop", api: "openai-completions", responseId: `gen-${i}-aaa` });
  function lookup(post: () => ReadonlySet<string> | false | { refused: string }) {
    const posted: string[][] = [];
    const timers: Array<() => void> = [];
    const notices: string[] = [];
    const l = new OpenRouterChargeLookup({
      fetchGeneration: async (id) => ({ status: 200, body: { data: { id, total_cost: 0.01, usage: 0.01, upstream_inference_cost: null, cache_discount: 0, is_byok: false,
        provider_name: "Z.AI", model: "m", api_type: "completions", workspace_id: "ws", created_at: "2026-10-26T10:00:00.000Z" } } }),
      postCharges: async (_s, charges) => { posted.push(charges.map((c) => c.entryId)); return post(); },
      schedule: (fn) => { timers.push(fn); },
      notice: (line) => { notices.push(line); },
    });
    l.enqueue("s1", [{ fact: fact(1), provenance: { ok: true, credentialSource: "env" } }], new Set());
    return { posted, timers, notices };
  }
  it("a 413 on the charges post is given up at once with its code: no retry is scheduled", async () => {
    const p = lookup(() => ({ refused: "usage_facts_too_many" }));
    await settleAll();
    expect(p.posted).toEqual([["e1"]]);
    expect(p.timers).toHaveLength(0);
    expect(p.notices).toEqual(["[pi-runner] OpenRouter charge outcomes refused: code=usage_facts_too_many count=1; not retried"]);
  });
  it("control: an ordinary failed post IS retried on a schedule (so the 413 row above is a real distinction)", async () => {
    const p = lookup(() => false);
    await settleAll();
    expect(p.timers).toHaveLength(1);
    expect(p.notices).toEqual([]);
  });
});
