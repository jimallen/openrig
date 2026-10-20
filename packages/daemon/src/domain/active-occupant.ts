// OPR.0.5.7.1 — the ONE active-occupant truth, as a pure leaf module.
//
// Execution (restore-orchestrator), preview (restore-plan-preview), snapshot
// usability (rig-repository), and lifecycle projection (node-inventory) all
// consume the SAME four-way ladder below; capture (snapshot-capture) and the
// live no-snapshot preview both derive the relation through the SAME helper.
// R2's HOLD was exactly the drift this module removes: reporting surfaces
// selecting historical rows the execution path would never resume.
//
// FOUR-WAY OCCUPANT TRUTH (repair ruling qitem-20260829080039-c47a571e):
// the ONLY case where legacy inference may run is the WHOLE relation map
// being absent (a pre-convention snapshot). A PRESENT map is the authority —
// a null value, a missing node key, or a dangling id each fails LOUDLY; the
// map is never collapsed by truthiness into the legacy ladder.

import type { SnapshotData, Session, SnapshotOccupantState } from "./types.js";

/** The minimal row shape the ladder needs — satisfied by Session and by the
 *  preview's narrower session rows alike, so ONE ladder serves every consumer
 *  without a copied variant. */
export interface OccupantCandidateRow {
  id: string;
  nodeId: string;
  status: string | null;
}

export type ActiveOccupantResolution<T extends OccupantCandidateRow> =
  | { kind: "resolved"; session: T }
  | { kind: "none" }
  | { kind: "ambiguous"; candidateIds: string[]; detail: string };

export type ActiveSnapshotSessionResolution =
  | { kind: "resolved"; session: Session }
  | { kind: "none" }
  | { kind: "ambiguous"; candidateIds: string[]; detail: string };

/** The resume-identity and launch-outcome fields the failed-launch rule reads. Optional so rows that do not
 *  carry them (older serialized snapshots, narrow preview rows) simply never qualify as a failed launch. */
interface ResumeIdentityFields {
  resumeType?: string | null;
  resumeToken?: string | null;
  resumeProvenance?: string | null;
  resumeLastVerified?: string | null;
  resumeLastProbeStatus?: string | null;
  startupStatus?: string | null;
  startupCompletedAt?: string | null;
  freshStart?: boolean | null;
}

const RESUME_IDENTITY_KEYS = ["resumeType", "resumeToken", "resumeProvenance", "resumeLastVerified", "resumeLastProbeStatus"] as const;

function hasUsableResumeIdentity(row: ResumeIdentityFields): boolean {
  return !!row.resumeToken?.trim() && !!row.resumeType && row.resumeType !== "none";
}

/** A launch that recorded `failed` and never completed startup: no occupant ever ran in it. A deliberate fresh
 *  start is excluded: the operator chose not to continue the earlier conversation, and no later restore may
 *  resume one from before that choice, whether or not the fresh launch itself got anywhere. */
function isFailedLaunchThatNeverReachedReady(row: ResumeIdentityFields): boolean {
  return row.startupStatus === "failed" && !row.startupCompletedAt && !row.freshStart;
}

/** A launch that failed before ready has no occupant, so its empty token is not evidence about the seat's
 *  conversation. When the resolved occupant is such a row with no token, its resume identity is the newest
 *  OLDER row's usable one, provided every row between them is also a failed launch that never reached ready.
 *  A row that did reach ready (or any row not recorded as a failed launch) ran a real occupant, so its
 *  missing token is real and the walk stops there. The occupant's own id, status and policy are kept. */
export function inheritResumeIdentityBehindFailedLaunches<T extends OccupantCandidateRow>(occupant: T, history: T[]): T {
  const own = occupant as T & ResumeIdentityFields;
  if (own.resumeToken?.trim() || !isFailedLaunchThatNeverReachedReady(own)) return occupant;
  const older = history
    .filter((row) => row.nodeId === occupant.nodeId && row.id < occupant.id)
    .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  for (const row of older) {
    const candidate = row as T & ResumeIdentityFields;
    if (hasUsableResumeIdentity(candidate)) {
      const inherited: ResumeIdentityFields = {};
      for (const key of RESUME_IDENTITY_KEYS) if (key in candidate) inherited[key] = candidate[key];
      return { ...occupant, ...inherited };
    }
    if (!isFailedLaunchThatNeverReachedReady(candidate)) return occupant;
  }
  return occupant;
}

/** The four-way ladder (moved from restore-orchestrator.ts, behavior
 *  byte-faithful; generic over the row shape so no consumer copies it). */
