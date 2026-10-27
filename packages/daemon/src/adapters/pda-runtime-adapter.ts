// pda runtime L2a (pda-runtime-design-9l Rev 2): the RuntimeAdapter for `runtime: pda`.
//
// Bounded contexts. OpenRig's seat (node, occupant, binding, resume token, readiness) drives ONE pda agent, a
// named conversation pda owns. This adapter is OpenRig-side only: it types the pda-runner command into the seat's
// pane and reads the runner's sidecar. It never calls pda, never holds the pda bearer (the runner reads pda's
// token file itself, D1), and never creates, resets or forks an agent. The anti-corruption layer that speaks pda
// is the runner's `pda-client.ts`.
//
// Contract choices, each one site:
//   - launch: `node <entry> <buildPdaRunnerArgv(...)>`, the token file as a PATH, `--usage-facts` only while
//     usage.pda_cost_facts is on. The binding is the resume token's when one is given (restore resumes the
//     token's agent, D2), else the spec's (`NodeBinding.pda`). No binding = refused before any keystroke.
//   - one pda agent per seat: a launch or restore is refused, before any keystroke, while another seat holds the
//     binding (`reserveBinding`, review L2b I-2b / action 3, and OF-96). Both launch and restore come through here.
//   - readiness: the runner's launch-scoped sidecar plus its READY marker, never pane heuristics, and never while
//     the pane is back at a shell.
//   - outcomes, one rule: what only a person can fix is `attention_required` (the agent is missing, pda refuses the
//     token, the token file is unusable, a held message, the runner stopped itself); what may pass by itself is a
//     plain failure (pda unreachable past the launch wait). Never `retry_fresh`: a pda seat has no fresh start.
//   - `freshStart: "unsupported"`, `startupContent: "withhold"` (D4): nothing is projected or delivered.
//   - `sendReadiness`: the sidecar, null (never a throw) when it is absent, stale, unparseable or not ready.

import nodePath from "node:path";
import { randomUUID } from "node:crypto";
import type { TmuxAdapter } from "./tmux.js";
import { shellQuote } from "./shell-quote.js";
import type {
  RuntimeAdapter, NodeBinding, ResolvedStartupFile, InstalledResource, ProjectionResult, StartupDeliveryResult,
  ReadinessResult, HarnessLaunchResult, ForkSource, RunnerReadinessTarget,
} from "../domain/runtime-adapter.js";
import { RUNNER_PASTE_OPEN_REASON } from "../domain/runtime-adapter.js";
import type { ProjectionPlan } from "../domain/projection-planner.js";
import type { AgentActivity } from "../domain/types.js";
import { PDA_USAGE_CLOSE_BUDGET_MS } from "./pda-usage-sink.js";
import { isShellForeground } from "../domain/shell-classifier.js";
import type { PdaLaunchReservation } from "../domain/pda-launch-reservations.js";
import {
  PDA_RESUME_TYPE, PDA_RUNTIME, PDA_RUNNER_ERROR_MARKER, PDA_RUNNER_EXIT_MARKER, PDA_RUNNER_READY_MARKER,
  PDA_SIDECAR_ALIVE_WINDOW_MS, buildPdaRunnerArgv, formatPdaResumeToken, parsePdaResumeToken, parsePdaRunnerLock,
  parsePdaRunnerState, pdaRunnerLockLive, pdaSeatPaths, pdaSidecarAlive, processPidAlive,
  type PdaBinding, type PdaRunnerLock, type PdaRunnerState,
} from "./pda-runner-protocol.js";

// The alive rule and its window live in the protocol (the runner applies them to its own lock too); re-exported here
// because the adapter's readers and tests have always imported them from this module.
export { PDA_SIDECAR_ALIVE_WINDOW_MS, pdaSidecarAlive };
/** How long a launch waits for the runner to attach (design: "The launch wait is 30 s"). */
export const PDA_LAUNCH_WAIT_MS = 30_000;

/** How long a launch waits for the PREVIOUS runner of the same seat to finish closing (OF-98): the usage sink's
 *  5 s close budget plus 2 s for the spill's fsyncs and the process teardown. */
export const PDA_OLD_RUNNER_WAIT_MS = PDA_USAGE_CLOSE_BUDGET_MS + 2000;

