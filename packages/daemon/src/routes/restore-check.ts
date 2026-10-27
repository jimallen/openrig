import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type Database from "better-sqlite3";
import { Hono } from "hono";
import { OPENRIG_HOME } from "../openrig-compat.js";
import { RestoreCheckService, type RestoreCheckDeps, type RestoreParityDeps, type NodeInventoryEntry, type StartupContextProbeResult } from "../domain/restore-check-service.js";
import { listedRefusalRemedy, predictListedSeatRefusals, startupToValidateForSeat } from "../domain/fresh-seat-restore-decision.js";
import { STARTUP_FROM_FORMS, parseStartupFrom, type SeatStartupSpecReader, type StartupFrom } from "../domain/seat-startup-source.js";
import { predictSeatStops } from "../domain/restore-seat-gates.js";
import { findOtherSessionOwner } from "../domain/session-owner.js";
import { activeOccupantAmbiguityError, deriveRehydrateOccupantsByNode } from "../domain/active-occupant.js";
import { readFreshOccupantRelations } from "../domain/fresh-occupant-relation.js";
import { savedRowDamage } from "../domain/node-row-damage.js";
import { classifyRunningSessions } from "../domain/restore-running-sessions.js";
import { SessionRegistry } from "../domain/session-registry.js";
import type { RuntimeAdapter } from "../domain/runtime-adapter.js";
import { deriveRelayEvents } from "../domain/claude-activity-hooks.js";
import { getNodeInventory } from "../domain/node-inventory.js";
import { resolveLegacyTopologyRigsRoot } from "../domain/user-settings/settings-store.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import { classifySessionLiveness, SESSION_LIVENESS_DEADLINE_MS } from "../domain/session-liveness.js";
import type { RigRepository } from "../domain/rig-repository.js";
import { isUnreadableSnapshot, type SnapshotRepository } from "../domain/snapshot-repository.js";
import { assessCurrentStateRehydrateEligibility, snapshotMatchesCurrentOccupants } from "../domain/rehydrate-eligibility.js";

function getDeps(c: { get(key: never): unknown }): {
  rigRepo: RigRepository;
  snapshotRepo: SnapshotRepository;
} {
  return {
    rigRepo: c.get("rigRepo" as never) as RigRepository,
    snapshotRepo: c.get("snapshotRepo" as never) as SnapshotRepository,
  };
}

export const restoreCheckRoutes = new Hono();

function getNodeIdMap(db: Database.Database, rigId: string): Map<string, string> {
  const rows = db.prepare(
    "SELECT id, logical_id FROM nodes WHERE rig_id = ?"
  ).all(rigId) as Array<{ id: string; logical_id: string }>;
  return new Map(rows.map((row) => [row.logical_id, row.id]));
}

