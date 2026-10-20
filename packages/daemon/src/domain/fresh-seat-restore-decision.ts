// OF-32 stage 3: the decision restore makes for a seat the operator lists with `--fresh`, before it launches that seat:
// where its startup policy comes from, and whether the files that source names can be delivered. Restore
// (restoreNodeUnisolated) acts on this decision; `rig up --existing --plan` and restore-check ask the same function
// what restore WOULD decide (`predictListedSeatRefusals`), so a prediction cannot be looser than the restore it
// predicts: they run one code path over the same inputs.
import type Database from "better-sqlite3";
import { resolveFreshSeatStartup, type FreshStartupContext, type SeatStartupSpecReader, type StartupFrom } from "./seat-startup-source.js";
import { freshSeatLaunchCommand } from "./active-occupant.js";
import { freshSeatReplaysSnapshotStartup, startupInputFindings } from "./restore-preconditions.js";
import { readOwnStartupForRestore } from "./own-startup-replay.js";
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
 * what restore validates.
 *  - `"resolved_at_launch"`: a seat listed with `--fresh` whose source is decided and checked per seat before its launch.
 *  - a context: the seat's own saved context, which it replays instead of an older snapshot copy. `replayProblem` says
 *    why restore cannot replay that context, when it cannot (it ends the restore or fails the seat).
 *  - `undefined`: the snapshot's copy (no live node, no adapter for its runtime, no own context, or a column that is
 *    not JSON).
 */
export function startupToValidateForSeat(
  deps: { db: Database.Database; rigRepo: { getRig(rigId: string): LiveRig | null; getRigSpecSource(rigId: string): string | null } },
  input: { rigId: string; logicalId: string; adapters: Record<string, RuntimeAdapter | undefined> | undefined; freshLogicalIds?: string[]; startupFrom?: StartupFrom },
): { override: "resolved_at_launch" | NodeStartupSnapshot | undefined; replayProblem: string | null } {
  const live = deps.rigRepo.getRig(input.rigId)?.nodes.find((candidate) => candidate.logicalId === input.logicalId);
  const runtime = live?.runtime ?? null;
  if (!live || !runtime || !input.adapters?.[runtime]) return { override: undefined, replayProblem: null };
  if (input.freshLogicalIds?.includes(input.logicalId)) {
    return {
      override: freshSeatReplaysSnapshotStartup({
        adapterAvailable: true,
        seatHasSavedContext: deps.db.prepare("SELECT 1 FROM node_startup_context WHERE node_id = ?").get(live.id) !== undefined,
        rigSpecReread: (input.startupFrom ?? "spec") === "spec" && !!deps.rigRepo.getRigSpecSource(input.rigId),
      }) ? undefined : "resolved_at_launch",
      replayProblem: null,
    };
  }
  const own = readOwnStartupForRestore(deps.db, live.id);
  return own.kind === "row" ? { override: own.snapshot, replayProblem: own.replayProblem } : { override: undefined, replayProblem: null };
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
  /** The startup context the snapshot holds for this seat (replayed only when the seat has none of its own). */
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
  // startup_context_malformed: the seat's saved context cannot be read, so nothing newer can be lost; the
  // snapshot's copy is replayed (as before stage 3), said in a warning, and a successful launch saves a new one.
  // Refusing here would leave the seat no fresh path at all: `--startup-from stored` reads the same row.
  const snapshotFallback = !decided.ok && (decided.code === "startup_context_missing" || decided.code === "startup_context_malformed");
  const chosen: NodeStartupSnapshot | null = decided.ok ? asReplayContext(decided.context)
    : snapshotFallback ? input.snapshotCopy : null;
  if (!decided.ok && !snapshotFallback) {
    refusal = `${decided.message}${decided.guidance ? ` ${decided.guidance}` : ""}`;
  } else if (chosen) {
    // The checks pre-restore validation runs on the snapshot's copy, run on what this seat will actually be given.
    const findings = startupInputFindings({ id: input.nodeId, logicalId: input.logicalId }, chosen, input.exists, true);
    if (findings.blockers.length > 0) {
      const from = decided.ok && decided.context.source.kind === "spec" ? `read from ${decided.context.source.specSource}`
        : decided.ok ? "saved at the seat's last successful launch" : "in this snapshot";
      refusal = `its startup files (${from}) cannot be delivered: ${findings.blockers.map((blocker) => blocker.message).join("; ")}.`;
    } else {
      warnings.push(...findings.warnings);
    }
  }
  return { decided, snapshotFallback, chosen, refusal, warnings };
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
    // With no snapshot, restore first captures one from the seat's own saved context: that is the copy.
    const own = readOwnStartupForRestore(deps.db, live.id);
    const snapshotCopy = input.snapshot
      ? (snapshotNode ? input.snapshot.nodeStartupContext?.[snapshotNode.id] ?? null : null)
      : own.kind === "row" ? own.snapshot : null;
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
