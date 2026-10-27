import type Database from "better-sqlite3";
import {
  deriveActiveOccupantsByNode,
  deriveActiveSessionIdByNode,
  deriveRehydrateOccupantsByNode,
  deriveRehydrateSessionIdByNode,
} from "./active-occupant.js";
import type { RigRepository } from "./rig-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { EventBus } from "./event-bus.js";
import type { SnapshotRepository } from "./snapshot-repository.js";
import type { PersistedEvent } from "./types.js";
import type { CheckpointStore } from "./checkpoint-store.js";
import type { Snapshot, SnapshotData } from "./types.js";
import { RigNotFoundError } from "./errors.js";

/** A node's saved startup context (node_startup_context) exactly as a snapshot copies it; null when it has none.
 *  Throws when a column is not JSON. OF-32: restore reads a seat's own saved context through this too, so a seat it
 *  starts fresh replays its saved setup in the same shape a snapshot would have held it. */
export function readNodeStartupSnapshot(db: Database.Database, nodeId: string): import("./types.js").NodeStartupSnapshot | null {
  const ctx = db.prepare("SELECT * FROM node_startup_context WHERE node_id = ?")
    .get(nodeId) as { projection_entries_json: string; resolved_files_json: string; startup_actions_json: string; runtime: string } | undefined;
  return ctx ? {
    projectionEntries: JSON.parse(ctx.projection_entries_json),
    resolvedStartupFiles: JSON.parse(ctx.resolved_files_json),
    startupActions: JSON.parse(ctx.startup_actions_json),
    runtime: ctx.runtime,
  } : null;
}
import { readFreshOccupantRelations } from "./fresh-occupant-relation.js";
import { savedRowDamage, savedRowDamageMessage } from "./node-row-damage.js";

interface SnapshotCaptureDeps {
  db: Database.Database;
  rigRepo: RigRepository;
  sessionRegistry: SessionRegistry;
  eventBus: EventBus;
  snapshotRepo: SnapshotRepository;
  checkpointStore: CheckpointStore;
}

export class SnapshotCapture {
  readonly db: Database.Database;
  private rigRepo: RigRepository;
  private sessionRegistry: SessionRegistry;
  private eventBus: EventBus;
  private snapshotRepo: SnapshotRepository;
  private checkpointStore: CheckpointStore;

  constructor(deps: SnapshotCaptureDeps) {
    if (deps.db !== deps.rigRepo.db) {
      throw new Error("SnapshotCapture: rigRepo must share the same db handle");
    }
    if (deps.db !== deps.sessionRegistry.db) {
      throw new Error("SnapshotCapture: sessionRegistry must share the same db handle");
    }
    if (deps.db !== deps.eventBus.db) {
      throw new Error("SnapshotCapture: eventBus must share the same db handle");
    }
    if (deps.db !== deps.snapshotRepo.db) {
      throw new Error("SnapshotCapture: snapshotRepo must share the same db handle");
    }
    if (deps.db !== deps.checkpointStore.db) {
      throw new Error("SnapshotCapture: checkpointStore must share the same db handle");
    }

    this.db = deps.db;
    this.rigRepo = deps.rigRepo;
    this.sessionRegistry = deps.sessionRegistry;
    this.eventBus = deps.eventBus;
    this.snapshotRepo = deps.snapshotRepo;
    this.checkpointStore = deps.checkpointStore;
  }