function parseStartupContextJsonField<T>(
  raw: string,
  fieldName: string,
  nodeId: string,
): { ok: true; value: T } | { ok: false; evidence: string } {
  try {
    const parsed = JSON.parse(raw) as T;
    return { ok: true, value: parsed };
  } catch (err) {
    return {
      ok: false,
      evidence: `Persisted startup context JSON parse failed for node ${nodeId} field ${fieldName}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function getStartupContext(db: Database.Database, nodeId: string): StartupContextProbeResult {
  try {
    const row = db.prepare(
      "SELECT projection_entries_json, resolved_files_json, startup_actions_json, runtime FROM node_startup_context WHERE node_id = ?"
    ).get(nodeId) as
      | {
          projection_entries_json: string;
          resolved_files_json: string;
          startup_actions_json: string;
          runtime: string | null;
        }
      | undefined;

    if (!row) {
      return {
        status: "missing",
        evidence: `Persisted startup context missing for node ${nodeId}`,
      };
    }

    const resolvedFiles = parseStartupContextJsonField<unknown[]>(row.resolved_files_json, "resolved_files_json", nodeId);
    if (!resolvedFiles.ok) {
      return { status: "malformed", evidence: resolvedFiles.evidence };
    }
    if (!Array.isArray(resolvedFiles.value)) {
      return {
        status: "malformed",
        evidence: `Persisted startup context field resolved_files_json is not an array for node ${nodeId}`,
      };
    }

    const projectionEntries = parseStartupContextJsonField<unknown[]>(row.projection_entries_json, "projection_entries_json", nodeId);
    if (!projectionEntries.ok) {
      return { status: "malformed", evidence: projectionEntries.evidence };
    }
    if (!Array.isArray(projectionEntries.value)) {
      return {
        status: "malformed",
        evidence: `Persisted startup context field projection_entries_json is not an array for node ${nodeId}`,
      };
    }
    if (projectionEntries.value.some((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return true;
      const candidate = entry as Record<string, unknown>;
      return typeof candidate["absolutePath"] !== "string" || candidate["absolutePath"].trim() === "";
    })) {
      return { status: "malformed", evidence: `Persisted startup context field projection_entries_json contains an invalid selection member for node ${nodeId}` };
    }

    const startupActions = parseStartupContextJsonField<unknown[]>(row.startup_actions_json, "startup_actions_json", nodeId);
    if (!startupActions.ok) {
      return { status: "malformed", evidence: startupActions.evidence };
    }
    if (!Array.isArray(startupActions.value)) {
      return {
        status: "malformed",
        evidence: `Persisted startup context field startup_actions_json is not an array for node ${nodeId}`,
      };
    }

    return {
      status: "ok",
      runtime: row.runtime,
      resolvedStartupFiles: resolvedFiles.value.flatMap((file) => {
        if (!file || typeof file !== "object") return [];
        const candidate = file as Record<string, unknown>;
        if (typeof candidate["absolutePath"] !== "string" || candidate["absolutePath"].trim() === "") return [];
        return [{
          absolutePath: candidate["absolutePath"].trim(),
          required: candidate["required"] !== false,
          path: typeof candidate["path"] === "string" ? candidate["path"] : null,
          deliveryHint: typeof candidate["deliveryHint"] === "string" ? candidate["deliveryHint"] : null,
          ownerRoot: typeof candidate["ownerRoot"] === "string" ? candidate["ownerRoot"] : null,
        }];
      }),
      projectionEntries: projectionEntries.value.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const candidate = entry as Record<string, unknown>;
        if (typeof candidate["absolutePath"] !== "string" || candidate["absolutePath"].trim() === "") return [];
        return [{
          absolutePath: candidate["absolutePath"].trim(),
          effectiveId: typeof candidate["effectiveId"] === "string" ? candidate["effectiveId"] : null,
          category: typeof candidate["category"] === "string" ? candidate["category"] : null,
          sourcePath: typeof candidate["sourcePath"] === "string" ? candidate["sourcePath"] : null,
          resourceType: typeof candidate["resourceType"] === "string" ? candidate["resourceType"] : null,
        }];
      }),
    };
  } catch (err) {
    return {
      status: "probe_error",
      evidence: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Per-probe deadline: a hung tmux must not stall the polled status route. Shared with the orchestrator. */
export const RESTORE_CHECK_PROBE_TIMEOUT_MS = SESSION_LIVENESS_DEADLINE_MS;

/** Restore's own decisions, for the check and the plan: the functions RestoreOrchestrator calls. */
export function restoreParityDeps(rigRepo: RigRepository, runtimeAdapters: Record<string, RuntimeAdapter | undefined>, specReader: SeatStartupSpecReader | null): RestoreParityDeps {
  return {
    startupToValidate: (rigId, logicalId, listed, selectedCopy) => startupToValidateForSeat({ db: rigRepo.db, rigRepo }, { rigId, logicalId, adapters: runtimeAdapters, ...listed, selectedCopy }),
    predictSeatStops: (rigId, snapshotData, listed) => predictSeatStops({ db: rigRepo.db, rigRepo }, { rigId, data: snapshotData, ...listed }),
    predictListedSeatRefusals: (rigId, snapshotData, listed) => predictListedSeatRefusals(
      { db: rigRepo.db, rigRepo, specReader, runtimeAdapters },
      { rigId, ...listed, snapshot: snapshotData, exists: existsSync },
    ),
    listedRefusalRemedy: (rigId, logicalId, snapshotData, listed) => listedRefusalRemedy(
      { db: rigRepo.db, rigRepo, runtimeAdapters },
      { rigId, logicalId, snapshot: snapshotData, ...listed, exists: existsSync },
    ),
  };
}

/**
 * OPR.0.4.3.22 — build a RestoreCheckService wired to the live daemon
 * repositories. Extracted so the rig-status compose route can consume the SAME
 * restore-check readiness signal (RecoveryPlan) the `/api/restore-check` route
 * emits, rather than re-implementing it (ponytail: one restore-check, composed).
 */
export function createRestoreCheckService(
  rigRepo: RigRepository,
  snapshotRepo: SnapshotRepository,
  tmuxAdapter?: TmuxAdapter,
  opts?: {
    probeTimeoutMs?: number;
    /** The runtime adapters restore is given (the app's `runtimeAdapters`) and the seam it re-reads a seat's spec
     *  through (`podInstantiator`). With them the check asks restore's own decisions (restoreParity) what restore would
     *  validate and refuse; without them it judges a seat's saved context from `getStartupContext` alone. */
    runtimeAdapters?: Record<string, RuntimeAdapter | undefined>;
    specReader?: SeatStartupSpecReader | null;
  },
): RestoreCheckService {
  const probeTimeoutMs = opts?.probeTimeoutMs ?? RESTORE_CHECK_PROBE_TIMEOUT_MS;
  const serviceDeps: RestoreCheckDeps = {
    // The SAME classification the restore orchestrator's liveness gate uses
    // (classifySessionLiveness over hasSession): a missing tmux server counts
    // as dead, exactly as `rig up --existing` reads it. A probe that throws or
    // outlives the deadline is "unreadable" (liveness unknown), never guessed.
    probeSeatLiveness: tmuxAdapter
      ? (sessionName: string) => classifySessionLiveness(tmuxAdapter, sessionName, probeTimeoutMs)
      : undefined,
    stateDir: OPENRIG_HOME,
    substrateRoot: dirname(resolveLegacyTopologyRigsRoot()),
    probeQueueStore: () => {
      try {
        // The durable queue is the daemon's SQLite table. Empty is a valid
        // state; restore-check only proves the store can be queried.
        rigRepo.db.prepare("SELECT qitem_id FROM queue_items LIMIT 0").all();
        return { available: true, evidence: "Daemon SQLite queue_items store is queryable; an empty queue is valid" };
      } catch (err) {
        return {
          available: false,
          evidence: `Daemon SQLite queue_items store could not be queried: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
    getClaudeActivityHookEvents: () => deriveRelayEvents(
      { exists: existsSync, readFile: (path) => readFileSync(path, "utf-8") },
      resolve(import.meta.dirname, "../../assets/plugins/openrig-core/hooks/claude.json"),
    ).map(({ event }) => event),
    listRigs: () => {
      const rigs = rigRepo.listRigs();
      return rigs.map((r) => ({ rigId: r.id, name: r.name }));
    },
    getNodeInventory: (rigId: string) => {
      const nodeIdByLogicalId = getNodeIdMap(rigRepo.db, rigId);
      return getNodeInventory(rigRepo.db, rigId).map((entry) => ({
        ...entry,
        nodeId: nodeIdByLogicalId.get(entry.logicalId) ?? null,
      })) as NodeInventoryEntry[];
    },
    getStartupContext: (nodeId: string) => {
      return getStartupContext(rigRepo.db, nodeId);
    },
    // OF-32: a seat started fresh re-reads this recorded spec; the advice and the restore prediction say so.
    getRigSpecSource: (rigId: string) => rigRepo.getRigSpecSource(rigId),
    // OF-62: the same predicate restore's pre-restore snapshot refuses on.
    getSavedRowDamage: (rigId: string) => (rigRepo.getRig(rigId)?.nodes ?? []).flatMap((node) => {
      const damage = savedRowDamage(node);
      return damage.length > 0 ? [{ logicalId: node.logicalId, damage }] : [];
    }),
    hasSnapshot: (rigId: string) => {
      return snapshotRepo.listSnapshots(rigId).some((snapshot) => !isUnreadableSnapshot(snapshot));
    },
    getLatestSnapshot: (rigId: string) => {
      const snapshot = snapshotRepo.getLatestSnapshot(rigId);
      return snapshot ? { id: snapshot.id, kind: snapshot.kind } : null;
    },
    getRestoreInputs: (rigId: string) => {
      const rig = rigRepo.getRig(rigId);
      if (!rig) return { unavailable: `Rig ${rigId} no longer exists` };
      const selected = snapshotRepo.selectRestoreUsable(rigId);
      if (!selected.ok || !snapshotMatchesCurrentOccupants(snapshotRepo.db, rig, selected.snapshot)) {
        return {
          currentStateRehydrate: withOccupantStops(snapshotRepo.db, rig, assessCurrentStateRehydrateEligibility(snapshotRepo.db, rig)),
          reason: selected.ok ? "Selected snapshot names an older occupant" : selected.message,
        };
      }
      return { snapshot: selected.snapshot, servicesRecord: rigRepo.getServicesRecord(rigId) };
    },
    probeDaemonHealth: () => {
      // We're inside the daemon — if this route is responding, daemon is healthy
      return { healthy: true, evidence: "Daemon running (responding to API requests)" };
    },
    exists: (path: string) => {
      try { return existsSync(path); } catch { return false; }
    },
    readFile: (path: string) => readFileSync(path, "utf-8"),
    classifyRunningSessions: tmuxAdapter
      ? async (rigId, probe) => {
        const sessions = new SessionRegistry(rigRepo.db).getSessionsForRig(rigId);
        const classification = await classifyRunningSessions(sessions, probe);
        // OF-47: the advice names the sessions restore refuses on, so it carries their tmux names (restore needs only ids).
        const refusing = new Set([...classification.live, ...classification.unknown]);
        const refusingRows = sessions.filter((s) => refusing.has(s.id));
        const sessionNames = Object.fromEntries(refusingRows.map((s) => [s.id, s.sessionName]));
        // The probe is global by tmux name: a live name may belong to ANOTHER seat or rig. Teardown asks the same question
        // (findOtherSessionOwner, archived rigs ignored) before it kills; the advice must too.
        const owners = refusingRows.flatMap((s) => {
          const owner = findOtherSessionOwner(rigRepo.db, s.sessionName, s.nodeId, { ignoreArchived: true });
          return owner ? [[s.id, owner] as const] : [];
        });
        const sessionOwners = Object.fromEntries(owners.map(([id, owner]) => [id, `${owner.logical_id}@${owner.rig_name}`]));
        // Rig names are not unique: the advice decides "a seat of this same rig" on the owner's rig id.
        const sessionOwnerRigIds = Object.fromEntries(owners.map(([id, owner]) => [id, owner.rig_id]));
        return { ...classification, sessionNames, sessionOwners, sessionOwnerRigIds };
      }
      : undefined,
    restoreParity: opts?.runtimeAdapters ? restoreParityDeps(rigRepo, opts.runtimeAdapters, opts.specReader ?? null) : undefined,
  };
  return new RestoreCheckService(serviceDeps);
}

// GET /api/restore-check?rig=<name>&noQueue=true&noHooks=true&compact=1
restoreCheckRoutes.get("/", async (c) => {
  const deps = getDeps(c);
  const rigFilter = c.req.query("rig") ?? undefined;
  const noQueue = c.req.query("noQueue") === "true";
  const noHooks = c.req.query("noHooks") === "true";
  const compact = c.req.query("compact") === "1";
  // OPR.0.4.0.29 FR-2: --ready stays compact but INCLUDES ready-seat detail.
  const includeReady = c.req.query("ready") === "1";

  // OF-32 follow-up: `fresh=a,b` predicts `rig up --existing --fresh a b`; `startupFrom` is its `--startup-from`.
  const freshLogicalIds = (c.req.query("fresh") ?? "").split(",").map((id) => id.trim()).filter((id) => id.length > 0);
  // A restore targets one rig (`rig up <rig> --fresh <seats>`); a seat name is looked up in the rigs being checked, so
  // without a rig filter another rig's seat of the same name would be predicted (and turn red) too.
  if (freshLogicalIds.length > 0 && !rigFilter) {
    return c.json({ error: "fresh needs rig=<name>: a restore targets one rig, and the same seat name in another rig would be predicted too.", code: "fresh_requires_rig" }, 400);
  }
  const startupFromQuery = c.req.query("startupFrom");
  const startupFrom: StartupFrom | undefined = startupFromQuery === undefined ? undefined : parseStartupFrom(startupFromQuery) ?? undefined;
  if (startupFromQuery !== undefined && startupFrom === undefined) {
    return c.json({ error: `startupFrom must be ${STARTUP_FROM_FORMS}.`, code: "invalid_startup_from" }, 400);
  }

  try {
    const service = createRestoreCheckService(deps.rigRepo, deps.snapshotRepo, c.get("tmuxAdapter" as never) as TmuxAdapter | undefined, {
      runtimeAdapters: (c.get("runtimeAdapters" as never) as Record<string, RuntimeAdapter> | undefined) ?? {},
      specReader: (c.get("podInstantiator" as never) as SeatStartupSpecReader | undefined) ?? null,
    });
    const result = await service.checkWithLiveness({
      rig: rigFilter, noQueue, noHooks, compact, includeReady,
      ...(freshLogicalIds.length > 0 ? { freshLogicalIds } : {}),
      ...(startupFrom ? { startupFrom } : {}),
    });

    if (compact) {
      const compactResult = {
        verdict: result.verdict,
        readiness: result.readiness,
        counts: result.counts,
        classCounts: result.classCounts,
        rigs: result.rigs.map((r) => ({
          rigId: r.rigId,
          rigName: r.rigName,
          status: r.status,
          verdict: r.verdict,
          expectedNodes: r.expectedNodes,
          runningReadyNodes: r.runningReadyNodes,
          blockedNodes: r.blockedNodes,
          caveatNodes: r.caveatNodes,
        })),
        // --ready (ready=1) keeps the ready-seat checks in compact mode;
        // default compact drops the green (ready) checks for token safety.
        checks: includeReady ? result.checks : result.checks.filter((ch) => ch.status !== "green"),
        recovery: {
          status: result.recovery.status,
          summary: result.recovery.summary,
          actions: result.recovery.actions,
          blocked: result.recovery.blocked,
        },
      };
      return c.json(compactResult);
    }

    return c.json(result);
  } catch (err) {
    const evidence = `Service error: ${err instanceof Error ? err.message : String(err)}`;

    return c.json({
      verdict: "unknown",
      readiness: {
        status: "unknown",
        reason: "unknown_probe_state",
        blockingRigCount: 0,
        caveatRigCount: 0,
        unknownRigCount: 0,
      },
      continuity: {
        status: "not_proven",
        evidence: "Strict same-session/provider-context resume is not verified by restore-check v1.",
        provenCapabilities: [],
        unprovenCapabilities: ["provider_session_resume", "context_window_preservation", "interrupted_work_functional_resume"],
      },
      rigs: [],
      hostInfra: {
        status: "unknown",
        evidence: "Host bootstrap/autostart source could not be inspected because restore-check route failed",
      },
      recovery: {
        status: "unknown",
        summary: "Recovery status could not be inspected because the restore-check route failed.",
        actions: [],
        blocked: [],
        unknown: [{
          scope: "host",
          reason: evidence,
        }],
      },
      counts: { red: 0, yellow: 0, green: 0 },
      checks: [{
        check: "probe.error",
        status: "red",
        evidence,
        remediation: "Check daemon logs with: rig daemon logs",
      }],
      repairPacket: [{
        step: 1,
        command: "Check daemon logs with: rig daemon logs",
        rationale: evidence,
        safe: true,
        blocking: true,
      }],
    }, 500);
  }
});

/**
 * OF-47: restore's own occupant rule, asked of the current state. With no usable snapshot, `rig up --existing` captures an
 * auto-rehydrate snapshot and restore resolves each seat's occupant from it (deriveRehydrateOccupantsByNode, the capture's
 * own derivation); a seat with several running rows is then failed as an active-occupant ambiguity. The eligibility
 * assessment alone says nothing about that, so the check would call it actionable. Same functions, same wording.
 */
function withOccupantStops(db: import("better-sqlite3").Database, rig: NonNullable<ReturnType<RigRepository["getRig"]>>, eligibility: { ok: boolean; blockers: string[] }): { ok: boolean; blockers: string[]; occupantStops: string[] } {
  const sessions = new SessionRegistry(db).getSessionsForRig(rig.rig.id);
  const states = deriveRehydrateOccupantsByNode(sessions, rig.nodes.map((n) => n.id), readFreshOccupantRelations(db, rig.rig.id));
  const occupantStops: string[] = [];
  for (const node of rig.nodes) {
    const state = states[node.id];
    if (state?.kind === "ambiguous") occupantStops.push(`Restore would not start ${node.logicalId} (failed): ${activeOccupantAmbiguityError(state.candidateIds)}`);
  }
  return { ...eligibility, occupantStops };
}
