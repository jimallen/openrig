import type Database from "better-sqlite3";
import { LOCAL_HUMAN_INBOX_ADDRESS } from "../gateway/destination-resolver.js";
import type { HealthDetectorObservation, HealthObservationSource, HealthSourceCoverage } from "../health-detectors.js";
import { parseSqliteUtcMs } from "../sqlite-time.js";

/**
 * `rig health` coverage for the operator's local inbox (`human@kernel`, LOCAL_HUMAN_INBOX_ADDRESS). Items reach Jim
 * through the inbox panel; nothing posts a banner any more. This source only says, in `rig health`, that open items
 * have waited too long. It reads queue state (SELECT only), writes nothing, and never pages, posts or spawns.
 *
 * Shape: coverage-only, like the banner health source it replaces. It reads no findings; it reports one "unavailable"
 * coverage row while any item has waited longer than HUMAN_INBOX_WAIT_THRESHOLD_MS, and is silent otherwise.
 * An item waits when it is `pending` and addressed to the inbox (age from ts_created), or `blocked` on the inbox
 * (age from ts_updated, which only understates a long park, so it never over-flags).
 */
export const HUMAN_INBOX_WAIT_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export interface InboxWaitingRow { qitemId: string; since: string }

export class HumanInboxWaitingHealthSource implements HealthObservationSource {
  readonly name = "human-inbox-waiting";
  constructor(
    private readonly listWaiting: () => InboxWaitingRow[],
    private readonly clock: () => Date = () => new Date(),
  ) {}

  read(): readonly HealthDetectorObservation[] { return []; }

  coverage(): readonly HealthSourceCoverage[] {
    const now = this.clock();
    const nowMs = now.getTime();
    const overdue = this.listWaiting()
      .map((r) => ({ qitemId: r.qitemId, sinceMs: parseSqliteUtcMs(r.since) }))
      .filter((r) => Number.isFinite(r.sinceMs) && nowMs - r.sinceMs > HUMAN_INBOX_WAIT_THRESHOLD_MS)
      .sort((a, b) => a.sinceMs - b.sinceMs || a.qitemId.localeCompare(b.qitemId));
    if (overdue.length === 0) return [];
    const oldest = overdue[0]!;
    const hours = Math.floor((nowMs - oldest.sinceMs) / 3_600_000);
    return [{
      source: this.name,
      evaluatedAt: now.toISOString(),
      status: "unavailable",
      partial: true,
      reason: `${overdue.length} item(s) addressed to ${LOCAL_HUMAN_INBOX_ADDRESS} have waited over 24 h (oldest ${oldest.qitemId}, ${hours} h); open the inbox panel or run rig queue show ${oldest.qitemId}`,
    }];
  }
}

/** Open rows that wait on the inbox: `pending` addressed to it, or `blocked` on it. SELECT only. */
export function sqliteInboxWaitingRows(db: Database.Database): () => InboxWaitingRow[] {
  const stmt = db.prepare(
    "SELECT qitem_id, CASE WHEN state = 'pending' THEN ts_created ELSE ts_updated END AS since FROM queue_items " +
    "WHERE (state = 'pending' AND destination_session = ?) OR (state = 'blocked' AND blocked_on = ?) ORDER BY ts_created ASC, qitem_id ASC",
  );
  return () => (stmt.all(LOCAL_HUMAN_INBOX_ADDRESS, LOCAL_HUMAN_INBOX_ADDRESS) as Array<{ qitem_id: string; since: string }>)
    .map((r) => ({ qitemId: r.qitem_id, since: r.since }));
}
