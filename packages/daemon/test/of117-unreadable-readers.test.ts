// OF-117: the readers a decision (or a listing) rests on used to `JSON.parse` a saved column bare, so one damaged row ended
// in a SyntaxError that every route answered as HTTP 500 for every row sharing the table. Measured at base 5eed3994:
//   GET /api/queue/list  with one queue_items.tags = '{not json'  -> 500 (every queue row hidden)
//   GET /api/queue/inbox/list, /outbox/list, /api/workflow/instances, /specs, watchdog status  -> the same.
// Now a reader that meets a damaged column answers in one of two NAMED ways, never "absent" and never a bare throw:
//   - REFUSE (decision reads, by-id reads): UnreadableRowError names the table, the row and the column; a route answers 422.
//   - MARK (listings, sweeps): the row is served with `unreadable: [columns]`, its damaged fields read as empty BECAUSE of it.
//
// Each row damages ONE column of ONE reader and nothing else, so each guard can fail on its own. Production consequence, in
// the test names: a damaged saved row names itself instead of hiding every other row of its table.
//
// Deployed entrypoints: server.ts mounts routes/queue.ts (QueueRepository, InboxHandler, OutboxHandler), routes/workflow.ts
// (WorkflowRuntime, WorkflowInstanceStore, WorkflowSpecCache) and routes/watchdog.ts (WatchdogHistoryLog); startup.ts runs
// drainPendingWakeIntents, runStuckSweep and runWorkflowBootSweep.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { Hono } from "hono";
import { createTestApp } from "./helpers/test-app.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { QueueRepository, type QueueNudgeTransport } from "../src/domain/queue-repository.js";
import { InboxHandler } from "../src/domain/inbox-handler.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { UnreadableRowError } from "../src/domain/unreadable-row.js";
import { runStuckSweep } from "../src/domain/queue-stuck-sweep.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { WatchdogHistoryLog } from "../src/domain/watchdog-history-log.js";
import { watchdogRoutes } from "../src/routes/watchdog.js";
import { StreamStore } from "../src/domain/stream-store.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { MissionControlAuditBrowse } from "../src/domain/mission-control/audit-browse.js";
import { queueRoutes } from "../src/routes/queue.js";
import { jsonBodyErrorHandler } from "../src/middleware/json-body-error.js";

const NOT_JSON = "{not json";
const A = "a@rig";
const B = "b@rig";

let db: Database.Database;
let setup: ReturnType<typeof createTestApp>;
let repo: QueueRepository;
let inboxHandler: InboxHandler;
let outboxHandler: OutboxHandler;
let queueApp: Hono;
beforeEach(() => {
  db = createDb();
  migrate(db, ALL_MIGRATIONS);
  setup = createTestApp(db);
  repo = new QueueRepository(db, setup.eventBus, { validateRig: () => true });
  inboxHandler = new InboxHandler(db, setup.eventBus, repo);
  outboxHandler = new OutboxHandler(db);
  repo.attachOutbox(outboxHandler);
  // The queue routes with the app's own error handler, as server.ts mounts them (UnreadableRowError.getResponse -> 422).
  queueApp = new Hono();
  queueApp.onError(jsonBodyErrorHandler);
  queueApp.use("*", async (c, next) => {
    c.set("eventBus" as never, setup.eventBus);
    c.set("queueRepo" as never, repo);
    c.set("inboxHandler" as never, inboxHandler);
    c.set("outboxHandler" as never, outboxHandler);
    await next();
  });
  queueApp.route("/api/queue", queueRoutes());
});
afterEach(() => db.close());

async function item(body: string) {
  return repo.create({ sourceSession: A, destinationSession: B, body, nudge: false });
}
function damage(qitemId: string, column: string, text: string | null) {
  db.prepare(`UPDATE queue_items SET ${column} = ? WHERE qitem_id = ?`).run(text, qitemId);
}

const QUEUE_COLUMNS = ["tags", "chain_of_record", "human_questions", "human_answers"] as const;
const CAMEL: Record<(typeof QUEUE_COLUMNS)[number], "tags" | "chainOfRecord" | "humanQuestions" | "humanAnswers"> = {
  tags: "tags", chain_of_record: "chainOfRecord", human_questions: "humanQuestions", human_answers: "humanAnswers",
};

