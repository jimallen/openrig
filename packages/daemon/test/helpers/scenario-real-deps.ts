/**
 * Slice 51-02 (L2 test-system) — the REAL-DEPS adapter.
 *
 * Binds the dumb runner core (scenario-runner.ts) to a LIVE scenario-local daemon:
 *   • runAction — maps each action verb to the SHIPPED `rig … --json` invocation
 *     (product-is-truth transport), run as a real subprocess against the daemon.
 *   • observe   — reads a shipped surface via readSurface (bound to the daemon).
 *   • the `daemon` verb drives the scenario-local daemon LIFECYCLE (sigterm/restart)
 *     directly — it is the test harness's own daemon, not a rig subprocess.
 *
 * Verb → shipped `rig` command (traced at 13e26355):
 *   up            → rig up <topology> --json --yes         (captures rigId/rigName)
 *   send          → rig send <to> <text> --json
 *   restart <seat>→ rig launch <rigId> <seat> --json       (seat relaunch/resume;
 *                                                            there is no top-level
 *                                                            `restart` command)
 *   down          → rig down <rigName|rigId> --json --force
 *   daemon {op}   → the ScenarioDaemon lifecycle (sigterm | restart)
 *
 * seed_regression calls an explicitly supplied test fault controller. With no
 * controller it fails loud; a declaration alone never counts as a seeded test.
 * restore/emit/mutate/policy have NO shipped runtime binding at v1
 * (they ride 51-03 / A5 items 6-8) — the adapter FAILS LOUD with a named
 * UnboundActionError rather than fabricating a call (same floor as the FLAG-1
 * `proof` surface: unbound is never silently-skipped).
 *
 * `rigBin` is injected (the single 51-04 container-mode seam); `runRig` is injected
 * so the verb→argv MAPPING is unit-testable without a live daemon.
 */

import { resolve } from "node:path";
import { runRig as realRunRig, type RigResult, type ScenarioDaemon } from "./scenario-daemon.js";
import { readSurface, sendTuiDrill } from "./scenario-surfaces.js";
import type { ExpectSurface } from "./scenario-schema.js";
import type { ScenarioRunnerDeps, ActionResult } from "./scenario-runner.js";
import type { RunRecord } from "./scenario-run-record.js";

// workspaces-o9o.132: the error lives with the runner core, which turns it into a HEALTHY_ONLY or NOT_RUN verdict; re-exported here for the
// callers that already import it from this adapter.
export { UnboundActionError } from "./scenario-runner.js";
import { UnboundActionError } from "./scenario-runner.js";

/** Why each verb is unbound in host mode, so a NOT RUN or HEALTHY-ONLY report names it (workspaces-o9o.132). */
const UNBOUND_REASONS: Record<string, string> = {
  seed_regression: "host mode has no seed controller; CI arms it",
  emit: "a step-time emit has no binding (ROUTING R-01): the stub runner has no input channel (no stdin reader, no socket, no route), " +
    "so behaviors run only from the launch script it reads at boot; declare env.stub_scripts to deliver a per-seat launch script instead",
  mutate: "no binding at v1 for a structural edit (test-system README, Run status honesty)",
  policy: "no binding at v1 for a policy step (test-system README, Run status honesty)",
  restore: "no binding at v1 for a step-time restore (test-system README, Run status honesty)",
};
const unbound = (verb: string): UnboundActionError => new UnboundActionError(verb, UNBOUND_REASONS[verb] ?? "no binding at v1");

/** The subset of a live ScenarioDaemon the adapter needs (readEnv + lifecycle). */
export type RealDepsDaemon = Pick<ScenarioDaemon, "readEnv" | "baseUrl" | "sigterm" | "restart">;

