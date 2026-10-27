import { captureSkippingUnreadable } from "./snapshot-capture.js";
import type Database from "better-sqlite3";
import type { RigRepository } from "./rig-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { SnapshotCapture } from "./snapshot-capture.js";
import type { EventBus } from "./event-bus.js";
import { RigNotFoundError } from "./errors.js";
import type { ResumeMetadataRefresher } from "./resume-metadata-refresher.js";
import fs from "node:fs";
import nodePath from "node:path";
import { removeManagedBlocksFromFile, DEFAULT_CLAUDE_MANAGED_BLOCK_FILE } from "./managed-blocks.js";
import { stopTranscriptRotation } from "./transcript-rotation.js";
import { findOtherSessionOwner } from "./session-owner.js";

export interface TeardownResult {
  rigId: string;
  sessionsKilled: number;
  snapshotId: string | null;
  deleted: boolean;
  deleteBlocked: boolean;
  alreadyStopped: boolean;
  errors: string[];
  /** OF-36 Q1 (Jim, "Skip that seat, warn"): what the teardown did that is worth knowing but is not a failure, such as
   *  a seat whose saved startup context was not copied into the snapshot. `rig down` prints them and still exits 0. */
  warnings?: string[];
}

interface TeardownOptions {
  delete?: boolean;
  /** Reserved for future graceful-stop support. Currently a no-op because
   *  tmux kill-session is already immediate — there is no graceful stop to skip. */
  force?: boolean;
  snapshot?: boolean;
}

interface TeardownDeps {
  db: Database.Database;
  rigRepo: RigRepository;
  sessionRegistry: SessionRegistry;
  tmuxAdapter: TmuxAdapter;
  snapshotCapture: SnapshotCapture;
  eventBus: EventBus;
  resumeMetadataRefresher?: ResumeMetadataRefresher;
  serviceOrchestrator?: import("./service-orchestrator.js").ServiceOrchestrator;
}

interface LatestNodeSession {
  nodeId: string;
  sessionId: string;
  sessionName: string;
  status: string;
  runtime: string | null;
  resumeType: string | null;
  resumeToken: string | null;
  cwd: string | null;
  /** Set on older rows only: an adopted (`claimed`) session is not OpenRig's to kill. */
  origin?: "claimed" | "launched";
}

/** The state one teardown carries from the pre-snapshot duplicate pass into the kill loop. */
interface TeardownRun {
  rigId: string;
  archived: boolean;
  result: TeardownResult;
  killFailures: number;
  /** A tmux name is killed at most once per teardown. Rows sharing a name (a seat's older row often carries the
   *  newest row's name) follow the first row's outcome instead of killing, or reporting a failure, a second time. */
  handledNames: Map<string, "ended" | "failed">;
  /** Duplicate rows ended before the snapshot with no kill of their own (their name is a kept row's): put back if that kill fails. */
  rowsEndedEarly: Array<{ sessionId: string; sessionName: string; status: string }>;
  /** Per node, the tmux names of its live adopted (`claimed`) rows. */
  claimedNames: ReadonlyMap<string, ReadonlySet<string>>;
  currentLiveGuidanceTargets: () => Set<string>;
}

/**
 * Graceful rig shutdown. Kills tmux sessions, clears bindings, marks
 * sessions exited. Optionally snapshots before teardown, optionally
 * deletes rig record.
 */
export class RigTeardownOrchestrator {
  readonly db: Database.Database;
  private deps: TeardownDeps;

  constructor(deps: TeardownDeps) {
    if (deps.db !== deps.rigRepo.db) throw new Error("RigTeardownOrchestrator: rigRepo must share the same db handle");
    if (deps.db !== deps.sessionRegistry.db) throw new Error("RigTeardownOrchestrator: sessionRegistry must share the same db handle");
    if (deps.db !== deps.eventBus.db) throw new Error("RigTeardownOrchestrator: eventBus must share the same db handle");
    if (deps.db !== deps.snapshotCapture.db) throw new Error("RigTeardownOrchestrator: snapshotCapture must share the same db handle");
    this.db = deps.db;
    this.deps = deps;
  }

