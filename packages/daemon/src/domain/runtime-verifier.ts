import type Database from "better-sqlite3";
import { ulid } from "ulid";
import type { ExecFn } from "../adapters/tmux.js";
import { ProbeTimeoutError } from "../adapters/bounded-probe-exec.js";
import type { RuntimeVerification, RuntimeStatus } from "./bootstrap-types.js";
import { HC_GENERATION, HcClient, HcError, HcOutcomeUnknownError, HcUnavailableError, type HcHello } from "../adapters/hc-client.js";

/** The hc release this build is tested against. A core upgrade is a tested release step, so the pin is exact. The CLI
 *  keeps its own copy (cli/src/tmux-health.ts), which it cannot import from here. */
export const HC_PINNED_VERSION = "0.1.15";

interface RuntimeVerifierDeps {
  exec: ExecFn;
  db: Database.Database;
  /** Runs the `--version` / `--help` probes (default: exec). The daemon passes boundedProbeExec, so a hung
   *  runtime binary is ended after a bound instead of holding up startup or bootstrap. */
  probeExec?: ExecFn;
  /** One `hello` to the hc core's socket (default: a client on the core's real socket). It must never start a core. */
  hcHello?: () => Promise<HcHello>;
}

/** What a probe that didn't answer within its bound records: status "error" with what happened. The binary
 *  exists but hangs, so it isn't "not found", and after a `--version` timeout `--help` isn't tried (it would
 *  usually hang too, doubling the wait). */
export function probeTimeoutOutcome(
  _binary: string,
  _probe: "version" | "help",
  timeout: ProbeTimeoutError,
): { fallBackToHelp: true } | { status: RuntimeStatus; error: string } {
  return { status: "error", error: timeout.message };
}

// OPR.0.4.6.PI1 — Pi's documented Node engine floor (package.json engines).
export const PI_NODE_ENGINE_FLOOR = "22.19.0";

export function meetsPiNodeEngineFloor(version: string): boolean {
  const parts = version.replace(/^v/, "").split(".").map((p) => parseInt(p, 10));
  const floor = PI_NODE_ENGINE_FLOOR.split(".").map((p) => parseInt(p, 10));
  for (let i = 0; i < floor.length; i++) {
    const have = parts[i] ?? 0;
    const need = floor[i]!;
    if (have > need) return true;
    if (have < need) return false;
  }
  return true;
}

/**
 * Verifies runtimes are usable — not just present on PATH.
 * Persists results to runtime_verifications table automatically.
 */
export class RuntimeVerifier {
  readonly db: Database.Database;
  private exec: ExecFn;
  private probeExec: ExecFn;
  private hcHello: () => Promise<HcHello>;

  constructor(deps: RuntimeVerifierDeps) {
    this.db = deps.db;
    this.exec = deps.exec;
    this.probeExec = deps.probeExec ?? deps.exec;
    this.hcHello = deps.hcHello ?? (() => new HcClient().hello());
  }

