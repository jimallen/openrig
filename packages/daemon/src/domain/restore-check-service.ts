import { savedRowDamageMessage } from "./node-row-damage.js";
import { claudeActivityRelayPath } from "./claude-activity-hooks.js";
import { existsSync, accessSync, constants } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { getCompatibleOpenRigPath } from "../openrig-compat.js";
import { shellQuote as quoteShellArgument } from "../adapters/shell-quote.js";
import { reanchorBuiltinStartupFile, reanchorShippedProjectionEntry } from "./builtin-startup-files.js";
import { validatePreRestore } from "./restore-preconditions.js";
import { freshSeatLaunchCommand } from "./active-occupant.js";
import { rigAdviceHandle, type RigRefLookup } from "./rig-ref.js";
import type { SeatStop } from "./restore-seat-gates.js";
import { restoreRefusesRig, type RunningSessionClassification } from "./restore-running-sessions.js";
import type { SessionLiveness } from "./session-liveness.js";
import { getSeatCwdFault, seatCwdFixAdvice, seatCwdUnusableMessage } from "./cwd-resolution.js";
import { projectRigWorkspaceRecreatable } from "./project-rig.js";
import type { CurrentStateRehydrateEligibility } from "./rehydrate-eligibility.js";
import type { Snapshot, RigServicesRecord, SeatIdentityVerdict, NodeStartupSnapshot } from "./types.js";
import { contestedAdoptedSessionReason, type AdoptedSessionLeftRunning } from "./adopted-reattach.js";

// --- Types ---

export type CheckStatus = "green" | "yellow" | "red";
export type Verdict = "restorable" | "restorable_with_caveats" | "not_restorable" | "unknown";
export type ReadinessStatus = "ready" | "ready_with_caveats" | "not_ready" | "unknown";
export type HostInfraStatus = "not_inspected" | "not_declared" | "declared" | "unknown";

export interface CheckEntry {
  check: string;
  status: CheckStatus;
  evidence: string;
  remediation: string;
  /** Whether the remediation action is execution-safe (read-only / manual
   *  inspection). false for mutating actions (daemon start, chmod, create
   *  files, snapshot). Defaults to false (unsafe) if omitted — conservative
   *  so new checks without explicit classification don't invite agents to
   *  auto-execute mutating commands. */
  remediationSafe?: boolean;
}

export interface RepairStep {
  step: number;
  command: string;
  rationale: string;
  safe: boolean;
  blocking: boolean;
}

export interface ReadinessAssertion {
  status: ReadinessStatus;
  reason: string;
  blockingRigCount: number;
  caveatRigCount: number;
  unknownRigCount: number;
}

export interface ContinuityAssertion {
  status: "proven" | "not_proven" | "partial" | "not_applicable";
  evidence: string;
  provenCapabilities: string[];
  unprovenCapabilities: string[];
}

// OPR.0.4.0.29 FR-8 — ready-confidence breakdown by the 5 REAL-enum seat
// classes. Each derives from a real primitive (no invented status): ready /
// ready_with_caveats / not_ready come from the seat readiness checks;
// attention_required from node.startupStatus; unknown is the indeterminate
// remainder. (The fresh-primed/awaiting-decision SPLIT of ready_with_caveats is
// the deferred/escalated follow-on — NOT emitted here.)
export interface ReadinessClassCounts {
  ready: number;
  ready_with_caveats: number;
  not_ready: number;
  attention_required: number;
  unknown: number;
}

export interface RigRestoreRollup {
  rigId: string;
  rigName: string;
  status: ReadinessStatus;
  verdict: Verdict;
  expectedNodes: number;
  runningReadyNodes: number;
  blockedNodes: number;
  caveatNodes: number;
  classCounts: ReadinessClassCounts;
  blockingChecks: CheckEntry[];
  caveatChecks: CheckEntry[];
}

export interface HostInfraAssertion {
  status: HostInfraStatus;
  evidence: string;
}

export type RecoveryStatus = "not_needed" | "actionable" | "blocked" | "unknown";

export interface RecoveryAction {
  scope: "rig";
  rigId: string;
  rigName: string;
  action: "restore_from_latest_snapshot";
  command: string;
  reason: string;
  safe: boolean;
  blocking: boolean;
}

export interface RecoveryIssue {
  scope: "host" | "rig";
  rigId?: string;
  rigName?: string;
  reason: string;
}

export interface RecoveryPlan {
  status: RecoveryStatus;
  summary: string;
  actions: RecoveryAction[];
  blocked: RecoveryIssue[];
  unknown: RecoveryIssue[];
}

export interface StartupContextResolvedFile {
  absolutePath: string;
  required: boolean;
  path?: string | null;
  deliveryHint?: string | null;
  ownerRoot?: string | null;
}

export interface StartupContextProjectionEntry {
  absolutePath: string;
  effectiveId?: string | null;
  category?: string | null;
  sourcePath?: string | null;
  resourceType?: string | null;
}

export interface QueueStoreProbeResult {
  available: boolean;
  evidence: string;
}

export type StartupContextProbeResult =
  | {
      status: "ok";
      runtime: string | null;
      resolvedStartupFiles: StartupContextResolvedFile[];
      projectionEntries: StartupContextProjectionEntry[];
    }
  | {
      status: "missing" | "malformed" | "probe_error";
      evidence: string;
    };

export interface RestoreCheckResult {
  verdict: Verdict;
  readiness: ReadinessAssertion;
  continuity: ContinuityAssertion;
  rigs: RigRestoreRollup[];
  hostInfra: HostInfraAssertion;
  recovery: RecoveryPlan;
  counts: { red: number; yellow: number; green: number };
  /** OPR.0.4.0.29 FR-8 — fleet-wide ready-confidence breakdown by class. */
  classCounts: ReadinessClassCounts;
  checks: CheckEntry[];
  repairPacket: RepairStep[] | null;
}

export interface RestoreCheckOpts {
  rig?: string;
  noQueue?: boolean;
  noHooks?: boolean;
  compact?: boolean;
  /** OPR.0.4.0.29 FR-2: in compact mode, still assemble ready-seat detail so
   *  `--ready` shows ready seats without dropping to the full firehose. */
  includeReady?: boolean;
  /** Composed status polls need preconditions only for rigs needing recovery. */
  recoveryOnly?: boolean;
  /** OF-32 follow-up: predict `rig up --existing <rig> --fresh <seats...>`: the seats the operator would list. Needs
   *  `restoreParity`; each listed seat restore would refuse is a blocker, with restore's own refusal text. */
  freshLogicalIds?: string[];
  /** With `freshLogicalIds`: `--startup-from` (default spec). */
  startupFrom?: import("./seat-startup-source.js").StartupFrom;
}

/** What restore decides, asked of the same functions restore calls (fresh-seat-restore-decision.ts,
 *  own-startup-replay.ts). Optional so the service stays framework-free; production wires it
 *  (routes/restore-check.ts). Without it the check judges a seat's saved context from `getStartupContext` alone. */
export interface RestoreParityDeps {
  /** startupToValidateForSeat, for this seat and these listed seats; `selectedCopy` is the checked snapshot's copy of
   *  the seat's startup context. Its `{ refuse }` is restore's own pre-restore refusal (OF-36). */
  startupToValidate(rigId: string, logicalId: string, listed: { freshLogicalIds?: string[]; startupFrom?: import("./seat-startup-source.js").StartupFrom }, selectedCopy: NodeStartupSnapshot | null):
    import("./restore-preconditions.js").FreshSeatStartupOverride;
  /** predictListedSeatRefusals: logical id -> the text restore reports after "Fresh start refused: ". */
  predictListedSeatRefusals(rigId: string, snapshotData: Snapshot["data"] | null, listed: { freshLogicalIds: string[]; startupFrom: import("./seat-startup-source.js").StartupFrom }): Promise<Map<string, string>>;
  /** Review F1: the remediation for a listed seat restore would refuse (listedRefusalRemedy); optional for older wiring. */
  listedRefusalRemedy?(rigId: string, logicalId: string, snapshotData: Snapshot["data"] | null, listed: { freshLogicalIds: string[]; startupFrom: import("./seat-startup-source.js").StartupFrom }): string;
  /** predictSeatStops (restore-seat-gates.ts): logical id -> why restore stops that seat before its startup files are
   *  looked at (removed seat, runtime differs from the snapshot's, resumable seat with no token, ...). */
  predictSeatStops(rigId: string, snapshotData: Snapshot["data"], listed: { freshLogicalIds?: string[]; startupFrom?: import("./seat-startup-source.js").StartupFrom }): Map<string, SeatStop>;
  /** The live seat facts restore validates with (liveSeatGateInputs), so pre-restore validation here skips and checks the
   *  seats restore does. Optional for older wiring: without it only the snapshot-only gates apply. */
  seatGateInputs?(rigId: string, snapshotData: Snapshot["data"]): (node: { id: string; logicalId: string }) => import("./restore-seat-gates.js").SeatGateInputs;
}

/** What the checked snapshot says about which seats restore starts and where (OF-125, OF-128 L7). */
interface LaunchRule {
  /** Seats restore stops at a gate (removed, ambiguous, runtime mismatch, no token): it starts nothing for them. */
  stoppedSeats: Set<string>;
  /** The cwd the snapshot saved for each seat: a seat with no live cwd is started there. */
  snapshotCwd: Map<string, string | null>;
}

// --- Deps (framework-free per ADR-0001; reads from existing projections per ADR-0002) ---

export interface NodeInventoryEntry {
  nodeId?: string | null;
  rigId: string;
  rigName: string;
  logicalId: string;
  podId: string | null;
  podNamespace?: string | null;
  canonicalSessionName: string | null;
  nodeKind: "agent" | "infrastructure";
  runtime: string | null;
  sessionStatus: string | null;
  /** The newest session row's raw DB status, before an identity verdict may relabel it. */
  storedSessionStatus?: string | null;
  startupStatus: string | null;
  storedStartupStatus?: string | null;
  identityVerdict?: SeatIdentityVerdict | null;
  tmuxAttachCommand: string | null;
  latestError: string | null;
  cwd?: string | null;
  /** The seat's binding (`tmux` when bound), null when it has none: restore starts only a seat with no binding. */
  attachmentType?: string | null;
}

/**
 * What tmux says about a seat's canonical session, independent of the DB.
 * `unreadable` means tmux could not be asked (transport down / probe threw):
 * liveness is UNKNOWN, never assumed dead or live.
 */
export type SeatLiveness = SessionLiveness;

export interface RestoreCheckDeps {
  /** Probe whether a seat's tmux session is live (the tmux adapter's classified
   *  session probe). Optional: without it checkWithLiveness() behaves like check(). */
  probeSeatLiveness?: (sessionName: string) => Promise<SeatLiveness>;
  /** Get all rigs as summaries */
  listRigs: () => Array<{ rigId: string; name: string; hasServices?: boolean }>;
  /** OF-155: the seat's adopted session that rig down left running, which rig up --existing reattaches
   *  (adopted-reattach.ts, the rule restore uses). Absent: no seat is read as one. */
  reattachableAdopted?: (nodeId: string) => AdoptedSessionLeftRunning | null;
  /** OF-152: the rig lookup advice names rigs by (ids across every rig, archived included; names among unarchived ones).
   *  Absent: advice reads `listRigs`, which knows no archived rig. */
  rigRefs?: RigRefLookup;
  /** Get node inventory for a rig (ADR-0002: NodeInventory projection) */
  getNodeInventory: (rigId: string) => NodeInventoryEntry[];
  /** Get persisted startup context for a node */
  getStartupContext: (nodeId: string) => StartupContextProbeResult;
  /** Check if a snapshot exists for a rig */
  hasSnapshot: (rigId: string) => boolean;
  /** OF-117: how many of the rig's saved snapshots are damaged (listed, but their data is not JSON). Absent: unknown (0). */
  countDamagedSnapshots?: (rigId: string) => number;
  /** Get the newest snapshot for exact restore planning when available */
  getLatestSnapshot?: (rigId: string) => { id: string; kind: string } | null;
  /** Exact ordinary-restore input; never captures an auto-rehydrate snapshot. */
  getRestoreInputs: (rigId: string) =>
    | { snapshot: Pick<Snapshot, "id" | "kind" | "data">; servicesRecord: RigServicesRecord | null }
    | { currentStateRehydrate: CurrentStateRehydrateEligibility & { occupantStops?: string[] }; reason: string }
    | { unavailable: string };
  /** Probe daemon health: returns { healthy: boolean; evidence: string } */
  probeDaemonHealth: () => { healthy: boolean; evidence: string };
  /** Filesystem probes */
  exists: (path: string) => boolean;
  /** Read a declaration/config file. Kept injectable so restore-check remains testable and source-safe. */
  readFile: (path: string) => string;
  /** Shared-docs root for rig spec path resolution. */
  substrateRoot?: string;
  /** Read-only probe of the daemon SQLite queue store. */
  probeQueueStore?: () => QueueStoreProbeResult;
  /** Configured OpenRig instance root, matching the Claude adapter stateDir. */
  stateDir?: string;
  /** Relay-backed Claude hook events derived from the shipped hook manifest. */
  getClaudeActivityHookEvents?: () => string[];
  /** OF-32: the spec source a rig records (null: none). A seat started fresh re-reads it; advice says so. */
  getRigSpecSource?: (rigId: string) => string | null;
  /** OF-62: the seats whose saved node row is damaged (session source / package list not what was written), with the
   *  reasons (node-row-damage.ts, the predicate restore's pre-restore snapshot refuses on). Optional so the service
   *  stays framework-free; production wires it (routes/restore-check.ts). Without it damage is not judged. */
  getSavedRowDamage?: (rigId: string) => Array<{ logicalId: string; damage: string[] }>;
  /** OF-32 follow-up: restore's own decisions about saved startup contexts and listed seats. */
  restoreParity?: RestoreParityDeps;
  /** OF-40 review: restore's own classification of the rig's DB-running session rows against tmux
   *  (restore-running-sessions.ts classifyRunningSessions, over every running row, with a liveness probe). Without it
   *  (no tmux) whether restore would run is UNKNOWN for a rig with a running row, and the gate prediction says so. */
  classifyRunningSessions?: (rigId: string, probe: (sessionName: string) => Promise<SeatLiveness>) => Promise<NamedRunningClassification>;
}

