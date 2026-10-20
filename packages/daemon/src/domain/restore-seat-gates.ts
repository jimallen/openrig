// OF-40: the gates restore runs on a seat BEFORE it looks at the seat's startup files or starts anything:
//   1. the seat was removed since the snapshot (restore does not recreate nodes),
//   2. which saved session is the seat's cannot be told (active-occupant ambiguity),
//   3. the seat's runtime is not the runtime the snapshot saved its startup context under,
//   4. the seat had no running occupant, but an earlier occupant left a resume token,
//   5. the seat's continuity is `restoring` (restore skips it as fresh and decides nothing further),
//   6. the seat is resumable but its saved session has no token.
// Restore (restoreNodeUnisolated) acts on this decision; restore-check asks the same function what restore WOULD do,
// so a check cannot be greener than the restore it predicts: they run one code path over the same inputs
// (the same pattern as fresh-seat-restore-decision.ts, which owns the gate after these).
import { absentSeatResumeHistory, absentSeatResumeHistoryError, activeOccupantAmbiguityError, freshSeatLaunchCommand, resolveActiveSnapshotSession } from "./active-occupant.js";
import { restoreRuntimeCompatibilityError } from "./restore-runtime-compatibility.js";
import type Database from "better-sqlite3";
import { resolveSnapshotRestoreTopology } from "./restore-topology.js";
import type { StartupFrom } from "./seat-startup-source.js";
import type { SnapshotData } from "./types.js";

export type SeatGate = "node_removed" | "occupant_ambiguous" | "runtime_mismatch" | "absent_history" | "no_token";

export type SeatPreLaunchDecision =
  /** Restore goes on to decide the seat's startup files and launch it. */
  | { kind: "proceed" }
  /** Restore skips the seat as `fresh` (its continuity is `restoring`); nothing further is decided for it. */
  | { kind: "skip_restoring" }
  /** Restore reports the seat with this status and error, before anything is started or written. */
  | { kind: "stop"; gate: SeatGate; status: "failed" | "awaiting-decision"; error: string };

export interface SeatPreLaunchInput {
  data: SnapshotData;
  /** The SNAPSHOT's id for the seat (it keys the snapshot's own sessions and startup context). */
  snapshotNodeId: string;
  logicalId: string;
  /** The live node found by logical id, or null when the seat was removed. */
  live: { runtime: string | null } | null;
  /** The seat is listed with `--fresh`. */
  freshRequested: boolean;
  rigName: string;
  startupFrom?: StartupFrom;
  /** The seat's `continuity_state.status` (null: none, or the seat is in no pod). */
  continuityStatus: string | null;
}

export function decideSeatPreLaunchGate(input: SeatPreLaunchInput): SeatPreLaunchDecision {
  const { data, snapshotNodeId: nodeId, logicalId, live, freshRequested } = input;
  if (!live) {
    // Removed since the snapshot and not grown back. Restore does not recreate a node (the launcher reports the same
    // "not found in rig" for it); it reports this seat failed, before anything is started or written, and goes on.
    return {
      kind: "stop", gate: "node_removed", status: "failed",
      error: `Node ${logicalId} not found in rig: it was removed after this snapshot and has not been added back, so there is no seat to restore it into. Restore does not recreate removed nodes.`,
    };
  }
  // OPR.0.5.7.1: D1 present-map ambiguity must be DETECTED before any continuity short-circuit, so a seat in
  // 'restoring' does not report fresh while the occupant truth is ambiguous.
  const occupant = resolveActiveSnapshotSession(data, nodeId);
  if (occupant.kind === "ambiguous") {
    return { kind: "stop", gate: "occupant_ambiguous", status: "failed", error: activeOccupantAmbiguityError(occupant.candidateIds, occupant.detail) };
  }
  const runtimeError = restoreRuntimeCompatibilityError(live.runtime, data.nodeStartupContext?.[nodeId]?.runtime);
  if (runtimeError) return { kind: "stop", gate: "runtime_mismatch", status: "awaiting-decision", error: runtimeError };

  // A seat with no occupant whose history still carries a token: restore stops it for a decision.
  const priorWithToken = occupant.kind === "none" && !freshRequested ? absentSeatResumeHistory(data.sessions, nodeId) : null;
  if (priorWithToken) {
    return { kind: "stop", gate: "absent_history", status: "awaiting-decision", error: absentSeatResumeHistoryError(logicalId, priorWithToken.resumeType, input.rigName, input.startupFrom) };
  }

  if (input.continuityStatus === "restoring") return { kind: "skip_restoring" };

  // OPR.0.3.4.2 / OPR.0.4.3.20 FR-7: a `resume_if_possible` seat that HAD a session but has NO usable token stops
  // here, whether or not a resume SOURCE was recorded. A seat with no session row at all never ran and fresh-primes.
  const snapSession = occupant.kind === "resolved" ? occupant.session : null;
  const policy = snapSession?.restorePolicy ?? "resume_if_possible";
  if (policy === "resume_if_possible" && snapSession && !snapSession.resumeToken && !freshRequested) {
    const sourceNote = snapSession.resumeType && snapSession.resumeType !== "none"
      ? `resume source '${snapSession.resumeType}' recorded but no token available`
      : `no resume token was captured for this seat`;
    return {
      kind: "stop", gate: "no_token", status: "awaiting-decision",
      error: `Original session unresumable: ${sourceNote}. No session was started. To start only this seat fresh, run: ${freshSeatLaunchCommand(logicalId, input.rigName, input.startupFrom)}; or restore the original session manually.`,
    };
  }
  return { kind: "proceed" };
}

/** The seat's continuity row, read where restore reads it. */
export function readContinuityRow(db: Database.Database, podId: string, nodeId: string): { status: string } | undefined {
  return db.prepare("SELECT status FROM continuity_state WHERE pod_id = ? AND node_id = ?").get(podId, nodeId) as { status: string } | undefined;
}

export type SeatStop = Extract<SeatPreLaunchDecision, { kind: "stop" }>;

/**
 * What restore would stop at these gates, per seat of the snapshot's intended roster, without starting anything: one
 * entry per seat restore would report `failed` or `awaiting-decision`, with restore's own error text. Reads the live
 * rig and the continuity table exactly where restore does.
 */
export function predictSeatStops(
  deps: { db: Database.Database; rigRepo: { getRig(rigId: string): { rig: { name: string }; nodes: Array<{ id: string; logicalId: string; podId?: string | null; runtime?: string | null }> } | null } },
  input: { rigId: string; data: SnapshotData; freshLogicalIds?: readonly string[]; startupFrom?: StartupFrom },
): Map<string, SeatStop> {
  const stops = new Map<string, SeatStop>();
  const rig = deps.rigRepo.getRig(input.rigId);
  for (const node of resolveSnapshotRestoreTopology(input.data).intendedNodes) {
    const live = rig?.nodes.find((candidate) => candidate.logicalId === node.logicalId) ?? null;
    const continuityRow = live?.podId ? readContinuityRow(deps.db, live.podId, live.id) : undefined;
    const decision = decideSeatPreLaunchGate({
      data: input.data, snapshotNodeId: node.id, logicalId: node.logicalId, live: live ? { runtime: live.runtime ?? null } : null,
      freshRequested: input.freshLogicalIds?.includes(node.logicalId) ?? false,
      rigName: rig?.rig.name ?? input.data.rig.name, startupFrom: input.startupFrom,
      continuityStatus: continuityRow?.status ?? null,
    });
    if (decision.kind === "stop") stops.set(node.logicalId, decision);
  }
  return stops;
}