  /**
   * Verify the seat host: hc is installed (`hc --version`, which starts no core), is the pinned version, and the
   * running core, read over its socket, speaks this build's protocol generation. The record is kept under the runtime
   * name "hc". No core running is "degraded", not a failure: nothing here starts one, and a seat launch will say so.
   */
  async verifyHc(): Promise<RuntimeVerification> {
    const result = await this.runProbe("hc", async () => {
      let output: string;
      try {
        output = await this.probeExec("hc --version");
      } catch (err) {
        if (err instanceof ProbeTimeoutError) {
          const outcome = probeTimeoutOutcome("hc", "version", err);
          if (!("fallBackToHelp" in outcome)) return { status: outcome.status, version: null, capabilitiesJson: null, error: outcome.error };
        }
        throw err;  // runProbe records not_found
      }
      const version = this.parseVersion(output);
      if (!version) {
        return { status: "error" as RuntimeStatus, version: null, capabilitiesJson: null, error: "unparseable version output" };
      }
      if (version !== HC_PINNED_VERSION) {
        return { status: "error" as RuntimeStatus, version, capabilitiesJson: null, error: `hc ${version} is installed; OpenRig is pinned to hc ${HC_PINNED_VERSION}` };
      }
      let hello: HcHello;
      try {
        hello = await this.hcHello();
      } catch (err) {
        if (err instanceof HcUnavailableError) {
          return { status: "degraded" as RuntimeStatus, version, capabilitiesJson: null, error: "no hc core is running" };
        }
        if (err instanceof HcError && err.kind === "unsupported_generation") {
          return { status: "error" as RuntimeStatus, version, capabilitiesJson: null, error: `the hc core refused generation ${HC_GENERATION}: ${err.message}` };
        }
        if (err instanceof HcError || err instanceof HcOutcomeUnknownError) {
          return { status: "error" as RuntimeStatus, version, capabilitiesJson: null, error: `the hc core could not be read: ${err.message}` };
        }
        throw err;
      }
      if (hello.generation !== HC_GENERATION) {
        return { status: "error" as RuntimeStatus, version, capabilitiesJson: null, error: `the hc core speaks generation ${hello.generation}, this build ${HC_GENERATION}` };
      }
      if (hello.version !== HC_PINNED_VERSION) {
        return { status: "error" as RuntimeStatus, version, capabilitiesJson: null, error: `the running hc core is ${hello.version}; OpenRig is pinned to hc ${HC_PINNED_VERSION}` };
      }
      return { status: "verified" as RuntimeStatus, version, capabilitiesJson: JSON.stringify({ generation: hello.generation, coreVersion: hello.version }), error: null };
    });
    this.persist(result);
    return result;
  }

  /** Verify Claude Code: `claude --version`, fallback to `claude --help`. */
  async verifyClaude(): Promise<RuntimeVerification> {
    const result = await this.verifyVersionOrHelp("claude", "claude-code");
    this.persist(result);
    return result;
  }

  /** Verify Codex: `codex --version`, fallback to `codex --help`. */
  async verifyCodex(): Promise<RuntimeVerification> {
    const result = await this.verifyVersionOrHelp("codex", "codex");
    this.persist(result);
    return result;
  }

  /** OPR.0.4.6.PI1 FR-1 — Verify Pi: `pi --version` (fallback `pi --help`)
   *  plus the Node engine floor Pi requires (>= 22.19.0). Provider/model
   *  resolvability is member-scoped and verified at launch, not here. */
  async verifyPi(): Promise<RuntimeVerification> {
    let result = await this.verifyVersionOrHelp("pi", "pi");
    if (result.status === "verified") {
      try {
        const nodeVersion = this.parseVersion(await this.exec("node --version"));
        if (nodeVersion && !meetsPiNodeEngineFloor(nodeVersion)) {
          result = this.buildVerification(
            "pi",
            "error",
            result.version,
            null,
            `Pi requires Node >= ${PI_NODE_ENGINE_FLOOR}; found ${nodeVersion}. Upgrade Node to run pi seats.`,
          );
        }
      } catch {
        // `node` unresolvable from the daemon's exec context — leave the
        // binary verification standing; the engine floor re-checks at launch.
      }
    }
    this.persist(result);
    return result;
  }

  /** OMP is an independent executable; do not inherit Pi's Node engine check. */
  async verifyOmp(): Promise<RuntimeVerification> {
    const result = await this.verifyVersionOrHelp("omp", "omp");
    this.persist(result);
    return result;
  }

  /**
   * Verify multiple runtimes. Returns results in input order.
   * @param runtimes - canonical runtime names: 'hc', 'claude-code', 'codex', 'pi', 'omp'
   */
  async verifyAll(runtimes: string[]): Promise<RuntimeVerification[]> {
    const results: RuntimeVerification[] = [];
    for (const runtime of runtimes) {
      switch (runtime) {
        case "hc":
        // "tmux" is the name bootstrap-orchestrator still asks for; the seat host it means is hc now.
        case "tmux": results.push(await this.verifyHc()); break;
        case "claude-code": results.push(await this.verifyClaude()); break;
        case "codex": results.push(await this.verifyCodex()); break;
        case "pi": results.push(await this.verifyPi()); break;
        case "omp": results.push(await this.verifyOmp()); break;
        default: {
          const v = this.buildVerification(runtime, "not_found", null, null, `unknown runtime: ${runtime}`);
          this.persist(v);
          results.push(v);
        }
      }
    }
    return results;
  }

