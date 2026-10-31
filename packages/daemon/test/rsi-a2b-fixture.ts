import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { HealthProjectionService, type HealthObservationSource } from "../src/domain/health-detectors.js";
import type { HealthRecord } from "../src/domain/health-projection.js";
import { RsiReadOnlyConnection, sqliteUtcStamp, type RsiFindingSourceDeps } from "../src/domain/rsi/finding-builder.js";

/** Far from wall clock (2026): a wall-clock reversion would move every fixture row out of its window. */
export const NOW = new Date("2031-03-04T05:06:07.000Z");
export const INSTANCE = "instance-fixture";

export const hoursAgo = (hours: number): Date => new Date(NOW.getTime() - hours * 3_600_000);
/** `events.created_at` form. */
export const stamp = (hours: number): string => sqliteUtcStamp(hoursAgo(hours));
/** ISO form used by usage_samples, outbox_entries and stream_items. */
export const iso = (hours: number): string => hoursAgo(hours).toISOString();

const dirs: string[] = [];
const open: Database.Database[] = [];
export function cleanupFixtures(): void {
  while (open.length) open.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
}

let counter = 0;

/** File-backed fixture: SQLite refuses a read-only connection to an in-memory database. */
export function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "rsi-a2b-"));
  dirs.push(dir);
  const dbPath = join(dir, "openrig.sqlite");
  const db = createDb(dbPath);
  open.push(db);
  migrate(db, ALL_MIGRATIONS);
  const deps = (extra: { rowLimit?: number } = {}): RsiFindingSourceDeps =>
    ({ connection: new RsiReadOnlyConnection(dbPath), instanceId: INSTANCE, now: () => NOW, ...extra });

  const event = (type: string, payload: unknown, createdAt: string, ids: { rigId?: string; nodeId?: string } = {}) =>
    Number(db.prepare("INSERT INTO events (rig_id, node_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(ids.rigId ?? null, ids.nodeId ?? null, type, typeof payload === "string" ? payload : JSON.stringify(payload), createdAt).lastInsertRowid);
  const activity = (a: { seat: string; rawEvent?: string; rawSubtype?: string | null; state?: string; hoursAgo: number; rigId?: string; nodeId?: string; type?: string; identity?: boolean; generation?: string }) => {
    const type = a.type ?? "agent.activity";
    const rawEvent = a.rawEvent ?? "SessionStart";
    const seq = event(type, {
      type, rigId: a.rigId ?? "rig-1", nodeId: a.nodeId ?? `node-${a.seat}`, sessionName: a.seat, runtime: "claude-code",
      activity: { state: a.state ?? "unknown", rawEvent, ...(a.rawSubtype === null ? {} : { rawSubtype: a.rawSubtype ?? "compact" }), ...(a.generation ? { generation: a.generation } : {}) },
    }, stamp(a.hoursAgo), { rigId: a.rigId ?? "rig-1", nodeId: a.nodeId ?? `node-${a.seat}` });  // the columns, as the daemon writes them
    // The daemon records one agent.session_identity event beside every SessionStart hook event.
    if (type === "agent.activity" && rawEvent === "SessionStart" && a.identity !== false) {
      event("agent.session_identity", { type: "agent.session_identity", sessionName: a.seat, provenance: "hook" }, stamp(a.hoursAgo));
    }
    return seq;
  };
  const fired = (f: { jobId: string; deliveryStatus: string; hoursAgo: number; type?: string }) =>
    event(f.type ?? "watchdog.evaluation_fired", { type: f.type ?? "watchdog.evaluation_fired", jobId: f.jobId, policy: "p", targetSession: "t@r", deliveryStatus: f.deliveryStatus }, stamp(f.hoursAgo));

  const usage = (u: { lane: "context" | "provider_window"; seat?: string; pct?: number | null; window?: "weekly" | "five_hour" | null; source?: string | null; hoursAgo: number; resetsAt?: string | null; capturedAt?: string }) =>
    Number(db.prepare(`INSERT INTO usage_samples (lane, seat_session, source, captured_at, used_percentage, window, window_used_percent, resets_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      u.lane, u.seat ?? "seat-a@rig", u.source === undefined ? "src" : u.source, u.capturedAt ?? iso(u.hoursAgo),
      u.lane === "context" ? (u.pct ?? null) : null, u.lane === "provider_window" ? (u.window ?? "weekly") : null,
      u.lane === "provider_window" ? (u.pct ?? null) : null, u.resetsAt ?? null).lastInsertRowid);

  const outbox = (o: { prov?: string | null; state: string; hoursAgo: number; retiredAt?: string | null }) =>
    Number(db.prepare(`INSERT INTO outbox_entries (outbox_id, sender_session, destination_session, body, ts_dispatched, delivery_state, identity_provenance, retired_at)
      VALUES (?, 's@r', 'd@r', 'BODY-CANARY', ?, ?, ?, ?)`).run(`o-${++counter}`, iso(o.hoursAgo), o.state, o.prov === undefined ? "transport:v1" : o.prov, o.retiredAt ?? null).lastInsertRowid);

  const stream = (s: { session: string; tags: unknown; hoursAgo: number; archivedAt?: string | null; body?: string }) =>
    Number(db.prepare(`INSERT INTO stream_items (stream_item_id, ts_emitted, stream_sort_key, source_session, body, hint_tags, archived_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(`st-${++counter}`, iso(s.hoursAgo), `k-${counter}`, s.session, s.body ?? "BODY-CANARY",
      s.tags === null ? null : typeof s.tags === "string" ? s.tags : JSON.stringify(s.tags), s.archivedAt ?? null).lastInsertRowid);

  const rig = (name: string, archivedAt: string | null = null) =>
    db.prepare("INSERT INTO rigs (id, name, archived_at) VALUES (?, ?, ?)").run(`rig-id-${++counter}`, name, archivedAt);

  /** Runs `then` once, right after the first statement the source runs has returned its rows. */
  const afterFirstStatement = (source: { readonlyHandle(): Database.Database }, then: () => void) => {
    const handle = source.readonlyHandle();
    const original = handle.prepare.bind(handle);
    let done = false;
    handle.prepare = ((sql: string) => {
      const statement = original(sql);
      for (const method of ["all", "get"] as const) {
        const run = statement[method].bind(statement) as (...a: unknown[]) => unknown;
        (statement as unknown as Record<string, unknown>)[method] = (...a: unknown[]) => {
          const result = run(...a);
          if (!done) { done = true; then(); }
          return result;
        };
      }
      return statement;
    }) as typeof handle.prepare;
  };
  /** Counts the statements a source prepares. */
  const countStatements = (source: { readonlyHandle(): Database.Database }) => {
    const handle = source.readonlyHandle();
    const original = handle.prepare.bind(handle);
    const seen: string[] = [];
    handle.prepare = ((sql: string) => { seen.push(sql); return original(sql); }) as typeof handle.prepare;
    return seen;
  };

  const records = (source: HealthObservationSource): HealthRecord[] => new HealthProjectionService([source]).records();
  return { dir, dbPath, db, deps, event, activity, fired, usage, outbox, stream, rig, afterFirstStatement, countStatements, records };
}

export function span(record: HealthRecord) {
  const item = record.evidence.find((e) => e.type === "telemetry-span");
  if (!item || item.type !== "telemetry-span") throw new Error("record carries no telemetry-span evidence");
  return item;
}
