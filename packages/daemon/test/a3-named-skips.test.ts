// OF-168 (a3): a filter that runs over a saved JSON column cannot match a row whose column is not JSON (json_valid() AND ...), so the
// row drops out of the filtered result. Which rows match is unchanged; the filtered result now NAMES the rows it could not read
// (in the result, the coverage row or the log), so a filtered listing or count is not read as complete. Jim, 2026-10-28.
//
// One input of one site per row, each beside a control with nothing damaged:
//   audit browse scope filters -> `unreadableAuditNotes` on the result (routes/mission-control.ts GET /audit serves the result)
//   queue list --tag           -> log line (callers: health-diagnosis.ts, health-passive-ceremony.ts)
//   stream list hintTag        -> log line
//   RSI event-threshold detectors -> `note` on the coverage row
// (The stuck sweep's seat-target successor check is named in queue-stuck-sweep.test.ts, beside its other rows.)
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueueNudgeTransport } from "../src/domain/queue-repository.js";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { StreamStore } from "../src/domain/stream-store.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { MissionControlAuditBrowse } from "../src/domain/mission-control/audit-browse.js";
import { createPermissionStallSource } from "../src/domain/rsi/event-sources.js";
import { HealthProjectionService } from "../src/domain/health-detectors.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { createCompactionStormSource } from "../src/domain/rsi/event-sources.js";
import { OutboxUnsettledSource } from "../src/domain/rsi/outbox-source.js";
import { namedRows, nameRowsThrottled, resetNamedRowThrottle } from "../src/domain/named-rows.js";
import { cleanupFixtures, fixture, stamp } from "./rsi-a2b-fixture.js";

const NOT_JSON = "{not json";
const A = "a@rig";
const B = "b@rig";