  async teardown(rigId: string, opts?: TeardownOptions): Promise<TeardownResult> {
    // 1. Validate rig
    const rig = this.deps.rigRepo.getRig(rigId);
    if (!rig) throw new RigNotFoundError(rigId);

    const guard = this.deps.tmuxAdapter.deliveryGuard;
    const ids = rig.nodes.map(node => node.id);
    if (guard && ids.some(id => !guard.ownsLifecycle(id))) return guard.lifecycle(ids, () => this.teardown(rigId, opts));
    const result: TeardownResult = {
      rigId, sessionsKilled: 0, snapshotId: null,
      deleted: false, deleteBlocked: false, alreadyStopped: false, errors: [],
    };
    const archived = this.db.prepare("SELECT archived_at FROM rigs WHERE id = ?").get(rigId) as { archived_at: string | null };
    // A live seat can create its guidance while teardown awaits tmux. Resolve
    // file identities only after those waits, immediately before each cleanup.
    const currentLiveGuidanceTargets = () => this.liveGuidanceTargets(rigId);

    // 2. Get latest session per node
    const liveSessions = this.getLatestLiveSessions(rigId);
    // OF-54: a seat's older rows can still be live when its newest row is not (or is a dead running row).
    const olderLiveSessions = this.deps.sessionRegistry.getOlderLiveSessions(rigId);

    // 3. Check if already stopped
    if (liveSessions.length === 0 && olderLiveSessions.length === 0) {
      // Additional intent is best-effort; keep down's existing result if it cannot be recorded.
      await this.recordAlreadyStoppedIntent(rigId).catch(() => {});
      this.cleanupManagedGuidanceFiles(rigId, currentLiveGuidanceTargets());
      result.alreadyStopped = true;
      // Still tear down services even if no agent sessions are running
      if (this.deps.serviceOrchestrator) {
        try {
          const serviceResult = await this.deps.serviceOrchestrator.teardown(rigId);
          if (!serviceResult.ok) result.errors.push(`Service teardown warning: ${serviceResult.error}`);
          else if (serviceResult.kept) result.errors.push(serviceResult.kept);
        } catch (err) {
          result.errors.push(`Service teardown warning: ${(err as Error).message}`);
        }
      }
      // Skip to delete if requested
      if (opts?.delete) {
        this.atomicDelete(rigId);
        result.deleted = true;
      } else {
        this.deps.eventBus.emit({ type: "rig.stopped", rigId });
      }
      return result;
    }

    // 3b. OF-116 F7 (Jim, 2026-10-27): a seat's older duplicate live rows end BEFORE the auto-pre-down snapshot, so the
    // snapshot records ONE running occupant for the seat instead of an active-occupant ambiguity that `rig up --existing`
    // then fails the seat on. Only a row with a LATER live row on the same seat is a duplicate: an older row that is the
    // seat's only live occupant is still recorded as the occupant.
    const c: TeardownRun = {
      rigId, archived: archived.archived_at !== null, result, killFailures: 0,
      handledNames: new Map(), rowsEndedEarly: [],
      claimedNames: this.deps.sessionRegistry.getClaimedLiveSessionNames(rigId),
      currentLiveGuidanceTargets,
    };
    const supersededDuplicates = this.deps.sessionRegistry.getSupersededLiveSessions(rigId);
    if (supersededDuplicates.length > 0) {
      const duplicateIds = new Set(supersededDuplicates.map(session => session.sessionId));
      const keptNames = new Map<string, Set<string>>();
      for (const kept of [...liveSessions, ...olderLiveSessions]) {
        if (duplicateIds.has(kept.sessionId)) continue;
        let names = keptNames.get(kept.nodeId);
        if (!names) keptNames.set(kept.nodeId, names = new Set());
        names.add(kept.sessionName);
      }
      for (const duplicate of supersededDuplicates) {
        if (duplicate.origin !== "claimed" && keptNames.get(duplicate.nodeId)?.has(duplicate.sessionName)) {
          // The seat's kept row carries this very tmux name, so there is no second session to kill: end the ROW only (the
          // kept row's kill, below, ends the session). A failed kill puts the row back.
          this.deps.sessionRegistry.markIntentionallyStopped(duplicate.sessionId);
          c.rowsEndedEarly.push({ sessionId: duplicate.sessionId, sessionName: duplicate.sessionName, status: duplicate.status });
          continue;
        }
        await this.endSession(duplicate, true, c);
      }
    }
    // What is still live and older once the duplicates are ended: the rows the kill loop below acts on.
    const olderRemaining = supersededDuplicates.length > 0 ? this.deps.sessionRegistry.getOlderLiveSessions(rigId) : olderLiveSessions;

    // 4. Auto-snapshot before teardown (always, best-effort)
    try {
      if (this.deps.resumeMetadataRefresher) {
        // A live namesake cannot supply resume metadata for an archived row.
        // Keep that row's own token in the snapshot, just as the kill below
        // leaves the other owner's session alone.
        const refreshableSessions = archived.archived_at === null ? liveSessions : liveSessions.filter(
          session => findOtherSessionOwner(this.db, session.sessionName, session.nodeId, { countReleased: true, ignoreArchived: true }) === null,
        );
        await this.deps.resumeMetadataRefresher.refresh(refreshableSessions);
      }
    } catch (err) {
      result.errors.push(`Resume metadata refresh failed: ${(err as Error).message}`);
    }
    // Discovery is best-effort; preserve the durable ledger even if it fails.
    try {
      // OF-36 Q1: a seat whose saved startup context is not JSON is captured with no copy, and warned, instead of
      // failing the whole rig's snapshot.
      const { snapshot: snap, warnings } = captureSkippingUnreadable(this.deps.snapshotCapture, rigId, "auto-pre-down");
      result.snapshotId = snap.id;
      if (warnings.length > 0) result.warnings = warnings;
    } catch (err) {
      result.errors.push(`Snapshot failed: ${(err as Error).message}`);
      // Best-effort — teardown proceeds even if snapshot fails
    }

    // 5. Kill each live session
    const olderIds = new Set(olderRemaining.map(session => session.sessionId));
    for (const session of [...liveSessions, ...olderRemaining]) {
      await this.endSession(session, olderIds.has(session.sessionId), c);
    }
    // A name whose kill failed is still live, so a duplicate row that was ended early only to keep the snapshot readable
    // goes back to running: the failure leaves every row of that name live (OF-68 F8).
    for (const early of c.rowsEndedEarly) {
      if (c.handledNames.get(early.sessionName) === "failed") this.deps.sessionRegistry.updateStatus(early.sessionId, early.status);
    }
    const killFailures = c.killFailures;
    // Stop live sessions before probing historical rows; bookkeeping must not fail down.
    await this.recordAlreadyStoppedIntent(rigId).catch(() => {});
    this.cleanupManagedGuidanceFiles(rigId, currentLiveGuidanceTargets());

    // 5b. Tear down services if they exist
    if (this.deps.serviceOrchestrator) {
      try {
        const serviceResult = await this.deps.serviceOrchestrator.teardown(rigId);
        if (!serviceResult.ok) result.errors.push(`Service teardown warning: ${serviceResult.error}`);
        else if (serviceResult.kept) result.errors.push(serviceResult.kept);
      } catch (err) {
        result.errors.push(`Service teardown warning: ${(err as Error).message}`);
        // Best-effort — rig teardown continues
      }
    }

    // 6. Delete if requested (blocked by kill failures)
    if (opts?.delete) {
      if (killFailures > 0) {
        result.errors.push("Rig deletion blocked: some sessions could not be killed");
        result.deleted = false;
        result.deleteBlocked = true;
      } else {
        try {
          this.atomicDelete(rigId);
          result.deleted = true;
        } catch (err) {
          result.errors.push(`Rig deletion failed: ${(err as Error).message}`);
          result.deleted = false;
        }
      }
    } else {
      // Emit stopped event
      this.deps.eventBus.emit({ type: "rig.stopped", rigId });
    }

    return result;
  }

