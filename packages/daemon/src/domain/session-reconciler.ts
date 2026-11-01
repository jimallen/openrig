import { findBindingNodeLiveFirst, findLatestSessionNameMatch } from "./latest-session-name-match.js";
import type Database from "better-sqlite3";
import type { RigRepository } from "./rig-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { EventBus } from "./event-bus.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { TranscriptStore } from "./transcript-store.js";
import { startTmuxTranscriptCapture } from "./transcript-capture.js";
import { deriveResumeToken, type ResumeTokenCaptureDeps } from "./resume-token-capture.js";
import {
  observeSolePane,
  paneObservationVerdict,
  type PaneBindingObservation,
} from "./pane-binding-observation.js";
import { SeatIdentityStore } from "./seat-identity-store.js";
import { paneBindingFields } from "./binding-pane.js";

/**
 * OPR.0.3.4.3 — outcome of the no-launch reconcile (adopt a hand-resumed
 * canonical session back into its persisted node). Honest split: `projectionDrift`
 * lists topology metadata the reconcile could NOT prove about the live pane;
 * `continuity` is ALWAYS "unverified" — reconnecting the projection never claims
 * the provider conversation is continuous.
 */
export interface ReconcileSessionResult {
  rigId: string;
  rigName: string;
  nodeId: string;
  logicalId: string;
  sessionName: string;
  sessionId: string;
  /** Topology metadata the reconcile could not prove on the live pane (e.g.
   *  "runtime unverified: pane command 'node' does not confirm runtime 'codex'"). */
  projectionDrift: string[];
  /** Provider-session conversation continuity is never verified by reconcile. */
  continuity: "unverified";
}

export type ReconcileSessionOutcome =
  | { ok: true; result: ReconcileSessionResult }
  | { ok: false; code: "session_not_found"; message: string }
  | { ok: false; code: "node_not_found"; message: string }
  | { ok: false; code: "rig_not_found"; message: string }
  | { ok: false; code: "node_mismatch"; message: string }
  | { ok: false; code: "reconcile_error"; message: string };

export interface ReconcileSessionOptions {
  sessionName: string;
  /** Optional explicit disambiguation; when given they are authoritative and
   *  cross-checked against the session-name mapping. */
  rigId?: string;
  logicalId?: string;
}

interface SessionReconcilerDeps {
  db: Database.Database;
  rigRepo: RigRepository;
  sessionRegistry: SessionRegistry;
  eventBus: EventBus;
  tmuxAdapter?: TmuxAdapter;
  transcriptStore?: TranscriptStore;
  // OPR.0.4.3.20 FR-3 — adoption-boundary resume-token capture. Both optional
  // and structurally typed (avoid a domain import cycle; older wirings / tests
  // that omit them make capture a silent no-op). contextUsageStore reads the
  // Claude status-line sidecar; resumeTokenCapturer derives the Codex thread id.
  contextUsageStore?: {
    readSidecar(sessionName: string): { ok: true; data: { session_id?: string; sampled_at?: string } } | { ok: false; reason: string };
  };
  /** #421 — start time of the pane's current Claude process; a sidecar sampled earlier is skipped. */
  claudeProcessStartedAt?: ResumeTokenCaptureDeps["claudeProcessStartedAt"];
  resumeTokenCapturer?: {
    captureCodexThreadId(sessionName: string): Promise<string | undefined>;
  };
  /** OPR.0.4.6.PI1 FR-6 — pi-runner sidecar reader for Pi resume-token capture. */
  piRunnerStateStore?: {
    readSessionFile(sessionName: string): { ok: true; sessionFile: string } | { ok: false; reason: string };
  };
  ompRunnerStateStore?: ResumeTokenCaptureDeps["ompRunnerStateStore"];
}

/**
 * Re-adopts a managed seat's OWN canonical session after an outage (the no-launch reconcile, OPR.0.3.4.3).
 * Session adoption of foreign sessions (discover / bind / claim / self-attach) is gone with hc-w7; this is the one piece
 * of the former ClaimService that restore recovery (crash-cart, topology converge) still needs.
 */
export class SessionReconciler {
  readonly db: Database.Database;
  private rigRepo: RigRepository;
  private sessionRegistry: SessionRegistry;
  private eventBus: EventBus;
  private tmuxAdapter: TmuxAdapter | null;
  private transcriptStore: TranscriptStore | null;
  private contextUsageStore: SessionReconcilerDeps["contextUsageStore"] | null;
  private claudeProcessStartedAt: SessionReconcilerDeps["claudeProcessStartedAt"] | null;
  private resumeTokenCapturer: SessionReconcilerDeps["resumeTokenCapturer"] | null;
  private piRunnerStateStore: SessionReconcilerDeps["piRunnerStateStore"] | null;
  private ompRunnerStateStore: SessionReconcilerDeps["ompRunnerStateStore"] | null;

