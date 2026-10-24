// pda runtime L3 finding, fixed at integration (integ24a): a usage fact queued while the previous post was still in
// flight was not posted when that post returned. It waited for the NEXT `run_end` (or a gap-fill recovery), which can
// be a long time away, and the queue is in memory only, so a runner restart in between lost it for good.
//
// Labels: the 15 s observation below is a runtime measurement; "lost for good if the runner restarts first" is an
// argument from code (the sink's queue is a local array; the gap fill resumes after the saved cursor), not measured.
//
// Observed at 966bf9d4 through the real runner (pda-seat-e2e.test.ts, first draft of row 11): three runs ended
// back to back against a real daemon; the first two facts were stored, the third (a run that ended while the second
// post was in flight) was still absent from pda_usage_entries 15 s later and the sidecar showed the seat idle.
// Mechanism: `pda-usage-sink.ts` `flush()` returned at `if (inFlight || pending.length === 0) return;`, and
// nothing called it again when `inFlight` settled.
//
// The fix: when a post settles with a definitive outcome (stored or refused), whatever is still pending was queued or
// upgraded while it was in flight, and it is flushed at once. A `keep` outcome (503, timeout, unreachable) does NOT
// re-flush: the daemon just said it cannot take facts, and re-posting at once would spin against it. Those facts wait
// for the next run_end, as the design says (pda-runtime-design-9l, J-3).
//
// The first row is L3's repro scenario kept as a regression row: it still proves the window exists (one post at a
// time, the second fact queued behind it), and now proves the second fact leaves when the first post settles.
import { describe, expect, it } from "vitest";
import { createPdaUsageSink, type PdaUsagePostOutcome } from "../src/adapters/pda-usage-sink.js";
import type { PdaUsagePayload } from "../src/adapters/pda-runner-protocol.js";
import { assistantEntry } from "./helpers/pda-real-shapes.js";

const priced = (id: number) => assistantEntry(id, "x", {
  usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } },
});

const tick = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A sink whose FIRST post stays open until `release(outcome)`: the window a second run can end in. Later posts return `later`. */
function sinkWithSlowFirstPost(later: PdaUsagePostOutcome = "stored") {
  const posts: PdaUsagePayload[] = [];
  let release!: (outcome?: PdaUsagePostOutcome) => void;
  const open = new Promise<PdaUsagePostOutcome>((resolve) => { release = (outcome = "stored") => resolve(outcome); });
  const sink = createPdaUsageSink({
    sessionName: "seat@rig", nodeId: "n1", generation: "g1", agent: "research",
    isOwnSubmission: () => true,
    post: async (payload): Promise<PdaUsagePostOutcome> => {
      posts.push(structuredClone(payload));
      if (posts.length === 1) return open;
      await tick(1); // a macrotask per later post: a sink that re-posts in a loop is observable, not a hung worker
      return later;
    },
  });
  const endRun = (entryId: number) => {
    sink.onRunStart!({ type: "run_start", inputs: [11] } as never);
    sink.onAssistantEntry!(priced(entryId));
    sink.onRunEnd!({ type: "run_end", inputs: [11] } as never);
  };
  return { sink, posts, release, endRun };
}

const postedEntryIds = (posts: PdaUsagePayload[]) => posts.map((p) => p.facts.map((f) => f.entryId));

describe("a usage fact queued behind an in-flight post", () => {
  it("L3 repro scenario: one post at a time, the second fact waits behind it, and leaves when the first post is stored", async () => {
    const { sink, posts, release, endRun } = sinkWithSlowFirstPost();
    endRun(1); // post #1 starts and stays open
    endRun(2); // its run ends while #1 is in flight: flush() returns early, never a second concurrent post
    expect(postedEntryIds(posts)).toEqual([["1"]]);
    expect(sink.pending().map((f) => f.entryId)).toEqual(["1", "2"]);
    release("stored");
    await sink.settled();
    await tick(50);
    await sink.settled();
    expect(postedEntryIds(posts)).toEqual([["1"], ["2"]]); // fact 2 alone: fact 1 is never re-sent
    expect(sink.pending()).toEqual([]);
  });

  it("it is posted without waiting for another run_end", async () => {
    const { sink, posts, release, endRun } = sinkWithSlowFirstPost();
    endRun(1);
    endRun(2);
    release();
    await sink.settled();
    await tick(50);
    await sink.settled();
    expect(postedEntryIds(posts).flat()).toEqual(["1", "2"]);
    expect(sink.pending()).toEqual([]);
  });

  it("a refused in-flight post also lets the newer fact go: only the refused batch is dropped", async () => {
    const { sink, posts, release, endRun } = sinkWithSlowFirstPost();
    endRun(1);
    endRun(2);
    release("refused");
    await sink.settled();
    expect(postedEntryIds(posts)).toEqual([["1"], ["2"]]);
    expect(sink.pending()).toEqual([]);
    expect(sink.dropped()).toBe(1);
  });

  it("a kept in-flight post (503, timeout) does not re-post at once: everything waits for the next run_end", async () => {
    const { sink, posts, release, endRun } = sinkWithSlowFirstPost("keep");
    endRun(1);
    endRun(2);
    release("keep");
    await tick(50); // observed by the clock, not settled(): a looping sink would never settle
    expect(postedEntryIds(posts)).toEqual([["1"]]); // no immediate retry against a daemon that just said 503
    expect(sink.pending().map((f) => f.entryId)).toEqual(["1", "2"]);
    endRun(3);
    await sink.settled();
    expect(postedEntryIds(posts)).toEqual([["1"], ["1", "2", "3"]]); // exactly one more post, and it keeps (later = keep)
    expect(sink.pending().map((f) => f.entryId)).toEqual(["1", "2", "3"]);
  });
});
