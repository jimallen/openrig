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
import { absentSeatResumeHistory, absentSeatResumeHistoryError, activeOccupantAmbiguityError, freshSeatLaunchCommand, resolveActiveSnapshotSession, type ActiveSnapshotSessionResolution } from "./active-occupant.js";
import { restoreRuntimeCompatibilityError } from "./restore-runtime-compatibility.js";
import type Database from "better-sqlite3";
import { resolveSnapshotRestoreTopology } from "./restore-topology.js";
import { readSnapshotStartupCopy, startupFromSnapshotId, type StartupFrom } from "./seat-startup-source.js";
import type { SnapshotData } from "./types.js";
import { RUNTIMES_WITHOUT_FRESH_START } from "./runtime-adapter.js";

/** pda L2a (design T29b): what a stop-for-decision tells the operator to do about a seat whose runtime has no fresh
 *  start, instead of a `--fresh` command that would then be refused. Its resume token is its binding (no secret), so
 *  the way back is to record the token and resume; the token is never quoted from the snapshot here. */
export function noFreshStartRemedy(runtime: string, logicalId: string, rigName: string): string {
  const seat = `'${`${logicalId}@${rigName}`.replace(/'/g, `'"'"'`)}'`;
  return `A ${runtime} seat has no fresh start (${runtime} owns the conversation). To resume it, record the agent its spec binds as its resume token, `
    + `printf '%s' 'http://127.0.0.1:<port>/agents/<agent>' | rig seat set-resume-token ${seat} --token-stdin --reason "<why>", `
    + `then run: rig up '${rigName.replace(/'/g, `'"'"'`)}' --existing. To drive another agent, re-instantiate the seat.`;
}

export type SeatGate = "node_removed" | "occupant_ambiguous" | "runtime_mismatch" | "absent_history" | "no_token";

export type SeatPreLaunchDecision =
  /** Restore goes on to decide the seat's startup files and launch it. */
  | { kind: "proceed" }
  /** Restore skips the seat as `fresh` (its continuity is `restoring`); nothing further is decided for it. */
  | { kind: "skip_restoring" }
  /** Restore reports the seat with this status and error, before anything is started or written. */
  | { kind: "stop"; gate: SeatGate; status: "failed" | "awaiting-decision"; error: string; /** absent_history only: the earlier occupant's resume source. */ priorResumeType?: string | null };

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
  /** The seat's occupant when the caller has already resolved it from rows that are not a captured snapshot (the plan's
   *  would-capture rows of a live rig). Absent: resolved from `data` exactly as restore does. */
  occupant?: ActiveSnapshotSessionResolution;
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
  const occupant = input.occupant ?? resolveActiveSnapshotSession(data, nodeId);
  if (occupant.kind === "ambiguous") {
    return { kind: "stop", gate: "occupant_ambiguous", status: "failed", error: activeOccupantAmbiguityError(occupant.candidateIds, occupant.detail) };
  }
  const runtimeError = restoreRuntimeCompatibilityError(live.runtime, data.nodeStartupContext?.[nodeId]?.runtime);
  if (runtimeError) return { kind: "stop", gate: "runtime_mismatch", status: "awaiting-decision", error: runtimeError };

  // A seat with no occupant whose history still carries a token: restore stops it for a decision.
  const priorWithToken = occupant.kind === "none" && !freshRequested ? absentSeatResumeHistory(data.sessions, nodeId) : null;
  const noFresh = live.runtime !== null && RUNTIMES_WITHOUT_FRESH_START.has(live.runtime) ? live.runtime : null;
  if (priorWithToken) {
    const error = noFresh
      ? `Original session not resumed: the seat had no running occupant when this snapshot was taken, but an earlier occupant left a '${priorWithToken.resumeType}' resume token. No session was started. The recorded token has not been verified. ${noFreshStartRemedy(noFresh, logicalId, input.rigName)}`
      : absentSeatResumeHistoryError(logicalId, priorWithToken.resumeType, input.rigName, input.startupFrom);
    return { kind: "stop", gate: "absent_history", status: "awaiting-decision", error, priorResumeType: priorWithToken.resumeType };
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
      error: noFresh
        ? `Original session unresumable: ${sourceNote}. No session was started. ${noFreshStartRemedy(noFresh, logicalId, input.rigName)}`
        : `Original session unresumable: ${sourceNote}. No session was started. To start only this seat fresh, run: ${freshSeatLaunchCommand(logicalId, input.rigName, input.startupFrom)}; or restore the original session manually.`,
    };
  }
  return { kind: "proceed" };
}

/** Whether this restore resumes the seat's saved conversation (an exact resume) rather than starting it fresh.
 *  The one predicate for the pre-launch startup decision, the post-launch replay containment, the plan and `rig launch`. */
