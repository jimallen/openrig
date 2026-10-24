import type { AgentActivity, Binding, StartupFile } from "./types.js";
import { PDA_RUNTIME } from "../adapters/pda-runner-protocol.js";
import type { ProjectionPlan } from "./projection-planner.js";

// -- Bridge type: NodeBinding extends Binding with cwd --
// Interim repo type. The current repo only has Binding in types.ts.
// The startup orchestrator (AS-T07) constructs NodeBinding from Binding + node.cwd.

export interface NodeBinding extends Binding {
  cwd: string;
  model?: string;
  effort?: string;
  /** The seat declared `remote_control: true` (nodes.remote_control): every claude launch of it carries
   *  `--remote-control <session name>` (claude-code only; absent/false = command unchanged). */
  remoteControl?: boolean;
  codexConfigProfile?: string;
  /** OPR.0.4.8.3 Seam B: the seat's RESOLVED launch posture from its permission_policy
   * attachment (member > rig precedence, resolved by the core resolver at materialize /
   * restore). Absent = no policy attached → the env-driven floor/YOLO decision stands.
   * Present = authoritative for this seat (overrides the env read in BOTH directions). */
  launchPosture?: "floor" | "full_bypass" | "auto";
  /** Explicit Claude native mode; checked against the bound managed executable. */
  permissionMode?: string;
  /** Persisted rig opt-in to per-launch warning acceptance, only at full_bypass. */
  nonInterruptive?: boolean;
  /** Launch-only operational default, derived from the persisted kernel rig and explicit selections. */
  kernelAuthority?: boolean;
  /** Derived at launch only when no authored policy, seat choice or native profile applies. */
  teamPermissionDefault?: boolean;
  /** Reserved successor generation; current tenure remains the input fence until commit. */
  launchGeneration?: string;
  /** #25: the rig's `managed_blocks.claude-code` file. Absent = CLAUDE.md. Only the Claude adapter reads it. */
  claudeManagedBlockFile?: import("./managed-blocks.js").ClaudeManagedBlockFile;
  /** pda L0: the pda agent a `runtime: pda` seat drives (`nodes.pda_binding`, L2b). Only the pda adapter reads it. */
  pda?: import("../adapters/pda-runner-protocol.js").PdaBinding;
}

// -- Resolved startup file with source-root provenance --

export interface ResolvedStartupFile {
  /** Explicit per-seat role orientation; never inferred from the filename. */
  orientation?: "role";
  path: string;
  absolutePath: string;
  ownerRoot: string;
  deliveryHint: "auto" | "guidance_merge" | "skill_install" | "send_text";
  required: boolean;
  appliesOn: ("fresh_start" | "restore")[];
  /** Optional discriminator; startup artifacts are files only. */
  kind?: "file";
  /** Read this file through the shared guarded reader (culture-file-guard.ts readGuardedStartupFile):
   *  regular file, one link, size cap, one descriptor. Set on the rig culture overlay. */
  guardedRead?: boolean;
}

// -- Adapter result types --

export interface InstalledResource {
  effectiveId: string;
  category: string;
  installedPath: string;
}

export interface ProjectionResult {
  warnings?: string[];
  projected: string[];
  skipped: string[];
  failed: Array<{ effectiveId: string; error: string }>;
}

export interface StartupDeliveryResult {
  warnings?: string[];
  delivered: number;
  failed: Array<{ path: string; error: string }>;
}

export interface ReadinessResult {
  ready: boolean;
  reason?: string;
  code?: string;
}

export const ATTENTION_REQUIRED_READINESS_CODES = new Set([
  "trust_gate",
  "hook_trust_gate",
  "update_gate",
  "login_required",
  "mcp_gate",
  "bypass_consent_gate",
  // Codex auth refusal (stored OAuth token can no longer be refreshed).
  // Defensive: row 6's verifyResumeLaunch patch propagates attention_required
  // through the launch path so the readiness fallback shouldn't see this code,
  // but adding it here keeps the two paths semantically aligned.
  "codex_auth_refusal",
  "codex_client_incompatible",
  // pda L0 (design 9l Rev 2): a pda runner's checkReady codes that need a person. Inert until a pda adapter
  // (L2a) returns them. pda_agent_missing: OpenRig never creates a pda agent, so a missing one needs a person.
  "pda_unauthorized",
  "pda_token_format",
  "pda_agent_missing",
  "pda_message_held",
]);

