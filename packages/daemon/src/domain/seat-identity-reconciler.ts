import { observeClaudePaneProcess, observeClaudePaneRuntime, observeCodexPaneProcess, listNativeProcesses, type NativeProcessLister, type NativeProcessObservation } from "./native-process-lineage.js";
import { isShellForeground } from "./shell-classifier.js";
import { registeredPaneSql } from "./binding-pane.js";
import { claudeResumeRotation } from "./session-registry.js";
import { STARTUP_TEXT_WAIT_MS } from "./startup-orchestrator.js";
import { DEFAULT_READINESS_TIMEOUT_MS } from "./readiness-timeout.js";
import { RESUME_SETTLE_MS } from "./resume-settle.js";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { SeatIdentityVerdict } from "./types.js";
import { SeatIdentityStore, SelfHostIdentityStore } from "./seat-identity-store.js";
import { RESERVED_HOST_IDS, validateHostRegistry } from "./hosts/hosts-registry-reader.js";

/** Default identity-reconcile cadence: 5s. Process identity changes rarely
 *  (a seat's pane/process is stable for its whole life), and the check is
 *  more expensive than the 1Hz activity poll (per-seat pane PID + command
 *  tmux reads), so a slower cadence is the right cost/freshness trade. */
export const DEFAULT_IDENTITY_POLL_INTERVAL_MS = 5000;

/** OF-235: how long a lifecycle lease may excuse a seat's missing terminal, counted from the first poll that saw the lease held. A restore, `rig down` or
 *  handover holds its leases for the whole run and the terminal may be absent for all of it, so the excuse must outlast a long multi-seat restore; but a lease
 *  that is never released (a hung operation) must not hide a real loss for ever. The bound is
 *      LIFECYCLE_EXCUSE_BASE_MS + LIFECYCLE_EXCUSE_PER_SEAT_MS x (the lifecycle leases held at that poll, from the guard's lease table)
 *  and past it the seat falls back to the two-poll rule. The restore loop is sequential and holds every seat's lease from its start, so its length grows with
 *  the number of seats held: the per-seat term is the bound one seat's turn can wait, STARTUP_TEXT_WAIT_MS (5 min), so the laptop's 27 seats get 10 + 135 = 145 min.
 *  The base covers the work around the seat loop (snapshot, preflight, bookkeeping). OF-241 measured it: a rig down and restore of 27 stub seats on a private
 *  core (hc 0.1.17, Sparky; Sparky's hc was 0.1.17 from 14:34 on 2026-11-05) took 0.55 s and 0.42 s, with 27 leases held at once for 0.39 s, about 15 ms per seat of
 *  OpenRig's own work; the OF-241 review re-measured it there at 0.50 s down, 0.43 s restore and 0.38 s for the longest lease. A real agent's start-up is not in
 *  that number and is what the per-seat term is for. 10 min is a margin of more than a thousand over the measurement, not a measurement. Finite: a lease held
 *  for ever hides a loss for at most this bound plus two polls.
 *
 *  The per-seat term is one seat's whole turn of the sequential restore, read from StartupOrchestrator.startNode (OF-247 a; a bound from the code, with the timing
 *  pinned in startup-pump.test.ts): the readiness window (`runtime.readiness_timeout_seconds`, default 30 s, at most 600 s, resolved at each launch), then the
 *  resume settle (RESUME_SETTLE_MS, 2.5 s, a resumed seat only), then at most ONE startup text wait (STARTUP_TEXT_WAIT_MS, 5 min: the first send the seat's gate does not
 *  record latches `pumpStopped`, so later sends return at once). A seat whose readiness times out fails there and never reaches the text wait, so the terms add only
 *  for a seat that becomes ready just inside its window. Before OF-247 the term was the text wait alone, 32.5 s short of that turn at the default window and 10 min
 *  short at the largest. */
export const LIFECYCLE_EXCUSE_BASE_MS = 10 * 60_000;
/** The per-seat term at the default readiness window; the reconciler uses the window in force when `readinessTimeoutMs` is wired. */
export const LIFECYCLE_EXCUSE_PER_SEAT_MS = STARTUP_TEXT_WAIT_MS + RESUME_SETTLE_MS + DEFAULT_READINESS_TIMEOUT_MS;

/** Foreground commands that read as a bare shell (a seat that dropped to a
 *  prompt, or an orphan/QA-squat shell occupying the pane). Mirrors the
 *  SessionFingerprinter SHELL_NAMES vocabulary. `pane_current_command` may
 *  carry a login-shell `-` prefix. */