interface RigRollupInput {
  liveness: Map<string, SeatLiveness>;
  rig: { rigId: string; name: string };
  nodes: NodeInventoryEntry[];
  checks: CheckEntry[];
  preconditionError?: string;
}

interface RecoveryRigInput {
  rigId: string;
  rigName: string;
  expectedNodes: number;
  runningReadyNodes: number;
  blockingChecks: CheckEntry[];
  latestSnapshot: { id: string; kind: string } | null;
  snapshotLookupError?: string;
  /** Seats live in tmux that the DB also shows running: restore refuses (409) while any exists. */
  liveRunningSeats: string[];
  /** Seats live in tmux that the DB does NOT show running (DB out of step with tmux). */
  liveUnrecordedSeats: string[];
  /** OF-155: seats whose adopted session rig down left running, live in tmux: rig up --existing reattaches them. */
  reattachSeats: string[];
  /** OF-155 review F1: of the seats whose liveness could not be read, those whose adopted session rig down left running:
   *  restore probes these too, and fails them (adopted_liveness_unknown) rather than reattach or start them. */
  unknownAdoptedSeats: string[];
  /** Seats tmux says are not live, as logical ids (for the per-seat fresh-launch advice). */
  deadSeatIds: string[];
  /** Seats whose tmux liveness could not be read. */
  unknownLivenessSeats: string[];
  /** Restore would refuse this rig whole (`rig_not_stopped`): a seat the DB shows running is live in tmux or unreadable.
   *  Then what the snapshot says about the next restore is not what recovery reports. */
  restoreRefused: boolean;
  /** OF-47: restore's own reading of EVERY DB-running row of the rig (restore-running-sessions.ts), which the advice must
   *  follow instead of each seat's newest row. `live`/`unreadable`: restore refuses (rig_not_stopped); `unanswered`: the
   *  rule was asked and failed. `none`: restore runs. `not_asked`: no tmux is wired, so no liveness is read at all. */
  restoreRunningRows: "none" | "live" | "unreadable" | "unanswered" | "not_asked";
  /** The tmux names of the running rows restore refuses on (the first live, or the first unreadable one: probing stops there). */
  restoreRunningRowNames: string[];
  /** Of those names, the ones another seat (or rig) owns: tmux name -> that seat's `logical@rig`. Never to be killed from here. */
  restoreRunningRowOwners: Record<string, string>;
  /** Of those owners, the owner's rig id (rig names are not unique). A missing id is read as "may be this rig". */
  restoreRunningRowOwnerRigIds: Record<string, string>;
  /** OF-144: of those names, the ones whose row was adopted (origin=claimed): tmux name -> that row's session id, the exact
   *  `rig unclaim` argument. `null`: the classification did not say which rows were adopted. */
  restoreRunningRowAdopted: Record<string, string> | null;
}

interface HostInfraCheckResult {
  check: CheckEntry;
  hostInfra: HostInfraAssertion;
}

/** Per rig id: the listed seats restore would refuse (logical id -> restore's refusal text), or why that could not be asked. */
type ListedRefusals = Map<string, Map<string, string> | Error>;
/** Per rig: what restore's refusal rule says about running rows (an Error: it could not be asked). Absent: not asked. */
type RunningClassifications = Map<string, NamedRunningClassification | Error>;
/** OF-47: restore's classification (session ids) plus the tmux names of the rows it refuses on, for advice that names them. */
type NamedRunningClassification = RunningSessionClassification & { sessionNames?: Record<string, string>; sessionOwners?: Record<string, string>; sessionOwnerRigIds?: Record<string, string>; adoptedSessionIds?: string[] };
/** Would the next restore run at all? `refused`: a running row is live or unreadable (rig_not_stopped). */
type RestoreRuns = "would_run" | "refused" | "unknown";

// --- Service ---

const DAEMON_HEALTHY_PATTERN = /^Daemon running\b/m;
export class RestoreCheckService {
  private deps: RestoreCheckDeps;

  constructor(deps: RestoreCheckDeps) {
    this.deps = deps;
  }

  /**
   * Compute scoped restore checks and recovery guidance from daemon, rig and
   * seat evidence without launching occupants.
   */

  /**
   * check() plus a tmux liveness probe per seat, so recovery advice reflects
   * what tmux says and not only what the DB says. Without a probe dep this is
   * check().
   */
  async checkWithLiveness(opts: RestoreCheckOpts): Promise<RestoreCheckResult> {
    const probe = this.deps.probeSeatLiveness;
    const liveness = new Map<string, SeatLiveness>();
    if (probe) {
      const names = new Set<string>();
      try {
        for (const rig of this.deps.listRigs()) {
          if (opts.rig && rig.name !== opts.rig) continue;
          for (const node of this.deps.getNodeInventory(rig.rigId)) {
            if (node.canonicalSessionName) names.add(node.canonicalSessionName);
          }
        }
      } catch { /* runCheck reports the same read failure as its own unknown result */ }
      await Promise.all([...names].map(async (name) => {
        try { liveness.set(name, await probe(name)); } catch { liveness.set(name, "unreadable"); }
      }));
    }
    return this.check(opts, liveness, await this.predictListedRefusals(opts), await this.classifyRunning(opts, liveness));
  }

  /** Per rig, restore's own reading of its DB-running rows (every row, raw status) against tmux. The liveness already
   *  read for the seats answers the names it covers; any other running row's name is probed. */
  private async classifyRunning(opts: RestoreCheckOpts, liveness: Map<string, SeatLiveness>): Promise<RunningClassifications> {
    const byRig: RunningClassifications = new Map();
    const classify = this.deps.classifyRunningSessions;
    const probe = this.deps.probeSeatLiveness;
    if (!classify || !probe) return byRig;
    let rigs: Array<{ rigId: string; name: string }> = [];
    try { rigs = this.deps.listRigs(); } catch { return byRig; }
    for (const rig of rigs) {
      if (opts.rig && rig.name !== opts.rig) continue;
      try {
        byRig.set(rig.rigId, await classify(rig.rigId, async (name) => liveness.get(name) ?? probe(name)));
      } catch (err) {
        byRig.set(rig.rigId, err instanceof Error ? err : new Error(String(err)));
      }
    }
    return byRig;
  }

  /** Per rig, the listed seats restore would refuse (OF-32 follow-up). Asked here because the decision re-reads each
   *  seat's spec, which is asynchronous; check() itself stays synchronous. A read failure here is reported by
   *  checkRestorePreconditions as the same unavailable-inputs result, not guessed at. */
  private async predictListedRefusals(opts: RestoreCheckOpts): Promise<ListedRefusals> {
    const byRig: ListedRefusals = new Map();
    const parity = this.deps.restoreParity;
    const listed = opts.freshLogicalIds ?? [];
    if (!parity || listed.length === 0) return byRig;
    let rigs: Array<{ rigId: string; name: string }> = [];
    try { rigs = this.deps.listRigs(); } catch { return byRig; /* check() reports the same read failure as unknown */ }
    for (const rig of rigs) {
      if (opts.rig && rig.name !== opts.rig) continue;
      try {
        const input = this.deps.getRestoreInputs(rig.rigId);
        if ("unavailable" in input || "currentStateRehydrate" in input) continue; // checkRestorePreconditions reports these
        byRig.set(rig.rigId, await parity.predictListedSeatRefusals(rig.rigId, input.snapshot.data, { freshLogicalIds: listed, startupFrom: opts.startupFrom ?? "spec" }));
      } catch (err) {
        // Never read as "nothing refused": an unanswered prediction is reported yellow by checkRestorePreconditions.
        byRig.set(rig.rigId, err instanceof Error ? err : new Error(String(err)));
      }
    }
    return byRig;
  }

