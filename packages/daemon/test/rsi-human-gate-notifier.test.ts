import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate, type Migration } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { createDaemon } from "../src/startup.js";
import {
  HumanGateNotifier,
  MAX_BANNERS_PER_DAY,
  MIN_BANNER_GAP_MS,
  REMINDER_INTERVAL_MS,
  sqliteBlockedRows,
  sqliteNotificationStore,
  type BannerSpawner,
  type BlockedQueueRow,
} from "../src/domain/rsi/human-gate-notifier.js";

// DEPENDENCY: RSI lane B1 creates `rsi_notifications` in its migration. This fixture is a
// test-only stand-in with the schema from rsi-design-9k-rev2.md section 3.7; at integration B1
// merges first and this fixture can be deleted.
const FIXTURE_MIGRATION: Migration = {
  name: "test-fixture-rsi_notifications.sql",
  sql: `CREATE TABLE IF NOT EXISTS rsi_notifications (
    qitem_id TEXT PRIMARY KEY,
    first_notified_at TEXT NOT NULL,
    last_notified_at TEXT NOT NULL
  );`,
};

// Injected far from wall clock: a wall-clock mutant would see every fixture timestamp as long past or future.
const T0 = Date.parse("2031-03-04T05:00:00.000Z");
const MIN = 60_000;
const dirs: string[] = [];
const open: Database.Database[] = [];

