import type Database from "better-sqlite3";
import type { RigRepository } from "./rig-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { EventBus } from "./event-bus.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { TranscriptStore } from "./transcript-store.js";
import type { PersistedEvent } from "./types.js";
import { validateSessionName, deriveSessionName } from "./session-name.js";
import {
  startTranscriptRotation,
  getTranscriptRotationOptionsFromEnv,
} from "./transcript-rotation.js";
import type { TmuxOptionDefaultsApplier } from "./tmux-option-defaults.js";
import { observeSolePane, paneObservationVerdict } from "./pane-binding-observation.js";
import { SeatIdentityStore } from "./seat-identity-store.js";
import { ensureCodexSeatHome } from "./codex-seat-home.js";
import type { CodexConfigWritePolicy } from "./codex-config-write-policy.js";
import { ensureGitWorktreeShim, withWorktreeShimPath } from "./git-worktree-shim.js";
import * as os from "node:os";
import * as path from "node:path";
import type { OccupantKind } from "./session-registry.js";
import { getSeatCwdFault, seatCwdUnusableMessage } from "./cwd-resolution.js";
import { recreateProjectRigWorkspace } from "./project-rig.js";

import type { Session, Binding } from "./types.js";

export type LaunchResult =
  | { ok: true; sessionName: string; session: Session; binding: Binding; warnings?: string[] }
  | { ok: false; code: string; message: string };

interface LaunchOpts {
  sessionName?: string;
  cwd?: string;
  /**
   * Per-seat silence window override (seconds). Currently inert: the
   * live SeatActivityService poller uses the global default (3s) and
   * does not read per-seat windows. Retained for future per-seat-poller
   * decision. Caller plumbs from AgentSpec.profile.activity.
   */
  silenceWindowSeconds?: number;
  /** A deliberate fresh occupant is distinct from initial rig boot in the tenure ledger. */
  occupantKind?: OccupantKind;
  /** The operator asked for this seat to start fresh (a restore with `--fresh <seat>`); recorded on the session row. */
  freshStart?: boolean;
}

interface NodeLauncherDeps {
  db: Database.Database;
  rigRepo: RigRepository;
  sessionRegistry: SessionRegistry;
  eventBus: EventBus;
  tmuxAdapter: TmuxAdapter;
  transcriptStore?: TranscriptStore;
  sessionEnv?: Record<string, string | undefined>;
  /** Extra launch env for one runtime only (OMP's provider keys), merged over
   *  sessionEnv so other runtimes' seats never receive it. */
  runtimeSessionEnv?: Record<string, Record<string, string | undefined>>;
  /** Default silence window (seconds). Currently used only as the
   *  SeatActivityService global default (3s). Per-seat override via
   *  LaunchOpts is currently inert. */
  defaultSilenceWindowSeconds?: number;
  /**
   * OPR.0.4.6.02 S1 — the SHARED tmux option-defaults applier (mouse/status
   * session-scope + set-clipboard/copy-command server-scope), applied to the
   * just-created session at launch. Injected from startup so the same
   * instance (and its once-per-daemon server-defaults memo) is shared with
   * SuccessorSessionLauncher. When omitted (most unit tests), the launch path
   * skips option application entirely.
   */
  tmuxOptionDefaults?: TmuxOptionDefaultsApplier;
  /** OF-183: whether this daemon may change the shared Codex config.toml a seat home links to. Absent = unrestricted. */
  codexConfigWritePolicy?: CodexConfigWritePolicy;
}

export class NodeLauncher {
  readonly db: Database.Database;
  private rigRepo: RigRepository;
  private sessionRegistry: SessionRegistry;
  private eventBus: EventBus;
  private tmuxAdapter: TmuxAdapter;
  private transcriptStore: TranscriptStore | null;
  private sessionEnv: Record<string, string>;
  private runtimeSessionEnv: Record<string, Record<string, string | undefined>>;
  private defaultSilenceWindowSeconds: number;
  private codexConfigWritePolicy: CodexConfigWritePolicy | null;
  private tmuxOptionDefaults: TmuxOptionDefaultsApplier | null;

  constructor(deps: NodeLauncherDeps) {
    // Hard runtime invariant: all domain services must share the same db handle.
    // Without this, db.transaction() in launchNode cannot span all writes atomically.
    if (deps.db !== deps.rigRepo.db) {
      throw new Error("NodeLauncher: rigRepo must share the same db handle");
    }
    if (deps.db !== deps.sessionRegistry.db) {
      throw new Error("NodeLauncher: sessionRegistry must share the same db handle");
    }
    if (deps.db !== deps.eventBus.db) {
      throw new Error("NodeLauncher: eventBus must share the same db handle");
    }

    this.db = deps.db;
    this.rigRepo = deps.rigRepo;
    this.sessionRegistry = deps.sessionRegistry;
    this.eventBus = deps.eventBus;
    this.tmuxAdapter = deps.tmuxAdapter;
    this.transcriptStore = deps.transcriptStore ?? null;
    this.sessionEnv = compactEnv(deps.sessionEnv ?? {});
    this.runtimeSessionEnv = deps.runtimeSessionEnv ?? {};
    this.defaultSilenceWindowSeconds = deps.defaultSilenceWindowSeconds ?? 3;
    this.tmuxOptionDefaults = deps.tmuxOptionDefaults ?? null;
    this.codexConfigWritePolicy = deps.codexConfigWritePolicy ?? null;
  }

