// OF-286 acceptance on the recorded night (verify-qa / verify-sec@eztrack, 2026-11-10): the REAL notifier and a REAL QueueRepository are driven over the flag
// timeline the real tracker produced from the recorded sessions (flag raised/cleared times from the replay; relaunches at the session-file boundaries), polled
// every 30 s. What the Chief of Staff receives is counted as queue ROWS. The timeline is the review's (scratchpad/r2/drive.out); the review measured the first
// build on it: 4 of its 6 "no longer looping" items were relaunches the CoS performed itself, and verify-qa's 08:24-08:54 loop (17 failures) got nothing.
import { describe, it, expect } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { inventoryOfLiveRigs } from "../src/domain/seat-lost-health.js";
import { SeatModelErrorLoopNotifier } from "../src/domain/seat-model-error-loop-notice.js";

type Seg = { from: string; to: string; loop: { since: string } | null; observed: boolean };
// [seat, segments] — from drive.out (real tracker, real event order); relaunch gaps are unobserved (pending sidecar) for 60 s.
const T = (s: string) => `2026-11-10T${s}.000Z`;
const timeline: Record<string, Seg[]> = {
  "verify-qa@eztrack": [
    { from: T("02:07:01"), to: T("02:21:55"), loop: { since: "q1" }, observed: true },
    { from: T("02:21:55"), to: T("02:22:55"), loop: null, observed: false },
    { from: T("02:22:55"), to: T("04:33:37"), loop: null, observed: true },
    { from: T("04:33:37"), to: T("05:56:51"), loop: { since: "q2" }, observed: true },
    { from: T("05:56:51"), to: T("05:57:51"), loop: null, observed: false },
    { from: T("05:57:51"), to: T("06:02:53"), loop: null, observed: true },
    { from: T("06:02:53"), to: T("06:28:49"), loop: { since: "q3" }, observed: true },
    { from: T("06:28:49"), to: T("07:49:53"), loop: null, observed: true },
    { from: T("07:49:53"), to: T("08:08:34"), loop: { since: "q4" }, observed: true },
    { from: T("08:08:34"), to: T("08:09:34"), loop: null, observed: false },
    { from: T("08:09:34"), to: T("08:24:20"), loop: null, observed: true },
    { from: T("08:24:20"), to: T("08:53:49"), loop: { since: "q5" }, observed: true },
    { from: T("08:53:49"), to: T("10:00:00"), loop: null, observed: true },
  ],
  "verify-sec@eztrack": [
    { from: T("05:59:33"), to: T("06:57:08"), loop: { since: "s1" }, observed: true },
    { from: T("06:57:08"), to: T("06:58:08"), loop: null, observed: false },
    { from: T("06:58:08"), to: T("07:06:39"), loop: null, observed: true },
    { from: T("07:06:39"), to: T("07:19:25"), loop: { since: "s2" }, observed: true },
    { from: T("07:19:25"), to: T("10:00:00"), loop: null, observed: true },
  ],
};


/** The CoS relaunches at these times (the session-file boundaries): every runner after them has another launch id. */
const relaunches: Record<string, string[]> = { "verify-qa@eztrack": [T("02:21:55"), T("05:56:51"), T("08:08:34")], "verify-sec@eztrack": [T("06:57:08")] };

async function night(unobservedGaps: boolean): Promise<string[]> {
  const db = createFullTestDb();
  try {
    const rigs = new RigRepository(db); const sessions = new SessionRegistry(db); const eventBus = new EventBus(db);
    const queue = new QueueRepository(db, eventBus, { validateRig: () => true });
    const rig = rigs.createRig("eztrack");
    const cos = rigs.addNode(rig.id, "exec.cos", { runtime: "claude-code" });
    sessions.updateStatus(sessions.registerSession(cos.id, "exec-cos@eztrack").id, "running");
    for (const [id, s] of [["verify.qa", "verify-qa@eztrack"], ["verify.sec", "verify-sec@eztrack"]] as const) {
      const n = rigs.addNode(rig.id, id, { runtime: "pi" });
      sessions.updateStatus(sessions.registerSession(n.id, s).id, "running");
      rigs.addEdge(rig.id, cos.id, n.id, "delegates_to");
    }
    let now = Date.parse(T("02:00:00"));
    const read = (seat: string) => {
      const seg = timeline[seat]?.find((g) => Date.parse(g.from) <= now && now < Date.parse(g.to));
      const launchId = `L${(relaunches[seat] ?? []).filter((t) => Date.parse(t) <= now).length}`;
      if (!seg) return { observed: true, loop: null, launchId };
      const observed = unobservedGaps ? seg.observed : true;
      return { observed, loop: seg.loop && observed ? { count: 3, total: 3, since: seg.from, lastAt: seg.from, lastError: "terminated" } : null, ...(observed ? { launchId } : {}) };
    };
    const at: Array<{ t: string; id: string }> = [];
    const n = new SeatModelErrorLoopNotifier({ db, queue: { create: async (i) => { const r = await queue.create(i); at.push({ t: new Date(now).toISOString().slice(11, 19), id: r.qitemId }); return r; } },
      inventory: () => inventoryOfLiveRigs(db), read: (_rt, s) => read(s), now: () => new Date(now), log: () => undefined });
    for (; now < Date.parse(T("10:00:00")); now += 30_000) await n.tick();
    const rows = db.prepare("SELECT qitem_id, tags, body FROM queue_items WHERE destination_session = 'exec-cos@eztrack'").all() as Array<{ qitem_id: string; tags: string; body: string }>;
    const byId = new Map(rows.map((r) => [r.qitem_id, r]));
    expect(rows.length).toBe(new Set(at.map((a) => a.id)).size);
    return at.map((a) => { const r = byId.get(a.id)!; return `${a.t} ${r.tags.includes("state:recovered") ? "recovered" : "looping  "} ${r.body.split(" ")[0]}`; });
  } finally { db.close(); }
}

const EXPECTED = [
  "02:07:30 looping   verify.qa@eztrack",
  "04:34:00 looping   verify.qa@eztrack",
  "06:00:00 looping   verify.sec@eztrack",
  "06:03:00 looping   verify.qa@eztrack",
  "06:29:00 recovered verify.qa@eztrack",
  "07:07:00 looping   verify.sec@eztrack",
  "07:19:30 recovered verify.sec@eztrack",
  "07:50:00 looping   verify.qa@eztrack",
  "08:24:30 looping   verify.qa@eztrack",
  "08:54:00 recovered verify.qa@eztrack",
];

describe("OF-286 the Chief of Staff over the recorded night", () => {
  it("gets 7 start items and 3 recovery items as queue rows, no recovery for a relaunch, and one for verify-qa's 08:24-08:54 loop (the relaunches leave the runner unobserved for a minute)", async () => {
    expect(await night(true)).toEqual(EXPECTED);
  }, 60_000);
  it("gets the same rows when the relaunch is only seen as another launch id (no unobserved pass between)", async () => {
    expect(await night(false)).toEqual(EXPECTED);
  }, 60_000);
});