  /**
   * `liveness` is the per-session tmux answer gathered by checkWithLiveness();
   * omitted, every seat is judged on DB state alone (the pre-OF-29 behaviour).
   */
  check(opts: RestoreCheckOpts, liveness: Map<string, SeatLiveness> = new Map(), listedRefusals: ListedRefusals = new Map(), running: RunningClassifications = new Map()): RestoreCheckResult {
    const checks: CheckEntry[] = [];
    // rev1-r2 no-false-ready: ready-seat caveat signals that default compact
    // COMPUTES but does NOT emit (AC-4 token-safe) still count toward the
    // top-level verdict/readiness/counts, so the headline never reports a false
    // ready while a rig rollup is ready_with_caveats.
    const deferredAssessmentChecks: CheckEntry[] = [];
    const rigRollupInputs: RigRollupInput[] = [];
    const recoveryRigInputs: RecoveryRigInput[] = [];
    const restoreInputsByRig = new Map<string, { snapshot: { id: string; kind: string } | null; error?: string }>();
    const launchRuleByRig = new Map<string, LaunchRule>();
    const restoreRefusedByRig = new Map<string, boolean>();
    const restoreRunningRowsByRig = new Map<string, RecoveryRigInput["restoreRunningRows"]>();
    const restoreRunningRowNamesByRig = new Map<string, string[]>();
    const restoreRunningRowOwnersByRig = new Map<string, Record<string, string>>();
    const restoreRunningRowOwnerRigIdsByRig = new Map<string, Record<string, string>>();
    const restoreRunningRowAdoptedByRig = new Map<string, Record<string, string> | null>();

    // Host-level checks — daemon probe throw produces unknown (not not_restorable).
    // Daemon definitely-down (healthy=false, negative text) is red/not_restorable.
    // Daemon probe exception (socket unavailable, etc.) is unknown.
    const daemonCheck = this.checkDaemonReachable();
    if (daemonCheck === null) {
      // Probe threw — state is uninspectable
      return this.buildUnknown([
        { check: "daemon.reachable", status: "red", evidence: "Daemon health probe failed (unable to determine state)", remediation: "Start the daemon with: rig daemon start",
      remediationSafe: false },
      ]);
    }
    checks.push(daemonCheck);
    checks.push(this.checkStateDirWritable());
    const hostInfraCheck = this.checkHostInfraDeclaration();
    checks.push(hostInfraCheck.check);

    // Get rigs — probe error produces unknown, not not_restorable
    let rigs: Array<{ rigId: string; name: string; hasServices?: boolean }>;
    try {
      rigs = this.deps.listRigs();
    } catch (err) {
      return this.buildUnknown([
        ...checks,
        { check: "probe.error", status: "red", evidence: `Failed to list rigs: ${err instanceof Error ? err.message : String(err)}`, remediation: "Check daemon status with: rig daemon status", remediationSafe: true },
      ]);
    }

    if (opts.rig) {
      rigs = rigs.filter((r) => r.name === opts.rig);
      if (rigs.length === 0) {
        return this.buildResult([
          ...checks,
          { check: `rig.${opts.rig}.exists`, status: "red", evidence: `Rig "${opts.rig}" not found`, remediation: "List rigs with: rig ps", remediationSafe: true },
        ], [], hostInfraCheck.hostInfra);
      }
    }

    // Per-rig checks
    for (const rig of rigs) {
      const rigChecks: CheckEntry[] = [];

      const snapshotCheck = this.checkSnapshot(rig);
      checks.push(snapshotCheck);
      rigChecks.push(snapshotCheck);

      // Rig spec/root check
      const specCheck = this.checkSpecPresent(rig);
      checks.push(specCheck);
      rigChecks.push(specCheck);

      // Per-seat checks — probe error produces unknown, not not_restorable
      let nodes: NodeInventoryEntry[];
      try {
        nodes = this.deps.getNodeInventory(rig.rigId);
      } catch (err) {
        return this.buildUnknown([
          ...checks,
          { check: "probe.error", status: "red", evidence: `Failed to get node inventory for ${rig.name}: ${err instanceof Error ? err.message : String(err)}`, remediation: "Check daemon status" },
        ]);
      }

      // No added snapshot/history read on a routine status poll for an all-ready rig.
      // Explicit restore-check still assesses its next restore, even while it is running.
      let preconditionError: string | undefined;
      const allReady = nodes.length > 0 && nodes.every((node) =>
        seatRunningReady(node, liveness)
      );
      const restoreRuns = restoreRunsFor(running.get(rig.rigId), nodes);
      restoreRefusedByRig.set(rig.rigId, restoreRuns === "refused");
      restoreRunningRowsByRig.set(rig.rigId, restoreRunningRowsFor(running.get(rig.rigId)));
      restoreRunningRowNamesByRig.set(rig.rigId, refusingRowNames(running.get(rig.rigId)));
      restoreRunningRowOwnersByRig.set(rig.rigId, refusingRowOwners(running.get(rig.rigId)));
      restoreRunningRowOwnerRigIdsByRig.set(rig.rigId, refusingRowOwnerRigIds(running.get(rig.rigId)));
      restoreRunningRowAdoptedByRig.set(rig.rigId, refusingRowAdopted(running.get(rig.rigId)));
      if (!opts.recoveryOnly || !allReady) {
        const preconditions = this.checkRestorePreconditions(rig, opts, listedRefusals.get(rig.rigId), restoreRuns);
        checks.push(preconditions.check);
        rigChecks.push(preconditions.check);
        preconditionError = preconditions.error;
        restoreInputsByRig.set(rig.rigId, { snapshot: preconditions.snapshot, error: preconditions.error });
        if (preconditions.launchRule) launchRuleByRig.set(rig.rigId, preconditions.launchRule);
        // OF-62: restore refuses the whole rig at its pre-restore snapshot while a seat's saved row is damaged, however
        // clean the snapshot it would restore from is. Judged where the preconditions are (same gate), so a routine poll of
        // an all-ready rig does not ask.
        const damagedRows = this.checkSavedRows(rig);
        if (damagedRows) {
          checks.push(damagedRows);
          rigChecks.push(damagedRows);
        }
      }

      for (const node of nodes) {
        const readinessCheck = this.checkSeatReadiness(node, liveness, restoreRuns === "refused", rig.name);
        checks.push(readinessCheck);
        rigChecks.push(readinessCheck);

        // OPR.0.4.0.29: in default compact, ready (green) seats SKIP full per-seat
        // detail assembly — the FR-3/AC-4 compute "look-above" win (transcript,
        // resume, queue, hooks are NOT probed). But the FR-8 summary still needs
        // the restore-readiness caveat signal: a running/ready seat whose startup
        // context is missing/unrestorable is ready_with_caveats, not ready. So we
        // compute ONLY checkStartupContext for every seat and feed it to the rig
        // rollup (rigChecks); it is emitted to the top-level `checks` only when we
        // are not skipping (full, --ready/includeReady, or a non-ready seat).
        const omitReadyDetail = opts.compact && !opts.includeReady && readinessCheck.status === "green";

        const startupContextCheck = this.checkStartupContext(node);
        if ("unknownChecks" in startupContextCheck) {
          return this.buildUnknown([
            ...checks,
            ...startupContextCheck.unknownChecks,
          ]);
        }
        rigChecks.push(startupContextCheck.check);
        if (omitReadyDetail) {
          // Not emitted (AC-4 token-safe), but counts toward the top-level
          // verdict/readiness/counts (rev1-r2 no-false-ready).
          deferredAssessmentChecks.push(startupContextCheck.check);
        } else {
          checks.push(startupContextCheck.check);
        }

        // OF-69: a seat that is not running is started by restore through the launcher, which refuses a folder that is
        // gone (tmux would start it in $HOME). Say so here, where the plan and the launch must agree.
        // OF-125: the plan's rule (restore-plan-preview.ts): only a seat restore would START is judged. A seat that is bound
        // (running, even if tmux is briefly unreadable) is not started, and neither is one restore stops at a gate. OF-128 L7:
        // a seat with no live cwd is started in the snapshot's, so that folder is the one judged.
        const launch = launchRuleByRig.get(rig.rigId);
        const restoreStartsSeat = !node.attachmentType && !launch?.stoppedSeats.has(node.logicalId);
        const seatCwd = node.cwd ?? launch?.snapshotCwd.get(node.logicalId) ?? null;
        // OF-124: a project rig's own missing workspace is recreated by the launch, so it is not a fault to report.
        const cwdFault = readinessCheck.status !== "green" && restoreStartsSeat && seatCwd
          && !projectRigWorkspaceRecreatable(rig.name, node.logicalId, seatCwd) ? getSeatCwdFault(seatCwd) : null;
        if (seatCwd && cwdFault) {
          const cwdCheck: CheckEntry = {
            check: `seat.${node.canonicalSessionName ?? node.logicalId}.cwd`,
            status: "red",
            evidence: seatCwdUnusableMessage(node.logicalId, seatCwd, cwdFault),
            remediation: `${seatCwdFixAdvice(seatCwd, cwdFault)}, then rerun rig restore-check`,
            remediationSafe: false,
          };
          checks.push(cwdCheck);
          rigChecks.push(cwdCheck);
        }

        // AC-4 / FR-3: default compact does NOT assemble the rest of the
        // ready-seat detail (the genuine compute skip, not a post-assembly hide).
        if (omitReadyDetail) {
          continue;
        }

        const transcriptCheck = this.checkTranscript(rig.name, node);
        checks.push(transcriptCheck);
        rigChecks.push(transcriptCheck);

        const resumeCheck = this.checkResumePath(node, rig.name);
        checks.push(resumeCheck);
        rigChecks.push(resumeCheck);

        if (!opts.noQueue) {
          const queueCheck = this.checkQueueStore(node);
          checks.push(queueCheck);
          rigChecks.push(queueCheck);
        }
        if (!opts.noHooks) {
          const hooksCheck = this.checkHooks(node);
          checks.push(hooksCheck);
          rigChecks.push(hooksCheck);
        }
      }

      rigRollupInputs.push({ liveness, rig, nodes, checks: rigChecks, preconditionError });
    }

    const internalRollups = rigRollupInputs.map((input) => this.buildRigRollup(input));
    const rigRollups: RigRestoreRollup[] = internalRollups.map(({ liveRunningSeats: _a, liveUnrecordedSeats: _b, reattachSeats: _r, unknownAdoptedSeats: _ua, deadSeatIds: _c, unknownLivenessSeats: _unknown, ...rollup }) => rollup);
    for (const rollup of internalRollups) {
      const latestSnapshot = restoreInputsByRig.get(rollup.rigId) ?? this.inspectLatestSnapshot(rollup.rigId);
      recoveryRigInputs.push({
        rigId: rollup.rigId,
        rigName: rollup.rigName,
        expectedNodes: rollup.expectedNodes,
        runningReadyNodes: rollup.runningReadyNodes,
        blockingChecks: rollup.blockingChecks,
        latestSnapshot: latestSnapshot.snapshot,
        snapshotLookupError: latestSnapshot.error,
        liveRunningSeats: rollup.liveRunningSeats,
        liveUnrecordedSeats: rollup.liveUnrecordedSeats,
        reattachSeats: rollup.reattachSeats,
        unknownAdoptedSeats: rollup.unknownAdoptedSeats,
        deadSeatIds: rollup.deadSeatIds,
        unknownLivenessSeats: rollup.unknownLivenessSeats,
        restoreRefused: restoreRefusedByRig.get(rollup.rigId) ?? false,
        restoreRunningRows: restoreRunningRowsByRig.get(rollup.rigId) ?? "not_asked",
        restoreRunningRowNames: restoreRunningRowNamesByRig.get(rollup.rigId) ?? [],
        restoreRunningRowOwners: restoreRunningRowOwnersByRig.get(rollup.rigId) ?? {},
        restoreRunningRowOwnerRigIds: restoreRunningRowOwnerRigIdsByRig.get(rollup.rigId) ?? {},
        restoreRunningRowAdopted: restoreRunningRowAdoptedByRig.get(rollup.rigId) ?? null,
      });
    }

    return this.buildResult(checks, rigRollups, hostInfraCheck.hostInfra, recoveryRigInputs, deferredAssessmentChecks);
  }

  /** OF-62: red naming each seat whose saved row is damaged; null when none is (or the check cannot be asked). */
  private checkSavedRows(rig: { rigId: string; name: string }): CheckEntry | null {
    if (!this.deps.getSavedRowDamage) return null;
    const check = `rig.${rig.name}.saved-rows`;
    let damaged: Array<{ logicalId: string; damage: string[] }>;
    try {
      damaged = this.deps.getSavedRowDamage(rig.rigId);
    } catch (err) {
      // Never read as "no damage": an unanswered question is reported yellow.
      return {
        check, status: "yellow",
        evidence: `Saved seat rows were not inspected for ${rig.name}: ${err instanceof Error ? err.message : String(err)}`,
        remediation: "Retry; or run the restore and read the refusal it gives", remediationSafe: true,
      };
    }
    if (damaged.length === 0) return null;
    return {
      check, status: "red",
      evidence: `Restore would refuse ${rig.name}: its pre-restore snapshot cannot be taken because ${damaged.map((seat) => savedRowDamageMessage(seat.logicalId, seat.damage)).join("; ")}`,
      remediation: `Repair the damaged saved row${damaged.length > 1 ? "s" : ""} (${damaged.map((seat) => seat.logicalId).join(", ")}), then check again; restore and snapshot refuse until then`,
      remediationSafe: false,
    };
  }

  private checkRestorePreconditions(rig: { rigId: string; name: string }, opts: RestoreCheckOpts = {}, listedRefusals?: Map<string, string> | Error, restoreRuns: RestoreRuns = "would_run"): {
    check: CheckEntry;
    snapshot: { id: string; kind: string } | null;
    error?: string;
    launchRule?: LaunchRule;
  } {
    const check = `rig.${rig.name}.restore-preconditions`;
    try {
      const input = this.deps.getRestoreInputs(rig.rigId);
      if ("unavailable" in input) throw new Error(input.unavailable);
      if ("currentStateRehydrate" in input) {
        // OF-47: restore's seat gate on which saved session is the seat's (active-occupant ambiguity) applies to the
        // snapshot restore will capture from current state. Like every seat gate it is predicted only when restore runs.
        const occupantStops = restoreRuns === "would_run" ? input.currentStateRehydrate.occupantStops ?? [] : [];
        const blockers = [...input.currentStateRehydrate.blockers, ...occupantStops];
        const ok = input.currentStateRehydrate.ok && occupantStops.length === 0;
        return {
          snapshot: null,
          check: {
            check,
            status: ok ? "yellow" : "red",
            evidence: ok
              ? `${input.reason}; restore inputs not inspected. Current-state rehydrate is eligible to attempt: ordinary rig up would capture current state. This does not validate that future snapshot or prove native continuity.`
              : `${input.reason}; current-state rehydrate is not eligible: ${blockers.join("; ")}`,
            remediation: "Inspect the rig's persisted state before choosing manual recovery",
            remediationSafe: true,
          },
        };
      }
      // OF-32: predict the restore this check advises (`rig up --existing`, no seat listed with --fresh) as it decides:
      // a seat it starts fresh comes back on its own saved setup, and replays the snapshot's copy only when it has none
      // (or it cannot be read). Restore finds the seat by logical id and reads the LIVE node's saved context (a seat
      // removed and grown back has a new node id); predict it the same way.
      const liveNodeIdByLogicalId = new Map(this.deps.getNodeInventory(rig.rigId).map((entry) => [entry.logicalId, entry.nodeId]));
      const parity = this.deps.restoreParity;
      const listed = { freshLogicalIds: opts.freshLogicalIds, startupFrom: opts.startupFrom };
      const validation = validatePreRestore(input.snapshot.data, {
        fsOps: { exists: this.deps.exists },
        servicesRecord: input.servicesRecord,
        ...(parity && opts.freshLogicalIds?.length ? { freshLogicalIds: opts.freshLogicalIds } : {}),
        ...(parity?.seatGateInputs ? { seatGateInputs: parity.seatGateInputs(rig.rigId, input.snapshot.data) } : {}),
        freshSeatStartup: (node) => {
          if (parity) {
            // The same function restore validates with (OF-36): for a seat this restore starts fresh, what it replays (its
            // own saved context, or the newest usable snapshot copy when that cannot be used), or restore's own refusal
            // when nothing can be used; validatePreRestore turns that into the same blocker restore reports.
            return parity.startupToValidate(rig.rigId, node.logicalId, listed, input.snapshot.data.nodeStartupContext?.[node.id] ?? null);
          }
          const liveId = liveNodeIdByLogicalId.get(node.logicalId);
          const saved = liveId ? this.deps.getStartupContext(liveId) : null;
          return saved?.status === "ok"
            ? { replay: { projectionEntries: saved.projectionEntries, resolvedStartupFiles: saved.resolvedStartupFiles, startupActions: [], runtime: saved.runtime ?? "" } as unknown as NodeStartupSnapshot }
            : undefined;
        },
      });
      const { blockers, warnings } = validation;
      // OF-125 / OF-128 L7: what the per-seat cwd check needs from this snapshot (see LaunchRule).
      const launchRule: LaunchRule = {
        stoppedSeats: new Set<string>(),
        snapshotCwd: new Map((input.snapshot.data.nodes ?? []).map((saved) => [saved.logicalId, saved.cwd ?? null] as const)),
      };
      // OF-40: the gates restore runs before it looks at a seat's startup files, asked of the function restore calls.
      // Restore reaches them only when it runs at all (it refuses a rig with a live seat, rig_not_stopped, before any
      // seat) and only when pre-restore validation passed (a validation blocker already makes this red, and a snapshot
      // that malformed cannot be walked), so they are predicted only then.
      let gatesNotPredicted = false;
      if (parity && restoreRuns === "unknown" && blockers.length === 0) {
        // Whether restore would run (or refuse the rig for a live seat) was not read, so what it would do at each seat
        // cannot be predicted: never green.
        gatesNotPredicted = true;
        warnings.push("restore's seat gates were not predicted: tmux was not read, so whether restore would run or refuse the rig for a running seat is unknown");
      }
      if (parity && restoreRuns === "would_run" && blockers.length === 0) {
        for (const [logicalId, stop] of parity.predictSeatStops(rig.rigId, input.snapshot.data, listed)) {
          launchRule.stoppedSeats.add(logicalId);
          blockers.push({
            code: stop.gate === "node_removed" ? "seat_removed" : "seat_stopped_before_launch",
            severity: "critical",
            logicalId,
            target: "restore-seat-gate",
            message: `Restore would not start ${logicalId} (${stop.status}): ${stop.error}`,
            remediation: stop.gate === "node_removed"
              ? `Add ${logicalId} back to the rig, or restore a snapshot taken after it was removed; restore does not recreate removed nodes`
              : stop.gate === "runtime_mismatch"
                ? `Restore a snapshot whose saved startup runtime matches ${logicalId}'s current runtime`
                : `Decide for ${logicalId} what restore must not guess: ${freshSeatLaunchCommand(logicalId, this.rigHandle(rig.rigId, rig.name), opts.startupFrom?.startsWith("snapshot:") ? undefined : opts.startupFrom)}, or restore the original session manually`,
          });
        }
      }
      if (listedRefusals instanceof Error) {
        // The prediction could not be asked. Never green: say so.
        return {
          snapshot: { id: input.snapshot.id, kind: input.snapshot.kind },
          launchRule,
          check: {
            check, status: blockers.length > 0 ? "red" : "yellow",
            evidence: `Snapshot ${input.snapshot.id}: could not predict which listed seats restore would refuse: ${listedRefusals.message}${blockers.length > 0 ? `; ${blockers.map((blocker) => `${blocker.code}: ${blocker.message}`).join("; ")}` : ""}`,
            remediation: "Retry; or run the restore and read the refusal it gives",
            remediationSafe: true,
          },
        };
      }
      for (const [logicalId, refusal] of listedRefusals ?? []) {
        blockers.push({
          code: "fresh_start_refused",
          severity: "critical",
          logicalId,
          target: "fresh-start",
          message: `Fresh start refused for ${logicalId}: ${refusal} No session would be started.`,
          remediation: parity?.listedRefusalRemedy?.(rig.rigId, logicalId, input.snapshot.data, { freshLogicalIds: opts.freshLogicalIds ?? [], startupFrom: opts.startupFrom ?? "spec" })
            ?? `Fix the cause above, or leave ${logicalId} out of --fresh`,
        });
      }
      return {
        snapshot: { id: input.snapshot.id, kind: input.snapshot.kind },
        launchRule,
        check: {
          check,
          status: blockers.length > 0 ? "red" : warnings.length > 0 || gatesNotPredicted ? "yellow" : "green",
          evidence: `Snapshot ${input.snapshot.id}: ${[
            ...blockers.map((blocker) => `${blocker.code}: ${blocker.message}`),
            ...warnings,
          ].join("; ") || "restore pre-validation passed (not a native resume proof)"}`,
          remediation: blockers.map((blocker) => blocker.remediation).join("; "),
          remediationSafe: false,
        },
      };
    } catch (err) {
      const error = `Restore preconditions unavailable for ${rig.name}: ${err instanceof Error ? err.message : String(err)}`;
      return {
        snapshot: null,
        error,
        check: { check, status: "yellow", evidence: error, remediation: "Inspect the rig's restore snapshot and persisted inputs before trusting restore", remediationSafe: true },
      };
    }
  }