  /**
   * Ends one live session row of a rig being taken down: kills its tmux session (or leaves it alone when it is not this
   * seat's to kill) and records the outcome on the row. `older`: the row is not its seat's latest, so it never owns the
   * seat's binding. A tmux name is killed at most once per teardown (`c.handledNames`).
   */
  private async endSession(session: LatestNodeSession, older: boolean, c: TeardownRun): Promise<void> {
    const { result, handledNames } = c;
    const handled = handledNames.get(session.sessionName);
    if (handled === "failed") {
      // The first row's kill (or probe) failed and already said so: the session is still live, so this row stays
      // live too, and the rig is not fully down (delete stays blocked).
      c.killFailures++;
      return;
    }
    if (older && session.origin === "claimed" && handled === undefined) {
      // An adopted session is not OpenRig's to kill (`rig seat stop` refuses it), but the seat has moved past this
      // row. End the ROW only, with no stop intent (nothing of ours stopped it), and leave its tmux session running.
      // `detached` (what `rig unclaim` writes), not `exited`, so the row still holds the name against another seat's kill.
      this.deps.sessionRegistry.updateStatus(session.sessionId, "detached");
      (result.warnings ??= []).push(`Session '${session.sessionName}' is an older row of this seat that was adopted (origin=claimed), not launched by OpenRig: its row was ended and its tmux session was left running. Release it with: rig unclaim ${session.sessionId}`);
      return;
    }
    // An archived rig may retain a stale row for a name now owned by a live rig.
    // That name cannot identify the archived rig's tmux session for a kill.
    // An OLDER row's name is only a historical label: any other live owner of that name
    // (OF-54) means the tmux session is not this seat's to kill, whatever the rig's state.
    const ownedByAnotherRig = (older || c.archived) && findOtherSessionOwner(
      this.db, session.sessionName, session.nodeId, { countReleased: true, ignoreArchived: true },
    ) !== null;
    // OF-116 N3: an older launched row that carries the name of an adopted session of the SAME seat is not a second
    // session: the name is the person's. The row ends; the session is left running.
    const adoptedNameOfThisSeat = older && session.origin !== "claimed" && (c.claimedNames.get(session.nodeId)?.has(session.sessionName) ?? false);
    const notOursToKill = ownedByAnotherRig || adoptedNameOfThisSeat;
    let absent = notOursToKill || handled === "ended";
    if (!absent && this.deps.tmuxAdapter.probeSession) {
      try {
        const probe = await this.deps.tmuxAdapter.probeSession(session.sessionName);
        absent = probe.state === "absent";
        if (probe.state !== "present" && !absent) {
          result.errors.push(`Could not confirm session '${session.sessionName}' is absent: ${probe.state === "transport_unavailable" ? probe.cause : probe.state}`);
          c.killFailures++;
          handledNames.set(session.sessionName, "failed");
          return;
        }
      } catch (err) {
        result.errors.push(`Could not check session '${session.sessionName}': ${(err as Error).message}`);
        c.killFailures++;
        handledNames.set(session.sessionName, "failed");
        return;
      }
    }
    const killResult = absent ? { ok: false, code: "session_not_found" } :
      await this.deps.tmuxAdapter.killSession(session.sessionName);

    const missingSession = (killResult as { code?: string; message?: string }).code === "session_not_found" &&
      !/no server running/i.test((killResult as { message?: string }).message ?? "");
    if (killResult.ok || missingSession) {
      // Stop capture only when termination is confirmed. A failed kill leaves
      // the session running. An archived namesake leaves the live owner's
      // rotation intact even when its stale row is removed.
      if (!notOursToKill) {
        stopTranscriptRotation(session.sessionName);
        handledNames.set(session.sessionName, "ended");
      }
      // Success or already gone — update DB atomically
      // An older row never owns the node's binding: the newest row's kill outcome decides that.
      if (older) this.deps.sessionRegistry.markIntentionallyStopped(session.sessionId);
      else this.atomicNodeCleanup(session);
      this.cleanupManagedGuidanceFileForNode(c.rigId, session.runtime, session.cwd, c.currentLiveGuidanceTargets());
      if (killResult.ok) result.sessionsKilled++;
    } else {
      // Real kill failure — don't update this node
      result.errors.push(`Kill failed for session '${session.sessionName}': ${(killResult as { message?: string }).message ?? "unknown"}`);
      c.killFailures++;
      handledNames.set(session.sessionName, "failed");
    }
  }