export function snapshotSeatResumes(session: { restorePolicy?: string | null; resumeType?: string | null } | null, freshRequested: boolean): boolean {
  const restorePolicy = session?.restorePolicy ?? "resume_if_possible";
  const resumeType = session?.resumeType ?? null;
  return restorePolicy === "resume_if_possible" && !!resumeType && resumeType !== "none" && !freshRequested;
}

/** What restore does with a seat: stops it at a gate, skips it, resumes the saved conversation, or starts it fresh
 *  (`why` is the reason in the words `rig launch`'s advice uses after "that snapshot"). */
export type SeatLaunchOutcome =
  | { kind: "stop"; stop: Extract<SeatPreLaunchDecision, { kind: "stop" }> }
  | { kind: "skip_restoring" }
  | { kind: "resume" }
  | { kind: "fresh"; why: string };

/** The gates, then the resume decision restore makes after them. The plan's forecast and `rig launch`'s advice read this,
 *  so neither keeps its own copy of the rule. */
export function decideSeatLaunchOutcome(input: SeatPreLaunchInput): SeatLaunchOutcome {
  const gate = decideSeatPreLaunchGate(input);
  if (gate.kind === "stop") return { kind: "stop", stop: gate };
  if (gate.kind === "skip_restoring") return gate;
  const occupant = input.occupant ?? resolveActiveSnapshotSession(input.data, input.snapshotNodeId);
  const session = occupant.kind === "resolved" ? occupant.session : null;
  if (!session) return { kind: "fresh", why: "saves no session for this seat" };
  const policy = session.restorePolicy ?? "resume_if_possible";
  if (policy !== "resume_if_possible") return { kind: "fresh", why: `saves this seat with restore policy '${policy}'` };
  if (input.freshRequested) return { kind: "fresh", why: "is listed with --fresh" };
  return snapshotSeatResumes(session, false) ? { kind: "resume" } : { kind: "fresh", why: "records no resume source for this seat" };
}

/** The seat's continuity row, read where restore reads it. */
export function readContinuityRow(db: Database.Database, podId: string, nodeId: string): { status: string } | undefined {
  return db.prepare("SELECT status FROM continuity_state WHERE pod_id = ? AND node_id = ?").get(podId, nodeId) as { status: string } | undefined;
}

export type SeatStop = Extract<SeatPreLaunchDecision, { kind: "stop" }>;

/** What the seat gates read that is not in the snapshot, plus the live cwd a checkpoint is delivered into (OF-25: a seat
 *  restores with its LIVE settings). `live: null`: the seat was removed and not grown back. */
export interface SeatGateInputs {
  live: { runtime: string | null; cwd: string | null } | null;
  continuityStatus: string | null;
  rigName: string;
}

/**
 * The live facts restore reads for a seat, found where restoreNodeUnisolated finds them (by logical id in the rig, the
 * continuity row of the live node), for pre-restore validation. Restore, restore-check and the `--fresh` remedy all call
 * this, so what they validate is what restore will do.
 */
export function liveSeatGateInputs(
  deps: { db: Database.Database; rigRepo: { getRig(rigId: string): { rig: { name: string }; nodes: Array<{ id: string; logicalId: string; podId?: string | null; runtime?: string | null; cwd?: string | null }> } | null } },
  input: { rigId: string; fallbackRigName: string },
): (node: { id: string; logicalId: string }) => SeatGateInputs {
  return (node) => {
    const rig = deps.rigRepo.getRig(input.rigId);
    const live = rig?.nodes.find((candidate) => candidate.logicalId === node.logicalId) ?? null;
    const continuityRow = live?.podId ? readContinuityRow(deps.db, live.podId, live.id) : undefined;
    return {
      live: live ? { runtime: live.runtime ?? null, cwd: live.cwd ?? null } : null,
      continuityStatus: continuityRow?.status ?? null,
      rigName: rig?.rig.name ?? input.fallbackRigName,
    };
  };
}

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
      rigName: rig?.rig.name ?? input.data.rig.name,
      // OF-36 G1: snapshot:<id> is named in this seat's advice only when that snapshot's copy is usable for it.
      startupFrom: (() => {
        const id = startupFromSnapshotId(input.startupFrom);
        if (!id) return input.startupFrom;
        return readSnapshotStartupCopy(deps.db, { rigId: input.rigId, logicalId: node.logicalId, runtime: live?.runtime ?? null, cwd: "." }, id).ok ? input.startupFrom : undefined;
      })(),
      continuityStatus: continuityRow?.status ?? null,
    });
    if (decision.kind === "stop") stops.set(node.logicalId, decision);
  }
  return stops;
}