  /** Returns CheckEntry on success/definite-down; null on probe exception
   *  (uninspectable state → caller should produce verdict: unknown). */
  private checkDaemonReachable(): CheckEntry | null {
    try {
      const probe = this.deps.probeDaemonHealth();
      // Anchored positive match: only "Daemon running" at line start is green.
      // Anything else (including "Daemon not running", empty output, or text
      // that contains "running" non-anchored) is red. This preserves the
      // reviewer fix from prototype 0e2af8d.
      if (probe.healthy && DAEMON_HEALTHY_PATTERN.test(probe.evidence)) {
        return { check: "daemon.reachable", status: "green", evidence: probe.evidence, remediation: "" };
      }
      return {
        check: "daemon.reachable", status: "red",
        evidence: probe.evidence || "Daemon health probe returned non-positive result",
        remediation: "Start the daemon with: rig daemon start",
      remediationSafe: false,
      };
    } catch {
      // Probe threw — return null to signal uninspectable state
      return null;
    }
  }

  private checkStateDirWritable(): CheckEntry {
    const stateDir = getCompatibleOpenRigPath("");
    try {
      // Non-mutating permission probe — no file creation/deletion.
      // accessSync throws if the directory is not writable.
      accessSync(stateDir, constants.W_OK);
      return { check: "host.state-dir-writable", status: "green", evidence: `${stateDir} is writable`, remediation: "" };
    } catch {
      return {
        check: "host.state-dir-writable", status: "red",
        evidence: `${stateDir} is not writable`,
        remediation: `Fix permissions: chmod u+w ${stateDir}`,
      remediationSafe: false,
      };
    }
  }

  private checkHostInfraDeclaration(): HostInfraCheckResult {
    const declarationPath = getCompatibleOpenRigPath("host-infra.json");
    const check = "host.bootstrap-autostart.declaration";

    try {
      if (!this.deps.exists(declarationPath)) {
        const evidence = `Host infra declaration missing at ${declarationPath}`;
        return {
          check: {
            check,
            status: "yellow",
            evidence,
            remediation: `Create host infra declaration at ${declarationPath}`,
            remediationSafe: false,
          },
          hostInfra: {
            status: "not_declared",
            evidence,
          },
        };
      }

      let raw: string;
      try {
        raw = this.deps.readFile(declarationPath);
      } catch (err) {
        const evidence = `Host infra declaration inspection failed at ${declarationPath}: ${err instanceof Error ? err.message : String(err)}`;
        return {
          check: {
            check,
            status: "yellow",
            evidence,
            remediation: `Inspect or fix host infra declaration at ${declarationPath}`,
            remediationSafe: false,
          },
          hostInfra: {
            status: "unknown",
            evidence,
          },
        };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        const evidence = `Host infra declaration JSON parse failed at ${declarationPath}: ${err instanceof Error ? err.message : String(err)}`;
        return {
          check: {
            check,
            status: "yellow",
            evidence,
            remediation: `Fix host infra declaration JSON at ${declarationPath}`,
            remediationSafe: false,
          },
          hostInfra: {
            status: "not_declared",
            evidence,
          },
        };
      }

      const validation = this.validateHostInfraDeclaration(parsed);
      if (validation.errors.length > 0) {
        const evidence = `Invalid host infra declaration at ${declarationPath}: missing/invalid ${validation.errors.join(", ")}`;
        return {
          check: {
            check,
            status: "yellow",
            evidence,
            remediation: `Fix host infra declaration shape at ${declarationPath}`,
            remediationSafe: false,
          },
          hostInfra: {
            status: "not_declared",
            evidence,
          },
        };
      }

      if (validation.schemaVersion === 2 && validation.evidenceProblems.length > 0) {
        const evidence = `Host infra declaration at ${declarationPath} declared with insufficient evidence paths; ${validation.evidenceProblems.join("; ")}`;
        return {
          check: {
            check,
            status: "yellow",
            evidence,
            remediation: `Add or repair host infra evidence path(s): ${validation.evidenceProblems.join("; ")}`,
            remediationSafe: false,
          },
          hostInfra: {
            status: "declared",
            evidence,
          },
        };
      }

      const evidence = validation.schemaVersion === 2
        ? `Host infra declaration at ${declarationPath} declared, evidence paths present, not autostart verified; daemonBootstrap mechanism=${validation.mechanism}; requiredSupportingInfra=${validation.requiredSupportingInfra}; evidencePaths=${validation.evidencePaths.join(", ")}`
        : `Host infra declaration at ${declarationPath} declared, not verified; daemonBootstrap mechanism=${validation.mechanism}; requiredSupportingInfra=${validation.requiredSupportingInfra}`;
      return {
        check: {
          check,
          status: "green",
          evidence,
          remediation: "",
        },
        hostInfra: {
          status: "declared",
          evidence,
        },
      };
    } catch (err) {
      const evidence = `Host infra declaration inspection failed at ${declarationPath}: ${err instanceof Error ? err.message : String(err)}`;
      return {
        check: {
          check,
          status: "yellow",
          evidence,
          remediation: `Inspect or fix host infra declaration at ${declarationPath}`,
          remediationSafe: false,
        },
        hostInfra: {
          status: "unknown",
          evidence,
        },
      };
    }
  }

  private validateHostInfraDeclaration(value: unknown): {
    errors: string[];
    schemaVersion: 1 | 2 | null;
    mechanism: string;
    requiredSupportingInfra: number;
    evidencePaths: string[];
    evidenceProblems: string[];
  } {
    const errors: string[] = [];
    const evidencePaths: string[] = [];
    const evidenceProblems: string[] = [];
    const obj = isRecord(value) ? value : null;
    if (obj === null) {
      return {
        errors: ["schemaVersion", "daemonBootstrap.mechanism", "supportingInfra"],
        schemaVersion: null,
        mechanism: "unknown",
        requiredSupportingInfra: 0,
        evidencePaths,
        evidenceProblems,
      };
    }

    const schemaVersion = obj["schemaVersion"] === 1 || obj["schemaVersion"] === 2
      ? obj["schemaVersion"]
      : null;
    if (schemaVersion === null) {
      errors.push("schemaVersion");
    }

    const daemonBootstrap = isRecord(obj["daemonBootstrap"]) ? obj["daemonBootstrap"] : null;
    const mechanism = daemonBootstrap && typeof daemonBootstrap["mechanism"] === "string"
      ? daemonBootstrap["mechanism"].trim()
      : "";
    if (!mechanism) {
      errors.push("daemonBootstrap.mechanism");
    }
    if (daemonBootstrap?.["declared"] !== true) {
      errors.push("daemonBootstrap.declared");
    }

    const supportingInfra = Array.isArray(obj["supportingInfra"]) ? obj["supportingInfra"] : null;
    if (!supportingInfra) {
      errors.push("supportingInfra");
    }
    const requiredSupportingInfra = supportingInfra
      ? supportingInfra.filter((entry) => isRecord(entry) && entry["required"] === true).length
      : 0;

    if (schemaVersion === 2 && errors.length === 0) {
      this.collectRequiredEvidencePaths(
        "daemonBootstrap.evidencePaths",
        daemonBootstrap?.["evidencePaths"],
        evidencePaths,
        evidenceProblems,
      );

      supportingInfra?.forEach((entry, index) => {
        if (!isRecord(entry) || entry["required"] !== true) return;
        const id = typeof entry["id"] === "string" && entry["id"].trim()
          ? entry["id"].trim()
          : String(index);
        this.collectRequiredEvidencePaths(
          `supportingInfra[${id}].evidencePaths`,
          entry["evidencePaths"],
          evidencePaths,
          evidenceProblems,
        );
      });
    }

    return {
      errors,
      schemaVersion,
      mechanism: mechanism || "unknown",
      requiredSupportingInfra,
      evidencePaths,
      evidenceProblems,
    };
  }

  private collectRequiredEvidencePaths(
    label: string,
    value: unknown,
    evidencePaths: string[],
    evidenceProblems: string[],
  ): void {
    if (!Array.isArray(value) || value.length === 0) {
      evidenceProblems.push(`${label} missing or empty`);
      return;
    }

    for (const candidate of value) {
      if (typeof candidate !== "string" || candidate.trim() === "") {
        evidenceProblems.push(`${label} contains invalid evidence path ${String(candidate)}`);
        continue;
      }

      const resolved = this.resolveHostInfraEvidencePath(candidate.trim());
      if ("error" in resolved) {
        evidenceProblems.push(`${label} invalid evidence path ${candidate}: ${resolved.error}`);
        continue;
      }

      const resolvedPath = resolved.path;
      evidencePaths.push(resolvedPath);
      if (!this.deps.exists(resolvedPath)) {
        evidenceProblems.push(`${label} missing evidence path ${resolvedPath}`);
      }
    }
  }

  private resolveHostInfraEvidencePath(rawPath: string): { path: string; error?: undefined } | { path?: undefined; error: string } {
    const openRigPrefix = "${OPENRIG_HOME}/";
    const hasTraversal = rawPath.split(/[\\/]+/).includes("..");

    if (rawPath.startsWith(openRigPrefix)) {
      const relativePath = rawPath.slice(openRigPrefix.length);
      if (!relativePath || isAbsolute(relativePath) || hasTraversal) {
        return { error: "path traversal or empty OPENRIG_HOME-relative path rejected" };
      }
      const openRigHome = getCompatibleOpenRigPath("");
      const resolved = join(openRigHome, relativePath);
      const relativeToHome = relative(openRigHome, resolved);
      if (relativeToHome === ".." || relativeToHome.startsWith(`..${sep}`) || isAbsolute(relativeToHome)) {
        return { error: "path traversal outside OPENRIG_HOME rejected" };
      }
      return { path: resolved };
    }

    if (!isAbsolute(rawPath)) {
      return { error: "plain relative evidence paths are rejected; use absolute or ${OPENRIG_HOME}/..." };
    }
    if (hasTraversal) {
      return { error: "path traversal evidence paths are rejected" };
    }
    return { path: rawPath };
  }

  private checkSnapshot(rig: { rigId: string; name: string }): CheckEntry {
    try {
      const has = this.deps.hasSnapshot(rig.rigId);
      if (has) {
        return { check: `rig.${rig.name}.snapshot`, status: "green", evidence: "Snapshot available", remediation: "" };
      }
      // OF-117: a rig whose only snapshots are damaged is not a first-boot rig; say so, and what to do about it.
      const damaged = this.deps.countDamagedSnapshots?.(rig.rigId) ?? 0;
      if (damaged > 0) {
        return {
          check: `rig.${rig.name}.snapshot`, status: "yellow",
          evidence: `No readable snapshot: ${damaged} saved snapshot${damaged === 1 ? " is" : "s are"} damaged (the saved data is not JSON), so none can be restored`,
          remediation: "Create a new snapshot with: rig snapshot <rigId> (see the damaged ones with: rig snapshot list <rigId>)",
          remediationSafe: false,
        };
      }
      return {
        check: `rig.${rig.name}.snapshot`, status: "yellow",
        evidence: "No snapshot found (first-boot or adopted rig)",
        remediation: "Create a snapshot with: rig snapshot <rigId>",
      remediationSafe: false,
      };
    } catch {
      return { check: `rig.${rig.name}.snapshot`, status: "yellow", evidence: "Could not check snapshots", remediation: "" };
    }
  }

