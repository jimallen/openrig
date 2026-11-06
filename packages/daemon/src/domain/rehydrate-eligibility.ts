import type Database from "better-sqlite3";
import { inheritResumeIdentityBehindFailedLaunches, resolveActiveOccupantRow, resolveActiveSnapshotSession } from "./active-occupant.js";
import { readFreshOccupantRelations } from "./fresh-occupant-relation.js";
import type { RigWithRelations, Snapshot } from "./types.js";

export interface CurrentStateRehydrateEligibility {
  ok: boolean;
  blockers: string[];
}

/**
 * A crash snapshot remains trustworthy only while it names every occupant that
 * durable current state still identifies as active. Boot reconciliation turns
 * rows detached after abrupt substrate loss, so detached rows must participate:
 * a different session id or native resume identity is positive evidence that
 * the snapshot belongs to an older occupant. Ambiguous current state is also
 * not permission to revive a historical occupant; current-state capture
 * preserves the ambiguity and restore refuses it explicitly.
 */
export function snapshotMatchesCurrentOccupants(
  db: Database.Database,
  rig: RigWithRelations,
  snapshot: Snapshot,
): boolean {
  if (rig.nodes.length === 0) return true;
  const rows = db.prepare(
    `SELECT s.id, s.node_id AS nodeId, s.status,
            s.resume_type AS resumeType, s.resume_token AS resumeToken,
            s.startup_status AS startupStatus, s.startup_completed_at AS startupCompletedAt, s.fresh_start AS freshStart,
            s.intentionally_stopped AS stopMark
       FROM sessions s
       JOIN nodes n ON n.id = s.node_id
       WHERE n.rig_id = ?`
  ).all(rig.rig.id) as Array<{
    id: string;
    nodeId: string;
    status: string;
    resumeType: string | null;
    resumeToken: string | null;
    startupStatus: string | null;
    startupCompletedAt: string | null;
    freshStart: number | null;
    stopMark: number | null;
  }>;

  const recorded = readFreshOccupantRelations(db, rig.rig.id);
  // A clean down exits the fresh occupant without revoking its relation.
  // Keep that row for snapshot comparison, but exclude unrelated exited history.
  // OF-255: a row a LATER deliberate stop of the same seat ended behind is not the seat's occupant (the capture drops it too).
  const stops = rows.filter((row) => row.status === "exited" && row.stopMark === 1);
  const candidates = rows.filter((row) => row.status !== "superseded" && (row.status !== "exited" || recorded[row.nodeId] === row.id)
    && !(row.status !== "exited" && stops.some((stop) => stop.nodeId === row.nodeId && stop.id > row.id)));
  for (const node of rig.nodes) {
    const current = resolveActiveOccupantRow(candidates, Object.prototype.hasOwnProperty.call(recorded, node.id) ? recorded : undefined, node.id);
    if (current.kind === "none") continue;
    if (current.kind === "ambiguous") return false;
    const captured = resolveActiveSnapshotSession(snapshot.data, node.id);
    // OF-255: the seat's fresh successor was stopped before the snapshot, which recorded the seat with no occupant and kept
    // the stopped successor's row (status exited). That is the same fact current state holds (a stopped seat, occupant of
    // record X): a match. A snapshot that does not carry that exact row never matches this way.
    if (captured.kind === "none" && current.session.status === "exited"
      && snapshot.data.sessions.some((row) => row.id === current.session.id && row.status === "exited")) continue;
    // The snapshot resolves the occupant's resume identity through its whole history (a failed launch that
    // never reached ready inherits its predecessor's). The candidates above drop that history, so resolve
    // the current row's identity the same way, over every row the node has.
    const currentSession = inheritResumeIdentityBehindFailedLaunches(current.session, rows);
    if (
      captured.kind !== "resolved"
      || captured.session.id !== currentSession.id
      || (captured.session.resumeType ?? null) !== currentSession.resumeType
      || (captured.session.resumeToken ?? null) !== currentSession.resumeToken
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Determines whether current persisted DB state is sufficient to synthesize a
 * restore snapshot after volatile runtime state (tmux) disappeared.
 *
 * This is intentionally conservative. It does not claim provider continuity by
 * itself; it only says the existing restore orchestrator has enough persisted
 * input to attempt a normal restore from an on-demand snapshot.
 */
export function assessCurrentStateRehydrateEligibility(
  db: Database.Database,
  rig: RigWithRelations,
): CurrentStateRehydrateEligibility {
  const blockers: string[] = [];

  if (rig.nodes.length === 0) {
    blockers.push("rig has no nodes to rehydrate");
  }

  const sessions = db.prepare(
    `SELECT node_id, resume_token
       FROM sessions
       WHERE node_id IN (${rig.nodes.map(() => "?").join(",") || "NULL"})
         AND status NOT IN ('superseded', 'exited')
       ORDER BY id DESC`
  ).all(...rig.nodes.map((node) => node.id)) as Array<{ node_id: string; resume_token: string | null }>;

  if (rig.nodes.length > 0 && sessions.length === 0) {
    blockers.push("rig has no persisted sessions to rehydrate");
  }

  const sessionByNode = new Map<string, Array<{ resume_token: string | null }>>();
  for (const session of sessions) {
    const rows = sessionByNode.get(session.node_id) ?? [];
    rows.push(session);
    sessionByNode.set(session.node_id, rows);
  }

  for (const node of rig.nodes) {
    const runtime = node.runtime ?? "";
    const isAgentRuntime = runtime.length > 0 && runtime !== "terminal";
    const hasStartupContext = !!db.prepare(
      "SELECT 1 FROM node_startup_context WHERE node_id = ? LIMIT 1"
    ).get(node.id);
    const hasResumeToken = (sessionByNode.get(node.id) ?? []).some((session) =>
      typeof session.resume_token === "string" && session.resume_token.length > 0
    );

    if (node.podId && !hasStartupContext) {
      blockers.push(`node ${node.logicalId} is pod-aware but has no persisted startup context`);
      continue;
    }

    if (isAgentRuntime && !hasStartupContext && !hasResumeToken) {
      blockers.push(`node ${node.logicalId} has runtime ${runtime} but no startup context or resume token`);
    }
  }

  return { ok: blockers.length === 0, blockers };
}