/** What one launch learned about its runner, for the claim's release rule (OF-112). */
interface LaunchProgress {
  /** A runner is, or may be, in the seat's pane: this launch typed the runner command (even if the send then threw), or it
   *  found the previous launch's runner still alive. From here a failed launch can leave a runner driving the agent. */
  runnerInPane: boolean;
  /** The runner is known to have stopped driving the target agent (it exited itself, or it runs another binding). */
  runnerStopped: boolean;
}

export interface PdaAdapterFsOps {
  readFile(path: string): string;
  exists(path: string): boolean;
  /** lstat: null when absent. The daemon only lstats pda's token file; it never opens it (D1). */
  lstat(path: string): { isFile: boolean } | null;
}

export interface PdaRuntimeAdapterDeps {
  tmux: Pick<TmuxAdapter, "sendShellCommand" | "hasSession" | "getPaneCommand" | "capturePaneContent">;
  fsOps: PdaAdapterFsOps;
  /** <OPENRIG_HOME>/state/pda: every pda seat's runner state dir is <stateRoot>/<sessionName>. */
  stateRoot: string;
  /** Absolute path to the compiled pda-runner entry in the daemon dist. */
  runnerEntryPath: string;
  /** pda's token file, resolved at each launch ($OPENRIG_PDA_TOKEN_FILE, default ~/.pi-durable/token). A path only. */
  tokenFile: () => string;
  /** usage.pda_cost_facts, read at each launch (absent = off). */
  usageFactsEnabled?: () => boolean;
  /** Why this binding may not be launched for this seat (another seat holds it; review L2b action 3), and, when it
   *  may, the claim on the agent (OF-96): check AND claim in one synchronous step (RigRepository.reservePdaLaunch), so
   *  two launches that both found the agent free cannot both pass. The claim is held while the launch runs; `failed()`
   *  frees it, `launched()` hands it to the seat's recorded token, and `heldWhileRunnerLives(gone)` keeps it after a
   *  failed launch whose runner may still be retrying, until `gone()` says the runner is (OF-112). */
  reserveBinding?: (binding: PdaBinding, nodeId: string) => { ok: true; reservation: PdaLaunchReservation } | { ok: false; conflicts: string[] };
  newLaunchId?: () => string;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  launchWaitMs?: number;
  /** Is this pid a live process? Default: signal 0 (EPERM counts as alive). */
  pidAlive?: (pid: number) => boolean;
  /** How long to wait for a previous runner's `runner.lock` to clear (default PDA_OLD_RUNNER_WAIT_MS). */
  oldRunnerWaitMs?: number;
}

/** What the runner's exit code means for a launch (pda-runner.ts header). */
const EXIT_TEXT: Record<number, string> = {
  2: "the runner refused its arguments",
  3: "pda has no such agent (OpenRig never creates one). Create it in pda, or re-instantiate the seat on another agent; the runner has exited and nothing retries by itself, so once the agent exists, then run: rig up <rig> --existing",
  4: "pda's token file is not usable (check $OPENRIG_PDA_TOKEN_FILE or ~/.pi-durable/token: a regular file, yours, mode 0600)",
  5: "the seat's message log could not be opened (fix or move it while the seat is down)",
  6: "another runner already holds this seat (its runner.lock names a live process); stop that one first",
  70: "the runner stopped on an internal error",
};

/** Sidecar codes that need a person, as checkReady reports them (ATTENTION_REQUIRED_READINESS_CODES holds each). */
function sidecarAttentionCode(state: PdaRunnerState): "pda_agent_missing" | "pda_token_format" | "pda_unauthorized" | "pda_message_held" | null {
  if (state.held) return state.held.code;
  const code = state.error?.code;
  return code === "pda_agent_missing" || code === "pda_token_format" || code === "pda_unauthorized" ? code : null;
}

export class PdaRuntimeAdapter implements RuntimeAdapter {
  readonly runtime = PDA_RUNTIME;
  readonly freshStart = "unsupported" as const;
  readonly startupContent = "withhold" as const;

  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly newLaunchId: () => string;

  /** <OPENRIG_HOME>/state/pda: the root under which each seat's runner state dir is <stateRoot>/<sessionName>. */
  get stateRoot(): string { return this.deps.stateRoot; }