describe("audit browse scope filters", () => {
  let db: Database.Database;
  let log: MissionControlActionLog;
  let browse: MissionControlAuditBrowse;
  let qitemId: string;
  beforeEach(async () => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    qitemId = (await repo.create({ sourceSession: A, destinationSession: B, body: "audited", nudge: false })).qitemId;
    log = new MissionControlActionLog(db);
    browse = new MissionControlAuditBrowse(db);
  });
  afterEach(() => db.close());

  const record = (actedAt: string, actorSession: string, auditNotes: Record<string, unknown>) =>
    log.record({ actionVerb: "approve", qitemId, actorSession, beforeState: { a: 1 }, afterState: { a: 2 }, actedAt, auditNotes });
  const damage = (actionId: string) => db.prepare("UPDATE mission_control_actions SET audit_notes_json = ? WHERE action_id = ?").run(NOT_JSON, actionId);
  const NOTES = { scope_tier: "mission", scope_id: "m1", scope_path: "p/m1", approval_scope: "all" };

  it.each([{ scopeTier: "mission" }, { scopeId: "m1" }, { scopePath: "p/m1" }, { approvalScope: "all" }])(
    "a scope filter %o names the damaged row; the matching rows are exactly the readable match", (filter) => {
      const good = record("2026-05-04T03:00:00.000Z", "alice@r", NOTES);
      const bad = record("2026-05-04T03:01:00.000Z", "alice@r", { scope_tier: "mission" });
      damage(bad.actionId);

      const result = browse.query(filter);

      expect(result.rows.map((r) => r.actionId)).toEqual([good.actionId]);
      expect(result.unreadableAuditNotes).toEqual([bad.actionId]);
    });

  it("control: with no scope filter the damaged row is listed and nothing is named", () => {
    const good = record("2026-05-04T03:00:00.000Z", "alice@r", NOTES);
    const bad = record("2026-05-04T03:01:00.000Z", "alice@r", NOTES);
    damage(bad.actionId);

    const result = browse.query({});

    expect(result.rows.map((r) => r.actionId).sort()).toEqual([good.actionId, bad.actionId].sort());
    expect("unreadableAuditNotes" in result).toBe(false);
  });

  it("control: a scope filter over nothing damaged names nothing", () => {
    record("2026-05-04T03:00:00.000Z", "alice@r", NOTES);

    expect("unreadableAuditNotes" in browse.query({ scopeTier: "mission" })).toBe(false);
  });

  it("only damaged rows that match every OTHER filter are named (actor, window, cursor)", () => {
    const mine = record("2026-05-04T03:00:00.000Z", "alice@r", NOTES);
    const theirs = record("2026-05-04T03:01:00.000Z", "bob@r", NOTES);
    const early = record("2026-05-01T03:00:00.000Z", "alice@r", NOTES);
    damage(mine.actionId);
    damage(theirs.actionId);
    damage(early.actionId);

    expect(browse.query({ scopeTier: "mission", actorSession: "alice@r", since: "2026-05-03T00:00:00.000Z" }).unreadableAuditNotes).toEqual([mine.actionId]);
    expect(browse.query({ scopeTier: "mission", actorSession: "carol@r" }).unreadableAuditNotes, "no row of that actor").toBeUndefined();
    // The cursor is insertion order (rowid): `mine` was recorded first, `early` last.
    expect(browse.query({ scopeTier: "mission", beforeId: early.actionId, actorSession: "alice@r" }).unreadableAuditNotes, "only rows before the cursor").toEqual([mine.actionId]);
    expect(browse.query({ scopeTier: "mission", beforeId: mine.actionId, actorSession: "alice@r" }).unreadableAuditNotes, "nothing before the first row").toBeUndefined();
  });

  it("a NULL audit_notes_json is not damage", () => {
    const row = record("2026-05-04T03:00:00.000Z", "alice@r", NOTES);
    db.prepare("UPDATE mission_control_actions SET audit_notes_json = NULL WHERE action_id = ?").run(row.actionId);

    expect("unreadableAuditNotes" in browse.query({ scopeTier: "mission" })).toBe(false);
  });

  it("at most 20 damaged rows are named, newest first, and the rest are counted", () => {
    const ids: string[] = [];
    for (let i = 0; i < 22; i += 1) {
      const row = record(`2026-05-04T03:${String(i).padStart(2, "0")}:00.000Z`, "alice@r", NOTES);
      damage(row.actionId);
      ids.push(row.actionId);
    }

    const result = browse.query({ scopeTier: "mission" });

    expect(result.unreadableAuditNotes).toHaveLength(20);
    expect(result.unreadableAuditNotes![0]).toBe(ids[21]);
    expect(result.unreadableAuditNotesMore).toBe(2);
  });

  it("the 'more' count is of the rows that match the other filters, not of every damaged row", () => {
    for (let i = 0; i < 21; i += 1) damage(record(`2026-05-04T03:${String(i).padStart(2, "0")}:00.000Z`, "alice@r", NOTES).actionId);
    for (let i = 0; i < 3; i += 1) damage(record(`2026-05-04T04:${String(i).padStart(2, "0")}:00.000Z`, "bob@r", NOTES).actionId);

    const result = browse.query({ scopeTier: "mission", actorSession: "alice@r" });

    expect(result.unreadableAuditNotes).toHaveLength(20);
    expect(result.unreadableAuditNotesMore).toBe(1);
  });

  it("exactly 20 damaged rows are all named, with no 'more' marker", () => {
    for (let i = 0; i < 20; i += 1) damage(record(`2026-05-04T03:${String(i).padStart(2, "0")}:00.000Z`, "alice@r", NOTES).actionId);

    const result = browse.query({ scopeTier: "mission" });

    expect(result.unreadableAuditNotes).toHaveLength(20);
    expect("unreadableAuditNotesMore" in result).toBe(false);
  });
});