  private checkTranscript(rigName: string, node: NodeInventoryEntry): CheckEntry {
    const session = node.canonicalSessionName ?? node.logicalId;
    const check = `seat.${session}.transcript`;

    // Terminal/infrastructure nodes are exempt from transcript checks
    if (node.nodeKind === "infrastructure") {
      return { check, status: "green", evidence: "Terminal/infrastructure node — transcript exempt", remediation: "" };
    }

    const transcriptPath = join(
      getCompatibleOpenRigPath("transcripts"),
      rigName,
      `${session}.log`
    );
    if (this.deps.exists(transcriptPath)) {
      return { check, status: "green", evidence: `Transcript exists at ${transcriptPath}`, remediation: "" };
    }
    return {
      check, status: "yellow",
      evidence: `Transcript missing: ${transcriptPath}`,
      remediation: "Transcript will be created on next session launch",
      remediationSafe: true,
    };
  }

  private checkSeatReadiness(node: NodeInventoryEntry, liveness: Map<string, SeatLiveness>, restoreRefused = false, rigName = ""): CheckEntry {
    const session = node.canonicalSessionName ?? node.logicalId;
    const check = `seat.${session}.readiness`;
    // OF-47: restore (rig up --existing) is offered as a way back only when restore's own rule lets it run.
    // OF-53: the two ways back are named as commands. `rig seat launch --fresh` starts a new conversation; restore resumes it.
    const relaunch = freshSeatLaunchCommand(node.logicalId, this.rigHandle(node.rigId, rigName));
    const restoreOrRelaunch = restoreRefused
      ? `Relaunch the seat with ${relaunch} (restore refuses this rig, rig_not_stopped, while a session row the DB shows running is live or unreadable; see the rig's recovery entry)`
      : `Restore the seat with rig up --existing ${shellQuote(this.rigHandle(node.rigId, rigName))} (resumes its conversation), or relaunch only this seat with ${relaunch} (starts a new conversation)`;

    if (!node.canonicalSessionName) {
      return {
        check,
        status: "red",
        evidence: "Missing canonical session identity",
        remediation: `${restoreOrRelaunch}, so it has a canonical session identity`,
        remediationSafe: false,
      };
    }

    if (node.sessionStatus === "running" && node.storedStartupStatus === "ready"
      && node.startupStatus === "attention_required"
      && (node.identityVerdict?.verdict === "mismatch" || node.identityVerdict?.verdict === "pane_missing")) {
      return {
        check,
        status: "red",
        evidence: `Seat identity needs verification: verdict=${node.identityVerdict.verdict} reason=${node.identityVerdict.reason ?? "unknown"}; stored startupStatus=ready`,
        remediation: node.identityVerdict.verdict === "mismatch"
          ? "Verify the current pane identity, then use rig seat clear-attention for this seat and rerun rig restore-check"
          : `If the seat's tmux session or pane is gone, ${restoreOrRelaunch.charAt(0).toLowerCase()}${restoreOrRelaunch.slice(1)}; if it now runs in another pane of its session, rig seat clear-attention for this seat rebinds and verifies it. Then rerun rig restore-check.`,
        remediationSafe: false,
      };
    }

    const tmux = liveness.get(node.canonicalSessionName);
    const dbReady = node.sessionStatus === "running" && node.startupStatus === "ready";

    if (dbReady && tmux === "dead") {
      return {
        check,
        status: "red",
        evidence: `Seat not running/ready: DB says sessionStatus=running startupStatus=ready but tmux session ${node.canonicalSessionName} is absent (stale DB state)`,
        remediation: `${restoreOrRelaunch}, then rerun rig restore-check`,
        remediationSafe: false,
      };
    }

    if (dbReady && tmux === "unreadable") {
      return {
        check,
        status: "yellow",
        evidence: `Seat tmux liveness unknown: DB says running/ready but tmux session ${node.canonicalSessionName} could not be read`,
        remediation: "Check that tmux is reachable, then rerun rig restore-check",
        remediationSafe: true,
      };
    }

    // z2 review F5: another seat's live row names this adopted session too. Restore fails the seat before asking tmux
    // (adopted_session_contested) and starts nothing, so the check says that, whatever tmux answered.
    const contested = !dbReady ? this.adoptedLeftRunning(node, "contested") : null;
    if (contested?.kind === "contested") {
      return {
        check,
        status: "red",
        evidence: `Adopted session ${contested.sessionName}, which rig down left running, is also the live session of seat ${contested.heldBy.seat} (row ${contested.heldBy.sessionId})`,
        remediation: `rig up --existing would fail this seat (adopted_session_contested): ${contestedAdoptedSessionReason(contested)}; then rerun rig restore-check`,
        remediationSafe: false,
      };
    }
    // OF-155 review F1: tmux cannot answer for an adopted session rig down left running. Restore fails such a seat
    // (adopted_liveness_unknown) and starts nothing, so the check says that, never "restore it".
    const adoptedUnknown = !dbReady && tmux === "unreadable" ? this.adoptedLeftRunning(node) : null;
    if (adoptedUnknown) {
      return {
        check,
        status: "red",
        evidence: `Adopted session ${adoptedUnknown.sessionName}, which rig down left running, could not be checked in tmux`,
        remediation: `rig up --existing would neither reattach it nor start this seat (adopted_liveness_unknown). Check that tmux is reachable, then rerun rig restore-check`,
        remediationSafe: false,
      };
    }
    const adopted = !dbReady && tmux === "live" ? this.adoptedLeftRunning(node) : null;
    if (adopted) {
      // OF-155: rig down left this adopted session running; rig up --existing reattaches it (option A), starting nothing.
      return {
        check,
        status: "yellow",
        evidence: `Adopted session ${adopted.sessionName} was left running by rig down (its row is detached and the seat's binding still names it)`,
        remediation: `rig up --existing reattaches it (reattached: ${adopted.sessionName}); nothing is started. To release it from this seat instead: rig unclaim ${adopted.sessionId}`,
        remediationSafe: true,
      };
    }

    if (!dbReady) {
      const latestError = node.latestError ? ` latestError=${node.latestError}` : "";
      const tmuxNote = tmux === "live" ? `; tmux session ${node.canonicalSessionName} is LIVE`
        : tmux === "unreadable" ? `; tmux liveness unknown (session ${node.canonicalSessionName} could not be read)`
        : "";
      return {
        check,
        status: "red",
        evidence: `Seat not running/ready: sessionStatus=${node.sessionStatus ?? "unknown"} startupStatus=${node.startupStatus ?? "unknown"}${latestError}${tmuxNote}`,
        remediation: tmux === "live"
          ? "The seat is live in tmux although the DB does not show it running; rig up --existing would be refused while a seat is live. Inspect with rig ps --nodes, then rerun rig restore-check"
          : `${restoreOrRelaunch}, then rerun rig restore-check`,
        remediationSafe: false,
      };
    }

    return {
      check,
      status: "green",
      evidence: `Seat running and ready: ${node.canonicalSessionName}`,
      remediation: "",
    };
  }

  /**
   * Report available seat attachment or a read-only restore-plan command.
   * Missing attachment does not establish whether an earlier token can resume.
   */
  private checkResumePath(node: NodeInventoryEntry, rigName: string): CheckEntry {
    const session = node.canonicalSessionName ?? node.logicalId;
    if (node.tmuxAttachCommand) {
      return { check: `seat.${session}.resume-path`, status: "green", evidence: node.tmuxAttachCommand, remediation: "" };
    }
    return {
      check: `seat.${session}.resume-path`, status: "yellow",
      evidence: "No attach command available",
      // Whether restore resumes, starts fresh or stops for a decision is per seat; the plan says which.
      remediation: `No live session to attach. Preview what restore would do for this seat with: rig up ${shellQuote(this.rigHandle(node.rigId, rigName))} --existing --plan`,
      remediationSafe: true,
    };
  }

  private checkStartupContext(node: NodeInventoryEntry): { check: CheckEntry } | { unknownChecks: CheckEntry[] } {
    const session = node.canonicalSessionName ?? node.logicalId;
    const check = `seat.${session}.startup-context`;
    const runningReady = node.sessionStatus === "running" && node.startupStatus === "ready";

    if (!node.nodeId) {
      return {
        check: this.buildStartupContextAvailabilityCheck(
          check,
          runningReady,
          `Startup context cannot be inspected because node id is missing for ${session}`,
        ),
      };
    }

    const probe = this.deps.getStartupContext(node.nodeId);
    switch (probe.status) {
      case "probe_error":
        return {
          unknownChecks: [{
            check: "probe.error",
            status: "red",
            evidence: `Failed to inspect startup context for ${session}: ${probe.evidence}`,
            remediation: "Check daemon logs with: rig daemon logs",
            remediationSafe: true,
          }],
        };
      case "missing":
      case "malformed":
        return {
          check: this.buildStartupContextAvailabilityCheck(check, runningReady, probe.evidence),
        };
      case "ok":
        break;
    }

    // #261: inspect (and report) the paths replay will actually use — recognized built-in startup
    // files and shipped-spec projection resources follow the running install.
    const startupContext = {
      ...probe,
      resolvedStartupFiles: probe.resolvedStartupFiles.map((file) => (
        typeof file.path === "string" && typeof file.ownerRoot === "string"
          ? reanchorBuiltinStartupFile({ ...file, path: file.path, ownerRoot: file.ownerRoot }, undefined, undefined, this.deps.exists)
          : file
      )),
      projectionEntries: probe.projectionEntries.map((entry) => (
        typeof entry.sourcePath === "string"
          ? reanchorShippedProjectionEntry({ ...entry, sourcePath: entry.sourcePath }, undefined, this.deps.exists)
          : entry
      )),
    };
    const missingRequired = startupContext.resolvedStartupFiles.filter((file) => file.required && !this.deps.exists(file.absolutePath));
    const missingOptional = startupContext.resolvedStartupFiles.filter((file) => !file.required && !this.deps.exists(file.absolutePath));
    const missingProjectionEntries = startupContext.projectionEntries.filter((entry) => !this.deps.exists(entry.absolutePath));

    if (missingRequired.length === 0 && missingOptional.length === 0 && missingProjectionEntries.length === 0) {
      const detailParts: string[] = [];
      if (startupContext.resolvedStartupFiles.length > 0) {
        detailParts.push(
          `resolved startup files present: ${startupContext.resolvedStartupFiles.map((file) => file.absolutePath).join(", ")}`
        );
      }
      if (startupContext.projectionEntries.length > 0) {
        detailParts.push(
          `projection source paths present: ${startupContext.projectionEntries.map((entry) => entry.absolutePath).join(", ")}`
        );
      }
      if (detailParts.length === 0) {
        detailParts.push("no persisted startup files or projection source paths declared");
      }
      return {
        check: {
          check,
          status: "green",
          evidence: `Startup context present for node ${node.nodeId}; ${detailParts.join("; ")}`,
          remediation: "",
        },
      };
    }

    const evidenceParts: string[] = [];
    if (missingRequired.length > 0) {
      evidenceParts.push(`missing required startup file(s): ${missingRequired.map((file) => file.absolutePath).join(", ")}`);
    }
    if (missingOptional.length > 0) {
      evidenceParts.push(`missing optional startup file(s): ${missingOptional.map((file) => file.absolutePath).join(", ")}`);
    }
    if (missingProjectionEntries.length > 0) {
      evidenceParts.push(`missing projection source path(s): ${missingProjectionEntries.map((entry) => entry.absolutePath).join(", ")}`);
    }

    const status: CheckStatus = missingRequired.length > 0 && !runningReady ? "red" : "yellow";
    return {
      check: {
        check,
        status,
        evidence: `Startup context present for node ${node.nodeId}, but replay inputs are incomplete: ${evidenceParts.join("; ")}`,
        remediation: `Restore or recreate the missing startup inputs from the rig or agent spec before trusting replay: ${[
          ...missingRequired.map((file) => file.absolutePath),
          ...missingOptional.map((file) => file.absolutePath),
          ...missingProjectionEntries.map((entry) => entry.absolutePath),
        ].join(", ")}`,
        remediationSafe: false,
      },
    };
  }

  private buildStartupContextAvailabilityCheck(
    check: string,
    runningReady: boolean,
    evidence: string,
  ): CheckEntry {
    return {
      check,
      status: runningReady ? "yellow" : "red",
      evidence,
      remediation: "Recreate the seat startup context from the rig or agent spec before trusting replay inputs",
      remediationSafe: false,
    };
  }