  constructor(private readonly deps: PdaRuntimeAdapterDeps) {
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.newLaunchId = deps.newLaunchId ?? (() => randomUUID());
  }

  async listInstalled(_binding: NodeBinding): Promise<InstalledResource[]> {
    return [];
  }

  /** D4: nothing is projected into a pda seat. A non-empty plan is said, not silently dropped. */
  async project(plan: ProjectionPlan, _binding: NodeBinding): Promise<ProjectionResult> {
    const skipped = plan.entries.map((entry) => entry.effectiveId);
    return {
      projected: [], skipped, failed: [],
      ...(skipped.length > 0 ? { warnings: [`pda seat: ${skipped.length} projection entr${skipped.length === 1 ? "y was" : "ies were"} not applied; OpenRig delivers no startup content to a pda agent`] } : {}),
    };
  }

  /** D4: no startup file reaches a pda agent, required or not. Said once, never counted as delivered. */
  async deliverStartup(files: ResolvedStartupFile[], _binding: NodeBinding): Promise<StartupDeliveryResult> {
    return {
      delivered: 0, failed: [],
      ...(files.length > 0 ? { warnings: [`pda seat: ${files.length} startup file${files.length === 1 ? " was" : "s were"} withheld; OpenRig delivers no startup content to a pda agent`] } : {}),
    };
  }

  async launchHarness(binding: NodeBinding, opts: { name: string; resumeToken?: string; forkSource?: ForkSource }): Promise<HarnessLaunchResult> {
    const sessionName = binding.tmuxSession;
    if (!sessionName) return { ok: false, error: "No tmux session bound; cannot launch the pda-runner" };
    if (opts.forkSource) {
      return { ok: false, error: "A pda seat cannot fork: pda owns the conversation, and OpenRig never creates a pda agent." };
    }
    let target: PdaBinding;
    if (opts.resumeToken !== undefined) {
      const fromToken = parsePdaResumeToken(opts.resumeToken.trim());
      // Never echo the token: it names a binding, and the validator's contract is format errors only.
      if (!fromToken) return { ok: false, error: "pda resume: the resume token is not a pda agent token (http://127.0.0.1:<port>/agents/<agent>)" };
      target = fromToken;
    } else if (binding.pda) {
      target = binding.pda;
    } else {
      return { ok: false, error: "pda launch: this seat has no readable pda binding (its spec's pda block is missing or its saved binding is damaged); nothing was started" };
    }

    const taken = this.deps.reserveBinding?.(target, binding.nodeId);
    if (taken && !taken.ok) {
      return { ok: false, error: `pda launch refused before anything was typed: ${taken.conflicts.join("; ")}` };
    }
    const reservation = taken?.reservation;
    // OF-96 review F3: NOTHING may sit between the reservation above and this `try`. An in-flight claim has no lease, so
    // a statement here that threw (or an early return) would leak the claim until the daemon restarts. New checks belong
    // before the reservation, or inside launchOnto, where the `finally` covers them.
    const progress: LaunchProgress = { runnerInPane: false, runnerStopped: false };
    let launchedOk = false;
    try {
      const result = await this.launchOnto(sessionName, target, progress);
      launchedOk = result.ok;
      return result;
    } finally {
      // The claim never outlives a launch that did not start a runner (a throw is a failure too). But once the runner
      // was typed, a failed launch is not the runner's end: a timeout and the attention outcomes say "the runner keeps
      // retrying in the pane" (OF-112, Jim: hold the claim until the pane is confirmed gone), so the claim stays until
      // the seat's runner.lock names no live process. A runner that stopped itself is gone: nothing to wait for.
      if (launchedOk) reservation?.launched();
      else if (progress.runnerInPane && !progress.runnerStopped) reservation?.heldWhileRunnerLives(() => !this.runnerStillThere(sessionName));
      else reservation?.failed();
    }
  }

  /** Is the seat's runner process still there? True while `runner.lock` names a live process (the one rule, see
   *  pdaRunnerLockLive). Fail closed: a lock that cannot be read counts as a runner still there, since the claim this
   *  guards is the only thing between a second seat and the agent. Absent or unparseable lock = gone (the runner writes
   *  it first thing; after the launch wait, no lock means no runner was ever started). */
  private runnerStillThere(sessionName: string): boolean {
    try { return this.liveRunnerLock(sessionName) !== null; } catch { return true; }
  }