describe("queue items: one damaged saved column names its row; the rows beside it are served", () => {
  it.each(QUEUE_COLUMNS)("GET /api/queue/list with %s damaged on one row: 200, the damaged row is flagged with that column, the readable rows are not", async (column) => {
    const good = await item("good");
    const bad = await item("bad");
    damage(bad.qitemId, column, NOT_JSON);
    const res = await queueApp.request("/api/queue/list");
    expect(res.status).toBe(200);
    const rows = await res.json() as Array<{ qitemId: string; unreadable?: string[]; tags: unknown }>;
    const byId = new Map(rows.map((r) => [r.qitemId, r]));
    expect(byId.get(bad.qitemId)!.unreadable).toEqual([column]);
    expect(byId.get(bad.qitemId)![CAMEL[column] as "tags"]).toBeNull();
    expect(byId.get(good.qitemId), "the readable row is served").toBeDefined();
    expect("unreadable" in byId.get(good.qitemId)!, "and carries no flag").toBe(false);
  });

  it("compact listings carry the flag too", async () => {
    const bad = await item("bad");
    damage(bad.qitemId, "tags", NOT_JSON);
    const res = await queueApp.request("/api/queue/list?compact=1");
    const rows = await res.json() as Array<{ qitemId: string; unreadable?: string[] }>;
    expect(rows.find((r) => r.qitemId === bad.qitemId)!.unreadable).toEqual(["tags"]);
  });

  it.each([
    ["tags that are valid JSON but an object", "tags", JSON.stringify({ k: "v" })],
    ["tags with a non-string member", "tags", JSON.stringify(["a", 1])],
    ["chain_of_record that is a scalar", "chain_of_record", "5"],
  ])("%s is damage too, not a list of strings", async (_name, column, text) => {
    const bad = await item("bad");
    damage(bad.qitemId, column, text);
    expect(repo.list({}).find((r) => r.qitemId === bad.qitemId)!.unreadable).toEqual([column]);
  });

  it("several damaged columns of one row are all named, in the order read", async () => {
    const bad = await item("bad");
    damage(bad.qitemId, "human_answers", NOT_JSON);
    damage(bad.qitemId, "tags", NOT_JSON);
    expect(repo.list({}).find((r) => r.qitemId === bad.qitemId)!.unreadable).toEqual(["tags", "human_answers"]);
  });

  it.each([["NULL", null], ["JSON null", "null"], ["empty list", "[]"]])("control: tags %s is 'none recorded': no flag", async (_name, text) => {
    const row = await item("row");
    damage(row.qitemId, "tags", text);
    const listed = repo.list({}).find((r) => r.qitemId === row.qitemId)!;
    expect("unreadable" in listed).toBe(false);
    expect(repo.getById(row.qitemId)).not.toBeNull();
  });

  it("list({ tag }) skips a row whose tags are not JSON (no match) instead of ending the whole listing; a readable match is served", async () => {
    const match = await repo.create({ sourceSession: A, destinationSession: B, body: "m", nudge: false, tags: ["wanted"] });
    const bad = await item("bad");
    damage(bad.qitemId, "tags", NOT_JSON);
    expect(repo.list({ tag: "wanted" }).map((r) => r.qitemId)).toEqual([match.qitemId]);
  });

  it("getById refuses by name: UnreadableRowError carries the table, the row and the column, and the route answers 422, not 500", async () => {
    const bad = await item("bad");
    damage(bad.qitemId, "tags", NOT_JSON);
    let caught: unknown;
    try { repo.getById(bad.qitemId); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(UnreadableRowError);
    expect(caught).toMatchObject({ table: "queue_items", rowId: bad.qitemId, columns: ["tags"] });
    const res = await queueApp.request(`/api/queue/${bad.qitemId}`);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: `Saved queue_items row ${bad.qitemId} is damaged: tags is not readable JSON. Repair or remove the row.`,
      code: "saved_row_unreadable", table: "queue_items", rowId: bad.qitemId, columns: ["tags"],
    });
  });

  it("listInProgressForDestination (the authoritative input of whoami's ambiguity refusal) refuses, it does not serve a row it cannot read", async () => {
    const bad = await item("bad");
    repo.claim({ qitemId: bad.qitemId, destinationSession: B });
    damage(bad.qitemId, "tags", NOT_JSON);
    expect(() => repo.listInProgressForDestination(B)).toThrow(UnreadableRowError);
    expect((await queueApp.request(`/api/queue/whoami?session=${B}`)).status).toBe(422);
  });

  // Review N1: the write routes answered a refused damaged row with 500 internal_error; reads answered 422.
  it.each([
    ["claim", "claim", {}],
    ["update", "update", { transitionNote: "noting" }],
    ["handoff", "handoff", { toSession: "c@rig", body: "next" }],
  ])("POST /:id/%s on a damaged row is 422 saved_row_unreadable (like the reads), and the row is unchanged", async (_name, verb, body) => {
    const bad = await item("bad");
    damage(bad.qitemId, "tags", NOT_JSON);
    const res = await queueApp.request(`/api/queue/${bad.qitemId}/${verb}`, { method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": B }, body: JSON.stringify(body) });
    expect({ status: res.status, body: await res.json() }).toMatchObject({ status: 422, body: { code: "saved_row_unreadable", table: "queue_items", rowId: bad.qitemId } });
    expect(db.prepare("SELECT state, claimed_at FROM queue_items WHERE qitem_id = ?").get(bad.qitemId)).toEqual({ state: "pending", claimed_at: null });
  });

  it("whoami's recent list (display) marks the row", async () => {
    const bad = await item("bad");
    damage(bad.qitemId, "tags", NOT_JSON);
    const recent = repo.whoami(B, {}).asDestination.recent;
    expect(recent.find((r) => r.qitemId === bad.qitemId)!.unreadable).toEqual(["tags"]);
  });

  it("listDeliveredHumanUpdates (GET /human-updates) marks a damaged delivered update and serves the readable one", async () => {
    const deliver = async (body: string) => {
      const row = await item(body);
      db.prepare("UPDATE queue_items SET destination_session = 'human@kernel', human_intent = 'update' WHERE qitem_id = ?").run(row.qitemId);
      repo.transitionLog.append({ qitemId: row.qitemId, state: "pending", actorSession: "gateway@system", transitionNote: `slack-owner-notification-posted notification_key=${row.qitemId}:1` });
      return row;
    };
    const good = await deliver("update good");
    const bad = await deliver("update bad");
    damage(bad.qitemId, "tags", NOT_JSON);
    const res = await queueApp.request("/api/queue/human-updates");
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<{ qitemId: string; unreadable?: string[] }> };
    expect(body.items.find((r) => r.qitemId === bad.qitemId)!.unreadable).toEqual(["tags"]);
    expect("unreadable" in body.items.find((r) => r.qitemId === good.qitemId)!).toBe(false);
  });

  it("listAttention (the For You lenses) marks the row", async () => {
    const bad = await item("bad");
    db.prepare("UPDATE queue_items SET destination_session = 'human@kernel' WHERE qitem_id = ?").run(bad.qitemId);
    damage(bad.qitemId, "tags", NOT_JSON);
    expect(repo.listAttention({}).find((r) => r.qitemId === bad.qitemId)!.unreadable).toEqual(["tags"]);
  });

  describe("overdue and undelivered listings", () => {
    async function overdue() {
      const row = await item("overdue");
      repo.claim({ qitemId: row.qitemId, destinationSession: B });
      db.prepare("UPDATE queue_items SET closure_required_at = '2000-01-01T00:00:00.000Z' WHERE qitem_id = ?").run(row.qitemId);
      return row;
    }

    it("GET /api/queue/overdue marks a damaged row and serves the rest; the default read refuses by name", async () => {
      const good = await overdue();
      const bad = await overdue();
      damage(bad.qitemId, "tags", NOT_JSON);
      const res = await queueApp.request("/api/queue/overdue");
      expect(res.status).toBe(200);
      const rows = await res.json() as Array<{ qitemId: string; unreadable?: string[] }>;
      expect(rows.find((r) => r.qitemId === bad.qitemId)!.unreadable).toEqual(["tags"]);
      expect("unreadable" in rows.find((r) => r.qitemId === good.qitemId)!).toBe(false);
      expect(() => repo.findOverdue()).toThrow(UnreadableRowError);
    });

    it("GET /api/queue/undelivered marks a damaged row; the default read refuses by name", async () => {
      const good = await item("undelivered good");
      const bad = await item("undelivered bad");
      for (const row of [good, bad]) repo.recordNudgeAttempt(row.qitemId, "failed:fixture");
      damage(bad.qitemId, "tags", NOT_JSON);
      const res = await queueApp.request("/api/queue/undelivered");
      expect(res.status).toBe(200);
      const rows = await res.json() as Array<{ qitemId: string; unreadable?: string[] }>;
      expect(rows.find((r) => r.qitemId === bad.qitemId)!.unreadable).toEqual(["tags"]);
      expect(rows.some((r) => r.qitemId === good.qitemId)).toBe(true);
      expect(() => repo.findUndelivered()).toThrow(UnreadableRowError);
    });

    it("the stuck sweep names each damaged row it skips (overdue, undelivered, unclaimed) and sweeps the rows beside them (it used to fail the whole tick)", async () => {
      const goodOverdue = await overdue();
      const badOverdue = await overdue();
      const badUndelivered = await item("undelivered bad");
      repo.recordNudgeAttempt(badUndelivered.qitemId, "failed:fixture");
      const badUnclaimed = await item("unclaimed bad");
      db.prepare("UPDATE queue_items SET ts_created = '2000-01-01T00:00:00.000Z' WHERE qitem_id = ?").run(badUnclaimed.qitemId);
      for (const row of [badOverdue, badUndelivered, badUnclaimed]) damage(row.qitemId, "tags", NOT_JSON);
      const lines: string[] = [];
      const result = await runStuckSweep({ db, queueRepo: repo, log: (line: string) => lines.push(line), now: new Date("2026-01-01T00:00:00.000Z"), resolveOrchestrator: () => null } as never);
      expect(lines.filter((l) => l.includes("SWEEP FAILED")), lines.join("\n")).toEqual([]);
      for (const row of [badOverdue, badUndelivered, badUnclaimed]) {
        expect(lines, row.qitemId).toContain(`[stuck-sweep] ${row.qitemId} skipped: its saved tags is not readable JSON (repair or remove the row)`);
      }
      expect(JSON.stringify(result)).toContain(goodOverdue.qitemId);
      for (const row of [badOverdue, badUndelivered, badUnclaimed]) expect(JSON.stringify(result), row.qitemId).not.toContain(row.qitemId);
    });

    // Review F1: the by-id lookups of the custody, wait-notice, successor and finding-link steps used to end the whole tick.
    describe("the other by-id lookups name a damaged row and skip it; the good overdue row still gets its finding", () => {
      const sweep = async () => {
        const lines: string[] = [];
        const result = await runStuckSweep({ db, queueRepo: repo, log: (line: string) => lines.push(line), now: new Date("2026-01-01T00:00:00.000Z"), resolveOrchestrator: () => null } as never);
        return { lines, result };
      };
      const skipped = (id: string) => `[stuck-sweep] ${id} skipped: its saved tags is not readable JSON (repair or remove the row)`;
      const closedWithTarget = async (target: string) => {
        const row = await item("closed");
        db.prepare("UPDATE queue_items SET state = 'done', closure_reason = 'handed_off_to', closure_target = ?, ts_updated = '2026-01-01T00:00:00.000Z' WHERE qitem_id = ?").run(target, row.qitemId);
        return row;
      };

      it("custody loop: a recently closed handed_off_to row with damaged tags", async () => {
        const good = await overdue();
        const bad = await closedWithTarget("qitem-gone");
        damage(bad.qitemId, "tags", NOT_JSON);
        const { lines, result } = await sweep();
        expect(lines.filter((l) => l.includes("SWEEP FAILED")), lines.join("\n")).toEqual([]);
        expect(lines).toContain(skipped(bad.qitemId));
        expect(JSON.stringify(result)).toContain(good.qitemId);
        expect(JSON.stringify(result)).not.toContain(bad.qitemId);
      });

      it("successor lookup: a closure whose recorded successor exists but cannot be read counts as having a successor", async () => {
        const good = await overdue();
        const successor = await item("successor");
        const closed = await closedWithTarget(successor.qitemId);
        damage(successor.qitemId, "tags", NOT_JSON);
        const { lines, result } = await sweep();
        expect(lines.filter((l) => l.includes("SWEEP FAILED")), lines.join("\n")).toEqual([]);
        expect(lines).toContain(skipped(successor.qitemId));
        expect(JSON.stringify(result)).toContain(good.qitemId);
        expect(JSON.stringify(result), "the existing successor is not reported dangling").not.toContain(closed.qitemId);
      });

      it("finding link: an existing recovery row whose tags are the wrong shape is skipped, and the stuck row is still refreshed", async () => {
        const stuck = await overdue();
        const recovery = await item("recovery for the stuck row");
        // Valid JSON of the wrong shape: the SQL link scan still finds it, the reader cannot read it.
        damage(recovery.qitemId, "tags", JSON.stringify({ link: `recovery-for:${stuck.qitemId}` }));
        const { lines, result } = await sweep();
        expect(lines.filter((l) => l.includes("SWEEP FAILED")), lines.join("\n")).toEqual([]);
        expect(lines).toContain(skipped(recovery.qitemId));
        expect(result.findings).toContainEqual(expect.objectContaining({ qitemId: stuck.qitemId, findingQitemId: recovery.qitemId, action: "refreshed" }));
      });

      // Same class as review F2b: a row the sweep could not read is not a row that stopped being stuck.
      it("an open finding about a row that has become unreadable stays open (it is not closed as 'no longer detected')", async () => {
        const stuck = await overdue();
        const first = await sweep();
        const findingId = (first.result.findings.find((f) => f.qitemId === stuck.qitemId))!.findingQitemId;
        expect(db.prepare("SELECT state FROM queue_items WHERE qitem_id = ?").get(findingId)).toEqual({ state: "pending" });
        damage(stuck.qitemId, "tags", NOT_JSON);
        const second = await sweep();
        expect(second.lines).toContain(skipped(stuck.qitemId));
        expect(second.result.findings.filter((f) => f.action === "closed")).toEqual([]);
        expect(db.prepare("SELECT state FROM queue_items WHERE qitem_id = ?").get(findingId)).toEqual({ state: "pending" });
        // Control: once repaired and no longer overdue, the same finding IS closed (the close path still works).
        damage(stuck.qitemId, "tags", null);
        db.prepare("UPDATE queue_items SET state = 'done', closure_reason = 'no-follow-on' WHERE qitem_id = ?").run(stuck.qitemId);
        const third = await sweep();
        expect(third.result.findings).toContainEqual(expect.objectContaining({ qitemId: stuck.qitemId, action: "closed" }));
      });

      it("the same for an undelivered-wake finding (the undelivered listing is the only reader of that row)", async () => {
        const stuck = await item("undelivered");
        repo.recordNudgeAttempt(stuck.qitemId, "failed:fixture");
        const first = await sweep();
        const found = first.result.findings.find((f) => f.qitemId === stuck.qitemId);
        expect(found?.kind).toBe("undelivered-wake");
        damage(stuck.qitemId, "tags", NOT_JSON);
        const second = await sweep();
        expect(second.lines).toContain(skipped(stuck.qitemId));
        expect(second.result.findings.filter((f) => f.action === "closed")).toEqual([]);
        expect(db.prepare("SELECT state FROM queue_items WHERE qitem_id = ?").get(found!.findingQitemId)).toEqual({ state: "pending" });
      });

      it("the same for an unclaimed-obligation finding (the by-id unclaimed loop is the only reader of that row)", async () => {
        const stuck = await item("unclaimed");
        db.prepare("UPDATE queue_items SET ts_created = '2000-01-01T00:00:00.000Z' WHERE qitem_id = ?").run(stuck.qitemId);
        const first = await sweep();
        const found = first.result.findings.find((f) => f.qitemId === stuck.qitemId);
        expect(found?.kind).toBe("unclaimed-obligation");
        damage(stuck.qitemId, "tags", NOT_JSON);
        const second = await sweep();
        expect(second.lines).toContain(skipped(stuck.qitemId));
        expect(second.result.findings.filter((f) => f.action === "closed")).toEqual([]);
        expect(db.prepare("SELECT state FROM queue_items WHERE qitem_id = ?").get(found!.findingQitemId)).toEqual({ state: "pending" });
      });

      it("a finding row whose tags are valid JSON of the wrong shape is skipped by name; it does not end the tick", async () => {
        const good = await overdue();
        const odd = await item("odd finding");
        damage(odd.qitemId, "tags", JSON.stringify({ kind: "stuck-sweep-finding", dedup: "stuck-sweep:overdue-claim:qitem-x" }));
        const { lines, result } = await sweep();
        expect(lines.filter((l) => l.includes("SWEEP FAILED")), lines.join("\n")).toEqual([]);
        expect(lines).toContain(`[stuck-sweep] ${odd.qitemId} skipped: its saved tags is not a readable list (repair or remove the row)`);
        expect(JSON.stringify(result)).toContain(good.qitemId);
        expect(db.prepare("SELECT state FROM queue_items WHERE qitem_id = ?").get(odd.qitemId)).toEqual({ state: "pending" });
      });

      it("wait-notice loop: a blocked row bound to an overdue wait timer with damaged tags", async () => {
        const good = await overdue();
        const bad = await item("blocked");
        db.prepare("UPDATE queue_items SET state = 'blocked' WHERE qitem_id = ?").run(bad.qitemId);
        const job = new WatchdogJobsRepository(db).register({
          policy: "periodic-reminder", targetSession: "b@rig", registeredBySession: "ops@rig", intervalSeconds: 600,
          specYaml: JSON.stringify({ context: { queue_wait: { notice: { at: "2000-01-01T00:00:00.000Z", deliveryStatus: "failed" } } } }),
        });
        db.prepare("INSERT INTO queue_transition_wakes (transition_id, qitem_id, phase, wake_kind, wake_ref) VALUES (1, ?, 'armed', 'watchdog', ?)").run(bad.qitemId, job.jobId);
        damage(bad.qitemId, "tags", NOT_JSON);
        const { lines, result } = await sweep();
        expect(lines.filter((l) => l.includes("SWEEP FAILED")), lines.join("\n")).toEqual([]);
        expect(lines).toContain(skipped(bad.qitemId));
        expect(JSON.stringify(result)).toContain(good.qitemId);
      });
    });
  });
});

