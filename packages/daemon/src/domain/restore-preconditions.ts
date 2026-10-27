import type { SnapshotData, RestoreValidationBlocker, RigServicesRecord, NodeStartupSnapshot } from "./types.js";
import { resolveSnapshotRestoreTopology } from "./restore-topology.js";
import { decideSeatLaunchOutcome, type SeatGateInputs } from "./restore-seat-gates.js";
import { reanchorBuiltinStartupFile, reanchorShippedProjectionEntry } from "./builtin-startup-files.js";

/** OF-32/OF-36: what a seat this restore starts fresh replays, when that is not simply the snapshot's copy
 *  (fresh-seat-restore-decision.ts `startupToValidateForSeat`). */
export type FreshSeatStartupOverride =
  /** A seat listed with `--fresh`: its source is decided and checked per seat before its launch. */
  | "resolved_at_launch"
  /** The snapshot's copy, as before OF-32 stage 3. */
  | undefined
  /** What the seat replays instead of the snapshot's copy (its own saved context, or the newest usable snapshot copy;
   *  `fromSnapshotId` names that copy's snapshot, which restore carries to the seat's launch: review F4). */
  | { replay: NodeStartupSnapshot; warning?: string; fromSnapshotId?: string }
  /** The seat has nothing restore can replay: restore starts nothing. */
  | { refuse: RestoreValidationBlocker };

