import { restoreRuntimeCompatibilityError } from "./restore-runtime-compatibility.js";
import { nonInterruptiveNotice, nonInterruptiveSummary } from "../adapters/non-interruptive.js";
import { effortPrecedence, readSeatEffort } from "./seat-effort.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { NativePermissionStore } from "./native-permission-store.js";
import type { RigRepository } from "./rig-repository.js";
import { resolvePermissionPolicyAttachment } from "./permission-policy/policy-ref.js";
import { claudeResumeRotation, type SessionRegistry } from "./session-registry.js";
import type { EventBus } from "./event-bus.js";
import type { SnapshotRepository } from "./snapshot-repository.js";
import type { SnapshotCapture } from "./snapshot-capture.js";
import type { CheckpointStore } from "./checkpoint-store.js";
import type { NodeLauncher } from "./node-launcher.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { ClaudeResumeAdapter } from "../adapters/claude-resume.js";
import type { CodexResumeAdapter } from "../adapters/codex-resume.js";
import type { PiResumeAdapter } from "../adapters/pi-resume.js";
import type { OmpResumeAdapter } from "../adapters/omp-resume.js";
import type { TranscriptStore } from "./transcript-store.js";
import { assessNativeResumeProbe } from "./native-resume-probe.js";
import { observeClaudeDelivery, observeClaudeResumeLaunch, verifyClaudePaneProcess, type ClaudeLaunchedProcess } from "./native-process-lineage.js";
import { reanchorBuiltinStartupFile, reanchorShippedProjectionEntry } from "./builtin-startup-files.js";
import { seatGuidance, restoreMissingGuidance, missingGuidanceBlocks } from "./restore-guidance.js";
import type {
  RestoreOutcome,
  RestoreRigResult,
  RestoreResult,
  RestoreNodeResult,
  SnapshotData,
  NodeWithBinding,
  Edge,
  Session,
  Checkpoint,
  RestoreSnapshotSelection,
  NodeStartupSnapshot,
  RestoreStartupSource,
} from "./types.js";
import { projectRereadSkills, readSnapshotStartupCopy, startupFromSnapshotId, type FreshStartupContext, type SeatStartupSpecReader, type StartupFrom } from "./seat-startup-source.js";
import { asReplayContext, decideListedFreshSeat, startupToValidateForSeat } from "./fresh-seat-restore-decision.js";
import { writeStartupContext } from "./startup-orchestrator.js";
import { AppliedLaunchObservationStore } from "./applied-launch-observation-store.js";
import { classifyPaneRuntimeMatch } from "./seat-identity-reconciler.js";
import { isShellForeground } from "./shell-classifier.js";
import { rebindAndVerifyPaneIdentity } from "./seat-attention-reconciler.js";
import { SeatIdentityStore } from "./seat-identity-store.js";
import { validatePreRestore, startupInputFindings, type FreshSeatStartupOverride } from "./restore-preconditions.js";
import { newestUsableSnapshotCopy, noUsableCopyMessage, noUsableCopyRemedy, seatStartupForRestore, type SeatStartupForRestore } from "./own-startup-replay.js";
import { resolveSnapshotRestoreTopology } from "./restore-topology.js";
import { classifySessionLiveness } from "./session-liveness.js";

// L3: result shape for runtime-truth reconciliation. A reconciliation that
// does NOT meet all four evidence preconditions is a no-op with a missing
// reason, NOT an error. Decision 3: terminal post-reconciliation outcome is
// `operator_recovered`; `ready` is forbidden.
export type ReconcileNodeResult =
  | {
      ok: true;
      attemptId: number;
      from: "failed" | "attention_required";
      to: "operator_recovered";
      evidence: { tmux: boolean; fgProcess: "claude" | "codex" | string; resumeTokenUsed: boolean; paneState: "usable" };
    }
  | {
      ok: false;
      code:
        | "node_not_found"
        | "no_attempt"
        | "outcome_not_upgradable"
        | "tmux_session_missing"
        | "binding_mismatch"
        | "process_lineage_mismatch"
        | "fg_process_not_runtime"
        | "resume_token_not_used"
        | "pane_not_usable";
      detail: string;
    };

// Only these edge kinds constrain launch order
const LAUNCH_DEPENDENCY_KINDS = new Set(["delegates_to", "spawned_by"]);

// OPR.0.5.7.1 consumer alignment: the four-way active-occupant ladder lives
// in the pure leaf module active-occupant.ts, shared with preview, snapshot
// usability, and lifecycle projection. Imported and re-exported here so the
// existing export surface and the execution call sites below are unchanged.
import { resolveActiveSnapshotSession, activeOccupantAmbiguityError, absentSeatResumeHistory, absentSeatResumeHistoryError, freshSeatLaunchCommand } from "./active-occupant.js";
export { resolveActiveSnapshotSession } from "./active-occupant.js";
export type { ActiveSnapshotSessionResolution } from "./active-occupant.js";

export function rollupRestoreRigResult(nodes: RestoreNodeResult[]): RestoreRigResult {
  if (nodes.length === 0) return "failed";
  // L3: `attention_required` is non-terminal failure (alive but blocked on
  // operator action). It rolls up as `partially_restored`. `operator_recovered`
  // is a clean post-reconciliation outcome and rolls up like `resumed`.
  const allFailed = nodes.every((node) => node.status === "failed");
  if (allFailed) return "failed";
  // A seat running without part of its guidance keeps its own status; the rig isn't fully restored.
  if (nodes.some((node) => (node.guidanceGaps?.length ?? 0) > 0)) return "partially_restored";
  if (nodes.some((node) => node.status === "fresh" || node.status === "fresh-primed" || node.status === "awaiting-decision" || node.status === "failed" || node.status === "attention_required")) {
    return "partially_restored";
  }
  return "fully_restored";
}

/** OPR.0.4.3.20 FR-7 — restore/launch statuses that mean NO session is running and
 *  the operator must act. The launch API + CLI must NOT report these as a successful
 *  launch (a subset/single launch that lands `awaiting-decision` is not "Launched"). */
export const NON_RUNNING_LAUNCH_STATUSES: ReadonlySet<string> = new Set([
  "awaiting-decision",
  "attention_required",
  "failed",
]);

/** True when a restore/launch status means a session is actually running (a real
 *  successful launch): resumed / rebuilt / fresh / fresh-primed / operator_recovered. */
export function launchStatusIsRunning(status: string): boolean {
  return !NON_RUNNING_LAUNCH_STATUSES.has(status);
}

/** What `rig launch` does for this node from this snapshot without --fresh, read as the restore path reads it: the
 *  occupant, then the pre-launch stop-and-ask check, then the resume decision (restoreNodeWithCompensation and the
 *  resume step after it). An exited agent's message offers stop-then-launch as a resume only when this says so. */
function snapshotLaunchOutcome(data: SnapshotData, nodeId: string, runtime: string | null):
  { kind: "resume" } | { kind: "fresh" | "decision" | "unrecoverable"; why: string } {
  const occupant = resolveActiveSnapshotSession(data, nodeId);
  if (occupant.kind === "ambiguous") return { kind: "unrecoverable", why: "can't tell which saved session is this seat's" };
  const session = occupant.kind === "resolved" ? occupant.session : null;
  const runtimeError = restoreRuntimeCompatibilityError(runtime,
    data.nodeStartupContext?.[nodeId]?.runtime);
  if (runtimeError) return { kind: "decision", why: runtimeError };
  if (!session) {
    // The restore's own rule for a seat stopped at capture whose earlier occupant left a token.
    const prior = occupant.kind === "none" ? absentSeatResumeHistory(data.sessions, nodeId) : null;
    return prior
      ? { kind: "decision", why: `had no running occupant for this seat when it was taken, but an earlier occupant left a '${prior.resumeType}' resume token` }
      : { kind: "fresh", why: "saves no session for this seat" };
  }
  const policy = session.restorePolicy ?? "resume_if_possible";
  if (policy !== "resume_if_possible") return { kind: "fresh", why: `saves this seat with restore policy '${policy}'` };
  if (!session.resumeToken) return { kind: "decision", why: "has no resume token for this seat" };
  if (!session.resumeType || session.resumeType === "none") return { kind: "fresh", why: "records no resume source for this seat" };
  return { kind: "resume" };
}

export interface NarrowLaunchResult {
  ok: boolean;
  planOnly?: boolean;
  code?: string;
  message?: string;
  launched?: RestoreNodeResult[];
  held?: Array<{ nodeId: string; logicalId: string; reason: string }>;
  alreadyRunning?: Array<{ nodeId: string; logicalId: string }>;
  failedTargets?: Array<{ nodeId: string; logicalId: string; reason: string }>;
  targetNodes?: Array<{ nodeId: string; logicalId: string }>;
  unmatchedIds?: string[];
  warnings?: string[];
  snapshotSelection?: RestoreSnapshotSelection;
  nonTargetEffects?: {
    mode: "unchanged" | "detach_and_hold";
    reason: string | null;
    affected: Array<{ nodeId: string; logicalId: string; reason: string }>;
    condition?: string;
  };
}

interface RestoreOrchestratorDeps {
  db: Database.Database;
  rigRepo: RigRepository;
  sessionRegistry: SessionRegistry;
  eventBus: EventBus;
  snapshotRepo: SnapshotRepository;
  snapshotCapture: SnapshotCapture;
  checkpointStore: CheckpointStore;
  nodeLauncher: NodeLauncher;
  tmuxAdapter: TmuxAdapter;
  claudeResume: ClaudeResumeAdapter;
  codexResume: CodexResumeAdapter;
  /** OPR.0.4.6.PI1 FR-6 — optional so older wiring/tests keep working; a Pi
   *  resume without the adapter falls through to the honest no-adapter error. */
  piResume?: PiResumeAdapter;
  ompResume?: OmpResumeAdapter;
  transcriptStore?: TranscriptStore;
  serviceOrchestrator?: import("./service-orchestrator.js").ServiceOrchestrator;
  listProcesses?: () => Promise<Array<{ pid: number; ppid: number; command: string }>>;
  /** OF-32: re-reads a fresh seat's startup policy from its rig's recorded spec (PodRigInstantiator), the reader
   *  `rig seat launch --fresh` uses. Without it a rig that records a source cannot start a seat fresh
   *  (launch_unavailable), exactly as on `rig seat launch --fresh`. */
  seatStartupSource?: SeatStartupSpecReader;
}

/** Per-seat restore inputs threaded from restore / launch into each seat's launch. */
type RestoreSeatOpts = {
  adapters?: Record<string, import("./runtime-adapter.js").RuntimeAdapter>;
  fsOps?: { exists(path: string): boolean };
  freshLogicalIds?: string[];
  /** OF-32: where a seat this restore starts fresh takes its startup policy from (default: the rig's spec now). */
  startupFrom?: StartupFrom;
  /** Review F4: the snapshot copy pre-restore validation chose (and checked) for a seat, by logical id. The seat's
   *  launch replays exactly that copy, or is refused if its snapshot is gone; it never chooses again. */
  preValidatedCopies?: Map<string, { snapshotId: string; context: NodeStartupSnapshot; warning?: string }>;
};

/** Whether this restore resumes the seat's saved conversation (an exact resume) rather than starting it fresh.
 *  The one predicate for both the pre-launch startup decision and the post-launch replay containment. */
function snapshotSeatResumes(session: { restorePolicy?: string | null; resumeType?: string | null } | null, freshRequested: boolean): boolean {
  const restorePolicy = session?.restorePolicy ?? "resume_if_possible";
  const resumeType = session?.resumeType ?? null;
  return restorePolicy === "resume_if_possible" && !!resumeType && resumeType !== "none" && !freshRequested;
}

export class RestoreOrchestrator {
  readonly db: Database.Database;
  private activeRestores = new Set<string>();
  private rigRepo: RigRepository;
  private sessionRegistry: SessionRegistry;
  private eventBus: EventBus;
  private snapshotRepo: SnapshotRepository;
  private snapshotCapture: SnapshotCapture;
  private nodeLauncher: NodeLauncher;
  private tmuxAdapter: TmuxAdapter;
  private claudeResume: ClaudeResumeAdapter;
  private codexResume: CodexResumeAdapter;
  private piResume: PiResumeAdapter | null;
  private ompResume: OmpResumeAdapter | null;
  private transcriptStore: TranscriptStore | null;
  private serviceOrchestrator: import("./service-orchestrator.js").ServiceOrchestrator | null;
  private listProcesses: (() => Promise<Array<{ pid: number; ppid: number; command: string }>>) | undefined;
  private seatStartupSource: SeatStartupSpecReader | null;
  private appliedLaunchStore: AppliedLaunchObservationStore;

  constructor(deps: RestoreOrchestratorDeps) {
    if (deps.db !== deps.rigRepo.db) {
      throw new Error("RestoreOrchestrator: rigRepo must share the same db handle");
    }
    if (deps.db !== deps.sessionRegistry.db) {
      throw new Error("RestoreOrchestrator: sessionRegistry must share the same db handle");
    }
    if (deps.db !== deps.eventBus.db) {
      throw new Error("RestoreOrchestrator: eventBus must share the same db handle");
    }
    if (deps.db !== deps.snapshotRepo.db) {
      throw new Error("RestoreOrchestrator: snapshotRepo must share the same db handle");
    }
    if (deps.db !== deps.checkpointStore.db) {
      throw new Error("RestoreOrchestrator: checkpointStore must share the same db handle");
    }
    if (deps.db !== deps.snapshotCapture.db) {
      throw new Error("RestoreOrchestrator: snapshotCapture must share the same db handle");
    }
    if (deps.db !== deps.nodeLauncher.db) {
      throw new Error("RestoreOrchestrator: nodeLauncher must share the same db handle");
    }

    this.db = deps.db;
    this.rigRepo = deps.rigRepo;
    this.sessionRegistry = deps.sessionRegistry;
    this.eventBus = deps.eventBus;
    this.snapshotRepo = deps.snapshotRepo;
    this.snapshotCapture = deps.snapshotCapture;
    this.nodeLauncher = deps.nodeLauncher;
    this.tmuxAdapter = deps.tmuxAdapter;
    this.claudeResume = deps.claudeResume;
    this.codexResume = deps.codexResume;
    this.piResume = deps.piResume ?? null;
    this.ompResume = deps.ompResume ?? null;
    this.transcriptStore = deps.transcriptStore ?? null;
    this.serviceOrchestrator = deps.serviceOrchestrator ?? null;
    this.listProcesses = deps.listProcesses;
    this.seatStartupSource = deps.seatStartupSource ?? null;
    this.appliedLaunchStore = new AppliedLaunchObservationStore(deps.db);
  }