  /** Atomically record the supported stop and clear its binding. */
  private atomicNodeCleanup(session: LatestNodeSession): void {
    const tx = this.db.transaction(() => {
      this.deps.sessionRegistry.markIntentionallyStopped(session.sessionId);
      this.deps.sessionRegistry.clearBinding(session.nodeId);
    });
    tx();
  }

  /** An explicit down also covers already-detached seats, but neither a stale
   * row nor an unavailable probe proves that its session is absent. */
  private async recordAlreadyStoppedIntent(rigId: string): Promise<void> {
    const probe = this.deps.tmuxAdapter.probeSession;
    if (!probe) return;
    const eligible = this.db.prepare(`
      SELECT s.id, s.node_id, s.session_name FROM sessions s JOIN nodes n ON n.id = s.node_id
      WHERE n.rig_id = ? AND s.status IN ('exited', 'detached')
        AND s.intentionally_stopped = 0
        AND s.id = (SELECT latest.id FROM sessions latest WHERE latest.node_id = n.id
          ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1)
    `);
    for (const row of eligible.all(rigId) as Array<{ id: string; node_id: string; session_name: string }>) {
      const binding = this.deps.sessionRegistry.getBindingForNode(row.node_id);
      if (binding && (binding.attachmentType !== "tmux" || binding.tmuxSession !== row.session_name)) continue;
      try {
        if ((await probe.call(this.deps.tmuxAdapter, row.session_name)).state !== "absent") continue;
      } catch {
        continue;
      }
      this.db.transaction(() => {
        // A launch may have rebound the node while the absence probe awaited.
        if ((eligible.all(rigId) as Array<{ id: string }>).some(current => current.id === row.id)
          && JSON.stringify(this.deps.sessionRegistry.getBindingForNode(row.node_id)) === JSON.stringify(binding)) {
          this.deps.sessionRegistry.markIntentionallyStopped(row.id);
          this.deps.sessionRegistry.clearBinding(row.node_id);
        }
      })();
    }
  }