  constructor(deps: SessionReconcilerDeps) {
    if (deps.db !== deps.rigRepo.db) throw new Error("SessionReconciler: rigRepo must share the same db handle");
    if (deps.db !== deps.sessionRegistry.db) throw new Error("SessionReconciler: sessionRegistry must share the same db handle");
    if (deps.db !== deps.eventBus.db) throw new Error("SessionReconciler: eventBus must share the same db handle");
    this.db = deps.db;
    this.rigRepo = deps.rigRepo;
    this.sessionRegistry = deps.sessionRegistry;
    this.eventBus = deps.eventBus;
    this.tmuxAdapter = deps.tmuxAdapter ?? null;
    this.transcriptStore = deps.transcriptStore ?? null;
    this.contextUsageStore = deps.contextUsageStore ?? null;
    this.claudeProcessStartedAt = deps.claudeProcessStartedAt ?? null;
    this.resumeTokenCapturer = deps.resumeTokenCapturer ?? null;
    this.piRunnerStateStore = deps.piRunnerStateStore ?? null;
    this.ompRunnerStateStore = deps.ompRunnerStateStore ?? null;
  }

  private async observeBindingPane(
    sessionName: string,
    knownPane?: string | null,
  ): Promise<PaneBindingObservation> {
    if (knownPane) return { ok: true, pane: knownPane };
    if (!this.tmuxAdapter) {
      return { ok: false, code: "tmux_unavailable", detail: "tmux adapter unavailable" };
    }
    return observeSolePane(this.tmuxAdapter, sessionName);
  }

  private persistPaneBinding(
    nodeId: string,
    sessionName: string,
    observation: PaneBindingObservation,
    sessionId: string,
    tmuxWindow?: string | null,
  ): void {
    this.sessionRegistry.updateBinding(nodeId, {
      tmuxSession: sessionName,
      ...(tmuxWindow ? { tmuxWindow } : {}),
      // hc registers the terminal's address, never a tmux pane; the attachment type follows the host even when the observation failed.
      ...paneBindingFields(this.tmuxAdapter?.hostKind, observation.ok ? observation.pane : null),
    });
    if (!observation.ok) {
      new SeatIdentityStore(this.db).upsert(paneObservationVerdict({
        nodeId,
        sessionId,
        sessionName,
        observation,
      }));
    }
  }

  /** Best-effort: set OpenRig-owned tmux metadata on an adopted session. */
  private async setRiggedMetadata(tmuxSession: string, meta: {
    nodeId: string; sessionName: string; rigId: string; rigName: string; logicalId: string;
  }): Promise<void> {
    if (!this.tmuxAdapter) return;
    const entries: [string, string][] = [
      ["@rigged_node_id", meta.nodeId],
      ["@rigged_session_name", meta.sessionName],
      ["@rigged_rig_id", meta.rigId],
      ["@rigged_rig_name", meta.rigName],
      ["@rigged_logical_id", meta.logicalId],
    ];
    for (const [key, value] of entries) {
      await this.tmuxAdapter.setSessionOption(tmuxSession, key, value);
    }
  }

