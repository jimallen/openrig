import type Database from "better-sqlite3";
import { resolveActiveOccupantRow } from "./active-occupant.js";
import { resolve } from "node:path";
import { ulid } from "ulid";
import { deriveComposeProjectName } from "./compose-project-name.js";
import type { ClaudeManagedBlockFile } from "./managed-blocks.js";
import type {
  Rig,
  Node,
  Edge,
  Binding,
  NodeWithBinding,
  RigWithRelations,
  RigServicesRecord,
  RigServicesRecordInput,
  Snapshot,
  SnapshotData,
  SessionSourceSpec,
} from "./types.js";
import { PdaLaunchReservations, type PdaClaimPhase, type PdaLaunchReservation } from "./pda-launch-reservations.js";
import { PDA_RESUME_TYPE, PDA_RUNTIME, parsePdaResumeToken, parsePdaSpecBlock, type PdaBinding } from "../adapters/pda-runner-protocol.js";
import { piEnvPassthroughRefusal, PI_ENV_PASSTHROUGH_MAX } from "../adapters/pi-runner-protocol.js";

/**
 * Free helper: returns the latest snapshot for a rig whose data carries non-null
 * `resume_token` for at least one persisted session, or null otherwise.
 *
 * Used by node-inventory and ps-projection to derive `lifecycleState=recoverable`
 * post-L1 cold-start. Distinct from `findLatestAutoPreDown`, which filters by kind.
 */
interface SnapshotRow { id: string; rig_id: string; kind: string; status: string; data: string; created_at: string }

/** Shared row → usable-Snapshot mapping (single source of truth for the parse +
 *  the ≥1-resume-token usability rule), used by both the single-rig and the
 *  FS-1 W1.2 all-rigs batched reads so their semantics are byte-identical. */
function snapshotFromRowIfUsable(row: SnapshotRow): Snapshot | null {
  let data: SnapshotData;
  try {
    data = JSON.parse(row.data) as SnapshotData;
  } catch {
    return null;
  }

  // OPR.0.5.7.1 — usability is OCCUPANT truth, not any-historical-row truth:
  // a snapshot is usable iff at least one node RESOLVES to an active occupant
  // carrying a token (the same four-way ladder execution consumes). A
  // present-null/missing-key/dangling relation never counts — a historical
  // token on a non-occupant row must not read as recoverable.
  const sessions = data.sessions ?? [];
  const nodeIds = [...new Set(sessions.map((s) => s.nodeId))];
  const hasResolvedOccupantToken = nodeIds.some((nodeId) => {
    const resolution = resolveActiveOccupantRow(sessions, data.activeSessionIdByNode, nodeId);
    return resolution.kind === "resolved"
      && typeof resolution.session.resumeToken === "string"
      && resolution.session.resumeToken.length > 0;
  });
  if (!hasResolvedOccupantToken) return null;

  return {
    id: row.id,
    rigId: row.rig_id,
    kind: row.kind,
    status: row.status,
    data,
    createdAt: row.created_at,
  };
}

export function findLatestUsableSnapshot(db: Database.Database, rigId: string): Snapshot | null {
  const row = db.prepare(
    "SELECT * FROM snapshots WHERE rig_id = ? ORDER BY created_at DESC, id DESC LIMIT 1"
  ).get(rigId) as SnapshotRow | undefined;
  if (!row) return null;
  return snapshotFromRowIfUsable(row);
}

/**
 * FS-1 W1.2 — the all-rigs batched form of `findLatestUsableSnapshot`: the
 * latest snapshot per rig in ONE query (same `created_at DESC, id DESC` order),
 * each mapped through the shared `snapshotFromRowIfUsable`. Rigs with no usable
 * snapshot are simply absent from the map (callers default to null). Rides the
 * arch-D1.1 sibling-audit `snapshots(rig_id, created_at)` index candidate.
 */
export function findLatestUsableSnapshotsForAllRigs(db: Database.Database): Map<string, Snapshot> {
  const rows = db.prepare(`
    SELECT s.* FROM snapshots s
    WHERE s.id = (
      SELECT s2.id FROM snapshots s2 WHERE s2.rig_id = s.rig_id
      ORDER BY s2.created_at DESC, s2.id DESC LIMIT 1
    )
  `).all() as SnapshotRow[];
  const out = new Map<string, Snapshot>();
  for (const row of rows) {
    const snap = snapshotFromRowIfUsable(row);
    if (snap) out.set(row.rig_id, snap);
  }
  return out;
}

/**
 * OPR.0.3.3.19 - rig archive read filter. Default daemon reads EXCLUDE archived
 * rigs; explicit modes opt in. Mirrors the stream-items `--include-archived`
 * precedent (stream-store.list).
 */
export interface RigArchiveFilter {
  /** include both active and archived rigs */
  includeArchived?: boolean;
  /** return ONLY archived rigs */
  archivedOnly?: boolean;
}

/**
 * SQL condition fragment for the archive filter on a column (e.g. "archived_at"
 * or the aliased "r.archived_at"). Returns null when no filter applies
 * (includeArchived = include everything). Default (no filter) excludes archived.
 */
export function archiveWhereClause(col: string, filter?: RigArchiveFilter): string | null {
  if (filter?.archivedOnly) return `${col} IS NOT NULL`;
  if (filter?.includeArchived) return null;
  return `${col} IS NULL`;
}

interface NodeOptions {
  role?: string;
  runtime?: string;
  model?: string;
  effort?: string;
  /** `remote_control: true` on the member: persisted so restore and successor launches know it. */
  remoteControl?: boolean;
  /** The pda agent the seat drives (runtime pda): persisted as nodes.pda_binding. */
  pda?: PdaBinding;
  /** A Pi seat's extra environment names (spec `env_passthrough`): persisted as nodes.env_passthrough. */
  envPassthrough?: string[];
  codexConfigProfile?: string;
  /** OPR.0.4.8.3 Seam B: per-seat permission_policy REF (builtin:<name> or spec-relative path). */
  permissionPolicy?: string;
  cwd?: string;
  surfaceHint?: string;
  workspace?: string;
  restorePolicy?: string;
  packageRefs?: string[];
  podId?: string;
  agentRef?: string;
  profile?: string;
  label?: string;
  sessionSource?: SessionSourceSpec;
  resolvedSpecName?: string;
  resolvedSpecVersion?: string;
  resolvedSpecHash?: string;
}

/** OF-45: a node's saved package list. A damaged column (not JSON, or not a list of strings) reads as no packages WITH
 *  the reason, so it never passes for a real empty list: getRig still loads (every route that loads the rig, node-detail
 *  included) and the callers that depend on the value refuse on the reason. NULL / empty column = none, no reason. */
export function readSavedPackageRefs(text: string | null | undefined): { value: string[]; unreadable?: string } {
  if (!text) return { value: [] };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { value: [], unreadable: "package_refs is not JSON" }; }
  if (parsed === null) return { value: [] };
  return Array.isArray(parsed) && parsed.every((ref) => typeof ref === "string")
    ? { value: parsed as string[] }
    : { value: [], unreadable: "package_refs is not a list of strings" };
}

/** OF-45: a node's saved session source. A damaged column (not JSON, or not an object) reads as no source WITH the
 *  reason; a literal JSON null is the real "no source". */
export function readSavedSessionSource(text: string | null | undefined): { value: SessionSourceSpec | null; unreadable?: string } {
  if (!text) return { value: null };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { value: null, unreadable: "session_source_json is not JSON" }; }
  if (parsed === null) return { value: null };
  return typeof parsed === "object" && !Array.isArray(parsed)
    ? { value: parsed as SessionSourceSpec }
    : { value: null, unreadable: "session_source_json is not an object" };
}

/** nodes.pda_binding as stored: `{"agent":..,"base_url":..}`, both keys always written. */
export function serializePdaBinding(binding: PdaBinding): string {
  return JSON.stringify({ agent: binding.agent, base_url: binding.baseUrl });
}