  /** Atomically delete rig + persist rig.deleted event */
  private atomicDelete(rigId: string): void {
    let persistedSeq = 0;
    let persistedAt = "";
    const tx = this.db.transaction(() => {
      const event = this.deps.eventBus.persistWithinTransaction({ type: "rig.deleted", rigId });
      persistedSeq = event.seq;
      persistedAt = event.createdAt;
      this.deps.rigRepo.deleteRig(rigId);
    });
    tx();
    this.deps.eventBus.notifySubscribers({
      type: "rig.deleted", rigId, seq: persistedSeq, createdAt: persistedAt,
    });
  }

  /** Get latest session per node, filtered to live statuses.
   *  OPR.0.4.3.20 FR-4 — delegates to the shared SessionRegistry method so the
   *  teardown pre-down path and the periodic/manual snapshot refresh share ONE query. */
  private getLatestLiveSessions(rigId: string): LatestNodeSession[] {
    return this.deps.sessionRegistry.getLatestLiveSessions(rigId);
  }

  private liveGuidanceTargets(rigId: string): Set<string> {
    const rows = this.db.prepare(`
      SELECT n.rig_id, n.runtime, n.cwd FROM nodes n
      JOIN rigs r ON r.id = n.rig_id
      WHERE r.archived_at IS NULL AND r.id <> ? AND n.cwd IS NOT NULL
    `).all(rigId) as Array<{ rig_id: string; runtime: string | null; cwd: string }>;
    const targets = new Set<string>();
    for (const row of rows) {
      const target = this.guidanceTargetPath(row.rig_id, row.runtime, row.cwd);
      if (target) targets.add(this.guidancePathKey(target));
    }
    // A failed kill or inconclusive probe leaves this rig's session live.
    // Its file may also be shared with a sibling that stopped successfully.
    for (const session of [...this.getLatestLiveSessions(rigId), ...this.deps.sessionRegistry.getOlderLiveSessions(rigId)]) {
      const target = this.guidanceTargetPath(rigId, session.runtime, session.cwd);
      if (target) targets.add(this.guidancePathKey(target));
    }
    return targets;
  }

