// OF-182 / OF-184: the seam that makes the post-restart prompt run. `startup.ts` calls wirePostRestartPrompt once; this
// module owns what the notifier is plugged into (the sessions and rigs tables, the event bus, the setting) so one test can
// drive it against a real database, and a second can prove startup calls it.
//
// Daemon restart (OF-184): the event bus keeps no pending work, so a restart between restore.completed and delivery would
// drop the prompt. Every restore.completed is a row in `events` with its full result, and the outbox row under the fixed
// delivery id says "done", so on boot the notifier is run again over the restores still inside the window (rederiveFromLog).
import type Database from "better-sqlite3";
import type { EventBus } from "./event-bus.js";
import type { PersistedEvent, RestoreResult } from "./types.js";
import {
  PostRestartNotifier,
  type PostRestartDeps,
  type PostRestartOutcome,
} from "./post-restart-notifier.js";

export interface PostRestartWiringOptions {
  db: Database.Database;
  eventBus: Pick<EventBus, "subscribe">;
  send: PostRestartDeps["send"];
  outbox: PostRestartDeps["outbox"];
  /** The `recovery.post_restart_prompt` setting. May throw. */
  readSwitch: () => boolean;
  log: (line: string) => void;
  /** Timing and clock overrides (tests, and the daemon option that shortens them). */
  timing?: Pick<PostRestartDeps, "now" | "sleep" | "firstDelayMs" | "retryEveryMs" | "windowMs" | "waitForIdleMs">;
}

export interface PostRestartWiring {
  notifier: PostRestartNotifier;
  /** Run the notifier over every restore.completed still inside the window. Resolves when all are settled. */
  rederiveFromLog: () => Promise<PostRestartOutcome[]>;
}

const DEFAULT_WINDOW_MS = 30 * 60_000;

/** SQLite `datetime('now')` text ("YYYY-MM-DD HH:MM:SS", UTC) as ISO; unparseable text is returned unchanged. */
export function sqliteUtcToIso(text: string): string {
  const ms = Date.parse(`${text.replace(" ", "T")}Z`);
  return Number.isNaN(ms) ? text : new Date(ms).toISOString();
}

export function wirePostRestartPrompt(o: PostRestartWiringOptions): PostRestartWiring {
  const { db } = o;
  const notifier = new PostRestartNotifier({
    // Settings read failure (OF-184): fail OPEN, to the setting's default (on). The prompt is advisory and sent once; a
    // missed one is the costly error (eztrack lost ~40 minutes to a silently killed background task), an unwanted one is
    // one harmless line. The failure is logged so an operator who turned it off can see why it came back.
    enabled: () => {
      try {
        return o.readSwitch();
      } catch (err) {
        o.log(`[post-restart] could not read recovery.post_restart_prompt (${err instanceof Error ? err.message : String(err)}); using the default (on)`);
        return true;
      }
    },
    sessionOf: (nodeId) => {
      const row = db
        .prepare("SELECT session_name AS name, created_at AS createdAt FROM sessions WHERE node_id = ? AND status = 'running' ORDER BY rowid DESC LIMIT 1")
        .get(nodeId) as { name: string; createdAt: string } | undefined;
      return row ? { name: row.name, startedAt: sqliteUtcToIso(row.createdAt) } : null;
    },
    rigNameOf: (rigId) => (db.prepare("SELECT name FROM rigs WHERE id = ?").get(rigId) as { name: string } | undefined)?.name ?? null,
    send: o.send,
    outbox: o.outbox,
    log: o.log,
    ...o.timing,
  });

  const run = (event: { seq: number; rigId: string; result: RestoreResult; createdAt: string }): Promise<PostRestartOutcome[]> =>
    notifier.onRestoreCompleted({ ...event, createdAt: sqliteUtcToIso(event.createdAt) });

  o.eventBus.subscribe((event: PersistedEvent) => {
    if (event.type !== "restore.completed") return;
    void run({ seq: event.seq, rigId: event.rigId, result: event.result, createdAt: event.createdAt })
      .catch((err) => o.log(`[post-restart] ${err instanceof Error ? err.message : String(err)}`));
  });

  const windowMs = o.timing?.windowMs ?? DEFAULT_WINDOW_MS;
  const nowMs = () => (o.timing?.now ?? (() => new Date()))().getTime();

  return {
    notifier,
    rederiveFromLog: async () => {
      const rows = db
        .prepare("SELECT seq, rig_id AS rigId, payload, created_at AS createdAt FROM events WHERE type = 'restore.completed' ORDER BY seq DESC LIMIT 200")
        .all() as Array<{ seq: number; rigId: string | null; payload: string; createdAt: string }>;
      const open = rows.filter((r) => nowMs() - Date.parse(sqliteUtcToIso(r.createdAt)) < windowMs && r.rigId);
      const settled = await Promise.all(open.map(async (r) => {
        try {
          const payload = JSON.parse(r.payload) as { result?: RestoreResult };
          if (!payload.result || !Array.isArray(payload.result.nodes)) return [];
          return await run({ seq: r.seq, rigId: r.rigId as string, result: payload.result, createdAt: r.createdAt });
        } catch (err) {
          o.log(`[post-restart] restore.completed seq ${r.seq} not re-derived: ${err instanceof Error ? err.message : String(err)}`);
          return [];
        }
      }));
      return settled.flat();
    },
  };
}
