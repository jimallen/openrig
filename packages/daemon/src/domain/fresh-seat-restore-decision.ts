// OF-32 stage 3: the decision restore makes for a seat the operator lists with `--fresh`, before it launches that seat:
// where its startup policy comes from, and whether the files that source names can be delivered. Restore
// (restoreNodeUnisolated) acts on this decision; `rig up --existing --plan` and restore-check ask the same function
// what restore WOULD decide (`predictListedSeatRefusals`), so a prediction cannot be looser than the restore it
// predicts: they run one code path over the same inputs.
import type Database from "better-sqlite3";
import { resolveFreshSeatStartup, startupFromSnapshotId, type FreshStartupContext, type SeatStartupSpecReader, type StartupFrom } from "./seat-startup-source.js";
import { freshSeatLaunchCommand } from "./active-occupant.js";
import { freshSeatReplaysSnapshotStartup, startupInputFindings, validatePreRestore, type FreshSeatStartupOverride } from "./restore-preconditions.js";
import { newestUsableSnapshotCopy, noUsableCopyMessage, noUsableCopyRemedy, seatStartupForRestore, startupContextUnusable } from "./own-startup-replay.js";
import { readNodeStartupSnapshot } from "./snapshot-capture.js";
import { restoreRuntimeCompatibilityError } from "./restore-runtime-compatibility.js";
import { deriveCanonicalSessionName, deriveSessionName } from "./session-name.js";
import type { RuntimeAdapter } from "./runtime-adapter.js";
import type { NodeStartupSnapshot, SnapshotData } from "./types.js";

/** A fresh seat's chosen startup policy in the shape restore replays (the snapshot's startup-context shape). */
export function asReplayContext(context: FreshStartupContext): NodeStartupSnapshot {
  return {
    projectionEntries: context.plan.entries,
    resolvedStartupFiles: context.resolvedStartupFiles,
    startupActions: context.startupActions,
    runtime: context.runtime,
  };
}

type LiveRig = { rig: { name: string }; nodes: Array<{ id: string; logicalId: string; podId?: string | null; runtime?: string | null; cwd?: string | null }> };

/**
 * What pre-restore validation checks for a seat this restore starts fresh, read as restoreNodeUnisolated will act (see
 * validatePreRestore's `freshSeatStartup`). Restore and restore-check both ask this, so the check validates exactly
 * what restore validates, and refuses exactly what restore refuses.
 *  - `"resolved_at_launch"`: a seat listed with `--fresh` whose source is decided and checked per seat before its launch
 *    (decideListedFreshSeat), including a listed seat whose only source is a snapshot copy that cannot be used.
 *  - `{ replay }`: what an unlisted seat replays instead of the restored snapshot's copy: its own saved context, or
 *    (OF-36) when that cannot be used the newest usable snapshot copy, with the warning that says so.
 *  - `{ refuse }`: an unlisted seat whose context cannot be used and no snapshot holds a usable copy (OF-36): restore
 *    starts nothing.
 *  - `undefined`: the restored snapshot's copy (no live node, no adapter for its runtime, or no saved context).
 * `selectedCopy`: the restored snapshot's copy of this seat's context.
 */
