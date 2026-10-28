import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { isHumanSeatSession } from "../human-route-enforcer.js";
import { LOCAL_HUMAN_INBOX_ADDRESS } from "../gateway/destination-resolver.js";
import type { HealthObservationSource, HealthDetectorObservation, HealthSourceCoverage } from "../health-detectors.js";

/**
 * Notification context (rsi-design-9k-rev2 section 3.1 and 3.7): a macOS banner for each RSI
 * item that waits on a human gate, and (z7, Jim 2026-10-28) for every open item addressed to the
 * operator's local inbox (`human@kernel`, LOCAL_HUMAN_INBOX_ADDRESS): questions, reports, replies and
 * gates alike. Local only: nothing here leaves the machine. All of them share one gap, one daily cap and
 * one 24 h reminder rule, so a seat that floods the inbox spends the same budget as everything else.
 *
 * Reads queue state, never writes it. The notifier's only writes go to its own table,
 * `rsi_notifications`, which RSI lane B1 creates in its migration:
 *   rsi_notifications(qitem_id TEXT PRIMARY KEY, first_notified_at TEXT NOT NULL, last_notified_at TEXT NOT NULL)
 * (migration 113). startup.ts arms the notifier only when `rsi.steward_session` is valid by B1's
 * own rule (`rsiStewardValidity`, health-finding-wake.ts), so an invalid value disarms the wake and
 * the notifier alike. The notifier is armed once, at daemon boot: changing `rsi.steward_session`
 * needs a daemon restart.
 *
 * Residual risk, accepted (Jim's D8(a): approvals can be forged): `source_session` is a label, not an
 * authenticated identity. The daemon takes the X-OpenRig-Session header (or a body sourceSession)
 * verbatim, so any seat that can reach the queue API can pose as the steward and have its items
 * counted. Selecting on the steward's source keeps a seat acting under its own identity from
 * spending the banner budget by tagging `rsi`; it does not stop a hostile or compromised seat.
 */

export const RSI_TAG = "rsi";
export const NOTIFIER_INTERVAL_MS = 60_000;
/** At most one reminder per item per 24 h. */
export const REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** At least 10 minutes between banners; items suppressed by the gap fold into the next banner. */
export const MIN_BANNER_GAP_MS = 10 * 60 * 1000;
/** Hard cap on banners in any rolling 24 h. */
export const MAX_BANNERS_PER_DAY = 12;
export const OSASCRIPT_PATH = "/usr/bin/osascript";
export const NOTIFICATION_GROUP = "openrig-rsi";
export const NOTIFICATION_TITLE = "OpenRig RSI";
/** Title when anything waiting is not a steward RSI item. */
export const INBOX_NOTIFICATION_TITLE = "OpenRig";
const SPAWN_TIMEOUT_MS = 5_000;
const MAX_FIELD_CHARS = 120;
const MAX_MESSAGE_CHARS = 300;

/** A queue row as the notifier reads it (blocked rows, and open rows addressed to the inbox). Filtering to what waits on the human is the notifier's job. */
export interface BlockedQueueRow {
  qitemId: string;
  /** Where the item is addressed (queue_items.destination_session). */
  destinationSession: string;
  /** The seat that created the item. Only the configured steward's items are RSI items. */
  sourceSession: string;
  /** Identifies one waiting episode: for a parked row the latest transition into `blocked` (a re-park is a new episode, so a new entry); for an open row its creation time. */
  episode: string;
  state: string;
  blockedOn: string | null;
  tags: string[];
  summary: string | null;
}

export interface NotificationRow { qitemId: string; firstNotifiedAt: string; lastNotifiedAt: string }

/** One banner attempt (rsi_notification_banners): the gap and the daily cap count these, failed attempts included. */
export interface BannerRow { sentAt: string; itemCount: number; ok: boolean }