describe("queue list --tag", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let lines: string[];
  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    resetNamedRowThrottle();
    lines = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => { lines.push(String(line)); });
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); db.close(); });

  const item = (tags: string[]) => repo.create({ sourceSession: A, destinationSession: B, body: "x", tags, nudge: false });
  const damageTags = (qitemId: string, text: string) => db.prepare("UPDATE queue_items SET tags = ? WHERE qitem_id = ?").run(text, qitemId);
  const named = () => lines.filter((line) => line.includes("[queue] list --tag"));

  it("names the row whose damaged tags still carry the quoted tag text; the listing is the readable matches only", async () => {
    const good = await item(["health-diagnosis"]);
    const bad = await item(["health-diagnosis"]);
    damageTags(bad.qitemId, '["health-diagnosis"');

    const rows = repo.list({ tag: "health-diagnosis" });

    expect(rows.map((r) => r.qitemId)).toEqual([good.qitemId]);
    expect(named()).toHaveLength(1);
    expect(named()[0]).toContain(bad.qitemId);
    expect(named()[0]).toContain("saved tags are not readable JSON");
  });

  it("names at most 20 rows and counts the rest", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 22; i += 1) {
      const row = await item(["health-diagnosis"]);
      damageTags(row.qitemId, '["health-diagnosis"');
      ids.push(row.qitemId);
    }
    // findDamagedTagRows lists oldest first (ts_created, qitem_id): make that order the insertion order.
    ids.forEach((id, i) => db.prepare("UPDATE queue_items SET ts_created = ? WHERE qitem_id = ?").run(`2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`, id));

    repo.list({ tag: "health-diagnosis" });

    expect(named()).toHaveLength(1);
    expect(named()[0]).toContain("and 2 more");
    expect(named()[0]).toContain(ids[19]!);
    expect(named()[0]).not.toContain(ids[20]!);
    expect(named()[0]).not.toContain(ids[21]!);
  });

  it("names a row once per 10 minutes, not on every call; a new damaged row is named at once, and the old one again after 10 minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2031-01-01T00:00:00.000Z"));
    const first = await item(["health-diagnosis"]);
    damageTags(first.qitemId, '["health-diagnosis"');

    repo.list({ tag: "health-diagnosis" });
    repo.list({ tag: "health-diagnosis" });
    vi.setSystemTime(new Date("2031-01-01T00:09:59.000Z"));
    repo.list({ tag: "health-diagnosis" });
    expect(named(), "one line for the first row however often it is listed").toHaveLength(1);

    const second = await item(["health-diagnosis"]);
    damageTags(second.qitemId, '["health-diagnosis"');
    repo.list({ tag: "health-diagnosis" });
    expect(named()).toHaveLength(2);
    expect(named()[1]).toContain(second.qitemId);
    expect(named()[1], "only the row that is due").not.toContain(first.qitemId);

    vi.setSystemTime(new Date("2031-01-01T00:10:01.000Z"));
    repo.list({ tag: "health-diagnosis" });
    expect(named()).toHaveLength(3);
    expect(named()[2]).toContain(first.qitemId);
  });

  it("control: nothing damaged, nothing named", async () => {
    await item(["health-diagnosis"]);

    repo.list({ tag: "health-diagnosis" });

    expect(named()).toEqual([]);
  });

  it("a damaged row for another tag, or only a prefix of this one, is not named", async () => {
    const other = await item(["other"]);
    damageTags(other.qitemId, '["other"');
    const longer = await item(["health-diagnosis-x"]);
    damageTags(longer.qitemId, '["health-diagnosis-x"');

    repo.list({ tag: "health-diagnosis" });

    expect(named()).toEqual([]);
  });

  it("a listing with no tag filter names nothing, even with a damaged row", async () => {
    const bad = await item(["health-diagnosis"]);
    damageTags(bad.qitemId, '["health-diagnosis"');

    repo.list({});

    expect(named()).toEqual([]);
  });
});