  async restore(snapshotId: string, opts?: {
    adapters?: Record<string, import("./runtime-adapter.js").RuntimeAdapter>;
    fsOps?: { exists(path: string): boolean };
    /**
     * OPR.0.3.4.2 — operation B opt-in: logical ids the operator explicitly
     * asked to fresh-prime (`rig up --existing <rig> --fresh <seat...>`).
     * Listed seats skip the resume attempt and launch a deliberate
     * blank-slate session, reported as `fresh-primed`. Unlisted unresumable
     * resume-policy seats STOP as `awaiting-decision` instead.
     */
    freshLogicalIds?: string[];
    /** OF-32: where the seats this restore starts fresh take their startup policy from: the rig's spec as it is now
     *  (`spec`, the default) or the context saved by each seat's last successful launch (`stored`). An exact resume
     *  never reads either: it keeps the stored context. */
    startupFrom?: StartupFrom;
    /** Explicit rig launch choice; persisted only after restore preconditions pass. */
    nonInterruptive?: boolean;
    /** Selection evidence from an automatic caller. Direct restore defaults
     * to explicit because its public door names the snapshot id. */
    snapshotSelection?: RestoreSnapshotSelection;
    /**
     * L3: fired with the persisted `restore.started` event seq as soon as the
     * orchestrator commits to running per-node restore. Routes use this to
     * return `attemptId` to the client immediately while per-node work
     * continues in the background.
     */
    onAttemptStarted?: (attemptId: number) => void;
  }): Promise<RestoreOutcome> {
    // 1. Load snapshot
    const snapshot = this.snapshotRepo.getSnapshot(snapshotId);
    if (!snapshot) {
      return { ok: false, code: "snapshot_not_found", message: `Snapshot ${snapshotId} not found` };
    }

    const rigId = snapshot.rigId;
    const rig = this.rigRepo.getRig(rigId);
    if (!rig) {
      return { ok: false, code: "rig_not_found", message: `Rig ${rigId} not found` };
    }
    const guard = this.tmuxAdapter.deliveryGuard;
    const guardedIds = rig.nodes.map(node => node.id);
    if (guard && guardedIds.some(id => !guard.ownsLifecycle(id))) {
      return guard.lifecycle(guardedIds, () => this.restore(snapshotId, opts));
    }
    const selectionOutcome = opts?.snapshotSelection ? null : this.snapshotRepo.selectRestoreUsable(rigId, snapshotId);
    if (selectionOutcome && !selectionOutcome.ok) return selectionOutcome;
    const snapshotSelection = opts?.snapshotSelection ?? selectionOutcome?.selection;

    // Classify DB-running sessions against tmux reality WITHOUT mutating DB.
    // This determines whether the rig is safe to restore before any state
    // changes occur — critical for pre_restore snapshot ordering (snapshot
    // must capture original DB state, not post-reconciliation state).
    const classification = await this.classifyRunningSessions(rigId);
    if (classification.live.length > 0) {
      return { ok: false, code: "rig_not_stopped", message: `Rig ${rigId} has live sessions. Stop the rig with 'rig down' before restoring, or use the latest auto-pre-down snapshot.` };
    }
    if (classification.unknown.length > 0) {
      // Not "live": tmux gave no usable answer (deadline or probe error). Fail closed, but do not tell the
      // operator to stop a rig nobody has shown to be running; the refusal is retryable.
      return { ok: false, code: "rig_not_stopped", message: `Rig ${rigId} was not restored: tmux did not answer a session-liveness probe within the deadline (or the probe errored), so liveness is unknown and some seats may still be live. Nothing was changed. Retry, or check tmux first (for example 'tmux ls'); if tmux shows seats still running, stop the rig with 'rig down' before restoring.` };
    }

    // Per-rig concurrency lock
    if (this.activeRestores.has(rigId)) {
      return { ok: false, code: "restore_in_progress", message: `Restore already in progress for rig ${rigId}` };
    }
    this.activeRestores.add(rigId);

    try {
      const preValidatedCopies = new Map<string, { snapshotId: string; context: NodeStartupSnapshot; warning?: string }>();
      const validation = validatePreRestore(snapshot.data, {
        fsOps: opts?.fsOps,
        servicesRecord: this.rigRepo.getServicesRecord(rigId),
        freshLogicalIds: opts?.freshLogicalIds,
        // OF-32: a seat started fresh replays the snapshot's copy of its startup files only when nothing newer exists;
        // otherwise its source is decided and checked per seat before its launch (restoreNodeUnisolated), and the
        // snapshot's copy (which may name a release since deleted) cannot block the restore.
        freshSeatStartup: (node) => {
          const decided = this.freshSeatStartupToValidate(rigId, node.logicalId, opts, snapshot.data.nodeStartupContext?.[node.id] ?? null);
          if (decided && typeof decided === "object" && "replay" in decided && decided.fromSnapshotId) {
            preValidatedCopies.set(node.logicalId, { snapshotId: decided.fromSnapshotId, context: decided.replay, ...(decided.warning ? { warning: decided.warning } : {}) });
          }
          return decided;
        },
      });
      const topology = resolveSnapshotRestoreTopology(snapshot.data);
      // The attempt's roster names its seats by the ids the attempt's results use: the LIVE node ids (a seat removed and
      // grown back has a new one), found by logical id. The restore receipt and the node inventory join the roster with
      // `result.nodes[].nodeId` and with later reconciliations (both live ids); a snapshot-id roster made a resumed
      // regrown seat read as "No restore outcome was recorded". A seat with no live node keeps its snapshot id, which is
      // the id its `failed` result carries.
      const liveIdByLogicalId = new Map((this.rigRepo.getRig(rigId)?.nodes ?? []).map((live) => [live.logicalId, live.id]));
      const intendedRoster = topology.intendedRoster.map((seat) => ({ ...seat, nodeId: liveIdByLogicalId.get(seat.logicalId) ?? seat.nodeId }));
      if (validation.blockers.length > 0) {
        const result: RestoreResult = {
          snapshotId,
          preRestoreSnapshotId: null,
          rigResult: "not_attempted",
          nodes: [],
          warnings: validation.warnings,
          blockers: validation.blockers,
          snapshotSelection,
          intendedRoster,
          excludedNodes: topology.excludedNodes,
        };
        return {
          ok: false,
          code: "pre_restore_validation_failed",
          message: "Restore pre-validation failed; no restore mutation was attempted.",
          result,
        };
      }

      // 2. Capture pre-restore snapshot BEFORE any DB mutations —
      // DB still reflects original session state (running for stale sessions)
      // N-C3: a seat whose saved startup context is not JSON is restorable (pre-restore validation found what it replays
      // instead), so this capture records no copy for it rather than ending the restore.
      const captureWarnings: string[] = [];
      const preRestoreSnapshot = this.snapshotCapture.captureSnapshot(rigId, "pre_restore", {
        onUnreadableStartupContext: (nodeId, message) => {
          const logicalId = rig.nodes.find((n) => n.id === nodeId)?.logicalId ?? nodeId;
          captureWarnings.push(`Restore: ${logicalId}: the pre-restore snapshot holds no copy of its saved startup context, which is not JSON (${message}).`);
        },
      });

      if (opts?.nonInterruptive !== undefined) this.rigRepo.setRigNonInterruptive(rigId, opts.nonInterruptive);

      // 2b. NOW mark stale sessions as detached (safe: we've captured the
      // pre-restore snapshot and confirmed no live/unknown sessions remain)
      for (const sessionId of classification.stale) {
        this.sessionRegistry.markDetached(sessionId);
      }

      // 3. Emit restore.started — the persisted event seq IS the attempt id
      //    (Decision 1: no separate restore_attempts table).
      const restoreStartedEvent = this.eventBus.emit({
        type: "restore.started",
        rigId,
        snapshotId,
        snapshotSelection,
        intendedRoster,
        excludedNodes: topology.excludedNodes,
      });
      const attemptId = restoreStartedEvent.seq;
      try {
        opts?.onAttemptStarted?.(attemptId);
      } catch {
        // onAttemptStarted is fire-and-forget; never let a route's response
        // logic crash the restore pipeline.
      }

      // 3b. Service gate: boot services before agent restore if this rig has services
      if (this.serviceOrchestrator) {
        const svcRecord = this.rigRepo.getServicesRecord(rigId);
        if (svcRecord) {
          const bootResult = await this.serviceOrchestrator.boot(rigId);
          if (!bootResult.ok) {
            this.eventBus.emit({
              type: "restore.completed",
              rigId,
              snapshotId,
              result: {
                snapshotId,
                preRestoreSnapshotId: preRestoreSnapshot.id,
                rigResult: "failed",
                nodes: [],
                warnings: [`Service boot failed: ${bootResult.error}`],
                snapshotSelection,
                intendedRoster,
                excludedNodes: topology.excludedNodes,
              },
            });
            return { ok: false, code: "service_boot_failed", message: `Service boot failed before agent restore: ${bootResult.error}` };
          }
        }
      }

      // 4. Compute restore plan
      const plan = this.computeRestorePlan(snapshot.data);

      // 5. Execute restore with compensating pattern per node
      const nodeResults: RestoreNodeResult[] = [];
      const restoreWarnings: string[] = [...validation.warnings, ...captureWarnings];
      if (this.rigRepo.getRigNonInterruptive(rigId)) restoreWarnings.push(nonInterruptiveSummary(true));
      else if (opts?.nonInterruptive === false) restoreWarnings.push(nonInterruptiveSummary(false));
      for (const entry of plan) {
        const result = await this.restoreNodeWithCompensation(entry, rigId, snapshotId, snapshot.data, { ...opts, preValidatedCopies }, restoreWarnings);
        nodeResults.push(result);
      }

      const restoreResult: RestoreResult = {
        snapshotId,
        preRestoreSnapshotId: preRestoreSnapshot.id,
        rigResult: rollupRestoreRigResult(nodeResults),
        nodes: nodeResults,
        warnings: restoreWarnings,
        snapshotSelection,
        intendedRoster,
        excludedNodes: topology.excludedNodes,
      };

      // 7. Emit restore.completed
      this.eventBus.emit({ type: "restore.completed", rigId, snapshotId, result: restoreResult });

      return { ok: true, result: restoreResult };
    } catch (err) {
      return {
        ok: false,
        code: "restore_error",
        message: err instanceof Error ? err.message : String(err),
      };
    } finally {
      this.activeRestores.delete(rigId);
    }
  }

  async launchNodeSubset(rigId: string, logicalIds: string[], opts?: {
    adapters?: Record<string, import("./runtime-adapter.js").RuntimeAdapter>;
    fsOps?: { exists(path: string): boolean };
    holdReason?: string;
    snapshotId?: string;
  }): Promise<NarrowLaunchResult> {
    return this.launchNodeTargets(rigId, logicalIds, { ...opts, nonTargetMode: "detach_and_hold" });
  }

  planNodeSubset(rigId: string, logicalIds: string[], opts?: {
    holdReason?: string;
    snapshotId?: string;
    nonTargetMode?: "unchanged" | "detach_and_hold";
  }): NarrowLaunchResult {
    const rig = this.rigRepo.getRig(rigId);
    if (!rig) return { ok: false, code: "rig_not_found", message: `Rig ${rigId} not found` };
    const selected = this.snapshotRepo.selectRestoreUsable(rigId, opts?.snapshotId);
    if (!selected.ok) return selected;
    const intendedNodes = resolveSnapshotRestoreTopology(selected.snapshot.data).intendedNodes;
    const targetNodes = intendedNodes.filter((node) => logicalIds.includes(node.logicalId) || logicalIds.includes(node.id));
    const targetIds = new Set(targetNodes.map((node) => node.logicalId));
    const targetNodeIds = new Set(targetNodes.map((node) => node.id));
    if (targetIds.size === 0) {
      return { ok: false, code: "no_matching_nodes", message: `No nodes match logical ids: ${logicalIds.join(", ")}` };
    }
    const nonTargetMode = opts?.nonTargetMode ?? "detach_and_hold";
    const reason = nonTargetMode === "unchanged" ? null : (opts?.holdReason ?? "excluded_from_subset");
    const nonTargetEffects: NarrowLaunchResult["nonTargetEffects"] = nonTargetMode === "unchanged"
      ? { mode: "unchanged", reason: null, affected: [] }
      : {
        mode: "detach_and_hold",
        reason,
        affected: rig.nodes
          .filter((node) => !targetIds.has(node.logicalId) && !targetNodeIds.has(node.id))
          .map((node) => ({ nodeId: node.id, logicalId: node.logicalId, reason: reason! })),
        condition: "applies only to non-target seats proven not live at execution time",
      };
    return {
      ok: true,
      planOnly: true,
      snapshotSelection: selected.selection,
      targetNodes: intendedNodes
        .filter((node) => targetIds.has(node.logicalId))
        // The live seat's id, as execution reports it (a seat grown back has a new one); a removed seat keeps the snapshot's.
        .map((node) => ({ nodeId: rig.nodes.find((live) => live.logicalId === node.logicalId)?.id ?? node.id, logicalId: node.logicalId })),
      unmatchedIds: logicalIds.filter((id) => !targetIds.has(id) && !targetNodeIds.has(id)),
      nonTargetEffects,
    };
  }

  async launchSingleNode(rigId: string, logicalId: string, opts?: {
    adapters?: Record<string, import("./runtime-adapter.js").RuntimeAdapter>;
    fsOps?: { exists(path: string): boolean };
    snapshotId?: string;
  }): Promise<NarrowLaunchResult> {
    return this.launchNodeTargets(rigId, [logicalId], { ...opts, nonTargetMode: "unchanged" });
  }