export function startupToValidateForSeat(
  deps: { db: Database.Database; rigRepo: { getRig(rigId: string): LiveRig | null; getRigSpecSource(rigId: string): string | null } },
  input: { rigId: string; logicalId: string; adapters: Record<string, RuntimeAdapter | undefined> | undefined; freshLogicalIds?: string[]; startupFrom?: StartupFrom; selectedCopy?: NodeStartupSnapshot | null },
): FreshSeatStartupOverride {
  const rig = deps.rigRepo.getRig(input.rigId);
  const live = rig?.nodes.find((candidate) => candidate.logicalId === input.logicalId);
  const runtime = live?.runtime ?? null;
  if (!rig || !live || !runtime || !input.adapters?.[runtime]) return undefined;
  if (input.freshLogicalIds?.includes(input.logicalId)) {
    // OF-36 Q2: `--startup-from snapshot:<id>` names the copy; it is read and checked per seat before its launch.
    if (startupFromSnapshotId(input.startupFrom)) return "resolved_at_launch";
    const replaysCopy = freshSeatReplaysSnapshotStartup({
      adapterAvailable: true,
      seatHasSavedContext: deps.db.prepare("SELECT 1 FROM node_startup_context WHERE node_id = ?").get(live.id) !== undefined,
      rigSpecReread: (input.startupFrom ?? "spec") === "spec" && !!deps.rigRepo.getRigSpecSource(input.rigId),
    });
    // A copy that cannot be used is not replayed: the seat's launch takes the newest usable one, or refuses the seat.
    return replaysCopy && !(input.selectedCopy && startupContextUnusable(input.selectedCopy, null)) ? undefined : "resolved_at_launch";
  }
  // Review F3 (4728c079): a seat restore's runtime gate stops (the restored copy names another runtime than the seat's)
  // replays nothing, so nothing is chosen, warned or refused for it here; restore stops it awaiting a decision.
  if (restoreRuntimeCompatibilityError(runtime, input.selectedCopy?.runtime)) return "resolved_at_launch";
  const pick = seatStartupForRestore(deps.db, { rigId: input.rigId, nodeId: live.id, logicalId: input.logicalId, runtime }, input.selectedCopy);
  switch (pick.kind) {
    case "own": return { replay: pick.context };
    case "snapshot": return undefined;
    case "fallback": return { replay: pick.context, warning: pick.warning, fromSnapshotId: pick.from.snapshotId };
    case "none_usable": return {
      refuse: {
        code: "saved_startup_context_unusable",
        severity: "critical",
        nodeId: live.id,
        logicalId: input.logicalId,
        target: "node_startup_context",
        message: `${noUsableCopyMessage(input.logicalId, pick.why)} Restore would start this seat fresh, so it starts nothing.`,
        remediation: noUsableCopyRemedy({ scope: "restore", rigName: rig.rig.name, logicalId: input.logicalId, specRecorded: !!deps.rigRepo.getRigSpecSource(input.rigId), ownRow: pick.ownRow }),
      },
    };
  }
}

export interface ListedSeatDecisionDeps {
  db: Database.Database;
  rigRepo: { getRigSpecSource(rigId: string): string | null };
  specReader: SeatStartupSpecReader | null;
  runtimeAdapters: Record<string, RuntimeAdapter | undefined>;
}

export interface ListedSeatDecisionInput {
  rigId: string;
  nodeId: string;
  logicalId: string;
  rigName: string;
  runtime: string | null;
  cwd: string;
  sessionName: string;
  startupFrom: StartupFrom;
  /** The startup context the restored snapshot holds for this seat (replayed only when the seat has none of its own;
   *  when that copy or the seat's own context cannot be used, the newest usable snapshot copy is replayed instead). */
  snapshotCopy: NodeStartupSnapshot | null;
  exists: (path: string) => boolean;
}

export interface ListedSeatDecision {
  decided: Awaited<ReturnType<typeof resolveFreshSeatStartup>>;
  /** The saved context is missing or unreadable, so the snapshot's copy is replayed instead. */
  snapshotFallback: boolean;
  /** What the seat will be given, checked below; null when nothing is replayed. */
  chosen: NodeStartupSnapshot | null;
  /** Why restore refuses this seat before launching it (the text after "Fresh start refused: "), or null. */
  refusal: string | null;
  /** Missing optional files and projection entries of what the seat will be given. */
  warnings: string[];
  /** OF-36: the snapshot whose copy is replayed, when it is not the restored one (the seat's context, or the restored
   *  snapshot's copy, cannot be used). */
  copyFromSnapshotId: string | null;
}