describe("stream list hintTag", () => {
  let db: Database.Database;
  let stream: StreamStore;
  let lines: string[];
  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    stream = new StreamStore(db, new EventBus(db));
    resetNamedRowThrottle();
    lines = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => { lines.push(String(line)); });
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); db.close(); });

  const named = () => lines.filter((line) => line.includes("[stream] list hintTag"));
  const damage = (streamItemId: string, text: string) => db.prepare("UPDATE stream_items SET hint_tags = ? WHERE stream_item_id = ?").run(text, streamItemId);

  it("names the item whose damaged hint_tags still carry the quoted tag; the matches are the readable ones", () => {
    const good = stream.emit({ sourceSession: "a@r", body: "x", hintTags: ["t"] });
    const bad = stream.emit({ sourceSession: "a@r", body: "y", hintTags: ["t"] });
    damage(bad.streamItemId, '["t"');

    const items = stream.list({ hintTag: "t" });

    expect(items.map((i) => i.streamItemId)).toEqual([good.streamItemId]);
    expect(named()).toHaveLength(1);
    expect(named()[0]).toContain(bad.streamItemId);
  });

  it("names at most 20 items and counts the rest", () => {
    const ids: string[] = [];
    for (let i = 0; i < 22; i += 1) {
      const row = stream.emit({ sourceSession: "a@r", body: `x${i}`, hintTags: ["t"] });
      damage(row.streamItemId, '["t"');
      ids.push(row.streamItemId);
    }
    db.prepare("UPDATE stream_items SET ts_emitted = '2026-01-01T00:00:00.000Z'").run();
    ids.forEach((id, i) => db.prepare("UPDATE stream_items SET stream_sort_key = ? WHERE stream_item_id = ?").run(`k-${String(i).padStart(2, "0")}`, id));

    stream.list({ hintTag: "t" });

    expect(named()).toHaveLength(1);
    expect(named()[0]).toContain("and 2 more");
    expect(named()[0]).toContain(ids[19]!);
    expect(named()[0]).not.toContain(ids[20]!);
    expect(named()[0]).not.toContain(ids[21]!);
  });

  it("names an item once per 10 minutes, not on every call", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2031-01-01T00:00:00.000Z"));
    const bad = stream.emit({ sourceSession: "a@r", body: "y", hintTags: ["t"] });
    damage(bad.streamItemId, '["t"');

    stream.list({ hintTag: "t" });
    stream.list({ hintTag: "t" });
    expect(named()).toHaveLength(1);

    vi.setSystemTime(new Date("2031-01-01T00:10:01.000Z"));
    stream.list({ hintTag: "t" });
    expect(named()).toHaveLength(2);
  });

  it("control: nothing damaged, nothing named", () => {
    stream.emit({ sourceSession: "a@r", body: "x", hintTags: ["t"] });

    stream.list({ hintTag: "t" });

    expect(named()).toEqual([]);
  });

  it("only a damaged item that matches every other filter is named (source session)", () => {
    const mine = stream.emit({ sourceSession: "a@r", body: "x", hintTags: ["t"] });
    const theirs = stream.emit({ sourceSession: "b@r", body: "y", hintTags: ["t"] });
    damage(mine.streamItemId, '["t"');
    damage(theirs.streamItemId, '["t"');

    stream.list({ hintTag: "t", sourceSession: "a@r" });

    expect(named()).toHaveLength(1);
    expect(named()[0]).toContain(mine.streamItemId);
    expect(named()[0]).not.toContain(theirs.streamItemId);
  });

  it("a different tag, a prefix of the tag, and a listing without a hintTag name nothing", () => {
    const other = stream.emit({ sourceSession: "a@r", body: "x", hintTags: ["tt"] });
    damage(other.streamItemId, '["tt"');

    stream.list({ hintTag: "t" });
    stream.list({});

    expect(named()).toEqual([]);
  });
});

describe("RSI event-threshold detectors (D9 permission stall)", () => {
  afterEach(cleanupFixtures);
  const needsInput = (f: ReturnType<typeof fixture>, hoursAgo: number) =>
    f.activity({ seat: "seat-a@r", rawEvent: "Notification", rawSubtype: null, state: "needs_input", hoursAgo });
  const noteOf = (f: ReturnType<typeof fixture>) => {
    const service = new HealthProjectionService([createPermissionStallSource(f.deps())]);
    return { records: service.records(), coverage: service.coverage()[0] };
  };

  it("says how many events in the window were not judged because their payload is not JSON, with their seq range; the findings are unchanged", () => {
    const f = fixture();
    for (let i = 1; i <= 8; i += 1) needsInput(f, i);
    const before = noteOf(f).records;
    const first = f.event("agent.activity", NOT_JSON, stamp(3));
    const last = f.event("agent.activity", "[1,", stamp(2));

    const { records, coverage } = noteOf(f);

    expect(coverage).toMatchObject({ note: `2 agent.activity event(s) in the window (seq ${first} to ${last}) have a payload that is not readable JSON and were not judged (a damaged payload cannot be classified, so this may include events the detector would have ignored); the counts above leave them out. Repair or remove the event rows.` });
    expect(records).toEqual(before);
    expect(records).toHaveLength(1);
  });

  it("control: nothing damaged, no note", () => {
    const f = fixture();
    for (let i = 1; i <= 3; i += 1) needsInput(f, i);

    expect(noteOf(f).coverage).not.toHaveProperty("note");
  });

  it("a damaged event outside the window, or of another event type, is not counted", () => {
    const f = fixture();
    needsInput(f, 1);
    f.event("agent.activity", NOT_JSON, stamp(30));
    f.event("agent.activity_shadow", NOT_JSON, stamp(2));

    expect(noteOf(f).coverage).not.toHaveProperty("note");
  });
});

