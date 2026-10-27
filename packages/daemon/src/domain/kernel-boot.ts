// V0.3.1 slice 05 kernel-rig-as-default — kernel auto-boot path.
//
// Composes into rig daemon start per IMPL-PRD §6.1: probes runtime
// auth state, selects a variant (dual / claude-only / codex-only),
// and fires the in-process bootstrap pipeline IN THE BACKGROUND.
// Short-circuits cleanly when:
//   - OPENRIG_NO_KERNEL=1 is set (operator opt-out / test fixture)
//   - A managed rig named `kernel` already exists in the DB
//   - Both runtimes are unauthenticated (auth_blocked terminal state)
//   - The selected variant's spec file is missing
//
// Forward-fix #3 architectural amendment (IMPL-PRD §16 amended):
// The bootstrap promise is NOT awaited. KernelBootTracker is returned
// immediately so createDaemon can finish + server.ts can bind healthz.
// A broken kernel agent therefore can no longer keep the daemon's HTTP
// surface from starting — operators see "daemon ready; kernel <state>"
// rather than "daemon failed to start".

import nodePath from "node:path";
import os from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";
import type { RigRepository } from "./rig-repository.js";
import type { BootstrapOrchestrator } from "./bootstrap-orchestrator.js";
import type { EventBus } from "./event-bus.js";
import type { SessionRegistry } from "./session-registry.js";
import { KernelBootTracker } from "./kernel-boot-tracker.js";
import { RigSpecCodec } from "./rigspec-codec.js";

export type RuntimeAuthStatus = "ok" | "unavailable";

export interface RuntimeProbeResult {
  claudeCode: RuntimeAuthStatus;
  codex: RuntimeAuthStatus;
  /** How Claude Code reports it authenticates (`claude.ai`, `api_key`, `none`, ...), when its JSON status said so.
   *  Logged on boot so an API-billed kernel is visible. It never selects the variant: that is a product rule. */
  claudeAuthMethod?: string;
}

export interface KernelBootDeps {
  rigRepo: RigRepository;
  sessionRegistry: SessionRegistry;
  eventBus: EventBus;
  bootstrapOrchestrator: BootstrapOrchestrator;
  /** Absolute path to the daemon's specs dir (passed in so tests can
   *  inject a fixture root). Production callsite resolves to the
   *  packaged `packages/daemon/specs/` location. */
  specsDir: string;
  /** cwdOverride passed to BootstrapOrchestrator.bootstrap. Kernel
   *  members run against the operator's environment, not the daemon
   *  installation tree — without this override, the bootstrap path
   *  refuses with `cwd is inside the OpenRig installation`. Production
   *  callsite passes the resolved workspace.root setting; tests inject
   *  a fixture path. */
  cwdOverride: string;
  /** Runtime auth probe — defaults to live shellouts; tests inject. */
  probeRuntimes?: () => Promise<RuntimeProbeResult>;
  /** Logger sink; defaults to console.log/warn so daemon stdout/stderr
   *  carry the boot trace. */
  log?: (level: "info" | "warn" | "error", message: string) => void;
  /** Degraded-timer override (ms). Forward-fix #3 default 90s; tests
   *  pass short values to exercise the timer path quickly. */
  degradedTimeoutMs?: number;
}

/** Entry point. Idempotent: safe to call on every daemon startup.
 *  Returns the tracker immediately; bootstrap (if fired) runs in the
 *  background. Callers should NOT await the tracker's internal
 *  bootstrap promise — that's the whole point of the architectural
 *  decoupling. Tracker state is observable via getStatus() and the
 *  /api/kernel/status route. */