  /** The seat's `runner.lock` when its runner is still there, else null. Throws when the files cannot be read. */
  private liveRunnerLock(sessionName: string): PdaRunnerLock | null {
    const lockPath = pdaSeatPaths(this.deps.stateRoot, sessionName).runnerLockPath;
    if (!this.deps.fsOps.exists(lockPath)) return null;
    const lock = parsePdaRunnerLock(this.deps.fsOps.readFile(lockPath));
    if (!lock) return null;
    return pdaRunnerLockLive(lock, this.readState(sessionName), this.now().getTime(), this.deps.pidAlive ?? processPidAlive) ? lock : null;
  }

  /** OF-109: the pda agent the seat's LIVE runner is attached to, from the runner's own sidecar (the truth), or null when
   *  there is no live runner, it has begun to exit, or its sidecar is not that of the locked launch (nothing is known yet).
   *  The database can name another agent (an operator may set a resume token after the runner launched elsewhere), so the
   *  holder checks ask this too. Never throws. A lock that exists but cannot be read answers "unknown" (fail closed, as the
   *  claim's probe does): the seat may be driving any agent. */
  runnerAttachedTo(sessionName: string): PdaBinding | "unknown" | null {
    try {
      const lock = this.liveRunnerLock(sessionName);
      const state = lock ? this.readState(sessionName) : null;
      if (!lock || !state || state.launchId !== lock.launchId || state.exited) return null;
      return { agent: state.agent, baseUrl: state.baseUrl };
    } catch { return "unknown"; }
  }

  private async launchOnto(sessionName: string, target: PdaBinding, progress: LaunchProgress): Promise<HarnessLaunchResult> {
    const tokenFile = this.deps.tokenFile();
    const token = this.deps.fsOps.lstat(tokenFile);
    if (!token || !token.isFile) {
      return {
        ok: false, recovery: "attention_required",
        error: `pda launch: pda's token file ${token ? "is not a regular file" : "does not exist"} at ${tokenFile} (set OPENRIG_PDA_TOKEN_FILE, or start pda once so it writes ~/.pi-durable/token); nothing was started`,
      };
    }

    // OF-98: never type while the seat's previous runner can still write the spill or the outbox.
    const previous = await this.awaitPreviousRunner(sessionName);
    if (previous) {
      // A runner of this seat IS in the pane (the previous launch's, which may have held the same claim): this refusal
      // must not release what that launch kept (OF-112).
      progress.runnerInPane = true;
      return { ok: false, error: `pda launch: the seat's previous runner (pid ${previous.pid}, runner.lock in the seat's state directory) is still running after ${(this.deps.oldRunnerWaitMs ?? PDA_OLD_RUNNER_WAIT_MS) / 1000} s; nothing was typed, so its pending usage facts and messages are safe. Try again in a moment` };
    }

    const launchId = this.newLaunchId();
    const argv = buildPdaRunnerArgv({
      sessionName, stateRoot: this.deps.stateRoot, launchId, binding: target, tokenFile,
      usageFacts: this.deps.usageFactsEnabled?.() === true,
    });
    // Flags are fixed literals; every value is quoted. The argv holds no secret (the token file is a path).
    const command = ["node", shellQuote(this.deps.runnerEntryPath), ...argv.map((arg) => /^--[a-z-]+$/.test(arg) ? arg : shellQuote(arg))].join(" ");
    // From here a runner may exist (even when the send throws half way): the claim's release rule is the runner's lock.
    progress.runnerInPane = true;
    const sent = await this.deps.tmux.sendShellCommand(sessionName, command, undefined, { stageIfLong: true, execInScript: true });
    if (!sent.ok) {
      progress.runnerInPane = false; // the send said it typed nothing
      return { ok: false, error: `Failed to send the pda-runner command: ${sent.message}` };
    }

    const waited = await this.waitForLaunch(sessionName, launchId, target, progress);
    if (!waited.ok) return waited.failure;
    return { ok: true, resumeToken: formatPdaResumeToken(target), resumeType: PDA_RESUME_TYPE };
  }