export async function decideListedFreshSeat(deps: ListedSeatDecisionDeps, input: ListedSeatDecisionInput): Promise<ListedSeatDecision> {
  const decided = await resolveFreshSeatStartup(
    { db: deps.db, rigRepo: deps.rigRepo, specReader: deps.specReader, runtimeAdapters: deps.runtimeAdapters },
    {
      rigId: input.rigId, nodeId: input.nodeId, logicalId: input.logicalId, runtime: input.runtime,
      cwd: input.cwd, sessionName: input.sessionName, startupFrom: input.startupFrom,
      refusalGuidance: `Restore or fix the spec at that path, or start only this seat with the startup files saved at its last successful launch: ${freshSeatLaunchCommand(input.logicalId, input.rigName, "stored")}.`,
    },
  );
  let refusal: string | null = null;
  const warnings: string[] = [];
  // startup_context_missing: the seat has no saved context of its own (it never launched in this database), so
  // the snapshot's copy is the only one and cannot be older than anything: it is replayed as before.
  // startup_context_malformed: the seat's saved context cannot be read, so nothing newer can be lost; a snapshot's copy
  // is replayed, said in a warning, and a successful launch saves it as the seat's new context.
  // OF-36: "the snapshot's copy" is the restored snapshot's copy only when it can be used; otherwise (and always when
  // the seat's own context cannot be used) it is the newest usable copy any snapshot of this rig holds. A copy taken
  // after the context broke carries the same damage and is skipped. When there is none, the seat is refused.
  const snapshotFallback = !decided.ok && (decided.code === "startup_context_missing" || decided.code === "startup_context_malformed");
  let chosen: NodeStartupSnapshot | null = decided.ok ? asReplayContext(decided.context) : null;
  let copyFrom = "in this snapshot";
  let copyFromSnapshotId: string | null = null;
  if (snapshotFallback) {
    const pick = seatStartupForRestore(deps.db, { rigId: input.rigId, nodeId: input.nodeId, logicalId: input.logicalId, runtime: input.runtime }, input.snapshotCopy);
    if (pick.kind === "none_usable") {
      refusal = `${noUsableCopyMessage(input.logicalId, pick.why)} ${noUsableCopyRemedy({
        scope: "seat", rigName: input.rigName, logicalId: input.logicalId,
        specRecorded: input.startupFrom === "stored" && !!deps.rigRepo.getRigSpecSource(input.rigId), ownRow: pick.ownRow,
      })}`;
    } else {
      chosen = pick.context;
      if (pick.kind === "fallback") {
        warnings.push(pick.warning);
        copyFrom = `in snapshot ${pick.from.snapshotId}`;
        copyFromSnapshotId = pick.from.snapshotId;
      }
    }
  }
  if (!decided.ok && !snapshotFallback) {
    refusal = `${decided.message}${decided.guidance ? ` ${decided.guidance}` : ""}`;
  } else if (chosen && !refusal) {
    // The checks pre-restore validation runs on the snapshot's copy, run on what this seat will actually be given.
    const findings = startupInputFindings({ id: input.nodeId, logicalId: input.logicalId }, chosen, input.exists, true);
    if (findings.blockers.length > 0) {
      const from = decided.ok && decided.context.source.kind === "spec" ? `read from ${decided.context.source.specSource}`
        : decided.ok && decided.context.source.kind === "snapshot" ? `copied in snapshot ${decided.context.source.snapshotId}`
        : decided.ok ? "saved at the seat's last successful launch" : copyFrom;
      refusal = `its startup files (${from}) cannot be delivered: ${findings.blockers.map((blocker) => blocker.message).join("; ")}.`;
    } else {
      warnings.push(...findings.warnings);
    }
  }
  return { decided, snapshotFallback, chosen, refusal, warnings, copyFromSnapshotId };
}

/**
 * Review F1 (4728c079): what the operator can do about a listed seat restore would refuse, every route checked against
 * the same decisions restore makes (so none of them loops back):
 *  - start it from a snapshot copy that can be used and whose required files exist: `--startup-from snapshot:<id>`;
 *  - leave it out of `--fresh`, offered only when the restore that leaves it out would not refuse the rig for this seat
 *    (pre-restore validation over the same snapshot, the seat unlisted);
 *  - otherwise say that leaving it out does not help, and that the listed restore still restores the other seats.
 */