export async function bootKernelIfNeeded(deps: KernelBootDeps): Promise<KernelBootTracker> {
  const log = deps.log ?? defaultLog;
  const tracker = new KernelBootTracker({
    eventBus: deps.eventBus,
    sessionRegistry: deps.sessionRegistry,
    rigRepo: deps.rigRepo,
    degradedTimeoutMs: deps.degradedTimeoutMs,
  });

  // 1. --no-kernel opt-out (CLI flag projected via OPENRIG_NO_KERNEL).
  // VITEST env additionally short-circuits the live runtime probe
  // path so daemon-composition tests don't block 5s+ on shelled-out
  // claude/codex CLI calls — real production probes complete in
  // ~100ms; this is an explicit test-fast escape hatch so individual
  // test files don't each have to remember to set OPENRIG_NO_KERNEL=1.
  // The auto-skip is suppressed when deps.probeRuntimes is injected:
  // kernel-boot's own unit tests inject a fast deterministic probe
  // and explicitly want to exercise the full logic.
  const probeInjected = typeof deps.probeRuntimes === "function";
  if (process.env["OPENRIG_NO_KERNEL"] === "1" || (process.env["VITEST"] === "true" && !probeInjected)) {
    const reason = process.env["OPENRIG_NO_KERNEL"] === "1" ? "OPENRIG_NO_KERNEL=1" : "VITEST=true";
    log("info", `kernel-boot: ${reason} — skipping kernel auto-boot`);
    tracker.setSkipped(reason);
    return tracker;
  }

  // 2. Already-managed short-circuit. If a rig named `kernel` exists
  // (e.g., from a prior boot or operator-migrated substrate kernel),
  // the builtin path stays out of the way.
  if (kernelAlreadyManaged(deps.rigRepo)) {
    log("info", "kernel-boot: kernel rig already managed; skipping builtin boot");
    tracker.setSkipped("kernel rig already managed");
    return tracker;
  }

  // 3. Probe runtime auth state to pick a variant.
  const probe = await (deps.probeRuntimes ?? defaultProbeRuntimes)();

  if (probe.claudeCode === "unavailable" && probe.codex === "unavailable") {
    const msg = authBlockMessage();
    log("error", msg);
    tracker.setAuthBlocked(msg);
    return tracker;
  }

  const variant = selectVariant(probe);
  const specPath = nodePath.join(deps.specsDir, "rigs/launch/kernel", variant);

  if (!existsSync(specPath)) {
    log("warn", `kernel-boot: spec missing at ${specPath} — skipping`);
    tracker.setSpecMissing(specPath);
    return tracker;
  }

  // 4. Cold boot via the in-process bootstrap pipeline — FIRED, not awaited.
  const authNote = probe.claudeAuthMethod ? ` (claude authMethod: ${probe.claudeAuthMethod})` : "";
  log("info", `kernel-boot: booting kernel rig from ${variant}${authNote}`);
  // Jim, 2026-10-26: warn when the sign-in type can't be told apart, and (OF-61) when it is API-key billing.
  if (probe.claudeCode === "ok" && !probe.claudeAuthMethod) {
    log("warn", "kernel-boot: Claude is signed in but its sign-in type could not be read; subscription and API-key billing cannot be told apart");
  } else if (probe.claudeAuthMethod === "api_key") {
    log("warn", "kernel-boot: Claude is signed in with an API key, so Claude seats are billed per use");
  }
  const bootstrapPromise = deps.bootstrapOrchestrator.bootstrap({
    mode: "apply",
    sourceRef: specPath,
    sourceKind: "rig_spec",
    autoApprove: true,
    cwdOverride: deps.cwdOverride,
  });
  tracker.startBooting(variant, bootstrapPromise, expectedKernelSeats(specPath));
  return tracker;
}

/** The seats the selected kernel spec declares, as `pod.member` logical IDs, so a boot failure is treated as
 *  recovered only when every one of them is ready. null when the spec can't be read as pods with members: the
 *  tracker then keeps a failure current, because an unknown roster must never read as ready. */
export function expectedKernelSeats(specPath: string): string[] | null {
  try {
    const raw = RigSpecCodec.parse(readFileSync(specPath, "utf-8")) as { pods?: unknown } | null;
    if (!raw || !Array.isArray(raw.pods)) return null;
    const seats: string[] = [];
    for (const pod of raw.pods as Array<{ id?: unknown; members?: unknown } | null>) {
      if (typeof pod?.id !== "string" || !Array.isArray(pod.members)) return null;
      for (const member of pod.members as Array<{ id?: unknown } | null>) {
        if (typeof member?.id !== "string") return null;
        seats.push(`${pod.id}.${member.id}`);
      }
    }
    return seats.length > 0 ? seats : null;
  } catch {
    return null;
  }
}