const SHELL_COMMANDS = new Set([
  "bash", "zsh", "fish", "sh", "dash", "tcsh", "csh",
  "-bash", "-zsh", "-fish", "-sh", "-dash", "-tcsh", "-csh",
]);

/**
 * Legacy short-command classifier. Codex callers additionally require the
 * shared native-process proof; this label alone is not positive Codex identity.
 *
 * Deliberately LENIENT to preserve the slice-15 no-false-green-for-live-seats
 * invariant: a genuinely-live claude/codex TUI usually reports its host
 * process (`node`) as `pane_current_command`, NOT the literal runtime name, so
 * we only declare `mismatch` on a POSITIVE contradiction — a different known
 * agent runtime, or a bare shell where an agent was expected (the process
 * died / an orphan shell squatted the pane). Ambiguous commands (`node`,
 * `python`, empty) never down-rank.
 *
 * Mirrors SessionFingerprinter's Layer-1 process-command vocabulary; we do NOT
 * run the full 4-layer scan (pane-content capture) per poll — it
 * is far more expensive at fleet scale and its content layer would not change
 * the down-rank decision here (the reconcile only needs to distinguish
 * "process contradicts the seat" from "no contradiction").
 */
export function classifyPaneRuntimeMatch(
  command: string | null,
  expectedRuntime: string | null,
): "match" | "mismatch" {
  if (!command) return "match"; // no signal — never false-mismatch a present pane
  const cmd = command.trim().toLowerCase();
  const expectsAgent = expectedRuntime === "claude-code" || expectedRuntime === "codex";

  // Positive same-runtime signal.
  if (expectedRuntime === "claude-code" && cmd.includes("claude")) return "match";
  if (expectedRuntime === "codex" && cmd.includes("codex")) return "match";

  // Cross-runtime contradiction (a DIFFERENT agent occupies the pane).
  if (expectedRuntime === "claude-code" && cmd.includes("codex")) return "mismatch";
  if (expectedRuntime === "codex" && cmd.includes("claude")) return "mismatch";

  // A bare shell where an agent runtime was expected — the agent process is
  // gone or an orphan/squat shell occupies the pane.
  if (expectsAgent && SHELL_COMMANDS.has(cmd)) return "mismatch";

  // Ambiguous / expected-shell (terminal nodes) — no contradiction.
  return "match";
}

interface RunningSeatRow {
  node_id: string;
  runtime: string | null;
  session_name: string;
  tmux_pane: string | null;
  resume_token?: string | null;
  resume_provenance?: string | null;
  resume_rotated_from?: string | null;
  resume_rotated_process?: string | null;
  resume_launch_process?: string | null;
}

type PaneObservation = { pid: number | null; command: string | null };

export interface SeatIdentityReconcilerDeps {
  db: Database.Database;
  tmux: Pick<TmuxAdapter, "listSessions" | "getPanePid" | "getPaneCommand"> & Partial<Pick<TmuxAdapter, "readAllPaneProcesses" | "listPanes" | "hostKind">>;
  now?: () => Date;
  listProcesses?: NativeProcessLister;
  /** OF-235: true while the delivery guard's lifecycle lease holds this seat (`SeatDeliveryGuard.lifecycleHeld`). Absent: no seat is ever excused. */
  lifecycleHeld?: (nodeId: string) => boolean;
  /** OF-235: how many seats the guard's lifecycle leases hold right now (`SeatDeliveryGuard.lifecycleHeldCount`); it scales the ceiling. Absent: one. */
  lifecycleHeldCount?: () => number;
  /** OF-247 (a): the readiness window in force (`resolveReadinessTimeoutMs`), read at a poll that finds a lease holding a seat. Absent: DEFAULT_READINESS_TIMEOUT_MS. */
  readinessTimeoutMs?: () => number;
  /** Overrides LIFECYCLE_EXCUSE_BASE_MS and the whole per-seat term (tests); a base given alone keeps the derived per-seat term. */
  lifecycleExcuse?: { baseMs: number; perSeatMs?: number };
}

/**
 * OPR.0.4.3.19 — periodic reconciler for the liveness identity verdict (the
 * THIRD axis). Mirrors SeatActivityService.start(): polls every running
 * tmux-bound managed seat, reconciles the current pane PID/command against the
 * registered seat, and persists the verdict to `seat_identity_verdicts`.
 * Projections then read the cheap persisted verdict synchronously.
 *
 * Non-inference: this reconciler reads ONLY tmux pane process identity vs the
 * registered binding. It NEVER reads queue/classifier/hook heartbeats, and it
 * does NOT touch `terminalActive` / `hasAssignedWork`.
 */