export function resolveActiveOccupantRow<T extends OccupantCandidateRow>(
  sessions: T[],
  relationMap: Record<string, string | null> | undefined,
  nodeId: string,
): ActiveOccupantResolution<T> {
  const rows = sessions.filter((s) => s.nodeId === nodeId);
  const map = relationMap;
  if (map === undefined) {
    // Pre-convention snapshot: this is the ONLY branch where zero rows means
    // "never ran" (none) and legacy inference may run — a single row, else
    // the uniquely-running row, else ambiguity.
    if (rows.length === 0) return { kind: "none" };
    if (rows.length === 1) return { kind: "resolved", session: inheritResumeIdentityBehindFailedLaunches(rows[0]!, rows) };
    const running = rows.filter((s) => s.status === "running");
    if (running.length === 1) return { kind: "resolved", session: inheritResumeIdentityBehindFailedLaunches(running[0]!, rows) };
    return { kind: "ambiguous", candidateIds: rows.map((r) => r.id), detail: "no explicit active relation (pre-convention snapshot) and no uniquely-running row" };
  }
  // Map PRESENT: it is the authority even with zero session rows — a null,
  // missing-key, or dangling relation state is loud regardless of history.
  if (!Object.prototype.hasOwnProperty.call(map, nodeId)) {
    return { kind: "ambiguous", candidateIds: rows.map((r) => r.id), detail: "the snapshot's activeSessionIdByNode map carries no entry for this node" };
  }
  const rel = map[nodeId];
  if (rel === null) {
    return { kind: "ambiguous", candidateIds: rows.map((r) => r.id), detail: "the snapshot recorded no single live occupant at capture (explicit null)" };
  }
  const hit = rows.find((s) => s.id === rel);
  if (!hit) {
    return { kind: "ambiguous", candidateIds: rows.map((r) => r.id), detail: `the recorded active relation ${rel} names no session row in this snapshot (dangling)` };
  }
  return { kind: "resolved", session: inheritResumeIdentityBehindFailedLaunches(hit, rows) };
}

/** The snapshot-shaped entry point (the original public signature; a thin
 *  wrapper so execution call sites are unchanged). */
export function resolveActiveSnapshotSession(data: SnapshotData, nodeId: string): ActiveSnapshotSessionResolution {
  const explicit = data.activeOccupantsByNode;
  if (explicit !== undefined) {
    const state = explicit[nodeId];
    const rows = data.sessions.filter((session) => session.nodeId === nodeId);
    if (!state) {
      return { kind: "ambiguous", candidateIds: rows.map((row) => row.id), detail: "the snapshot's activeOccupantsByNode map carries no entry for this node" };
    }
    if (state.kind === "absent") return { kind: "none" };
    if (state.kind === "ambiguous") {
      return { kind: "ambiguous", candidateIds: [...state.candidateIds], detail: "the snapshot recorded multiple live occupant candidates at capture" };
    }
    const session = rows.find((row) => row.id === state.sessionId);
    if (!session) {
      return { kind: "ambiguous", candidateIds: rows.map((row) => row.id), detail: `the recorded active occupant ${state.sessionId} names no session row in this snapshot (dangling)` };
    }
    return { kind: "resolved", session: inheritResumeIdentityBehindFailedLaunches(session, rows) };
  }
  return resolveActiveOccupantRow(data.sessions, data.activeSessionIdByNode, nodeId);
}

/** A seat with no occupant (none) whose history still carries a resume token. Execution and the
 *  plan preview both stop such a seat for a decision rather than fresh-priming it: it HAD a session,
 *  and which earlier conversation to resume is not theirs to guess. Shared so the two cannot drift.
 *  The seat's newest row (ids are ULIDs) carries its current restore policy: under anything but
 *  resume_if_possible it starts fresh as before. Otherwise returns a row with a recorded token, or null. */
export function absentSeatResumeHistory<T extends { id: string; nodeId: string; resumeType: string | null; resumeToken: string | null; restorePolicy?: string | null }>(
  sessions: T[],
  nodeId: string,
): T | null {
  const rows = sessions.filter((session) => session.nodeId === nodeId);
  const newest = rows.reduce<T | null>((latest, row) => (!latest || row.id > latest.id ? row : latest), null);
  if (!newest || (newest.restorePolicy ?? "resume_if_possible") !== "resume_if_possible") return null;
  return rows.find((session) => !!session.resumeToken?.trim() && !!session.resumeType && session.resumeType !== "none") ?? null;
}

/** The ONE command every fresh-start suggestion names for a seat that could not be resumed. It is the
 *  per-seat door: `rig seat launch` touches only that seat and works whether its siblings are live or not.
 *  `rig up --existing <rig> --fresh <seat>` is NOT offered: restore refuses a rig with any live seat
 *  (`rig_not_stopped`, HTTP 409), and a restore that leaves one seat awaiting a decision has normally just
 *  started its siblings. The seat ref is shell-quoted; `<why>` is the operator's audit reason.
 *  (The one place `rig up --existing` is named is not a fresh-start suggestion but a measured non-recommendation: the
 *  malformed-startup-context guidance in seat-startup-source.ts says why `rig down` + `rig up --existing --fresh` does not
 *  reliably heal an unreadable saved row.) */
