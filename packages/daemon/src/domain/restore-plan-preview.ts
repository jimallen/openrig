// OPR.0.3.4.4 — read-only restore plan preview.
//
// `rig up --existing <rig> --plan` advertised "preview without executing" but
// the rig_name path bypassed the plan gate and MUTATED (recreated sessions,
// flipped detached->running, replaced manually-resumed panes). This module is
// the shared read-only preview both restore routes (`/api/up` rig_name and the
// Explorer `/api/rigs/:id/up`) return when plan=true: it computes the INTENDED
// per-seat restore action from snapshot/session data and touches NOTHING — no
// restoreOrchestrator.restore(), no session create/kill/replace/resume, no
// snapshot capture (the auto-rehydrate capture is itself a mutation and is
// only reported as would-happen), no projection writes.

import type Database from "better-sqlite3";
import { resolveActiveOccupantRow, resolveActiveSnapshotSession, deriveRehydrateSessionIdByNode, type ActiveOccupantResolution, type ActiveSnapshotSessionResolution } from "./active-occupant.js";
import type { RigWithRelations, Snapshot, SnapshotData } from "./types.js";
import { parseSqliteUtcMs } from "./sqlite-time.js";
import { predictListedSeatRefusals, type ListedSeatDecisionDeps } from "./fresh-seat-restore-decision.js";
import type { StartupFrom } from "./seat-startup-source.js";
import { decideSeatLaunchOutcome, readContinuityRow } from "./restore-seat-gates.js";
import { resolveSnapshotRestoreTopology } from "./restore-topology.js";
import { savedRowDamage, savedRowDamageMessage } from "./node-row-damage.js";

/** OPR.0.4.3.20 FR-6 — a present token whose last verification is older than this
 *  is surfaced as `stale` (age-based staleness — the "stale while running" signal
 *  that needs no probe). DELIVERY DEFAULT; pm confirms the exact value. */
export const RESUME_FRESHNESS_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

/** The plan's words for a resumable seat whose saved session has no token (the `no_token` gate). Unchanged from before OF-44. */
export const PLAN_NO_TOKEN_REASON = "Prior occupant has no usable native resume identity. No session will be started without a fresh-start decision.";

/** OPR.0.4.3.20 FR-6 — per-seat token truth in the restore plan. */
export type ResumeTokenState = "present" | "missing" | "stale" | "unverified";

export interface RestorePlanPreviewNode {
  logicalId: string;
  /** Consent version, not a guessed native conversation id. */
  occupantSessionId?: string | null;
  hasHistory?: boolean;
  /** The slice-02 vocabulary, as a forecast: what apply mode WOULD do. */
  intendedAction: "resume-original" | "fresh-primed" | "awaiting-decision";
  reason?: string;
  // OPR.0.4.3.20 FR-6 — per-seat token state + freshness (read-only forecast).
  /** present = verified + fresh; missing = no token; stale = probe failed OR
   *  last-verified past the freshness threshold; unverified = present but never
   *  verified. A stale/unverified token is NEVER a silent restore failure —
   *  the operator sees it here and can re-verify before restore. */
  tokenState: ResumeTokenState;
  /** The token's source: adoption / hook / operator / scrape (null when none). */
  provenance?: string | null;
  /** When the token was last confirmed current (SQLite UTC ts; null = never). */
  lastVerified?: string | null;
  /** True when the seat has no resumable token → restore would require an
   *  explicit `--fresh` (surfaced here; never presented as a silent fresh-prime). */
  freshRequired: boolean;
  /** A runtime prompt the operator should expect at restore (Claude session
   *  picker, Codex auth/update) — a forecast, not an incidental surprise. */
  runtimePrompt?: string;
  /** A seat listed with --fresh that apply mode would REFUSE before launching it, in restore's own words (the text
   *  restore reports after "Fresh start refused: "). Decided by the function restore calls
   *  (fresh-seat-restore-decision.ts), so the plan is never looser than the restore. Absent: nothing predicted. */
  wouldRefuse?: string;
  /** Set when apply would STOP this seat at a pre-launch gate: the status restore reports for it (`failed`: the seat was
   *  removed or its occupant cannot be told; `awaiting-decision`: it needs an operator decision). The intended action
   *  of such a seat is `awaiting-decision` either way, since nothing is started; `reason` is restore's own text. */
  restoreStatus?: "failed" | "awaiting-decision";
  /** OF-62: the seat's saved row is damaged (its session source and/or package list is not what was written), as the
   *  node carries it. Restore's pre-restore snapshot refuses the whole rig on it, so the plan does not forecast a
   *  start for this seat. Absent: the row is readable. */
  savedRowDamage?: string[];
}

