import type Database from "better-sqlite3";
import type { SessionRegistry } from "./session-registry.js";
import type { EventBus } from "./event-bus.js";
import type { TmuxAdapter } from "../adapters/tmux.js";

export interface ReconcileResult {
  checked: number;
  detached: number;
  errors: { sessionId: string; error: string }[];
}

interface ReconcilerDeps {
  db: Database.Database;
  sessionRegistry: SessionRegistry;
  eventBus: EventBus;
  tmuxAdapter: TmuxAdapter;
}

// Only an active/non-terminal session can become detached. In particular,
// superseded rows are occupant history: rewriting one to detached resurrects
// it as a restore candidate and makes the next reboot ambiguous.
const SKIP_STATUSES = new Set(["detached", "exited", "superseded"]);

export class Reconciler {
  private db: Database.Database;
  private sessionRegistry: SessionRegistry;
  private eventBus: EventBus;
  private tmuxAdapter: TmuxAdapter;

  constructor(deps: ReconcilerDeps) {
    if (deps.db !== deps.sessionRegistry.db) {
      throw new Error("Reconciler: sessionRegistry must share the same db handle");
    }
    if (deps.db !== deps.eventBus.db) {
      throw new Error("Reconciler: eventBus must share the same db handle");
    }

    this.db = deps.db;
    this.sessionRegistry = deps.sessionRegistry;
    this.eventBus = deps.eventBus;
    this.tmuxAdapter = deps.tmuxAdapter;
  }

  async reconcile(rigId: string): Promise<ReconcileResult> {
    const sessions = this.sessionRegistry.getSessionsForRig(rigId);

    let checked = 0;
    let detached = 0;
    const errors: { sessionId: string; error: string }[] = [];

    for (const session of sessions) {
      if (SKIP_STATUSES.has(session.status)) {
        continue;
      }

      let alive: boolean;
      try {
        // Boot-time reconciliation against a dead tmux server must still
        // detach stale rows: transport-absence is treated as detachable HERE,
        // by explicit choice at this call site (OPR.0.5.4.2 mini-req 2 — the
        // adapter no longer collapses that decision for its callers).
        const probe = await this.tmuxAdapter.probeSession(session.sessionName);
        alive = probe.state === "present";
        checked++;
      } catch (err) {
        errors.push({
          sessionId: session.id,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      if (!alive) {
        try {
          const txn = this.db.transaction(() => {
            this.sessionRegistry.markDetached(session.id);
            return this.eventBus.persistWithinTransaction({
              type: "session.detached",
              rigId,
              nodeId: session.nodeId,
              sessionName: session.sessionName,
            });
          });
          const persistedEvent = txn();
          this.eventBus.notifySubscribers(persistedEvent);
          detached++;
        } catch (err) {
          errors.push({
            sessionId: session.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    return { checked, detached, errors };
  }

  /**
   * OF-177: end the session rows of ARCHIVED rigs whose host session no longer exists.
   *
   * The boot reconcile iterates `listRigs()`, which hides archived rigs, so a rig archived while a
   * seat's row still read `running` (archive allows an attention_required rig) kept that row for
   * ever: it showed as a running seat and was polled for cost. This pass covers those rigs.
   *
   * Stricter than `reconcile()`: only a POSITIVE absence ends a row. A probe that throws, or that
   * reports transport_unavailable (a dead or restarting terminal server), proves nothing about the
   * session, so the row is left for a later pass. Idempotent: ended rows are skipped, and the write
   * re-checks inside the transaction that the rig is still archived and the row still active.
   * Pass `rigId` to scope it to one rig (the archive route); omit it to cover every archived rig.
   */
  async reconcileArchivedRigs(rigId?: string): Promise<ReconcileResult> {
    const rows = this.db.prepare(
      `SELECT s.id AS id, s.node_id AS node_id, s.session_name AS session_name, n.rig_id AS rig_id
         FROM sessions s JOIN nodes n ON n.id = s.node_id JOIN rigs r ON r.id = n.rig_id
        WHERE r.archived_at IS NOT NULL AND s.status NOT IN ('detached', 'exited', 'superseded')
          AND (? IS NULL OR r.id = ?)
        ORDER BY s.created_at, s.id`,
    ).all(rigId ?? null, rigId ?? null) as { id: string; node_id: string; session_name: string; rig_id: string }[];

    let checked = 0;
    let detached = 0;
    const errors: { sessionId: string; error: string }[] = [];
    for (const row of rows) {
      try {
        const probe = await this.tmuxAdapter.probeSession(row.session_name);
        checked++;
        if (probe.state !== "absent") continue;
        const persisted = this.db.transaction(() => {
          const still = this.db.prepare(
            `SELECT 1 FROM sessions s JOIN nodes n ON n.id = s.node_id JOIN rigs r ON r.id = n.rig_id
              WHERE s.id = ? AND r.archived_at IS NOT NULL AND s.status NOT IN ('detached', 'exited', 'superseded')`,
          ).get(row.id);
          if (!still) return null;
          this.sessionRegistry.markDetached(row.id);
          return this.eventBus.persistWithinTransaction({
            type: "session.detached",
            rigId: row.rig_id,
            nodeId: row.node_id,
            sessionName: row.session_name,
          });
        })();
        if (persisted) {
          this.eventBus.notifySubscribers(persisted);
          detached++;
        }
      } catch (err) {
        errors.push({ sessionId: row.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { checked, detached, errors };
  }
}