describe("inbox: a damaged entry is flagged in the listings and refuses to be absorbed", () => {
  let inbox: InboxHandler;
  beforeEach(() => { inbox = inboxHandler; });

  it("listPending and listForDestination mark the entry (and the routes serve 200); absorb refuses by name and writes nothing", async () => {
    const good = inbox.drop({ destinationSession: B, senderSession: A, body: "good" });
    const bad = inbox.drop({ destinationSession: B, senderSession: A, body: "bad", tags: ["t"] });
    db.prepare("UPDATE inbox_entries SET tags = ? WHERE inbox_id = ?").run(NOT_JSON, bad.inboxId);
    for (const read of [() => inbox.listPending(B), () => inbox.listForDestination(B)]) {
      const rows = read();
      expect(rows.find((r) => r.inboxId === bad.inboxId)).toMatchObject({ unreadable: ["tags"], tags: null });
      expect("unreadable" in rows.find((r) => r.inboxId === good.inboxId)!).toBe(false);
    }
    expect((await queueApp.request(`/api/queue/inbox/pending?destinationSession=${B}`)).status).toBe(200);
    expect((await queueApp.request(`/api/queue/inbox/list?destinationSession=${B}`)).status).toBe(200);
    const before = (db.prepare("SELECT count(*) AS n FROM queue_items").get() as { n: number }).n;
    await expect(inbox.absorb(bad.inboxId, B)).rejects.toBeInstanceOf(UnreadableRowError);
    // Review N1: the route answers the same refusal as 422, not 500 internal_error.
    const routed = await queueApp.request(`/api/queue/inbox/${bad.inboxId}/absorb`, { method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": B }, body: "{}" });
    expect(routed.status).toBe(422);
    expect(await routed.json()).toMatchObject({ code: "saved_row_unreadable", table: "inbox_entries", rowId: bad.inboxId });
    expect((db.prepare("SELECT count(*) AS n FROM queue_items").get() as { n: number }).n).toBe(before);
    expect((db.prepare("SELECT state FROM inbox_entries WHERE inbox_id = ?").get(bad.inboxId) as { state: string }).state).toBe("pending");
    // Control: the readable entry is absorbed.
    await expect(inbox.absorb(good.inboxId, B)).resolves.toMatchObject({ qitemId: expect.any(String) });
  });
});

describe("outbox: a damaged entry is flagged, held-message listings name the damage, and the wake drain skips what it cannot read", () => {
  let outbox: OutboxHandler;
  beforeEach(() => { outbox = outboxHandler; });

  it("listForSender marks an entry with damaged tags; getById refuses by name", () => {
    outbox.record({ outboxId: "ob-good", senderSession: A, destinationSession: B, body: "g", tags: ["t"] });
    outbox.record({ outboxId: "ob-bad", senderSession: A, destinationSession: B, body: "b", tags: ["t"] });
    db.prepare("UPDATE outbox_entries SET tags = ? WHERE outbox_id = 'ob-bad'").run(NOT_JSON);
    const rows = outbox.listForSender(A);
    expect(rows.find((r) => r.outboxId === "ob-bad")).toMatchObject({ unreadable: ["tags"], tags: null });
    expect("unreadable" in rows.find((r) => r.outboxId === "ob-good")!).toBe(false);
    expect(() => outbox.getById("ob-bad")).toThrow(UnreadableRowError);
  });

  it("a damaged guard_binding refuses by name on a by-id read (a guard compares it)", () => {
    outbox.record({ outboxId: "ob-held", senderSession: A, destinationSession: B, body: "h" });
    db.prepare("UPDATE outbox_entries SET delivery_state = 'retained', guard_binding = ? WHERE outbox_id = 'ob-held'").run(NOT_JSON);
    expect(() => outbox.getById("ob-held")).toThrow(expect.objectContaining({ table: "outbox_entries", rowId: "ob-held", columns: ["guard_binding"] }));
  });

  it("heldForNode and the retention quota survive a retained row whose binding is not JSON, and the listing names it", () => {
    const hold = (id: string, binding: string) => {
      outbox.record({ outboxId: id, senderSession: A, destinationSession: B, body: id });
      db.prepare("UPDATE outbox_entries SET delivery_state = 'retained', guard_binding = ? WHERE outbox_id = ?").run(binding, id);
    };
    hold("held-good", JSON.stringify({ nodeId: "n1", session: B, occupant: null, pane: null }));
    hold("held-bad", NOT_JSON);
    const held = outbox.heldForNode("n1");
    expect(held.items.map((r) => r.outboxId)).toEqual(["held-good"]);
    expect(held.total).toBe(1);
    expect(held.unreadableHeld).toEqual(["held-bad"]);
    expect(() => outbox.assertRetentionCapacity("n1", "body")).not.toThrow();
    // Control: nothing damaged, nothing named.
    db.prepare("DELETE FROM outbox_entries WHERE outbox_id = 'held-bad'").run();
    expect(outbox.heldForNode("n1").unreadableHeld).toEqual([]);
  });

  it("heldForNode serves a held message whose binding is readable but whose tags are not, flagged, beside the intact one", () => {
    const binding = JSON.stringify({ nodeId: "n1", session: B, occupant: null, pane: null });
    for (const id of ["held-intact", "held-bad-tags"]) {
      outbox.record({ outboxId: id, senderSession: A, destinationSession: B, body: id, tags: ["t"] });
      db.prepare("UPDATE outbox_entries SET delivery_state = 'retained', guard_binding = ? WHERE outbox_id = ?").run(binding, id);
    }
    db.prepare("UPDATE outbox_entries SET tags = ? WHERE outbox_id = 'held-bad-tags'").run(NOT_JSON);
    const held = outbox.heldForNode("n1");
    expect(held.items.map((r) => r.outboxId).sort()).toEqual(["held-bad-tags", "held-intact"]);
    expect(held.items.find((r) => r.outboxId === "held-bad-tags")).toMatchObject({ unreadable: ["tags"], tags: null });
    expect("unreadable" in held.items.find((r) => r.outboxId === "held-intact")!).toBe(false);
  });

  it("drainPendingWakeIntents delivers the readable intent, leaves the damaged one pending and names it (it used to end the drain)", async () => {
    const sent: string[] = [];
    const transport: QueueNudgeTransport = { async send(session) { sent.push(session); return { ok: true, verified: true }; } };
    const drainRepo = new QueueRepository(db, setup.eventBus, { validateRig: () => true });
    drainRepo.attachOutbox(outbox);
    const source = await drainRepo.create({ nudge: false, sourceSession: "planner@rig", destinationSession: "driver@rig", body: "x" });
    const first = (await drainRepo.handoff({ qitemId: source.qitemId, fromSession: "driver@rig", toSession: "reviewer@rig", body: "y" })).created;
    const secondSource = await drainRepo.create({ nudge: false, sourceSession: "planner@rig", destinationSession: "driver@rig", body: "x2" });
    const second = (await drainRepo.handoff({ qitemId: secondSource.qitemId, fromSession: "driver@rig", toSession: "other@rig", body: "y2" })).created;
    // Both intents committed and pending (no transport yet: the crash window).
    expect(outbox.getById(`wake-intent-${first.qitemId}`)!.deliveryState).toBe("pending");
    db.prepare("UPDATE outbox_entries SET tags = ? WHERE outbox_id = ?").run(NOT_JSON, `wake-intent-${first.qitemId}`);
    drainRepo.attachTransport(transport);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const tally = await drainRepo.drainPendingWakeIntents();
    errors.mockRestore();
    expect(tally).toMatchObject({ delivered: 1, unreadable: [`wake-intent-${first.qitemId}`] });
    expect(sent).toEqual(["other@rig"]);
    expect((db.prepare("SELECT delivery_state FROM outbox_entries WHERE outbox_id = ?").get(`wake-intent-${first.qitemId}`) as { delivery_state: string }).delivery_state).toBe("pending");
    expect(outbox.getById(`wake-intent-${second.qitemId}`)!.deliveryState).toBe("delivered");
    // Control: once the row is repaired the same drain delivers it, and the tally has no unreadable key.
    db.prepare("UPDATE outbox_entries SET tags = NULL WHERE outbox_id = ?").run(`wake-intent-${first.qitemId}`);
    const repaired = await drainRepo.drainPendingWakeIntents();
    expect(repaired.delivered).toBe(1);
    expect("unreadable" in repaired).toBe(false);
    expect(sent).toEqual(["other@rig", "reviewer@rig"]);
  });

  it("a wake intent is delivered even when a pending peer to the same destination has tags that are not JSON (the correlation scan skips it)", async () => {
    const sent: string[] = [];
    const transport: QueueNudgeTransport = { async send(session) { sent.push(session); return { ok: true, verified: true }; } };
    const drainRepo = new QueueRepository(db, setup.eventBus, { validateRig: () => true });
    drainRepo.attachOutbox(outbox);
    const target = await drainRepo.create({ nudge: false, sourceSession: "planner@rig", destinationSession: "owner@rig", body: "target" });
    outbox.record({ outboxId: `wake-intent-${target.qitemId}`, senderSession: "planner@rig", destinationSession: "owner@rig", body: "wake", tags: ["queue:return:c1"], auditPointer: target.qitemId });
    outbox.record({ outboxId: "wake-intent-peer", senderSession: "planner@rig", destinationSession: "owner@rig", body: "wake", tags: ["queue:return:c1"], auditPointer: target.qitemId });
    db.prepare("UPDATE outbox_entries SET tags = ? WHERE outbox_id = 'wake-intent-peer'").run(NOT_JSON);
    drainRepo.attachTransport(transport);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const tally = await drainRepo.drainPendingWakeIntents();
    errors.mockRestore();
    expect(tally.delivered).toBe(1);
    expect(tally.unreadable).toEqual(["wake-intent-peer"]);
    expect(sent).toEqual(["owner@rig"]);
  });
});

describe("watchdog history: the status route serves a damaged entry flagged; the policy's read refuses by name", () => {
  const NOTES = JSON.stringify({ deliveryReason: "fixture" });
  function seedHistory() {
    const jobs = new WatchdogJobsRepository(db);
    const job = jobs.register({ policy: "periodic-reminder", specYaml: "message: m\n", targetSession: "owner@rig", registeredBySession: "ops@rig", intervalSeconds: 600 });
    const log = new WatchdogHistoryLog(db);
    const entry = (evaluatedAt: string, notes: string | null) => {
      const row = log.record({ jobId: job.jobId, evaluatedAt, outcome: "sent", deliveryStatus: "ok", evaluationNotes: { n: 1 } });
      db.prepare("UPDATE watchdog_history SET evaluation_notes = ? WHERE history_id = ?").run(notes, row.historyId);
      return row;
    };
    return { jobs, log, job, good: entry("2026-01-01T00:00:01.000Z", NOTES), bad: entry("2026-01-01T00:00:02.000Z", NOT_JSON) };
  }

  it("GET /:job/status is 200 with the damaged entry flagged unreadable and the readable one intact", async () => {
    const { jobs, log, job, good, bad } = seedHistory();
    const app = new Hono();
    app.onError(jsonBodyErrorHandler);
    app.use("*", async (c, next) => { c.set("watchdogJobsRepo" as never, jobs); c.set("watchdogHistoryLog" as never, log); c.set("eventBus" as never, setup.eventBus); await next(); });
    app.route("/api/watchdog", watchdogRoutes());
    const res = await app.request(`/api/watchdog/${job.jobId}/status`);
    expect(res.status).toBe(200);
    const body = await res.json() as { recentHistory: Array<{ historyId: string; evaluationNotes: unknown; unreadable?: string[] }> };
    expect(body.recentHistory.find((h) => h.historyId === bad.historyId)).toMatchObject({ evaluationNotes: null, unreadable: ["evaluation_notes"] });
    const intact = body.recentHistory.find((h) => h.historyId === good.historyId)!;
    expect(intact.evaluationNotes).toEqual({ deliveryReason: "fixture" });
    expect("unreadable" in intact).toBe(false);
  });

  it("listForJob / listAll (the parked-owner policy reconciles from the notes) refuse by name, with the entry id and column", () => {
    const { log, job, bad } = seedHistory();
    expect(() => log.listForJob(job.jobId, 10)).toThrow(expect.objectContaining({ name: "UnreadableRowError", table: "watchdog_history", rowId: bad.historyId, columns: ["evaluation_notes"] }));
    expect(() => log.listAll()).toThrow(UnreadableRowError);
    // Control: NULL notes are not damage.
    db.prepare("UPDATE watchdog_history SET evaluation_notes = NULL").run();
    expect(log.listForJob(job.jobId, 10)).toHaveLength(2);
  });
});

describe("SQL filters over saved JSON columns skip a damaged row instead of ending the query", () => {
  it("the audit browse's scope filters (json_extract of audit_notes_json) skip a damaged row; the readable match is served", async () => {
    const q = await item("audited");
    const log = new MissionControlActionLog(db);
    const input = { actionVerb: "approve" as const, qitemId: q.qitemId, actorSession: "alice@r", beforeState: { a: 1 }, afterState: { a: 2 } };
    const good = log.record({ ...input, actedAt: "2026-05-04T03:00:00.000Z", auditNotes: { scope_tier: "mission", scope_id: "m1", scope_path: "p/m1", approval_scope: "all" } });
    const bad = log.record({ ...input, actedAt: "2026-05-04T03:01:00.000Z", auditNotes: { scope_tier: "mission" } });
    db.prepare("UPDATE mission_control_actions SET audit_notes_json = ? WHERE action_id = ?").run(NOT_JSON, bad.actionId);
    const browse = new MissionControlAuditBrowse(db);
    for (const filter of [{ scopeTier: "mission" }, { scopeId: "m1" }, { scopePath: "p/m1" }, { approvalScope: "all" }]) {
      expect(browse.query(filter).rows.map((r) => r.actionId), JSON.stringify(filter)).toEqual([good.actionId]);
    }
  });

  it("the stream's hint-tag filter (json_each of hint_tags) skips a damaged row; the readable match is served", () => {
    const stream = new StreamStore(db, setup.eventBus);
    const good = stream.emit({ sourceSession: "a@r", body: "x", hintTags: ["t"] });
    const bad = stream.emit({ sourceSession: "a@r", body: "y", hintTags: ["t"] });
    db.prepare("UPDATE stream_items SET hint_tags = ? WHERE stream_item_id = ?").run(NOT_JSON, bad.streamItemId);
    expect(stream.list({ hintTag: "t" }).map((i) => i.streamItemId)).toEqual([good.streamItemId]);
  });
});