  async checkReady(binding: NodeBinding): Promise<ReadinessResult> {
    const sessionName = binding.tmuxSession;
    if (!sessionName) return { ready: false, reason: "No tmux session bound" };
    if (!(await this.deps.tmux.hasSession(sessionName))) return { ready: false, reason: "tmux session not responsive" };
    // A sidecar or a READY line can outlive the runner: neither counts while the pane is back at a shell.
    const atShell = isShellForeground((await this.deps.tmux.getPaneCommand(sessionName)) ?? "");
    const state = this.readState(sessionName);
    if (state) {
      const attention = sidecarAttentionCode(state);
      if (state.exited) {
        return attention
          ? { ready: false, reason: `pda-runner exited: ${attention}`, code: attention }
          : { ready: false, reason: `pda-runner exited (code ${state.exited.code ?? "unknown"})`, code: "runner_exited" };
      }
      // Review N3: the same alive window as sendReadiness. A ready sidecar left by a runner killed without an `exited`
      // record is not readiness, even while the pane shows another process.
      if (!pdaSidecarAlive(state, this.now().getTime())) {
        return { ready: false, reason: `pda-runner sidecar has had no alive tick for over ${PDA_SIDECAR_ALIVE_WINDOW_MS / 1000} s (the runner is gone or hung)`, code: "runner_stale" };
      }
      if (attention) return { ready: false, reason: `pda-runner needs a person: ${attention}`, code: attention };
      if (state.ready) {
        return atShell
          ? { ready: false, reason: "pda-runner sidecar says ready but the pane is back at a shell (runner process gone)", code: "runner_exited" }
          : { ready: true };
      }
    }
    // The runner's own pane marker, as the secondary signal; still never pda's output, and the same shell guard.
    const pane = (await this.deps.tmux.capturePaneContent(sessionName, 40)) ?? "";
    const lastExit = pane.lastIndexOf(PDA_RUNNER_EXIT_MARKER);
    const lastError = pane.lastIndexOf(PDA_RUNNER_ERROR_MARKER);
    const lastReady = pane.lastIndexOf(PDA_RUNNER_READY_MARKER);
    if (lastExit > lastReady) return { ready: false, reason: "pda-runner exited", code: "runner_exited" };
    if (lastError > lastReady) return { ready: false, reason: "pda-runner reported an error in the pane", code: "runner_error" };
    if (lastReady >= 0) {
      return atShell
        ? { ready: false, reason: "READY marker is stale scrollback; the pane is back at a shell", code: "runner_exited" }
        : { ready: true };
    }
    return { ready: false, reason: "pda-runner has not reported ready yet", code: "awaiting_runtime" };
  }

  /** The runner's answer for `rig send`, or null for "no runner answer" (absent, stale, unparseable, not ready,
   *  exited). Never throws. The transport applies the shell-foreground clause at the seam. */
  async sendReadiness(target: RunnerReadinessTarget): Promise<AgentActivity | null> {
    let state: PdaRunnerState | null;
    try { state = this.readState(target.sessionName); } catch { return null; }
    if (!state || !state.ready || state.exited) return null;
    const nowMs = this.now().getTime();
    if (!pdaSidecarAlive(state, nowMs)) return null;
    const base = { evidenceSource: "runner_sidecar" as const, sampledAt: new Date(nowMs).toISOString(), evidence: null, runtime: PDA_RUNTIME };
    if (state.held) return { ...base, state: "needs_input", reason: state.held.code };
    // OF-148: an unclosed paste holds the pane input (after the alive window above; a held message keeps its own answer).
    if (state.pasteOpen === true) return { ...base, state: "needs_input", reason: RUNNER_PASTE_OPEN_REASON };
    if (!state.connected) return { ...base, state: "unknown", reason: "pda_disconnected" };
    if (state.busy) return { ...base, state: "running", reason: "run_active" };
    return { ...base, state: "idle", reason: "runner_idle" };
  }

  // ── internals ──

  /** Null when absent or unparseable. A read error is "no answer" too. */
  private readState(sessionName: string): PdaRunnerState | null {
    const { runnerStatePath } = pdaSeatPaths(this.deps.stateRoot, sessionName);
    try {
      if (!this.deps.fsOps.exists(runnerStatePath)) return null;
      return parsePdaRunnerState(this.deps.fsOps.readFile(runnerStatePath));
    } catch {
      return null;
    }
  }