export function isAttentionRequiredReadinessCode(code: string | undefined): boolean {
  return !!code && ATTENTION_REQUIRED_READINESS_CODES.has(code);
}

// -- Harness launch result --

export type HarnessLaunchRecovery = "retry_fresh" | "attention_required";

// `launchedProcess` (Claude resume launches): the first process the launch's own readiness check
// pinned as the one it started, kept even when a later sample saw it replaced (#1077).
export type HarnessLaunchResult =
  | { ok: true; resumeToken?: string; resumeType?: string; appliedLaunch?: import("./permission-drift.js").AppliedLaunchObservation;
    launchedProcess?: import("./native-process-lineage.js").ClaudeLaunchedProcess }
  // `evidence` carries the last-N pane lines for `attention_required` outcomes
  // so the failure can flow honest evidence through to RestoreNodeResult's
  // attentionEvidence field. Omitted for non-attention recoveries.
  // `missingConversation` is set only when the runtime itself reported that the requested
  // conversation doesn't exist; other `retry_fresh` failures (such as a pane back at its shell)
  // leave it unset.
  | { ok: false; error: string; recovery?: HarnessLaunchRecovery; evidence?: string; missingConversation?: true;
    launchedProcess?: import("./native-process-lineage.js").ClaudeLaunchedProcess };

// -- Shared concrete-hint resolver --

/**
 * Resolve 'auto' delivery hint to a concrete hint.
 * Single source of truth — used by both the startup partition and adapter delivery.
 * Rules match existing adapter logic byte-for-byte.
 */
export function resolveConcreteHint(
  path: string,
  content: string,
): "guidance_merge" | "skill_install" | "send_text" {
  if (path.endsWith("SKILL.md") || content.startsWith("# SKILL")) return "skill_install";
  if (path.endsWith(".md")) return "guidance_merge";
  return "send_text";
}

// -- Runtime adapter contract --

/** pda L0: what `RuntimeAdapter.sendReadiness` is asked about. Identity only: a runner's readiness is a
 *  file the runner writes, found by session name. */
export interface RunnerReadinessTarget {
  sessionName: string;
  nodeId: string | null;
}

/** What SessionTransport consults for a runner-hosted seat's send readiness (review N3 seam guard). The
 *  transport asks, and believes, ONLY a runtime in `runtimes`: a runtime whose adapter declares
 *  `sendReadiness`. A mis-wired source can therefore never touch claude-code, codex, pi, omp, terminal or
 *  stub. Build it with `runnerSendReadinessFromAdapters`, never by hand. */
export interface RunnerSendReadinessSource {
  readonly runtimes: ReadonlySet<string>;
  ask(target: RunnerReadinessTarget & { runtime: string }): Promise<import("./types.js").AgentActivity | null>;
}

/** The only constructor L2a should use for SessionTransport's `runnerSendReadiness` dep: one entry per
 *  adapter-map key whose adapter declares `sendReadiness`, and nothing else. */
export function runnerSendReadinessFromAdapters(
  adapters: Readonly<Record<string, Pick<RuntimeAdapter, "sendReadiness"> | undefined>>,
): RunnerSendReadinessSource {
  const declared = new Map<string, NonNullable<RuntimeAdapter["sendReadiness"]>>();
  for (const [runtime, adapter] of Object.entries(adapters)) {
    const fn = adapter?.sendReadiness;
    if (typeof fn === "function") declared.set(runtime, fn.bind(adapter));
  }
  return {
    runtimes: new Set(declared.keys()),
    ask: async (target) => {
      const fn = declared.get(target.runtime);
      return fn ? fn({ sessionName: target.sessionName, nodeId: target.nodeId }) : null;
    },
  };
}

/** pda L2a: the runtimes whose adapter declares `freshStart: "unsupported"`, for the decisions that run without an
 *  adapter map (restore-seat-gates' remedy text). The adapter's declaration is the authority; a startup pin checks
 *  this set equals the adapter map's "unsupported" keys, so the two cannot drift. */
export const RUNTIMES_WITHOUT_FRESH_START: ReadonlySet<string> = new Set([PDA_RUNTIME]);

/** How an adapter's optional `freshStart` reads when absent: supported, every runtime's behaviour today. */
export function adapterFreshStart(adapter: Pick<RuntimeAdapter, "freshStart"> | null | undefined): "supported" | "unsupported" {
  return adapter?.freshStart === "unsupported" ? "unsupported" : "supported";
}