  private async launchNodeTargets(rigId: string, logicalIds: string[], opts: {
    adapters?: Record<string, import("./runtime-adapter.js").RuntimeAdapter>;
    fsOps?: { exists(path: string): boolean };
    holdReason?: string;
    snapshotId?: string;
    nonTargetMode: "unchanged" | "detach_and_hold";
  }): Promise<NarrowLaunchResult> {
    const rig = this.rigRepo.getRig(rigId);
    if (!rig) return { ok: false, code: "rig_not_found", message: `Rig ${rigId} not found` };

    const selected = this.snapshotRepo.selectRestoreUsable(rigId, opts.snapshotId);
    if (!selected.ok) return selected;
    const { snapshot, selection: snapshotSelection } = selected;

    const allNodes = rig.nodes;
    const targetNodes = resolveSnapshotRestoreTopology(snapshot.data).intendedNodes
      .filter((node) => logicalIds.includes(node.logicalId));
    const matchedIds = new Set(targetNodes.map((n) => n.logicalId));
    const unmatchedIds = logicalIds.filter((id) => !matchedIds.has(id));
    if (targetNodes.length === 0) return { ok: false, code: "no_matching_nodes", message: `No nodes match logical ids: ${logicalIds.join(", ")}` };

    // The targets come from the SNAPSHOT; every liveness check and lifecycle claim is about the LIVE seat, found by
    // logical id. A seat removed and grown back keeps its logical id but has a new node id, so the snapshot's id names
    // nothing live: matched on it, the regrown target is mistaken for a non-target (and held) and its live session is
    // not seen. A target with no live node (removed, not grown back) has no sessions; restore reports it failed.
    const liveNodeOf = (node: { logicalId: string }) => allNodes.find((current) => current.logicalId === node.logicalId);
    const nonTargetNodes = opts.nonTargetMode === "detach_and_hold"
      ? allNodes.filter((node) => !targetNodes.some((target) => target.logicalId === node.logicalId))
      : [];

    const guard = this.tmuxAdapter.deliveryGuard;
    const guardedIds = [
      ...targetNodes.flatMap((node) => liveNodeOf(node)?.id ?? []),
      ...nonTargetNodes.map(node => node.id),
    ];
    if (guard && guardedIds.some(id => !guard.ownsLifecycle(id))) {
      return guard.lifecycle(guardedIds, () => this.launchNodeTargets(rigId, logicalIds, opts));
    }

    // Per-target tmux-liveness classification (runtime truth, fail-closed)
    const launched: RestoreNodeResult[] = [];
    const alreadyRunning: Array<{ nodeId: string; logicalId: string }> = [];
    const failedTargets: Array<{ nodeId: string; logicalId: string; reason: string }> = [];
    // Subset-level aggregate of per-node warnings (incl. FR-5 derived-name
    // fallback observability). Previously created per-node inside the loop and
    // discarded, so restore.subset_completed carried warnings: [].
    const subsetWarnings: string[] = [];

    for (const node of targetNodes) {
      const liveTarget = liveNodeOf(node);
      const liveId = liveTarget?.id ?? null;
      const sessions = liveId === null ? [] : this.sessionRegistry.getSessionsForRig(rigId)
        .filter((s) => s.nodeId === liveId && s.status === "running");

      let isLive = false;
      let isUnknown = false;
      let idleSession: string | undefined;

      for (const session of sessions) {
        try {
          const alive = await this.tmuxAdapter.hasSession(session.sessionName);
          if (alive) {
            // A preserved shell is not a running agent. Reuse the process-lineage
            // check's positive idle-shell evidence; opaque wrappers stay untouched.
            isLive = true;
            const binding = this.sessionRegistry.getBindingForNode(liveId!);
            const pane = binding?.tmuxSession === session.sessionName ? binding.tmuxPane : null;
            const runtime = liveTarget?.runtime ?? node.runtime;
            // Launch needs consistent positive evidence: both samples idle with the same fingerprint, and the
            // bound pane still in this session (a recycled pane id could name another session's shell).
            if (pane && ["claude-code", "codex", "pi", "omp"].includes(runtime ?? "")
              && isShellForeground(await this.tmuxAdapter.getPaneCommand(pane) ?? "")
              && (await this.tmuxAdapter.listPanes(session.sessionName)).some(candidate => candidate.id === pane)
              && (await observeClaudeDelivery({ target: pane, tmux: this.tmuxAdapter, listProcesses: this.listProcesses }, { unknownKeepsIdle: false })).state === "idle_shell"
              && isShellForeground(await this.tmuxAdapter.getPaneCommand(pane) ?? "")) {
              idleSession = session.sessionName;
              isLive = false;
              continue;
            }
            break;
          }
        } catch {
          isUnknown = true;
        }
      }

      if (isLive) {
        alreadyRunning.push({ nodeId: liveId ?? node.id, logicalId: node.logicalId });
        continue;
      }
      if (idleSession) {
        // Keep the pane/history and the existing per-target failure contract.
        // Choosing a fresh versus resumed conversation belongs to the person. Stopping closes the pane, so
        // stop-then-launch is offered as a resume only when this snapshot can resume the seat; otherwise the
        // message says what that launch would do instead. The command pins the snapshot that was checked.
        const outcome = snapshotLaunchOutcome(snapshot.data, node.id, liveTarget ? liveTarget.runtime : node.runtime);
        const launchCommand = `rig launch ${rigId} ${node.logicalId} --snapshot-id ${snapshot.id}`;
        const relaunch = outcome.kind === "resume"
          ? `To resume its conversation: rig seat stop ${idleSession} --reason "<why>", then ${launchCommand} (this closes the pane, and launch resumes from that snapshot's resume token). `
          : `Stopping it and launching from snapshot ${snapshot.id} won't resume this conversation: that snapshot ${outcome.why}, so launch would `
            + `${outcome.kind === "fresh" ? "start a fresh conversation" : outcome.kind === "decision" ? "start nothing and ask for a decision" : "fail"}. `;
        launched.push({
          nodeId: liveId ?? node.id, logicalId: node.logicalId, status: "attention_required",
          error: `Session alive, agent not running for '${node.logicalId}': tmux session '${idleSession}' holds an idle shell, and its pane and history are preserved. `
            + `The person chooses how to bring the agent back. ${relaunch}`
            + `To start a blank occupant: rig seat launch ${idleSession} --fresh --stop --reason "<why>". `
            + `To keep the pane: attach to tmux session '${idleSession}' and restart the agent there by hand.`,
        });
        continue;
      }
      if (isUnknown) {
        // OPR.0.4.3.28 correction — INVERT the fail-closed-on-unknown launch default. A failed tmux
        // liveness probe is NOT positive evidence of a live seat (only isLive, above, is). Deny-by-
        // default here hard-503'd all restore/launch on a transient tmux blip. Instead PROCEED to
        // launch this node (same path as stale/no-session below) and surface the uncertainty as a
        // NON-blocking warning so an operator/agent can verify no live seat was squatted. isLive stays
        // the no-squat guard.
        subsetWarnings.push(
          `liveness_probe_unknown: launched '${node.logicalId}' despite a failed tmux liveness probe — verify no live seat was squatted`,
        );
      }

      // Stale or no session (or probe-unknown, per the inversion above) — launchable. Accumulate this
      // node's warnings into
      // the subset-level array so they survive to restore.subset_completed + the
      // API result (FR-5 fallback observability must not be discarded here).
      const planEntry = { node };
      const result = await this.restoreNodeWithCompensation(
        planEntry, rigId, snapshot.id, snapshot.data, { adapters: opts?.adapters, fsOps: opts?.fsOps }, subsetWarnings,
      );
      launched.push(result);
    }

    // Emit restore.subset_completed for launched targets only
    if (launched.length > 0) {
      const subsetResult: RestoreResult = {
        snapshotId: snapshot.id,
        preRestoreSnapshotId: null as unknown as string,
        rigResult: rollupRestoreRigResult(launched),
        nodes: launched,
        warnings: subsetWarnings,
        snapshotSelection,
      };
      this.eventBus.emit({ type: "restore.subset_completed", rigId, snapshotId: snapshot.id, result: subsetResult });
    }

    // Emit node.held for non-running held non-targets (tri-state: running/unknown/held)
    const held: Array<{ nodeId: string; logicalId: string; reason: string }> = [];
    const holdReasonText = opts?.holdReason ?? "excluded_from_subset";
    for (const node of nonTargetNodes) {
      const sessions = this.sessionRegistry.getSessionsForRig(rigId)
        .filter((s) => s.nodeId === node.id && s.status === "running");

      let running = false;
      let unknown = false;
      for (const session of sessions) {
        try {
          if (await this.tmuxAdapter.hasSession(session.sessionName)) { running = true; break; }
        } catch {
          unknown = true;
        }
      }

      if (running || unknown) continue;

      // Clear stale DB-running rows for non-targets proven tmux-dead so
      // inventory projects heldReason honestly (not masked by stale running status).
      for (const session of sessions) {
        this.sessionRegistry.markDetached(session.id);
      }

      this.eventBus.emit({
        type: "node.held",
        rigId,
        nodeId: node.id,
        logicalId: node.logicalId,
        reason: holdReasonText,
      });
      held.push({ nodeId: node.id, logicalId: node.logicalId, reason: holdReasonText });
    }

    return {
      ok: true,
      launched,
      held,
      alreadyRunning,
      failedTargets,
      unmatchedIds: unmatchedIds.length > 0 ? unmatchedIds : undefined,
      warnings: subsetWarnings.length > 0 ? subsetWarnings : undefined,
      snapshotSelection,
      nonTargetEffects: {
        mode: opts.nonTargetMode,
        reason: opts.nonTargetMode === "detach_and_hold" ? holdReasonText : null,
        affected: held,
      },
    };
  }

  private captureNodeState(nodeId: string, rigId: string): { binding: import("./types.js").Binding | null; sessions: { id: string; status: string }[] } {
    const binding = this.sessionRegistry.getBindingForNode(nodeId);
    const sessions = this.sessionRegistry.getSessionsForRig(rigId)
      .filter((s) => s.nodeId === nodeId && s.status !== "superseded" && s.status !== "exited")
      .map((s) => ({ id: s.id, status: s.status }));
    return { binding, sessions };
  }

  /**
   * Classify ALL DB-running sessions against tmux reality without mutating DB.
   * Scans every session (not just latest-per-node) to catch older live sessions
   * behind newer detached rows. Returns structured classification for the caller
   * to act on: live sessions block restore, stale sessions get marked detached
   * AFTER the pre_restore snapshot is captured, unknown sessions fail closed.
   * Probing stops at the first live or unreadable session: either one already refuses the restore, and
   * on a wedged tmux every further probe would cost another full deadline. The buckets are therefore
   * complete only when the restore may proceed (no live, no unknown).
   */
  private async classifyRunningSessions(rigId: string): Promise<{
    live: string[];
    stale: string[];
    unknown: string[];
  }> {
    const live: string[] = [];
    const stale: string[] = [];
    const unknown: string[] = [];

    for (const session of this.sessionRegistry.getSessionsForRig(rigId)) {
      if (session.status !== "running") continue;
      // Shared with restore-check's advice (classifySessionLiveness) so the two cannot drift.
      // A probe that throws fails closed: classified unknown so restore blocks.
      const liveness = await classifySessionLiveness(this.tmuxAdapter, session.sessionName);
      if (liveness === "live") { live.push(session.id); break; }
      else if (liveness === "dead") stale.push(session.id);
      else { unknown.push(session.id); break; }
    }

    return { live, stale, unknown };
  }

  private clearStaleState(nodeId: string, rigId: string): void {
    this.sessionRegistry.clearBinding(nodeId);
    const sessions = this.sessionRegistry.getSessionsForRig(rigId);
    for (const sess of sessions) {
      if (sess.nodeId === nodeId && sess.status !== "superseded" && sess.status !== "exited") {
        this.sessionRegistry.markSuperseded(sess.id);
      }
    }
  }

