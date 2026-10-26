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
import type { ProjectionPlan } from "../domain/projection-planner.js";
import type { AgentActivity } from "../domain/types.js";
import { isShellForeground } from "../domain/shell-classifier.js";
import {
  PDA_RESUME_TYPE, PDA_RUNTIME, PDA_RUNNER_ERROR_MARKER, PDA_RUNNER_EXIT_MARKER, PDA_RUNNER_READY_MARKER,
  buildPdaRunnerArgv, formatPdaResumeToken, parsePdaResumeToken, parsePdaRunnerState, pdaSeatPaths,
  type PdaBinding, type PdaRunnerState,
} from "./pda-runner-protocol.js";

/** A sidecar whose `aliveAt` is older than this is no runner answer (the runner rewrites it every 60 s). */
export const PDA_SIDECAR_ALIVE_WINDOW_MS = 180_000;
/** How long a launch waits for the runner to attach (design: "The launch wait is 30 s"). */
export const PDA_LAUNCH_WAIT_MS = 30_000;

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
   *  frees it, `launched()` hands it to the seat's recorded token. */
  reserveBinding?: (binding: PdaBinding, nodeId: string) => { ok: true; reservation: { launched(): void; failed(): void } } | { ok: false; conflicts: string[] };
  newLaunchId?: () => string;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  launchWaitMs?: number;
}

/** What the runner's exit code means for a launch (pda-runner.ts header). */
const EXIT_TEXT: Record<number, string> = {
  2: "the runner refused its arguments",
  3: "pda has no such agent (OpenRig never creates one). Create it in pda, or re-instantiate the seat on another agent; the runner has exited and nothing retries by itself, so once the agent exists, then run: rig up <rig> --existing",
  4: "pda's token file is not usable (check $OPENRIG_PDA_TOKEN_FILE or ~/.pi-durable/token: a regular file, yours, mode 0600)",
  5: "the seat's message log could not be opened (fix or move it while the seat is down)",
  70: "the runner stopped on an internal error",
};

/** The ONE alive rule both readers apply (review N2, N3): a sidecar is the runner's word only while its aliveAt is
 *  within the window on either side of now. The runner rewrites it at least every 60 s; one older than the window was
 *  left by a runner that died (SIGKILL writes no `exited`), and one from the future is a clock jump or a forged file. */
export function pdaSidecarAlive(state: PdaRunnerState, nowMs: number): boolean {
  const alive = Date.parse(state.aliveAt);
  return Number.isFinite(alive) && Math.abs(nowMs - alive) <= PDA_SIDECAR_ALIVE_WINDOW_MS;
}

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
    let launchedOk = false;
    try {
      const result = await this.launchOnto(sessionName, target);
      launchedOk = result.ok;
      return result;
    } finally {
      // A throw is a failure too: the claim must never outlive a launch that did not start the runner.
      if (launchedOk) reservation?.launched(); else reservation?.failed();
    }
  }

  private async launchOnto(sessionName: string, target: PdaBinding): Promise<HarnessLaunchResult> {
    const tokenFile = this.deps.tokenFile();
    const token = this.deps.fsOps.lstat(tokenFile);
    if (!token || !token.isFile) {
      return {
        ok: false, recovery: "attention_required",
        error: `pda launch: pda's token file ${token ? "is not a regular file" : "does not exist"} at ${tokenFile} (set OPENRIG_PDA_TOKEN_FILE, or start pda once so it writes ~/.pi-durable/token); nothing was started`,
      };
    }

    const launchId = this.newLaunchId();
    const argv = buildPdaRunnerArgv({
      sessionName, stateRoot: this.deps.stateRoot, launchId, binding: target, tokenFile,
      usageFacts: this.deps.usageFactsEnabled?.() === true,
    });
    // Flags are fixed literals; every value is quoted. The argv holds no secret (the token file is a path).
    const command = ["node", shellQuote(this.deps.runnerEntryPath), ...argv.map((arg) => /^--[a-z-]+$/.test(arg) ? arg : shellQuote(arg))].join(" ");
    const sent = await this.deps.tmux.sendShellCommand(sessionName, command, undefined, { stageIfLong: true, execInScript: true });
    if (!sent.ok) return { ok: false, error: `Failed to send the pda-runner command: ${sent.message}` };

    const waited = await this.waitForLaunch(sessionName, launchId, target);
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

  /** Poll THIS launch's sidecar (stale ones from an earlier runner are ignored by launch id). */
  private async waitForLaunch(sessionName: string, launchId: string, target: PdaBinding): Promise<{ ok: true } | { ok: false; failure: HarnessLaunchResult }> {
    const pollMs = this.deps.pollMs ?? 250;
    const attempts = Math.max(1, Math.floor((this.deps.launchWaitMs ?? PDA_LAUNCH_WAIT_MS) / Math.max(pollMs, 1)) + 1);
    let last: PdaRunnerState | null = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const state = this.readState(sessionName);
      if (state?.launchId === launchId) {
        last = state;
        if (state.agent !== target.agent || state.baseUrl !== target.baseUrl) {
          return { ok: false, failure: { ok: false, error: "pda launch: the runner reports another binding than the one launched" } };
        }
        if (state.exited) {
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