export function listedRefusalRemedy(
  deps: { db: Database.Database; rigRepo: { getRig(rigId: string): LiveRig | null; getRigSpecSource(rigId: string): string | null }; runtimeAdapters: Record<string, RuntimeAdapter | undefined> },
  input: { rigId: string; logicalId: string; snapshot: SnapshotData | null; freshLogicalIds: string[]; startupFrom: StartupFrom; exists: (path: string) => boolean },
): string {
  const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
  const rig = deps.rigRepo.getRig(input.rigId);
  const live = rig?.nodes.find((node) => node.logicalId === input.logicalId);
  const rigName = rig?.rig.name ?? input.rigId;
  const routes: string[] = [];
  const best = live ? newestUsableSnapshotCopy(deps.db, input.rigId, input.logicalId, live.runtime ?? null) : null;
  if (best && input.startupFrom !== `snapshot:${best.snapshotId}`
    && startupInputFindings({ id: live!.id, logicalId: input.logicalId }, best.context, input.exists, true).blockers.length === 0) {
    const others = input.freshLogicalIds.length > 1 ? " (--startup-from applies to every seat listed with --fresh)" : "";
    routes.push(`start ${input.logicalId} from snapshot ${best.snapshotId}'s copy of its startup files (${best.kind}, taken ${best.createdAt}): rig up ${quote(rigName)} --existing --fresh ${quote(input.logicalId)} --startup-from snapshot:${best.snapshotId}${others}`);
  }
  let leaveOutRefusal: string | null = null;
  if (input.snapshot) {
    const unlisted = input.freshLogicalIds.filter((id) => id !== input.logicalId);
    const validation = validatePreRestore(input.snapshot, {
      fsOps: { exists: input.exists },
      freshLogicalIds: unlisted,
      freshSeatStartup: (node) => startupToValidateForSeat(deps, {
        rigId: input.rigId, logicalId: node.logicalId, adapters: deps.runtimeAdapters, freshLogicalIds: unlisted,
        startupFrom: input.startupFrom, selectedCopy: input.snapshot!.nodeStartupContext?.[node.id] ?? null,
      }),
    });
    const blocker = validation.blockers.find((candidate) => candidate.logicalId === input.logicalId);
    if (blocker) leaveOutRefusal = `${blocker.code}: ${blocker.message}`;
  }
  if (!leaveOutRefusal) routes.push(`leave ${input.logicalId} out of --fresh`);
  const head = `Fix the cause above${routes.map((route) => `, or ${route}`).join("")}.`;
  return leaveOutRefusal
    ? `${head} Leaving ${input.logicalId} out of --fresh does not help: that restore is refused before it starts anything (${leaveOutRefusal}). Restoring with --fresh ${input.logicalId} as it is restores the other seats and starts nothing for ${input.logicalId}.`
    : head;
}

/**
 * What restore would refuse, per listed seat, without starting anything: one entry per seat of `freshLogicalIds`
 * that restore would refuse before launching it (the full text restore reports after "Fresh start refused: ").
 * A seat restore would not reach this decision for (no live node, no adapter for its runtime) has no entry: restore
 * decides nothing there, and neither does this.
 */
export async function predictListedSeatRefusals(
  deps: ListedSeatDecisionDeps & { rigRepo: ListedSeatDecisionDeps["rigRepo"] & { getRig(rigId: string): LiveRig | null } },
  input: { rigId: string; freshLogicalIds: string[]; startupFrom: StartupFrom; snapshot: SnapshotData | null; exists: (path: string) => boolean },
): Promise<Map<string, string>> {
  const refusals = new Map<string, string>();
  const rig = deps.rigRepo.getRig(input.rigId);
  if (!rig) return refusals;
  for (const logicalId of input.freshLogicalIds) {
    const live = rig.nodes.find((node) => node.logicalId === logicalId);
    const runtime = live?.runtime ?? null;
    if (!live || !runtime || !deps.runtimeAdapters[runtime]) continue;
    const snapshotNode = input.snapshot?.nodes?.find((node) => node.logicalId === logicalId);
    // With no snapshot, restore first captures one from the seat's own saved context, verbatim: that is the copy.
    let snapshotCopy: NodeStartupSnapshot | null = null;
    if (input.snapshot) {
      snapshotCopy = snapshotNode ? input.snapshot.nodeStartupContext?.[snapshotNode.id] ?? null : null;
    } else {
      try { snapshotCopy = readNodeStartupSnapshot(deps.db, live.id); } catch { /* not JSON: the capture holds no copy */ }
    }
    const parts = logicalId.split(".");
    const sessionName = live.podId && parts.length >= 2
      ? deriveCanonicalSessionName(parts[0]!, parts.slice(1).join("."), rig.rig.name)
      : deriveSessionName(rig.rig.name, logicalId);
    const decision = await decideListedFreshSeat(deps, {
      rigId: input.rigId, nodeId: live.id, logicalId, rigName: rig.rig.name, runtime, cwd: live.cwd ?? ".",
      sessionName, startupFrom: input.startupFrom, snapshotCopy, exists: input.exists,
    });
    if (decision.refusal) refusals.set(logicalId, decision.refusal);
  }
  return refusals;
}