export interface RealDepsOptions {
  daemon: RealDepsDaemon;
  /** Path to the shipped `rig` bin (the single 51-04 injectable invocation seam). */
  rigBin: string;
  /** Resolved rig-spec path for the `up` verb (the scenario's `topology`). */
  topologyPath: string;
  /**
   * Scratch working directory passed to `rig up --cwd` so a seat's `cwd: "."`
   * resolves under the hermetic scaffold (its managed-file writes — AGENTS.md,
   * the stub readiness sidecar — never pollute the launch cwd). Omitted → the
   * shipped default (the daemon's cwd).
   */
  seatCwd?: string;
  /** Injected `rig` runner (defaults to the real subprocess runner; tests inject a spy). */
  runRig?: (
    args: string[],
    env: Record<string, string | undefined>,
    rigBin: string,
    timeoutMs?: number,
  ) => Promise<RigResult>;
  /** Injected scenario-local clock (ms) for the poll bound. Defaults to Date.now. */
  now?: () => number;
  /** Injected sleep between polls. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Optional run-record sink. */
  appendRecord?: (rec: RunRecord) => void;
  /** The single default within/poll pair. */
  defaults?: { withinMs: number; pollIntervalMs: number };
  /** The v1 runner-internal normalizer seam for the `equals` mode (lock amendment
   *  A-N1: runner-internal interface of record; the DECLARATIVE artifact remains
   *  the only scenario-facing form, rides 51-03, and lowers to this seam). */
  normalizer?: (surface: ExpectSurface, value: unknown) => unknown;
  /** The mission scope reads audit (D3) — threaded from the scenario's
   *  env.scope_mission into `rig scope audit --mission <name> --json`. */
  scopeMission?: string;
  /** Arm a named, scenario-local test fault (or explicitly record its healthy
   * control). The paired harness owns injection timing and verifies the actual
   * failing observation; this must never invoke a production `rig` command. */
  seedRegression?: (regressionClass: string) => Promise<ActionResult>;
  /** workspaces-o9o.132 (ROUTING R-12): the scenario file's folder, which a per-step `up: {topology: <path>}` is relative to. Host mode
   *  without staged scripts passes it; where it is absent (staged or container topologies) a per-step topology fails loud. */
  scenarioDir?: string;
}

/** `rig up` is heavy (real tmux seat launch) — give it a generous ceiling. */
const UP_TIMEOUT_MS = 120_000;

const fail = (stderr: string): ActionResult => ({ code: 1, stdout: "", stderr });