  /** The previous runner's lock if it is still live after the bounded wait, else null (no lock, a stale one, or it cleared).
   *  Stale = its pid is dead (a SIGKILL skips the release), or its sidecar for that launch has not ticked inside
   *  the alive window (a reused pid). Never throws. */
  private async awaitPreviousRunner(sessionName: string): Promise<{ pid: number } | null> {
    const pollMs = Math.max(this.deps.pollMs ?? 250, 1);
    const attempts = Math.floor((this.deps.oldRunnerWaitMs ?? PDA_OLD_RUNNER_WAIT_MS) / pollMs) + 1;
    let live: { pid: number } | null = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      live = null;
      try {
        const lock = this.liveRunnerLock(sessionName);
        if (!lock) return null;
        live = { pid: lock.pid };
      } catch { return null; }
      if (attempt < attempts - 1) await this.sleep(pollMs);
    }
    return live;
  }

  /** Poll THIS launch's sidecar (stale ones from an earlier runner are ignored by launch id). */
  private async waitForLaunch(sessionName: string, launchId: string, target: PdaBinding, progress: LaunchProgress): Promise<{ ok: true } | { ok: false; failure: HarnessLaunchResult }> {
    const pollMs = this.deps.pollMs ?? 250;
    const attempts = Math.max(1, Math.floor((this.deps.launchWaitMs ?? PDA_LAUNCH_WAIT_MS) / Math.max(pollMs, 1)) + 1);
    let last: PdaRunnerState | null = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const state = this.readState(sessionName);
      if (state?.launchId === launchId) {
        last = state;
        if (state.agent !== target.agent || state.baseUrl !== target.baseUrl) {
          progress.runnerStopped = true; // it is not on the agent this claim is for (its own agent is held by runnerAttachedTo)
          return { ok: false, failure: { ok: false, error: "pda launch: the runner reports another binding than the one launched" } };
        }
        if (state.exited) {
          progress.runnerStopped = true; // it stopped itself: it no longer drives the agent, whatever its close still writes
          const code = state.exited.code ?? -1;
          return { ok: false, failure: {
            ok: false, recovery: "attention_required",
            error: `pda launch: the runner stopped (code ${state.exited.code ?? "unknown"}): ${EXIT_TEXT[code] ?? "see the pane"}`,
            evidence: await this.paneTail(sessionName),
          } };
        }
        if (state.ready) return { ok: true }; // a held head is reported by checkReady after the launch (attention)
        const attention = state.error?.code === "pda_unauthorized" || state.error?.code === "pda_token_format" ? state.error.code : null;
        if (attention) {
          // The runner keeps retrying; a person fixes the cause and the seat attaches by itself.
          return { ok: false, failure: {
            ok: false, recovery: "attention_required",
            error: `pda launch: ${attention === "pda_unauthorized" ? "pda refused the token" : attention}; the runner keeps retrying until it is fixed`,
            evidence: await this.paneTail(sessionName),
          } };
        }
      }
      if (attempt < attempts - 1) await this.sleep(pollMs);
    }
    const why = last?.error?.code === "pda_unreachable" ? "pda is unreachable" : last ? "the runner has not attached" : "the runner never reported";
    return { ok: false, failure: { ok: false, error: `pda launch: timed out waiting for the runner to attach (${why}); the runner keeps retrying in the pane` } };
  }

  private async paneTail(sessionName: string): Promise<string> {
    try {
      return ((await this.deps.tmux.capturePaneContent(sessionName, 40)) ?? "").split("\n").slice(-12).join("\n");
    } catch {
      return "";
    }
  }
}

/** pda's token file as the daemon resolves it (`$OPENRIG_PDA_TOKEN_FILE`, default `$HOME/.pi-durable/token`, pda
 *  `main.mjs:17, 26`). A path only. */
export function resolvePdaTokenFile(env: Readonly<Record<string, string | undefined>>, homeDir: string): string {
  const configured = env.OPENRIG_PDA_TOKEN_FILE?.trim();
  return configured && configured.length > 0 ? configured : nodePath.join(homeDir, ".pi-durable", "token");
}