/** A node's saved pda binding. NULL is the real "no binding"; a damaged column (empty, not JSON, not a mapping, a key
 *  missing, or a value L0's parsePdaSpecBlock refuses) reads as no binding WITH the reason, because a seat that
 *  drives a pda agent must never be launched or copied as if it drove none. The defaults of the spec block do not
 *  apply to a stored row: both keys must be present. */
export function readSavedPdaBinding(text: string | null | undefined): { value?: PdaBinding; unreadable?: string } {
  // Review D-1: NULL (or no column) is the ONLY absence. Any stored text that is not a binding, the empty string
  // included, is damaged: serializePdaBinding never writes '', so '' is a hand edit, and every reader (the node, the
  // retry gate, the exporter, the holder check) now reads it the same way, fail closed.
  if (text === null || text === undefined) return {};
  if (text === "") return { unreadable: "pda_binding is empty" };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { unreadable: "pda_binding is not JSON" }; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { unreadable: "pda_binding is not an object" };
  const keys = Object.keys(parsed as Record<string, unknown>);
  if (!keys.includes("agent") || !keys.includes("base_url")) return { unreadable: "pda_binding lacks agent or base_url" };
  const result = parsePdaSpecBlock(parsed);
  return result.ok ? { value: result.binding } : { unreadable: "pda_binding is not a valid pda binding" };
}

/** A seat that drives a pda agent, or may (the holder side of the duplicate-binding check). `unreadable` is set when
 *  the seat's saved binding is damaged: the agent it drives cannot be known, so it is treated as a possible holder of
 *  EVERY agent (fail closed) and the reason says what to repair. */
export interface PdaBindingHolder {
  nodeId: string;
  rigId: string;
  rigName: string;
  logicalId: string;
  unreadable?: string;
  /** Set when the seat is a holder because its RESUME TOKEN names the agent (what a restore of that seat would
   *  launch with), not because its saved binding does. The two can differ: an operator may set a token. */
  viaResumeToken?: true;
  /** Set when the seat is a holder only because a launch of it holds a claim on the agent right now (OF-96). */
  viaLaunch?: true;
  /** With `viaLaunch`: where that launch stands (it decides what the refusal may truthfully say). */
  launchPhase?: PdaClaimPhase;
  /** Set when the seat is a holder because its LIVE RUNNER is attached to the agent, whatever its saved binding or resume
   *  token say (OF-109): the runner's own sidecar is the truth about which agent a pane drives. */
  viaRunner?: true;
}

/** The ONE refusal text for "this pda agent is already taken", used by instantiation, unarchive and the rollback of a
 *  replacement, so the three never drift. Names the holding seat and rig; carries no token. */
export function describePdaHolder(binding: PdaBinding, holder: PdaBindingHolder): string {
  if (holder.unreadable !== undefined && holder.viaRunner) {
    return `seat "${holder.logicalId}" in rig "${holder.rigName}" has a pda runner whose lock cannot be read (${holder.unreadable}), so it may already drive pda agent "${binding.agent}" at ${binding.baseUrl}; fix the permissions of that seat's pda state directory or stop that runner, then retry`;
  }
  if (holder.unreadable !== undefined) {
    return `seat "${holder.logicalId}" in rig "${holder.rigName}" has an unreadable pda binding (${holder.unreadable}), so it may already drive pda agent "${binding.agent}" at ${binding.baseUrl}; repair its pda_binding or archive that rig, then retry`;
  }
  if (holder.viaResumeToken) {
    return `pda agent "${binding.agent}" at ${binding.baseUrl} is already driven by seat "${holder.logicalId}" in rig "${holder.rigName}" (that seat's resume token names it); one pda agent is driven by one seat`;
  }
  if (holder.viaRunner) {
    return `pda agent "${binding.agent}" at ${binding.baseUrl} is already driven by seat "${holder.logicalId}" in rig "${holder.rigName}" (that seat's pda runner is attached to it, whatever its saved binding or resume token say); one pda agent is driven by one seat`;
  }
  if (holder.viaLaunch) {
    // Three truths, three texts (OF-96 review F2): a launch still running, a launch that returned (its token is not
    // recorded yet), and a launch that failed while its runner may still be retrying in the pane (OF-112).
    const state = holder.launchPhase === "runner_may_live"
      ? "its launch failed, but its runner may still be running in the pane and retrying; the agent is held until that runner has stopped"
      : holder.launchPhase === "returned"
        ? "it was just launched and its resume token is not recorded yet"
        : "its launch is under way";
    return `pda agent "${binding.agent}" at ${binding.baseUrl} is being taken by seat "${holder.logicalId}" in rig "${holder.rigName}" (${state}); one pda agent is driven by one seat`;
  }
  return `pda agent "${binding.agent}" at ${binding.baseUrl} is already driven by seat "${holder.logicalId}" in rig "${holder.rigName}"; one pda agent is driven by one seat`;
}

/** A binding of one rig that another live seat already holds (the unarchive check). */
export interface PdaBindingConflict {
  binding: PdaBinding;
  /** The rig's own seat that carries the binding. */
  seat: string;
  holder: PdaBindingHolder;
}

export class RigRepository {
  readonly db: Database.Database;
  /** OPR.0.5.6.24 — born-armed (advisor-ruled birth-property principle):
   *  protection arms in the same act that creates the rig. Wired at startup;
   *  optional so repo construction stays dependency-free. */
  onRigCreated?: (rig: Rig) => void;
  /** OF-96: pda agents claimed by launches in flight (see reservePdaLaunch). */
  private readonly pdaReservations: PdaLaunchReservations;
  constructor(db: Database.Database, opts?: { pdaReservationNow?: () => number }) {
    this.db = db;
    this.pdaReservations = new PdaLaunchReservations(opts?.pdaReservationNow);
  }

  createRig(name: string, installRoot?: string): Rig {
    const id = ulid();
    if (installRoot !== undefined) {
      this.db.prepare("INSERT INTO rigs (id, name, install_root) VALUES (?, ?, ?)")
        .run(id, name, installRoot);
    } else {
      this.db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run(id, name);
    }

    const rig = this.rowToRig(
      this.db.prepare("SELECT * FROM rigs WHERE id = ?").get(id) as RigRow
    );
    this.onRigCreated?.(rig);
    return rig;
  }

  /** Canonical bundle materialization folder, independent of seats' working directories. */
  getRigInstallRoot(rigId: string): string | null {
    const row = this.db.prepare("SELECT * FROM rigs WHERE id = ?").get(rigId) as
      { install_root?: string | null } | undefined;
    return row?.install_root ?? null;
  }

  /** OF-32: record where this rig's spec came from, as the operator named it (a library link keeps its
   *  link spelling). Resolved again at each use; never a substitute for the startup context itself. */
  setRigSpecSource(rigId: string, specSourcePath: string): void {
    this.db.prepare("UPDATE rigs SET spec_source_path = ? WHERE id = ?").run(specSourcePath, rigId);
  }

  /** OF-32: the recorded spec source, or null when none was recorded (older rigs, specs without a file). */
  getRigSpecSource(rigId: string): string | null {
    const row = this.db.prepare("SELECT spec_source_path FROM rigs WHERE id = ?").get(rigId) as
      { spec_source_path: string | null } | undefined;
    return row?.spec_source_path ?? null;
  }

  /**
   * PL-007 Workspace Primitive — persist the typed workspace block on the
   * rigs row. Stored as JSON in `workspace_json` (migration 038). Pass
   * null to clear. Older test fixtures that bypass the canonical migration
   * list don't have the column; setter is a no-op in that case (the
   * caller's contract is "best-effort persistence"). Whoami / node-inventory
   * read this column to surface the rig's workspace block alongside cwd.
   */
  setRigWorkspace(rigId: string, workspace: import("./types.js").WorkspaceSpec | null): void {
    if (!this.hasRigColumn("workspace_json")) return;
    const json = workspace ? JSON.stringify(workspace) : null;
    this.db.prepare("UPDATE rigs SET workspace_json = ?, updated_at = ? WHERE id = ?")
      .run(json, new Date().toISOString(), rigId);
  }