/** True when a rig named `kernel` already exists in the DB. */
export function kernelAlreadyManaged(rigRepo: RigRepository): boolean {
  const rigs = rigRepo.listRigs();
  return rigs.some((r) => r.name === "kernel");
}

/** Choose a rig variant from the auth probe. */
export function selectVariant(probe: RuntimeProbeResult): string {
  if (probe.claudeCode === "ok" && probe.codex === "ok") return "rig.yaml";
  if (probe.claudeCode === "ok") return "rig-claude-only.yaml";
  if (probe.codex === "ok") return "rig-codex-only.yaml";
  // Caller is expected to short-circuit before reaching here on the
  // both-unavailable path; defensive default keeps the type narrow.
  return "rig.yaml";
}

/** Default auth probe — shells out to the runtime CLIs. */
export async function defaultProbeRuntimes(): Promise<RuntimeProbeResult> {
  const { exec } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execAsync = promisify(exec);

  async function runProbe(cmd: string): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    try {
      const { stdout, stderr } = await execAsync(cmd, { timeout: 5000 });
      return { stdout, stderr, exitCode: 0 };
    } catch (err) {
      // exec rejects on a non-zero exit, a timeout (killed, no numeric code) or a missing binary (string code).
      const e = err as { stdout?: unknown; stderr?: unknown; code?: unknown };
      return {
        stdout: typeof e.stdout === "string" ? e.stdout : "",
        stderr: typeof e.stderr === "string" ? e.stderr : "",
        exitCode: typeof e.code === "number" ? e.code : null,
      };
    }
  }

  async function tryProbe(cmd: string): Promise<RuntimeAuthStatus> {
    const result = await runProbe(cmd);
    return classifyTextAuthStatus(result);
  }

  async function probeClaude(): Promise<ClaudeAuthClassification> {
    return classifyClaudeAuthStatus(await runProbe("claude auth status"));
  }

  const codexHome = process.env.CODEX_HOME || nodePath.join(os.homedir(), ".codex");
  const [claude, codex] = await Promise.all([
    probeClaude(),
    probeCodexReadiness({
      run: tryProbe,
      readConfig: () => {
        try { return readFileSync(nodePath.join(codexHome, "config.toml"), "utf-8"); } catch { return null; }
      },
      env: process.env,
    }),
  ]);

  return {
    claudeCode: claude.status,
    codex,
    ...(claude.authMethod ? { claudeAuthMethod: claude.authMethod } : {}),
  };
}

export interface AuthProbeOutput {
  stdout: string;
  stderr: string;
  /** null when the command never produced one (timeout, missing binary). */
  exitCode: number | null;
}

export interface ClaudeAuthClassification {
  status: RuntimeAuthStatus;
  authMethod?: string;
}

/** Legacy text rule, shared by Codex and the Claude fallback. Conservative: any indicator the CLI considers itself
 *  unauthenticated marks the runtime unavailable. A non-zero or missing exit code is always unavailable. */
export function classifyTextAuthStatus(out: AuthProbeOutput): RuntimeAuthStatus {
  if (out.exitCode !== 0) return "unavailable";
  const text = `${out.stdout}\n${out.stderr}`.toLowerCase();
  if (text.includes("not logged") || text.includes("not authenticated") || text.includes("login required")) {
    return "unavailable";
  }
  return "ok";
}

/** Claude Code readiness from `claude auth status`. Claude Code 2.1.x prints JSON (`loggedIn`, `authMethod`) and
 *  exits 1 when logged out; older versions print prose. Rules, in order:
 *   1. A non-zero or missing exit code is unavailable, whatever was printed.
 *   2. JSON with a boolean `loggedIn` decides: false is unavailable even at exit 0, true is ok.
 *   3. Anything else falls back to the text rule.
 *  API-key auth (`authMethod: api_key`) counts as ok: the kernel boots, and the method is only reported so an
 *  API-billed kernel is visible. Choosing a variant by billing method is a product rule, not made here. */
