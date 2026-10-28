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

  it("at most 50 damaged rows are named, newest first", () => {
    const ids: string[] = [];
    for (let i = 0; i < 52; i += 1) {
      const row = record(`2026-05-04T03:${String(i).padStart(2, "0")}:00.000Z`, "alice@r", NOTES);
      damage(row.actionId);
      ids.push(row.actionId);
    }

    const named = browse.query({ scopeTier: "mission" }).unreadableAuditNotes ?? [];

    expect(named).toHaveLength(50);
    expect(named[0]).toBe(ids[51]);
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
    lines = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => { lines.push(String(line)); });
  });
  afterEach(() => { vi.restoreAllMocks(); db.close(); });

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
    lines = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => { lines.push(String(line)); });
  });
  afterEach(() => { vi.restoreAllMocks(); db.close(); });

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

    expect(coverage).toMatchObject({ note: `2 agent.activity event(s) in the window (seq ${first} to ${last}) have a payload that is not readable JSON and were not judged; the counts above leave them out. Repair or remove the event rows.` });
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