  async launchNode(
    rigId: string,
    logicalId: string,
    opts?: LaunchOpts
  ): Promise<LaunchResult> {
    // 1. Validate node exists and is unbound
    const rig = this.rigRepo.getRig(rigId);
    if (!rig) {
      return { ok: false, code: "node_not_found", message: `Rig ${rigId} not found` };
    }

    const node = rig.nodes.find((n) => n.logicalId === logicalId);
    if (!node) {
      return { ok: false, code: "node_not_found", message: `Node ${logicalId} not found in rig` };
    }

    const guard = this.tmuxAdapter.deliveryGuard;
    if (guard && !guard.ownsLifecycle(node.id)) {
      return guard.lifecycle([node.id], () => this.launchNode(rigId, logicalId, opts));
    }

    if (node.binding !== null) {
      return { ok: false, code: "already_bound", message: `Node ${logicalId} is already bound` };
    }

    // 2. Derive or validate session name
    const sessionName = opts?.sessionName ?? deriveSessionName(rig.rig.name, logicalId);
    if (!validateSessionName(sessionName)) {
      return {
        ok: false,
        code: "invalid_session_name",
        message: `Derived session name "${sessionName}" does not match OpenRig naming pattern`,
      };
    }

    // OF-69: the backstop for every launch that goes through launchNode (first start, restore, relaunch, `up --existing`,
    // `--startup-from stored`, the TUI). tmux does not refuse a missing `-c` directory: it starts the session in $HOME, so
    // the seat would run in the wrong place with no error. Nothing is created here except a project rig's own missing workspace (below). A seat with no cwd at all
    // has no folder to judge and keeps tmux's default. Callers that stop something first (fresh launch) run the same
    // check earlier, before the stop. The two respawn paths that do not come through here judge the same folder with the
    // same helper (OF-124): restart-in-place (seat-restart-in-place.ts) and handover (successor-session-launcher.ts).
    const seatCwd = opts?.cwd ?? node.cwd ?? undefined;
    // A project rig's own `.workspaces/<seat>` folder is the daemon's to keep: when it is gone (a `git clean -fdx`), the
    // launch makes it again as `rig up` did, then judges it like any other. No other folder is ever created here.
    if (seatCwd && getSeatCwdFault(seatCwd)?.kind === "missing") recreateProjectRigWorkspace(rig.rig.name, logicalId, seatCwd);
    const cwdFault = seatCwd ? getSeatCwdFault(seatCwd) : null;
    if (seatCwd && cwdFault) {
      return {
        ok: false,
        code: "seat_cwd_unusable",
        message: seatCwdUnusableMessage(logicalId, seatCwd, cwdFault),
      };
    }

    // 3. Reserve the source-bound occupant generation before the process starts. Reservation is
    // side-effect-free and fail-open: an unavailable ledger yields null and the launch remains valid.
    const occupantGeneration = this.sessionRegistry.reserveOccupantGeneration();

    // Create tmux session with OpenRig identity env vars. A duplicate is a
    // collision, never authority to kill an unmanaged same-name session.
    const openRigEnv = compactEnv({
      OPENRIG_NODE_ID: node.id,
      OPENRIG_SESSION_NAME: sessionName,
      OPENRIG_RUNTIME: node.runtime ?? undefined,
      ...this.sessionEnv,
      ...(node.runtime ? this.runtimeSessionEnv[node.runtime] : undefined),
      OPENRIG_OCCUPANT_GENERATION: occupantGeneration ?? undefined,
    });
    const codexSeatWarnings: string[] = [];

    // Worktree placement law: every rig seat gets the git shim first on PATH,
    // so 'git worktree add' outside <repo>/.rig-worktrees redirects rather
    // than sprawling into ~/Code as a sibling (171-tree pileup, 2026-10-02).
    try {
      const shimHome = this.sessionEnv["OPENRIG_HOME"] ?? process.env["OPENRIG_HOME"] ?? path.join(os.homedir(), ".openrig");
      await ensureGitWorktreeShim(shimHome);
      withWorktreeShimPath(openRigEnv, shimHome);
    } catch (err) {
      codexSeatWarnings.push(
        `worktree shim materialization failed (${err instanceof Error ? err.message : String(err)}); seat launches without the placement shim`,
      );
    }

    if (node.runtime === "codex") {
      // codex seats get a per-seat CODEX_HOME so their managed app-server
      // freezes THIS seat's env, not the first launcher's on the shared
      // ~/.codex (measured: verify seats resolved identity as
      // queue-worker@kernel through the shared daemon — see codex-seat-home).
      try {
        const seatHome = await ensureCodexSeatHome(sessionName, {
          openrigHome: this.sessionEnv["OPENRIG_HOME"],
          sharedCodexHome: this.sessionEnv["CODEX_HOME"],
          ...(this.codexConfigWritePolicy ? { configWritePolicy: this.codexConfigWritePolicy } : {}),
        });
        openRigEnv["CODEX_HOME"] = seatHome.path;
        // OF-115: a profile withheld for carrying a seat identity, or a shared config.toml that sets one, is told to the
        // operator in the launch result, not only on the daemon console.
        codexSeatWarnings.push(...seatHome.warnings);
      } catch (err) {
        codexSeatWarnings.push(
          `codex per-seat CODEX_HOME seeding failed (${err instanceof Error ? err.message : String(err)}); seat launches on the shared home and may inherit a foreign session identity`,
        );
      }
    }
    const tmuxResult = await this.tmuxAdapter.createSession(sessionName, seatCwd, openRigEnv);
    if (!tmuxResult.ok) {
      return { ok: false, code: tmuxResult.code, message: tmuxResult.message };
    }

    // The session's own non-fatal warnings (#771: the parent-session identity cleanup).
    const launchWarnings: string[] = [...codexSeatWarnings, ...(tmuxResult.warnings ?? [])];

    // Observe the pane before the DB transaction. A concrete pane is committed
    // with session+binding; an unresolved pane gets a durable named verdict in
    // that same transaction rather than carrying an unexplained NULL forward.
    const paneObservation = await observeSolePane(this.tmuxAdapter, sessionName);

    // 3a2. OPR.0.4.6.02 S1 — apply the daemon's tmux option defaults to the
    // JUST-CREATED session via the shared applier (mouse/status session-scope
    // + set-clipboard/copy-command server-scope). Touches only this new
    // session, never an existing one (BR-1 never-retro). Option-set failures
    // come back as non-fatal launch warnings.
    if (this.tmuxOptionDefaults) {
      launchWarnings.push(...(await this.tmuxOptionDefaults.applyToFreshSession(sessionName)));
    }

    // 3b. Start transcript rotation (V1 pre-release CLI/daemon Item 1:
    // bounded capture-pane overwrite replaces the unbounded pipe-pane
    // mechanism). Failures inside individual rotation ticks are silent
    // (best-effort); only the transcript directory not being writable
    // surfaces a launch warning.
    if (this.transcriptStore?.enabled) {
      const dirOk = this.transcriptStore.ensureTranscriptDir(rig.rig.name);
      if (dirOk) {
        const transcriptPath = this.transcriptStore.getTranscriptPath(rig.rig.name, sessionName);
        startTranscriptRotation(
          this.tmuxAdapter,
          sessionName,
          transcriptPath,
          getTranscriptRotationOptionsFromEnv(),
          getTranscriptRotationOptionsFromEnv,
        );
      } else {
        launchWarnings.push(`Transcript directory creation failed for rig ${rig.rig.name}`);
      }
    }

    // 4. DB transaction: session + binding + event (atomic)
    let persistedEvent: PersistedEvent;
    let createdSessionId: string | null = null;
    try {
      const txn = this.db.transaction(() => {
        const session = this.sessionRegistry.registerSession(
          node.id,
          sessionName,
          opts?.occupantKind ?? "initial",
          occupantGeneration,
          opts?.freshStart === true,
        );
        createdSessionId = session.id;
        this.sessionRegistry.updateStatus(session.id, "running");
        this.sessionRegistry.updateBinding(node.id, {
          tmuxSession: sessionName,
          ...(paneObservation.ok ? { tmuxPane: paneObservation.pane } : {}),
        });
        if (!paneObservation.ok) {
          new SeatIdentityStore(this.db).upsert(paneObservationVerdict({
            nodeId: node.id,
            sessionId: session.id,
            sessionName,
            observation: paneObservation,
          }));
        }
        return this.eventBus.persistWithinTransaction({
          type: "node.launched",
          rigId,
          nodeId: node.id,
          logicalId: node.logicalId,
          sessionName,
        });
      });
      persistedEvent = txn();
    } catch (err) {
      // DB failed — best-effort tmux cleanup
      await this.tmuxAdapter.killSession(sessionName);
      return {
        ok: false,
        code: "db_error",
        message: err instanceof Error ? err.message : String(err),
      };
    }

    this.tmuxAdapter.deliveryGuard?.rebindLifecycle(node.id);
    this.tmuxAdapter.finishLaunchBinding?.(sessionName);

    // 5. Notify subscribers (best-effort, after commit)
    this.eventBus.notifySubscribers(persistedEvent);

    // 6. Fetch the created session + binding for the caller
    const sessions = this.sessionRegistry.getSessionsForRig(rigId);
    const session = sessions.find((s) => s.id === createdSessionId);
    const binding = this.sessionRegistry.getBindingForNode(node.id);

    return {
      ok: true,
      sessionName,
      session: session!,
      binding: binding!,
      warnings: launchWarnings.length > 0 ? launchWarnings : undefined,
    };
  }
}

function compactEnv(input: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" && value.length > 0) result[key] = value;
  }
  return result;
}