  private checkQueueStore(node: NodeInventoryEntry): CheckEntry {
    const session = node.canonicalSessionName ?? node.logicalId;
    const check = `seat.${session}.queue-store`;
    let probe: QueueStoreProbeResult | undefined;
    try {
      probe = this.deps.probeQueueStore?.();
    } catch (err) {
      probe = {
        available: false,
        evidence: `Daemon SQLite queue_items store probe failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (probe?.available) {
      return { check, status: "green", evidence: probe.evidence, remediation: "" };
    }
    return {
      check, status: "yellow",
      evidence: probe?.evidence ?? "Daemon SQLite queue store could not be inspected",
      remediation: "Restore the daemon SQLite queue store before relying on queue continuity",
      remediationSafe: false,
    };
  }

  private checkHooks(node: NodeInventoryEntry): CheckEntry {
    const session = node.canonicalSessionName ?? node.logicalId;

    if (node.nodeKind !== "agent") {
      return {
        check: `seat.${session}.hooks`, status: "green",
        evidence: "Infrastructure/terminal node; Claude Code hook inspection not applicable",
        remediation: "",
      };
    }

    if (node.runtime !== "claude-code") {
      return {
        check: `seat.${session}.hooks`, status: "green",
        evidence: `${node.runtime ?? "non-Claude"} seat; Claude Code hook inspection not applicable`,
        remediation: "",
      };
    }

    // Current Claude activity hooks are selected as a runtime resource and
    // delivered by ClaudeCodeAdapter: settings in the seat CWD, relay in instance state.
    // Do not require the retired internal control-plane shell hooks on public installs.
    const startup = node.nodeId ? this.deps.getStartupContext(node.nodeId) : null;
    if (startup?.status === "ok" && !startup.projectionEntries.some((entry) => (
      entry.category === "runtime_resource" && entry.resourceType === "claude_activity_hooks"
    ))) {
      return {
        check: `seat.${session}.hooks`, status: "green",
        evidence: "Claude activity hooks are not selected for this seat; hook inspection is not applicable",
        remediation: "",
      };
    }
    if (startup?.status === "ok") {
      if (!node.cwd) {
        return {
          check: `seat.${session}.hooks`, status: "yellow",
          evidence: "Claude activity hooks are selected, but seat cwd is unavailable for delivery inspection",
          remediation: "Restore the seat working directory before trusting activity-hook readiness",
          remediationSafe: false,
        };
      }
      const settingsPath = join(node.cwd, ".claude", "settings.local.json");
      const relayPath = claudeActivityRelayPath(this.deps.stateDir);
      const events = this.deps.getClaudeActivityHookEvents?.() ?? [];
      if (events.length === 0) {
        return {
          check: `seat.${session}.hooks`, status: "yellow",
          evidence: "Claude activity hook events could not be derived from the shipped manifest",
          remediation: "Restore the daemon's Claude activity-hook assets before trusting hook readiness",
          remediationSafe: false,
        };
      }
      if (!this.deps.exists(relayPath) || !this.deps.exists(settingsPath)) {
        return {
          check: `seat.${session}.hooks`, status: "yellow",
          evidence: `Claude activity hook delivery is incomplete: expected relay ${relayPath} and settings ${settingsPath}`,
          remediation: "Relaunch the seat to project its selected Claude activity hooks",
          remediationSafe: false,
        };
      }
      let settings: unknown;
      try {
        settings = JSON.parse(this.deps.readFile(settingsPath));
      } catch (err) {
        return {
          check: `seat.${session}.hooks`, status: "yellow",
          evidence: `Claude activity-hook settings could not be trusted at ${settingsPath}: ${err instanceof Error ? err.message : String(err)}`,
          remediation: `Fix the Claude settings JSON at ${settingsPath}`,
          remediationSafe: false,
        };
      }
      if (isRecord(settings) && settings["disableAllHooks"] === true) {
        return {
          check: `seat.${session}.hooks`, status: "yellow",
          evidence: `Selected Claude activity hooks are explicitly disabled in ${settingsPath}; projection does not prove usable hooks`,
          remediation: "Review the intentional hook-disable setting before relying on activity-hook readiness",
          remediationSafe: false,
        };
      }
      const missingEvents = events.filter((event) => !this.hasActivityRelayHook(settings, event, relayPath));
      if (missingEvents.length === 0) {
        return {
          check: `seat.${session}.hooks`, status: "green",
          evidence: `Selected Claude activity hooks are projected in ${settingsPath}, with relay present at ${relayPath}; hook execution is not verified`,
          remediation: "",
        };
      }
      return {
        check: `seat.${session}.hooks`, status: "yellow",
        evidence: `Claude activity-hook settings at ${settingsPath} are missing relay entries for: ${missingEvents.join(", ")}`,
        remediation: "Relaunch the seat to project its selected Claude activity hooks",
        remediationSafe: false,
      };
    }

    return {
      check: `seat.${session}.hooks`, status: "yellow",
      evidence: startup?.status === "probe_error"
        ? `Claude activity-hook selection could not be inspected: ${startup.evidence}`
        : "Claude activity-hook selection could not be inspected because persisted startup context is unavailable",
      remediation: "Restore the seat startup context before trusting hook readiness",
      remediationSafe: false,
    };
  }

  private hasActivityRelayHook(settings: unknown, eventName: string, relayPath: string): boolean {
    if (!isRecord(settings) || !isRecord(settings["hooks"])) return false;
    const eventEntries = settings["hooks"][eventName];
    if (!Array.isArray(eventEntries)) return false;
    const contexts = eventName === "SessionStart" ? ["startup", "resume"]
      : eventName === "Notification" ? ["permission_prompt", "idle_prompt"] : [null];
    return contexts.every((context) => eventEntries.some((entry) => {
      if (!isRecord(entry) || !Array.isArray(entry["hooks"])) return false;
      if (context !== null && entry["matcher"] !== undefined && entry["matcher"] !== "" && entry["matcher"] !== "*") {
        if (typeof entry["matcher"] !== "string") return false;
        try {
          const matcher = entry["matcher"];
          const matches = /^[a-zA-Z0-9_\- ,|]+$/.test(matcher)
            ? matcher.split(/[|,]/).some((value) => value.trim() === context)
            : new RegExp(matcher).test(context);
          if (!matches) return false;
        }
        catch { return false; }
      }
      return entry["hooks"].some((hook) => (
        isRecord(hook) && hook["type"] === "command" && typeof hook["command"] === "string" &&
        hook["command"] === `node ${quoteShellArgument(relayPath)}`
      ));
    }));
  }

  private checkSpecPresent(rig: { rigId: string; name: string }): CheckEntry {
    // OPR.0.3.2.14 — subpath scrubbed (internal-team layout → generic placeholder).
    const substrateRoot = this.deps.substrateRoot ?? join(process.env["HOME"] ?? "~", ".openrig", "shared-docs");
    const rigRoot = join(substrateRoot, "rigs", rig.name);
    const rigYaml = join(rigRoot, "rig.yaml");

    if (!this.deps.exists(rigRoot)) {
      // A rig can launch from a spec anywhere, and restore reads the snapshot, never the spec,
      // so a spec this check cannot find is a caveat, not a blocker.
      return {
        check: `rig.${rig.name}.spec-present`, status: "yellow",
        evidence: `Not checked: no launch spec location could be established; looked for ${rigYaml}, and ${rigRoot} does not exist`,
        remediation: `Confirm where this rig's spec lives; restore-check only looks at ${rigYaml}`,
        remediationSafe: true,
      };
    }
    if (!this.deps.exists(rigYaml)) {
      return {
        check: `rig.${rig.name}.spec-present`, status: "yellow",
        evidence: `Rig root exists but rig.yaml missing: ${rigYaml}`,
        remediation: `Add a rig.yaml spec to ${rigRoot}`,
      remediationSafe: false,
      };
    }
    return { check: `rig.${rig.name}.spec-present`, status: "green", evidence: `Spec present at ${rigYaml}`, remediation: "" };
  }