export interface NotificationStore {
  /** Per-episode entry and reminder state (rsi_notifications). */
  list(): NotificationRow[];
  /** Insert, or move last_notified_at while keeping first_notified_at. */
  record(qitemIds: string[], at: string): void;
  deleteOlderThan(qitemIds: string[], cutoff: string): void;
  listBanners(): BannerRow[];
  recordBanner(row: BannerRow): void;
  /** Bounds the table: banners older than a day carry no gap or cap information. */
  deleteBannersBefore(cutoff: string): void;
}

/**
 * Why a banner program failed. `exit`: it ran and exited nonzero (`exitCode`). `spawn-error`: it could not be
 * started, so nothing was posted. `timeout`: it outlived the bound and was killed. `signal`: it died from a signal
 * we did not send. After `timeout` or `signal` the program may already have posted its banner.
 */
export type BannerFailureCause = "exit" | "spawn-error" | "timeout" | "signal";
export type BannerSpawnResult = { ok: boolean; exitCode?: number | null; cause?: BannerFailureCause };
export type BannerSpawner = (command: string, args: string[]) => Promise<BannerSpawnResult>;

function causeOf(result: BannerSpawnResult): BannerFailureCause | undefined {
  return result.cause ?? (typeof result.exitCode === "number" ? "exit" : undefined);
}

/** The word an operator reads in the log: exit=N, spawn_error, timeout, signal (unknown only if a spawner reports none). */
export function bannerFailureReason(result: BannerSpawnResult): string {
  const cause = causeOf(result);
  if (cause === "exit") return `exit=${result.exitCode ?? "none"}`;
  if (cause === "spawn-error") return "spawn_error";
  return cause ?? "unknown";
}

/** OF-83 fallback rule: only when nothing can have been posted, i.e. a nonzero exit or a spawn error. */
function shouldFallBackToOsascript(result: BannerSpawnResult): boolean {
  const cause = causeOf(result);
  return !result.ok && (cause === "exit" || cause === "spawn-error");
}

export type NotifierTickResult =
  | { status: "noop-platform" }
  | { status: "idle"; waiting: number }
  | { status: "coalesced"; waiting: number; pending: number }
  | { status: "capped"; waiting: number; pending: number }
  | { status: "sent"; waiting: number; notified: string[]; command: string }
  | { status: "failed"; waiting: number; command: string }
  | { status: "error"; errorClass: string };

export interface HumanGateNotifierDeps {
  /** Every row in state `blocked`, plus every `pending` row addressed to the inbox. Must be read-only. */
  listWaiting: () => BlockedQueueRow[];
  /** The configured `rsi.steward_session`; only its items are RSI items. Null when none is valid: the inbox banner does not depend on RSI. */
  stewardSession: string | null;
  store: NotificationStore;
  spawner: BannerSpawner;
  /** Absolute path of an installed binary, or null. */
  findExecutable: (name: string) => string | null;
  clock?: () => Date;
  platform?: NodeJS.Platform;
  log?: (line: string) => void;
  intervalMs?: number;
}

/** A row the banner is about. `rsi` rows keep the RSI wording; `inbox` rows are anything else waiting on the human. */
export type WaitingItem = BlockedQueueRow & { kind: "rsi" | "inbox" };

/**
 * The set the banner is about.
 *  - rsi: parked on a human seat, created by the configured steward, and tagged rsi. The tag is free text any
 *    seat can write, so the source is the authority for the RSI wording.
 *  - inbox: addressed to the operator's local inbox and open (pending), or parked on it. The sender is not
 *    trusted either (source_session is a label), so these rows get generic wording, and the shared gap and
 *    daily cap are what stop a spamming seat.
 */
export function selectWaitingItems(rows: BlockedQueueRow[], stewardSession: string | null): WaitingItem[] {
  const out: WaitingItem[] = [];
  for (const r of rows) {
    if (r.state === "blocked" && isHumanSeatSession(r.blockedOn) && r.sourceSession === stewardSession && r.tags.includes(RSI_TAG)) {
      out.push({ ...r, kind: "rsi" });
    } else if ((r.state === "pending" && r.destinationSession === LOCAL_HUMAN_INBOX_ADDRESS) || (r.state === "blocked" && r.blockedOn === LOCAL_HUMAN_INBOX_ADDRESS)) {
      out.push({ ...r, kind: "inbox" });
    }
  }
  return out;
}