export class SeatIdentityReconciler {
  private readonly db: Database.Database;
  private readonly tmux: SeatIdentityReconcilerDeps["tmux"];
  private readonly now: () => Date;
  private readonly store: SeatIdentityStore;
  private readonly listProcesses: NativeProcessLister;
  private timer: ReturnType<typeof setInterval> | null = null;
  private reconciling = false;
  private generation = 0;
  /** OF-205 (b): the seats whose session read missing on the previous poll, with the session name read (a seat is lost only once two polls in a row say so). */
  private readonly missingSeen = new Map<string, string>();
  /** OF-235: per seat, the observation time (ms) of the first poll that found a lifecycle lease holding it; cleared by the first poll that does not. */
  private readonly heldSince = new Map<string, number>();
  private readonly lifecycleHeld: ((nodeId: string) => boolean) | undefined;
  private readonly lifecycleHeldCount: (() => number) | undefined;
  private readonly readinessTimeoutMs: (() => number) | undefined;
  private readonly excuseBaseMs: number;
  private readonly excusePerSeatMsOverride: number | undefined;

  constructor(deps: SeatIdentityReconcilerDeps) {
    this.db = deps.db;
    this.tmux = deps.tmux;
    this.now = deps.now ?? (() => new Date());
    this.store = new SeatIdentityStore(deps.db);
    this.listProcesses = deps.listProcesses ?? listNativeProcesses;
    this.lifecycleHeld = deps.lifecycleHeld;
    this.lifecycleHeldCount = deps.lifecycleHeldCount;
    this.excuseBaseMs = deps.lifecycleExcuse?.baseMs ?? LIFECYCLE_EXCUSE_BASE_MS;
    this.readinessTimeoutMs = deps.readinessTimeoutMs;
    this.excusePerSeatMsOverride = deps.lifecycleExcuse?.perSeatMs;
  }

  /** How long a lease holding `held` seats may excuse a missing terminal, counted from the first poll that saw it (OF-247 a: the per-seat term follows the readiness window in force). */
  excuseCeilingMs(held: number): number {
    const perSeat = this.excusePerSeatMsOverride ?? STARTUP_TEXT_WAIT_MS + RESUME_SETTLE_MS + (this.readinessTimeoutMs?.() ?? DEFAULT_READINESS_TIMEOUT_MS);
    return this.excuseBaseMs + perSeat * Math.max(1, held);
  }

  /** OF-235: a supported operation (stop, `rig down`, restart, handover, restore, launch) holds the seat's lifecycle lease from before it ends the
   *  terminal until after the new one is bound, however long that takes, so a terminal missing under the lease is the operation's doing, not a crash.
   *  True while the lease holds the seat and has held it for less than the ceiling; the clock is the sweep's own observation time. */
  private excusedByLifecycle(nodeId: string, observedMs: number): boolean {
    if (!this.lifecycleHeld?.(nodeId)) { this.heldSince.delete(nodeId); return false; }
    const since = this.heldSince.get(nodeId) ?? observedMs;
    this.heldSince.set(nodeId, since);
    return observedMs - since < this.excuseCeilingMs(this.lifecycleHeldCount?.() ?? 1);
  }

  private runningSeats(): RunningSeatRow[] {
    return this.db.prepare(`
      SELECT n.id as node_id, n.runtime as runtime,
             s.session_name as session_name, ${registeredPaneSql(this.db)} as tmux_pane, s.resume_token as resume_token,
             s.resume_provenance as resume_provenance,
             s.resume_rotated_from as resume_rotated_from,
             s.resume_rotated_process as resume_rotated_process,
             s.resume_launch_process as resume_launch_process
      FROM nodes n
      JOIN sessions s ON s.node_id = n.id
        AND s.id = (SELECT s2.id FROM sessions s2 WHERE s2.node_id = n.id ORDER BY s2.id DESC LIMIT 1)
      LEFT JOIN bindings b ON b.node_id = n.id
      WHERE s.status = 'running'
        AND s.session_name IS NOT NULL
        AND COALESCE(b.attachment_type, 'tmux') IN ('tmux', 'hc')
    `).all() as RunningSeatRow[];
  }