export interface RestorePlanPreview {
  status: "plan";
  mode: "restore";
  rigId: string;
  rigName: string;
  /** The snapshot apply mode would restore from (null when it would capture
   *  a current-state auto-rehydrate snapshot instead). */
  snapshot: { id: string; kind: string; createdAt: string } | null;
  /** True when apply mode would first CAPTURE an auto-rehydrate snapshot —
   *  reported, not performed (plan mode performs zero writes). */
  wouldCaptureCurrentState: boolean;
  nodes: RestorePlanPreviewNode[];
  /** Always false — the contract this preview exists to keep. */
  mutated: false;
  /** Set when the refusal prediction for the listed seats could not be made; absent otherwise. */
  refusalPredictionError?: string;
  /** OF-62 (review B2): apply mode would refuse the WHOLE rig, so no seat is started and a per-seat reading ("this seat
   *  fails, the rest are restored") is wrong. Today: a seat's saved row is damaged and restore's pre-restore snapshot
   *  refuses on it. `seats` names them. Every consumer of the plan checks this before it reads a seat's own status.
   *  Absent: restore is not refused for this reason. */
  restoreRefusal?: { reason: string; seats: string[] };
}

export interface PreviewSessionRow {
  nodeId: string;
  restorePolicy: string | null;
  resumeType: string | null;
  resumeToken: string | null;
  // OPR.0.4.3.20 FR-6 — provenance + verification freshness (nullable/degrading
  // for pre-45 rows and old snapshots → rendered as unverified, never a crash).
  resumeProvenance?: string | null;
  resumeLastVerified?: string | null;
  resumeLastProbeStatus?: string | null;
  /** How the row's launch ended. A launch that failed and never completed startup had no occupant, so
   *  the occupant resolution looks past it for the resume identity (active-occupant.ts). */
  startupStatus?: string | null;
  startupCompletedAt?: string | null;
  /** The launch was a deliberate fresh start; a failed one never lets the walk reach past it. */
  freshStart?: boolean;
  /** Row id (ULID). Selection is by the shared ACTIVE-OCCUPANT resolution
   *  (active-occupant.ts) — the same truth the restore execution consumes —
   *  never by newest-id inference. */
  id: string;
  /** Session status — the occupant ladder's legacy/uniquely-running input and
   *  the live would-capture derivation's input. */
  status: string | null;
}

/** OPR.0.4.3.20 FR-6 — compute a seat's token state (read-only). A present token
 *  whose probe failed (`not_resumable`/`inconclusive`) OR whose last-verified age
 *  is past the freshness threshold is `stale` — surfaced, never silently nulled. */
function tokenStateFor(
  latest: PreviewSessionRow | null,
  nowMs: number,
): { tokenState: ResumeTokenState; provenance: string | null; lastVerified: string | null } {
  if (!latest || !latest.resumeToken) {
    return { tokenState: "missing", provenance: null, lastVerified: null };
  }
  const provenance = latest.resumeProvenance ?? null;
  const lastVerified = latest.resumeLastVerified ?? null;
  const probe = latest.resumeLastProbeStatus ?? null;
  if (probe === "not_resumable" || probe === "inconclusive") {
    return { tokenState: "stale", provenance, lastVerified };
  }
  if (!probe && !lastVerified) {
    return { tokenState: "unverified", provenance, lastVerified };
  }
  if (lastVerified) {
    // NaN (unparseable) skips the age check: an unreadable stamp is never stale-by-age.
    const verifiedMs = parseSqliteUtcMs(lastVerified);
    if (!Number.isNaN(verifiedMs) && nowMs - verifiedMs > RESUME_FRESHNESS_THRESHOLD_MS) {
      return { tokenState: "stale", provenance, lastVerified };
    }
  }
  return { tokenState: "present", provenance, lastVerified };
}