/** Key of one parking episode in rsi_notifications (its schema has only qitem_id as the key). */
export function episodeKey(row: Pick<BlockedQueueRow, "qitemId" | "episode">): string {
  return `${row.qitemId}@${row.episode}`;
}


function clean(text: string, max: number): string {
  // The text is shown, never interpreted, but Jim decides from it: drop every format (Cf: bidi overrides and
  // isolates, zero-width) character, and turn control (Cc: C0, DEL, C1) and line/paragraph separators into a space.
  const flat = text.replace(/[\p{Cf}]+/gu, "").replace(/[\p{Cc}\u2028\u2029]+/gu, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function tagValue(tags: string[], prefix: string): string | null {
  const hit = tags.find((t) => t.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

export function composeBannerMessage(waiting: WaitingItem[], lead: WaitingItem): string {
  const allRsi = waiting.every((w) => w.kind === "rsi");
  const noun = allRsi ? "RSI item(s) waiting" : "item(s) waiting for you";
  let head: string;
  if (lead.kind === "rsi") {
    const stage = clean(tagValue(lead.tags, "rsi:stage:") ?? "unstaged", MAX_FIELD_CHARS);
    const fp = clean(tagValue(lead.tags, "rsi:fp:") ?? "unknown", MAX_FIELD_CHARS);
    head = `${waiting.length} ${noun} · ${stage} ${fp} · rsi-decide ${clean(lead.qitemId, MAX_FIELD_CHARS)}`;
  } else {
    head = `${waiting.length} ${noun} · from ${clean(lead.sourceSession, MAX_FIELD_CHARS)} · ${clean(lead.qitemId, MAX_FIELD_CHARS)}`;
  }
  const summary = lead.summary ? clean(lead.summary, MAX_FIELD_CHARS) : "";
  return clean(summary ? `${head} · ${summary}` : head, MAX_MESSAGE_CHARS);
}

/**
 * The argv for one banner. terminal-notifier when installed (its `-group` makes a banner replace
 * the previous one); otherwise osascript with the text as argv items of a fixed script. No shell
 * and no string-built AppleScript: the message never becomes script source.
 */
export function bannerCommand(
  terminalNotifierPath: string | null,
  title: string,
  message: string,
): { command: string; args: string[] } {
  if (terminalNotifierPath) {
    return { command: terminalNotifierPath, args: ["-title", title, "-message", message, "-group", NOTIFICATION_GROUP] };
  }
  return {
    command: OSASCRIPT_PATH,
    args: [
      "-e", "on run argv",
      "-e", "display notification (item 1 of argv) with title (item 2 of argv)",
      "-e", "end run",
      "--", message, title,
    ],
  };
}

export class HumanGateNotifier {
  private readonly clock: () => Date;
  private readonly platform: NodeJS.Platform;
  private readonly log: (line: string) => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /** Outcome of the last spawn, so the first banner proves delivery from the daemon process. */
  lastResult: { at: string; command: string; ok: boolean } | null = null;

  constructor(private readonly deps: HumanGateNotifierDeps) {
    this.clock = deps.clock ?? (() => new Date());
    this.platform = deps.platform ?? process.platform;
    this.log = deps.log ?? ((line) => console.warn(line));
  }

  start(): void {
    if (this.timer) return;
    if (this.platform !== "darwin") {
      this.log(`[rsi-notifier] no-op on platform ${this.platform}; banners are macOS-only`);
      return;
    }
    this.timer = setInterval(() => { void this.tick(); }, this.deps.intervalMs ?? NOTIFIER_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<NotifierTickResult> {
    if (this.platform !== "darwin") return { status: "noop-platform" };
    if (this.running) return { status: "error", errorClass: "ReentrantTick" };
    this.running = true;
    try {
      return await this.tickOnce();
    } catch (err) {
      // A foreign error contributes its class only: its message may carry queue content.
      const errorClass = err instanceof Error ? err.constructor.name : typeof err;
      this.log(`[rsi-notifier] tick failed class=${errorClass}`);
      return { status: "error", errorClass };
    } finally {
      this.running = false;
    }
  }

  private async tickOnce(): Promise<NotifierTickResult> {
    const nowMs = this.clock().getTime();
    const nowIso = new Date(nowMs).toISOString();
    const waiting = selectWaitingItems(this.deps.listWaiting(), this.deps.stewardSession);
    // A stored time that is unparseable or later than now cannot be a past banner: the row is ignored (for the gap, the
    // cap and the item's own entry state), so one bad row cannot block every banner. A sent banner rewrites the item's row.
    const rows = this.deps.store.list()
      .map((r) => ({ ...r, lastMs: Date.parse(r.lastNotifiedAt) }))
      .filter((r) => Number.isFinite(r.lastMs) && r.lastMs <= nowMs);
    const byKey = new Map(rows.map((r) => [r.qitemId, r]));
    const waitingKeys = new Set(waiting.map(episodeKey));

    // Rows older than a day for episodes that no longer wait (and old attempts) carry no gap or cap information; drop them.
    const dayAgo = nowMs - REMINDER_INTERVAL_MS;
    const stale = rows.filter((r) => !waitingKeys.has(r.qitemId) && r.lastMs <= dayAgo).map((r) => r.qitemId);
    if (stale.length > 0) this.deps.store.deleteOlderThan(stale, new Date(dayAgo + 1).toISOString());

    const pending = waiting.filter((w) => {
      const row = byKey.get(episodeKey(w));
      return !row || row.lastMs <= nowMs - REMINDER_INTERVAL_MS;
    });
    if (pending.length === 0) return { status: "idle", waiting: waiting.length };

    // The gap and the cap count banner ATTEMPTS, successful or not: a failing spawner must not run a child
    // process every gap all day, and a restart must not forget the last attempt. A future-stamped row is ignored.
    const banners = this.deps.store.listBanners()
      .map((b) => Date.parse(b.sentAt))
      .filter((t) => Number.isFinite(t) && t <= nowMs);
    const lastBannerMs = Math.max(0, ...banners);
    if (nowMs - lastBannerMs < MIN_BANNER_GAP_MS) {
      return { status: "coalesced", waiting: waiting.length, pending: pending.length };
    }
    if (banners.filter((t) => t > dayAgo).length >= MAX_BANNERS_PER_DAY) {
      return { status: "capped", waiting: waiting.length, pending: pending.length };
    }

    // New entries lead over reminders, so the named item is the one that just arrived.
    const lead = pending.find((p) => !byKey.has(episodeKey(p))) ?? pending[0]!;
    const message = composeBannerMessage(waiting, lead);
    const terminalNotifier = this.deps.findExecutable("terminal-notifier");
    const title = waiting.every((w) => w.kind === "rsi") ? NOTIFICATION_TITLE : INBOX_NOTIFICATION_TITLE;
    let { command, args } = bannerCommand(terminalNotifier, title, message);
    let result = await this.deps.spawner(command, args);
    if (terminalNotifier && shouldFallBackToOsascript(result)) {
      // OF-83: terminal-notifier can be installed yet unable to post (exit 3: notifications are off for
      // fr.julienxx.oss.terminal-notifier). osascript posts under a different app identity, so try it once
      // before giving up. Not after a timeout or a signal: terminal-notifier may already have posted, and a second
      // banner would be a duplicate (u16 review N2). The reason in the log tells an operator why it failed.
      this.log(`[rsi-notifier] terminal-notifier banner failed ${bannerFailureReason(result)}; falling back to osascript`);
      ({ command, args } = bannerCommand(null, title, message));
      result = await this.deps.spawner(command, args);
    }
    this.lastResult = { at: nowIso, command: path.basename(command), ok: result.ok };
    this.deps.store.recordBanner({ sentAt: nowIso, itemCount: pending.length, ok: result.ok });
    this.deps.store.deleteBannersBefore(new Date(dayAgo).toISOString());
    if (!result.ok) {
      this.log(`[rsi-notifier] banner spawn failed command=${path.basename(command)} ${bannerFailureReason(result)}`);
      // The items stay unnotified: they are retried after the gap.
      return { status: "failed", waiting: waiting.length, command: path.basename(command) };
    }
    const notified = pending.map(episodeKey);
    this.deps.store.record(notified, nowIso);
    return { status: "sent", waiting: waiting.length, notified, command: path.basename(command) };
  }
}

/** This many latest banner attempts in a row, all failed, is "banners keep failing". */
export const BANNER_FAILURE_STREAK = 3;

/**
 * `rig health` coverage for the one signal an item to Jim now has. The stuck sweep no longer escalates inbox items, so a
 * banner that cannot be posted (notifications off, spawn errors) or a notifier that was never built would leave an item
 * unseen with nothing saying so. This source reads no findings; it only reports an "unavailable" coverage row while that
 * is true. The banner failures come from the durable attempt table (rsi_notification_banners); a construction failure is
 * known for the life of this daemon process. Silent when healthy, and on a platform with no banners by design.
 */
export class HumanInboxBannerHealthSource implements HealthObservationSource {
  readonly name = "human-inbox-banner";
  private listBanners: (() => BannerRow[]) | null = null;
  private constructionFailure: string | null = null;
  constructor(private readonly clock: () => Date = () => new Date()) {}

  attach(listBanners: () => BannerRow[]): void { this.listBanners = listBanners; }
  markConstructionFailed(errorClass: string): void { this.constructionFailure = errorClass; }

  read(): readonly HealthDetectorObservation[] { return []; }

  coverage(): readonly HealthSourceCoverage[] {
    const evaluatedAt = this.clock().toISOString();
    const unavailable = (reason: string): HealthSourceCoverage[] => [{ source: this.name, evaluatedAt, status: "unavailable", partial: true, reason }];
    if (this.constructionFailure) {
      return unavailable(`the macOS banner notifier was not built (class=${this.constructionFailure}); items addressed to human@kernel are not announced`);
    }
    if (!this.listBanners) return [];
    const recent = this.listBanners()
      .filter((b) => Number.isFinite(Date.parse(b.sentAt)))
      .sort((a, b) => Date.parse(b.sentAt) - Date.parse(a.sentAt))
      .slice(0, BANNER_FAILURE_STREAK);
    if (recent.length === BANNER_FAILURE_STREAK && recent.every((b) => !b.ok)) {
      return unavailable(`the last ${BANNER_FAILURE_STREAK} macOS banner attempts failed (latest ${recent[0]!.sentAt}); check that notifications are allowed for terminal-notifier / Script Editor. Items addressed to human@kernel are not being announced`);
    }
    return [];
  }
}

/** Reads the rows that can wait on the human from the daemon database: every `blocked` row, and every `pending` row addressed to the inbox. SELECT only. */
export function sqliteWaitingRows(db: Database.Database): () => BlockedQueueRow[] {
  const stmt = db.prepare(
    "SELECT q.qitem_id, q.source_session, q.destination_session, q.state, q.blocked_on, q.tags, q.summary, " +
    // The parking episode is the transition that ENTERED blocked from another state. A blocked-to-blocked
    // transition (a second update, a watchdog park-wake, a custody move) is the same episode. An open
    // (pending) row has one episode for its life: its creation time.
    "CASE WHEN q.state = 'blocked' THEN " +
    "COALESCE((SELECT MAX(t.transition_id) FROM queue_transitions t WHERE t.qitem_id = q.qitem_id AND t.state = 'blocked' " +
    "AND COALESCE((SELECT p.state FROM queue_transitions p WHERE p.qitem_id = t.qitem_id AND p.transition_id < t.transition_id " +
    "ORDER BY p.transition_id DESC LIMIT 1), '') <> 'blocked'), q.ts_updated) ELSE q.ts_created END AS episode " +
    // Oldest first, so the banner's lead (the first new entry) is the oldest waiting item, not whichever the table returns first.
    "FROM queue_items q WHERE q.state = 'blocked' OR (q.state = 'pending' AND q.destination_session = ?) ORDER BY q.ts_created ASC, q.qitem_id ASC",
  );
  return () => (stmt.all(LOCAL_HUMAN_INBOX_ADDRESS) as Array<{ qitem_id: string; source_session: string; destination_session: string; state: string; blocked_on: string | null; tags: string | null; summary: string | null; episode: string | number }>)
    .map((r) => ({ qitemId: r.qitem_id, sourceSession: r.source_session, destinationSession: r.destination_session, episode: String(r.episode), state: r.state, blockedOn: r.blocked_on, tags: parseTags(r.tags), summary: r.summary }));
}

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

/** The notifier's own table. The only write path of the notifier. */
export function sqliteNotificationStore(db: Database.Database): NotificationStore {
  const list = db.prepare("SELECT qitem_id, first_notified_at, last_notified_at FROM rsi_notifications");
  const upsert = db.prepare(
    "INSERT INTO rsi_notifications (qitem_id, first_notified_at, last_notified_at) VALUES (?, ?, ?) " +
    "ON CONFLICT(qitem_id) DO UPDATE SET last_notified_at = excluded.last_notified_at",
  );
  const del = db.prepare("DELETE FROM rsi_notifications WHERE qitem_id = ? AND last_notified_at < ?");
  const listBanners = db.prepare("SELECT sent_at, item_count, ok FROM rsi_notification_banners");
  const insertBanner = db.prepare("INSERT INTO rsi_notification_banners (sent_at, item_count, ok) VALUES (?, ?, ?)");
  const deleteBanners = db.prepare("DELETE FROM rsi_notification_banners WHERE sent_at < ?");
  return {
    list: () => (list.all() as Array<{ qitem_id: string; first_notified_at: string; last_notified_at: string }>)
      .map((r) => ({ qitemId: r.qitem_id, firstNotifiedAt: r.first_notified_at, lastNotifiedAt: r.last_notified_at })),
    record: (ids, at) => db.transaction(() => { for (const id of ids) upsert.run(id, at, at); })(),
    listBanners: () => (listBanners.all() as Array<{ sent_at: string; item_count: number; ok: number }>)
      .map((r) => ({ sentAt: r.sent_at, itemCount: r.item_count, ok: r.ok === 1 })),
    recordBanner: (row) => { insertBanner.run(row.sentAt, row.itemCount, row.ok ? 1 : 0); },
    deleteBannersBefore: (cutoff) => { deleteBanners.run(cutoff); },
    deleteOlderThan: (ids, cutoff) => db.transaction(() => { for (const id of ids) del.run(id, cutoff); })(),
  };
}

/** No shell: argv array, stdio ignored, killed after a bound. */
export const defaultBannerSpawner: BannerSpawner = (command, args) =>
  new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean, exitCode: number | null, cause?: BannerFailureCause) => {
      if (!settled) { settled = true; resolve(ok ? { ok, exitCode } : { ok, exitCode, cause }); }
    };
    try {
      const child = spawn(command, args, { stdio: "ignore", shell: false });
      const timer = setTimeout(() => { child.kill(); done(false, null, "timeout"); }, SPAWN_TIMEOUT_MS);
      timer.unref?.();
      child.on("error", () => { clearTimeout(timer); done(false, null, "spawn-error"); });
      child.on("exit", (code) => { clearTimeout(timer); done(code === 0, code, code === null ? "signal" : "exit"); });
    } catch {
      done(false, null, "spawn-error");
    }
  });

/** Fixed install locations only. The daemon's PATH is never consulted: a banner binary is not found by search. */
export const TERMINAL_NOTIFIER_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"] as const;

export function defaultFindExecutable(name: string, dirs: readonly string[] = TERMINAL_NOTIFIER_DIRS): string | null {
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch { /* next */ }
  }
  return null;
}