export function classifyClaudeAuthStatus(out: AuthProbeOutput): ClaudeAuthClassification {
  const json = parseAuthStatusJson(out.stdout);
  const authMethod = json && typeof json.authMethod === "string" && /^[A-Za-z0-9._-]{1,32}$/.test(json.authMethod)
    ? json.authMethod
    : undefined;
  const withMethod = (status: RuntimeAuthStatus): ClaudeAuthClassification =>
    authMethod ? { status, authMethod } : { status };
  if (out.exitCode !== 0) return withMethod("unavailable");
  if (json && typeof json.loggedIn === "boolean") return withMethod(json.loggedIn ? "ok" : "unavailable");
  return withMethod(classifyTextAuthStatus(out));
}

function parseAuthStatusJson(stdout: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Issue #194 — how the Codex provider selected in `$CODEX_HOME/config.toml`
 *  authenticates. Only an explicit provider entry with
 *  `requires_openai_auth = false` and an `env_key` uses its credential
 *  variable. Everything else (no file, a parse error, a legacy top-level
 *  `profile`, a built-in or undeclared provider) keeps the OpenAI login check,
 *  so an unresolved config does not take the env-key shortcut; readiness still follows the login result. Other Codex config layers
 *  (project, system or managed config, requirements, `-c`, `--profile`) are not
 *  resolved here. The CLI's `rig setup` carries the same rule. */
export type CodexProviderAuth =
  | { kind: "openai-login"; unresolved?: string }
  | { kind: "env-key"; providerId: string; envKey: string };

export function selectCodexProviderAuth(configToml: string | null): CodexProviderAuth {
  if (configToml === null) return { kind: "openai-login" };
  let config: Record<string, unknown>;
  try {
    config = parseToml(configToml) as Record<string, unknown>;
  } catch {
    return { kind: "openai-login", unresolved: "config.toml could not be parsed" };
  }
  if (Object.hasOwn(config, "profile")) {
    return { kind: "openai-login", unresolved: "config.toml selects a legacy profile, which is not resolved here" };
  }
  const providerId = config["model_provider"];
  const providers = config["model_providers"];
  if (typeof providerId !== "string" || !providers || typeof providers !== "object" || !Object.hasOwn(providers, providerId)) {
    return { kind: "openai-login" };
  }
  const entry = (providers as Record<string, unknown>)[providerId];
  if (!entry || typeof entry !== "object") return { kind: "openai-login" };
  const { requires_openai_auth: requiresOpenAiAuth, env_key: envKey } = entry as Record<string, unknown>;
  if (requiresOpenAiAuth !== false || typeof envKey !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envKey)) {
    return { kind: "openai-login" };
  }
  return { kind: "env-key", providerId, envKey };
}

/** Codex half of the kernel runtime probe. An env-key provider is ready when
 *  its variable is nonblank and the executable answers; this is local
 *  credential availability, not a remote authentication or inference check. */
export async function probeCodexReadiness(deps: {
  run: (cmd: string) => Promise<RuntimeAuthStatus>;
  readConfig: () => string | null;
  env: Record<string, string | undefined>;
}): Promise<RuntimeAuthStatus> {
  const auth = selectCodexProviderAuth(deps.readConfig());
  if (auth.kind === "openai-login") return deps.run("codex login status");
  if (!deps.env[auth.envKey]?.trim()) return "unavailable";
  return deps.run("codex --version");
}

/** Honest 3-part-error message for the auth-block path. Per IMPL-PRD
 *  §6.3 + the building-agent-software skill discipline. */
export function authBlockMessage(): string {
  return [
    "Error: Kernel rig cannot boot — no AI runtime is authenticated.",
    "Reason: Kernel rig requires at least one of Claude Code or Codex authenticated. Both are unavailable.",
    "Fix: Run `claude auth login` to authenticate Claude Code, OR `codex login` to authenticate Codex. Then run `rig daemon start` (or `rig setup`) again.",
  ].join("\n");
}

function defaultLog(level: "info" | "warn" | "error", message: string): void {
  if (level === "error") console.error(message);
  else if (level === "warn") console.warn(message);
  else console.log(message);
}