  private restoreNodeState(nodeId: string, priorState: { binding: import("./types.js").Binding | null; sessions: { id: string; status: string }[] }): void {
    // Restore prior binding EXACTLY, not as a partial merge. The launch path
    // may have created a binding for this node (NodeLauncher), and
    // updateBinding alone is an upsert MERGE: a null prior binding would
    // leave the launched binding pointing at a killed session, and null
    // prior fields would silently preserve launched-row values. Clear first,
    // then recreate from the prior fields — or leave absent when no prior
    // binding existed. Shared by launch-failure compensation and
    // rollbackToZeroSession so both carry the same exact semantics.
    this.sessionRegistry.clearBinding(nodeId);
    if (priorState.binding) {
      this.sessionRegistry.updateBinding(nodeId, {
        attachmentType: priorState.binding.attachmentType ?? undefined,
        tmuxSession: priorState.binding.tmuxSession ?? undefined,
        tmuxWindow: priorState.binding.tmuxWindow ?? undefined,
        tmuxPane: priorState.binding.tmuxPane ?? undefined,
        externalSessionName: priorState.binding.externalSessionName ?? undefined,
        cmuxWorkspace: priorState.binding.cmuxWorkspace ?? undefined,
        cmuxSurface: priorState.binding.cmuxSurface ?? undefined,
      });
    }
    // Restore prior session statuses
    // Each in its own try, so one failed write does not strand the sessions after it; the faults are reported together.
    const failures: string[] = [];
    for (const sess of priorState.sessions) {
      try {
        this.sessionRegistry.updateStatus(sess.id, sess.status);
      } catch (err) {
        failures.push(`session ${sess.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (failures.length > 0) throw new Error(`could not restore prior session status (${failures.join("; ")})`);
  }

  private computeRestorePlan(data: SnapshotData): PlanEntry[] {
    const nodes = resolveSnapshotRestoreTopology(data).intendedNodes;
    const edges = data.edges;

    // Build adjacency for launch-dependency edges only
    // For delegates_to: source must launch before target
    // For spawned_by: target must launch before source
    const nodeIds = nodes.map((n) => n.id);
    const inDegree: Record<string, number> = {};
    const adjacency: Record<string, string[]> = {};

    for (const id of nodeIds) {
      inDegree[id] = 0;
      adjacency[id] = [];
    }

    for (const edge of edges) {
      if (!LAUNCH_DEPENDENCY_KINDS.has(edge.kind)) continue;

      let from: string;
      let to: string;

      if (edge.kind === "delegates_to") {
        from = edge.sourceId;
        to = edge.targetId;
      } else {
        // spawned_by: target (parent) must launch before source (child)
        from = edge.targetId;
        to = edge.sourceId;
      }

      if (adjacency[from] && inDegree[to] !== undefined) {
        adjacency[from]!.push(to);
        inDegree[to] = (inDegree[to] ?? 0) + 1;
      }
    }

    // Topological sort with alphabetical tiebreaker by logical_id
    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    const queue = nodeIds
      .filter((id) => (inDegree[id] ?? 0) === 0)
      .sort((a, b) => {
        const na = nodeById.get(a)!.logicalId;
        const nb = nodeById.get(b)!.logicalId;
        return na.localeCompare(nb);
      });

    const order: string[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      order.push(current);

      const neighbors = (adjacency[current] ?? []).slice().sort((a, b) => {
        const na = nodeById.get(a)!.logicalId;
        const nb = nodeById.get(b)!.logicalId;
        return na.localeCompare(nb);
      });

      for (const neighbor of neighbors) {
        inDegree[neighbor] = (inDegree[neighbor] ?? 1) - 1;
        if ((inDegree[neighbor] ?? 0) === 0) {
          // Insert in sorted position
          const logicalId = nodeById.get(neighbor)!.logicalId;
          let inserted = false;
          for (let i = 0; i < queue.length; i++) {
            if (nodeById.get(queue[i]!)!.logicalId.localeCompare(logicalId) > 0) {
              queue.splice(i, 0, neighbor);
              inserted = true;
              break;
            }
          }
          if (!inserted) queue.push(neighbor);
        }
      }
    }

    return order.map((id) => ({
      node: nodeById.get(id)!,
    }));
  }

  /**
   * Restore one planned seat, checking continuity before launching its occupant.
   * Preserve prior state so a failed launch or resume can be compensated.
   */
  private async restoreNodeWithCompensation(
    entry: PlanEntry,
    rigId: string,
    snapshotId: string,
    data: SnapshotData,
    opts?: RestoreSeatOpts,
    warnings?: string[],
  ): Promise<RestoreNodeResult> {
    // One seat's THROWN error (a launcher, adapter, filesystem or database fault, as opposed to a failed launch RESULT)
    // is that seat's failure, not the attempt's: it must not skip the seats after it or the restore.completed /
    // restore.subset_completed event that closes the attempt.
    const progress: SeatRestoreProgress = { launchReturned: false };
    try {
      return await this.restoreNodeUnisolated(entry, rigId, snapshotId, data, opts, warnings, progress);
    } catch (err) {
      const errors = [err instanceof Error ? err.message : String(err)];
      console.error(`[restore] ${entry.node.logicalId}: restore threw and was isolated to this seat:`, err instanceof Error ? (err.stack ?? err.message) : err);
      // Whether a launch HAPPENED is decided from evidence, not from whether launchNode returned: it commits the session
      // and binding and then makes more calls before it returns, so a throw in that tail has launched a seat whose
      // return value never arrived. A session row for this node that did not exist before clearStaleState is the proof.
      //
      // Unreadable evidence (OF-27 N8): if launchNode HAS returned the answer is already known and the read is not
      // needed. If it has not returned and the evidence cannot be read, the seat is compensated. The throw is then
      // almost certainly before the launcher committed (the commit-to-return tail is short), where skipping the
      // rollback would strand a seat with its binding cleared and its sessions superseded; the opposite fault, a
      // post-commit tail throw AND a failed read, would put the stale binding back over the live one. Only the first
      // is likely, so compensation is the less destructive fallback.
      //
      // Known residual (OF-27, concurrent writer): the check counts ANY new session row for this node, so a row some
      // other actor registers for the same node during the launcher's window (reconciler, claim, discovery) is read as
      // "launched" and skips the rollback of a pre-commit throw. The seat is then left cleared with the error saying a
      // session was left in place; no live state is overwritten, and a re-restore recovers it. A guard that also
      // required the node's binding to name the new row's session would tighten this, but a false negative there
      // compensates over a real launch, the destructive direction, so the cheap guard was declined.
      let launchedSessionLeft = progress.launchReturned && !progress.launchResultFailed;
      if (!progress.launchReturned && progress.nodeId && progress.knownSessionIds) {
        try {
          const nodeId = progress.nodeId;
          launchedSessionLeft = this.sessionRegistry.getSessionsForRig(rigId)
            .some((session) => session.nodeId === nodeId && !progress.knownSessionIds!.has(session.id));
        } catch {
          // Cannot tell: fall back to the launch-did-not-return reading and compensate.
        }
      }
      if (progress.launchResultFailed) {
        // The launcher returned a failed result, so nothing was launched, and the body already tried to put the prior
        // state back; that attempt is what threw. Do not try again and do not claim a session was left.
        errors.push("the launch had failed, so no session was launched, and rolling back the failed launch threw: the seat's prior state may not be fully restored");
      } else       if (launchedSessionLeft) {
        // The launched session is the current state; as for any post-launch failure it is not rolled back.
        errors.push("the launched session was left in place (not rolled back)");
      } else if (progress.priorState && progress.nodeId) {
        // Nothing was launched: the seat's binding was cleared and its sessions superseded. Compensate exactly as a
        // failed launch result does.
        try {
          this.restoreNodeState(progress.nodeId, progress.priorState);
        } catch (compensationErr) {
          errors.push(`compensation also failed: ${compensationErr instanceof Error ? compensationErr.message : String(compensationErr)}`);
        }
      }
      return {
        nodeId: progress.nodeId ?? entry.node.id,
        logicalId: entry.node.logicalId,
        status: "failed",
        error: errors.join("; "),
      };
    }
  }

  /** OF-32: what pre-restore validation checks for a seat this restore starts fresh, read as restoreNodeUnisolated
   *  will act (see validatePreRestore's `freshSeatStartup`). */
  private freshSeatStartupToValidate(rigId: string, logicalId: string, opts: RestoreSeatOpts | undefined, selectedCopy: NodeStartupSnapshot | null): FreshSeatStartupOverride {
    // Shared with restore-check (startupToValidateForSeat), so the check validates what restore validates.
    return startupToValidateForSeat({ db: this.db, rigRepo: this.rigRepo }, {
      rigId, logicalId, adapters: opts?.adapters, freshLogicalIds: opts?.freshLogicalIds, startupFrom: opts?.startupFrom, selectedCopy,
    });
  }

  /** The fresh-start command a stop-for-decision message names for this seat (see `freshSeatLaunchCommand`). */
  private freshStartCommand(rigId: string, data: SnapshotData, logicalId: string, startupFrom?: StartupFrom): string {
    return freshSeatLaunchCommand(logicalId, this.rigRepo.getRig(rigId)?.rig.name ?? data.rig.name, this.adviceStartupFrom(rigId, logicalId, startupFrom));
  }

  /** Re-check G1 (5ffd9b97): the restore's `--startup-from` as advice for THIS seat. `snapshot:<id>` was named for the
   *  listed seats; it is repeated for a seat only when that snapshot holds a copy this seat can use (the check its
   *  launch runs, readSnapshotStartupCopy); otherwise the advice names the default (the rig's spec as it is now). */
  private adviceStartupFrom(rigId: string, logicalId: string, startupFrom?: StartupFrom): StartupFrom | undefined {
    const snapshotId = startupFromSnapshotId(startupFrom);
    if (!snapshotId) return startupFrom;
    const live = this.rigRepo.getRig(rigId)?.nodes.find((node) => node.logicalId === logicalId);
    return readSnapshotStartupCopy(this.db, { rigId, logicalId, runtime: live?.runtime ?? null, cwd: live?.cwd ?? "." }, snapshotId).ok ? startupFrom : undefined;
  }

  private async restoreNodeUnisolated(
    entry: PlanEntry,
    rigId: string,
    snapshotId: string,
    data: SnapshotData,
    opts: RestoreSeatOpts | undefined,
    warnings: string[] | undefined,
    progress: SeatRestoreProgress,
  ): Promise<RestoreNodeResult> {
    // Compare against the live logical target without changing saved post-launch inputs.
    //
    // Two ids name a seat here and they are not interchangeable. `node.id` is the SNAPSHOT's node id: it keys only the
    // snapshot's own records (its sessions, checkpoints and startup context). `nodeId` is the LIVE seat's id, found by
    // logical id in this rig, and it keys every write to the database: a seat that was removed and grown back keeps its
    // logical id but has a new node id, and a write keyed by the old one violates the foreign key to `nodes`.
    const node = entry.node;
    const liveNode = this.rigRepo.getRig(rigId)?.nodes.find(current => current.logicalId === node.logicalId);
    if (!liveNode) {
      // Removed since the snapshot and not grown back. Restore does not recreate a node (the launcher reports the same
      // "not found in rig" for it); it reports this seat failed, before anything is started or written, and goes on.
      return {
        nodeId: node.id,
        logicalId: node.logicalId,
        status: "failed",
        error: `Node ${node.logicalId} not found in rig: it was removed after this snapshot and has not been added back, so there is no seat to restore it into. Restore does not recreate removed nodes.`,
      };
    }
    const nodeId = liveNode.id;
    progress.nodeId = nodeId;

    // OPR.0.5.7.1 (bought ordering blocker, baton 0efd154d): D1 present-map
    // ambiguity must be DETECTED before any continuity_state short-circuit —
    // a pod node in 'restoring' otherwise returns a silent status "fresh"
    // (classified running downstream) while the occupant truth is ambiguous,
    // bypassing A1's loud-failure semantics. Resolved/none/legacy states
    // fall through to absent-history classification and the continuity check.
    const occupantResolution = resolveActiveSnapshotSession(data, node.id);
    if (occupantResolution.kind === "ambiguous") {
      return {
        nodeId,
        logicalId: node.logicalId,
        status: "failed",
        error: activeOccupantAmbiguityError(occupantResolution.candidateIds, occupantResolution.detail),
      };
    }

    const freshRequested = opts?.freshLogicalIds?.includes(node.logicalId) ?? false;
    const runtimeError = restoreRuntimeCompatibilityError(liveNode.runtime,
      data.nodeStartupContext?.[node.id]?.runtime);
    if (runtimeError) {
      return { nodeId, logicalId: node.logicalId, status: "awaiting-decision", error: runtimeError };
    }

    // Classify absent-seat history before the continuity short-circuit: a
    // restoring seat must not report fresh while its forecast awaits a decision.
    const priorWithToken = occupantResolution.kind === "none" && !freshRequested
      ? absentSeatResumeHistory(data.sessions, node.id)
      : null;
    if (priorWithToken) {
      return { nodeId, logicalId: node.logicalId, status: "awaiting-decision", error: absentSeatResumeHistoryError(node.logicalId, priorWithToken.resumeType, this.rigRepo.getRig(rigId)?.rig.name ?? data.rig.name, this.adviceStartupFrom(rigId, node.logicalId, opts?.startupFrom)) };
    }

    // Consult live continuity state BEFORE clearing stale state
    if (liveNode.podId) {
      const continuityRow = this.db.prepare(
        "SELECT status FROM continuity_state WHERE pod_id = ? AND node_id = ?"
      ).get(liveNode.podId, nodeId) as { status: string } | undefined;
      if (continuityRow) {
        if (continuityRow.status === "restoring") {
          warnings?.push(`Node ${node.logicalId}: continuity state is 'restoring', skipping`);
          return { nodeId, logicalId: node.logicalId, status: "fresh" };
        }
        if (continuityRow.status === "degraded") {
          warnings?.push(`Node ${node.logicalId}: continuity state is 'degraded', proceeding with caution`);
        }
      }
    }

    // OPR.0.3.4.2 (A) + OPR.0.4.3.20 FR-7 — PRE-LAUNCH stop-and-ask classification,
    // BEFORE clearStaleState / launchNode, so `awaiting-decision` means ZERO session
    // started and prior state is untouched.
    //
    // FR-7 (Gap 1): a `resume_if_possible` seat that HAD a session (a snapshot
    // session row exists) but has NO usable token stops here — whether or not a
    // resume SOURCE was recorded. The old scope required a recorded source, so a
    // crashed seat with a session row but no captured token silently fresh-primed
    // (identity-replaced while looking healthy). A node with NO session row at all
    // never ran / has nothing to resume → it legitimately fresh-primes (falls
    // through). The ONLY default fresh-prime is now: no prior session, a genuinely
    // non-resume policy (relaunch_fresh / checkpoint_only), or explicit `--fresh`.
    {
      // OPR.0.5.7.1 D1 — the active occupant was RESOLVED once at the top of
      // this function (before the continuity consult); ambiguity already
      // returned there, so only resolved/none reach here.
      const snapSession = occupantResolution.kind === "resolved" ? occupantResolution.session : null;
      const policy = snapSession?.restorePolicy ?? "resume_if_possible";
      const resumeSourceRecorded = !!snapSession?.resumeType && snapSession.resumeType !== "none";
      if (policy === "resume_if_possible" && snapSession && !snapSession.resumeToken && !freshRequested) {
        const sourceNote = resumeSourceRecorded
          ? `resume source '${snapSession?.resumeType}' recorded but no token available`
          : `no resume token was captured for this seat`;
        return {
          nodeId,
          logicalId: node.logicalId,
          status: "awaiting-decision",
          error: `Original session unresumable: ${sourceNote}. No session was started. To start only this seat fresh, run: ${this.freshStartCommand(rigId, data, node.logicalId, opts?.startupFrom)}; or restore the original session manually.`,
        };
      }
    }

    // Capture prior state for compensation
    const priorState = this.captureNodeState(nodeId, rigId);
    progress.priorState = priorState;
    // Every session row the seat has now, superseded and exited included: a row outside this set is one the launch made.
    progress.knownSessionIds = new Set(this.sessionRegistry.getSessionsForRig(rigId).filter((s) => s.nodeId === nodeId).map((s) => s.id));

    // Clear stale state so NodeLauncher doesn't see already_bound
    this.clearStaleState(nodeId, rigId);
    this.tmuxAdapter.deliveryGuard?.rebindLifecycle(nodeId);

    // Derive canonical session name for pod-aware nodes
    const rig = this.rigRepo.getRig(rigId);
    let launchOpts: { sessionName?: string; cwd?: string } | undefined = node.cwd
      ? { cwd: node.cwd }
      : undefined;
    let expectedSessionName: string | undefined;

    // OPR.0.4.3.20 FR-5 — pin the resume target to the DURABLY-BOUND session.
    // priorState.binding was captured (above) BEFORE clearStaleState deleted the
    // binding row, so it is the ONLY surviving copy of the name the seat was
    // ACTUALLY bound to. Pinning it means a rename/reshape between the binding
    // and the crash does not silently retarget resume to a re-derived
    // (wrong/nonexistent) pane — the Class-1 fragility. Setting
    // launchOpts.sessionName (not just expectedSessionName) is required:
    // otherwise the launcher re-derives (node-launcher.ts) and writes the
    // derived name back to the binding, defeating the pin. Selection-only — no
    // identity re-key, no schema/derive-helper change. Fallback to the existing
    // derive (below) is observable, never a silent divergence.
    const pinnedTarget = priorState.binding?.tmuxSession ?? null;
    let pinnedTargetUsed = false;
    if (pinnedTarget) {
      const { validateSessionName } = await import("./session-name.js");
      if (validateSessionName(pinnedTarget)) {
        expectedSessionName = pinnedTarget;
        launchOpts = { ...launchOpts, sessionName: expectedSessionName };
        pinnedTargetUsed = true;
      } else {
        // Binding present but the bound name is malformed → observable fallback.
        warnings?.push(`FR-5: durably-bound session name "${pinnedTarget}" for ${node.logicalId} is invalid; falling back to a derived name.`);
      }
    } else {
      // No durably-bound session name (old data / null binding or empty
      // tmux_session) → observable derived-name fallback (PRD back-compat AC).
      warnings?.push(`FR-5: no durably-bound session name for ${node.logicalId}; falling back to a derived session name.`);
    }

    // Derived-name FALLBACK — only when no usable pin. The existing derive,
    // unchanged (pod-aware then legacy); preserves back-compat for partial-data rigs.
    if (!pinnedTargetUsed) {
      if (node.podId && rig) {
        // Pod-aware: derive {pod}-{member}@{rigName} from node identity
        const parts = node.logicalId.split(".");
        if (parts.length >= 2) {
          const podPart = parts[0]!;
          const memberPart = parts.slice(1).join(".");
          const { deriveCanonicalSessionName, deriveSessionName } = await import("./session-name.js");
          expectedSessionName = deriveCanonicalSessionName(podPart, memberPart, rig.rig.name);
          launchOpts = { ...launchOpts, sessionName: expectedSessionName };
        }
      }
      if (!expectedSessionName && rig) {
        const { deriveSessionName } = await import("./session-name.js");
        expectedSessionName = deriveSessionName(rig.rig.name, node.logicalId);
      }
    }

    // OF-32: a seat this restore starts fresh (anything but an exact resume) takes its startup policy from the same
    // decision `rig seat launch --fresh` makes: the rig's spec as it is now, or with `--startup-from stored` the
    // context saved by the seat's last successful launch. It never replays the snapshot's copy while the seat has a
    // saved context of its own, because the snapshot can be older than that context. Decided before the launch, so a
    // refusal starts nothing. Without an adapter for the seat's runtime nothing is replayed or saved either way, and
    // the post-launch checks say so; the decision is skipped.
    let freshStartup: FreshStartupContext | null = null;
    // A seat started fresh without being listed with --fresh: its own saved context, replayed as a snapshot copy was.
    let savedSetup: NodeStartupSnapshot | null = null;
    // What the restore result (and so restore.completed and `rig up`) says this seat was given, once it is launched.
    let startupReport: RestoreStartupSource | null = null;
    const seatRuntime = liveNode.runtime ?? null;
    const startsFresh = !snapshotSeatResumes(occupantResolution.kind === "resolved" ? occupantResolution.session : null, freshRequested)
      && !!seatRuntime && !!opts?.adapters?.[seatRuntime];
    if (startsFresh && !freshRequested) {
      // OF-32, Jim's scope (2026-10-20): only a seat the operator lists with --fresh re-reads the spec. Every other seat
      // this restore starts fresh (by restore policy, with no history, a checkpoint rebuild) comes back on its saved
      // setup exactly as before stage 3: no re-read, no per-seat refusal, the same lenient replay and the same
      // pre-restore validation. The one difference is the snapshot-hazard fix: the saved setup is the seat's own saved
      // context, not an older snapshot's copy of it. When it has none, the snapshot's copy is replayed. OF-36: when it
      // cannot be used (not JSON, the wrong shape, another runtime), or it has none and this snapshot's copy cannot be
      // used, the newest usable snapshot copy is replayed; when no snapshot holds one, nothing is started for the seat.
      // The same decision as pre-restore validation (startupToValidateForSeat), which refuses a whole restore() first;
      // a `rig launch` target has no pre-restore validation, so this is where it is refused.
      // Review F4: a copy pre-restore validation chose is replayed exactly; if its snapshot is gone the seat is refused.
      const carried = opts?.preValidatedCopies?.get(node.logicalId);
      if (carried && !this.db.prepare("SELECT 1 FROM snapshots WHERE id = ?").get(carried.snapshotId)) {
        this.restoreNodeState(nodeId, priorState);
        // Re-check G3: the pre-validation warning said this seat replays that copy; it does not.
        const said = carried.warning ? warnings?.indexOf(carried.warning) ?? -1 : -1;
        if (said >= 0) warnings!.splice(said, 1);
        const rigName = rig?.rig.name ?? data.rig.name;
        const now = newestUsableSnapshotCopy(this.db, rigId, node.logicalId, seatRuntime);
        const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
        const next = now
          ? `To start it from the newest snapshot copy that can be used now (snapshot ${now.snapshotId}, ${now.kind}, taken ${now.createdAt}): rig seat launch ${quote(`${node.logicalId}@${rigName}`)} --fresh --startup-from snapshot:${now.snapshotId} --reason "<why>".`
          : noUsableCopyRemedy({ scope: "seat", rigName, logicalId: node.logicalId, specRecorded: !!this.rigRepo.getRigSpecSource(rigId), ownRow: this.db.prepare("SELECT 1 FROM node_startup_context WHERE node_id = ?").get(nodeId) !== undefined });
        return { nodeId, logicalId: node.logicalId, status: "failed", error: `Fresh start refused: ${node.logicalId}: snapshot ${carried.snapshotId}, whose copy of its startup files this restore checked before it started, was removed before the seat's launch, so restore does not choose another copy unchecked. ${next} No session was started.` };
      }
      const pick: SeatStartupForRestore = carried
        ? { kind: "fallback", context: carried.context, from: { snapshotId: carried.snapshotId, kind: "", createdAt: "", context: carried.context }, why: "", warning: "" }
        : seatStartupForRestore(this.db, { rigId, nodeId, logicalId: node.logicalId, runtime: seatRuntime }, data.nodeStartupContext?.[node.id] ?? null);
      if (pick.kind === "none_usable") {
        this.restoreNodeState(nodeId, priorState);
        const remedy = noUsableCopyRemedy({ scope: "seat", rigName: rig?.rig.name ?? data.rig.name, logicalId: node.logicalId, specRecorded: !!this.rigRepo.getRigSpecSource(rigId), ownRow: pick.ownRow });
        return { nodeId, logicalId: node.logicalId, status: "failed", error: `Fresh start refused: ${noUsableCopyMessage(node.logicalId, pick.why)} ${remedy} No session was started.` };
      }
      savedSetup = pick.context;
      if (pick.kind === "own") {
        startupReport = { kind: "stored", reason: "not_fresh_listed" };
      } else if (pick.kind === "fallback") {
        startupReport = { kind: "snapshot", reason: "saved_context_unreadable", ...(pick.from.snapshotId !== snapshotId ? { snapshotId: pick.from.snapshotId } : {}) };
        // Pre-restore validation may already have reported it (always, for a carried copy).
        if (pick.warning && !warnings?.includes(pick.warning)) warnings?.push(pick.warning);
      } else if (pick.context) {
        startupReport = { kind: "snapshot", reason: "no_saved_context" };
      }
    }
    if (startsFresh && freshRequested && opts?.adapters) {
      const rigName = rig?.rig.name ?? data.rig.name;
      // The decision itself (source, snapshot-copy fallback, refusal text) is shared with restore-check and the plan,
      // which ask the same function what this restore would refuse (fresh-seat-restore-decision.ts).
      const { decided, chosen, refusal: decidedRefusal, warnings: findingWarnings, copyFromSnapshotId } = await decideListedFreshSeat(
        { db: this.db, rigRepo: this.rigRepo, specReader: this.seatStartupSource, runtimeAdapters: opts.adapters },
        {
          rigId, nodeId, logicalId: node.logicalId, rigName, runtime: seatRuntime, cwd: node.cwd ?? ".",
          sessionName: expectedSessionName ?? node.logicalId, startupFrom: opts.startupFrom ?? "spec",
          snapshotCopy: data.nodeStartupContext?.[node.id] ?? null, exists: opts.fsOps?.exists ?? (() => true),
        },
      );
      // Pre-restore validation may already have reported the same warning for the snapshot's copy.
      for (const warning of findingWarnings) if (!warnings?.includes(warning)) warnings?.push(warning);
      let refusal = decidedRefusal;
      // OF-32 N6: a seat that re-read its spec gets that release's skills as first launch does, just before its launch.
      const skills = decided.ok && !refusal ? projectRereadSkills(this.seatStartupSource, decided.context) : { ok: true as const };
      if (!skills.ok) refusal = skills.message;
      if (refusal) {
        this.restoreNodeState(nodeId, priorState);
        return { nodeId, logicalId: node.logicalId, status: "failed", error: `Fresh start refused: ${refusal} No session was started.` };
      }
      if (decided.ok) {
        freshStartup = decided.context;
        for (const warning of decided.context.sourceWarnings) warnings?.push(`Restore: ${node.logicalId}: ${warning}`);
        const source = decided.context.source;
        if (source.kind === "spec") {
          const previous = this.db.prepare("SELECT resolved_spec_version AS version FROM nodes WHERE id = ?").get(nodeId) as { version: string | null } | undefined;
          startupReport = {
            kind: "spec", specSource: source.specSource, specPath: source.specPath,
            previousSpecVersion: previous?.version ?? null, specVersion: decided.context.resolvedSpec?.version ?? "",
          };
        } else if (source.kind === "snapshot") {
          startupReport = { kind: "snapshot", reason: "requested", snapshotId: source.snapshotId };
        } else {
          startupReport = { kind: "stored", reason: source.reason };
        }
      } else if (chosen) {
        // A snapshot's copy, chosen before the launch (OF-36: not necessarily this snapshot's), is what is replayed.
        savedSetup = chosen;
        // The decision's warnings (pushed above) name the snapshot whose copy is replayed when it is not this one.
        startupReport = {
          kind: "snapshot", reason: decided.code === "startup_context_malformed" ? "saved_context_unreadable" : "no_saved_context",
          ...(copyFromSnapshotId && copyFromSnapshotId !== snapshotId ? { snapshotId: copyFromSnapshotId } : {}),
        };
      }
    }

    // Write transcript boundary marker BEFORE launch (before pipe-pane attaches)
    // so the marker appears before any post-restore terminal output.
    // Uses "restore attempt" language — honest even if launch subsequently fails.
    if (this.transcriptStore?.enabled && rig && expectedSessionName) {
      const markerOk = this.transcriptStore.writeBoundaryMarker(
        rig.rig.name,
        expectedSessionName,
        `restore attempt from snapshot ${snapshotId}`,
      );
      if (!markerOk) {
        warnings?.push(`Transcript boundary marker failed for ${expectedSessionName}`);
      }
    }

    // Attempt launch — compensate ONLY if launch itself fails
    const launchResult = await this.nodeLauncher.launchNode(rigId, node.logicalId, freshRequested ? { ...launchOpts, freshStart: true } : launchOpts);
    progress.launchReturned = true;
    if (!launchResult.ok) {
      progress.launchResultFailed = true;
      // Launch failed — restore prior state (compensating action)
      this.restoreNodeState(nodeId, priorState);
      return {
        nodeId,
        logicalId: node.logicalId,
        status: "failed",
        error: launchResult.message,
      };
    }

    // Launch succeeded — do NOT compensate on post-launch failures
    // (the new session/binding are now the current state)

    // Propagate launch warnings (includes transcript attach failures)
    if (launchResult.warnings?.length) {
      warnings?.push(...launchResult.warnings);
    }

    const given = freshStartup ? asReplayContext(freshStartup) : savedSetup;
    const restored = await this.postLaunchRestore(entry, nodeId, rigId, data, launchResult.sessionName, launchResult, opts, warnings, priorState,
      given ? { replay: given, ...(freshStartup?.resolvedSpec ? { provenance: freshStartup.resolvedSpec } : {}) } : null);
    // OF-32: name the source on the seat's result, as `rig seat launch --fresh` does on its own.
    const announced = startupReport ? { ...restored, startupSource: startupReport } : restored;
    return this.checkRestoredGuidance(announced, entry.node, rigId, data, warnings, given ?? undefined);
  }

  /** A seat that came back running should also have its role, culture and SOP guidance. If its
   *  guidance file still lacks a managed block it should hold, the seat keeps its true status (a
   *  live resumed session is still running) and the gap is disclosed on the node and in the
   *  warnings, so the rig is reported partially_restored, not fully_restored. */
  private checkRestoredGuidance(
    result: RestoreNodeResult,
    node: SnapshotData["nodes"][number],
    rigId: string,
    data: SnapshotData,
    warnings?: string[],
    /** OF-32: the startup policy a fresh seat was actually given, when it was not the snapshot's copy. */
    startupGiven?: NodeStartupSnapshot,
  ): RestoreNodeResult {
    // Every status with a live session; attention_required keeps its status and gains the disclosure.
    if (!["resumed", "fresh-primed", "fresh", "rebuilt", "attention_required"].includes(result.status)) return result;
    let guidance: ReturnType<typeof seatGuidance>;
    try {
      guidance = seatGuidance(startupGiven ?? data.nodeStartupContext?.[node.id] ?? null, node.cwd,
        this.rigRepo.getRigClaudeManagedBlockFile(rigId), existsSync, (path) => readFileSync(path, "utf-8"));
    } catch (err) {
      warnings?.push(`Restore: ${node.logicalId}: could not check its guidance: ${(err as Error).message}`);
      return { ...result, guidanceGaps: ["(guidance check failed)"] };
    }
    if (!guidance || guidance.items.length === 0) return result;
    let missing: string[];
    try {
      missing = missingGuidanceBlocks(guidance, { exists: existsSync, readFile: (path) => readFileSync(path, "utf-8") });
    } catch (err) {
      missing = [`(could not read ${guidance.targetPath}: ${(err as Error).message})`];
    }
    if (missing.length === 0) return result;
    const gap = `${node.logicalId} is running without part of its guidance: ${guidance.targetPath} lacks the OpenRig blocks ${missing.join(", ")}.`;
    warnings?.push(`Restore: ${gap}`);
    return { ...result, guidanceGaps: missing };
  }

  /** OPR.0.3.4.2 (B) — roll a just-launched session back to ZERO sessions for
   *  the awaiting-decision outcome: kill the live blank session, mark its row
   *  superseded, and restore the prior binding/session state (the existing
   *  launch-failure compensating action). The caller fires this ONLY on a
   *  POSITIVE determination the session is fresh/blank — never for
   *  unknown-but-possibly-valid continuity. */
  private async rollbackToZeroSession(
    nodeId: string,
    sessionName: string,
    launchedSessionId: string | undefined,
    priorState: { binding: import("./types.js").Binding | null; sessions: { id: string; status: string }[] } | undefined,
  ): Promise<void> {
    try {
      await this.tmuxAdapter.killSession(sessionName);
    } catch { /* best-effort — the row + projection rollback below is the source of truth */ }
    if (launchedSessionId) {
      try { this.sessionRegistry.updateStatus(launchedSessionId, "superseded"); } catch { /* best-effort */ }
    }
    if (priorState) {
      this.restoreNodeState(nodeId, priorState);
    }
  }

  private async postLaunchRestore(
    entry: PlanEntry,
    liveNodeId: string,
    rigId: string,
    data: SnapshotData,
    sessionName: string,
    launchResult?: { ok: true; sessionName: string; session: import("./types.js").Session; binding: import("./types.js").Binding },
    opts?: RestoreSeatOpts,
    warnings?: string[],
    priorState?: { binding: import("./types.js").Binding | null; sessions: { id: string; status: string }[] },
    /** OF-32: the startup policy chosen before launch for a seat started fresh (null: replay the snapshot's copy). */
    fresh: { replay: NodeStartupSnapshot; provenance?: { name: string; version: string; hash: string } } | null = null,
  ): Promise<RestoreNodeResult> {
    // `node` carries the LIVE seat's id: every database write below is keyed by `node.id`. The snapshot's own records
    // (sessions, checkpoints, startup context) are keyed by `snapshotNodeId`. They differ when the seat was removed and
    // grown back, and a write keyed by the vanished snapshot id fails the foreign key to `nodes`.
    const snapshotNodeId = entry.node.id;
    const node = { ...entry.node, id: liveNodeId };
    // OPR.0.7.0.7: what this restore launches with when the seat has a saved effort choice is decided by the one
    // precedence seam (latest wins), which also says so when the snapshot held another value.
    let restoreEffort: { effort: string | null } | undefined;
    const effortForRestore = (): string | null => {
      if (!restoreEffort) {
        // The live seat (found by its logical id in this rig by the caller): a seat removed and grown back has a new
        // node id, and its latest saved choice still wins over the older snapshot.
        const decided = effortPrecedence.restoreLaunchEffort({ snapshot: entry.node, live: readSeatEffort(this.db, node.id) });
        if (decided.warning) warnings?.push(`Restore: ${node.logicalId}: ${decided.warning}`);
        restoreEffort = decided;
      }
      return restoreEffort.effort;
    };
    // OPR.0.5.7.1 D1 — the active occupant is RESOLVED, never inferred from
    // row ordering (cite site 2 of 2; "latest = max id" was the incident's
    // defect: a superseded row with a newer ULID defeated the real occupant).
    const sessionResolution = resolveActiveSnapshotSession(data, snapshotNodeId);
    if (sessionResolution.kind === "ambiguous") {
      return {
        nodeId: node.id,
        logicalId: node.logicalId,
        status: "failed",
        error: activeOccupantAmbiguityError(sessionResolution.candidateIds, sessionResolution.detail),
      };
    }
    const session = sessionResolution.kind === "resolved" ? sessionResolution.session : null;
    const checkpoint = data.checkpoints[snapshotNodeId] ?? null;

    // Check restore policy. OPR.0.3.4.2: a --fresh-listed seat (operation B)
    // deliberately skips the resume attempt; its launch reports `fresh-primed`.
    const resumeType = session?.resumeType ?? null;
    const resumeToken = session?.resumeToken ?? null;
    const freshRequested = opts?.freshLogicalIds?.includes(node.logicalId) ?? false;
    // `&& !!resumeType` is implied by the predicate; it is spelled out so the type checker narrows resumeType below.
    const resumeRequested = snapshotSeatResumes(session, freshRequested) && !!resumeType;

    // OPR.0.3.4.2 — non-resume launches are DELIBERATE blank-slate launches
    // (policy- or --fresh-driven): named `fresh-primed`, the old conflated
    // `fresh` no longer flows from this pipeline.
    let baseStatus: RestoreNodeResult["status"] = "fresh-primed";

    // Pod-aware nodes: resume via launchHarness (handled in startup orchestrator with skipHarnessLaunch: false)
    // Legacy nodes: resume via old claude-resume/codex-resume helpers
    const isPodAware = !!node.podId;

    const startupCtx = data.nodeStartupContext?.[snapshotNodeId] ?? null;
    // OF-36: `rig down` copies a seat's saved context verbatim, so this copy can be any JSON. What a fresh seat replays was
    // chosen before its launch (a usable copy, or a refusal), and a resume's contained replay reads only its runtime. The
    // resume steps below read the copy's projection list as they always did (leniently: only its activity-hook entry is
    // used); a list that is not a list, or a member that is not an object, is not dereferenced.
    const projection = startupCtx ? (startupCtx as { projectionEntries?: unknown }).projectionEntries : undefined;
    const resumeCtx = startupCtx && Array.isArray(projection)
      ? { ...startupCtx, projectionEntries: projection.filter((entry) => !!entry && typeof entry === "object" && !Array.isArray(entry)) }
      : null;
    if (startupCtx && !resumeCtx && resumeRequested) {
      warnings?.push(`Restore: ${node.logicalId}: this snapshot's copy of its startup context has no list of projection entries, so this resume takes nothing from it (no saved activity hooks or missing guidance blocks are put back).`);
    }
    // Restore only the saved activity selection before either native resume path.
    // This also heals settings stripped by older restores. The entry is a marker:
    // the adapter uses its current relay/manifest, not the old install's path.
    // No current profile resolution, guidance, skills or startup replay belongs here.
    const activityAdapter = opts?.adapters?.["claude-code"];
    if (resumeRequested && resumeToken && launchResult && resumeCtx?.runtime === "claude-code" && activityAdapter) {
      const entries = resumeCtx.projectionEntries.filter(e =>
        e.category === "runtime_resource" && e.resourceType === "claude_activity_hooks");
      if (entries.length > 0) try {
        const result = await activityAdapter.project({
          runtime: "claude-code", cwd: node.cwd ?? ".",
          entries: entries.map(e => ({ ...e, category: "runtime_resource" as const, classification: "safe_projection" as const,
            mergeStrategy: e.mergeStrategy as import("./projection-planner.js").ProjectionEntry["mergeStrategy"] })),
          startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [],
        }, { ...launchResult.binding, cwd: node.cwd ?? "." });
        warnings?.push(...(result.warnings ?? []));
        for (const skipped of result.skipped) warnings?.push(`Restore activity hooks: skipped ${skipped}; saved hooks could not be reapplied.`);
        for (const failure of result.failed) warnings?.push(`Restore activity hooks: ${failure.error}`);
      } catch (error) {
        // Activity delivery remains best-effort, as on an ordinary fresh launch.
        warnings?.push(`Restore activity hooks: ${(error as Error).message}`);
      }
    }

    // A narrow exception to the replay containment below: before either native resume path
    // starts the harness, put back only the MISSING managed guidance blocks from the saved
    // startup selection. Ordinary `rig down` strips them; without this the resumed
    // seat came back with no role, culture or SOP. Existing blocks are never refreshed; nothing
    // reaches the conversation; no action, skill or plugin runs. Never blocks the resume.
    if (resumeRequested && resumeToken && launchResult) {
      let guidance: ReturnType<typeof seatGuidance> = null;
      try {
        guidance = seatGuidance(resumeCtx, node.cwd, this.rigRepo.getRigClaudeManagedBlockFile(rigId), existsSync, (path) => readFileSync(path, "utf-8"));
      } catch (err) {
        // Guidance never blocks the exact resume; the post-launch check discloses the gap.
        warnings?.push(`Restore guidance: ${node.logicalId}: could not read its saved guidance selection: ${(err as Error).message}`);
      }
      if (guidance && guidance.items.length > 0) {
        const repair = restoreMissingGuidance(guidance, {
          exists: existsSync,
          readFile: (path) => readFileSync(path, "utf-8"),
          writeFile: (path, content) => writeFileSync(path, content, "utf-8"),
          mkdirp: (path) => mkdirSync(path, { recursive: true }),
        });
        if (repair.restored.length > 0) {
          warnings?.push(`Restore guidance: ${node.logicalId}: put back missing blocks ${repair.restored.join(", ")} in ${guidance.targetPath} from their current source files.`);
        }
        for (const gap of repair.gaps) warnings?.push(`Restore guidance: ${node.logicalId}: ${gap}`);
      }
    }

    if (resumeRequested && !isPodAware) {
      // Legacy resume path
      if (!resumeToken) {
        // Defense in depth: the pre-launch classification catches this case
        // before any session exists. If it is somehow reached post-launch, the
        // just-created session is a confirmed blank (no resume was possible) —
        // roll back to zero sessions and present the decision honestly.
        await this.rollbackToZeroSession(node.id, sessionName, launchResult?.session.id, priorState);
        return { nodeId: node.id, logicalId: node.logicalId, status: "awaiting-decision", error: `Original session unresumable: resume requested but no token available. No session is running. To start only this seat fresh, run: ${this.freshStartCommand(rigId, data, node.logicalId, opts?.startupFrom)}; or restore the original session manually.` };
      } else {
        const launchedSessionId = launchResult?.session.id;
        if (launchedSessionId && this.claudeResume.canResume(resumeType, resumeToken)) {
          // Before the resume: Claude's SessionStart hook can land before attemptResume returns.
          try {
            this.sessionRegistry.recordResumeLaunch(launchedSessionId, resumeToken);
          } catch { /* best-effort: without it a rotation stays unproved, as before */ }
        }
        const resumeOutcome = await this.attemptResume(node.id, sessionName, resumeType, resumeToken, node.cwd ?? "/", node.codexConfigProfile, node.model, this.resolveRestorePosture(node.id, rigId), effortForRestore(), warnings, node.remoteControl === true);
        if (resumeOutcome.kind === "resumed") {
          baseStatus = "resumed";
          if (launchedSessionId && this.claudeResume.canResume(resumeType, resumeToken)) {
            // The process this resume started, as the launch itself observes it (#1077): the one its
            // identity check proved, else one observed now.
            try {
              const launched = resumeOutcome.launchedProcess ?? await observeClaudeResumeLaunch({ target: sessionName, tmux: this.tmuxAdapter,
                ...(this.listProcesses ? { listProcesses: this.listProcesses } : {}), token: resumeToken });
              if (launched) this.sessionRegistry.recordResumeLaunchProcess(launchedSessionId, resumeToken, launched);
            } catch { /* best-effort: without it a rotation stays unproved, as before */ }
          }
        } else if (resumeOutcome.kind === "attention_required") {
          // L3 Decision 2: Claude resume-selection prompt -> attention_required.
          // Do NOT auto-answer. Reconcile later via reconcileNodeRuntimeTruth
          // when the operator reaches a usable pane state. (Boundary: a LIVE
          // parked session is attention_required, NEVER awaiting-decision.)
          return {
            nodeId: node.id,
            logicalId: node.logicalId,
            status: "attention_required",
            error: resumeOutcome.message,
            attentionEvidence: resumeOutcome.evidence ?? null,
          };
        } else {
          // OPR.0.3.4.2 (B): resume CONCLUDED failed — the launched session is
          // a confirmed blank agent (precision guard trigger (i)). Roll back to
          // zero sessions; the stop-and-ask is realized as awaiting-decision.
          await this.rollbackToZeroSession(node.id, sessionName, launchResult?.session.id, priorState);
          return { nodeId: node.id, logicalId: node.logicalId, status: "awaiting-decision", error: `Original session unresumable: resume attempted but failed. The blank session was rolled back; no session is running. To start only this seat fresh, run: ${this.freshStartCommand(rigId, data, node.logicalId, opts?.startupFrom)}; or check the harness state manually.` };
        }
      }
    } else if (resumeRequested && isPodAware) {
      // Pod-aware restore must preserve the same honesty contract as legacy restore:
      // if resume was requested but continuity state is unavailable, stop loudly
      // instead of silently downgrading to a fresh launch with amnesia.
      if (!resumeToken) {
        // Defense in depth (pre-launch classification catches this first).
        await this.rollbackToZeroSession(node.id, sessionName, launchResult?.session.id, priorState);
        return {
          nodeId: node.id,
          logicalId: node.logicalId,
          status: "awaiting-decision",
          error: `Original session unresumable: resume requested but no token available. No session is running. To start only this seat fresh, run: ${this.freshStartCommand(rigId, data, node.logicalId, opts?.startupFrom)}; or restore the original session manually.`,
        };
      }
      // OPR.0.4.3.20 FR-7 (Gap 2b) — a pod-aware resume needs the runtime adapter
      // to verify continuity + relaunch the harness (the startup replay below is
      // gated on opts.adapters). If the adapter for this seat's runtime is absent
      // (e.g. a node-subset launch that did not thread adapters), we CANNOT resume
      // and MUST NOT silently fresh-prime — fail closed to awaiting-decision.
      // Explicit --fresh and non-resume policies stay the only fresh-prime paths.
      const resumeAdapter = node.runtime ? opts?.adapters?.[node.runtime] : undefined;
      if (!resumeAdapter) {
        await this.rollbackToZeroSession(node.id, sessionName, launchResult?.session.id, priorState);
        return {
          nodeId: node.id,
          logicalId: node.logicalId,
          status: "awaiting-decision",
          error: `Original session unresumable: resume requested but runtime continuity could not be verified (no ${node.runtime ?? "runtime"} adapter available). No session is running. To start only this seat fresh, run: ${this.freshStartCommand(rigId, data, node.logicalId, opts?.startupFrom)}; or retry restore with runtime adapters.`,
        };
      }
    }

    // Checkpoint delivery (if not already resumed)
    if (baseStatus !== "resumed" && checkpoint) {
      if (!node.cwd) {
        return { nodeId: node.id, logicalId: node.logicalId, status: "failed", error: "Checkpoint available but node has no cwd" };
      }
      const written = this.writeCheckpointFile(node.cwd, checkpoint);
      if (written) {
        baseStatus = "rebuilt";
      } else {
        return { nodeId: node.id, logicalId: node.logicalId, status: "failed", error: "Checkpoint file write failed" };
      }
    }

    // OPR.0.5.7.1 D6a — REPLAY CONTAINMENT, UNCONDITIONAL. An exact resume
    // returns to an EXISTING history: replaying startup/onboarding content
    // into it is the ghost-prompt source (the incident's live specimen:
    // managed CLAUDE.md blocks rewritten mid-"resume"). A resumed history
    // replays no startup content — the saved activity resource was reconciled
    // above before native resume. The launch leg survives untouched (the D2
    // discriminator proved an empty runtime-correct plan resumes fine).
    // There is deliberately NO replay opt-in surface here: D6b restores the
    // explicit+versioned+durable+idempotent contract in the D4 operation-id
    // phase, where its durability primitives live. Deliberate fresh-primed
    // launches are new histories and keep their replay.
    // One narrow exception: MISSING managed guidance blocks are put back before the harness
    // starts (see restoreMissingGuidance above); existing blocks are still never rewritten, and
    // nothing else is replayed.
    const replayContained = resumeRequested && !!resumeToken;
    // OF-32: what a seat started fresh is given. The snapshot's copy only when no other source was chosen before the
    // launch (no adapter, or the seat has no saved context of its own); an exact resume replays nothing from either.
    const replaySource = fresh?.replay ?? startupCtx;
    const startupRuntime = replaySource?.runtime ?? node.runtime ?? null;
    const startupAdapter = startupRuntime ? opts?.adapters?.[startupRuntime] : undefined;

    // A new pod-aware agent needs a startup context to run StartupOrchestrator.
    // Do not report a healthy fresh-primed result when that context or adapter
    // is missing; the pane would contain only a shell with no runtime process.
    if (
      isPodAware
      && launchResult
      && baseStatus !== "resumed"
      && startupRuntime !== null
      && startupRuntime !== "terminal"
      && (!replaySource || !startupAdapter)
    ) {
      const cause = replaySource ? `no ${startupRuntime} runtime adapter` : "no startup context";
      const error = `Harness not started: ${cause} for ${node.logicalId}.`;
      warnings?.push(`Restore: ${error}`);
      return { nodeId: node.id, logicalId: node.logicalId, status: "attention_required", error };
    }

    // Attempt restore-safe startup replay if context available
    if ((fresh || data.nodeStartupContext) && opts?.adapters && launchResult) {
      if (replaySource) {
        const adapter = opts.adapters[replaySource.runtime];
        if (adapter) {
          // Prefilter: check which files/entries still exist
          const existsFn = opts.fsOps?.exists ?? (() => true);
          const sourceEntries = replayContained ? [] : replaySource.projectionEntries.map((e) => reanchorShippedProjectionEntry(e, undefined, existsFn));
          // #261: recognized built-in startup files follow the running install.
          const sourceFiles = replayContained ? [] : replaySource.resolvedStartupFiles.map((f) => reanchorBuiltinStartupFile(f, undefined, undefined, existsFn));
          const sourceActions = replayContained ? [] : replaySource.startupActions;
          const filteredEntries = sourceEntries.filter((e) => {
            if (!existsFn(e.absolutePath)) {
              warnings?.push(`Restore: missing projection entry ${e.absolutePath} (skipped)`);
              return false;
            }
            return true;
          });
          const filteredFiles = sourceFiles.filter((f) => {
            if (!existsFn(f.absolutePath)) {
              if (f.required) {
                warnings?.push(`Restore: missing REQUIRED startup file ${f.absolutePath}`);
                return false; // will cause failure below
              }
              warnings?.push(`Restore: missing optional startup file ${f.absolutePath} (skipped)`);
              return false;
            }
            return true;
          });

          // Check if any required files were dropped
          const missingRequired = sourceFiles.filter((f) => f.required && !existsFn(f.absolutePath));
          if (missingRequired.length > 0) {
            return { nodeId: node.id, logicalId: node.logicalId, status: "failed", error: `Missing required startup files: ${missingRequired.map((f) => f.path).join(", ")}` };
          }

          // Build fresh projection plan (all safe_projection)
          const plan: import("./projection-planner.js").ProjectionPlan = {
            runtime: replaySource.runtime,
            cwd: node.cwd ?? ".",
            entries: filteredEntries.map((e) => ({
              ...e,
              classification: "safe_projection" as const,
              category: e.category as import("./projection-planner.js").ProjectionEntry["category"],
              mergeStrategy: e.mergeStrategy as import("./projection-planner.js").ProjectionEntry["mergeStrategy"],
            })),
            startup: { files: filteredFiles as import("./types.js").StartupFile[], actions: sourceActions },
            conflicts: [],
            noOps: [],
            diagnostics: [],
          };

          const binding = {
            ...launchResult.binding,
            cwd: node.cwd ?? ".",
            codexConfigProfile: node.codexConfigProfile ?? undefined,
            // OPR.0.4.8.3 Seam B: the pod-aware restore path binds the restored posture too
            // (both restore paths consume persisted provenance — preflight surface 3).
            launchPosture: this.resolveRestorePosture(node.id, rigId),
            // OPR.0.4.6.PI1 VM leg finding: the restore binding dropped the
            // node's model declaration, so a resumed Pi seat relaunched with
            // no --model — and the runner's provider-key allowlist (keyed off
            // the declared provider) passed nothing through ("No API key
            // found" on every resumed Pi seat). Claude/Codex silently lost
            // their -m/--model on restore the same way.
            model: node.model ?? undefined,
            effort: effortForRestore() ?? undefined,
            // The seat's persisted remote_control declaration: restore (`rig up --existing`, rig-here)
            // must start Claude Code Remote Control again, exactly as the first launch did.
            ...(node.remoteControl ? { remoteControl: true } : {}),
          };

          try {
            const { StartupOrchestrator } = await import("./startup-orchestrator.js");
            const startupOrch = new StartupOrchestrator({ db: this.db, sessionRegistry: this.sessionRegistry, eventBus: this.eventBus, tmuxAdapter: this.tmuxAdapter,
              ...(this.listProcesses ? { listProcesses: this.listProcesses } : {}) });
            const replayAsRestore = baseStatus !== "fresh-primed";
            const shouldLaunchHarness = isPodAware;
            const startupResult = await startupOrch.startNode({
              rigId,
              nodeId: node.id,
              sessionId: launchResult.session.id,
              binding: binding as import("./runtime-adapter.js").NodeBinding,
              adapter,
              plan,
              resolvedStartupFiles: filteredFiles,
              startupActions: sourceActions,
              isRestore: replayAsRestore,
              preserveStartupContext: replayContained,
              skipHarnessLaunch: !shouldLaunchHarness,
              resumeToken: (isPodAware && resumeRequested) ? resumeToken ?? undefined : undefined,
              resumeType: (isPodAware && resumeRequested) ? resumeType ?? undefined : undefined,
              sessionName: sessionName,
              allowFreshFallback: !(isPodAware && resumeRequested),
              // OF-32: a seat started fresh saves what it was given only once it has an occupant (below), as
              // `rig seat launch --fresh` does, so a failed restore launch leaves the seat's saved context as it was.
              deferStartupContextWrite: !replayContained,
            });
            warnings?.push(...(startupResult.warnings ?? []));
            if (!replayContained && (startupResult.ok || startupResult.startupStatus === "attention_required")) {
              try {
                writeStartupContext(this.db, {
                  nodeId: node.id, entries: plan.entries, resolvedStartupFiles: filteredFiles, startupActions: sourceActions,
                  runtime: adapter.runtime, ...(fresh?.provenance ? { provenance: fresh.provenance } : {}),
                });
              } catch (error) {
                return { nodeId: node.id, logicalId: node.logicalId, status: "failed", error: `Restore startup context persistence failed: ${String(error)}` };
              }
            }
            if (startupResult.ok) {
              const nativeContinuityProved = isPodAware
                && resumeRequested
                && this.launchedSessionMatchesSnapshotResume(launchResult.session.id, resumeType, resumeToken);
              if (isPodAware && resumeRequested && startupResult.continuityOutcome === "fresh" && !nativeContinuityProved) {
                // OPR.0.3.4.2 (B): the runtime POSITIVELY reported fresh
                // continuity and native continuity is unproven — a confirmed
                // blank agent (precision guard trigger (ii)). Roll back to
                // zero sessions and present the decision. NOTE: this fires
                // ONLY on the concluded-fresh determination; a genuinely
                // unknown-but-possibly-valid continuity never reaches here
                // (continuityOutcome would not be "fresh").
                await this.rollbackToZeroSession(node.id, sessionName, launchResult.session.id, priorState);
                return {
                  nodeId: node.id,
                  logicalId: node.logicalId,
                  status: "awaiting-decision",
                  error: `Original session unresumable: resume attempted but the runtime reported fresh continuity. The blank session was rolled back; no session is running. If that degradation is acceptable, run: ${this.freshStartCommand(rigId, data, node.logicalId, opts?.startupFrom)}.`,
                };
              }
              const finalStatus = (isPodAware && resumeRequested)
                ? ((startupResult.continuityOutcome === "resumed" || nativeContinuityProved) ? "resumed" : baseStatus)
                : baseStatus;
              if (finalStatus === "resumed") {
                return this.finishJoinedResume(node, sessionName, resumeToken, launchResult?.session.id,
                  isPodAware && node.runtime === "claude-code");
              }
              return { nodeId: node.id, logicalId: node.logicalId, status: finalStatus };
            }
            // Pod-aware attention_required: hoisted above both the
            // resume-requested and non-resume-requested failed branches so
            // that pod-aware Codex auth-refusal (verifyResumeLaunch →
            // recovery: "attention_required") surfaces honestly regardless
            // of whether resume was requested. Mirrors the runtime-agnostic
            // legacy mapping at lines 725-735. This MUST come before the
            // line 859 / 867 failed branches; otherwise the production
            // pod-aware-resume path (most common) returns `status: "failed"`
            // and the slice's "attention_required end-to-end" claim breaks.
            if (isPodAware && startupResult.startupStatus === "attention_required") {
              return {
                nodeId: node.id,
                logicalId: node.logicalId,
                status: "attention_required",
                error: `Restore startup requires attention: ${startupResult.errors.join("; ")}`,
                attentionEvidence: startupResult.evidence ?? null,
              };
            }
            if (isPodAware && resumeRequested) {
              // Only the runtime's own report that the conversation doesn't exist rolls the seat back
              // as unresumable. A pane that went back to its shell for another reason stays failed,
              // with its pane and binding kept, so its output can still be read.
              if (startupResult.recovery === "retry_fresh" && startupResult.missingConversation) {
                await this.rollbackToZeroSession(node.id, sessionName, launchResult?.session.id, priorState);
                return {
                  nodeId: node.id,
                  logicalId: node.logicalId,
                  status: "awaiting-decision",
                  error: `Original session unresumable: ${startupResult.errors.join("; ")}. The blank session was rolled back; no session is running. To start only this seat fresh, run: ${this.freshStartCommand(rigId, data, node.logicalId, opts?.startupFrom)}; or restore the original session manually.`,
                };
              }
              return {
                nodeId: node.id,
                logicalId: node.logicalId,
                status: "failed",
                error: startupResult.errors.join("; "),
              };
            }
            if (isPodAware) {
              const prefix = startupResult.startupStatus === "attention_required"
                ? "Restore startup requires attention"
                : "Restore startup failed";
              return {
                nodeId: node.id,
                logicalId: node.logicalId,
                status: "failed",
                error: `${prefix}: ${startupResult.errors.join("; ")}`,
              };
            }
            warnings?.push(`Restore startup failed for ${node.logicalId}: ${startupResult.errors.join("; ")}`);
          } catch (err) {
            if (isPodAware && resumeRequested) {
              return {
                nodeId: node.id,
                logicalId: node.logicalId,
                status: "failed",
                error: `Restore startup error: ${(err as Error).message}`,
              };
            }
            if (isPodAware) {
              return {
                nodeId: node.id,
                logicalId: node.logicalId,
                status: "failed",
                error: `Restore startup error: ${(err as Error).message}`,
              };
            }
            warnings?.push(`Restore startup error for ${node.logicalId}: ${(err as Error).message}`);
          }
        }
      }
    }

    if (baseStatus === "resumed") {
      return this.finishJoinedResume(node, sessionName, resumeToken, launchResult?.session.id);
    }
    return { nodeId: node.id, logicalId: node.logicalId, status: baseStatus };
  }

  /** A native resume is only a full success after the restored terminal is
   * rebound and its process identity agrees with the declared seat runtime. */
  private async finishJoinedResume(
    node: SnapshotData["nodes"][number],
    sessionName: string,
    resumeToken: string | null,
    sessionId?: string,
    managedClaudeResume = false,
  ): Promise<RestoreNodeResult> {
    const identity = await rebindAndVerifyPaneIdentity({
      db: this.db,
      sessionRegistry: this.sessionRegistry,
      tmux: this.tmuxAdapter,
      nodeId: node.id,
      sessionName,
      runtime: node.runtime ?? null,
      expectedResumeToken: resumeToken,
      requireExactResumeLineage: true,
      ...(this.listProcesses ? { listProcesses: this.listProcesses } : {}),
    });
    const markManagedResumeAttention = () => {
      if (!managedClaudeResume || !sessionId) return;
      // The join awaits native observations. Only the exact launched row, still
      // current and running, owns this readiness write after those awaits.
      const current = this.db.prepare(
        "SELECT id, session_name, status FROM sessions WHERE node_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
      ).get(node.id) as { id: string; session_name: string; status: string } | undefined;
      if (current?.id === sessionId && current.session_name === sessionName && current.status === "running") {
        this.sessionRegistry.updateStartupStatus(sessionId, "attention_required");
      }
    };
    if (!identity.ok) {
      markManagedResumeAttention();
      return {
        nodeId: node.id,
        logicalId: node.logicalId,
        status: "attention_required",
        error: `Exact native session resumed, but joined restore proof is incomplete: ${identity.detail}. The resumed session was preserved; no replacement was started.`,
      };
    }
    // Legacy resume adapters do not write native metadata. Fill only the
    // launched row's empty token after proof; never overwrite a hook/operator.
    const provedClaudeWrapper = node.runtime === "claude-code"
      && classifyPaneRuntimeMatch(identity.command, node.runtime) === "mismatch"
      && isShellForeground(identity.command?.trim().toLowerCase() ?? "");
    if ((node.runtime === "codex" || provedClaudeWrapper || managedClaudeResume) && sessionId && resumeToken) {
      const current = this.db.prepare("SELECT node_id, session_name, status, resume_token FROM sessions WHERE id = ?").get(sessionId) as
        { node_id: string; session_name: string; status: string; resume_token: string | null } | undefined;
      const sameSession = current?.node_id === node.id && current.session_name === sessionName && current.status === "running";
      // Startup already retained the managed token. Recheck after the awaited
      // join; a hook/operator may have changed it meanwhile. Never backfill here.
      const retained = sameSession && (managedClaudeResume
        ? this.sessionRegistry.resumeTokenMatches(sessionId, "claude_id", resumeToken)
          // Claude continued the resumed conversation under a new id (its hook said so).
          || this.sessionRegistry.claudeResumeRotatedFrom(sessionId, resumeToken)
        : current.resume_token === resumeToken
          || (node.runtime === "claude-code" && this.sessionRegistry.claudeResumeRotatedFrom(sessionId, resumeToken))
          || (!current.resume_token && this.sessionRegistry.updateResumeToken(sessionId, node.runtime === "codex" ? "codex_id" : "claude_id", resumeToken, "scrape")));
      if (!retained) {
        markManagedResumeAttention();
        const store = new SeatIdentityStore(this.db);
        const proof = store.getForNode(node.id);
        if (proof) store.upsert({ ...proof, verdict: "mismatch", reason: "process_identity_mismatch" });
        return { nodeId: node.id, logicalId: node.logicalId, status: "attention_required",
          error: "Native resume was observed but its current session metadata conflicts or could not be retained; session preserved." };
      }
    }
    return { nodeId: node.id, logicalId: node.logicalId, status: "resumed" };
  }

  private launchedSessionMatchesSnapshotResume(
    sessionId: string,
    resumeType: string | null,
    resumeToken: string | null,
  ): boolean {
    if (!resumeType || !resumeToken) return false;
    const row = this.db.prepare("SELECT resume_type, resume_token FROM sessions WHERE id = ?").get(sessionId) as
      | { resume_type: string | null; resume_token: string | null }
      | undefined;
    if (!row?.resume_type || !row.resume_token) return false;
    return row.resume_type === resumeType && row.resume_token === resumeToken;
  }

  /**
   * OPR.0.4.8.3 Seam B — a restored seat's launch posture WITHOUT the in-memory RigSpec
   * (dev-guard restart-provenance ruling):
   *   1. Persisted node provenance (migration 057) is the primary source. For a CUSTOM
   *      attachment with readable provenance (declaringDir + the node's raw ref) the policy
   *      is REOPENED + re-derived (a custom surface:flag policy restores to full_bypass);
   *      an unreadable file degrades to the PERSISTED posture (still restart-stable).
   *   2. No provenance (e.g. organic claim/self-attach seats): the persisted RIG-level ref
   *      resolves — builtin refs resolve dirlessly; a custom rig ref without provenance
   *      degrades to the resolver's advisory floor (honest absence of a declaring dir).
   *   3. Nothing attached (or a resolution error) → EXPLICIT "floor" — the locked
   *      minimum-floor absence contract; never undefined/env-delegation for managed seats.
   */
  private resolveRestorePosture(nodeId: string, rigId: string): "floor" | "full_bypass" | "auto" {
    try {
      const prov = this.rigRepo.getNodePolicyProvenance(nodeId);
      if (prov) {
        // Guard-F3: the resolver swallows read errors internally (advisory floor), so the
        // fallback must be decided BEFORE re-resolution: probe readability of the persisted
        // resolvedTarget first — readable → REOPEN + re-derive (the ruling); unreadable /
        // invalid → the PERSISTED posture carries (restart-stable), never a silent floor.
        if (prov.origin === "custom" && prov.declaringDir && prov.resolvedTarget) {
          const ref = prov.nodeRef ?? this.rigRepo.getRigPermissionPolicy(rigId);
          if (ref) {
            let content: string | null = null;
            try { content = readFileSync(prov.resolvedTarget, "utf-8"); } catch { content = null; }
            if (content !== null) {
              const body = content;
              const rederived = resolvePermissionPolicyAttachment(ref, prov.declaringDir, {
                readFile: () => body,
              });
              // Guard round-2: trust the re-derivation ONLY when content resolution
              // genuinely succeeded with usable semantics (parse OK + valid flag
              // contract) — readable-but-malformed/unusable carries the PERSISTED
              // posture, exactly like unreadable. Advisory only; no enforcement.
              if (rederived.contentResolved) return rederived.launchPosture;
            }
          }
        }
        return prov.launchPosture;
      }
      // Guard-F1: no node provenance (organic claim/self-attach seats) → the PERSISTED
      // rig-level attachment is authoritative — same readable-probe discipline; NEVER
      // resolve the raw relative rig ref against this process's cwd.
      const rigProv = this.rigRepo.getRigPolicyProvenance(rigId);
      if (rigProv) {
        if (rigProv.origin === "custom" && rigProv.declaringDir && rigProv.resolvedTarget && rigProv.rigRef) {
          let content: string | null = null;
          try { content = readFileSync(rigProv.resolvedTarget, "utf-8"); } catch { content = null; }
          if (content !== null) {
            const body = content;
            const rederived = resolvePermissionPolicyAttachment(rigProv.rigRef, rigProv.declaringDir, {
              readFile: () => body,
            });
            if (rederived.contentResolved) return rederived.launchPosture; // same rule as node-level
          }
        }
        return rigProv.launchPosture;
      }
    } catch { /* posture resolution must never block a restore */ }
    // R2 terminal (954d97a0): NO provenance anywhere (and the error path) = the locked
    // minimum floor, explicitly — never undefined (which would delegate to ambient YOLO).
    return "floor";
  }

  private async attemptResume(
    nodeId: string,
    sessionName: string,
    resumeType: string,
    resumeToken: string | null,
    cwd: string,
    codexConfigProfile?: string | null,
    model?: string | null,
    // OPR.0.4.8.3 Seam B: the seat's restored launch posture (persisted provenance,
    // custom policies re-validated when readable). Absent = env decision.
    resolvedPosture?: "floor" | "full_bypass" | "auto",
    effort?: string | null,
    warnings?: string[],
    remoteControl?: boolean,
  ): Promise<
    | { kind: "resumed"; launchedProcess?: ClaudeLaunchedProcess }
    | { kind: "retry_fresh" }
    | { kind: "failed"; message: string }
    | { kind: "attention_required"; message: string; evidence?: string }
  > {
    const launchGeneration = this.sessionRegistry.currentOccupantTenure(nodeId)?.generationUuid;
    const node = this.db.prepare("SELECT rig_id FROM nodes WHERE id = ?").get(nodeId) as { rig_id: string } | undefined;
    const nonInterruptive = node ? this.rigRepo.getRigNonInterruptive(node.rig_id) : false;
    let kernelAuthority = false;
    let teamPermissionDefault = false;
    let permissionMode: string | undefined;
    try {
      const runtime = this.claudeResume.canResume(resumeType, resumeToken) ? "claude-code"
        : this.codexResume.canResume(resumeType, resumeToken) ? "codex" : "pi";
      const override = new NativePermissionStore(this.db).launchOverride(nodeId, runtime);
      kernelAuthority = override.kernelAuthority === true;
      teamPermissionDefault = override.teamPermissionDefault === true;
      resolvedPosture = override.launchPosture ?? resolvedPosture;
      permissionMode = override.permissionMode ?? (resolvedPosture === "auto" && runtime === "claude-code" ? "auto" : undefined);
    } catch (error) { return { kind: "failed", message: `Permission selection: ${(error as Error).message}` }; }
    const launchTail: [effort?: string | null, nonInterruptive?: boolean, kernelAuthority?: boolean, teamPermissionDefault?: boolean] = teamPermissionDefault
      ? [effort, nonInterruptive, false, true] : kernelAuthority
      ? [effort, nonInterruptive, true] : nonInterruptive ? [effort, true] : effort !== undefined ? [effort] : [];
    if (this.claudeResume.canResume(resumeType, resumeToken)) {
      // The variable-length launchTail cannot take a trailing positional, so a declared remote_control
      // gets the full five-slot tail; an undeclared seat keeps today's exact call shape.
      const claudeTail: [effort?: string | null, nonInterruptive?: boolean, kernelAuthority?: boolean, teamPermissionDefault?: boolean, remoteControl?: boolean] = remoteControl
        ? [effort, nonInterruptive, kernelAuthority, teamPermissionDefault, true] // launchOverride makes kernelAuthority and teamPermissionDefault mutually exclusive, so this equals launchTail's precedence
        : launchTail;
      const result = await this.claudeResume.resume(sessionName, resumeType, resumeToken, cwd, resolvedPosture, model, permissionMode, nodeId, ...claudeTail);
      if (result.ok) {
        const notice = nonInterruptiveNotice("claude-code", { nonInterruptive, launchPosture: resolvedPosture, permissionMode });
        if (notice) warnings?.push(`${sessionName}: ${notice}`);
        if (result.appliedLaunch && launchGeneration) this.appliedLaunchStore.recordGeneration(launchGeneration, result.appliedLaunch);
        return { kind: "resumed", ...(result.launchedProcess ? { launchedProcess: result.launchedProcess } : {}) };
      }
      if (result.code === "retry_fresh") return { kind: "retry_fresh" };
      // L3: surface attention_required from the Claude probe (resume-selection prompt).
      if (result.code === "attention_required") {
        return {
          kind: "attention_required",
          message: result.message,
          evidence: (result as { evidence?: string }).evidence,
        };
      }
      return { kind: "failed", message: result.message };
    }

    if (this.codexResume.canResume(resumeType, resumeToken)) {
      const result = await this.codexResume.resume(sessionName, resumeType, resumeToken, cwd, codexConfigProfile, resolvedPosture, model, ...launchTail);
      if (result.ok) {
        const notice = nonInterruptiveNotice("codex", { nonInterruptive, launchPosture: resolvedPosture, permissionMode });
        if (notice) warnings?.push(`${sessionName}: ${notice}`);
        if (result.appliedLaunch && launchGeneration) this.appliedLaunchStore.recordGeneration(launchGeneration, result.appliedLaunch);
        return { kind: "resumed" };
      }
      if (result.code === "retry_fresh") return { kind: "retry_fresh" };
      // Codex auth-refusal: stored OAuth token can no longer be refreshed.
      // Recoverable — operator runs `codex login` and the seat continues.
      // Per-node mapping at lines 725-735 emits `status: "attention_required"`
      // with `attentionEvidence` for both runtimes; no further wiring needed.
      if (result.code === "attention_required") {
        return {
          kind: "attention_required",
          message: result.message,
          evidence: (result as { evidence?: string }).evidence,
        };
      }
      return { kind: "failed", message: result.message };
    }

    // OPR.0.4.6.PI1 FR-6 — honest session-file continuation. A missing
    // session file returns retry_fresh, which the caller maps to the
    // awaiting-decision stop-and-ask — never a silent fresh start (BR-6).
    if (this.piResume?.canResume(resumeType, resumeToken)) {
      const result = await this.piResume.resume(sessionName, resumeType, resumeToken, cwd, model, resolvedPosture);
      if (result.ok) {
        if (result.appliedLaunch && launchGeneration) this.appliedLaunchStore.recordGeneration(launchGeneration, result.appliedLaunch);
        return { kind: "resumed" };
      }
      if (result.code === "retry_fresh") return { kind: "retry_fresh" };
      if (result.code === "attention_required") {
        return {
          kind: "attention_required",
          message: result.message,
          evidence: (result as { evidence?: string }).evidence,
        };
      }
      return { kind: "failed", message: result.message };
    }
    if (this.ompResume?.canResume(resumeType, resumeToken)) {
      const result = await this.ompResume.resume(sessionName, resumeType, resumeToken, cwd, model, resolvedPosture);
      if (result.ok) {
        if (result.appliedLaunch && launchGeneration) this.appliedLaunchStore.recordGeneration(launchGeneration, result.appliedLaunch);
        return { kind: "resumed" };
      }
      if (result.code === "retry_fresh") return { kind: "retry_fresh" };
      if (result.code === "attention_required") {
        return { kind: "attention_required", message: result.message, evidence: (result as { evidence?: string }).evidence };
      }
      return { kind: "failed", message: result.message };
    }


    return { kind: "failed", message: "No resume adapter available for this runtime/token combination." };
  }

  /**
   * L3 Decision 3: runtime-truth reconciliation. Given a node whose original
   * `restoreOutcome` was `failed` or `attention_required`, examine current
   * runtime state. If ALL four visible-evidence preconditions hold, append
   * `restore.outcome_reconciled` so the node's effective post-reconciliation
   * outcome becomes `operator_recovered`. Never mutates or deletes the
   * original failure event; never produces `ready`.
   *
   * Returns `{ ok: true, attemptId, from, to, evidence }` on upgrade, or
   * `{ ok: false, code, detail }` describing exactly which precondition
   * failed (or "no_attempt" / "outcome_not_upgradable" when there is nothing
   * to reconcile).
   */
  async reconcileNodeRuntimeTruth(
    rigId: string,
    nodeId: string,
  ): Promise<ReconcileNodeResult> {
    // Locate the latest restore attempt for this rig.
    const startedRow = this.db.prepare(
      "SELECT seq, payload FROM events WHERE rig_id = ? AND type = 'restore.started' ORDER BY seq DESC LIMIT 1"
    ).get(rigId) as { seq: number; payload: string } | undefined;
    if (!startedRow) {
      return { ok: false, code: "no_attempt", detail: "No restore.started event recorded for this rig." };
    }
    const attemptId = startedRow.seq;

    // Find the node's most recent post-attempt outcome from the most-recent
    // restore.completed event for this rig. If the latest outcome is not
    // failed or attention_required, the reconciler has nothing to upgrade.
    const completedRow = this.db.prepare(
      "SELECT payload FROM events WHERE rig_id = ? AND type = 'restore.completed' AND seq > ? ORDER BY seq DESC LIMIT 1"
    ).get(rigId, attemptId) as { payload: string } | undefined;
    let nodeStatus: RestoreNodeResult["status"] | null = null;
    let nodeLogicalId: string | null = null;
    if (completedRow) {
      try {
        const parsed = JSON.parse(completedRow.payload) as { result: RestoreResult };
        const found = parsed.result?.nodes?.find((n) => n.nodeId === nodeId);
        if (found) {
          nodeStatus = found.status;
          nodeLogicalId = found.logicalId;
        }
      } catch {
        // payload corruption — treat as no node record found
      }
    }
    if (!nodeStatus) {
      return { ok: false, code: "node_not_found", detail: `Node ${nodeId} has no record in the latest restore.completed event for rig ${rigId}.` };
    }
    if (nodeStatus !== "failed" && nodeStatus !== "attention_required") {
      return { ok: false, code: "outcome_not_upgradable", detail: `Reconciliation only upgrades failed or attention_required; current outcome is ${nodeStatus}.` };
    }
    const fromStatus: "failed" | "attention_required" = nodeStatus;

    const priorReconciliation = this.db.prepare(
      "SELECT payload FROM events WHERE rig_id = ? AND node_id = ? AND type = 'restore.outcome_reconciled' AND json_extract(payload, '$.attemptId') = ? ORDER BY seq DESC LIMIT 1",
    ).get(rigId, nodeId, attemptId) as { payload: string } | undefined;
    if (priorReconciliation) {
      try {
        const prior = JSON.parse(priorReconciliation.payload) as Extract<import("./types.js").RigEvent, { type: "restore.outcome_reconciled" }>;
        if ("tmux" in prior.evidence) {
          return { ok: true, attemptId, from: prior.from, to: "operator_recovered", evidence: prior.evidence };
        }
      } catch {
        // A malformed prior row is not positive evidence; continue to the live proof.
      }
    }

    // Resolve canonical session name for this node so we can probe tmux/pane.
    const bindingRow = this.db.prepare(
      "SELECT tmux_session FROM bindings WHERE node_id = ?"
    ).get(nodeId) as { tmux_session: string | null } | undefined;
    const sessionName = bindingRow?.tmux_session ?? null;
    if (!sessionName) {
      return { ok: false, code: "tmux_session_missing", detail: "No tmux session bound for this node." };
    }

    const sessRow = this.db.prepare(
      "SELECT session_name, resume_type, resume_token, resume_provenance, resume_rotated_from, resume_rotated_process, resume_launch_process FROM sessions WHERE node_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
    ).get(nodeId) as { session_name: string; resume_type: string | null; resume_token: string | null; resume_provenance: string | null; resume_rotated_from: string | null; resume_rotated_process: string | null; resume_launch_process: string | null } | undefined;
    if (!sessRow || sessRow.session_name !== sessionName) {
      return { ok: false, code: "binding_mismatch", detail: `Canonical binding ${sessionName} does not match the latest session row.` };
    }
    const expectedResumeToken = sessRow.resume_token;
    // The one alternative argv may carry: the token OpenRig launched this row to resume, when the
    // first hook after that launch recorded Claude continuing it as the stored token (#1077), and
    // only in the process that sent that hook.
    const rotation = sessRow.resume_type === "claude_id" ? claudeResumeRotation(sessRow) : null;
    if (!expectedResumeToken) {
      return { ok: false, code: "resume_token_not_used", detail: "No resume token recorded on the latest session row." };
    }

    // Precondition #1: tmux session exists.
    let alive = false;
    try {
      alive = await this.tmuxAdapter.hasSession(sessionName);
    } catch {
      // L1 fail-closed: ambiguous probe failure stays as not-alive for the
      // reconciler. Original failure event remains untouched.
      alive = false;
    }
    if (!alive) {
      return { ok: false, code: "tmux_session_missing", detail: `Tmux session ${sessionName} is not currently alive.` };
    }

    // Resolve runtime and prove exact native-token process lineage. Executable
    // basename alone is never sufficient for no-input recovery.
    const nodeRow = this.db.prepare(
      "SELECT runtime FROM nodes WHERE id = ?"
    ).get(nodeId) as { runtime: string | null } | undefined;
    const runtime = nodeRow?.runtime ?? null;
    // One exact-lineage check per process, accepting the stored token or the recorded rotation.
    const identity = await rebindAndVerifyPaneIdentity({
      db: this.db,
      sessionRegistry: this.sessionRegistry,
      tmux: this.tmuxAdapter,
      nodeId,
      sessionName,
      runtime,
      expectedResumeToken,
      requireExactResumeLineage: true,
      resumeRotation: rotation,
      ...(this.listProcesses ? { listProcesses: this.listProcesses } : {}),
    });
    if (!identity.ok) {
      return { ok: false, code: "process_lineage_mismatch", detail: identity.detail };
    }
    const paneCommand = await this.tmuxAdapter.getPaneCommand(identity.pane);
    const paneContent = (await this.tmuxAdapter.capturePaneContent(identity.pane, 40)) ?? "";
    const claudeResumeIdentityVerified = runtime === "claude-code" && !!await verifyClaudePaneProcess({
      target: identity.pane,
      tmux: this.tmuxAdapter,
      expectedToken: expectedResumeToken,
      rotation,
      requireResume: true,
      ...(this.listProcesses ? { listProcesses: this.listProcesses } : {}),
    });
    const probe = assessNativeResumeProbe({
      runtime,
      paneCommand,
      paneContent,
      // Headerless readiness requires the same stable foreground/argv proof
      // as the resume adapter; a token-bearing descendant alone is insufficient.
      ...(runtime === "claude-code" ? { claudeResumeIdentityVerified } : {}),
    });
    const fgProcess = runtime === "claude-code" ? "claude" as const : runtime === "codex" ? "codex" as const : null;
    if (!fgProcess) {
      return { ok: false, code: "fg_process_not_runtime", detail: `Node runtime is ${runtime ?? "unknown"}, not claude/codex.` };
    }

    // Precondition #4: pane is at a usable/idle state — explicitly NOT a
    // resume-selection prompt and not the "returned to shell" failure mode.
    if (probe.status !== "resumed") {
      return { ok: false, code: "pane_not_usable", detail: `Pane state is ${probe.status} (${probe.code}); reconciliation requires resumed.` };
    }

    // All four preconditions hold. Append (never mutate) the audit event.
    this.eventBus.emit({
      type: "restore.outcome_reconciled",
      rigId,
      nodeId,
      attemptId,
      from: fromStatus,
      to: "operator_recovered",
      evidence: { tmux: true, fgProcess, resumeTokenUsed: true, paneState: "usable" },
    });

    return {
      ok: true,
      attemptId,
      from: fromStatus,
      to: "operator_recovered",
      evidence: { tmux: true, fgProcess, resumeTokenUsed: true, paneState: "usable" },
    };
  }

  private writeCheckpointFile(cwd: string, checkpoint: Checkpoint): boolean {
    try {
      const filePath = join(cwd, ".rigged-checkpoint.md");
      const content = [
        "# OpenRig Checkpoint",
        "",
        `## Summary`,
        checkpoint.summary,
        "",
        checkpoint.currentTask ? `## Current Task\n${checkpoint.currentTask}\n` : "",
        checkpoint.nextStep ? `## Next Step\n${checkpoint.nextStep}\n` : "",
        checkpoint.blockedOn ? `## Blocked On\n${checkpoint.blockedOn}\n` : "",
        checkpoint.keyArtifacts.length > 0
          ? `## Key Artifacts\n${checkpoint.keyArtifacts.map((a) => `- ${a}`).join("\n")}\n`
          : "",
      ]
        .filter(Boolean)
        .join("\n");

      writeFileSync(filePath, content, "utf-8");
      return true;
    } catch {
      return false;
    }
  }
}

/** How far one seat's restore got, so a thrown error can be compensated by what had been done. */
interface SeatRestoreProgress {
  /** The LIVE node id, once found. */
  nodeId?: string;
  /** The seat's binding and sessions as they were before clearStaleState; set just before it runs. */
  priorState?: { binding: import("./types.js").Binding | null; sessions: { id: string; status: string }[] };
  /** Ids of every session row the seat had before clearStaleState; set with priorState. */
  knownSessionIds?: Set<string>;
  /** True once nodeLauncher.launchNode has returned (ok or not). */
  launchReturned: boolean;
  /** True once launchNode returned a failed result: nothing was launched and the body is compensating. */
  launchResultFailed?: boolean;
}

interface PlanEntry {
  node: NodeWithBinding;
}