  /**
   * OPR.0.4.3.20 FR-3 — best-effort capture of a seat's resume token at the
   * adoption boundary (reconcile / adopt / bind). Called post-tx, pre-return
   * from the reconcile adoption path, precisely where an operator has
   * just re-established a live session they expect to survive the next crash.
   *
   * Derivation is REUSE-ONLY and PURE READ — no pane writes, no launch — so it
   * is consistent with reconcile's no-launch/no-input safety contract:
   *   claude-code → the status-line sidecar's session_id (a file read)
   *   codex       → the thread id derived from live pid-keyed logs
   * Persist via updateResumeToken with provenance "adoption"; the rank guard
   * governs clobber (operator/hook are never downgraded; the validity guard
   * blocks an empty write). Honest failure = persist nothing (null token = the
   * honest missing/unverified state) + a redacted skip event with a stated
   * reason. Terminal/unknown runtime is exempt (no capture, no event, not a
   * failure). ANY throw is swallowed — capture NEVER fails or blocks the
   * adoption (PRD Rule 7).
   */
  private async captureResumeTokenOnAdoption(input: {
    rigId: string; nodeId: string; sessionId: string; sessionName: string; runtime: string | null;
  }): Promise<void> {
    try {
      // Derivation is the shared PURE helper (OPR.0.4.3.04 B2 — reused by the
      // seat-handover discovered-mode capture); persistence + events stay here so
      // FR-3's adoption provenance/audit semantics are unchanged.
      const derived = await deriveResumeToken(
        { runtime: input.runtime, sessionName: input.sessionName },
        { contextUsageStore: this.contextUsageStore, claudeProcessStartedAt: this.claudeProcessStartedAt, resumeTokenCapturer: this.resumeTokenCapturer, piRunnerStateStore: this.piRunnerStateStore, ompRunnerStateStore: this.ompRunnerStateStore },
      );
      if (derived.outcome === "exempt" || derived.outcome === "noop") return;
      const runtime = input.runtime as string; // non-null past exempt
      if (derived.outcome === "skipped") {
        this.emitCaptureSkip(input, runtime, derived.reason);
        return;
      }
      const validation = { resumeType: derived.resumeType, token: derived.token };

      // Emit "captured" ONLY when the write actually happened. If the provenance
      // guard refused it (a higher-rank hook/operator token already present —
      // e.g. a hook fired during the async probe window), the ledger is
      // correctly preserved and the event must say so, not falsely claim a
      // captured adoption write at the exact boundary FR-3 makes authoritative.
      const wrote = this.sessionRegistry.updateResumeToken(input.sessionId, validation.resumeType, validation.token, "adoption");
      try {
        this.eventBus.emit(wrote
          ? {
              type: "session.resume_token_captured",
              rigId: input.rigId, nodeId: input.nodeId, sessionName: input.sessionName, sessionId: input.sessionId,
              runtime, outcome: "captured", resumeType: validation.resumeType, provenance: "adoption", redacted: true,
            }
          : {
              type: "session.resume_token_captured",
              rigId: input.rigId, nodeId: input.nodeId, sessionName: input.sessionName, sessionId: input.sessionId,
              runtime, outcome: "preserved", resumeType: validation.resumeType, reason: "higher_rank_present", redacted: true,
            });
      } catch { /* best-effort */ }
    } catch {
      // best-effort — capture never fails or blocks the adoption (PRD Rule 7)
    }
  }

  private emitCaptureSkip(
    input: { rigId: string; nodeId: string; sessionId: string; sessionName: string },
    runtime: string,
    reason: "missing_sidecar" | "parse_error" | "probe_timeout" | "invalid_token" | "stale_sidecar",
  ): void {
    try {
      this.eventBus.emit({
        type: "session.resume_token_captured",
        rigId: input.rigId, nodeId: input.nodeId, sessionName: input.sessionName, sessionId: input.sessionId,
        runtime, outcome: "skipped", reason, redacted: true,
      });
    } catch { /* best-effort */ }
  }