export function freshSeatLaunchCommand(logicalId: string, rigName: string, startupFrom?: import("./seat-startup-source.js").StartupFrom): string {
  const seat = `'${`${logicalId}@${rigName}`.replace(/'/g, `'"'"'`)}'`;
  // OF-32: a fresh seat re-reads its rig's spec by default. An operator who chose `--startup-from stored` for this
  // restore is told the same escape for the seats it could not start.
  return `rig seat launch ${seat} --fresh${startupFrom && startupFrom !== "spec" ? ` --startup-from ${startupFrom}` : ""} --reason "<why>"`;
}

/** The stop-for-decision explanation for such a seat, worded once for apply and preview. */
export function absentSeatResumeHistoryError(logicalId: string, resumeType: string | null, rigName: string, startupFrom?: import("./seat-startup-source.js").StartupFrom): string {
  return `Original session not resumed: the seat had no running occupant when this snapshot was taken, but an earlier occupant left a '${resumeType}' resume token. No session was started. The recorded token has not been verified and may be stale or belong to another runtime. To deliberately start only this seat fresh, run: ${freshSeatLaunchCommand(logicalId, rigName, startupFrom)}.`;
}

/** One wording for the loud failure everywhere — divergent phrasings would be
 *  a second copy of the truth. */
export function activeOccupantAmbiguityError(candidateIds: string[], detail?: string): string {
  return `Active-occupant ambiguity: ${candidateIds.length} candidate session rows (${candidateIds.join(", ")})` +
    `${detail ? ` — ${detail}` : ""}. Seat unrecoverable until resolved. ` +
    `Refusing newest-row-wins and refusing a replacement occupant.`;
}

/** The CAPTURE rule, shared verbatim by SnapshotCapture and the live
 *  no-snapshot preview so the two sibling derivations cannot drift:
 *  exactly one RUNNING row for a node -> its id; otherwise -> explicit null
 *  (recorded honestly; restore resolves it loudly instead of guessing). */
export function deriveActiveSessionIdByNode(
  sessions: OccupantCandidateRow[],
  nodeIds: string[],
): Record<string, string | null> {
  const relation: Record<string, string | null> = {};
  for (const nodeId of nodeIds) {
    const running = sessions.filter((s) => s.nodeId === nodeId && s.status === "running");
    relation[nodeId] = running.length === 1 ? running[0]!.id : null;
  }
  return relation;
}

/** Capture the same live relation without collapsing absent and ambiguous. */
export function deriveActiveOccupantsByNode(
  sessions: OccupantCandidateRow[],
  nodeIds: string[],
): Record<string, SnapshotOccupantState> {
  const relation: Record<string, SnapshotOccupantState> = {};
  for (const nodeId of nodeIds) {
    const running = sessions.filter((session) => session.nodeId === nodeId && session.status === "running");
    relation[nodeId] = running.length === 0
      ? { kind: "absent" }
      : running.length === 1
        ? { kind: "resolved", sessionId: running[0]!.id }
        : { kind: "ambiguous", candidateIds: running.map((session) => session.id) };
  }
  return relation;
}

/** Reboot capture equivalent: resolve one durable non-terminal occupant when
 * possible, otherwise preserve the exact absent/ambiguous candidate set. */
export function deriveRehydrateOccupantsByNode(
  sessions: OccupantCandidateRow[],
  nodeIds: string[],
  recorded: Record<string, string | null> = {},
): Record<string, SnapshotOccupantState> {
  const candidates = sessions.filter((session) => session.status !== "superseded" && session.status !== "exited");
  const relation: Record<string, SnapshotOccupantState> = {};
  for (const nodeId of nodeIds) {
    const rows = candidates.filter((session) => session.nodeId === nodeId);
    const resolved = resolveActiveOccupantRow(candidates, Object.prototype.hasOwnProperty.call(recorded, nodeId) ? recorded : undefined, nodeId);
    relation[nodeId] = resolved.kind === "resolved"
      ? { kind: "resolved", sessionId: resolved.session.id }
      : resolved.kind === "none"
        ? { kind: "absent" }
        : { kind: "ambiguous", candidateIds: rows.map((row) => row.id) };
  }
  return relation;
}

/** Reboot-only capture rule. Startup reconciliation has already changed the
 * lost process's row from running to detached, so the ordinary live-capture
 * rule cannot identify it. Reuse the legacy relation ladder over durable rows:
 * one non-terminal row, or one uniquely-running row among several, is enough;
 * every ambiguous shape remains explicit null and therefore fails closed. */
export function deriveRehydrateSessionIdByNode(
  sessions: OccupantCandidateRow[],
  nodeIds: string[],
  recorded: Record<string, string | null> = {},
): Record<string, string | null> {
  const candidates = sessions.filter((session) => session.status !== "superseded" && session.status !== "exited");
  const relation: Record<string, string | null> = {};
  for (const nodeId of nodeIds) {
    const resolved = resolveActiveOccupantRow(candidates, Object.prototype.hasOwnProperty.call(recorded, nodeId) ? recorded : undefined, nodeId);
    relation[nodeId] = resolved.kind === "resolved" ? resolved.session.id : null;
  }
  return relation;
}