describe("named-rows helper", () => {
  beforeEach(resetNamedRowThrottle);

  it("namedRows spells out the first 20 and counts the rest", () => {
    const ids = Array.from({ length: 25 }, (_, i) => `r${i}`);
    expect(namedRows(ids)).toBe(`${ids.slice(0, 20).join(", ")} and 5 more`);
    expect(namedRows(ids.slice(0, 20))).toBe(ids.slice(0, 20).join(", "));
    expect(namedRows(["a", "b"], 7)).toBe("a, b and 5 more");
  });

  it("nameRowsThrottled emits the ids that are due, and nothing when none is; scopes are independent", () => {
    const seen: string[][] = [];
    const emit = (due: string[]) => { seen.push(due); };
    nameRowsThrottled("s1", ["a", "b"], emit, 1_000);
    nameRowsThrottled("s1", ["a", "b"], emit, 1_000 + 599_999);
    nameRowsThrottled("s1", ["a", "c"], emit, 1_000 + 599_999);
    nameRowsThrottled("s2", ["a"], emit, 1_000 + 599_999);
    nameRowsThrottled("s1", ["a"], emit, 1_000 + 600_000);

    expect(seen).toEqual([["a", "b"], ["c"], ["a"], ["a"]]);
  });
});

describe("wake-intent grouping: a pending peer whose tags are not JSON is named when it is not coalesced", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let outbox: OutboxHandler;
  let lines: string[];
  let sent: string[];
  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    resetNamedRowThrottle();
    outbox = new OutboxHandler(db);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    repo.attachOutbox(outbox);
    sent = [];
    const transport: QueueNudgeTransport = { async send(session) { sent.push(session); return { ok: true, verified: true }; } };
    repo.attachTransport(transport);
    lines = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => { lines.push(String(line)); });
  });
  afterEach(() => { vi.restoreAllMocks(); db.close(); });

  const groupLines = () => lines.filter((line) => line.includes("[queue] wake group"));
  async function seed(peerTags: string) {
    const target = await repo.create({ nudge: false, sourceSession: "planner@rig", destinationSession: "owner@rig", body: "target" });
    outbox.record({ outboxId: `wake-intent-${target.qitemId}`, senderSession: "planner@rig", destinationSession: "owner@rig", body: "wake", tags: ["queue:return:c1"], auditPointer: target.qitemId });
    outbox.record({ outboxId: "wake-intent-peer", senderSession: "planner@rig", destinationSession: "owner@rig", body: "wake", tags: ["queue:return:c1"], auditPointer: target.qitemId });
    db.prepare("UPDATE outbox_entries SET tags = ? WHERE outbox_id = 'wake-intent-peer'").run(peerTags);
    return target;
  }

  it("names the peer whose damaged tags still carry the correlation tag; the wake is delivered and the peer is not grouped", async () => {
    await seed('["queue:return:c1"');

    const tally = await repo.drainPendingWakeIntents();

    expect(tally.delivered).toBe(1);
    expect(sent).toEqual(["owner@rig"]);
    expect(groupLines()).toHaveLength(1);
    expect(groupLines()[0]).toContain("wake-intent-peer");
    expect(groupLines()[0]).toContain("saved tags are not readable JSON");
  });

  it("names it once per 10 minutes, not on every drain", async () => {
    await seed('["queue:return:c1"');

    await repo.drainPendingWakeIntents();
    await repo.drainPendingWakeIntents();

    expect(groupLines()).toHaveLength(1);
  });

  it("control: a damaged peer whose tags no longer carry the correlation text, or a readable group, names nothing", async () => {
    await seed("{not json");
    await repo.drainPendingWakeIntents();
    expect(groupLines()).toEqual([]);
  });
});

