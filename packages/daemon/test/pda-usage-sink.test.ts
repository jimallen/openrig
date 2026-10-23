// pda runtime L2a: the usage sink the pda-runner installs with --usage-facts (design J-3, J-5). Unit rows for the
// fact builder, the attribution rule and the delivery rule; the end-to-end rows (the real runner, the real route) are
// in pda-l2a-runner-seat.test.ts.

import { describe, expect, it, vi } from "vitest";
import { createPdaUsagePoster, createPdaUsageSink, pdaUsageFactFromEntry, type PdaUsagePostOutcome } from "../src/adapters/pda-usage-sink.js";
import { parsePdaUsageFact, type PdaUsagePayload } from "../src/adapters/pda-runner-protocol.js";
import { assistantEntry } from "./helpers/pda-real-shapes.js";

const priced = (id: number, total: number) => assistantEntry(id, "TEXT-CANARY", {
  usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 18, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } },
  responseId: `resp-${id}`,
});

describe("pdaUsageFactFromEntry", () => {
  it("builds L0's fact from a real-shaped assistant entry: ids as text, the message timestamp, J-5's cost rule", () => {
    const fact = pdaUsageFactFromEntry(priced(7, 0.25), "own")!;
    expect(fact).toEqual({
      conversationId: "1", entryId: "7", entryTimestamp: new Date(1_760_000_000_000).toISOString(), kind: "assistant",
      provider: "ollama-cloud", model: "m", api: "openai-completions", responseId: "resp-7", stopReason: "stop",
      input: 10, output: 5, cacheRead: 2, cacheWrite: 1, costTotal: 0.25, costBasis: "model_priced", origin: "own",
    });
    expect(parsePdaUsageFact(fact)).not.toBeNull();
    expect(pdaUsageFactFromEntry(priced(8, 0), "other")).toMatchObject({ costTotal: null, costBasis: "declared_zero_price", origin: "other" });
    expect(JSON.stringify(fact)).not.toContain("CANARY"); // numbers and ids only
  });

  it("null for anything that is not an assistant entry with whole-number usage", () => {
    expect(pdaUsageFactFromEntry({ id: 1, conversationId: 1, kind: "pi.user", model: [{ role: "user", content: [], timestamp: 1 }] }, "own")).toBeNull();
    expect(pdaUsageFactFromEntry(assistantEntry(2, "x", { usage: undefined }), "own")).toBeNull();
    expect(pdaUsageFactFromEntry(assistantEntry(3, "x", { usage: { input: 1.5, output: 1, cacheRead: 0, cacheWrite: 0 } }), "own")).toBeNull();
    expect(pdaUsageFactFromEntry(assistantEntry(4, "x", { timestamp: undefined }), "own")).toBeNull();
    expect(pdaUsageFactFromEntry(null, "own")).toBeNull();
  });
});

describe("createPdaUsageSink", () => {
  function sink(outcomes: PdaUsagePostOutcome[], own: string[] = ["11"]) {
    const posts: PdaUsagePayload[] = [];
    const s = createPdaUsageSink({
      sessionName: "seat@rig", nodeId: "n1", generation: "g1", agent: "research",
      isOwnSubmission: (id) => own.includes(id),
      post: async (p) => { posts.push(structuredClone(p)); return outcomes.shift() ?? "stored"; },
      maxPending: 3,
    });
    return { s, posts };
  }
  const run = async (s: ReturnType<typeof sink>["s"], inputs: unknown[] | null, ids: number[]) => {
    if (inputs) s.onRunStart!({ type: "run_start", inputs } as never);
    for (const id of ids) s.onAssistantEntry!(priced(id, 0.01));
    s.onRunEnd!({ type: "run_end", inputs: inputs ?? [] } as never);
    await s.settled();
  };

  it("attribution: own if any input is this seat's (mixed counts as own), other if none, unknown with no run_start or no inputs", async () => {
    const { s, posts } = sink([]);
    await run(s, [11], [1]);
    await run(s, [11, 99], [2]);
    await run(s, [99], [3]);
    await run(s, [], [4]);
    await run(s, null, [5]);
    expect(posts.flatMap((p) => p.facts.map((f) => [f.entryId, f.origin]))).toEqual([["1", "own"], ["2", "own"], ["3", "other"], ["4", "unknown"], ["5", "unknown"]]);
    expect(posts[0]).toMatchObject({ sessionName: "seat@rig", nodeId: "n1", generation: "g1", agent: "research" });
  });

  it("a 503 (or a timeout) keeps the facts for the next run_end; a stored post clears them; a refusal drops and counts them", async () => {
    const { s, posts } = sink(["keep", "stored", "refused"]);
    await run(s, [11], [1]);
    expect(s.pending().map((f) => f.entryId)).toEqual(["1"]);
    await run(s, [11], [2]);
    expect(posts[1]!.facts.map((f) => f.entryId)).toEqual(["1", "2"]); // the kept fact is re-sent first
    expect(s.pending()).toEqual([]);
    await run(s, [11], [3]);
    expect(s.pending()).toEqual([]);
    expect(s.dropped()).toBe(1);
  });

  it("a post that throws keeps the facts; a replayed entry is queued once; the pending list is bounded, oldest out", async () => {
    const posts: number[] = [];
    const s = createPdaUsageSink({
      sessionName: "s", nodeId: null, generation: null, agent: "a", isOwnSubmission: () => true, maxPending: 3,
      post: vi.fn(async (p: PdaUsagePayload) => { posts.push(p.facts.length); throw new Error("boom"); }),
    });
    s.onRunStart!({ type: "run_start", inputs: [1] } as never);
    for (const id of [1, 1, 2, 3, 4]) s.onAssistantEntry!(priced(id, 0.01));
    expect(s.pending().map((f) => f.entryId)).toEqual(["2", "3", "4"]);
    expect(s.dropped()).toBe(1);
    s.onRunEnd!({ type: "run_end", inputs: [1] } as never);
    await s.settled();
    expect(posts).toEqual([3]);
    expect(s.pending()).toHaveLength(3);
  });
});

describe("createPdaUsagePoster", () => {
  it("posts to /api/activity/pda-usage with the hook token; 2xx stored, 503 and 5xx keep, other 4xx refused, a throw keeps", async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const respond = (status: number) => vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
      return new Response("{}", { status });
    }) as unknown as typeof fetch;
    const endpoint = { baseUrl: "http://127.0.0.1:7433", token: "hook-tok" };
    const payload = { sessionName: "s", agent: "a", facts: [] } as PdaUsagePayload;
    expect(await createPdaUsagePoster(endpoint, respond(200))(payload)).toBe("stored");
    expect(await createPdaUsagePoster(endpoint, respond(503))(payload)).toBe("keep");
    expect(await createPdaUsagePoster(endpoint, respond(500))(payload)).toBe("keep");
    expect(await createPdaUsagePoster(endpoint, respond(404))(payload)).toBe("refused");
    expect(await createPdaUsagePoster(endpoint, (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch)(payload)).toBe("keep");
    expect(await createPdaUsagePoster(null)(payload)).toBe("keep");
    expect(seen[0]).toEqual({ url: "http://127.0.0.1:7433/api/activity/pda-usage", auth: "Bearer hook-tok" });
  });
});
