// OF-105: the three usage posters (pi runner, pi charge lookup, pda sink) against the daemon's per-post limits
// (5000 facts, 4 MiB; routes/activity.ts answers 413 beyond them). Limits are written out as literals here.
//
// Deployed entrypoints: the seat's pi-runner (pi-runner.ts main, with --usage-facts) builds RunnerCore, whose
// reportUsageFacts posts to /api/activity/pi-usage; with --openrouter-charge the same process builds
// OpenRouterChargeLookup (/pi-usage-charges). The seat's pda-runner builds createPdaUsageSink + createPdaUsagePoster
// (/api/activity/pda-usage). Production consequences, in the order of the rows:
//   1. Overlapping get_entries refreshes used to start a second post loop while the first was in flight, so
//      every chunk was posted twice (doubled load on an idempotent store).
//   2. A pda batch whose JSON passed 4 MiB was refused whole (413 -> dropped as http_413) and every valid fact in it
//      was lost; one fact with a huge `model` or `responseId` could do that alone.
//   3. The charge poster's chunking had no test at all (its branch is defensive: the pump keeps `unposted` small).
import { describe, it, expect } from "vitest";
import { RunnerCore, type RunnerIo } from "../src/adapters/pi-runner.js";
import { OpenRouterChargeLookup } from "../src/adapters/pi-openrouter-charge.js";
import { createPdaUsageSink, pdaUsageFactFromEntry } from "../src/adapters/pda-usage-sink.js";
import { parsePdaUsageFact, type PdaUsageFact, type PdaUsagePayload } from "../src/adapters/pda-runner-protocol.js";
import { assistantEntry } from "./helpers/pda-real-shapes.js";

const settleAll = async () => { for (let i = 0; i < 40; i += 1) await new Promise((r) => setTimeout(r, 0)); };
const BASE = Date.UTC(2026, 9, 26, 10, 0, 0);

// ── 1. pi runner: one post loop in flight, a rerun flag for what arrived meanwhile ─────────────────────────────
const entry = (i: number) => ({
  type: "message", id: `e${i}`, parentId: null, timestamp: new Date(BASE + 1000 + i).toISOString(),
  message: { role: "assistant", provider: "openrouter", model: "m-1", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 }, stopReason: "stop" },
});
const entries = (n: number) => Array.from({ length: n }, (_, i) => entry(i));
const HEADER = JSON.stringify({ type: "session", version: 3, id: "0197a2f0", timestamp: new Date(BASE).toISOString(), cwd: "/w" });

function gatedRunner() {
  const posts: string[][] = [];
  const releases: Array<() => void> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const io: RunnerIo = {
    sendRpc: () => {}, mirrorLine: () => {}, mirrorAppend: () => {}, postActivity: () => {}, writeSidecar: () => {},
    sessionFileExists: () => true, now: () => new Date(BASE).toISOString(), readFirstLine: () => HEADER,
    postUsageFacts: async (payload) => {
      posts.push((payload as { facts: Array<{ entryId: string }> }).facts.map((f) => f.entryId));
      inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => releases.push(resolve));
      inFlight -= 1;
      return true;
    },
  };
  const core = new RunnerCore(io, { sessionName: "devpi-a@rig", nodeId: "node-1", generation: "gen-2" }, { usageFacts: true, runtime: "pi" });
  core.start();
  core.handlePiLine(JSON.stringify({ type: "response", id: "pi-runner-get-state", success: true, data: { sessionFile: "/s/f.jsonl", sessionId: "0197a2f0" } }));
  const refresh = async (list: unknown[]) => {
    core.handlePiLine(JSON.stringify({ type: "response", id: "pi-runner-cursor-refresh", success: true, command: "get_entries", data: { entries: list, leafId: null } }));
    await settleAll();
  };
  const release = async () => { releases.shift()?.(); await settleAll(); };
  return { refresh, release, posts, maxInFlight: () => maxInFlight, waiting: () => releases.length };
}

describe("OF-105 pi runner: overlapping refreshes never post at the same time", () => {
  it("a refresh that arrives while a post is in flight posts nothing yet; once the post settles it sends only what is new", async () => {
    const r = gatedRunner();
    await r.refresh(entries(3));
    expect(r.posts).toEqual([["e0", "e1", "e2"]]);
    await r.refresh(entries(5)); // arrives while the first post is still in flight
    expect(r.posts).toEqual([["e0", "e1", "e2"]]); // base: a second post of e0..e4 is already out
    expect(r.waiting()).toBe(1);
    await r.release();
    await r.release();
    expect(r.posts).toEqual([["e0", "e1", "e2"], ["e3", "e4"]]); // the rerun: e0..e2 are settled, not sent twice
    expect(r.maxInFlight()).toBe(1);
  });

  it("control: no refresh arrived meanwhile, so no rerun is posted", async () => {
    const r = gatedRunner();
    await r.refresh(entries(3));
    await r.release();
    await settleAll();
    expect(r.posts).toEqual([["e0", "e1", "e2"]]);
  });

  it("three overlapping refreshes collapse into one rerun", async () => {
    const r = gatedRunner();
    await r.refresh(entries(2));
    await r.refresh(entries(3));
    await r.refresh(entries(4));
    await r.release();
    await r.release();
    await r.release();
    expect(r.posts).toEqual([["e0", "e1"], ["e2", "e3"]]);
    expect(r.maxInFlight()).toBe(1);
  });
});

// ── 2. pda sink: a post stays inside the daemon's byte cap; text fields are bounded ────────────────────────────
const pad = (n: number) => "x".repeat(n);
const bigEntry = (id: number, width: number) => assistantEntry(id, "t", {
  usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } },
  provider: pad(width), model: pad(width), api: pad(width), responseId: pad(width), stopReason: pad(width),
});