  /** Reconcile every running tmux-bound seat once and persist the verdicts. */
  async reconcileAll(): Promise<void> {
    // Skip ticks while actual reads are pending; never release on a deadline
    // that could leave subprocesses alive. Normal polling cost is unchanged.
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      await this.reconcileSweep(this.generation);
    } finally {
      this.reconciling = false;
    }
  }

  private async reconcileSweep(generation: number): Promise<void> {
    const seats = this.runningSeats();
    // Prune verdicts for nodes no longer running (keep the table bounded).
    this.store.pruneExcept(seats.map((s) => s.node_id));
    const running = new Set(seats.map((s) => s.node_id));
    for (const nodeId of [...this.missingSeen.keys()]) if (!running.has(nodeId)) this.missingSeen.delete(nodeId);
    for (const nodeId of [...this.heldSince.keys()]) if (!running.has(nodeId)) this.heldSince.delete(nodeId);
    if (seats.length === 0) return;

    const observedAt = this.now().toISOString();

    // One tmux availability probe per poll. If tmux is entirely unreachable
    // (throws) OR reports zero live sessions while we have running seats in
    // the DB, treat it as a transient tmux blip and record `tmux_unavailable`
    // for legacy runtimes. Codex remains non-green without native evidence.
    // OF-207: on hc an empty listing is an answer, not a blip. HcIdentity.listSessions
    // throws when the core cannot be reached (never the empty list a tmux server with
    // no sessions gives), so zero live terminals from a core that answered means every
    // running seat's terminal is gone: the sweep goes on and each seat reads
    // `session_missing`. Without this the last terminal of a core could never be lost.
    // OF-235: the leases are read before the listing as well as after it. A lease that held the seat when the core was asked excuses what the listing
    // shows even if the operation finished before the verdict is written (the listing may be from the middle of it).
    const observedMs = Date.parse(observedAt);
    const excusedAtListing = new Set(seats.filter((s) => this.excusedByLifecycle(s.node_id, observedMs)).map((s) => s.node_id));
    let liveSessions: Set<string> | null = null;
    try {
      const sessions = await this.tmux.listSessions();
      liveSessions = new Set(sessions.map((s) => s.name));
    } catch {
      liveSessions = null;
    }
    if (generation !== this.generation) return;
    if (liveSessions === null || (liveSessions.size === 0 && this.tmux.hostKind !== "hc")) {
      // A poll that could not look neither confirms nor refutes a missing session: the two polls must be consecutive.
      this.missingSeen.clear();
      for (const seat of seats) {
        this.store.upsert(this.tmuxUnavailableVerdict(seat, observedAt));
      }
      return;
    }

    const readPanes = async (): Promise<Map<string, PaneObservation>> => {
      try { return new Map(await this.tmux.readAllPaneProcesses?.() ?? []); }
      catch { return new Map(); }
    };
    let panes = await readPanes();
    if (generation !== this.generation) return;
    // Cache the per-pane fallback, including absent PIDs. Selection and verdict
    // share this observation; direct Claude seats need no additional subprocess.
    const readPane = async (target: string): Promise<PaneObservation> => {
      const existing = panes.get(target);
      if (existing) return existing;
      const pid = await this.tmux.getPanePid(target);
      const observed = { pid, command: pid === null ? null : await this.tmux.getPaneCommand(target) };
      panes.set(target, observed);
      return observed;
    };

    // Only wrapped Claude seats need native proof. Tokenless proof also needs
    // the sole-pane recheck below; do not sample when that capability is absent.
    const nativeSeats: RunningSeatRow[] = [];
    for (const seat of seats) {
      if (!seat.tmux_pane || !liveSessions.has(seat.session_name)) continue;
      if (seat.runtime === "codex") nativeSeats.push(seat);
      else if (seat.runtime === "claude-code" && (seat.resume_token != null || this.tmux.listPanes)) {
        try {
          let command: string | null;
          if (this.tmux.readAllPaneProcesses) {
            const observed = await readPane(seat.tmux_pane);
            if (observed.pid === null) continue;
            command = observed.command;
          } else {
            // Legacy adapters have no batch. Preserve their independent early
            // selection and final observation rather than caching an early label.
            command = await this.tmux.getPaneCommand(seat.tmux_pane);
          }
          if (classifyPaneRuntimeMatch(command, seat.runtime) === "mismatch"
            && isShellForeground(command?.trim().toLowerCase() ?? "")) nativeSeats.push(seat);
        } catch { /* No proof selected; the final per-seat observation still runs. */ }
        if (generation !== this.generation) return;
      }
    }
    const sample = async (observations: Map<string, PaneObservation>) => {
      let snapshot: ReturnType<NativeProcessLister> | undefined;
      // Two fresh process snapshots, each paired with its own pane observation.
      // The first uses the selection batch; the second starts after it settles.
      const tmux = Object.assign(Object.create(this.tmux) as typeof this.tmux, {
        getPanePid: async (target: string) => {
          const observed = observations.get(target);
          return observed ? observed.pid : this.tmux.getPanePid(target);
        },
      });
      return Promise.all(nativeSeats.map((seat) => (seat.runtime === "codex" ? observeCodexPaneProcess
        : seat.resume_token !== null && seat.resume_token !== undefined ? observeClaudePaneProcess : observeClaudePaneRuntime)({
        target: seat.tmux_pane!, tmux, expectedToken: seat.resume_token, rotation: claudeResumeRotation(seat),
        listProcesses: () => snapshot ??= this.listProcesses(),
      })));
    };
    const first = await sample(panes);
    if (generation !== this.generation) return;
    const second = nativeSeats.length > 0 ? await sample(await readPanes()) : [];
    if (generation !== this.generation) return;
    const nativeProofs = new Map(nativeSeats.map((seat, index) => [seat.node_id,
      first[index] && first[index]?.fingerprint === second[index]?.fingerprint ? second[index]! : null]));
    if (nativeSeats.length > 0) {
      // Native proof crossed awaits: final verdicts must not reuse the initial
      // command/PID (including a direct seat that became a shell meanwhile).
      panes = await readPanes();
      if (generation !== this.generation) return;
    }
    for (const seat of seats) {
      try {
        const verdict = await this.computeVerdict(seat, liveSessions, observedAt, nativeProofs.get(seat.node_id) ?? null, panes);
        if (generation !== this.generation) return;
        // OF-235: while a lifecycle lease holds the seat, a missing terminal is the operation's (a respawn, `rig down`, restart, handover or restore can
        // leave it absent for far longer than two polls). Nothing is recorded and no count is kept: the lease's end restarts the two-poll rule.
        const excused = this.excusedByLifecycle(seat.node_id, observedMs) || excusedAtListing.has(seat.node_id);
        if (excused && verdict.reason === "session_missing") {
          this.missingSeen.delete(seat.node_id);
          continue;
        }
        // OF-205 (b): a supported stop, restart, handover or restore ends the terminal a moment before the session row is written, and a poll inside that
        // moment reads `session_missing`, which rig health reports as `seat.lost` until the next poll replaces it. The first such read is not recorded
        // (the previous verdict stands); a second consecutive one is. A crashed seat is reported one poll later, never missed.
        if (verdict.reason === "session_missing") {
          if (this.missingSeen.get(seat.node_id) !== seat.session_name) {
            this.missingSeen.set(seat.node_id, seat.session_name);
            continue;
          }
        } else {
          this.missingSeen.delete(seat.node_id);
        }
        this.store.upsert(verdict);
      } catch {
        if (generation !== this.generation) return;
        this.missingSeen.delete(seat.node_id);
        // A single seat's tmux failure must not crash the loop; record it as
        // unavailable observation (non-green for Codex).
        this.store.upsert(this.tmuxUnavailableVerdict(seat, observedAt));
      }
    }
  }

  private tmuxUnavailableVerdict(seat: RunningSeatRow, observedAt: string): SeatIdentityVerdict {
    return {
      nodeId: seat.node_id,
      verdict: seat.runtime === "codex" ? "mismatch" : "tmux_unavailable",
      evidenceSource: null,
      reason: "tmux_unavailable",
      evidence: { registeredPane: seat.tmux_pane, observedPid: null, observedCommand: null, matchedLayer: null },
      sessionName: seat.session_name,
      observedAt,
    };
  }

  private async computeVerdict(
    seat: RunningSeatRow,
    liveSessions: Set<string>,
    observedAt: string,
    native: NativeProcessObservation | null,
    panes: Map<string, PaneObservation> | null = null,
  ): Promise<SeatIdentityVerdict> {
    const base = {
      nodeId: seat.node_id,
      sessionName: seat.session_name,
      observedAt,
    };

    // A null binding pane has two distinct causes. When the target session is
    // absent, that is a down-ranking missing-session fact. When it is live,
    // only the binding is absent: named, and non-green for Codex.
    if (!seat.tmux_pane) {
      if (!liveSessions.has(seat.session_name)) {
        return {
          ...base,
          verdict: "pane_missing",
          evidenceSource: "tmux_session",
          reason: "session_missing",
          evidence: { registeredPane: null, observedPid: null, observedCommand: null, matchedLayer: null },
        };
      }
      return {
        ...base,
        verdict: seat.runtime === "codex" ? "mismatch" : "binding_absent",
        evidenceSource: "tmux_session",
        reason: "binding_pane_missing",
        evidence: { registeredPane: null, observedPid: null, observedCommand: null, matchedLayer: null },
      };
    }

    // From the sweep's one batched list-panes when the pane is in it; otherwise read per pane as before.
    // OF-176: a seat whose session the sweep's listing lacks gets no per-pane read: it can only fail, and the verdict
    // below (session_missing) is the one that failure gives.
    const batched = panes?.get(seat.tmux_pane) ?? null;
    const pid = batched ? batched.pid : liveSessions.has(seat.session_name) ? await this.tmux.getPanePid(seat.tmux_pane) : null;
    if (pid === null) {
      // The registered pane no longer resolves. Distinguish "the whole tmux
      // session is gone" from "the pane within a live session is gone".
      const sessionAlive = liveSessions.has(seat.session_name);
      return {
        ...base,
        verdict: "pane_missing",
        evidenceSource: sessionAlive ? "pane_process" : "tmux_session",
        reason: sessionAlive ? "pane_pid_gone" : "session_missing",
        evidence: { registeredPane: seat.tmux_pane, observedPid: null, observedCommand: null, matchedLayer: null },
      };
    }

    const command = batched ? batched.command : await this.tmux.getPaneCommand(seat.tmux_pane);
    if (command === null && seat.runtime === "claude-code") {
      return this.tmuxUnavailableVerdict(seat, observedAt);
    }
    if (seat.runtime === "codex" || (seat.runtime === "claude-code" && (seat.resume_token != null || native !== null)
      && classifyPaneRuntimeMatch(command, seat.runtime) === "mismatch" && isShellForeground(command?.trim().toLowerCase() ?? ""))) {
      let verified = native?.panePid === pid;
      if (verified && seat.runtime === "claude-code" && seat.resume_token == null) {
        // Runtime-only proof must still refer to the sole bound pane after the
        // two shared process snapshots. It does not clear startup/restore state.
        const currentPanes = await this.tmux.listPanes?.(seat.session_name).catch(() => []);
        const currentPid = await this.tmux.getPanePid(seat.tmux_pane).catch(() => null);
        verified = currentPanes?.length === 1 && currentPanes[0]?.id === seat.tmux_pane && currentPid === pid;
      }
      return {
        ...base, verdict: verified ? "verified" : "mismatch",
        evidenceSource: "pane_process", reason: verified ? null : "process_identity_ambiguous",
        evidence: { registeredPane: seat.tmux_pane, observedPid: native?.process.pid ?? pid,
          observedCommand: native?.process.command ?? command, matchedLayer: verified ? 1 : null },
      };
    }
    const match = classifyPaneRuntimeMatch(command, seat.runtime);
    if (match === "mismatch") {
      return {
        ...base,
        verdict: "mismatch",
        evidenceSource: "pane_process",
        reason: "process_identity_mismatch",
        evidence: { registeredPane: seat.tmux_pane, observedPid: pid, observedCommand: command, matchedLayer: 1 },
      };
    }

    return {
      ...base,
      verdict: "verified",
      evidenceSource: "pane_process",
      reason: null,
      evidence: { registeredPane: seat.tmux_pane, observedPid: pid, observedCommand: command, matchedLayer: 1 },
    };
  }

  /** Start the scheduler. Idempotent — calling twice is a no-op. */
  start(intervalMs: number = DEFAULT_IDENTITY_POLL_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.reconcileAll();
    }, intervalMs);
    if (this.timer && typeof this.timer === "object" && "unref" in this.timer) {
      (this.timer as NodeJS.Timeout).unref();
    }
  }

  /** Stop the scheduler. Safe to call before start or multiple times. */
  stop(): void {
    // Fence old observations without releasing their flight before settlement.
    this.generation++;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

// ── 51-09 increment 1: durable daemon self-host identity ─────────────────────
// Co-located with the seat-identity substrate per arch ruling cb19867f (extend,
// do not invent a parallel identity lifecycle). Reconciled once AT BOOT.

/**
 * Reserved / non-identity host tokens that must NEVER become a self-host id: the
 * registry reserved set ({kernel, host, local}, hosts-registry-reader) plus the
 * bare display default "localhost" (host.name's default — display-only per DP4,
 * never an identity). Compared case-insensitively.
 */
export const RESERVED_SELF_HOST_SEEDS = new Set<string>([...RESERVED_HOST_IDS, "localhost"]);

function isReservedSeed(candidate: string): boolean {
  return RESERVED_SELF_HOST_SEEDS.has(candidate.trim().toLowerCase());
}

/**
 * Assert a self-host id is never empty and never a reserved/display token.
 * Throws (loud, fail-closed) if violated — the never-'local' invariant guard.
 */
export function assertNeverReservedHostId(hostId: string): void {
  const norm = hostId.trim().toLowerCase();
  if (!norm) {
    throw new Error("[self-host-identity] invariant: self-host id must be non-empty");
  }
  if (RESERVED_SELF_HOST_SEEDS.has(norm)) {
    throw new Error(
      `[self-host-identity] invariant: self-host id must never be a reserved/display token (got '${hostId}'; reserved: ${[...RESERVED_SELF_HOST_SEEDS].sort().join(", ")})`,
    );
  }
}

/**
 * Where a live self-host id CAME FROM, derived at read time — `named`, `generated`, or the honest
 * `indeterminate`.
 *
 * WHY DERIVED AND NOT READ: `self_host_identity` stores `host_id`, `minted_at`, `reconciled_at` and
 * NOTHING about provenance, so there is no record to consult. Recording it properly is a migration
 * and belongs with the population work, not here.
 *
 * `indeterminate` is load-bearing, not a cop-out. It is exactly the CONFLICT state the reconciler
 * already warns about: an operator sets `host.name` AFTER the id was minted, the reconciler keeps
 * the original id (a durable identity is never silently re-keyed), and from then on the configured
 * name and the live id disagree. Calling that `generated` would be a false claim about a machine
 * someone did name, and an unknown that reads as a known state is the whole defect this slice is
 * about.
 */
export type SelfHostIdSource = "named" | "generated" | "indeterminate";

const GENERATED_SELF_HOST_ID = /^host-[0-9a-f]{8}$/;

export function deriveSelfHostIdSource(
  hostId: string | null | undefined,
  hostNameCandidate: string | null | undefined,
): SelfHostIdSource | null {
  if (typeof hostId !== "string" || hostId.trim() === "") return null;
  // ADMISSIBILITY MUST MATCH THE MINT BRANCH EXACTLY, not merely "is it set".
  // `host.name` DEFAULTS to "localhost", which is a reserved display token the reconciler refuses as
  // a seed — so on a freshly generated host the candidate is present-but-unusable. Testing only for
  // presence reported `indeterminate` for the most ordinary machine there is: one nobody named.
  const candidate = normalizeCandidate(hostNameCandidate);
  const admissibleSeed =
    candidate !== null && !isReservedSeed(candidate) && isRegistryValidSelfId(candidate)
      ? candidate
      : null;

  // Seeded from the operator's name and still agreeing with it.
  if (admissibleSeed !== null && admissibleSeed === hostId) return "named";
  // Nobody usably named this machine and the id carries the generated shape: the retained generated-id fallback.
  if (admissibleSeed === null && GENERATED_SELF_HOST_ID.test(hostId)) return "generated";
  // An admissible name that DISAGREES (the conflict the reconciler keeps and warns about), or an id
  // whose shape fits neither story. Unprovable, and said so.
  return "indeterminate";
}

/** A collision-safe generated self-host id, used when no unambiguous operator seed exists. */
function generateSelfHostId(): string {
  return `host-${randomUUID().slice(0, 8)}`;
}

// ── 51-09 increment 2b: self-id ↔ registry-id ALIGNMENT (arch ruling dfa65bfc) ─
// Interpretation (ii): there is NO registry self-row (type-incoherent against the
// closed HostEntry union); the alignment property is that the minted self-host id
// must be a VALID, NON-RESERVED registry id so a REMOTE host can adopt it as a
// registry key (transport-carries-host). We REUSE the canonical registry-id
// validator (validateHostRegistry — the CLI/daemon lockstep twin, parity-pinned
// in hosts-registry-parity.test.ts) via a single-entry probe rather than a
// divergent copy of its rules (regex + reserved set). The probe fixes a valid
// transport/target so ONLY the id can fail — ok===false iff the id is invalid.

function isRegistryValidSelfId(id: string): boolean {
  return validateHostRegistry(
    { hosts: [{ id, transport: "ssh", target: "self-host-alignment-probe" }] },
    "<self-host-identity>",
  ).ok;
}

/**
 * 51-09 increment 2b — the FAIL-CLOSED registry-alignment assert. A durable
 * self-host id that is not a valid registry id could not be resolved by a remote
 * host as a key (transport-carries-host breaks), so it is a fatal boot
 * misconfiguration. Escalates increment 1's loud-conflict posture to a
 * fail-closed assert-on-boot for the registry-alignment case, per the ruling.
 */
export function assertSelfHostIdRegistryAligned(hostId: string): void {
  const probe = validateHostRegistry(
    { hosts: [{ id: hostId, transport: "ssh", target: "self-host-alignment-probe" }] },
    "<self-host-identity>",
  );
  if (!probe.ok) {
    throw new Error(
      `[self-host-identity] registry-alignment: self-host id '${hostId}' is not a valid registry id — remote hosts could not resolve it as a key. ${probe.error} Fix the operator host.name or drop the self-host record to re-key.`,
    );
  }
}

function normalizeCandidate(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export interface SelfHostReconcileResult {
  hostId: string;
  minted: boolean;
  /**
   * Populated (non-null) when a stored id already exists AND an operator
   * candidate (host.name) differs from it — the identity is NEVER silently
   * re-keyed; the stored id is kept and the conflict is surfaced loudly. This is
   * the general loud-conflict mechanism increment 2 reuses for self-id ↔
   * registry-id alignment.
   */
  conflict: { storedId: string; candidate: string } | null;
}

/**
 * 51-09 increment 1 — mint-or-reconcile the daemon's durable self-host id at
 * boot. First boot MINTS (seeding from an unambiguous operator host.name where
 * present, else a generated collision-safe id); every subsequent boot RECONCILES
 * (advances reconciled_at, keeps the id — restart ⇒ same id). host.name is a
 * DISPLAY-ONLY candidate seed (arch ruling cb19867f / DP4); a reserved/default
 * candidate is rejected in favour of a generated id. When a stored id exists and
 * the operator candidate now differs, the id is KEPT (never silent re-key) and a
 * LOUD conflict naming BOTH is surfaced.
 */
export function reconcileSelfHostIdentity(
  store: SelfHostIdentityStore,
  opts: { nowIso: string; hostNameCandidate?: string | null; log?: (message: string) => void },
): SelfHostReconcileResult {
  const log = opts.log ?? ((message: string) => console.error(message));
  const candidate = normalizeCandidate(opts.hostNameCandidate);
  const existing = store.get();

  if (existing) {
    store.touchReconciledAt(opts.nowIso);
    assertNeverReservedHostId(existing.hostId);
    // 51-09 incr 2b: fail-closed if the stored self-id is not a valid registry id
    // (a pre-2b-minted or DB-tampered id that a remote could not adopt as a key).
    assertSelfHostIdRegistryAligned(existing.hostId);
    let conflict: SelfHostReconcileResult["conflict"] = null;
    if (candidate && !isReservedSeed(candidate) && candidate !== existing.hostId) {
      conflict = { storedId: existing.hostId, candidate };
      log(
        `[self-host-identity] CONFLICT: operator host.name '${candidate}' differs from the minted self-host id '${existing.hostId}'. Keeping '${existing.hostId}' — a durable host identity is NEVER silently re-keyed. Re-key deliberately (drop the self-host record) or reconcile the display name.`,
      );
    }
    return { hostId: existing.hostId, minted: false, conflict };
  }

  // 51-09 incr 2b: a host.name seed is adopted ONLY when it is a valid registry id
  // (non-reserved via incr-1's case-insensitive guard AND registry-id-format valid),
  // so a format-invalid operator host.name falls back to a generated valid id
  // rather than minting an unusable, boot-bricking self-id.
  const seed =
    candidate && !isReservedSeed(candidate) && isRegistryValidSelfId(candidate)
      ? candidate
      : generateSelfHostId();
  assertNeverReservedHostId(seed);
  const record = store.mint(seed, opts.nowIso);
  // Belt: the minted id (adopted-valid or generated) is registry-aligned.
  assertSelfHostIdRegistryAligned(record.hostId);
  return { hostId: record.hostId, minted: true, conflict: null };
}