// Shared read-only validation. Keep restore's refusal order and replay eligibility here.
export function validatePreRestore(
  data: SnapshotData,
  opts: {
    fsOps?: { exists(path: string): boolean };
    servicesRecord?: RigServicesRecord | null;
    freshLogicalIds?: string[];
    /** OF-32: for a seat this restore starts fresh, what it will replay when that is not the snapshot's copy.
     *  `"resolved_at_launch"`: a seat listed with `--fresh`, whose source is decided and checked per seat before its
     *  launch, so nothing is checked here. A context: the seat's own saved context, which it replays instead of an
     *  older snapshot copy, checked here exactly as the snapshot's copy was. `undefined` (or the option omitted): the
     *  snapshot's copy, as before OF-32 stage 3. */
    freshSeatStartup?: (node: { id: string; logicalId: string }) => FreshSeatStartupOverride;
    /** OF-57: what the seat gates (restore-seat-gates.ts) read that is not in the snapshot: the live seat found by
     *  logical id (null: removed), its continuity status and the rig's name. Absent: the gates that can be decided
     *  from the snapshot alone (occupant ambiguity, an earlier occupant's token, a resumable seat with no token) are
     *  applied, and the live ones (removed seat, runtime mismatch, `restoring`) are not. */
    seatGateInputs?: (node: { id: string; logicalId: string }) => SeatGateInputs;
  },
): { blockers: RestoreValidationBlocker[]; warnings: string[] } {
  const blockers: RestoreValidationBlocker[] = [];
  const warnings: string[] = [];
  const exists = opts.fsOps?.exists ?? (() => true);

  const add = (blocker: RestoreValidationBlocker) => blockers.push(blocker);
  const nodes = Array.isArray(data.nodes) ? data.nodes : null;
  const sessions = Array.isArray(data.sessions) ? data.sessions : null;
  const edges = Array.isArray(data.edges) ? data.edges : null;
  const checkpoints = data.checkpoints && typeof data.checkpoints === "object" ? data.checkpoints : null;

  if (!data.rig || typeof data.rig.id !== "string") {
    add({
      code: "invalid_snapshot_data",
      severity: "critical",
      target: "snapshot.rig",
      message: "Snapshot is missing the rig record needed for restore.",
      remediation: "Capture a new snapshot or restore from a structurally valid snapshot.",
    });
  }
  if (!nodes) {
    add({
      code: "invalid_snapshot_data",
      severity: "critical",
      target: "snapshot.nodes",
      message: "Snapshot is missing the node list needed for restore.",
      remediation: "Capture a new snapshot or restore from a structurally valid snapshot.",
    });
  }
  if (!sessions) {
    add({
      code: "invalid_snapshot_data",
      severity: "critical",
      target: "snapshot.sessions",
      message: "Snapshot is missing session records needed for restore.",
      remediation: "Capture a new snapshot or restore from a structurally valid snapshot.",
    });
  }
  if (!edges) {
    add({
      code: "invalid_snapshot_data",
      severity: "critical",
      target: "snapshot.edges",
      message: "Snapshot is missing topology edges needed for restore planning.",
      remediation: "Capture a new snapshot or restore from a structurally valid snapshot.",
    });
  }
  if (!checkpoints) {
    add({
      code: "invalid_snapshot_data",
      severity: "critical",
      target: "snapshot.checkpoints",
      message: "Snapshot is missing the checkpoint map needed for restore.",
      remediation: "Capture a new snapshot or restore from a structurally valid snapshot.",
    });
  }

  if (!nodes || !checkpoints) {
    return { blockers, warnings };
  }

  const topology = resolveSnapshotRestoreTopology(data);
  for (const invalidNodeId of topology.invalidRosterIds) {
    add({
      code: "invalid_topology_roster",
      severity: "critical",
      nodeId: invalidNodeId,
      target: "snapshot.topologyRoster",
      message: `Intended topology roster names node ${invalidNodeId}, which is absent from snapshot.nodes.`,
      remediation: "Capture a new snapshot from the authoritative materialized topology.",
    });
  }

  for (const node of topology.intendedNodes) {
    const snapshotCtx = data.nodeStartupContext?.[node.id] ?? null;
    const gateInputs = opts.seatGateInputs?.(node);
    const outcome = decideSeatLaunchOutcome({
      data, snapshotNodeId: node.id, logicalId: node.logicalId,
      freshRequested: opts.freshLogicalIds?.includes(node.logicalId) ?? false,
      ...(gateInputs ?? { live: { runtime: snapshotCtx?.runtime ?? null }, continuityStatus: null, rigName: data.rig?.name ?? "" }),
    });
    const startsNothing = outcome.kind === "stop" || outcome.kind === "skip_restoring";

    const checkpoint = checkpoints[node.id] ?? null;
    // OF-25: restore delivers a checkpoint into the cwd the seat has NOW (the live node's). OF-128 L7: a seat with no live cwd
    // falls back to the snapshot's, exactly as restore does, so that is the cwd checked. A seat restore stops or skips
    // delivers nothing, so it needs no cwd.
    const checkpointCwd = gateInputs?.live?.cwd ?? node.cwd;
    if (checkpoint && !checkpointCwd && !startsNothing) {
      add({
        code: "checkpoint_missing_node_cwd",
        severity: "critical",
        nodeId: node.id,
        logicalId: node.logicalId,
        target: "checkpoint",
        message: `Checkpoint exists for ${node.logicalId}, but the node has no cwd to receive it.`,
        remediation: "Update the rig spec to include a cwd for this node, then capture a new snapshot or restore manually.",
      });
    }

    // OF-57: whether the seat will CONSUME replay is what restore does with it, asked of the one function restore, the
    // plan and `rig launch` ask (restore-seat-gates.ts decideSeatLaunchOutcome), not a second copy of its rules.
    // A seat restore stops at a gate (removed, ambiguous occupant, runtime mismatch, an earlier occupant's token, a
    // resumable seat with no token) or skips (`restoring` continuity) starts nothing and reads none of its startup
    // files, so none are checked: a missing file of such a seat must not refuse the rig. A seat that resumes consumes
    // nothing (its projection entries are still checked, as before). Only a seat started fresh replays its files.
    if (startsNothing) continue;
    const consumesReplay = outcome.kind === "fresh";
    const override = consumesReplay ? opts.freshSeatStartup?.(node) : undefined;
    if (override === "resolved_at_launch") continue;
    if (override && "refuse" in override) {
      add(override.refuse);
      continue;
    }
    if (override?.warning) warnings.push(override.warning);
    const startupCtx = override ? override.replay : snapshotCtx;
    if (!startupCtx) continue;
    const findings = startupInputFindings(node, startupCtx, exists, consumesReplay);
    blockers.push(...findings.blockers);
    warnings.push(...findings.warnings);
  }

  const servicesRecord = opts.servicesRecord ?? null;
  if (servicesRecord) {
    if (pathLike(servicesRecord.rigRoot) && !exists(servicesRecord.rigRoot)) {
      add({
        code: "service_rig_root_missing",
        severity: "critical",
        target: "services.rigRoot",
        path: servicesRecord.rigRoot,
        message: `Service rig root is missing: ${servicesRecord.rigRoot}`,
        remediation: "Restore the service rig root or update the services record before retrying restore.",
      });
    }
    if (pathLike(servicesRecord.composeFile) && !exists(servicesRecord.composeFile)) {
      add({
        code: "service_compose_file_missing",
        severity: "critical",
        target: "services.composeFile",
        path: servicesRecord.composeFile,
        message: `Service compose file is missing: ${servicesRecord.composeFile}`,
        remediation: "Restore the compose file or update the services record before retrying restore.",
      });
    }
  }

  return { blockers, warnings };
}

/** The startup-input checks for one seat's startup context: required files (blockers, only when the seat consumes
 *  the replay) and missing optional files and projection entries (warnings). Shared by pre-restore validation (the
 *  snapshot's copy) and, OF-32, by restore's per-seat check of the source a fresh seat was actually given. */
