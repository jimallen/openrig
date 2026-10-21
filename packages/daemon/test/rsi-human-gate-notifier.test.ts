import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { createDaemon } from "../src/startup.js";
import { isSettingsValidKey } from "../src/domain/user-settings/settings-store.js";
import {
  defaultFindExecutable,
  HumanGateNotifier,
  MAX_BANNERS_PER_DAY,
  MIN_BANNER_GAP_MS,
  REMINDER_INTERVAL_MS,
  sqliteBlockedRows,
  sqliteNotificationStore,
  type BannerSpawner,
  type BlockedQueueRow,
} from "../src/domain/rsi/human-gate-notifier.js";

// DEPENDENCY: the `rsi_notifications` and `rsi_notification_banners` tables and the `rsi.steward_session` setting come from RSI lane B1
// (migration 113, settings-store). This branch is rebased on B1, so the real migrations are used.

// Injected far from wall clock: a wall-clock mutant would see every fixture timestamp as long past or future.
const T0 = Date.parse("2031-03-04T05:00:00.000Z");
const MIN = 60_000;
const STEWARD = "improve-steward@kernel";
const dirs: string[] = [];
const open: Database.Database[] = [];

afterEach(() => {
  while (open.length) { try { open.pop()!.close(); } catch { /* closed */ } }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  delete process.env["OPENRIG_RSI_STEWARD_SESSION"];
  vi.restoreAllMocks();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function freshDb(file = false): Database.Database {
  const db = createDb(file ? join(tempDir("rsi-notifier-"), "openrig.sqlite") : ":memory:");
  migrate(db, ALL_MIGRATIONS);
  open.push(db);
  return db;
}

function park(db: Database.Database, id: string, ts = "2031-03-04T00:00:00.000Z"): void {
  db.prepare("INSERT INTO queue_transitions (qitem_id, ts, state, actor_session) VALUES (?, ?, 'blocked', ?)").run(id, ts, STEWARD);
}

function insertQueueRow(
  db: Database.Database,
  id: string,
  opts: { state?: string; blockedOn?: string | null; tags?: string[]; summary?: string | null; source?: string } = {},
): void {
  db.prepare(
    "INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, tags, blocked_on, body, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id, "2031-03-04T00:00:00.000Z", "2031-03-04T00:00:00.000Z", opts.source ?? STEWARD, STEWARD,
    opts.state ?? "blocked", JSON.stringify(opts.tags ?? ["rsi", "rsi:fp:rsi.x/rig:a", "rsi:stage:proposal"]),
    opts.blockedOn === undefined ? "human@kernel" : opts.blockedOn, "body", opts.summary === undefined ? "plain summary" : opts.summary,
  );
  if ((opts.state ?? "blocked") === "blocked") park(db, id);
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
    stewardSession: STEWARD,
    store: sqliteNotificationStore(db),
    spawner,
    findExecutable: (name) => (name === "terminal-notifier" ? (opts.terminalNotifier === undefined ? "/opt/homebrew/bin/terminal-notifier" : opts.terminalNotifier) : null),
    clock: () => new Date(now.ms),
    platform: opts.platform ?? "darwin",
    log: (line) => logs.push(line),
  });
  return { db, now, calls, logs, notifier };
}

const messageOf = (call: { args: string[] }): string => call.args[call.args.indexOf("-message") + 1]!;