afterEach(() => {
  while (open.length) { try { open.pop()!.close(); } catch { /* closed */ } }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function freshDb(file = false): Database.Database {
  let path = ":memory:";
  if (file) {
    const dir = mkdtempSync(join(tmpdir(), "rsi-notifier-"));
    dirs.push(dir);
    path = join(dir, "openrig.sqlite");
  }
  const db = createDb(path);
  migrate(db, [...ALL_MIGRATIONS, FIXTURE_MIGRATION]);
  open.push(db);
  return db;
}

function insertQueueRow(db: Database.Database, id: string, opts: { state?: string; blockedOn?: string | null; tags?: string[]; summary?: string | null } = {}): void {
  db.prepare(
    "INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, tags, blocked_on, body, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id, "2031-03-04T00:00:00.000Z", "2031-03-04T00:00:00.000Z", "improve-steward@kernel", "improve-steward@kernel",
    opts.state ?? "blocked", JSON.stringify(opts.tags ?? ["rsi", "rsi:fp:rsi.x/rig:a", "rsi:stage:proposal"]),
    opts.blockedOn === undefined ? "human@kernel" : opts.blockedOn, "body", opts.summary === undefined ? "plain summary" : opts.summary,
  );
}

interface Harness {
  db: Database.Database;
  now: { ms: number };
  calls: Array<{ command: string; args: string[] }>;
  logs: string[];
  notifier: HumanGateNotifier;
}

function harness(opts: { platform?: NodeJS.Platform; terminalNotifier?: string | null; spawnOk?: boolean; db?: Database.Database; now?: { ms: number } } = {}): Harness {
  const db = opts.db ?? freshDb();
  const now = opts.now ?? { ms: T0 };
  const calls: Array<{ command: string; args: string[] }> = [];
  const logs: string[] = [];
  const spawner: BannerSpawner = async (command, args) => { calls.push({ command, args }); return { ok: opts.spawnOk ?? true }; };
  const notifier = new HumanGateNotifier({
    listBlocked: sqliteBlockedRows(db),
    store: sqliteNotificationStore(db),
    spawner,
    findExecutable: (name) => (name === "terminal-notifier" ? (opts.terminalNotifier === undefined ? "/opt/homebrew/bin/terminal-notifier" : opts.terminalNotifier) : null),
    clock: () => new Date(now.ms),
    platform: opts.platform ?? "darwin",
    log: (line) => logs.push(line),
  });
  return { db, now, calls, logs, notifier };
}

describe("selection: which rows become banners", () => {
  it("banners an RSI item parked on a human seat, once, with the group and an argv array", async () => {
    const h = harness();
    insertQueueRow(h.db, "q-rsi-1");
    const first = await h.notifier.tick();
    expect(first.status).toBe("sent");
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.command).toBe("/opt/homebrew/bin/terminal-notifier");
    expect(h.calls[0]!.args.slice(h.calls[0]!.args.indexOf("-group"))).toEqual(["-group", "openrig-rsi"]);
    const message = h.calls[0]!.args[h.calls[0]!.args.indexOf("-message") + 1]!;
    expect(message).toContain("1 RSI item(s) waiting");
    expect(message).toContain("proposal rsi.x/rig:a");
    expect(message).toContain("rsi-decide q-rsi-1");
    h.now.ms += 5 * MIN;
    expect((await h.notifier.tick()).status).toBe("idle");
    expect(h.calls).toHaveLength(1);
  });

  it("does not notify a non-RSI human-gate item, an RSI item parked on an agent, or a non-blocked RSI item", async () => {
    const h = harness();
    insertQueueRow(h.db, "q-plain-human", { tags: ["not-rsi", "rsi:fp:lookalike"] });
    insertQueueRow(h.db, "q-rsi-agent", { blockedOn: "improve-engineer@kernel" });
    insertQueueRow(h.db, "q-rsi-pending", { state: "pending" });
    insertQueueRow(h.db, "q-untagged", { tags: [] });
    const result = await h.notifier.tick();
    expect(result).toEqual({ status: "idle", waiting: 0 });
    expect(h.calls).toHaveLength(0);
    // Positive control: the same fixture with the one qualifying row added does notify.
    insertQueueRow(h.db, "q-rsi-ok");
    expect((await h.notifier.tick()).status).toBe("sent");
  });
});

describe("rate limits", () => {
  it("coalesces items that arrive inside the 10-minute gap into the next banner's count", async () => {
    const h = harness();
    insertQueueRow(h.db, "q-a");
    expect((await h.notifier.tick()).status).toBe("sent");
    insertQueueRow(h.db, "q-b");
    h.now.ms = T0 + 5 * MIN;
    expect((await h.notifier.tick()).status).toBe("coalesced");
    h.now.ms = T0 + MIN_BANNER_GAP_MS - 1;
    expect((await h.notifier.tick()).status).toBe("coalesced");
    expect(h.calls).toHaveLength(1);
    h.now.ms = T0 + MIN_BANNER_GAP_MS;
    expect((await h.notifier.tick()).status).toBe("sent");
    expect(h.calls).toHaveLength(2);
    const message = h.calls[1]!.args[h.calls[1]!.args.indexOf("-message") + 1]!;
    expect(message).toContain("2 RSI item(s) waiting");
    expect(message).toContain("rsi-decide q-b");
  });

  it("sends at most one reminder per item per 24 hours", async () => {
    const h = harness();
    insertQueueRow(h.db, "q-a");
    await h.notifier.tick();
    h.now.ms = T0 + REMINDER_INTERVAL_MS - MIN;
    expect((await h.notifier.tick()).status).toBe("idle");
    h.now.ms = T0 + REMINDER_INTERVAL_MS;
    expect((await h.notifier.tick()).status).toBe("sent");
    h.now.ms += MIN_BANNER_GAP_MS + MIN;
    expect((await h.notifier.tick()).status).toBe("idle");
    h.now.ms = T0 + 2 * REMINDER_INTERVAL_MS - MIN;
    expect((await h.notifier.tick()).status).toBe("idle");
    expect(h.calls).toHaveLength(2);
    const row = h.db.prepare("SELECT first_notified_at, last_notified_at FROM rsi_notifications WHERE qitem_id = 'q-a'").get() as { first_notified_at: string; last_notified_at: string };
    expect(row.first_notified_at).toBe(new Date(T0).toISOString());
    expect(row.last_notified_at).toBe(new Date(T0 + REMINDER_INTERVAL_MS).toISOString());
  });

  it("caps banners at 12 in a rolling 24 hours", async () => {
    const h = harness();
    for (let i = 0; i < MAX_BANNERS_PER_DAY + 1; i += 1) {
      insertQueueRow(h.db, `q-${i}`);
      const result = await h.notifier.tick();
      if (i < MAX_BANNERS_PER_DAY) expect(result.status).toBe("sent");
      else expect(result.status).toBe("capped");
      h.now.ms += MIN_BANNER_GAP_MS;
    }
    expect(h.calls).toHaveLength(MAX_BANNERS_PER_DAY);
  });

  it("keeps the gap and the notified set across a daemon restart", async () => {
    const first = harness();
    insertQueueRow(first.db, "q-a");
    await first.notifier.tick();
    const second = harness({ db: first.db, now: first.now });
    first.now.ms = T0 + MIN;
    expect((await second.notifier.tick()).status).toBe("idle");
    insertQueueRow(first.db, "q-b");
    expect((await second.notifier.tick()).status).toBe("coalesced");
    expect(second.calls).toHaveLength(0);
  });

  it("does not record a failed spawn and does not retry it inside the gap", async () => {
    const h = harness({ spawnOk: false });
    insertQueueRow(h.db, "q-a");
    expect((await h.notifier.tick()).status).toBe("failed");
    expect(h.notifier.lastResult).toMatchObject({ ok: false, command: "terminal-notifier" });
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM rsi_notifications").get()).toEqual({ n: 0 });
    h.now.ms += MIN;
    expect((await h.notifier.tick()).status).toBe("coalesced");
    expect(h.calls).toHaveLength(1);
  });
});

describe("osascript fallback: no string-built AppleScript", () => {
  const HOSTILE = 'close" & do shell script "touch /tmp/never" & "';

  it("passes the summary only as argv after `--`, with a fixed script", async () => {
    const h = harness({ terminalNotifier: null });
    insertQueueRow(h.db, "q-inj", { summary: HOSTILE });
    expect((await h.notifier.tick()).status).toBe("sent");
    const { command, args } = h.calls[0]!;
    expect(command).toBe("osascript");
    const sep = args.indexOf("--");
    expect(sep).toBeGreaterThan(0);
    const scriptPart = args.slice(0, sep);
    expect(scriptPart).toEqual([
      "-e", "on run argv",
      "-e", "display notification (item 1 of argv) with title (item 2 of argv)",
      "-e", "end run",
    ]);
    for (const piece of scriptPart) {
      expect(piece).not.toContain("do shell script");
      expect(piece).not.toContain('"');
    }
    const [message, title] = args.slice(sep + 1);
    expect(args.slice(sep + 1)).toHaveLength(2);
    expect(message).toContain('close" & do shell script');
    expect(title).toBe("OpenRig RSI");
  });

  it("passes the summary to terminal-notifier as one argv element, never through a shell", async () => {
    const h = harness();
    insertQueueRow(h.db, "q-inj", { summary: HOSTILE });
    await h.notifier.tick();
    const { command, args } = h.calls[0]!;
    expect(command).toBe("/opt/homebrew/bin/terminal-notifier");
    expect(args.filter((a) => a.includes("do shell script"))).toHaveLength(1);
    expect(args.indexOf("-message")).toBe(2);
  });
});

describe("platform and failure posture", () => {
  it("is a no-op on Linux: no read, no spawn, one log line at start, no timer", async () => {
    const db = freshDb();
    insertQueueRow(db, "q-a");
    const calls: string[] = [];
    const logs: string[] = [];
    const notifier = new HumanGateNotifier({
      listBlocked: () => { calls.push("list"); return []; },
      store: sqliteNotificationStore(db),
      spawner: async (c) => { calls.push(c); return { ok: true }; },
      findExecutable: () => null,
      platform: "linux",
      log: (l) => logs.push(l),
    });
    notifier.start();
    expect(await notifier.tick()).toEqual({ status: "noop-platform" });
    expect(calls).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("no-op on platform linux");
    expect(db.prepare("SELECT COUNT(*) AS n FROM rsi_notifications").get()).toEqual({ n: 0 });
    notifier.stop();
  });

  it("logs a failing read by class only, never its message", async () => {
    const logs: string[] = [];
    const notifier = new HumanGateNotifier({
      listBlocked: () => { throw new RangeError("qitem body: secret-token-abc"); },
      store: sqliteNotificationStore(freshDb()),
      spawner: async () => ({ ok: true }),
      findExecutable: () => null,
      platform: "darwin",
      log: (l) => logs.push(l),
    });
    expect(await notifier.tick()).toEqual({ status: "error", errorClass: "RangeError" });
    expect(logs).toEqual(["[rsi-notifier] tick failed class=RangeError"]);
  });

  it("reads queue state through a read-only handle and leaves queue_items untouched", async () => {
    const db = freshDb(true);
    insertQueueRow(db, "q-a");
    insertQueueRow(db, "q-b", { tags: ["plain"] });
    const before = JSON.stringify(db.prepare("SELECT * FROM queue_items ORDER BY qitem_id").all());
    const path = db.name;
    const ro = new Database(path, { readonly: true, fileMustExist: true });
    open.push(ro);
    // The queue read works on a handle that cannot write: it is SELECT only.
    expect(sqliteBlockedRows(ro)().map((r: BlockedQueueRow) => r.qitemId).sort()).toEqual(["q-a", "q-b"]);
    expect(() => ro.prepare("UPDATE queue_items SET state = 'done'").run()).toThrow(/readonly/i);
    const h = harness({ db });
    await h.notifier.tick();
    expect(JSON.stringify(db.prepare("SELECT * FROM queue_items ORDER BY qitem_id").all())).toBe(before);
    expect(db.prepare("SELECT qitem_id FROM rsi_notifications").all()).toEqual([{ qitem_id: "q-a" }]);
  });
});

describe("daemon wiring", () => {
  it("builds no notifier unless rsi.stewardSession is configured (in-memory and file-backed, setting unset)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rsi-notifier-wiring-"));
    dirs.push(dir);
    const fileDaemon = await createDaemon({ dbPath: join(dir, "openrig.sqlite") });
    open.push(fileDaemon.db);
    const memoryDaemon = await createDaemon({ dbPath: ":memory:" });
    open.push(memoryDaemon.db);
    expect(fileDaemon.humanGateNotifier).toBeUndefined();
    expect(memoryDaemon.humanGateNotifier).toBeUndefined();
  });
});