  /** PL-007 — read the persisted workspace block for a rig. */
  getRigWorkspace(rigId: string): import("./types.js").WorkspaceSpec | null {
    if (!this.hasRigColumn("workspace_json")) return null;
    const row = this.db.prepare("SELECT workspace_json FROM rigs WHERE id = ?")
      .get(rigId) as { workspace_json: string | null } | undefined;
    if (!row || !row.workspace_json) return null;
    try {
      return JSON.parse(row.workspace_json) as import("./types.js").WorkspaceSpec;
    } catch {
      return null;
    }
  }

  setRigNonInterruptive(rigId: string, enabled: boolean): void {
    if (!this.hasRigColumn("non_interruptive")) return;
    this.db.prepare("UPDATE rigs SET non_interruptive = ?, updated_at = ? WHERE id = ?")
      .run(enabled ? 1 : 0, new Date().toISOString(), rigId);
  }

  getRigNonInterruptive(rigId: string): boolean {
    if (!this.hasRigColumn("non_interruptive")) return false;
    const row = this.db.prepare("SELECT non_interruptive FROM rigs WHERE id = ?")
      .get(rigId) as { non_interruptive: number } | undefined;
    return row?.non_interruptive === 1;
  }

  /** OPR.0.4.8.3 Seam B — persist a rig's attached permission_policy REF (builtin:<name> or a
   *  spec-relative custom path), or null to clear. Mirrors setRigWorkspace (migration 056). */
  setRigPermissionPolicy(rigId: string, permissionPolicy: string | null): void {
    if (!this.hasRigColumn("permission_policy")) return;
    this.db.prepare("UPDATE rigs SET permission_policy = ?, updated_at = ? WHERE id = ?")
      .run(permissionPolicy ?? null, new Date().toISOString(), rigId);
  }

  /** OPR.0.4.8.3 Seam B — read the persisted rig-level permission_policy REF (null when none). */
  getRigPermissionPolicy(rigId: string): string | null {
    if (!this.hasRigColumn("permission_policy")) return null;
    const row = this.db.prepare("SELECT permission_policy FROM rigs WHERE id = ?")
      .get(rigId) as { permission_policy: string | null } | undefined;
    return row?.permission_policy ?? null;
  }

  /** #25 — persist the rig's selected Claude managed-block file (migration 085), or null for
   *  the CLAUDE.md default. Mirrors setRigPermissionPolicy. */
  setRigClaudeManagedBlockFile(rigId: string, file: ClaudeManagedBlockFile | null): void {
    if (!this.hasRigColumn("claude_managed_block_file")) return;
    this.db.prepare("UPDATE rigs SET claude_managed_block_file = ?, updated_at = ? WHERE id = ?")
      .run(file ?? null, new Date().toISOString(), rigId);
  }

  /** #25 — the rig's selected Claude managed-block file, or null when it uses the default. */
  getRigClaudeManagedBlockFile(rigId: string): ClaudeManagedBlockFile | null {
    if (!this.hasRigColumn("claude_managed_block_file")) return null;
    const row = this.db.prepare("SELECT claude_managed_block_file FROM rigs WHERE id = ?")
      .get(rigId) as { claude_managed_block_file: ClaudeManagedBlockFile | null } | undefined;
    return row?.claude_managed_block_file ?? null;
  }

  /** Seam B Guard-F1 — persist the RIG-level resolved attachment provenance (migration 058).
   *  declaringDir = the ORIGINAL declaring RigSpec dir; consumers must never re-resolve the
   *  raw relative ref against an unrelated operation root. No-op on pre-058 fixture DBs. */
  setRigPolicyProvenance(
    rigId: string,
    provenance: {
      origin: "builtin" | "custom" | "deliberate_none";
      resolvedTarget: string | null;
      declaringDir: string | null;
      launchPosture: "floor" | "full_bypass" | "auto";
    },
  ): void {
    if (!this.hasRigColumn("rig_policy_launch_posture")) return;
    this.db.prepare(
      "UPDATE rigs SET rig_policy_origin = ?, rig_policy_resolved_target = ?, rig_policy_declaring_dir = ?, rig_policy_launch_posture = ?, updated_at = ? WHERE id = ?",
    ).run(provenance.origin, provenance.resolvedTarget, provenance.declaringDir, provenance.launchPosture, new Date().toISOString(), rigId);
  }

  /** Seam B Guard-F1 — read the rig-level resolved attachment provenance (null when none). */
  getRigPolicyProvenance(rigId: string): {
    origin: "builtin" | "custom" | "deliberate_none";
    resolvedTarget: string | null;
    declaringDir: string | null;
    launchPosture: "floor" | "full_bypass" | "auto";
    /** the raw rig ref (056) alongside, for re-validation */
    rigRef: string | null;
  } | null {
    if (!this.hasRigColumn("rig_policy_launch_posture")) return null;
    const row = this.db.prepare(
      "SELECT permission_policy, rig_policy_origin, rig_policy_resolved_target, rig_policy_declaring_dir, rig_policy_launch_posture FROM rigs WHERE id = ?",
    ).get(rigId) as {
      permission_policy: string | null;
      rig_policy_origin: string | null;
      rig_policy_resolved_target: string | null;
      rig_policy_declaring_dir: string | null;
      rig_policy_launch_posture: string | null;
    } | undefined;
    if (!row || row.rig_policy_origin == null || row.rig_policy_launch_posture == null) return null;
    return {
      origin: row.rig_policy_origin as "builtin" | "custom" | "deliberate_none",
      resolvedTarget: row.rig_policy_resolved_target,
      declaringDir: row.rig_policy_declaring_dir,
      launchPosture: row.rig_policy_launch_posture as "floor" | "full_bypass" | "auto",
      rigRef: row.permission_policy,
    };
  }

  /** OPR.0.4.8.3 Seam B (R2, dev-guard ruling) — persist a node's RESOLVED policy attachment
   *  provenance (restart-stable: origin + resolved target + declaring dir + launch posture).
   *  Builtins carry resolvedTarget=null until the packaging leg's canonical path is ruled
   *  (PM lane c76c7153) — never a `builtin:<name>` echo. No-op on pre-057 fixture DBs. */
  setNodePolicyProvenance(
    nodeId: string,
    provenance: {
      origin: "builtin" | "custom" | "deliberate_none";
      resolvedTarget: string | null;
      declaringDir: string | null;
      launchPosture: "floor" | "full_bypass" | "auto";
    },
  ): void {
    if (!this.hasNodeColumn("policy_launch_posture")) return;
    this.db.prepare(
      "UPDATE nodes SET policy_origin = ?, policy_resolved_target = ?, policy_declaring_dir = ?, policy_launch_posture = ? WHERE id = ?",
    ).run(provenance.origin, provenance.resolvedTarget, provenance.declaringDir, provenance.launchPosture, nodeId);
  }

  /** Seam B (R2) — read a node's persisted policy provenance; null when none attached
   *  (or pre-057 DB). Restore consumers re-derive posture from this without the spec. */
  getNodePolicyProvenance(nodeId: string): {
    origin: "builtin" | "custom" | "deliberate_none";
    resolvedTarget: string | null;
    declaringDir: string | null;
    launchPosture: "floor" | "full_bypass" | "auto";
    /** The node's own raw ref (member-level; null when the attachment came from the rig). */
    nodeRef: string | null;
  } | null {
    if (!this.hasNodeColumn("policy_launch_posture")) return null;
    const row = this.db.prepare(
      "SELECT permission_policy, policy_origin, policy_resolved_target, policy_declaring_dir, policy_launch_posture FROM nodes WHERE id = ?",
    ).get(nodeId) as {
      permission_policy: string | null;
      policy_origin: string | null;
      policy_resolved_target: string | null;
      policy_declaring_dir: string | null;
      policy_launch_posture: string | null;
    } | undefined;
    if (!row || row.policy_origin == null || row.policy_launch_posture == null) return null;
    return {
      origin: row.policy_origin as "builtin" | "custom" | "deliberate_none",
      resolvedTarget: row.policy_resolved_target,
      declaringDir: row.policy_declaring_dir,
      launchPosture: row.policy_launch_posture as "floor" | "full_bypass" | "auto",
      nodeRef: row.permission_policy,
    };
  }