  private inspectLatestSnapshot(rigId: string): { snapshot: { id: string; kind: string } | null; error?: string } {
    if (!this.deps.getLatestSnapshot) {
      return { snapshot: null };
    }

    try {
      const snapshot = this.deps.getLatestSnapshot(rigId);
      if (!snapshot) return { snapshot: null };
      return { snapshot: { id: snapshot.id, kind: snapshot.kind } };
    } catch (err) {
      return {
        snapshot: null,
        error: `Latest snapshot lookup failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private buildResult(
    checks: CheckEntry[],
    rigs: RigRestoreRollup[],
    hostInfra?: HostInfraAssertion,
    recoveryInputs: RecoveryRigInput[] = [],
    assessmentExtra: CheckEntry[] = [],
  ): RestoreCheckResult {
    // counts + verdict assess the FULL signal (emitted checks + any computed-but-
    // omitted ready-seat caveats) so default compact never reports a false ready;
    // repairPacket/recovery still operate on the EMITTED checks (token-safe).
    const assessed = assessmentExtra.length > 0 ? [...checks, ...assessmentExtra] : checks;
    const red = assessed.filter((c) => c.status === "red").length;
    const yellow = assessed.filter((c) => c.status === "yellow").length;
    const green = assessed.filter((c) => c.status === "green").length;

    let verdict: Verdict;
    if (red > 0) {
      verdict = "not_restorable";
    } else if (rigs.some((rig) => rig.status === "unknown")) {
      verdict = "unknown";
    } else if (yellow > 0) {
      verdict = "restorable_with_caveats";
    } else {
      verdict = "restorable";
    }

    const repairPacket = this.buildRepairPacket(checks, verdict);
    const recovery = this.buildRecovery(verdict, checks, recoveryInputs);
    return this.withAssertion({ verdict, counts: { red, yellow, green }, checks, repairPacket, recovery }, rigs, hostInfra);
  }

  /** Probe error produces verdict=unknown (not not_restorable) so operators
   *  can distinguish "definitely broken" from "checker couldn't inspect." */
  private buildUnknown(checks: CheckEntry[]): RestoreCheckResult {
    const red = checks.filter((c) => c.status === "red").length;
    const yellow = checks.filter((c) => c.status === "yellow").length;
    const green = checks.filter((c) => c.status === "green").length;
    const repairPacket = this.buildRepairPacket(checks, "unknown");
    const evidence = checks.find((check) => check.status === "red")?.evidence
      ?? "Restore-check state could not be inspected";
    return this.withAssertion({
      verdict: "unknown",
      counts: { red, yellow, green },
      checks,
      repairPacket,
      recovery: {
        status: "unknown",
        summary: "Recovery status could not be inspected because restore-check state is unknown.",
        actions: [],
        blocked: [],
        unknown: [{ scope: "host", reason: evidence }],
      },
    }, []);
  }

  private withAssertion(
    result: Pick<RestoreCheckResult, "verdict" | "counts" | "checks" | "repairPacket" | "recovery">,
    rigs: RigRestoreRollup[],
    hostInfra?: HostInfraAssertion,
  ): RestoreCheckResult {
    const blockingRigCount = rigs.filter((rig) => rig.blockedNodes > 0 || rig.blockingChecks.length > 0).length;
    const caveatRigCount = rigs.filter((rig) => rig.blockedNodes === 0 && rig.blockingChecks.length === 0 && (rig.caveatNodes > 0 || rig.caveatChecks.length > 0)).length;
    const unknownRigCount = rigs.filter((rig) => rig.status === "unknown").length;

    let readinessStatus: ReadinessStatus;
    let reason: string;
    if (result.verdict === "unknown") {
      readinessStatus = "unknown";
      reason = "unknown_probe_state";
    } else if (result.counts.red > 0) {
      readinessStatus = "not_ready";
      reason = "blockers_present";
    } else if (result.counts.yellow > 0) {
      readinessStatus = "ready_with_caveats";
      reason = "caveats_present";
    } else {
      readinessStatus = "ready";
      reason = hostInfra?.status === "declared"
        ? "all_observable_checks_green_host_infra_declared_not_verified"
        : "all_observable_checks_green";
    }

    // Continuity is always not_proven in v1 — no code path can produce "proven"
    const continuity: ContinuityAssertion = {
      status: "not_proven",
      evidence: "Strict same-session/provider-context resume is not verified by restore-check v1. Observable readiness is verified.",
      provenCapabilities: this.computeProvenCapabilities(result.checks),
      unprovenCapabilities: [
        "provider_session_resume",
        "context_window_preservation",
        "interrupted_work_functional_resume",
      ],
    };

    return {
      ...result,
      readiness: {
        status: readinessStatus,
        reason,
        blockingRigCount,
        caveatRigCount,
        unknownRigCount,
      },
      continuity,
      rigs,
      // FR-8: fleet-wide ready-confidence breakdown = sum of the per-rig class counts.
      classCounts: rigs.reduce<ReadinessClassCounts>((acc, r) => ({
        ready: acc.ready + r.classCounts.ready,
        ready_with_caveats: acc.ready_with_caveats + r.classCounts.ready_with_caveats,
        not_ready: acc.not_ready + r.classCounts.not_ready,
        attention_required: acc.attention_required + r.classCounts.attention_required,
        unknown: acc.unknown + r.classCounts.unknown,
      }), { ready: 0, ready_with_caveats: 0, not_ready: 0, attention_required: 0, unknown: 0 }),
      hostInfra: hostInfra ?? (result.verdict === "unknown"
        ? {
            status: "unknown",
            evidence: "Host bootstrap/autostart source could not be inspected because restore-check state is unknown",
          }
        : {
            status: "not_inspected",
            evidence: "No host bootstrap/autostart source inspected by v0; readiness only covers observable daemon, rig, and seat checks",
          }),
      recovery: result.recovery,
    };
  }

  /** Derive proven capabilities from green checks for the continuity block. */
  private computeProvenCapabilities(checks: CheckEntry[]): string[] {
    const proven: string[] = [];
    if (checks.some((c) => c.check === "daemon.reachable" && c.status === "green")) proven.push("daemon_reachable");
    if (checks.some((c) => c.check.endsWith(".transcript") && c.status === "green")) proven.push("transcript_readable");
    if (checks.some((c) => c.check.endsWith(".spec-present") && c.status === "green")) proven.push("spec_present");
    if (checks.some((c) => c.check.endsWith(".queue-store") && c.status === "green")) proven.push("queue_store_available");
    if (checks.some((c) => c.check.endsWith(".resume-path") && c.status === "green")) proven.push("seat_identity_resolvable");
    return proven;
  }

  private buildRecovery(
    verdict: Verdict,
    checks: CheckEntry[],
    recoveryInputs: RecoveryRigInput[],
  ): RecoveryPlan {
    if (verdict === "unknown" && recoveryInputs.length === 0) {
      const evidence = checks.find((check) => check.status === "red")?.evidence
        ?? "Restore-check state could not be inspected";
      return {
        status: "unknown",
        summary: "Recovery status could not be inspected because restore-check state is unknown.",
        actions: [],
        blocked: [],
        unknown: [{ scope: "host", reason: evidence }],
      };
    }

    if (recoveryInputs.length === 0) {
      const firstRed = checks.find((check) => check.status === "red");
      if (firstRed) {
        return {
          status: "blocked",
          summary: "No exact recovery action is known in v0 because restore-check found blockers outside runnable rig inventory.",
          actions: [],
          blocked: [{ scope: "host", reason: firstRed.evidence }],
          unknown: [],
        };
      }
      return {
        status: "not_needed",
        summary: "All observable rigs are already running/ready; no recovery action needed.",
        actions: [],
        blocked: [],
        unknown: [],
      };
    }

    const allReady = recoveryInputs.every((input) => !input.snapshotLookupError
      && input.runningReadyNodes === input.expectedNodes
      && this.restoreInputBlockers(input).length === 0);
    if (allReady) {
      return {
        status: "not_needed",
        summary: "All observable rigs are already running/ready; no recovery action needed.",
        actions: [],
        blocked: [],
        unknown: [],
      };
    }

    const actions: RecoveryAction[] = [];
    const blocked: RecoveryIssue[] = [];
    const unknown: RecoveryIssue[] = [];

    for (const input of recoveryInputs) {
      if (input.snapshotLookupError) {
        unknown.push({
          scope: "rig",
          rigId: input.rigId,
          rigName: input.rigName,
          reason: input.snapshotLookupError,
        });
        continue;
      }
      const restoreInputBlockers = this.restoreInputBlockers(input);
      if (restoreInputBlockers.length > 0) {
        blocked.push({
          scope: "rig",
          rigId: input.rigId,
          rigName: input.rigName,
          reason: `No exact recovery action is known in v0 because restore-input blockers remain: ${restoreInputBlockers.map((check) => this.isSavedRowsCheck(check) ? `${check.evidence}. ${check.remediation}` : check.evidence).join("; ")}`,
        });
        continue;
      }
      if (input.runningReadyNodes === input.expectedNodes) continue;

      if (input.unknownLivenessSeats.length > 0) {
        unknown.push({
          scope: "rig",
          rigId: input.rigId,
          rigName: input.rigName,
          reason: `tmux liveness is unknown for ${input.unknownLivenessSeats.join(", ")}; no restore command is advised because this check cannot tell whether those seats are live. ${input.unknownAdoptedSeats.length > 0
            ? `Restore probes the seats the DB shows running: it refuses (rig_not_stopped, 409) if one of those is live or unreadable, and otherwise starts. It also probes an adopted session rig down left running (${input.unknownAdoptedSeats.join(", ")}): one it cannot check fails that seat (adopted_liveness_unknown), neither reattached nor started.`
            : "Restore itself only probes seats the DB shows running: it refuses (rig_not_stopped, 409) if one of those is live or unreadable, and otherwise starts."}`,
        });
        continue;
      }
      if (input.liveRunningSeats.length > 0 || input.liveUnrecordedSeats.length > 0) {
        const parts: string[] = [];
        if (input.liveRunningSeats.length > 0) {
          parts.push(`Seats running in tmux: ${input.liveRunningSeats.join(", ")}. rig up --existing is refused (rig_not_stopped, 409) while any seat the DB shows running is live.`);
        }
        if (input.liveUnrecordedSeats.length > 0) {
          parts.push(`Seats live in tmux that the DB does not show running: ${input.liveUnrecordedSeats.join(", ")}. The DB is out of step with tmux; restore does not check these seats and could start a second session over a live one. Inspect with rig ps --nodes and reconcile before restoring.`);
        }
        if (input.deadSeatIds.length > 0) {
          const rig = shellQuote(this.rigHandle(input.rigId, input.rigName));
          parts.push(`To bring a down seat back WITHOUT its old conversation (it starts a new one), per seat: ${input.deadSeatIds.map((id) => freshSeatLaunchCommand(id, this.rigHandle(input.rigId, input.rigName))).join("; ")}.${this.freshStartupNote(input.rigId, "seat", input.rigName)} To keep the conversations instead: rig down ${this.rigDownHandle(input.rigId, input.rigName)}, then rig up ${rig} --existing (this restarts every seat).`);
        }
        blocked.push({
          scope: "rig",
          rigId: input.rigId,
          rigName: input.rigName,
          reason: parts.join(" "),
        });
        continue;
      }

      // OF-47: the seats' newest rows show nothing live, but restore reads every running row. Whatever it refuses on, the
      // advice must not be the command it refuses.
      if (input.restoreRunningRows === "live") {
        // `rig down` ends an older live row (teardown kills its session when no other node owns the name, and ends the row
        // either way; an adopted `claimed` session keeps its tmux session, OF-68), so it is the remedy; `rig seat stop <seat>`
        // ends that one seat's live sessions the same way. The advice offers no hand-run tmux kill (OF-66): the rig commands
        // cover every row, and a kill-by-name could end a session another seat owns.
        const names = input.restoreRunningRowNames;
        const owners = input.restoreRunningRowOwners;
        const ownerRigIds = input.restoreRunningRowOwnerRigIds;
        const downHandle = this.rigDownHandle(input.rigId, input.rigName);
        const ownName = names.filter((name) => owners[name] === undefined);
        const heldName = names.filter((name) => owners[name] !== undefined);
        // A holder in ANOTHER rig keeps its session when this rig goes down. For a holder in THIS rig (decided by rig id: rig names
        // are not unique) teardown may kill nothing: each row's owner lookup finds the other seat, so the shared session can survive.
        // The advice promises only what the rows end. An owner whose rig is unknown is read as possibly this rig.
        const held = heldName.map((name) => (ownerRigIds[name] === undefined || ownerRigIds[name] === input.rigId)
          ? `${name} is held by ${owners[name]}, a seat of this rig: do not kill it from here, it would end that seat; rig down ${downHandle} ends this rig's running rows for it, which is what lets restore run; it may leave the tmux session itself running (a name another seat still claims is not killed), so check it afterwards (rig capture -- ${shellQuote(name)}) and end it yourself if it is no longer wanted`
          : `${name} is held by ${owners[name]}, another rig's seat: do not kill it from here, it would end that seat; rig down ${downHandle} ends only this rig's older running row for it, without touching that session, which is what lets restore run`).join("; ");
        // OF-144: an adopted row is released by its own session id (rig unclaim needs one; a name can match several rows). These
        // rows are older ones (a live newest row is advised above), and releasing an older row leaves the seat's occupant alone.
        const adopted = input.restoreRunningRowAdopted;
        const adoptedOwn = adopted === null ? [] : ownName.filter((name) => adopted[name] !== undefined);
        const adoptedNote = adopted === null
          ? "An adopted session is the exception: rig down ends its row but leaves the tmux session running, and rig seat stop refuses it; release it with rig unclaim <session-id>. "
          : adoptedOwn.map((name) => `${name} was adopted (not launched by OpenRig): rig down ends its row but leaves its tmux session running, and rig seat stop refuses it; release it with rig unclaim ${adopted[name]}. `).join("");
        const downEnds = ownName.length > 0
          ? `rig down ${downHandle} ends ${ownName.join(", ")} (and stops the rest of the rig), as does rig seat stop <seat> for just that seat's live sessions. ${adoptedNote}`
          : "";
        blocked.push({
          scope: "rig",
          rigId: input.rigId,
          rigName: input.rigName,
          reason: `Restore would refuse this rig (rig_not_stopped, 409): the DB shows ${names.length === 1 ? "this session" : "these sessions"} running and tmux has ${names.length === 1 ? "it" : "them"} live: ${names.join(", ")}; no seat's newest session row shows it (an older running row sits behind a newer one). rig up --existing is refused while it is live. ${downEnds}${held ? `${held}. ` : ""}${ownName.length > 0 ? `Check it first if you are unsure it is not needed (rig capture -- ${ownName.map((n) => shellQuote(n)).join(" ")}). ` : ""}Probing stops at the first live row, so rerun rig restore-check afterwards: once no running row is live it predicts what else would stop restore (a seat that cannot be told apart from its older row, a missing resume token) before it advises rig up ${shellQuote(this.rigHandle(input.rigId, input.rigName))} --existing. A seat that has two running rows (a newer one that is dead as well as the live older one) is restored by rig up --existing from its newer row alone after rig down, which ends the older row before it takes its snapshot; if that newer row has no resume token restore stops the seat for a decision, and rig seat launch <seat> --fresh brings it back. Ending the older row any other way (a hand-run tmux kill) leaves both rows running in the DB, and restore then fails the seat with "Active-occupant ambiguity".`,
        });
        continue;
      }
      if (input.restoreRunningRows === "unreadable") {
        unknown.push({
          scope: "rig",
          rigId: input.rigId,
          rigName: input.rigName,
          reason: `No restore command is advised: tmux liveness could not be read for ${input.restoreRunningRowNames.join(", ")}, a session row the DB shows running (an older running row may sit behind a newer one). Restore fails closed (rig_not_stopped, 409) on a running row it cannot read. Check tmux (tmux ls), then rerun rig restore-check.`,
        });
        continue;
      }
      if (input.restoreRunningRows === "unanswered") {
        unknown.push({
          scope: "rig",
          rigId: input.rigId,
          rigName: input.rigName,
          reason: `No restore command is advised: restore's own reading of the rig's running session rows could not be answered, so whether restore would refuse this rig (rig_not_stopped, 409) is unknown. Rerun rig restore-check.`,
        });
        continue;
      }

      if (input.latestSnapshot) {
        actions.push({
          scope: "rig",
          rigId: input.rigId,
          rigName: input.rigName,
          action: "restore_from_latest_snapshot",
          command: `rig up --existing ${shellQuote(this.rigHandle(input.rigId, input.rigName))}`,
          reason: `Rig has a latest snapshot and one or more seats are not running/ready.${input.reattachSeats.length > 0 ? ` It reattaches the adopted sessions rig down left running (reattached: ${input.reattachSeats.join(", ")}); nothing is started for them.` : ""}${this.freshStartupNote(input.rigId, "restore", input.rigName)}`,
          safe: false,
          blocking: true,
        });
        continue;
      }

      actions.push({
        scope: "rig",
        rigId: input.rigId,
        rigName: input.rigName,
        action: "restore_from_latest_snapshot",
        command: `rig up --existing ${shellQuote(this.rigHandle(input.rigId, input.rigName))}`,
        reason: `Current persisted state is eligible for an ordinary restore attempt; rig up would capture an auto-rehydrate snapshot whose restore inputs have not been inspected.${input.reattachSeats.length > 0 ? ` It reattaches the adopted sessions rig down left running (reattached: ${input.reattachSeats.join(", ")}); nothing is started for them.` : ""}${this.freshStartupNote(input.rigId, "restore", input.rigName)}`,
        safe: false,
        blocking: true,
      });
    }

    const status: RecoveryStatus = unknown.length > 0
      ? "unknown"
      : actions.length > 0
        ? "actionable"
        : blocked.length > 0
          ? "blocked"
          : "not_needed";