  private cleanupManagedGuidanceFiles(rigId: string, liveGuidanceTargets: ReadonlySet<string>): void {
    const rows = this.db.prepare(`
      SELECT DISTINCT runtime, cwd
      FROM nodes
      WHERE rig_id = ?
    `).all(rigId) as Array<{ runtime: string | null; cwd: string | null }>;
    for (const row of rows) {
      this.cleanupManagedGuidanceFileForNode(rigId, row.runtime, row.cwd, liveGuidanceTargets);
    }
  }

  private guidanceTargetPath(rigId: string, runtime: string | null, cwd: string | null): string | null {
    if (!runtime || !cwd) {
      return null;
    }
    // #25: clean only the rig's selected Claude file; the other file is never touched.
    return runtime === "claude-code"
      ? nodePath.join(cwd, this.deps.rigRepo.getRigClaudeManagedBlockFile(rigId) ?? DEFAULT_CLAUDE_MANAGED_BLOCK_FILE)
      : runtime === "codex"
        ? nodePath.join(cwd, "AGENTS.md")
        : null;
  }

  private guidancePathKey(path: string): string {
    const resolved = nodePath.resolve(path);
    try {
      const real = fs.realpathSync.native(resolved);
      const stat = fs.statSync(real);
      // File identity covers symlinks, hard links, and case aliases on a
      // case-insensitive volume without assuming all volumes behave alike.
      if (stat.ino !== 0) return `file:${stat.dev}:${stat.ino}`;
      return `path:${process.platform === "win32" ? real.toLowerCase() : real}`;
    } catch {
      // Cleanup is a no-op for a missing file; keep a stable path key for it.
      return `path:${process.platform === "win32" ? resolved.toLowerCase() : resolved}`;
    }
  }

  private cleanupManagedGuidanceFileForNode(rigId: string, runtime: string | null, cwd: string | null, liveGuidanceTargets: ReadonlySet<string>): void {
    const targetPath = this.guidanceTargetPath(rigId, runtime, cwd);
    if (!targetPath) {
      return;
    }
    if (liveGuidanceTargets.has(this.guidancePathKey(targetPath))) return;
    removeManagedBlocksFromFile({
      exists: (path) => fs.existsSync(path),
      readFile: (path) => fs.readFileSync(path, "utf-8"),
      writeFile: (path, content) => fs.writeFileSync(path, content, "utf-8"),
      deleteFile: (path) => fs.unlinkSync(path),
    }, targetPath);
  }
}