describe("selection: which rows become banners", () => {
  it("banners an RSI item parked on a human seat, once, with the group and an argv array", async () => {
    const h = harness();
    insertQueueRow(h.db, "q-rsi-1");
    const first = await h.notifier.tick();
    expect(first.status).toBe("sent");
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.command).toBe("/opt/homebrew/bin/terminal-notifier");
    expect(h.calls[0]!.args.slice(h.calls[0]!.args.indexOf("-group"))).toEqual(["-group", "openrig-rsi"]);
    const message = messageOf(h.calls[0]!);
    expect(message).toContain("1 RSI item(s) waiting");
    expect(message).toContain("proposal rsi.x/rig:a");
    expect(message).toContain("rsi-decide q-rsi-1");
    expect(message.startsWith("-")).toBe(false);
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

  it("counts only items created by the configured steward: another seat's rsi-tagged park cannot spend the banner budget", async () => {
    const h = harness();
    for (let i = 0; i < MAX_BANNERS_PER_DAY; i += 1) insertQueueRow(h.db, `q-junk-${i}`, { source: "some-other@rig" });
    expect(await h.notifier.tick()).toEqual({ status: "idle", waiting: 0 });
    insertQueueRow(h.db, "q-real");
    const result = await h.notifier.tick();
    expect(result.status).toBe("sent");
    expect(messageOf(h.calls[0]!)).toContain("1 RSI item(s) waiting");
    expect(messageOf(h.calls[0]!)).toContain("rsi-decide q-real");
    expect(h.calls).toHaveLength(1);
  });

  it("gives an item re-parked after resolution a fresh entry banner, and not one for the same parking episode", async () => {
    const h = harness();
    insertQueueRow(h.db, "q-a");
    expect((await h.notifier.tick()).status).toBe("sent");
    // Resolved (no longer waiting), then parked on the human again an hour later.
    h.db.prepare("UPDATE queue_items SET state = 'in-progress' WHERE qitem_id = 'q-a'").run();
    h.now.ms = T0 + 20 * MIN;
    expect((await h.notifier.tick()).status).toBe("idle");
    h.db.prepare("UPDATE queue_items SET state = 'blocked' WHERE qitem_id = 'q-a'").run();
    park(h.db, "q-a", "2031-03-04T05:20:00.000Z");
    h.now.ms = T0 + 60 * MIN;
    expect((await h.notifier.tick()).status).toBe("sent");
    expect(h.calls).toHaveLength(2);
    // Same episode again: nothing new until the reminder window.
    h.now.ms = T0 + 90 * MIN;
    expect((await h.notifier.tick()).status).toBe("idle");
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
    expect(messageOf(h.calls[1]!)).toContain("2 RSI item(s) waiting");
    expect(messageOf(h.calls[1]!)).toContain("rsi-decide q-b");
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
    const row = h.db.prepare("SELECT first_notified_at, last_notified_at FROM rsi_notifications WHERE qitem_id LIKE 'q-a@%'").get() as { first_notified_at: string; last_notified_at: string };
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

  it("counts the cap from banner rows, so item-row churn cannot undercount it", async () => {
    const h = harness();
    for (let i = 0; i < MAX_BANNERS_PER_DAY; i += 1) {
      insertQueueRow(h.db, `q-${i}`);
      expect((await h.notifier.tick()).status).toBe("sent");
      h.now.ms += MIN_BANNER_GAP_MS;
    }
    expect(h.db.prepare("SELECT COUNT(*) AS n, SUM(ok) AS ok FROM rsi_notification_banners").get()).toEqual({ n: MAX_BANNERS_PER_DAY, ok: MAX_BANNERS_PER_DAY });
    // Item rows are rewritten or removed by reminders and re-parks; the cap does not depend on them.
    h.db.prepare("DELETE FROM rsi_notifications").run();
    insertQueueRow(h.db, "q-late");
    expect((await h.notifier.tick()).status).toBe("capped");
  });

  it("drops banner rows older than a day, and counts only the last day toward the cap", async () => {
    const h = harness();
    for (let i = 0; i < MAX_BANNERS_PER_DAY; i += 1) {
      h.db.prepare("INSERT INTO rsi_notification_banners (sent_at, item_count, ok) VALUES (?, 1, 1)").run(new Date(T0 - 25 * 60 * MIN - i * MIN).toISOString());
    }
    insertQueueRow(h.db, "q-a");
    expect((await h.notifier.tick()).status).toBe("sent");
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM rsi_notification_banners").get()).toEqual({ n: 1 });
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

  it("does not mark items notified on a failed spawn, and does not retry it inside the gap", async () => {
    const h = harness({ spawnOk: false });
    insertQueueRow(h.db, "q-a");
    expect((await h.notifier.tick()).status).toBe("failed");
    expect(h.notifier.lastResult).toMatchObject({ ok: false, command: "terminal-notifier" });
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM rsi_notifications").get()).toEqual({ n: 0 });
    expect(h.db.prepare("SELECT sent_at, item_count, ok FROM rsi_notification_banners").all()).toEqual([{ sent_at: new Date(T0).toISOString(), item_count: 1, ok: 0 }]);
    h.now.ms += MIN;
    expect((await h.notifier.tick()).status).toBe("coalesced");
    expect(h.calls).toHaveLength(1);
  });

  it("counts failed spawn attempts against the daily cap", async () => {
    const h = harness({ spawnOk: false });
    insertQueueRow(h.db, "q-a");
    for (let i = 0; i < MAX_BANNERS_PER_DAY + 1; i += 1) {
      const result = await h.notifier.tick();
      expect(result.status).toBe(i < MAX_BANNERS_PER_DAY ? "failed" : "capped");
      h.now.ms += MIN_BANNER_GAP_MS;
    }
    expect(h.calls).toHaveLength(MAX_BANNERS_PER_DAY);
  });

  it("remembers a failed attempt across a restart: no immediate retry from a fresh process", async () => {
    const first = harness({ spawnOk: false });
    insertQueueRow(first.db, "q-a");
    await first.notifier.tick();
    const second = harness({ db: first.db, now: first.now, spawnOk: false });
    first.now.ms = T0 + MIN;
    expect((await second.notifier.tick()).status).toBe("coalesced");
    expect(second.calls).toHaveLength(0);
  });

  it("ignores a row stamped in the future: one bad row cannot block every banner", async () => {
    const h = harness();
    h.db.prepare("INSERT INTO rsi_notifications (qitem_id, first_notified_at, last_notified_at) VALUES ('q-bad@1', '2099-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z')").run();
    h.db.prepare("INSERT INTO rsi_notifications (qitem_id, first_notified_at, last_notified_at) VALUES ('q-junk@1', 'x', 'not-a-date')").run();
    h.db.prepare("INSERT INTO rsi_notification_banners (sent_at, item_count, ok) VALUES ('2099-01-01T00:00:00.000Z', 1, 1)").run();
    h.db.prepare("INSERT INTO rsi_notification_banners (sent_at, item_count, ok) VALUES ('not-a-date', 1, 1)").run();
    insertQueueRow(h.db, "q-a");
    expect((await h.notifier.tick()).status).toBe("sent");
  });
});

describe("osascript fallback: no string-built AppleScript", () => {
  const HOSTILE = 'close" & do shell script "touch /tmp/never" & "';

  it("passes the summary only as argv after `--`, with a fixed script, by absolute path", async () => {
    const h = harness({ terminalNotifier: null });
    insertQueueRow(h.db, "q-inj", { summary: HOSTILE });
    expect((await h.notifier.tick()).status).toBe("sent");
    const { command, args } = h.calls[0]!;
    expect(command).toBe("/usr/bin/osascript");
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
    expect(message!.startsWith("-")).toBe(false);
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

describe("what Jim reads: display spoofing", () => {
  it("strips control, bidi, zero-width and C1 characters from the summary, the tag values and the id", async () => {
    const h = harness();
    insertQueueRow(h.db, "q-s\u202Ep\u200Bo", {
      tags: ["rsi", "rsi:fp:rsi.x/\u202Ereg\u2066ig\u200B", "rsi:stage:pro\u0085posal\u2029"],
      summary: "ap\u202Eprove\u200B now\u0085\u0007 \u2028done",
    });
    expect((await h.notifier.tick()).status).toBe("sent");
    const message = messageOf(h.calls[0]!);
    expect(message).not.toMatch(/[\p{Cc}\p{Cf}\u2028\u2029]/u);
    // The visible text survives.
    expect(message).toContain("rsi-decide q-spo");
    expect(message).toContain("rsi.x/reg");
    expect(message).toContain("approve now");
    expect(message).toContain("done");
  });
});

describe("executables are found only in fixed places", () => {
  it("never consults PATH, and requires a regular executable file", () => {
    const planted = tempDir("rsi-notifier-planted-");
    writeFileSync(join(planted, "terminal-notifier"), "#!/bin/sh\n");
    chmodSync(join(planted, "terminal-notifier"), 0o755);
    const saved = process.env["PATH"];
    process.env["PATH"] = `${planted}:${saved ?? ""}`;
    try {
      const found = defaultFindExecutable("terminal-notifier");
      expect(found === null || !found.startsWith(planted)).toBe(true);
      // Positive control: the same lookup does find the file when its directory is one of the fixed ones.
      expect(defaultFindExecutable("terminal-notifier", [planted])).toBe(join(planted, "terminal-notifier"));
    } finally {
      process.env["PATH"] = saved;
    }
    const asDir = tempDir("rsi-notifier-dir-");
    mkdirSync(join(asDir, "terminal-notifier"));
    expect(defaultFindExecutable("terminal-notifier", [asDir])).toBeNull();
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
      stewardSession: STEWARD,
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
      stewardSession: STEWARD,
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
    const ro = new Database(db.name, { readonly: true, fileMustExist: true });
    open.push(ro);
    // The queue read works on a handle that cannot write: it is SELECT only.
    expect(sqliteBlockedRows(ro)().map((r: BlockedQueueRow) => r.qitemId).sort()).toEqual(["q-a", "q-b"]);
    expect(() => ro.prepare("UPDATE queue_items SET state = 'done'").run()).toThrow(/readonly/i);
    const h = harness({ db });
    await h.notifier.tick();
    expect(JSON.stringify(db.prepare("SELECT * FROM queue_items ORDER BY qitem_id").all())).toBe(before);
    expect(db.prepare("SELECT qitem_id FROM rsi_notifications").all()).toEqual([{ qitem_id: expect.stringMatching(/^q-a@/) }]);
  });
});

describe("daemon wiring", () => {
  it("uses a setting key that exists in the settings key list", () => {
    expect(isSettingsValidKey("rsi.steward_session")).toBe(true);
  });

  it("arms the notifier when rsi.steward_session is set, and builds none when it is unset", async () => {
    const dir = tempDir("rsi-notifier-wiring-");
    const log = vi.spyOn(console, "log");
    const unset = await createDaemon({ dbPath: join(dir, "unset.sqlite") });
    open.push(unset.db);
    expect(unset.humanGateNotifier).toBeUndefined();

    process.env["OPENRIG_RSI_STEWARD_SESSION"] = STEWARD;
    const armed = await createDaemon({ dbPath: join(dir, "armed.sqlite") });
    open.push(armed.db);
    expect(armed.humanGateNotifier).toBeInstanceOf(HumanGateNotifier);
    expect(log.mock.calls.map((c) => String(c[0]))).toContain(`[rsi-notifier] armed for steward session ${STEWARD}`);
  });

  it("degrades, never fails daemon start, when the notifier cannot be built (missing table)", async () => {
    const dir = tempDir("rsi-notifier-degrade-");
    const dbPath = join(dir, "partial.sqlite");
    const seeded = createDb(dbPath);
    migrate(seeded, ALL_MIGRATIONS);
    seeded.exec("DROP TABLE rsi_notifications");
    seeded.close();
    process.env["OPENRIG_RSI_STEWARD_SESSION"] = STEWARD;
    const error = vi.spyOn(console, "error");
    const daemon = await createDaemon({ dbPath });
    open.push(daemon.db);
    expect(daemon.humanGateNotifier).toBeUndefined();
    const lines = error.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[rsi-notifier]"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[rsi-notifier\] disabled: construction failed class=SqliteError$/);
  });
});