/** Build the live ScenarioRunnerDeps for the dumb runner core. */
export function buildRealDeps(opts: RealDepsOptions): ScenarioRunnerDeps {
  const { daemon, rigBin, topologyPath } = opts;
  const runRig = opts.runRig ?? realRunRig;

  // Captured from the `up` result so down/restart target the real rig (never fabricated).
  let rigId: string | undefined;
  let rigName: string | undefined;
  // workspaces-o9o.132 (R-12): the further rigs a per-step `up: {topology}` brought up, in order. `down` stops them too, latest first, so a
  // second rig never outlives the scenario; `restart` keeps targeting the scenario's own rig.
  const extraRigs: string[] = [];

  const runAction = async (verb: string, payload: unknown, seat?: string): Promise<ActionResult> => {
    switch (verb) {
      case "up": {
        const stepTopology = payload && typeof payload === "object" ? (payload as { topology?: unknown }).topology : undefined;
        if (stepTopology !== undefined) {
          if (!opts.scenarioDir) {
            return fail("up: a per-step topology is relative to the scenario file, and this run has no scenario folder to resolve it " +
              "against (a staged or container topology); run the scenario in host mode without env.stub_scripts");
          }
          const extraArgs = ["up", resolve(opts.scenarioDir, stepTopology as string), "--json", "--yes"];
          if (opts.seatCwd) extraArgs.push("--cwd", opts.seatCwd);
          const r = await runRig(extraArgs, daemon.readEnv, rigBin, UP_TIMEOUT_MS);
          try {
            const j = JSON.parse(r.stdout) as Record<string, unknown>;
            const rig = (j.rig as Record<string, unknown> | undefined) ?? undefined;
            const name = (j.rigName as string) ?? (rig?.name as string) ?? (j.rigId as string) ?? (rig?.id as string);
            if (name) extraRigs.push(name);
          } catch { /* non-JSON up output: the rig is not tracked, and its down will not run */ }
          return r;
        }
        const upArgs = ["up", topologyPath, "--json", "--yes"];
        if (opts.seatCwd) upArgs.push("--cwd", opts.seatCwd);
        const r = await runRig(upArgs, daemon.readEnv, rigBin, UP_TIMEOUT_MS);
        // workspaces-o9o.29: a failed up (a seat that never became ready) still created its rig, so its ids are
        // captured too, when its output names them, and a later `down` stops what it started.
        try {
          const j = JSON.parse(r.stdout) as Record<string, unknown>;
          const rig = (j.rig as Record<string, unknown> | undefined) ?? undefined;
          rigId = (j.rigId as string) ?? (rig?.id as string) ?? rigId;
          rigName = (j.rigName as string) ?? (rig?.name as string) ?? rigName;
        } catch {
          /* non-JSON up output — leave the rig ids uncaptured; down/restart will fail loud */
        }
        return r;
      }
      case "send": {
        const p = (payload && typeof payload === "object" ? payload : {}) as { to?: string; text?: string };
        const to = p.to ?? seat;
        const text = p.text ?? "";
        if (!to) return fail("send: no recipient (payload.to or a seat is required)");
        return runRig(["send", to, text, "--json"], daemon.readEnv, rigBin);
      }
      case "restart": {
        // Seat relaunch/resume — rig launch <rigId> <seat>. Distinct from the
        // `daemon` verb (which restarts the scenario-local DAEMON, not a seat).
        const node = typeof payload === "string" ? payload : seat;
        const target = rigId ?? rigName;
        if (!target) return fail("restart: no rig brought up yet (no rigId/rigName captured from `up`)");
        if (!node) return fail("restart: no seat named (restart <seat>)");
        return runRig(["launch", target, node, "--json"], daemon.readEnv, rigBin);
      }
      case "down": {
        const target = rigName ?? rigId;
        if (!target) return fail("down: no rig brought up yet (no rigId/rigName captured from `up`)");
        // R-12: the further rigs first, latest first; the first failure is the result.
        for (const extra of [...extraRigs].reverse()) {
          const r = await runRig(["down", extra, "--json", "--force"], daemon.readEnv, rigBin);
          if (r.code !== 0) return r;
        }
        extraRigs.length = 0;
        return runRig(["down", target, "--json", "--force"], daemon.readEnv, rigBin);
      }
      case "daemon": {
        const op = (payload && typeof payload === "object" ? (payload as { op?: string }).op : undefined);
        if (op === "sigterm") { await daemon.sigterm(); return { code: 0, stdout: "", stderr: "" }; }
        if (op === "restart") { await daemon.restart(); return { code: 0, stdout: "", stderr: "" }; }
        return fail(`daemon: unknown op ${JSON.stringify(op)} (allowed: sigterm, restart)`);
      }
      case "tui": {
        // workspaces-o9o.172: one drill line to the scenario's TUI socket (sendTuiDrill re-checks the payload); never the rig CLI.
        try {
          const reply = await sendTuiDrill(daemon.readEnv, payload);
          const accepted = !!reply && typeof reply === "object" && (reply as { ok?: unknown }).ok === true;
          return accepted ? { code: 0, stdout: JSON.stringify(reply), stderr: "" }
            : fail(`tui: the TUI did not accept the line: ${JSON.stringify(reply)}`);
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      }
      case "seed_regression": {
        const regressionClass = payload && typeof payload === "object"
          ? (payload as { class?: unknown }).class : undefined;
        if (typeof regressionClass !== "string" || regressionClass.length === 0) {
          return fail("seed_regression: a non-empty class is required");
        }
        if (!opts.seedRegression) throw unbound(verb);
        return opts.seedRegression(regressionClass);
      }
      default:
        // restore / emit / mutate / policy — no shipped binding at v1.
        throw unbound(verb);
    }
  };

  const observe = (surface: ExpectSurface, o: { seat?: string; since?: number }): Promise<unknown> =>
    readSurface(
      surface,
      { rigBin, readEnv: daemon.readEnv, baseUrl: daemon.baseUrl },
      { seat: o.seat, scopeMission: opts.scopeMission, ...(o.since !== undefined ? { since: o.since } : {}) },
    );

  return {
    runAction,
    observe,
    now: opts.now ?? (() => Date.now()),
    sleep: opts.sleep ?? ((ms: number) => new Promise((res) => setTimeout(res, ms))),
    appendRecord: opts.appendRecord,
    defaults: opts.defaults ?? { withinMs: 15_000, pollIntervalMs: 250 },
    normalizer: opts.normalizer,
  };
}