/** How an adapter's optional `startupContent` reads when absent: deliver, every runtime's behaviour today. */
export function adapterStartupContent(adapter: Pick<RuntimeAdapter, "startupContent"> | null | undefined): "deliver" | "withhold" {
  return adapter?.startupContent === "withhold" ? "withhold" : "deliver";
}

/**
 * Member-level fork-source input translated by the startup orchestrator from
 * the rigspec member's `sessionSource` field. v1 narrow MVP: kind="native_id"
 * only; other shapes are rejected at schema validation today.
 *
 * Adapters that support fork (claude-code, codex) build their respective
 * fork command from this input and capture the NEW post-fork token, never
 * the parent. Adapters that don't support fork (terminal) refuse with a
 * clear runtime-mismatch error.
 */
export interface ForkSource {
  kind: "native_id" | "artifact_path" | "name" | "last";
  value?: string;
  /** Set only by a seat handover: a launch whose new id isn't captured yet still succeeds, with the id
   *  pending, so the handover can commit the ready successor. Every other fork caller keeps the
   *  refusal on a missed capture. */
  pendingIdAllowed?: boolean;
}

/**
 * The five-method runtime adapter contract.
 * Adapters own projection, delivery, harness launch, reconciliation, and readiness.
 * Startup action execution is NOT part of this contract — that belongs
 * to the startup orchestrator after checkReady().
 */
export interface RuntimeAdapter {
  /** Claude's managed capability/launch seam, shared with seat selection. */
  readonly claudeManagedLaunch?: import("./claude-managed-launch.js").ClaudeManagedLaunch;
  readonly runtime: string;
  /** The file an adapter's project() writes for a skill when it lives outside
   *  the Claude project tree, for "already in place" detection. Absent = the
   *  instantiator's default target. */
  skillTargetPath?(tmuxSession: string | null, effectiveId: string): string | null;

  /** List currently installed/projected resources for a node. */
  listInstalled(binding: NodeBinding): Promise<InstalledResource[]>;

  /** Project resources from a projection plan to the runtime target locations. */
  project(plan: ProjectionPlan, binding: NodeBinding): Promise<ProjectionResult>;

  /** Deliver startup files. Claude's post-launch path can reuse the orchestrator's checked send.
   * The adapter still owns file reads, ordering, provisioning and required/optional errors. */
  deliverStartup(files: ResolvedStartupFile[], binding: NodeBinding, sendInteractiveText?: (text: string) => Promise<void>): Promise<StartupDeliveryResult>;

  /**
   * Launch the harness (claude/codex/terminal) inside the tmux session.
   *
   * `resumeToken` and `forkSource` are mutually exclusive. If both are
   * provided, adapters MUST refuse with a clear error rather than guess.
   * `forkSource` triggers a fork from the named source; the captured
   * resumeToken in the result is the NEW post-fork token, never the parent.
   */
  launchHarness(
    binding: NodeBinding,
    opts: { name: string; resumeToken?: string; forkSource?: ForkSource },
  ): Promise<HarnessLaunchResult>;

  /** Check if the runtime harness is responsive and ready. */
  checkReady(binding: NodeBinding): Promise<ReadinessResult>;

  /**
   * pda L0 (design 9l Rev 2 D7/A3; review D1). Send readiness from a runner-authored surface (the runner's
   * sidecar), consulted by `rig send` BEFORE any pane heuristic. Null = no runner answer: today's logic
   * decides. Absent on every adapter today.
   *
   * ASYNC by contract (review D1). The answer is believed only while the pane's foreground is not a shell:
   * a sidecar outlives a SIGKILLed runner for up to its alive window, and on `--wait-for-idle` the transport's
   * shell refusal runs once, BEFORE the wait. SessionTransport applies that foreground check at the seam
   * itself (one rule, one site), so an implementation cannot forget it; an implementation may check more.
   * The returned activity is re-labelled `evidenceSource: "runner_sidecar"` by the transport.
   */
  sendReadiness?(target: RunnerReadinessTarget): Promise<AgentActivity | null>;

  /** pda L0 (design A4). "unsupported": the runtime owns the conversation and has no fresh start, so a
   *  `--fresh` request is refused at the shared fresh decision (L2a). Absent = "supported" (adapterFreshStart). */
  readonly freshStart?: "supported" | "unsupported";

  /** pda L0 (design D4). "withhold": OpenRig delivers no startup content, actions, preload or proof challenge
   *  to this runtime (the orchestrator gate is L2a). Absent = "deliver" (adapterStartupContent). */
  readonly startupContent?: "deliver" | "withhold";
}