describe("OF-105 pda sink: a batch is split by bytes", () => {
  it("2000 facts with 512-character text fields post as several bodies, each under 4 MiB, all delivered once and in order", async () => {
    const posts: PdaUsagePayload[] = [];
    const s = createPdaUsageSink({
      sessionName: "seat@rig", nodeId: "n1", generation: "g1", agent: "research", isOwnSubmission: () => true,
      post: async (p) => { posts.push(structuredClone(p)); return "stored"; },
    });
    for (let id = 1; id <= 2000; id += 1) s.onAssistantEntry!(bigEntry(id, 512));
    expect(s.pending()).toHaveLength(2000);
    s.onRunEnd!({ type: "run_end", inputs: [] } as never);
    await s.settled();
    await settleAll();
    const bytes = posts.map((p) => Buffer.byteLength(JSON.stringify(p)));
    expect(posts.length).toBeGreaterThan(1);
    for (const b of bytes) expect(b).toBeLessThanOrEqual(4 * 1024 * 1024); // base: one body of about 7 MB
    expect(posts.flatMap((p) => p.facts.map((f) => f.entryId))).toEqual(Array.from({ length: 2000 }, (_, i) => String(i + 1)));
    expect(s.pending()).toHaveLength(0);
    expect(s.dropped()).toBe(0);
  });

  it("a split batch still carries one envelope per post (agent, nodeId, generation) and a transient answer keeps the rest pending", async () => {
    const posts: PdaUsagePayload[] = [];
    const answers: Array<"stored" | "keep"> = ["keep"];
    const s = createPdaUsageSink({
      sessionName: "seat@rig", nodeId: "n1", generation: "g1", agent: "research", isOwnSubmission: () => true,
      post: async (p) => { posts.push(structuredClone(p)); return answers.shift() ?? "stored"; },
    });
    for (let id = 1; id <= 2000; id += 1) s.onAssistantEntry!(bigEntry(id, 512));
    s.onRunEnd!({ type: "run_end", inputs: [] } as never);
    await s.settled();
    expect(posts).toHaveLength(1); // keep: nothing re-posted until the next run_end
    expect(posts[0]).toMatchObject({ sessionName: "seat@rig", nodeId: "n1", generation: "g1", agent: "research" });
    expect(s.pending()).toHaveLength(2000); // nothing was lost with the kept answer
  });
});

describe("OF-105 pda facts: text fields are bounded at 512 characters", () => {
  const good = (): PdaUsageFact => pdaUsageFactFromEntry(bigEntry(1, 4), "own")!;
  it.each(["conversationId", "entryId", "entryTimestamp", "provider", "model", "api", "responseId", "stopReason"] as const)(
    "%s: 512 characters pass, 513 are refused", (key) => {
      expect(parsePdaUsageFact({ ...good(), [key]: pad(512) })).not.toBeNull();
      expect(parsePdaUsageFact({ ...good(), [key]: pad(513) })).toBeNull();
    });

  it("a fact built from an entry with a 5 MB model name is dropped as unbuildable (counted, logged), and its neighbours still post", async () => {
    const posts: PdaUsagePayload[] = [];
    const lines: string[] = [];
    const s = createPdaUsageSink({
      sessionName: "seat@rig", nodeId: "n1", generation: "g1", agent: "research", isOwnSubmission: () => true,
      post: async (p) => { posts.push(structuredClone(p)); return "stored"; }, log: (l) => lines.push(l),
    });
    s.onAssistantEntry!(bigEntry(1, 4));
    s.onAssistantEntry!(assistantEntry(2, "t", { model: pad(5_000_000), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } } }));
    s.onAssistantEntry!(bigEntry(3, 4));
    s.onRunEnd!({ type: "run_end", inputs: [] } as never);
    await s.settled();
    expect(posts.flatMap((p) => p.facts.map((f) => f.entryId))).toEqual(["1", "3"]);
    expect(s.droppedReasons()).toEqual({ unbuildable: 1 });
    expect(lines).toEqual(["[pda-runner] usage fact dropped: reason=unbuildable count=1"]);
  });
});

// ── 3. charges poster: chunking pinned ─────────────────────────────────────────────────────────────────────────
describe("OF-105 charges poster: more than 5000 unposted outcomes post in chunks", () => {
  it("5001 unposted outcomes in one session post as 5000 + 1, in order, and each is posted once", async () => {
    const posted: string[][] = [];
    const l = new OpenRouterChargeLookup({
      fetchGeneration: async () => ({ error: "network" }),
      postCharges: async (_s, charges) => { posted.push(charges.map((c) => c.entryId)); return new Set(charges.map((c) => c.entryId)); },
      schedule: () => {},
    });
    // The pump keeps `unposted` to a handful, so the branch cannot be reached through enqueue(); seed the backlog.
    const unposted = (l as unknown as { unposted: Map<string, unknown> }).unposted;
    for (let i = 0; i < 5001; i += 1) {
      unposted.set(`s1\u0000e${i}`, { piSessionId: "s1", posts: 0, charge: { entryId: `e${i}`, generationId: `gen-${i}`, status: "unavailable", totalCostUsd: null, upstreamInferenceCostUsd: null,
        cacheDiscountUsd: null, isByok: null, providerName: null, model: null, apiType: null, workspaceId: null, generationCreatedAt: null, credentialSource: "env", reason: "x" } });
    }
    await (l as unknown as { flushAlone(): Promise<void> }).flushAlone();
    expect(posted.map((p) => p.length)).toEqual([5000, 1]); // unchunked: one post of 5001 (the daemon answers 413)
    expect(posted.flat()).toEqual(Array.from({ length: 5001 }, (_, i) => `e${i}`));
    expect(unposted.size).toBe(0);
  });
});