  captureSnapshot(rigId: string, kind: string, opts?: {
    intendedNodeIds?: string[];
    /** N-C3: with this, a seat whose saved startup context has a column that is not JSON is captured with no copy
     *  (null) and reported here, instead of failing the whole capture. Every automatic capture passes it, through
     *  `captureSkippingUnreadable`; the manual `rig snapshot` capture does not. */
    onUnreadableStartupContext?: (nodeId: string, message: string) => void;
    /** OF-45: with this, a seat whose saved package_refs / session_source_json is damaged is captured with that
     *  damage kept on the node (`packageRefsUnreadable` / `sessionSourceUnreadable`, never a quiet empty value) and
     *  reported here. Without it the capture refuses, naming the seat. */
    onUnreadableNodeRow?: (nodeId: string, message: string) => void;
    /** OF-51: a node's newest checkpoint whose saved key-artifact list is not readable is captured with the flag
     *  (`keyArtifactsUnreadable`, an empty list) and reported here. Never refuses: the list only feeds a resume prompt. */
    onUnreadableCheckpoint?: (nodeId: string, message: string) => void;
  }): Snapshot {
    // 1. Get rig with nodes, edges, bindings
    const rig = this.rigRepo.getRig(rigId);
    if (!rig) {
      throw new RigNotFoundError(rigId);
    }

    // 1b. OF-45: a damaged saved package list / session source reads as empty on the node, which a snapshot would
    // otherwise persist as if the seat had declared none.
    for (const node of rig.nodes) {
      const damage = savedRowDamage(node);
      if (damage.length === 0) continue;
      const message = savedRowDamageMessage(node.logicalId, damage);
      if (!opts?.onUnreadableNodeRow) throw new Error(`Cannot snapshot: ${message}. Repair the row, then snapshot again.`);
      opts.onUnreadableNodeRow(node.id, message);
    }

    // 2. Get sessions with resume metadata
    const sessions = this.sessionRegistry.getSessionsForRig(rigId);

    // 2b. OPR.0.5.7.1 D1 — capture the ACTIVE-OCCUPANT relation explicitly,
    // through the ONE shared derivation (active-occupant.ts) that the live
    // no-snapshot preview also uses, so the sibling paths cannot drift.
    const recorded = kind === "auto-rehydrate" ? readFreshOccupantRelations(this.db, rigId) : {};
    const activeSessionIdByNode = kind === "auto-rehydrate"
      ? deriveRehydrateSessionIdByNode(sessions, rig.nodes.map((n) => n.id), recorded)
      : deriveActiveSessionIdByNode(sessions, rig.nodes.map((n) => n.id));
    const activeOccupantsByNode = kind === "auto-rehydrate"
      ? deriveRehydrateOccupantsByNode(sessions, rig.nodes.map((n) => n.id), recorded)
      : deriveActiveOccupantsByNode(sessions, rig.nodes.map((n) => n.id));

    const requestedRoster = opts?.intendedNodeIds;
    const materializedRoster = requestedRoster ? null : this.materializedRoster(rigId);
    const intendedNodeIds = requestedRoster ?? materializedRoster ?? rig.nodes.map((node) => node.id);
    const allNodeIds = new Set(rig.nodes.map((node) => node.id));
    if (
      new Set(intendedNodeIds).size !== intendedNodeIds.length
      || intendedNodeIds.some((nodeId) => !allNodeIds.has(nodeId))
    ) {
      throw new Error("Snapshot intended roster must contain unique node ids belonging to the target rig");
    }

    // 3. Get checkpoints as map (latest per node)
    const checkpoints = this.checkpointStore.getCheckpointsForRig(rigId);
    for (const [nodeId, checkpoint] of Object.entries(checkpoints)) {
      if (checkpoint?.keyArtifactsUnreadable) opts?.onUnreadableCheckpoint?.(nodeId, "its saved key-artifact list is not a JSON list of strings");
    }

    // 4. Get pods + continuity state + startup context
    const podRows = this.db.prepare("SELECT * FROM pods WHERE rig_id = ?")
      .all(rigId) as Array<{ id: string; rig_id: string; namespace: string; label: string; summary: string | null; continuity_policy_json: string | null; created_at: string }>;
    const podIds = podRows.map((p) => p.id);
    const continuityRows = podIds.length > 0
      ? this.db.prepare(`SELECT * FROM continuity_state WHERE pod_id IN (${podIds.map(() => "?").join(",")})`)
          .all(...podIds) as Array<{ pod_id: string; node_id: string; status: string; artifacts_json: string | null; last_sync_at: string | null; updated_at: string }>
      : [];

    const nodeStartupContext: Record<string, import("./types.js").NodeStartupSnapshot | null> = {};
    for (const node of rig.nodes) {
      const onUnreadable = opts?.onUnreadableStartupContext;
      if (!onUnreadable) {
        nodeStartupContext[node.id] = readNodeStartupSnapshot(this.db, node.id);
        continue;
      }
      try {
        nodeStartupContext[node.id] = readNodeStartupSnapshot(this.db, node.id);
      } catch (err) {
        nodeStartupContext[node.id] = null;
        onUnreadable(node.id, (err as Error).message);
      }
    }

    // 4b. Get env receipt from services record if services exist
    const servicesRecord = this.rigRepo.getServicesRecord(rigId);
    let envReceipt: import("./types.js").EnvReceipt | null = null;
    if (servicesRecord?.latestReceiptJson) {
      try {
        envReceipt = JSON.parse(servicesRecord.latestReceiptJson);
      } catch { /* receipt_only — no checkpoint available */ }
    }

    // 5. Assemble SnapshotData
    const data: SnapshotData = {
      rig: rig.rig,
      nodes: rig.nodes,
      edges: rig.edges,
      sessions,
      activeSessionIdByNode,
      activeOccupantsByNode,
      topologyRoster: {
        version: 1,
        source: requestedRoster
          ? "operator_explicit"
          : materializedRoster
            ? "materialized_topology"
            : "legacy_current_nodes",
        intendedNodeIds,
      },
      checkpoints,
      pods: podRows.map((p) => ({ id: p.id, rigId: p.rig_id, namespace: p.namespace, label: p.label, summary: p.summary, continuityPolicyJson: p.continuity_policy_json, createdAt: p.created_at })),
      continuityStates: continuityRows.map((r) => ({ podId: r.pod_id, nodeId: r.node_id, status: r.status as "healthy" | "degraded" | "restoring", artifactsJson: r.artifacts_json, lastSyncAt: r.last_sync_at, updatedAt: r.updated_at })),
      nodeStartupContext,
      envReceipt,
    };

    // 5. Atomic: persist snapshot + event in one transaction
    const txn = this.db.transaction(() => {
      const snapshot = this.snapshotRepo.createSnapshot(rigId, kind, data);
      const persistedEvent = this.eventBus.persistWithinTransaction({
        type: "snapshot.created",
        rigId,
        snapshotId: snapshot.id,
        kind,
      });
      return { snapshot, persistedEvent };
    });

    const { snapshot, persistedEvent } = txn();

    // 6. Notify subscribers after commit (best-effort)
    this.eventBus.notifySubscribers(persistedEvent);

    return snapshot;
  }

