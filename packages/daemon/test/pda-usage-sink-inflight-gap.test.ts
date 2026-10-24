// pda runtime L3 (QA capture, no production change): a usage fact that is queued while the previous post is still in
// flight is not posted when that post returns. It waits for the NEXT `run_end` (or a gap-fill recovery), which can be
// a long time away, and the queue is in memory only.
//
// Labels: the 15 s observation below is a runtime measurement; "lost for good if the runner restarts first" is an
// argument from code (the sink's queue is a local array; the gap fill resumes after the saved cursor), not measured.
//
// Observed at 966bf9d4 through the real runner (pda-seat-e2e.test.ts, first draft of row 11): three runs ended
// back to back against a real daemon; the first two facts were stored, the third (a run that ended while the second
// post was in flight) was still absent from pda_usage_entries 15 s later and the sidecar showed the seat idle.
// Mechanism: `pda-usage-sink.ts` `flush()` returns at `if (inFlight || pending.length === 0) return;`, and
// nothing calls it again when `inFlight` settles. The design says unacknowledged facts are re-sent "on the next
// run_end, as Pi does" (pda-runtime-design-9l, J-3), so this is design-conformant; what it costs is that the last
// run of a burst (a followUp queue ending run after run) is reported late, and is lost for good if the runner
// restarts first.
//
// What is captured: the repro (passes today, delete it when the sink re-flushes), and the fixed contract as a STRICT
// expected failure (`it.fails`): the day the sink posts a fact that was queued behind an in-flight post, the
// second test starts failing loudly, and whoever fixes it flips `it.fails` to `it` and deletes the repro. It cannot be
// weakened to pass. The fix direction (re-flush when `inFlight` settles and `pending` is non-empty) belongs to the
// owner of pda-usage-sink.ts; this file does not decide it.
import { describe, expect, it } from "vitest";
import { createPdaUsageSink, type PdaUsagePostOutcome } from "../src/adapters/pda-usage-sink.js";
import type { PdaUsagePayload } from "../src/adapters/pda-runner-protocol.js";
import { assistantEntry } from "./helpers/pda-real-shapes.js";

const priced = (id: number) => assistantEntry(id, "x", {
  usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } },
});

/** A sink whose FIRST post stays open until `release()`: the window a second run can end in. */
function sinkWithSlowFirstPost() {
  const posts: PdaUsagePayload[] = [];
  let release!: () => void;
  const open = new Promise<void>((resolve) => { release = resolve; });
  const sink = createPdaUsageSink({
    sessionName: "seat@rig", nodeId: "n1", generation: "g1", agent: "research",
    isOwnSubmission: () => true,
    post: async (payload): Promise<PdaUsagePostOutcome> => {
      posts.push(structuredClone(payload));
      if (posts.length === 1) await open;
      return "stored";
    },
  });
  const endRun = (entryId: number) => {
    sink.onRunStart!({ type: "run_start", inputs: [11] } as never);
    sink.onAssistantEntry!(priced(entryId));
    sink.onRunEnd!({ type: "run_end", inputs: [11] } as never);
  };
  return { sink, posts, release, endRun };
}

const tick = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const postedEntryIds = (posts: PdaUsagePayload[]) => posts.flatMap((p) => p.facts.map((f) => f.entryId));

describe("a usage fact queued behind an in-flight post", () => {
  it("REPRO (current behaviour; delete when fixed): it is not posted when the in-flight post returns, and stays pending", async () => {
    const { sink, posts, release, endRun } = sinkWithSlowFirstPost();
    endRun(1); // post #1 starts and stays open
    endRun(2); // its run ends while #1 is in flight: flush() returns early
    expect(posts).toHaveLength(1);
    release();
    await sink.settled();
    await tick(50);
    await sink.settled();
    expect(postedEntryIds(posts)).toEqual(["1"]);                        // the defect: fact 2 was never posted
    expect(sink.pending().map((f) => f.entryId)).toEqual(["2"]);        // ... and it is still waiting for the next run_end
  });

  it.fails("FIXED CONTRACT (strict expected failure; flip to `it` and delete the repro when fixed): it is posted without waiting for another run_end", async () => {
    const { sink, posts, release, endRun } = sinkWithSlowFirstPost();
    endRun(1);
    endRun(2);
    release();
    await sink.settled();
    await tick(50);
    await sink.settled();
    expect(postedEntryIds(posts)).toEqual(["1", "2"]);
    expect(sink.pending()).toEqual([]);
  });
});