describe("RSI cross-check and outbox detector", () => {
  afterEach(cleanupFixtures);

  it("compaction storm: a disagreement caused by a damaged agent.session_identity event says so", () => {
    const f = fixture();
    // The SessionStart's identity event was written but its payload is damaged now; a second damaged one is outside the 24 h window.
    f.activity({ seat: "seat-a@r", rawEvent: "SessionStart", rawSubtype: "compact", hoursAgo: 2, identity: false });
    f.event("agent.session_identity", NOT_JSON, stamp(2));
    f.event("agent.session_identity", NOT_JSON, stamp(40));
    const service = new HealthProjectionService([createCompactionStormSource(f.deps())]);
    service.records();

    const [coverage] = service.coverage();

    expect(coverage).toMatchObject({ status: "unavailable", reason: expect.stringContaining("disagree") });
    expect(coverage).toMatchObject({ reason: expect.stringContaining("(1 agent.session_identity event(s) in the window have a payload that is not readable JSON and were not counted") });
  });

  it("compaction storm: a disagreement with nothing damaged does not mention damage", () => {
    const f = fixture();
    f.activity({ seat: "seat-a@r", rawEvent: "SessionStart", rawSubtype: "compact", hoursAgo: 2, identity: false });
    const service = new HealthProjectionService([createCompactionStormSource(f.deps())]);
    service.records();

    const [coverage] = service.coverage();

    expect(coverage).toMatchObject({ status: "unavailable", reason: expect.stringContaining("disagree") });
    expect(JSON.stringify(coverage)).not.toContain("not readable JSON");
  });

  it("outbox unsettled: rows whose tags are not JSON are counted as ordinary rows and NAMED on the coverage row", () => {
    const f = fixture();
    const a = f.outbox({ state: "pending", hoursAgo: 30 });
    const b = f.outbox({ state: "pending", hoursAgo: 31 });
    f.outbox({ state: "pending", hoursAgo: 32 });
    f.db.prepare("UPDATE outbox_entries SET tags = ? WHERE rowid IN (?, ?)").run(NOT_JSON, a, b);
    const ids = (f.db.prepare("SELECT outbox_id FROM outbox_entries WHERE rowid IN (?, ?) ORDER BY rowid").all(a, b) as Array<{ outbox_id: string }>).map((r) => r.outbox_id);
    const service = new HealthProjectionService([new OutboxUnsettledSource(f.deps())]);
    service.records();

    const [coverage] = service.coverage();

    expect(coverage).toMatchObject({ note: expect.stringContaining(`2 un-retired outbox row(s) (${ids.join(", ")}) have tags that are not readable JSON and were counted as ordinary rows`) });
  });

  it("outbox unsettled: a RETIRED row with damaged tags is not counted and not named", () => {
    const f = fixture();
    const live = f.outbox({ state: "pending", hoursAgo: 30 });
    const retired = f.outbox({ state: "pending", hoursAgo: 31, retiredAt: "2031-03-01T00:00:00.000Z" });
    f.db.prepare("UPDATE outbox_entries SET tags = ? WHERE rowid IN (?, ?)").run(NOT_JSON, live, retired);
    const retiredId = (f.db.prepare("SELECT outbox_id FROM outbox_entries WHERE rowid = ?").get(retired) as { outbox_id: string }).outbox_id;
    const service = new HealthProjectionService([new OutboxUnsettledSource(f.deps())]);
    service.records();

    const [coverage] = service.coverage();

    expect(coverage).toMatchObject({ note: expect.stringContaining("1 un-retired outbox row(s)") });
    expect(JSON.stringify(coverage)).not.toContain(retiredId);
  });

  it("outbox unsettled: control, nothing damaged, no note", () => {
    const f = fixture();
    f.outbox({ state: "pending", hoursAgo: 30 });
    const service = new HealthProjectionService([new OutboxUnsettledSource(f.deps())]);
    service.records();

    expect(service.coverage()[0]).not.toHaveProperty("note");
  });
});