    return {
      status,
      summary: this.buildRecoverySummary(status, actions, blocked, unknown),
      actions,
      blocked,
      unknown,
    };
  }

  /** The red checks that stop recovery from advising a restore. A rig restore would refuse whole (a live seat) is not
   *  stopped by what the snapshot says about the next restore: the liveness reasons below speak for it. */
  private restoreInputBlockers(input: RecoveryRigInput): CheckEntry[] {
    return input.blockingChecks.filter((check) => {
      if (this.classifyRecoveryBlockingCheck(check) !== "restore_input") return false;
      const aboutNextRestore = check.check.startsWith("rig.") && check.check.endsWith(".restore-preconditions");
      return !(aboutNextRestore && input.restoreRefused);
    });
  }

  private isSavedRowsCheck(check: CheckEntry): boolean {
    return check.check.startsWith("rig.") && check.check.endsWith(".saved-rows");
  }

  private classifyRecoveryBlockingCheck(check: CheckEntry): "restore_input" | "runtime" | "other" {
    if (check.status !== "red") return "other";

    if (check.check.startsWith("rig.") && check.check.endsWith(".restore-preconditions")) return "restore_input";

    // OF-62 (review B1): restore refuses the whole rig at its pre-restore snapshot while a saved row is damaged, so no
    // `rig up --existing` is advised; the blocked reason carries the check's evidence and its remedy.
    if (this.isSavedRowsCheck(check)) return "restore_input";

    if (check.check.startsWith("seat.") && check.check.endsWith(".readiness")) {
      if (check.evidence.includes("Missing canonical session identity")) {
        return "restore_input";
      }
      return "runtime";
    }

    if (check.check.startsWith("seat.") && check.check.endsWith(".startup-context")) {
      return "restore_input";
    }

    // OF-69: restore would start the seat through the launcher, which refuses a missing folder; no `rig up --existing` fixes that.
    if (check.check.startsWith("seat.") && check.check.endsWith(".cwd")) {
      return "restore_input";
    }

    return "other";
  }

  private buildRecoverySummary(
    status: RecoveryStatus,
    actions: RecoveryAction[],
    blocked: RecoveryIssue[],
    unknown: RecoveryIssue[],
  ): string {
    if (status === "not_needed") {
      return "All observable rigs are already running/ready; no recovery action needed.";
    }
    if (status === "unknown") {
      return `Recovery status could not be inspected completely; ${actions.length} actionable, ${blocked.length} blocked, ${unknown.length} unknown.`;
    }
    if (status === "actionable") {
      return `${actions.length} ${pluralize(actions.length, "rig")} can be recovered by known OpenRig command; ${blocked.length} ${pluralize(blocked.length, "rig")} blocked; ${unknown.length} unknown.`;
    }
    return `${blocked.length} ${pluralize(blocked.length, "rig")} blocked; ${actions.length} actionable; ${unknown.length} unknown.`;
  }

  /** What to type after `rig down`: the rig's name while exactly one rig carries it, its id when two or more do (rig names
   *  are not unique; `rig down <name>` halts as ambiguous) or when the rig list cannot be read (an id is always exact). */
  private rigDownHandle(rigId: string, rigName: string): string {
    return shellQuote(this.rigHandle(rigId, rigName));
  }

  /** OF-135: the rig as advice names it in `rig down`, `rig up <rig> --existing` and `<seat>@<rig>`: its name while that name
   *  reaches it and only it, else its id (rigAdviceHandle). OF-152: over every rig's id, archived ones included (an id wins,
   *  so a name that is an archived rig's id reaches that rig), when the lookup is wired; else over the unarchived rigs
   *  `listRigs` gives. Unreadable gives the id. Not quoted. */
  private rigHandle(rigId: string, rigName: string): string {
    if (this.deps.rigRefs) return rigAdviceHandle(this.deps.rigRefs, rigId, rigName);
    return rigAdviceHandle({
      findRigById: (id) => {
        const rig = this.deps.listRigs().find((r) => r.rigId === id);
        return rig ? { rig: { id: rig.rigId, name: rig.name, createdAt: "", updatedAt: "" }, archived: false } : null;
      },
      findUnarchivedRigsByName: (name) => this.deps.listRigs().filter((r) => r.name === name)
        .map((r) => ({ id: r.rigId, name: r.name, createdAt: "", updatedAt: "" })),
    }, rigId, rigName);
  }

  /** OF-32: where a seat started fresh takes its startup files from, for this rig. `rig seat launch --fresh` (and a
   *  seat listed with `rig up --existing --fresh <seat>`) re-reads the rig's recorded spec as it is now, with
   *  `--startup-from stored` as the escape. Any other seat `rig up --existing` starts fresh comes back on its saved
   *  files. A rig that records no source always replays those. Empty when the daemon cannot say (no reader wired). */
  private freshStartupNote(rigId: string, advice: "seat" | "restore", rigName: string): string {
    if (!this.deps.getRigSpecSource) return "";
    let source: string | null;
    try {
      source = this.deps.getRigSpecSource(rigId);
    } catch {
      return "";
    }
    if (source === null) {
      return advice === "seat"
        ? " This rig records no spec source, so a seat started fresh replays the startup files saved at its last successful launch."
        : " Seats it starts fresh (not resumed) come back on the startup files saved at their last successful launch; this rig records no spec source to re-read.";
    }
    return advice === "seat"
      ? ` A seat started fresh re-reads this rig's spec (${source}) as it is now; add --startup-from stored to give it the startup files saved at its last successful launch instead.`
      : ` Seats it starts fresh (not resumed) come back on the startup files saved at their last successful launch; to start a seat on this rig's spec (${source}) as it is now instead, list it: rig up ${shellQuote(this.rigHandle(rigId, rigName))} --existing --fresh <seat>.`;
  }

  private buildRigRollup(input: RigRollupInput): RigRestoreRollup & { liveRunningSeats: string[]; liveUnrecordedSeats: string[]; reattachSeats: string[]; unknownAdoptedSeats: string[]; deadSeatIds: string[]; unknownLivenessSeats: string[] } {
    const blockingChecks = input.checks.filter((check) => check.status === "red");
    const caveatChecks = input.checks.filter((check) => check.status === "yellow");
    const expectedNodes = input.nodes.length;
    let runningReadyNodes = 0;
    const liveRunningSeats: string[] = [];
    const liveUnrecordedSeats: string[] = [];
    const reattachSeats: string[] = [];
    const unknownAdoptedSeats: string[] = [];
    const deadSeatIds: string[] = [];
    const unknownLivenessSeats: string[] = [];
    let blockedNodes = 0;
    let caveatNodes = 0;
    // FR-8: per-seat class breakdown (each seat counts toward exactly one class).
    const classCounts: ReadinessClassCounts = { ready: 0, ready_with_caveats: 0, not_ready: 0, attention_required: 0, unknown: 0 };
    // unknown/no-snapshot derives from the REAL snapshot primitive: the
    // rig-level `rig.<name>.snapshot` yellow check (no snapshot found / could
    // not check). A rig with no snapshot cannot be restored, so its seats'
    // restore-readiness is unknown (not "ready"), per FR-8/AC-7.
    const rigNoSnapshot = input.checks.some(
      (check) => check.check === `rig.${input.rig.name}.snapshot` && check.status === "yellow",
    );

    for (const node of input.nodes) {
      const session = node.canonicalSessionName ?? node.logicalId;
      const nodeChecks = input.checks.filter((check) => check.check.startsWith(`seat.${session}.`));
      const hasBlocking = nodeChecks.some((check) => check.status === "red");
      const hasCaveat = nodeChecks.some((check) => check.status === "yellow");
      const seatLiveness = node.canonicalSessionName ? input.liveness.get(node.canonicalSessionName) : undefined;
      if (seatLiveness === "live") {
        (node.sessionStatus === "running" ? liveRunningSeats : this.adoptedLeftRunning(node) ? reattachSeats : liveUnrecordedSeats).push(session);
      }
      if (seatLiveness === "dead") deadSeatIds.push(node.logicalId);
      if (seatLiveness === "unreadable") {
        unknownLivenessSeats.push(session);
        if (node.sessionStatus !== "running" && this.adoptedLeftRunning(node)) unknownAdoptedSeats.push(session);
      }
      const runningReady = seatRunningReady(node, input.liveness);
      if (runningReady) runningReadyNodes += 1;
      if (hasBlocking) blockedNodes += 1;
      else if (hasCaveat) caveatNodes += 1;

      // FR-8 class derivation (precedence; each from a real primitive).
      // attention/not_ready WIN FIRST (a failed/attention seat is surfaced even
      // in a no-snapshot rig); no-snapshot then overrides ONLY ready/caveat (a
      // clean seat in an unrestorable rig is unknown); a real yellow caveat then
      // wins over plain ready so the class count matches the per-rig status +
      // caveatNodes (a running/ready seat with a yellow check is NOT plain ready):
      //   attention_required ← node.startupStatus
      //   not_ready          ← a red seat check (failed/down)
      //   unknown            ← no-snapshot (rig can't restore)
      //   ready_with_caveats ← a yellow seat check
      //   ready              ← running/ready, no caveat
      //   unknown            ← indeterminate remainder
      if (node.startupStatus === "attention_required") classCounts.attention_required += 1;
      else if (hasBlocking) classCounts.not_ready += 1;
      else if (rigNoSnapshot) classCounts.unknown += 1;
      else if (hasCaveat) classCounts.ready_with_caveats += 1;
      else if (runningReady) classCounts.ready += 1;
      else classCounts.unknown += 1;
    }

    let verdict: Verdict;
    let status: ReadinessStatus;
    if (input.preconditionError) {
      verdict = "unknown";
      status = "unknown";
    } else if (blockingChecks.length > 0) {
      verdict = "not_restorable";
      status = "not_ready";
    } else if (caveatChecks.length > 0) {
      verdict = "restorable_with_caveats";
      status = "ready_with_caveats";
    } else {
      verdict = "restorable";
      status = "ready";
    }

    return {
      rigId: input.rig.rigId,
      rigName: input.rig.name,
      status,
      verdict,
      expectedNodes,
      runningReadyNodes,
      blockedNodes,
      caveatNodes,
      classCounts,
      blockingChecks,
      caveatChecks,
      liveRunningSeats,
      liveUnrecordedSeats,
      reattachSeats,
      unknownAdoptedSeats,
      deadSeatIds,
      unknownLivenessSeats,
    };
  }

  /** OF-155: the seat's adopted session rig down left running, when it is the session this check probed and of the kind
   *  asked (`reattach` unless named: a contested one is not reattached). Unreadable reads as none, which keeps the stricter
   *  "live although the DB does not show it running" advice (nothing is acted on). */
  private adoptedLeftRunning(node: NodeInventoryEntry, kind: AdoptedSessionLeftRunning["kind"] = "reattach"): AdoptedSessionLeftRunning | null {
    if (!node.nodeId || !this.deps.reattachableAdopted || !node.canonicalSessionName) return null;
    try {
      const adopted = this.deps.reattachableAdopted(node.nodeId);
      return adopted && adopted.kind === kind && adopted.sessionName === node.canonicalSessionName ? adopted : null;
    } catch {
      return null;
    }
  }

  /** Generate ordered repair steps from non-green checks with remediation.
   *  null when all green (restorable — nothing to repair).
   *  Blockers (red) first in check order, then caveats (yellow). */
  private buildRepairPacket(checks: CheckEntry[], verdict: Verdict): RepairStep[] | null {
    if (verdict === "restorable") return null;

    // Blockers first, then caveats, preserving original check order within each group
    const blockers = checks.filter((c) => c.status === "red" && c.remediation);
    const caveats = checks.filter((c) => c.status === "yellow" && c.remediation);
    const ordered = [...blockers, ...caveats];

    if (ordered.length === 0) return null;

    let step = 0;
    return ordered.map((c) => ({
      step: ++step,
      command: c.remediation,
      rationale: c.evidence,
      safe: c.remediationSafe === true,  // conservative: default false unless explicitly marked safe
      blocking: c.status === "red",
    }));
  }
}

/**
 * Would the next restore run at all? Asked of restore's own rule (restore-running-sessions.ts) over the rig's DB-running
 * rows. Not asked (no tmux wired) or not answerable: a rig with a running seat is `unknown`, never assumed either way; a
 * rig with no running seat has nothing to refuse it.
 */
function restoreRunsFor(classification: NamedRunningClassification | Error | undefined, nodes: NodeInventoryEntry[]): RestoreRuns {
  if (classification && !(classification instanceof Error)) return restoreRefusesRig(classification) ? "refused" : "would_run";
  const anyRunning = nodes.some((node) => (node.storedSessionStatus ?? node.sessionStatus) === "running");
  return anyRunning ? "unknown" : "would_run";
}

/** OF-47: the tmux names of the running rows restore refuses on (live first, else unreadable). */
function refusingRowNames(classification: NamedRunningClassification | Error | undefined): string[] {
  if (!classification || classification instanceof Error) return [];
  const ids = classification.live.length > 0 ? classification.live : classification.unknown;
  return ids.map((id) => classification.sessionNames?.[id]).filter((name): name is string => name !== undefined);
}

/** OF-47: of the refusing rows' tmux names, the ones another seat owns (name -> `logical@rig`). */
function refusingRowOwners(classification: NamedRunningClassification | Error | undefined): Record<string, string> {
  if (!classification || classification instanceof Error) return {};
  const ids = classification.live.length > 0 ? classification.live : classification.unknown;
  return Object.fromEntries(ids.flatMap((id) => {
    const name = classification.sessionNames?.[id];
    const owner = classification.sessionOwners?.[id];
    return name !== undefined && owner !== undefined ? [[name, owner]] : [];
  }));
}

/** OF-54: the rig id of each owner `refusingRowOwners` names (tmux name -> rig id). */
function refusingRowOwnerRigIds(classification: NamedRunningClassification | Error | undefined): Record<string, string> {
  if (!classification || classification instanceof Error) return {};
  const ids = classification.live.length > 0 ? classification.live : classification.unknown;
  return Object.fromEntries(ids.flatMap((id) => {
    const name = classification.sessionNames?.[id];
    const rigId = classification.sessionOwnerRigIds?.[id];
    return name !== undefined && rigId !== undefined ? [[name, rigId]] : [];
  }));
}

/** OF-144: of the refusing rows, the adopted ones (tmux name -> session id); null when the classification does not say. */
function refusingRowAdopted(classification: NamedRunningClassification | Error | undefined): Record<string, string> | null {
  if (!classification || classification instanceof Error || classification.adoptedSessionIds === undefined) return null;
  const adoptedIds = new Set(classification.adoptedSessionIds);
  const ids = classification.live.length > 0 ? classification.live : classification.unknown;
  return Object.fromEntries(ids.flatMap((id) => {
    const name = classification.sessionNames?.[id];
    return name !== undefined && adoptedIds.has(id) ? [[name, id]] : [];
  }));
}

/** OF-47: the recovery advice's reading of restore's own rule over the rig's running rows. */
function restoreRunningRowsFor(classification: NamedRunningClassification | Error | undefined): RecoveryRigInput["restoreRunningRows"] {
  if (classification === undefined) return "not_asked";
  if (classification instanceof Error) return "unanswered";
  if (classification.live.length > 0) return "live";
  if (classification.unknown.length > 0) return "unreadable";
  return "none";
}

/** DB says running+ready AND tmux has not contradicted it (unprobed counts as DB-only). */
function seatRunningReady(node: NodeInventoryEntry, liveness: Map<string, SeatLiveness>): boolean {
  if (!node.canonicalSessionName || node.sessionStatus !== "running" || node.startupStatus !== "ready") return false;
  const tmux = liveness.get(node.canonicalSessionName);
  return tmux !== "dead" && tmux !== "unreadable";
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9._@:-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pluralize(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}
