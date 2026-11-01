import type Database from "better-sqlite3";

/** One seat's compaction sequence as a restart must find it. `preparation` is the attempt without its AbortController. */
export interface PersistedCompactionSeat {
  sessionName: string;
  stage: "turn_boundary" | "restore_prompt" | "compliance_prompt" | null;
  stageGeneration: string | null;
  stageCycle: string | null;
  manual: { stage: string; reason?: string; updatedAt: number; operatorInitiated?: boolean } | null;
  preparation: {
    attemptId: string; occupantGeneration: string | null; mapPath: string; marker: string; mode: "automatic" | "manual";
    status: "sending" | "waiting" | "stopped" | "compact-sent"; delivery: "pending" | "not_sent" | "delivered" | "uncertain";
    deadlineAt: number | null; reason?: string; sends: number; policyWasEnabled: boolean;
  } | null;
}

/** The enforcer's stages, one row per seat (migration 122). A row that cannot be read is skipped with a warning: a lost stage is the
 *  old behaviour, and one damaged row must not stop the daemon's boot or another seat's restore. */
export class CompactionStageStore {
  private readonly available: boolean;

  constructor(private readonly db: Database.Database) {
    this.available = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'compaction_stages'").get() !== undefined;
  }

  save(seat: PersistedCompactionSeat): void {
    if (!this.available) return;
    this.db.prepare(`INSERT INTO compaction_stages (session_name, state, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(session_name) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`)
      .run(seat.sessionName, JSON.stringify(seat), new Date().toISOString());
  }

  remove(sessionName: string): void {
    if (!this.available) return;
    this.db.prepare("DELETE FROM compaction_stages WHERE session_name = ?").run(sessionName);
  }

  loadAll(): PersistedCompactionSeat[] {
    if (!this.available) return [];
    const rows = this.db.prepare("SELECT session_name, state FROM compaction_stages").all() as Array<{ session_name: string; state: string }>;
    return rows.flatMap((row) => {
      try {
        return [JSON.parse(row.state) as PersistedCompactionSeat];
      } catch {
        console.warn(`[compaction] the saved stage of ${row.session_name} is not readable; that seat starts with none`);
        return [];
      }
    });
  }
}