/** OPR.0.4.3.20 FR-6 — forecast the runtime prompt a resume WOULD hit, so it is
 *  an expected operator step, not a terminal surprise. Only meaningful when the
 *  seat would attempt a resume (has a token). */
function runtimePromptFor(runtime: string | null, tokenState: ResumeTokenState): string | undefined {
  if (tokenState === "missing") return undefined;
  if (runtime === "claude-code") return "expect the Claude session picker (full-session resume)";
  if (runtime === "codex") return "expect a Codex auth/update check before resume";
  return undefined;
}

/** Gather the session rows the preview forecasts from — the snapshot's
 *  captured sessions when one exists, otherwise the live rows an
 *  auto-rehydrate capture WOULD snapshot (read-only SELECT; the capture
 *  itself is a mutation and is never performed here). */
export function collectPreviewSessionRows(
  db: Database.Database,
  rig: RigWithRelations,
  snapshot: Snapshot | null,
): PreviewSessionRow[] {
  if (snapshot) {
    return (snapshot.data.sessions ?? []).map((s) => ({
      nodeId: s.nodeId,
      restorePolicy: s.restorePolicy ?? null,
      resumeType: s.resumeType ?? null,
      resumeToken: s.resumeToken ?? null,
      // OPR.0.4.3.20 FR-6 — degrade to null for snapshots serialized pre-45.
      resumeProvenance: s.resumeProvenance ?? null,
      resumeLastVerified: s.resumeLastVerified ?? null,
      resumeLastProbeStatus: s.resumeLastProbeStatus ?? null,
      startupStatus: s.startupStatus ?? null,
      startupCompletedAt: s.startupCompletedAt ?? null,
      freshStart: s.freshStart === true,
      id: s.id,
      status: s.status ?? null,
    }));
  }
  const nodeIds = rig.nodes.map((n) => n.id);
  if (nodeIds.length === 0) return [];
  const placeholders = nodeIds.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT id, node_id, restore_policy, resume_type, resume_token, resume_provenance, resume_last_verified, resume_last_probe_status, startup_status, startup_completed_at, fresh_start, status FROM sessions WHERE node_id IN (${placeholders})`
  ).all(...nodeIds) as Array<{ id: string; node_id: string; restore_policy: string | null; resume_type: string | null; resume_token: string | null; resume_provenance: string | null; resume_last_verified: string | null; resume_last_probe_status: string | null; startup_status: string | null; startup_completed_at: string | null; fresh_start: number | null; status: string | null }>;
  return rows.map((r) => ({
    nodeId: r.node_id,
    restorePolicy: r.restore_policy,
    resumeType: r.resume_type,
    resumeToken: r.resume_token,
    resumeProvenance: r.resume_provenance,
    resumeLastVerified: r.resume_last_verified,
    resumeLastProbeStatus: r.resume_last_probe_status,
    startupStatus: r.startup_status,
    startupCompletedAt: r.startup_completed_at,
    freshStart: r.fresh_start === 1,
    id: r.id,
    status: r.status,
  }));
}

/**
 * The listed seats apply mode would refuse before launching them, by logical id, asked of the function restore calls
 * (read-only: it re-reads each listed seat's spec and checks the files it names; it starts, stops and writes nothing).
 */
export function predictedPlanRefusals(
  deps: ListedSeatDecisionDeps & { rigRepo: ListedSeatDecisionDeps["rigRepo"] & { getRig(rigId: string): RigWithRelations | null }; exists: (path: string) => boolean },
  rig: RigWithRelations,
  snapshot: Snapshot | null,
  freshLogicalIds: string[] | undefined,
  startupFrom: StartupFrom,
): Promise<Map<string, string>> {
  if (!freshLogicalIds || freshLogicalIds.length === 0) return Promise.resolve(new Map());
  return predictListedSeatRefusals(deps, { rigId: rig.rig.id, freshLogicalIds, startupFrom, snapshot: snapshot?.data ?? null, exists: deps.exists });
}

/**
 * Forecast per-seat restore actions from current inventory and saved occupancy.
 * Report token state and guidance without launching or changing any sessions.
 */
export function buildRestorePlanPreview(
  rig: RigWithRelations,
  snapshot: Snapshot | null,
  sessionRows: PreviewSessionRow[],
  freshLogicalIds?: string[],
  nowMs: number = Date.now(),
  recorded: Record<string, string | null> = {},
  /** Listed seats apply mode would refuse (see `predictedPlanRefusals`), by logical id. */
  refusals: ReadonlyMap<string, string> = new Map(),
  /** Each live seat's `continuity_state.status` by node id (see `readPreviewContinuity`). */
  continuity: Readonly<Record<string, string>> = {},
): RestorePlanPreview {
  // OPR.0.5.7.1 — the relation the resolution consumes: the snapshot's own
  // when previewing a snapshot; for the live no-snapshot case, the SAME
  // would-capture derivation SnapshotCapture uses (shared helper — the
  // sibling paths cannot drift).
  const relationMap = snapshot
    ? snapshot.data.activeSessionIdByNode
    : deriveRehydrateSessionIdByNode(sessionRows, rig.nodes.map((n) => n.id), recorded);
  // The gate input restore reads: the captured snapshot, or (no snapshot) the rows an auto-rehydrate capture would copy.
  const data = snapshot ? snapshot.data : ({ nodes: [], sessions: sessionRows } as unknown as SnapshotData);
  const forecast = (input: {
    logicalId: string; snapshotNodeId: string; live: { runtime: string | null } | null; continuityStatus: string | null;
    freshRequested: boolean; occupant: ActiveOccupantResolution<PreviewSessionRow>;
  }): RestorePlanPreviewNode => {
    const { logicalId, snapshotNodeId, live, freshRequested, occupant: resolution } = input;
    // ONE decision, the function restore calls (restore-seat-gates.ts): the plan only words it.
    const outcome = decideSeatLaunchOutcome({
      data, snapshotNodeId, logicalId, live, freshRequested, rigName: rig.rig.name, continuityStatus: input.continuityStatus,
      ...(snapshot ? {} : { occupant: resolution as unknown as ActiveSnapshotSessionResolution }),
    });
    let intendedAction: RestorePlanPreviewNode["intendedAction"];
    let reason: string | undefined;
    let restoreStatus: RestorePlanPreviewNode["restoreStatus"];
    if (outcome.kind === "stop") {
      intendedAction = "awaiting-decision";
      // Restore's own text for every gate but one: the plan's no-token sentence is the CLI wording operators already read
      // (kept stable); restore's longer text for the same gate adds the fresh-start command the plan prints beside it.
      reason = outcome.stop.gate === "no_token" ? PLAN_NO_TOKEN_REASON : outcome.stop.error;
      restoreStatus = outcome.stop.status;
    } else if (outcome.kind === "skip_restoring") {
      intendedAction = "fresh-primed";
      reason = "continuity state is 'restoring' — apply would skip this seat as fresh and start nothing for it";
    } else if (freshRequested) {
      intendedAction = "fresh-primed";
      reason = "listed in --fresh — apply would deliberately skip the resume (operation B)";
    } else {
      intendedAction = outcome.kind === "resume" ? "resume-original" : "fresh-primed";
    }
    // OPR.0.4.3.20 FR-6 — per-seat token state (read-only), derived from the
    // RESOLVED occupant only — never from a historical row.
    const occupant = resolution.kind === "resolved" ? resolution.session : null;
    const { tokenState, provenance, lastVerified } = tokenStateFor(occupant, nowMs);
    const runtimePrompt = live ? runtimePromptFor(live.runtime, tokenState) : undefined;
    // no resumable token → restore needs an explicit --fresh (never silent); a stop --fresh cannot get past (a removed
    // seat, a runtime mismatch, a broken relation) must not suggest it, and a seat restore skips needs nothing.
    const freshCannotHelp = outcome.kind === "stop" && (outcome.stop.gate === "node_removed" || outcome.stop.gate === "runtime_mismatch" || outcome.stop.gate === "occupant_ambiguous");
    return {
      logicalId,
      occupantSessionId: occupant?.id ?? null,
      hasHistory: sessionRows.some((row) => row.nodeId === snapshotNodeId),
      intendedAction,
      ...(reason ? { reason } : {}),
      ...(restoreStatus ? { restoreStatus } : {}),
      tokenState,
      ...(provenance ? { provenance } : {}),
      ...(lastVerified ? { lastVerified } : {}),
      freshRequired: freshCannotHelp || outcome.kind === "skip_restoring" ? false : tokenState === "missing",
      ...(runtimePrompt ? { runtimePrompt } : {}),
      // Only a seat that is actually listed can be refused (a refusal for an unlisted seat is never predicted).
      ...(freshRequested && refusals.has(logicalId) ? { wouldRefuse: refusals.get(logicalId)! } : {}),
    };
  };
  const resolveOccupant = (savedNodeId: string, nodeId: string): ActiveOccupantResolution<PreviewSessionRow> => snapshot
    ? resolveActiveSnapshotSession(snapshot.data, savedNodeId) as unknown as ActiveOccupantResolution<PreviewSessionRow>
    : sessionRows.some((row) => row.nodeId === nodeId)
      ? resolveActiveOccupantRow(sessionRows, relationMap, nodeId)
      : { kind: "none" as const };
  const nodes: RestorePlanPreviewNode[] = rig.nodes.map((node) => {
    const savedNodeId = snapshot?.data.nodes?.find(saved => saved.logicalId === node.logicalId)?.id ?? node.id;
    const forecasted = forecast({
      logicalId: node.logicalId, snapshotNodeId: savedNodeId, live: { runtime: node.runtime ?? null },
      continuityStatus: continuity[node.id] ?? null,
      freshRequested: freshLogicalIds?.includes(node.logicalId) ?? false, occupant: resolveOccupant(savedNodeId, node.id),
    });
    // OF-62: restore captures a pre-restore snapshot of the LIVE rig first, and that capture refuses on a damaged saved
    // row (snapshot-capture.ts, the same predicate). Nothing is started, so the plan must not say "fresh-primed".
    const damage = savedRowDamage(node);
    if (damage.length === 0) return forecasted;
    return {
      ...forecasted,
      intendedAction: "awaiting-decision" as const,
      restoreStatus: "failed" as const,
      reason: `restore would refuse the whole rig: its pre-restore snapshot cannot be taken because ${savedRowDamageMessage(node.logicalId, damage)}. Repair the row first.`,
      freshRequired: false,
      savedRowDamage: damage,
    };
  });
  // A seat the snapshot's restore would attempt but the rig no longer has: restore reports it failed, so the plan lists it.
  if (snapshot && Array.isArray(snapshot.data.nodes)) {
    for (const saved of resolveSnapshotRestoreTopology(snapshot.data).intendedNodes) {
      if (rig.nodes.some((node) => node.logicalId === saved.logicalId)) continue;
      nodes.push(forecast({
        logicalId: saved.logicalId, snapshotNodeId: saved.id, live: null, continuityStatus: null,
        freshRequested: freshLogicalIds?.includes(saved.logicalId) ?? false, occupant: resolveOccupant(saved.id, saved.id),
      }));
    }
  }
  const damagedSeats = nodes.filter((node) => node.savedRowDamage);
  return {
    status: "plan",
    mode: "restore",
    rigId: rig.rig.id,
    rigName: rig.rig.name,
    snapshot: snapshot ? { id: snapshot.id, kind: snapshot.kind, createdAt: snapshot.createdAt } : null,
    wouldCaptureCurrentState: snapshot === null,
    nodes,
    mutated: false,
    ...(damagedSeats.length > 0 ? {
      restoreRefusal: {
        reason: `restore would refuse the whole rig and start no seat: its pre-restore snapshot cannot be taken because ${damagedSeats.map((node) => savedRowDamageMessage(node.logicalId, node.savedRowDamage!)).join("; ")}. Repair the row first.`,
        seats: damagedSeats.map((node) => node.logicalId),
      },
    } : {}),
  };
}

/** The `continuity_state.status` of each live seat, by node id, read where restore reads it (readContinuityRow). */
export function readPreviewContinuity(db: Database.Database, rig: RigWithRelations): Record<string, string> {
  const out: Record<string, string> = {};
  for (const node of rig.nodes) {
    const row = node.podId ? readContinuityRow(db, node.podId, node.id) : undefined;
    if (row) out[node.id] = row.status;
  }
  return out;
}