  /** PL-007 — defensive column probe on rigs (migration 038's
   *  workspace_json is absent in legacy test fixtures). */
  private hasRigColumn(columnName: string): boolean {
    try {
      return this.db.prepare("PRAGMA table_info(rigs)").all()
        .some((row) => (row as { name?: string }).name === columnName);
    } catch {
      return false;
    }
  }

  addNode(rigId: string, logicalId: string, opts?: NodeOptions): Node {
    // Same-rig guard for podId
    if (opts?.podId) {
      const pod = this.db.prepare("SELECT rig_id FROM pods WHERE id = ?").get(opts.podId) as { rig_id: string } | undefined;
      if (!pod) throw new Error(`Pod not found: ${opts.podId}`);
      if (pod.rig_id !== rigId) throw new Error("Pod belongs to a different rig");
    }

    const id = ulid();
    if (this.hasNodeColumn("codex_config_profile") && this.hasNodeColumn("permission_policy")) {
      // OPR.0.4.8.3 Seam B: both ALTER-added optional columns present (migrations 022 + 055; 055
      // runs after 022, so a permission_policy column implies a codex_config_profile column).
      this.db
        .prepare(
          `INSERT INTO nodes (id, rig_id, logical_id, role, runtime, model, codex_config_profile, permission_policy, cwd, surface_hint, workspace, restore_policy, package_refs,
           pod_id, agent_ref, profile, label, resolved_spec_name, resolved_spec_version, resolved_spec_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          rigId,
          logicalId,
          opts?.role ?? null,
          opts?.runtime ?? null,
          opts?.model ?? null,
          opts?.codexConfigProfile ?? null,
          opts?.permissionPolicy ?? null,
          opts?.cwd ?? null,
          opts?.surfaceHint ?? null,
          opts?.workspace ?? null,
          opts?.restorePolicy ?? null,
          opts?.packageRefs ? JSON.stringify(opts.packageRefs) : null,
          opts?.podId ?? null,
          opts?.agentRef ?? null,
          opts?.profile ?? null,
          opts?.label ?? null,
          opts?.resolvedSpecName ?? null,
          opts?.resolvedSpecVersion ?? null,
          opts?.resolvedSpecHash ?? null,
        );
    } else if (this.hasNodeColumn("codex_config_profile")) {
      this.db
        .prepare(
          `INSERT INTO nodes (id, rig_id, logical_id, role, runtime, model, codex_config_profile, cwd, surface_hint, workspace, restore_policy, package_refs,
           pod_id, agent_ref, profile, label, resolved_spec_name, resolved_spec_version, resolved_spec_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          rigId,
          logicalId,
          opts?.role ?? null,
          opts?.runtime ?? null,
          opts?.model ?? null,
          opts?.codexConfigProfile ?? null,
          opts?.cwd ?? null,
          opts?.surfaceHint ?? null,
          opts?.workspace ?? null,
          opts?.restorePolicy ?? null,
          opts?.packageRefs ? JSON.stringify(opts.packageRefs) : null,
          opts?.podId ?? null,
          opts?.agentRef ?? null,
          opts?.profile ?? null,
          opts?.label ?? null,
          opts?.resolvedSpecName ?? null,
          opts?.resolvedSpecVersion ?? null,
          opts?.resolvedSpecHash ?? null,
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO nodes (id, rig_id, logical_id, role, runtime, model, cwd, surface_hint, workspace, restore_policy, package_refs,
           pod_id, agent_ref, profile, label, resolved_spec_name, resolved_spec_version, resolved_spec_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          rigId,
          logicalId,
          opts?.role ?? null,
          opts?.runtime ?? null,
          opts?.model ?? null,
          opts?.cwd ?? null,
          opts?.surfaceHint ?? null,
          opts?.workspace ?? null,
          opts?.restorePolicy ?? null,
          opts?.packageRefs ? JSON.stringify(opts.packageRefs) : null,
          opts?.podId ?? null,
          opts?.agentRef ?? null,
          opts?.profile ?? null,
          opts?.label ?? null,
          opts?.resolvedSpecName ?? null,
          opts?.resolvedSpecVersion ?? null,
          opts?.resolvedSpecHash ?? null,
        );
    }

    if (opts?.sessionSource && this.hasNodeColumn("session_source_json")) {
      this.db.prepare("UPDATE nodes SET session_source_json = ? WHERE id = ?")
        .run(JSON.stringify(opts.sessionSource), id);
    }

    if (opts?.effort && this.hasNodeColumn("effort")) {
      this.db.prepare("UPDATE nodes SET effort = ? WHERE id = ?")
        .run(opts.effort, id);
    }

    if (opts?.remoteControl && this.hasNodeColumn("remote_control")) {
      this.db.prepare("UPDATE nodes SET remote_control = 1 WHERE id = ?").run(id);
    }

    if (opts?.pda) {
      // No silent skip: a pda seat whose binding was not stored would restore and export as bound to nothing.
      if (!this.hasNodeColumn("pda_binding")) throw new Error("nodes.pda_binding is missing (migration 115 has not run); the pda binding cannot be stored");
      this.db.prepare("UPDATE nodes SET pda_binding = ? WHERE id = ?").run(serializePdaBinding(opts.pda), id);
    }

    if (opts?.envPassthrough && opts.envPassthrough.length > 0) {
      // No silent skip: a seat whose names were not stored would launch without the variables its spec names.
      if (!this.hasNodeColumn("env_passthrough")) throw new Error("nodes.env_passthrough is missing (migration 120 has not run); the env_passthrough names cannot be stored");
      this.db.prepare("UPDATE nodes SET env_passthrough = ? WHERE id = ?").run(JSON.stringify(opts.envPassthrough), id);
    }

    return this.rowToNode(
      this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as NodeRow
    );
  }

  /** pda L2a (review L2b action 3, and its forward note): who stops THIS seat from launching or restoring onto
   *  `binding`, as refusal texts. Every other seat that holds the binding counts, as does every damaged seat in
   *  ANOTHER live rig (fail closed: it may drive any agent). A damaged sibling in the seat's OWN rig does not: the
   *  in-spec duplicate rule and the creating doors (which count every holder, own rig included) mean no OpenRig path
   *  puts two seats of one rig on one agent, so one damaged row must not hold every healthy pda seat of its rig
   *  hostage at restore. The binding is the one being launched: the resume token's on a restore. */
  findPdaLaunchConflicts(binding: PdaBinding, nodeId: string): string[] {
    const own = this.db.prepare(
      "SELECT n.rig_id AS rig_id, n.logical_id AS logical_id, r.name AS rig_name FROM nodes n JOIN rigs r ON r.id = n.rig_id WHERE n.id = ?",
    ).get(nodeId) as { rig_id: string; logical_id: string; rig_name: string } | undefined;
    const holders = this.findPdaDrivers(binding, { excludeNodeId: nodeId, ...(own ? { ignoreDamagedInRigId: own.rig_id } : {}) });
    const who = own ? `seat "${own.logical_id}" in rig "${own.rig_name}" cannot take it: ` : "";
    return holders.map((holder) => who + describePdaHolder(binding, holder));
  }

  /** OF-96: take the agent for ONE launch, atomically with the check. Synchronous from the check to the claim, so two
   *  launches that both found the agent free cannot both pass: the second sees the first's claim. The claim lasts for the
   *  launch (`failed()` frees it at once) and, after a launch that succeeded (`launched()`), until the seat's resume token
   *  names the agent in the database (the token is then the holder) or `PDA_RESERVATION_LEASE_MS` has passed. In memory
   *  by design: only this process launches, and a crash must not leave a claim behind. */
  reservePdaLaunch(binding: PdaBinding, nodeId: string): { ok: true; reservation: PdaLaunchReservation } | { ok: false; conflicts: string[] } {
    const conflicts = this.findPdaLaunchConflicts(binding, nodeId);
    if (conflicts.length > 0) return { ok: false, conflicts };
    return { ok: true, reservation: this.pdaReservations.claim(binding, nodeId) };
  }

  /** Every seat that drives, or may drive, this pda agent: those whose saved binding names it (or is damaged), those whose
   *  resume token names it (OF-92), and any seat whose launch holds a claim on it right now (OF-96). A seat appears once.
   *  `excludeRigIds` are rigs about to be archived by the same operation; `excludeNodeId` is the seat being re-checked. */
  findPdaDrivers(binding: PdaBinding, opts?: { excludeRigIds?: readonly string[]; excludeNodeId?: string; ignoreDamagedInRigId?: string }): PdaBindingHolder[] {
    const seen = new Set<string>();
    const out: PdaBindingHolder[] = [];
    const add = (holders: PdaBindingHolder[]) => {
      for (const holder of holders) {
        if (seen.has(holder.nodeId)) continue;
        seen.add(holder.nodeId);
        out.push(holder);
      }
    };
    // A damaged sibling in the asking seat's OWN rig is dropped before the union, so the same seat can still count
    // through its resume token (the order the OF-92 launch check always had).
    add(this.findPdaBindingHolders(binding, opts).filter((holder) => !(holder.unreadable !== undefined && holder.rigId === opts?.ignoreDamagedInRigId)));
    add(this.findPdaResumeTokenHolders(binding, opts));
    add(this.findPdaReservationHolders(binding, opts));
    add(this.findPdaRunnerHolders(binding, opts));
    return out;
  }

  /** OF-109: how the repository asks "which pda agent is this seat's live runner attached to?" (the runner's own sidecar;
   *  the adapter answers, the repository stays database-only). Set once at startup; absent in tests that do not need it. */
  private pdaRunnerProbe: ((sessionName: string) => PdaBinding | "unknown" | null) | null = null;
  setPdaRunnerProbe(probe: ((sessionName: string) => PdaBinding | "unknown" | null) | null): void {
    this.pdaRunnerProbe = probe;
  }

  /** Seats whose live runner is attached to this agent, by the runner's own sidecar. The database can disagree with the
   *  pane: an operator may set a resume token after a runner launched on another agent, so the seat's row names an agent
   *  the runner is not driving, and the one it IS driving is named by nothing stored. Seat -> pane is the seat's binding. */
  private findPdaRunnerHolders(binding: PdaBinding, opts?: { excludeRigIds?: readonly string[]; excludeNodeId?: string }): PdaBindingHolder[] {
    const probe = this.pdaRunnerProbe;
    if (!probe) return [];
    const rows = this.db.prepare(
      "SELECT n.id AS node_id, n.rig_id AS rig_id, r.name AS rig_name, n.logical_id AS logical_id, b.tmux_session AS tmux_session " +
      "FROM nodes n JOIN rigs r ON r.id = n.rig_id JOIN bindings b ON b.node_id = n.id " +
      "WHERE n.runtime = ? AND b.tmux_session IS NOT NULL AND r.archived_at IS NULL ORDER BY n.id",
    ).all(PDA_RUNTIME) as Array<{ node_id: string; rig_id: string; rig_name: string; logical_id: string; tmux_session: string }>;
    const excludedRigs = new Set(opts?.excludeRigIds ?? []);
    const holders: PdaBindingHolder[] = [];
    for (const row of rows) {
      if (row.node_id === opts?.excludeNodeId || excludedRigs.has(row.rig_id)) continue;
      const attached = probe(row.tmux_session);
      const base = { nodeId: row.node_id, rigId: row.rig_id, rigName: row.rig_name, logicalId: row.logical_id, viaRunner: true as const };
      if (attached === "unknown") holders.push({ ...base, unreadable: "its runner.lock exists but cannot be read" }); // fail closed: it may drive any agent
      else if (attached && attached.agent === binding.agent && attached.baseUrl === binding.baseUrl) holders.push(base);
    }
    return holders;
  }

  /** Seats whose launch holds a claim on this agent and that no stored row names yet. A claim whose launch succeeded
   *  is dropped as soon as the database names its seat (token holder) or its lease ran out. */
  private findPdaReservationHolders(binding: PdaBinding, opts?: { excludeRigIds?: readonly string[]; excludeNodeId?: string }): PdaBindingHolder[] {
    const claimed = this.pdaReservations.claimants(binding);
    if (claimed.length === 0) return [];
    const tokenHolderIds = new Set(this.findPdaResumeTokenHolders(binding).map((holder) => holder.nodeId));
    const excludedRigs = new Set(opts?.excludeRigIds ?? []);
    const holders: PdaBindingHolder[] = [];
    for (const claim of claimed) {
      if (claim.launched && tokenHolderIds.has(claim.nodeId)) { this.pdaReservations.settle(binding, claim.nodeId); continue; }
      if (claim.nodeId === opts?.excludeNodeId) continue;
      const row = this.db.prepare(
        "SELECT n.id AS node_id, n.rig_id AS rig_id, r.name AS rig_name, n.logical_id AS logical_id FROM nodes n JOIN rigs r ON r.id = n.rig_id WHERE n.id = ? AND r.archived_at IS NULL",
      ).get(claim.nodeId) as { node_id: string; rig_id: string; rig_name: string; logical_id: string } | undefined;
      if (!row || excludedRigs.has(row.rig_id)) continue;
      holders.push({ nodeId: row.node_id, rigId: row.rig_id, rigName: row.rig_name, logicalId: row.logical_id, viaLaunch: true, launchPhase: claim.phase });
    }
    return holders;
  }

  /** Every seat, in a rig that is not archived, whose current pda resume token names this agent at this base URL.
   *  The token of a seat is that of its most recent session that has one (the row a restore resumes from). A token that
   *  does not parse, or a token of another resume type, names no pda agent and holds nothing. */
  findPdaResumeTokenHolders(binding: PdaBinding, opts?: { excludeRigIds?: readonly string[]; excludeNodeId?: string }): PdaBindingHolder[] {
    const rows = this.db.prepare(
      "SELECT s.node_id AS node_id, s.resume_token AS resume_token, n.rig_id AS rig_id, r.name AS rig_name, n.logical_id AS logical_id " +
      "FROM sessions s JOIN nodes n ON n.id = s.node_id JOIN rigs r ON r.id = n.rig_id " +
      "WHERE s.resume_type = ? AND s.resume_token IS NOT NULL AND TRIM(s.resume_token) != '' AND r.archived_at IS NULL " +
      "ORDER BY s.created_at DESC, s.id DESC",
    ).all(PDA_RESUME_TYPE) as Array<{ node_id: string; resume_token: string; rig_id: string; rig_name: string; logical_id: string }>;
    const latest = new Map<string, (typeof rows)[number]>();
    for (const row of rows) if (!latest.has(row.node_id)) latest.set(row.node_id, row);
    const holders: PdaBindingHolder[] = [];
    const excludedRigs = new Set(opts?.excludeRigIds ?? []);
    for (const row of latest.values()) {
      if (row.node_id === opts?.excludeNodeId || excludedRigs.has(row.rig_id)) continue;
      const named = parsePdaResumeToken(row.resume_token.trim());
      if (named && named.agent === binding.agent && named.baseUrl === binding.baseUrl) {
        holders.push({ nodeId: row.node_id, rigId: row.rig_id, rigName: row.rig_name, logicalId: row.logical_id, viaResumeToken: true });
      }
    }
    return holders;
  }

  /** Every seat, in any rig that is not archived, that drives this pda agent at this base URL (the pda agent is the
   *  pair: the same name on another port is another pda), PLUS every seat whose saved binding is damaged (it may drive
   *  any agent; see PdaBindingHolder.unreadable). `excludeRigIds` are rigs about to be archived by the same operation;
   *  `excludeNodeId` is the seat being re-checked. The comparison is made on the parsed binding, never on the stored
   *  text. */
  findPdaBindingHolders(binding: PdaBinding, opts?: { excludeRigIds?: readonly string[]; excludeNodeId?: string }): PdaBindingHolder[] {
    if (!this.hasNodeColumn("pda_binding")) return [];
    const rows = this.db.prepare(
      "SELECT n.id AS node_id, n.rig_id AS rig_id, r.name AS rig_name, n.logical_id AS logical_id, n.pda_binding AS pda_binding " +
      "FROM nodes n JOIN rigs r ON r.id = n.rig_id WHERE n.pda_binding IS NOT NULL AND r.archived_at IS NULL ORDER BY n.id",
    ).all() as Array<{ node_id: string; rig_id: string; rig_name: string; logical_id: string; pda_binding: string }>;
    const excludedRigs = new Set(opts?.excludeRigIds ?? []);
    return rows
      .filter((row) => row.node_id !== opts?.excludeNodeId && !excludedRigs.has(row.rig_id))
      .flatMap((row): PdaBindingHolder[] => {
        const base = { nodeId: row.node_id, rigId: row.rig_id, rigName: row.rig_name, logicalId: row.logical_id };
        const saved = readSavedPdaBinding(row.pda_binding);
        if (saved.value === undefined) return [{ ...base, unreadable: saved.unreadable ?? "pda_binding is not readable" }];
        return saved.value.agent === binding.agent && saved.value.baseUrl === binding.baseUrl ? [base] : [];
      });
  }

  /** Would bringing this (archived) rig back create a second holder? Every readable binding of the rig's own seats is
   *  checked against the other live rigs (the rig itself is excluded). A damaged binding of the rig's OWN seat names no
   *  agent and so cannot be checked here; a damaged binding in ANOTHER live rig counts against every binding. */
  findPdaBindingConflictsForRig(rigId: string): PdaBindingConflict[] {
    if (!this.hasNodeColumn("pda_binding")) return [];
    const own = this.db.prepare("SELECT logical_id, pda_binding FROM nodes WHERE rig_id = ? AND pda_binding IS NOT NULL ORDER BY id")
      .all(rigId) as Array<{ logical_id: string; pda_binding: string }>;
    const conflicts: PdaBindingConflict[] = [];
    for (const row of own) {
      const binding = readSavedPdaBinding(row.pda_binding).value;
      if (binding === undefined) continue;
      for (const holder of this.findPdaDrivers(binding, { excludeRigIds: [rigId] })) {
        conflicts.push({ binding, seat: row.logical_id, holder });
      }
    }
    // OF-109: a restore of an own seat launches with its RESUME TOKEN's agent, which an operator may have set to another
    // agent than the saved binding. Bringing the rig back must check that agent too, or the first restore finds it taken.
    const checked = new Set(own.flatMap((row) => { const b = readSavedPdaBinding(row.pda_binding).value; return b ? [`${row.logical_id}\u0000${b.baseUrl}\u0000${b.agent}`] : []; }));
    for (const seat of this.findPdaResumeTokenBindingsForRig(rigId)) {
      if (checked.has(`${seat.logicalId}\u0000${seat.binding.baseUrl}\u0000${seat.binding.agent}`)) continue; // same agent as its binding: already checked
      for (const holder of this.findPdaDrivers(seat.binding, { excludeRigIds: [rigId] })) {
        conflicts.push({ binding: seat.binding, seat: seat.logicalId, holder });
      }
    }
    return conflicts;
  }

  /** The agent each seat of this rig would resume onto: its current resume token (that of its most recent session that has
   *  one, as findPdaResumeTokenHolders reads it), when that token names a pda agent. The rig may be archived. */
  private findPdaResumeTokenBindingsForRig(rigId: string): Array<{ logicalId: string; binding: PdaBinding }> {
    const rows = this.db.prepare(
      "SELECT s.node_id AS node_id, s.resume_token AS resume_token, n.logical_id AS logical_id " +
      "FROM sessions s JOIN nodes n ON n.id = s.node_id " +
      "WHERE n.rig_id = ? AND s.resume_type = ? AND s.resume_token IS NOT NULL AND TRIM(s.resume_token) != '' " +
      "ORDER BY s.created_at DESC, s.id DESC",
    ).all(rigId, PDA_RESUME_TYPE) as Array<{ node_id: string; resume_token: string; logical_id: string }>;
    const latest = new Map<string, (typeof rows)[number]>();
    for (const row of rows) if (!latest.has(row.node_id)) latest.set(row.node_id, row);
    const out: Array<{ logicalId: string; binding: PdaBinding }> = [];
    for (const row of latest.values()) {
      const named = parsePdaResumeToken(row.resume_token.trim());
      if (named) out.push({ logicalId: row.logical_id, binding: named });
    }
    return out;
  }

  /** `unarchiveRig`, unless that would leave one pda agent driven by two seats. Synchronous, so the check and the
   *  write are one step. The plain `unarchiveRig` stays the bare primitive. */
  unarchiveRigUnlessPdaConflict(rigId: string): { ok: true; changed: boolean } | { ok: false; conflicts: PdaBindingConflict[] } {
    const conflicts = this.findPdaBindingConflictsForRig(rigId);
    if (conflicts.length > 0) return { ok: false, conflicts };
    return { ok: true, changed: this.unarchiveRig(rigId) };
  }

  /** S5 (OPR.0.5.4.7) — the first supported nodes.model write (the inventory was insert-only;
   *  KI-5.3-9). Every managed resume/successor launch reads node.model at call time, so this
   *  UPDATE is the complete persistence half of set-model. Returns whether a row changed. */
  setNodeModel(nodeId: string, model: string): boolean {
    const result = this.db
      .prepare("UPDATE nodes SET model = ? WHERE id = ?")
      .run(model, nodeId);
    return result.changes > 0;
  }

  /** A Pi seat's extra environment names, as its launch passes them to the runner. Fails closed: a missing
   *  column, a NULL, or anything that is not a JSON array of names reads as none (the baseline only), and an
   *  individual name the runner would refuse is left out. Names only; values come from the seat pane at launch. */
  getNodeEnvPassthrough(nodeId: string): string[] {
    if (!this.hasNodeColumn("env_passthrough")) return [];
    const row = this.db.prepare("SELECT env_passthrough AS v FROM nodes WHERE id = ?").get(nodeId) as { v: string | null } | undefined;
    if (!row?.v) return [];
    let parsed: unknown;
    try { parsed = JSON.parse(row.v); } catch { return []; }
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((name): name is string => typeof name === "string" && piEnvPassthroughRefusal(name) === null)
      .slice(0, PI_ENV_PASSTHROUGH_MAX);
  }

  setNodeEffort(nodeId: string, effort: string): boolean {
    if (!this.hasNodeColumn("effort")) return false;
    const result = this.db
      .prepare("UPDATE nodes SET effort = ? WHERE id = ?")
      .run(effort, nodeId);
    return result.changes > 0;
  }

  /** Declare (true) or withdraw (false) the seat's Claude Code Remote Control. A relaunch from the spec
   *  writes the member's current declaration, so a spec change takes effect on the next launch. */
  setNodeRemoteControl(nodeId: string, remoteControl: boolean): boolean {
    if (!this.hasNodeColumn("remote_control")) return false;
    const result = this.db
      .prepare("UPDATE nodes SET remote_control = ? WHERE id = ?")
      .run(remoteControl ? 1 : null, nodeId);
    return result.changes > 0;
  }

  /** OPR.0.7.0.7: write or clear (null) a seat's explicit effort choice. Returns false when
   *  the column isn't available or no row matched, so a caller never reports a change from it. */
  setNodeEffortChoice(nodeId: string, choice: string | null): boolean {
    if (!this.hasNodeColumn("effort_choice")) return false;
    return this.db.prepare("UPDATE nodes SET effort_choice = ? WHERE id = ?")
      .run(choice, nodeId).changes > 0;
  }

  clearNodeEffort(nodeId: string): boolean {
    if (!this.hasNodeColumn("effort")) return false;
    const result = this.db
      .prepare("UPDATE nodes SET effort = NULL WHERE id = ?")
      .run(nodeId);
    return result.changes > 0;
  }

  addEdge(rigId: string, sourceId: string, targetId: string, kind: string): Edge {
    const id = ulid();
    this.db
      .prepare(
        "INSERT INTO edges (id, rig_id, source_id, target_id, kind) VALUES (?, ?, ?, ?, ?)"
      )
      .run(id, rigId, sourceId, targetId, kind);

    return this.rowToEdge(
      this.db.prepare("SELECT * FROM edges WHERE id = ?").get(id) as EdgeRow
    );
  }

  getRig(rigId: string): RigWithRelations | null {
    const rigRow = this.db
      .prepare("SELECT * FROM rigs WHERE id = ?")
      .get(rigId) as RigRow | undefined;

    if (!rigRow) return null;

    const nodeRows = this.db
      .prepare("SELECT * FROM nodes WHERE rig_id = ? ORDER BY created_at")
      .all(rigId) as NodeRow[];

    const edgeRows = this.db
      .prepare("SELECT * FROM edges WHERE rig_id = ?")
      .all(rigId) as EdgeRow[];

    const nodes: NodeWithBinding[] = nodeRows.map((row) => {
      const bindingRow = this.db
        .prepare("SELECT * FROM bindings WHERE node_id = ?")
        .get(row.id) as BindingRow | undefined;

      return {
        ...this.rowToNode(row),
        binding: bindingRow ? this.rowToBinding(bindingRow) : null,
      };
    });

    return {
      rig: this.rowToRig(rigRow),
      nodes,
      edges: edgeRows.map((r) => this.rowToEdge(r)),
    };
  }

  listRigs(filter?: RigArchiveFilter, observe?: import("./request-phase-observer.js").QueryObservation): Rig[] {
    const cond = archiveWhereClause("archived_at", filter);
    const where = cond ? `WHERE ${cond}` : "";
    let rows: RigRow[];
    try { observe?.("begin"); } catch { /* Best-effort measurement only. */ }
    try {
      rows = this.db.prepare(`SELECT * FROM rigs ${where} ORDER BY created_at`).all() as RigRow[];
    } catch (error) {
      try { observe?.("end", true); } catch { /* Preserve the actual query error. */ }
      throw error;
    }
    try { observe?.("end", false); } catch { /* Preserve the query result. */ }
    return rows.map((r) => this.rowToRig(r));
  }

  /**
   * Returns the latest snapshot for this rig with at least one non-null resume token,
   * or null if no usable snapshot exists. Used by the lifecycle projection to derive
   * `recoverable` state.
   */
  findLatestUsableSnapshot(rigId: string): Snapshot | null {
    return findLatestUsableSnapshot(this.db, rigId);
  }

  findRigsByName(name: string): Rig[] {
    const rows = this.db
      .prepare("SELECT * FROM rigs WHERE name = ? ORDER BY created_at")
      .all(name) as RigRow[];
    return rows.map((r) => this.rowToRig(r));
  }

  /** OF-135: the rig whose id is exactly `id`, archived or not, or null. Ids are unique, so a command that takes a rig id or
   *  a name tries this first (the precedence of the CLI's rig-handle.ts). */
  findRigById(id: string): { rig: Rig; archived: boolean } | null {
    const row = this.db.prepare("SELECT * FROM rigs WHERE id = ?").get(id) as (RigRow & { archived_at?: string | null }) | undefined;
    if (!row) return null;
    return { rig: this.rowToRig(row), archived: this.hasRigColumn("archived_at") && row.archived_at != null };
  }

  /** #174: seat-ref resolution sees only unarchived rigs, as default reads do since migration 042. */
  findUnarchivedRigsByName(name: string): Rig[] {
    const archived = this.hasRigColumn("archived_at") ? " AND archived_at IS NULL" : "";
    const rows = this.db
      .prepare(`SELECT * FROM rigs WHERE name = ?${archived} ORDER BY created_at`)
      .all(name) as RigRow[];
    return rows.map((r) => this.rowToRig(r));
  }

  getRigSummaries(filter?: RigArchiveFilter): Array<{ id: string; name: string; nodeCount: number; latestSnapshotAt: string | null; latestSnapshotId: string | null; hasServices: boolean; archivedAt: string | null }> {
    const cond = archiveWhereClause("r.archived_at", filter);
    const where = cond ? `WHERE ${cond}` : "";
    const rows = this.db.prepare(`
      SELECT
        r.id,
        r.name,
        r.archived_at AS archived_at,
        (SELECT COUNT(*) FROM nodes n WHERE n.rig_id = r.id) AS node_count,
        EXISTS(SELECT 1 FROM rig_services rs WHERE rs.rig_id = r.id) AS has_services,
        ls.id AS latest_snapshot_id,
        ls.created_at AS latest_snapshot_at
      FROM rigs r
      LEFT JOIN snapshots ls ON ls.id = (
        SELECT s2.id FROM snapshots s2
        WHERE s2.rig_id = r.id
        ORDER BY s2.created_at DESC, s2.id DESC
        LIMIT 1
      )
      ${where}
      ORDER BY r.created_at
    `).all() as Array<{ id: string; name: string; archived_at: string | null; node_count: number; has_services: number; latest_snapshot_id: string | null; latest_snapshot_at: string | null }>;

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      nodeCount: r.node_count,
      hasServices: r.has_services === 1,
      latestSnapshotAt: r.latest_snapshot_at,
      latestSnapshotId: r.latest_snapshot_id,
      archivedAt: r.archived_at,
    }));
  }

  /**
   * OPR.0.3.3.19 - soft-archive a rig: sets `archived_at`. The rigs row,
   * topology rows, and snapshots are all RETAINED (this is NOT the delete
   * path - contrast deleteRig). Returns false if the rig was already archived.
   */
  archiveRig(rigId: string): boolean {
    const result = this.db
      .prepare("UPDATE rigs SET archived_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND archived_at IS NULL")
      .run(rigId);
    return result.changes > 0;
  }

  /** OPR.0.3.3.19 - reverse archive: clears `archived_at`. Returns false if not archived. */
  unarchiveRig(rigId: string): boolean {
    const result = this.db
      .prepare("UPDATE rigs SET archived_at = NULL, updated_at = datetime('now') WHERE id = ? AND archived_at IS NOT NULL")
      .run(rigId);
    return result.changes > 0;
  }

  deleteRig(rigId: string): void {
    this.db.prepare("DELETE FROM rigs WHERE id = ?").run(rigId);
  }

  deleteNode(nodeId: string): void {
    this.db.prepare("DELETE FROM nodes WHERE id = ?").run(nodeId);
  }

  setServicesRecord(rigId: string, record: RigServicesRecordInput): RigServicesRecord {
    const now = new Date().toISOString();
    const composeFile = resolve(record.rigRoot, record.composeFile);
    const rig = this.db.prepare("SELECT 1 AS present FROM rigs WHERE id = ?").get(rigId);
    if (!rig) throw new Error(`Rig not found: ${rigId}`);
    // Keep the fallback aligned with bootstrap's unique, stable rig-ID default.
    const projectName = record.projectName ?? this.getServicesRecord(rigId)?.projectName ?? deriveComposeProjectName(rigId);
    this.db.prepare(`
      INSERT INTO rig_services (
        rig_id,
        kind,
        spec_json,
        rig_root,
        compose_file,
        project_name,
        latest_receipt_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(rig_id) DO UPDATE SET
        kind = excluded.kind,
        spec_json = excluded.spec_json,
        rig_root = excluded.rig_root,
        compose_file = excluded.compose_file,
        project_name = excluded.project_name,
        latest_receipt_json = excluded.latest_receipt_json,
        updated_at = excluded.updated_at
    `).run(
      rigId,
      record.kind,
      record.specJson,
      record.rigRoot,
      composeFile,
      projectName,
      record.latestReceiptJson ?? null,
      now,
      now,
    );

    const stored = this.db.prepare("SELECT * FROM rig_services WHERE rig_id = ?").get(rigId) as RigServicesRow | undefined;
    if (!stored) throw new Error(`Failed to persist services record for rig ${rigId}`);
    return this.rowToServicesRecord(stored);
  }

  /** A retained generation must not tear down a live generation's project. */
  getLiveServicesSuccessor(rigId: string, projectName: string): { id: string; name: string } | null {
    if (!this.hasRigColumn("archived_at")) return null;
    return this.db.prepare(`
      SELECT r.id, r.name FROM rig_services s JOIN rigs r ON r.id = s.rig_id
      JOIN rigs predecessor ON predecessor.id = ?
      WHERE s.project_name = ? AND r.id != predecessor.id
        AND predecessor.archived_at IS NOT NULL AND r.archived_at IS NULL
        AND r.name = predecessor.name
      ORDER BY r.created_at DESC LIMIT 1
    `).get(rigId, projectName) as { id: string; name: string } | undefined ?? null;
  }

  getServicesRecord(rigId: string): RigServicesRecord | null {
    const row = this.db.prepare("SELECT * FROM rig_services WHERE rig_id = ?").get(rigId) as RigServicesRow | undefined;
    return row ? this.rowToServicesRecord(row) : null;
  }

  updateServicesReceipt(rigId: string, latestReceiptJson: string | null): RigServicesRecord | null {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE rig_services
      SET latest_receipt_json = ?, updated_at = ?
      WHERE rig_id = ?
    `).run(latestReceiptJson, now, rigId);

    if (result.changes === 0) return null;
    return this.getServicesRecord(rigId);
  }

  // -- Row-to-domain mappers --

  private rowToRig(row: RigRow): Rig {
    return {
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private rowToNode(row: NodeRow): Node {
    const packageRefs = readSavedPackageRefs(row.package_refs);
    const sessionSource = readSavedSessionSource(row.session_source_json);
    const pdaBinding = readSavedPdaBinding(row.pda_binding);
    return {
      id: row.id,
      rigId: row.rig_id,
      logicalId: row.logical_id,
      role: row.role,
      runtime: row.runtime,
      model: row.model,
      effort: row.effort ?? null,
      // Present only when declared, so nodes (and the snapshots serialized from them) that never declared it are unchanged.
      ...(row.remote_control === 1 ? { remoteControl: true } : {}),
      // Present only for a pda seat, so every other node (and the snapshots serialized from them) is unchanged.
      ...(pdaBinding.value ? { pda: pdaBinding.value } : {}),
      ...(pdaBinding.unreadable ? { pdaBindingUnreadable: pdaBinding.unreadable } : {}),
      effortChoice: row.effort_choice ?? null,
      codexConfigProfile: row.codex_config_profile ?? null,
      permissionPolicy: row.permission_policy ?? null,
      cwd: row.cwd,
      surfaceHint: row.surface_hint ?? null,
      workspace: row.workspace ?? null,
      restorePolicy: row.restore_policy ?? null,
      packageRefs: packageRefs.value,
      podId: row.pod_id ?? null,
      agentRef: row.agent_ref ?? null,
      profile: row.profile ?? null,
      label: row.label ?? null,
      sessionSource: sessionSource.value,
      ...(packageRefs.unreadable ? { packageRefsUnreadable: packageRefs.unreadable } : {}),
      ...(sessionSource.unreadable ? { sessionSourceUnreadable: sessionSource.unreadable } : {}),
      resolvedSpecName: row.resolved_spec_name ?? null,
      resolvedSpecVersion: row.resolved_spec_version ?? null,
      resolvedSpecHash: row.resolved_spec_hash ?? null,
      occupantLifecycle: row.occupant_lifecycle as Node["occupantLifecycle"] ?? null,
      continuityOutcome: row.continuity_outcome as Node["continuityOutcome"] ?? null,
      handoverResult: row.handover_result as Node["handoverResult"] ?? null,
      previousOccupant: row.previous_occupant ?? null,
      handoverAt: row.handover_at ?? null,
      createdAt: row.created_at,
    };
  }

  private rowToEdge(row: EdgeRow): Edge {
    return {
      id: row.id,
      rigId: row.rig_id,
      sourceId: row.source_id,
      targetId: row.target_id,
      kind: row.kind,
      createdAt: row.created_at,
    };
  }

  private rowToBinding(row: BindingRow): Binding {
    return {
      id: row.id,
      nodeId: row.node_id,
      attachmentType: (row.attachment_type as Binding["attachmentType"]) ?? "tmux",
      tmuxSession: row.tmux_session,
      tmuxWindow: row.tmux_window,
      tmuxPane: row.tmux_pane,
      externalSessionName: row.external_session_name ?? null,
      cmuxWorkspace: row.cmux_workspace,
      cmuxSurface: row.cmux_surface,
      updatedAt: row.updated_at,
    };
  }

  private rowToServicesRecord(row: RigServicesRow): RigServicesRecord {
    return {
      rigId: row.rig_id,
      kind: row.kind as "compose",
      specJson: row.spec_json,
      rigRoot: row.rig_root,
      composeFile: row.compose_file,
      projectName: row.project_name,
      latestReceiptJson: row.latest_receipt_json ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private hasNodeColumn(columnName: string): boolean {
    return this.db.prepare("PRAGMA table_info(nodes)").all()
      .some((row) => (row as { name?: string }).name === columnName);
  }
}

// -- Raw DB row types (snake_case) --

interface RigRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

interface NodeRow {
  id: string;
  rig_id: string;
  logical_id: string;
  role: string | null;
  runtime: string | null;
  model: string | null;
  effort?: string | null;
  remote_control?: number | null;
  pda_binding?: string | null;
  effort_choice?: string | null;
  codex_config_profile?: string | null;
  permission_policy?: string | null;
  cwd: string | null;
  surface_hint: string | null;
  workspace: string | null;
  restore_policy: string | null;
  package_refs: string | null;
  pod_id: string | null;
  agent_ref: string | null;
  profile: string | null;
  label: string | null;
  session_source_json?: string | null;
  resolved_spec_name: string | null;
  resolved_spec_version: string | null;
  resolved_spec_hash: string | null;
  occupant_lifecycle: string | null;
  continuity_outcome: string | null;
  handover_result: string | null;
  previous_occupant: string | null;
  handover_at: string | null;
  created_at: string;
}

interface EdgeRow {
  id: string;
  rig_id: string;
  source_id: string;
  target_id: string;
  kind: string;
  created_at: string;
}

interface BindingRow {
  id: string;
  node_id: string;
  attachment_type: string | null;
  tmux_session: string | null;
  tmux_window: string | null;
  tmux_pane: string | null;
  external_session_name: string | null;
  cmux_workspace: string | null;
  cmux_surface: string | null;
  updated_at: string;
}

interface RigServicesRow {
  rig_id: string;
  kind: string;
  spec_json: string;
  rig_root: string;
  compose_file: string;
  project_name: string;
  latest_receipt_json: string | null;
  created_at: string;
  updated_at: string;
}