  /**
   * OPR.0.3.4.3 — no-launch reconcile: adopt a LIVE, hand-resumed canonical
   * session back into its persisted node. The safest outage repair (manual
   * `claude --resume` / `codex resume` into the canonical tmux name) leaves the
   * daemon projection showing the seat down; this binds the live process to its
   * OWN node and flips the projection, and does NOTHING else.
   *
   * THE SAFETY LINE (guard rev1): reuses ONLY the DB binding / projection /
   * metadata portions of bind — NEVER the post-claim input path. It does not
   * call launchNode / createSession / killSession / sendText / sendKeys /
   * deliverClaimHint / startup-or-resume delivery / compact-menu automation.
   * Allowed target ops: hasSession check, pane metadata/PID reads,
   * binding/session/projection upserts, non-input tmux metadata
   * (setSessionOption), event emission, transcript bookkeeping.
   *
   * Identity boundary: binds to the EXISTING node — same node id, no re-key,
   * no migration. Honest split: projectionDrift (unproven topology metadata)
   * is reported separately; continuity is always "unverified".
   */
  async reconcileSession(opts: ReconcileSessionOptions): Promise<ReconcileSessionOutcome> {
    const sessionName = opts.sessionName.trim();
    if (!sessionName) {
      return { ok: false, code: "session_not_found", message: "sessionName is required." };
    }

    // 1. Resolve the persisted node for this canonical session name. The
    // session-name mapping is the daemon's own history (bindings + session
    // rows); explicit --rig/--node are authoritative and cross-checked.
    let nodeRow: { id: string; rig_id: string; logical_id: string; runtime: string | null; cwd: string | null } | undefined;
    if (opts.rigId && opts.logicalId) {
      const rig = this.rigRepo.getRig(opts.rigId);
      if (!rig) {
        return { ok: false, code: "rig_not_found", message: `Rig "${opts.rigId}" not found.` };
      }
      const node = rig.nodes.find((candidate) => candidate.logicalId === opts.logicalId);
      if (!node) {
        return { ok: false, code: "node_not_found", message: `Logical ID "${opts.logicalId}" does not exist in rig "${rig.rig.name}".` };
      }
      nodeRow = { id: node.id, rig_id: opts.rigId, logical_id: node.logicalId, runtime: node.runtime ?? null, cwd: node.cwd ?? null };
      // Cross-check: if the daemon's history maps this session name to a
      // DIFFERENT node, refuse honestly rather than silently re-pointing.
      const mapped = this.resolveNodeIdForSessionName(sessionName);
      if (mapped && mapped !== node.id) {
        return {
          ok: false,
          code: "node_mismatch",
          message: `Session "${sessionName}" maps to a different persisted node than ${opts.logicalId}. Re-check --rig/--node, or omit them to use the daemon's mapping.`,
        };
      }
      // IDENTITY BOUNDARY (guard re-review): with NO daemon-history mapping,
      // explicit --rig/--node may only adopt the node's OWN canonical/managed
      // session name. Binding an arbitrary never-managed name to a node would
      // be an adopt/re-key path, not a reconcile — and adopting an
      // unmanaged session was removed with the hc cutover (decision 13).
      if (!mapped) {
        const expected = await this.expectedManagedSessionName(node.logicalId, node.podId ?? null, rig.rig.name);
        if (sessionName !== expected) {
          return {
            ok: false,
            code: "node_mismatch",
            message: `Session "${sessionName}" is not ${opts.logicalId}'s managed session name (expected "${expected}") and the daemon has no history mapping it to this node. Reconcile only re-adopts a node's own canonical session; adopting an unmanaged session is not supported; launch the seat with rig seat launch.`,
          };
        }
      }
    } else {
      const mappedNodeId = this.resolveNodeIdForSessionName(sessionName);
      if (!mappedNodeId) {
        return {
          ok: false,
          code: "node_not_found",
          message: `No persisted node maps to session "${sessionName}". If this seat was never managed, adopting it is not supported (launch it with rig seat launch); reconcile only re-adopts a previously managed seat. You can disambiguate with --rig <rig> --node <logicalId>.`,
        };
      }
      const row = this.db
        .prepare("SELECT id, rig_id, logical_id, runtime, cwd FROM nodes WHERE id = ?")
        .get(mappedNodeId) as { id: string; rig_id: string; logical_id: string; runtime: string | null; cwd: string | null } | undefined;
      if (!row) {
        return { ok: false, code: "node_not_found", message: `Persisted node for session "${sessionName}" no longer exists.` };
      }
      nodeRow = row;
    }

    const rig = this.rigRepo.getRig(nodeRow.rig_id);
    if (!rig) {
      return { ok: false, code: "rig_not_found", message: `Rig for node "${nodeRow.logical_id}" no longer exists.` };
    }

    // 2. Verify a LIVE tmux session with the canonical name exists (read-only).
    if (!this.tmuxAdapter) {
      return { ok: false, code: "reconcile_error", message: "tmux adapter unavailable; cannot verify the live session." };
    }
    const guard = this.tmuxAdapter.deliveryGuard;
    const observedTarget = guard?.target(nodeRow.id);
    const alive = await this.tmuxAdapter.hasSession(sessionName);
    if (!alive) {
      return {
        ok: false,
        code: "session_not_found",
        message: `No live tmux session named "${sessionName}". Reconcile adopts a RUNNING session; to start the seat, use the launch path instead.`,
      };
    }

    // 3. Read-only pane facts for the honest drift report. Reading never
    // injects input; failures degrade to drift entries, not errors.
    const projectionDrift: string[] = [];
    const paneObservation = await this.observeBindingPane(sessionName);
    if (!paneObservation.ok) projectionDrift.push(paneObservation.detail);
    let paneCommand: string | null = null;
    try {
      paneCommand = await this.tmuxAdapter.getPaneCommand(
        paneObservation.ok ? paneObservation.pane : sessionName,
      );
    } catch { paneCommand = null; }
    if (nodeRow.runtime) {
      const expectation: Record<string, string[]> = {
        "claude-code": ["claude", "node"],
        codex: ["codex", "node"],
        terminal: [],
      };
      const expected = expectation[nodeRow.runtime];
      if (!paneCommand) {
        projectionDrift.push(`runtime unverified: pane command unreadable; node declares runtime "${nodeRow.runtime}"`);
      } else if (expected && expected.length > 0 && !expected.includes(paneCommand)) {
        projectionDrift.push(`runtime unverified: pane command "${paneCommand}" does not confirm runtime "${nodeRow.runtime}"`);
      }
    }
    if (nodeRow.cwd) {
      projectionDrift.push(`cwd unverified: node declares "${nodeRow.cwd}"; the live pane's cwd is not provable without injecting input`);
    }

    // 4. The DB portion of bind, reconcile-shaped: supersede stale session
    // rows for THIS node, upsert the binding to the live session, register a
    // fresh claimed-session row (status running), emit node.reconciled — one tx.
    try {
      let sessionId = "";
      let persistedEvent: ReturnType<EventBus["persistWithinTransaction"]> | undefined;
      const tx = this.db.transaction(() => {
        const stale = this.db
          .prepare("SELECT id FROM sessions WHERE node_id = ? AND status = 'running'")
          .all(nodeRow!.id) as Array<{ id: string }>;
        for (const row of stale) {
          this.sessionRegistry.markSuperseded(row.id);
        }
        const session = this.sessionRegistry.registerClaimedSession(nodeRow!.id, sessionName);
        this.persistPaneBinding(nodeRow!.id, sessionName, paneObservation, session.id);
        sessionId = session.id;
        persistedEvent = this.eventBus.persistWithinTransaction({
          type: "node.reconciled",
          rigId: nodeRow!.rig_id,
          nodeId: nodeRow!.id,
          logicalId: nodeRow!.logical_id,
          sessionName,
        });
      });
      if (guard && observedTarget) guard.reconcileBinding(observedTarget, tx);
      else tx();
      if (persistedEvent) this.eventBus.notifySubscribers(persistedEvent);

      // 5. Best-effort NON-INPUT housekeeping: OpenRig-owned tmux metadata
      // (setSessionOption only) + transcript capture (pipe-pane bookkeeping).
      // Deliberately NO deliverClaimHint and NO context-collector provisioning
      // — nothing that writes into the live pane or the seat's workspace.
      try {
        await this.setRiggedMetadata(sessionName, {
          nodeId: nodeRow.id,
          sessionName,
          rigId: nodeRow.rig_id,
          rigName: rig.rig.name,
          logicalId: nodeRow.logical_id,
        });
      } catch { /* best-effort */ }
      try {
        await startTmuxTranscriptCapture(this.tmuxAdapter, this.transcriptStore, rig.rig.name, sessionName);
      } catch { /* best-effort */ }
      // OPR.0.4.3.20 FR-3 — capture the resume token at the adoption boundary.
      // Pure reads only (sidecar file / pid-keyed log) — consistent with the
      // no-launch/no-input contract above; does NOT touch `continuity`
      // (FR-3 captures a token, it does not assert conversation continuity).
      await this.captureResumeTokenOnAdoption({
        rigId: nodeRow.rig_id, nodeId: nodeRow.id, sessionId, sessionName,
        runtime: nodeRow.runtime,
      });

      return {
        ok: true,
        result: {
          rigId: nodeRow.rig_id,
          rigName: rig.rig.name,
          nodeId: nodeRow.id,
          logicalId: nodeRow.logical_id,
          sessionName,
          sessionId,
          projectionDrift,
          continuity: "unverified",
        },
      };
    } catch (err) {
      return { ok: false, code: "reconcile_error", message: (err as Error).message };
    }
  }

  /** The session name a managed node is EXPECTED to live at — pod-aware nodes
   *  derive `{pod}-{member}@{rigName}`; legacy flat nodes use the legacy
   *  derivation. Used to fence the explicit --rig/--node reconcile branch when
   *  the daemon has no history mapping for the supplied name. */
  private async expectedManagedSessionName(logicalId: string, podId: string | null, rigName: string): Promise<string> {
    const { deriveCanonicalSessionName, deriveSessionName } = await import("./session-name.js");
    if (podId) {
      const parts = logicalId.split(".");
      if (parts.length >= 2) {
        return deriveCanonicalSessionName(parts[0]!, parts.slice(1).join("."), rigName);
      }
    }
    return deriveSessionName(rigName, logicalId);
  }

  /** Map a canonical session name to its persisted node via the daemon's own
   *  history: the current binding first, then the most recent session row. */
  private resolveNodeIdForSessionName(sessionName: string): string | null {
    const boundNodeId = findBindingNodeLiveFirst(this.db, sessionName);
    if (boundNodeId) return boundNodeId;
    return findLatestSessionNameMatch(this.db, sessionName)?.node_id ?? null;
  }
}
