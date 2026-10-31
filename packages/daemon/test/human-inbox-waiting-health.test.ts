import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { createDaemon } from "../src/startup.js";
import {
  HumanInboxWaitingHealthSource,
  sqliteInboxWaitingRows,
} from "../src/domain/rsi/human-inbox-waiting-health.js";

// Nothing here can post a macOS notification: the banner path is retired, and the last test below pins that no
// banner program is named anywhere in the daemon source.

// Injected far from wall clock: a wall-clock mutant would see every fixture timestamp as long past or future.
const T0 = Date.parse("2031-03-04T05:00:00.000Z");
// 24 h is restated here, not imported: a pin must not import the constant it pins.
const HOUR = 3_600_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const dirs: string[] = [];
const open: Database.Database[] = [];

afterEach(() => {
  while (open.length) { try { open.pop()!.close(); } catch { /* closed */ } }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function freshDb(file?: string): Database.Database {
  const db = createDb(file ?? ":memory:");
  migrate(db, ALL_MIGRATIONS);
  open.push(db);
  return db;
}

function insert(db: Database.Database, id: string, o: { state: string; destination?: string; blockedOn?: string | null; created: string; updated?: string }): void {
  db.prepare(
    "INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, tags, blocked_on, body, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, o.created, o.updated ?? o.created, "dev-a@some-rig", o.destination ?? "human@kernel", o.state, "[]", o.blockedOn ?? null, "body", "summary");
}

const sourceOver = (db: Database.Database, nowMs = T0) => new HumanInboxWaitingHealthSource(sqliteInboxWaitingRows(db), () => new Date(nowMs));

describe("which rows wait on the inbox", () => {
  it("selects pending rows addressed to human@kernel and rows blocked on it, and nothing else", () => {
    const db = freshDb();
    insert(db, "q-pending", { state: "pending", created: iso(T0) });
    insert(db, "q-blocked", { state: "blocked", blockedOn: "human@kernel", destination: "dev-a@some-rig", created: iso(T0) });
    insert(db, "q-pending-elsewhere", { state: "pending", destination: "dev-b@some-rig", created: iso(T0) });
    insert(db, "q-blocked-elsewhere", { state: "blocked", blockedOn: "dev-b@some-rig", destination: "dev-a@some-rig", created: iso(T0) });
    insert(db, "q-done", { state: "done", created: iso(T0) });
    insert(db, "q-claimed", { state: "in-progress", created: iso(T0) });
    insert(db, "q-near-miss", { state: "pending", destination: "human-typo@kernel", created: iso(T0) });
    expect(sqliteInboxWaitingRows(db)().map((r) => r.qitemId).sort()).toEqual(["q-blocked", "q-pending"]);
  });

  it("ages a pending row from its creation and a blocked row from its last update", () => {
    const db = freshDb();
    insert(db, "q-pending", { state: "pending", created: "2031-03-01T00:00:00.000Z", updated: "2031-03-04T00:00:00.000Z" });
    insert(db, "q-blocked", { state: "blocked", blockedOn: "human@kernel", destination: "dev-a@some-rig", created: "2031-03-01T00:00:00.000Z", updated: "2031-03-04T00:00:00.000Z" });
    const since = Object.fromEntries(sqliteInboxWaitingRows(db)().map((r) => [r.qitemId, r.since]));
    expect(since).toEqual({ "q-pending": "2031-03-01T00:00:00.000Z", "q-blocked": "2031-03-04T00:00:00.000Z" });
  });
});

describe("rig health says when an item to Jim has waited over 24 hours", () => {
  it("is silent at and under 24 h, and flags past it: the threshold is strictly greater than 24 h", () => {
    const db = freshDb();
    insert(db, "q-edge", { state: "pending", created: iso(T0 - 24 * HOUR) });
    expect(sourceOver(db).coverage()).toEqual([]);
    insert(db, "q-fresh", { state: "pending", created: iso(T0 - HOUR) });
    expect(sourceOver(db).coverage()).toEqual([]);
    // Positive control: one millisecond past 24 h is flagged.
    expect(sourceOver(db, T0 + 1).coverage()).toHaveLength(1);
  });

  it("emits one unavailable coverage row naming the count, the oldest item and its age, and reads no findings", () => {
    const db = freshDb();
    insert(db, "q-b", { state: "pending", created: iso(T0 - 30 * HOUR) });
    insert(db, "q-a", { state: "blocked", blockedOn: "human@kernel", destination: "dev-a@some-rig", created: iso(T0 - 100 * HOUR), updated: iso(T0 - 50.5 * HOUR) });
    insert(db, "q-fresh", { state: "pending", created: iso(T0 - HOUR) });
    const source = sourceOver(db);
    expect(source.read()).toEqual([]);
    const rows = source.coverage();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "human-inbox-waiting", status: "unavailable", partial: true, evaluatedAt: iso(T0) });
    const reason = (rows[0] as { reason: string }).reason;
    expect(reason).toContain("2 item(s) addressed to human@kernel have waited over 24 h");
    expect(reason).toContain("oldest q-a, 50 h");
    expect(reason).not.toContain("q-fresh");
  });

  it("reads SQLite UTC stamps as UTC, not local time, whatever the host zone", () => {
    const savedTz = process.env["TZ"];
    try {
      // A zone far from UTC in each direction: a local-time parse would be skewed by hours the wrong way in one of them.
      for (const tz of ["Pacific/Kiritimati", "Pacific/Pago_Pago"]) {
        process.env["TZ"] = tz;
        const db = freshDb();
        // 2031-03-03 04:00:00 UTC is 25 h before T0.
        insert(db, "q-sqlite-stamp", { state: "pending", created: "2031-03-03 04:00:00" });
        expect(sourceOver(db).coverage(), tz).toHaveLength(1);
        expect(sourceOver(db, T0 - 2 * HOUR).coverage(), tz).toEqual([]);
      }
    } finally {
      if (savedTz === undefined) delete process.env["TZ"]; else process.env["TZ"] = savedTz;
    }
  });

  it("ignores a row whose stamp cannot be parsed instead of failing the health read", () => {
    const db = freshDb();
    insert(db, "q-bad", { state: "pending", created: "not-a-time" });
    expect(sourceOver(db).coverage()).toEqual([]);
  });

  it("only reads: it works on a read-only handle and leaves queue_items untouched", () => {
    const file = join(tempDir("inbox-waiting-"), "openrig.sqlite");
    const rw = freshDb(file);
    insert(rw, "q-old", { state: "pending", created: iso(T0 - 48 * HOUR) });
    const before = JSON.stringify(rw.prepare("SELECT * FROM queue_items").all());
    const ro = new Database(file, { readonly: true });
    open.push(ro);
    expect(sourceOver(ro).coverage()).toHaveLength(1);
    expect(JSON.stringify(rw.prepare("SELECT * FROM queue_items").all())).toBe(before);
  });
});

describe("daemon wiring", () => {
  it("serves the waiting-over-24h row through rig health, and writes neither banner table", async () => {
    const file = join(tempDir("inbox-waiting-daemon-"), "openrig.sqlite");
    const seeded = freshDb(file);
    insert(seeded, "q-ancient", { state: "pending", created: "2020-01-01T00:00:00.000Z" });
    insert(seeded, "q-new", { state: "pending", created: new Date().toISOString() });
    seeded.close();
    const daemon = await createDaemon({ dbPath: file });
    open.push(daemon.db);
    const coverage = daemon.deps.healthProjection!.list().coverage ?? [];
    const row = coverage.find((c) => c.source === "human-inbox-waiting");
    expect(row).toMatchObject({ status: "unavailable", partial: true });
    expect(JSON.stringify(row)).toContain("1 item(s) addressed to human@kernel have waited over 24 h");
    expect(JSON.stringify(row)).toContain("oldest q-ancient");
    // The retired notifier's tables stay in the schema (no destructive migration) and nothing writes them.
    expect((daemon.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('rsi_notifications','rsi_notification_banners')").get() as { n: number }).n).toBe(2);
    expect((daemon.db.prepare("SELECT COUNT(*) AS n FROM rsi_notifications").get() as { n: number }).n).toBe(0);
    expect((daemon.db.prepare("SELECT COUNT(*) AS n FROM rsi_notification_banners").get() as { n: number }).n).toBe(0);
    expect(Object.keys(daemon)).not.toContain("humanGateNotifier");
  });

  it("is silent when nothing has waited over 24 h", async () => {
    const file = join(tempDir("inbox-waiting-daemon-"), "openrig.sqlite");
    const seeded = freshDb(file);
    insert(seeded, "q-new", { state: "pending", created: new Date().toISOString() });
    seeded.close();
    const daemon = await createDaemon({ dbPath: file });
    open.push(daemon.db);
    expect((daemon.deps.healthProjection!.list().coverage ?? []).map((c) => c.source)).not.toContain("human-inbox-waiting");
  });
});

describe("the banner path is gone", () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = path.join(dir, name);
      return statSync(p).isDirectory() ? sourceFiles(p) : p.endsWith(".ts") ? [p] : [];
    });
  }

  it("no daemon source file names terminal-notifier, an AppleScript notification or a banner spawner", () => {
    const files = sourceFiles(path.resolve(__dirname, "../src"));
    expect(files.length).toBeGreaterThan(100); // positive control: the walk saw the source tree
    const offenders = files.filter((f) => /terminal-notifier|display notification|defaultBannerSpawner|HumanGateNotifier/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