export function startupInputFindings(
  node: { id: string; logicalId: string },
  startupCtx: NodeStartupSnapshot,
  exists: (path: string) => boolean,
  consumesReplay: boolean,
): { blockers: RestoreValidationBlocker[]; warnings: string[] } {
  const blockers: RestoreValidationBlocker[] = [];
  const warnings: string[] = [];

  // OF-36: a snapshot copies a seat's saved context verbatim, so a copy can be any JSON. Restore never replays a copy
  // that is not a valid startup setup (own-startup-replay.ts); here a copy it will not replay (a resuming seat, or no
  // adapter) must not end the restore either, so only list members that are objects are inspected.
  const members = <T>(list: unknown): T[] => (Array.isArray(list) ? list.filter((member) => !!member && typeof member === "object" && !Array.isArray(member)) : []) as T[];
  for (const storedFile of consumesReplay ? members<NodeStartupSnapshot["resolvedStartupFiles"][number]>(startupCtx.resolvedStartupFiles) : []) {
    // Validate the file replay will actually deliver (#261: built-ins follow the running install).
    const file = reanchorBuiltinStartupFile(storedFile, undefined, undefined, exists);
    if (!file.required) {
      if (pathLike(file.absolutePath) && !exists(file.absolutePath)) {
        warnings.push(`Restore pre-validation: optional startup file missing for ${node.logicalId}: ${file.absolutePath}`);
      }
      continue;
    }
    if (pathLike(file.ownerRoot) && !exists(file.ownerRoot)) {
      blockers.push({
        code: "startup_owner_root_missing",
        severity: "critical",
        nodeId: node.id,
        logicalId: node.logicalId,
        target: file.path,
        path: file.ownerRoot,
        message: `Required startup file owner root is missing for ${node.logicalId}: ${file.ownerRoot}`,
        remediation: "Restore the agent/source root or capture a new snapshot with reachable startup context.",
      });
    }
    if (pathLike(file.absolutePath) && !exists(file.absolutePath)) {
      blockers.push({
        code: "required_startup_file_missing",
        severity: "critical",
        nodeId: node.id,
        logicalId: node.logicalId,
        target: file.path,
        path: file.absolutePath,
        message: `Required startup file is missing for ${node.logicalId}: ${file.absolutePath}`,
        remediation: "Restore the missing startup file or capture a new snapshot before retrying restore.",
      });
    }
  }

  // OPR.0.3.4.5 (behavior 09): projection-validity != session continuity.
  // A stale/missing projected skill/artifact must NOT abort a restore that
  // has a valid native resume. Demoted from critical blockers to warnings
  // flagged as projection_drift (compose slice-03's drift reporting shape).
  // The existing post-launch filter (:855-885) already skips missing
  // entries with a "(skipped)" warning; here we prevent the pre-restore
  // gate from blocking the attempt entirely. Missing REQUIRED startup
  // files and genuinely-fatal blockers (malformed snapshot, missing nodes)
  // stay critical above.
  for (const storedEntry of members<NodeStartupSnapshot["projectionEntries"][number]>(startupCtx.projectionEntries)) {
    const entry = reanchorShippedProjectionEntry(storedEntry, undefined, exists);
    if (pathLike(entry.sourcePath) && !exists(entry.sourcePath)) {
      warnings.push(`projection_drift: source root missing for ${node.logicalId}: ${entry.sourcePath} (projection will be skipped at startup; session continuity is unaffected)`);
    }
    if (pathLike(entry.absolutePath) && !exists(entry.absolutePath)) {
      warnings.push(`projection_drift: entry missing for ${node.logicalId}: ${entry.absolutePath} (projection will be skipped at startup; session continuity is unaffected)`);
    }
  }
  return { blockers, warnings };
}

/** OF-32: whether a seat a restore starts fresh replays the snapshot's copy of its startup context. Only when restore
 *  cannot decide its source at launch (no adapter for its runtime: nothing is replayed or saved at all), or when the
 *  seat has no saved context of its own and its rig's spec will not be re-read. Otherwise the source is the rig's
 *  spec as it is now or the seat's own saved context, and it is checked per seat before the launch. */
export function freshSeatReplaysSnapshotStartup(input: { adapterAvailable: boolean; seatHasSavedContext: boolean; rigSpecReread: boolean }): boolean {
  return !input.adapterAvailable || (!input.seatHasSavedContext && !input.rigSpecReread);
}

function pathLike(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && (
    value.startsWith("/")
    || value.startsWith("./")
    || value.startsWith("../")
    || value.startsWith("~")
  );
}