  private materializedRoster(rigId: string): string[] | null {
    const row = this.db.prepare(
      "SELECT payload FROM events WHERE rig_id = ? AND type = 'topology.roster_recorded' ORDER BY seq DESC LIMIT 1",
    ).get(rigId) as { payload: string } | undefined;
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.payload) as { intendedNodeIds?: unknown };
      if (!Array.isArray(parsed.intendedNodeIds) || !parsed.intendedNodeIds.every((id) => typeof id === "string")) {
        throw new Error("latest topology roster event has no string intendedNodeIds array");
      }
      return parsed.intendedNodeIds;
    } catch (error) {
      throw new Error(`Cannot capture snapshot from malformed authoritative topology roster: ${(error as Error).message}`);
    }
  }
}

/**
 * OF-36 Q1 (Jim, 2026-10-20: "Skip that seat, warn"): an automatic capture (`rig down`'s auto-pre-down, the periodic
 * capture, every auto-rehydrate capture) does not fail the whole rig's snapshot because one seat's saved startup
 * context has a column that is not JSON. That seat is captured with no copy (null), and a warning says so. Restore
 * never replays a copy it cannot use: a seat it starts fresh replays the newest valid snapshot copy, or is refused when
 * there is none (own-startup-replay.ts). A free function over `captureSnapshot`, so any capture seam works with it.
 */
export function captureSkippingUnreadable(
  capture: Pick<SnapshotCapture, "captureSnapshot"> & { db?: Database.Database },
  rigId: string,
  kind: string,
  opts?: { intendedNodeIds?: string[] },
): { snapshot: Snapshot; warnings: string[] } {
  const warnings: string[] = [];
  const snapshot = capture.captureSnapshot(rigId, kind, {
    ...opts,
    onUnreadableNodeRow: (_nodeId, message) => {
      warnings.push(`Snapshot (${kind}) records ${message}; that damage is kept on the seat in the snapshot, not read as an empty value. The rest of the rig was captured.`);
    },
    onUnreadableCheckpoint: (nodeId, message) => {
      let logicalId = nodeId;
      try {
        logicalId = (capture.db?.prepare("SELECT logical_id FROM nodes WHERE id = ?").get(nodeId) as { logical_id: string } | undefined)?.logical_id ?? nodeId;
      } catch { /* the node id names it */ }
      warnings.push(`Snapshot (${kind}) holds ${logicalId}'s newest checkpoint with an empty key-artifact list: ${message}. The snapshot keeps the flag, not a quiet empty list.`);
    },
    onUnreadableStartupContext: (nodeId, message) => {
      let logicalId = nodeId;
      try {
        logicalId = (capture.db?.prepare("SELECT logical_id FROM nodes WHERE id = ?").get(nodeId) as { logical_id: string } | undefined)?.logical_id ?? nodeId;
      } catch { /* the node id names it */ }
      warnings.push(`Snapshot (${kind}) holds no copy of ${logicalId}'s saved startup context: a column of it is not JSON (${message}). The rest of the rig was captured.`);
    },
  });
  return { snapshot, warnings };
}