  /**
   * Shared helper: try `{binary} --version`, fall back to `{binary} --help`.
   * Used by verifyClaude and verifyCodex.
   */
  private async verifyVersionOrHelp(binary: string, canonicalName: string): Promise<RuntimeVerification> {
    // Try --version first
    try {
      const output = await this.probeExec(`${binary} --version`);
      const version = this.parseVersion(output);
      return this.buildVerification(canonicalName, "verified", version ?? null, null, null);
    } catch (err) {
      if (err instanceof ProbeTimeoutError) {
        const outcome = probeTimeoutOutcome(binary, "version", err);
        if (!("fallBackToHelp" in outcome)) return this.buildVerification(canonicalName, outcome.status, null, null, outcome.error);
      }
      // Fall back to --help
      try {
        await this.probeExec(`${binary} --help`);
        return this.buildVerification(canonicalName, "verified", null, null, null);
      } catch (helpErr) {
        if (helpErr instanceof ProbeTimeoutError) {
          const outcome = probeTimeoutOutcome(binary, "help", helpErr);
          if (!("fallBackToHelp" in outcome)) return this.buildVerification(canonicalName, outcome.status, null, null, outcome.error);
        }
        return this.buildVerification(canonicalName, "not_found", null, null, `${binary} not found`);
      }
    }
  }

  /**
   * Run a probe with error handling. On exec failure, returns failStatus (default: not_found).
   */
  private async runProbe(
    runtime: string,
    fn: () => Promise<{ status: RuntimeStatus; version: string | null; capabilitiesJson: string | null; error: string | null }>,
    failStatus: RuntimeStatus = "not_found",
  ): Promise<RuntimeVerification> {
    try {
      const { status, version, capabilitiesJson, error } = await fn();
      return this.buildVerification(runtime, status, version, capabilitiesJson, error);
    } catch (err) {
      return this.buildVerification(runtime, failStatus, null, null, (err as Error).message);
    }
  }

  private buildVerification(
    runtime: string,
    status: RuntimeStatus,
    version: string | null,
    capabilitiesJson: string | null,
    error: string | null,
  ): RuntimeVerification {
    return {
      id: ulid(),
      runtime,
      version,
      capabilitiesJson,
      verifiedAt: new Date().toISOString(),
      status,
      error,
    };
  }

  /** Parse a semver-like version from output (e.g. "hc 0.1.15" -> "0.1.15"). */
  private parseVersion(output: string): string | undefined {
    const match = output.match(/(\d+\.\d+(?:\.\d+)?(?:[a-z])?)/);
    return match?.[1];
  }

  /** Persist verification to runtime_verifications table. Upserts by runtime name. */
  private persist(v: RuntimeVerification): void {
    const existing = this.db
      .prepare("SELECT id FROM runtime_verifications WHERE runtime = ?")
      .get(v.runtime) as { id: string } | undefined;

    if (existing) {
      this.db.prepare(
        "UPDATE runtime_verifications SET version = ?, capabilities_json = ?, verified_at = ?, status = ?, error = ? WHERE runtime = ?"
      ).run(v.version, v.capabilitiesJson, v.verifiedAt, v.status, v.error, v.runtime);
      v.id = existing.id;
    } else {
      this.db.prepare(
        "INSERT INTO runtime_verifications (id, runtime, version, capabilities_json, verified_at, status, error) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(v.id, v.runtime, v.version, v.capabilitiesJson, v.verifiedAt, v.status, v.error);
    }
  }
}
