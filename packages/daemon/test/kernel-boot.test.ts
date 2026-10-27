// V0.3.1 slice 05 kernel-rig-as-default — kernel auto-boot tests.
//
// Covers HG-2 (variant selection), HG-3 (auth-block 3-part error),
// HG-4 (already-managed short-circuit), HG-6 (--no-kernel flag via
// OPENRIG_NO_KERNEL env). Forward-fix #3 architectural amendment:
// bootKernelIfNeeded now returns a KernelBootTracker; the bootstrap
// runs in the background. Tests await microtasks to observe the
// post-bootstrap tracker state.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  bootKernelIfNeeded,
  expectedKernelSeats,
  selectVariant,
  kernelAlreadyManaged,
  authBlockMessage,
  probeCodexReadiness,
  selectCodexProviderAuth,
  classifyClaudeAuthStatus,
  defaultProbeRuntimes,
  type KernelBootDeps,
  type RuntimeAuthStatus,
} from "../src/domain/kernel-boot.js";
import type { RigRepository } from "../src/domain/rig-repository.js";
import type { BootstrapOrchestrator } from "../src/domain/bootstrap-orchestrator.js";
import type { SessionRegistry } from "../src/domain/session-registry.js";
import type { EventBus } from "../src/domain/event-bus.js";

function makeRigRepo(existingRigs: Array<{ id?: string; name: string }>): RigRepository {
  return {
    listRigs: () => existingRigs,
    findRigsByName: (name: string) => existingRigs.filter((r) => r.name === name),
    findUnarchivedRigsByName: (name: string) => existingRigs.filter((r) => r.name === name),
    getRig: () => null,
  } as unknown as RigRepository;
}

function makeSessionRegistry(sessionsByRig: Record<string, Array<{ sessionName: string; runtime?: string; startupStatus: string }>> = {}): SessionRegistry {
  return {
    getSessionsForRig: (rigId: string) => sessionsByRig[rigId] ?? [],
  } as unknown as SessionRegistry;
}

function makeEventBus(): { bus: EventBus; emitted: Array<{ type: string }> } {
  const emitted: Array<{ type: string }> = [];
  const bus = {
    emit: (event: { type: string }) => {
      emitted.push(event);
      return event;
    },
  } as unknown as EventBus;
  return { bus, emitted };
}

function makeBootstrapMock(result?: { errors?: string[]; throwError?: Error }) {
  return {
    bootstrap: vi.fn(async () => {
      if (result?.throwError) throw result.throwError;
      return {
        runId: "test",
        status: "ok",
        stages: [],
        errors: result?.errors ?? [],
        warnings: [],
      };
    }),
  } as unknown as BootstrapOrchestrator;
}

/** Await pending microtasks so tracker's bootstrap-promise handlers can
 *  fire before status is read. The setImmediate hop is enough for
 *  vi.fn-wrapped async mocks that resolve in the same tick. */
async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function makeBaseDeps(
  overrides: Partial<KernelBootDeps>,
  specsDir: string,
): KernelBootDeps {
  return {
    rigRepo: makeRigRepo([]),
    sessionRegistry: makeSessionRegistry(),
    eventBus: makeEventBus().bus,
    bootstrapOrchestrator: makeBootstrapMock(),
    specsDir,
    cwdOverride: specsDir,
    probeRuntimes: async () => ({ claudeCode: "ok", codex: "ok" }),
    log: () => {},
    degradedTimeoutMs: 0, // disable degraded timer for default tests
    ...overrides,
  };
}

let tmpSpecsDir: string;

beforeEach(() => {
  tmpSpecsDir = mkdtempSync(join(tmpdir(), "kernel-boot-"));
  const kernelDir = join(tmpSpecsDir, "rigs/launch/kernel");
  mkdirSync(kernelDir, { recursive: true });
  writeFileSync(join(kernelDir, "rig.yaml"), "name: kernel\n");
  writeFileSync(join(kernelDir, "rig-claude-only.yaml"), "name: kernel\n");
  writeFileSync(join(kernelDir, "rig-codex-only.yaml"), "name: kernel\n");
});

afterEach(() => {
  delete process.env.OPENRIG_NO_KERNEL;
  if (tmpSpecsDir) rmSync(tmpSpecsDir, { recursive: true, force: true });
});

describe("selectVariant — auth-state → variant mapping", () => {
  it("picks rig.yaml when both runtimes available", () => {
    expect(selectVariant({ claudeCode: "ok", codex: "ok" })).toBe("rig.yaml");
  });
  it("picks rig-claude-only.yaml when only Claude available", () => {
    expect(selectVariant({ claudeCode: "ok", codex: "unavailable" })).toBe("rig-claude-only.yaml");
  });
  it("picks rig-codex-only.yaml when only Codex available", () => {
    expect(selectVariant({ claudeCode: "unavailable", codex: "ok" })).toBe("rig-codex-only.yaml");
  });
});

describe("kernelAlreadyManaged — short-circuit predicate", () => {
  it("returns true when a rig named 'kernel' exists", () => {
    expect(kernelAlreadyManaged(makeRigRepo([{ name: "kernel" }, { name: "other" }]))).toBe(true);
  });
  it("returns false when no rig is named 'kernel' (case-sensitive)", () => {
    expect(kernelAlreadyManaged(makeRigRepo([{ name: "Kernel" }, { name: "other" }]))).toBe(false);
  });
  it("returns false on an empty rig list", () => {
    expect(kernelAlreadyManaged(makeRigRepo([]))).toBe(false);
  });
});

describe("authBlockMessage — 3-part error contract", () => {
  it("includes Error/Reason/Fix lines per building-agent-software skill discipline", () => {
    const msg = authBlockMessage();
    expect(msg).toMatch(/^Error:/m);
    expect(msg).toMatch(/^Reason:/m);
    expect(msg).toMatch(/^Fix:/m);
    expect(msg).toContain("claude auth login");
    expect(msg).toContain("codex login");
  });
});

describe("bootKernelIfNeeded — short-circuit branches", () => {
  it("returns skipped tracker when OPENRIG_NO_KERNEL=1", async () => {
    process.env.OPENRIG_NO_KERNEL = "1";
    const bootstrap = makeBootstrapMock();
    const tracker = await bootKernelIfNeeded(makeBaseDeps({ bootstrapOrchestrator: bootstrap }, tmpSpecsDir));
    expect(tracker.getStatus().kernelState).toBe("skipped");
    expect(tracker.getStatus().detail).toBe("OPENRIG_NO_KERNEL=1");
    expect((bootstrap as unknown as { bootstrap: ReturnType<typeof vi.fn> }).bootstrap).not.toHaveBeenCalled();
  });

  it("returns skipped tracker when a kernel rig is already managed", async () => {
    const bootstrap = makeBootstrapMock();
    const tracker = await bootKernelIfNeeded(makeBaseDeps({
      rigRepo: makeRigRepo([{ name: "kernel" }]),
      bootstrapOrchestrator: bootstrap,
    }, tmpSpecsDir));
    expect(tracker.getStatus().kernelState).toBe("skipped");
    expect(tracker.getStatus().detail).toContain("already managed");
    expect((bootstrap as unknown as { bootstrap: ReturnType<typeof vi.fn> }).bootstrap).not.toHaveBeenCalled();
  });

  it("returns auth_blocked tracker when neither runtime is available", async () => {
    const bootstrap = makeBootstrapMock();
    const tracker = await bootKernelIfNeeded(makeBaseDeps({
      bootstrapOrchestrator: bootstrap,
      probeRuntimes: async () => ({ claudeCode: "unavailable", codex: "unavailable" }),
    }, tmpSpecsDir));
    const status = tracker.getStatus();
    expect(status.kernelState).toBe("auth_blocked");
    expect(status.detail).toMatch(/^Error: Kernel rig cannot boot/);
    expect((bootstrap as unknown as { bootstrap: ReturnType<typeof vi.fn> }).bootstrap).not.toHaveBeenCalled();
  });

  it("returns spec_missing tracker when the chosen variant file doesn't exist", async () => {
    rmSync(join(tmpSpecsDir, "rigs/launch/kernel/rig.yaml"));
    const bootstrap = makeBootstrapMock();
    const tracker = await bootKernelIfNeeded(makeBaseDeps({ bootstrapOrchestrator: bootstrap }, tmpSpecsDir));
    expect(tracker.getStatus().kernelState).toBe("spec_missing");
    expect((bootstrap as unknown as { bootstrap: ReturnType<typeof vi.fn> }).bootstrap).not.toHaveBeenCalled();
  });
});

describe("bootKernelIfNeeded — fire-and-forget bootstrap", () => {
  it("fires bootstrap in the background with the resolved variant + correct opts", async () => {
    // Hold the bootstrap mock open so we can observe the in-flight
    // booting state deterministically before the promise resolves.
    let release: () => void = () => {};
    const blocked = new Promise<void>((r) => { release = r; });
    const bootstrap = {
      bootstrap: vi.fn(async () => {
        await blocked;
        return { runId: "t", status: "ok", stages: [], errors: [], warnings: [] };
      }),
    } as unknown as BootstrapOrchestrator;
    const tracker = await bootKernelIfNeeded(makeBaseDeps({ bootstrapOrchestrator: bootstrap }, tmpSpecsDir));
    expect(tracker.getStatus().kernelState).toBe("booting");
    expect(tracker.getStatus().variant).toBe("rig.yaml");
    expect((bootstrap as unknown as { bootstrap: ReturnType<typeof vi.fn> }).bootstrap).toHaveBeenCalledOnce();
    const opts = (bootstrap as unknown as { bootstrap: ReturnType<typeof vi.fn> }).bootstrap.mock.calls[0]![0];
    expect(opts.mode).toBe("apply");
    expect(opts.sourceRef).toBe(join(tmpSpecsDir, "rigs/launch/kernel", "rig.yaml"));
    expect(opts.sourceKind).toBe("rig_spec");
    expect(opts.autoApprove).toBe(true);
    expect(opts.cwdOverride).toBe(tmpSpecsDir);
    release();
    tracker.stop();
  });

  it("transitions to bootstrap_failed when orchestrator returns errors (post-flush)", async () => {
    const tracker = await bootKernelIfNeeded(makeBaseDeps({
      bootstrapOrchestrator: makeBootstrapMock({ errors: ["preflight: tmux missing"] }),
    }, tmpSpecsDir));
    await flushPromises();
    const status = tracker.getStatus();
    expect(status.kernelState).toBe("bootstrap_failed");
    expect(status.detail).toContain("tmux missing");
    tracker.stop();
  });

  it("transitions to bootstrap_failed and surfaces thrown error message (post-flush)", async () => {
    const tracker = await bootKernelIfNeeded(makeBaseDeps({
      bootstrapOrchestrator: makeBootstrapMock({ throwError: new Error("network blip") }),
    }, tmpSpecsDir));
    await flushPromises();
    const status = tracker.getStatus();
    expect(status.kernelState).toBe("bootstrap_failed");
    expect(status.detail).toBe("network blip");
    tracker.stop();
  });

  it("uses the claude-only variant when only Claude is available", async () => {
    const tracker = await bootKernelIfNeeded(makeBaseDeps({
      probeRuntimes: async () => ({ claudeCode: "ok", codex: "unavailable" }),
    }, tmpSpecsDir));
    expect(tracker.getStatus().variant).toBe("rig-claude-only.yaml");
    tracker.stop();
  });

  it("uses the codex-only variant when only Codex is available", async () => {
    const tracker = await bootKernelIfNeeded(makeBaseDeps({
      probeRuntimes: async () => ({ claudeCode: "unavailable", codex: "ok" }),
    }, tmpSpecsDir));
    expect(tracker.getStatus().variant).toBe("rig-codex-only.yaml");
    tracker.stop();
  });
});

// Issue #194 — a Codex provider that does not use an OpenAI login.
const BEDROCK_CONFIG = [
  'model_provider = "bedrock-runtime-us"',
  "",
  "[model_providers.bedrock-runtime-us]",
  'name = "Amazon Bedrock Runtime"',
  'env_key = "AWS_BEARER_TOKEN_BEDROCK"',
  'wire_api = "responses"',
  "requires_openai_auth = false",
  "",
].join("\n");

function codexProbe(opts: { config: string | null; env?: Record<string, string>; loggedIn?: boolean; installed?: boolean }) {
  const ran: string[] = [];
  const run = async (cmd: string): Promise<RuntimeAuthStatus> => {
    ran.push(cmd);
    if (opts.installed === false) return "unavailable";
    if (cmd === "codex login status") return opts.loggedIn ? "ok" : "unavailable";
    return "ok";
  };
  return { ran, deps: { run, readConfig: () => opts.config, env: opts.env ?? {} } };
}

describe("selectCodexProviderAuth — provider-aware Codex readiness (#194)", () => {
  it("uses the credential variable only for an explicit non-OpenAI provider with env_key", () => {
    expect(selectCodexProviderAuth(BEDROCK_CONFIG)).toEqual({
      kind: "env-key", providerId: "bedrock-runtime-us", envKey: "AWS_BEARER_TOKEN_BEDROCK",
    });
  });

  it("keeps the OpenAI login check for every unresolved or OpenAI-auth case", () => {
    expect(selectCodexProviderAuth(null)).toEqual({ kind: "openai-login" });
    expect(selectCodexProviderAuth('model_provider = "openai"\n')).toEqual({ kind: "openai-login" });
    expect(selectCodexProviderAuth(BEDROCK_CONFIG.replace("requires_openai_auth = false", "requires_openai_auth = true")).kind).toBe("openai-login");
    expect(selectCodexProviderAuth(BEDROCK_CONFIG.replace("requires_openai_auth = false", "")).kind).toBe("openai-login");
    expect(selectCodexProviderAuth(BEDROCK_CONFIG.replace('env_key = "AWS_BEARER_TOKEN_BEDROCK"', "")).kind).toBe("openai-login");
    expect(selectCodexProviderAuth(BEDROCK_CONFIG.replace('model_provider = "bedrock-runtime-us"', 'model_provider = "missing"')).kind).toBe("openai-login");
    expect(selectCodexProviderAuth('model_provider = "__proto__"\n')).toEqual({ kind: "openai-login" });
    expect(selectCodexProviderAuth("model_provider = [broken")).toEqual({ kind: "openai-login", unresolved: "config.toml could not be parsed" });
    expect(selectCodexProviderAuth(`profile = "work"\n${BEDROCK_CONFIG}`).kind).toBe("openai-login");
  });
});

describe("probeCodexReadiness — the kernel's Codex probe (#194)", () => {
  it("reports ok for the Bedrock provider with its token set and no OpenAI login, without running codex login status", async () => {
    const probe = codexProbe({ config: BEDROCK_CONFIG, env: { AWS_BEARER_TOKEN_BEDROCK: "synthetic-token" }, loggedIn: false });
    expect(await probeCodexReadiness(probe.deps)).toBe("ok");
    expect(probe.ran).toEqual(["codex --version"]);
  });

  it("reports unavailable when the provider's variable is missing or blank", async () => {
    for (const env of [{}, { AWS_BEARER_TOKEN_BEDROCK: "   " }]) {
      const probe = codexProbe({ config: BEDROCK_CONFIG, env, loggedIn: true });
      expect(await probeCodexReadiness(probe.deps)).toBe("unavailable");
      expect(probe.ran).not.toContain("codex login status");
    }
  });

  it("reports unavailable when the Codex executable is missing even with the token set", async () => {
    const probe = codexProbe({ config: BEDROCK_CONFIG, env: { AWS_BEARER_TOKEN_BEDROCK: "synthetic-token" }, installed: false });
    expect(await probeCodexReadiness(probe.deps)).toBe("unavailable");
  });

  it("keeps the OpenAI login result for default, OpenAI-auth and malformed configurations", async () => {
    for (const config of [null, 'model_provider = "openai"\n', "model_provider = [broken"]) {
      for (const loggedIn of [true, false]) {
        const probe = codexProbe({ config, env: { AWS_BEARER_TOKEN_BEDROCK: "synthetic-token" }, loggedIn });
        expect(await probeCodexReadiness(probe.deps)).toBe(loggedIn ? "ok" : "unavailable");
        expect(probe.ran).toEqual(["codex login status"]);
      }
    }
  });

  it("lets the kernel select the Codex variant for a Bedrock-only machine", async () => {
    const probe = codexProbe({ config: BEDROCK_CONFIG, env: { AWS_BEARER_TOKEN_BEDROCK: "synthetic-token" }, loggedIn: false });
    const tracker = await bootKernelIfNeeded(makeBaseDeps({
      probeRuntimes: async () => ({ claudeCode: "unavailable", codex: await probeCodexReadiness(probe.deps) }),
    }, tmpSpecsDir));
    expect(tracker.getStatus().variant).toBe("rig-codex-only.yaml");
    tracker.stop();
  });
});

describe("expectedKernelSeats — the roster a boot failure must recover (#1042)", () => {
  it("reads each pod member of the shipped kernel variants as pod.member", () => {
    const kernelDir = fileURLToPath(new URL("../specs/rigs/launch/kernel/", import.meta.url));
    for (const variant of ["rig.yaml", "rig-claude-only.yaml", "rig-codex-only.yaml"]) {
      expect(expectedKernelSeats(join(kernelDir, variant))).toEqual(["advisor.lead", "operator.human", "operator.agent", "queue.worker"]);
    }
  });

  it("returns null when the roster can't be known, so a failure stays current", () => {
    const cases: Record<string, string> = {
      "no-pods.yaml": "name: kernel\n",
      "empty-pods.yaml": "name: kernel\npods: []\n",
      "member-without-id.yaml": "name: kernel\npods:\n  - id: queue\n    members:\n      - runtime: codex\n",
      "malformed.yaml": "name: kernel\npods: [\n",
    };
    for (const [file, yaml] of Object.entries(cases)) {
      writeFileSync(join(tmpSpecsDir, file), yaml);
      expect(expectedKernelSeats(join(tmpSpecsDir, file))).toBeNull();
    }
    expect(expectedKernelSeats(join(tmpSpecsDir, "missing.yaml"))).toBeNull();
  });
});

describe("classifyClaudeAuthStatus — Claude Code 2.1.x JSON status (OF-58)", () => {
  const out = (stdout: string, exitCode: number | null, stderr = "") => ({ stdout, stderr, exitCode });
  const json = (o: Record<string, unknown>) => JSON.stringify(o, null, 2);

  it("JSON logged in with a subscription is ok and reports the method", () => {
    expect(classifyClaudeAuthStatus(out(json({ loggedIn: true, authMethod: "claude.ai" }), 0)))
      .toEqual({ status: "ok", authMethod: "claude.ai" });
  });

  it("api_key auth counts as ok (the kernel boots) and the method is reported, not acted on", () => {
    expect(classifyClaudeAuthStatus(out(json({ loggedIn: true, authMethod: "api_key" }), 0)))
      .toEqual({ status: "ok", authMethod: "api_key" });
  });

  it("JSON logged out with exit 1 is unavailable", () => {
    expect(classifyClaudeAuthStatus(out(json({ loggedIn: false, authMethod: "none" }), 1)).status).toBe("unavailable");
  });

  it("JSON logged out with exit 0 is unavailable: correctness must not rest on the exit code alone", () => {
    expect(classifyClaudeAuthStatus(out(json({ loggedIn: false, authMethod: "none" }), 0)))
      .toEqual({ status: "unavailable", authMethod: "none" });
  });

  it("a non-zero exit is unavailable even when the JSON says logged in", () => {
    expect(classifyClaudeAuthStatus(out(json({ loggedIn: true, authMethod: "claude.ai" }), 2)).status).toBe("unavailable");
  });

  it("a missing exit code (timeout, missing binary) is unavailable", () => {
    expect(classifyClaudeAuthStatus(out("", null)).status).toBe("unavailable");
  });

  it("legacy text 'Not logged in' at exit 0 is unavailable; legacy logged-in text is ok", () => {
    expect(classifyClaudeAuthStatus(out("Not logged in. Run claude auth login.", 0)).status).toBe("unavailable");
    expect(classifyClaudeAuthStatus(out("Logged in as someone@example.com", 0)).status).toBe("ok");
    expect(classifyClaudeAuthStatus(out("", 0, "Login required")).status).toBe("unavailable");
  });

  it("empty or garbage output at exit 0 keeps today's text rule (ok)", () => {
    expect(classifyClaudeAuthStatus(out("", 0)).status).toBe("ok");
    expect(classifyClaudeAuthStatus(out("{not json", 0)).status).toBe("ok");
  });

  it("JSON without a boolean loggedIn falls back to the text rule rather than guessing", () => {
    expect(classifyClaudeAuthStatus(out(json({ loggedIn: "no", note: "not logged in" }), 0)).status).toBe("unavailable");
    expect(classifyClaudeAuthStatus(out(json({ authMethod: "claude.ai" }), 0)).status).toBe("ok");
  });

  it("an authMethod that is not a short token is never reported", () => {
    const r = classifyClaudeAuthStatus(out(json({ loggedIn: true, authMethod: "sk-ant secret value with spaces" }), 0));
    expect(r).toEqual({ status: "ok" });
  });

  // OF-61: the 32-character cap on a reported authMethod. Both values use only the allowed charset, so only the
  // length can separate them (the spaces row above is rejected by the charset alone and cannot pin the cap).
  it("an authMethod of exactly 32 token characters is reported", () => {
    const value = "a".repeat(32);
    expect(classifyClaudeAuthStatus(out(json({ loggedIn: true, authMethod: value }), 0)))
      .toEqual({ status: "ok", authMethod: value });
  });

  it("an authMethod of 33 token characters is never reported", () => {
    const value = "a".repeat(33);
    expect(classifyClaudeAuthStatus(out(json({ loggedIn: true, authMethod: value }), 0))).toEqual({ status: "ok" });
  });
});

describe("defaultProbeRuntimes — claude auth status through a real process (OF-58)", () => {
  let binDir: string;
  let savedPath: string | undefined;
  let savedCodexHome: string | undefined;
  function stub(name: string, body: string): void {
    const file = join(binDir, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
  }
  beforeEach(() => {
    binDir = mkdtempSync(join(tmpdir(), "kernel-probe-bin-"));
    savedPath = process.env.PATH;
    savedCodexHome = process.env.CODEX_HOME;
    process.env.PATH = `${binDir}:/usr/bin:/bin`;
    process.env.CODEX_HOME = binDir; // no config.toml: the codex login-status path
    stub("codex", "exit 1");
  });
  afterEach(() => {
    process.env.PATH = savedPath;
    if (savedCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = savedCodexHome;
    rmSync(binDir, { recursive: true, force: true });
  });

  it("logged-out JSON printed with exit 0 reads as unavailable", async () => {
    stub("claude", `echo '{"loggedIn": false, "authMethod": "none"}'`);
    const probe = await defaultProbeRuntimes();
    expect(probe.claudeCode).toBe("unavailable");
    expect(probe.codex).toBe("unavailable");
  });

  it("logged-in JSON reads as ok and carries the auth method", async () => {
    stub("claude", `echo '{"loggedIn": true, "authMethod": "api_key"}'`);
    const probe = await defaultProbeRuntimes();
    expect(probe.claudeCode).toBe("ok");
    expect(probe.claudeAuthMethod).toBe("api_key");
  });

  it("logged-out JSON with exit 1 stays unavailable", async () => {
    stub("claude", `echo '{"loggedIn": false, "authMethod": "none"}'; exit 1`);
    const probe = await defaultProbeRuntimes();
    expect(probe.claudeCode).toBe("unavailable");
    // exec rejects on a non-zero exit; the output it carried must still reach the classifier.
    expect(probe.claudeAuthMethod).toBe("none");
  });

  it("a status command that outlives the 5s probe timeout is unavailable, even though it printed logged-in JSON first", async () => {
    stub("claude", `echo '{"loggedIn": true, "authMethod": "claude.ai"}'; exec sleep 30`);
    expect((await defaultProbeRuntimes()).claudeCode).toBe("unavailable");
  }, 20000);
});

describe("bootKernelIfNeeded — auth method visibility (OF-58)", () => {
  it("names the Claude authMethod in the booting log line and does not change the variant", async () => {
    const lines: string[] = [];
    const tracker = await bootKernelIfNeeded(makeBaseDeps({
      probeRuntimes: async () => ({ claudeCode: "ok", codex: "ok", claudeAuthMethod: "api_key" }),
      log: (_level, message) => { lines.push(message); },
    }, tmpSpecsDir));
    expect(lines.some((l) => l.includes("booting kernel rig from rig.yaml") && l.includes("claude authMethod: api_key"))).toBe(true);
    expect(tracker.getStatus().variant).toBe("rig.yaml");
    tracker.stop();
  });

  // Jim, 2026-10-26: warn when a seat's sign-in type can't be told apart (OF-61).
  async function bootLines(probe: { claudeCode: "ok" | "unavailable"; codex: "ok" | "unavailable"; claudeAuthMethod?: string }) {
    const lines: Array<{ level: string; message: string }> = [];
    const tracker = await bootKernelIfNeeded(makeBaseDeps({
      probeRuntimes: async () => probe,
      log: (level, message) => { lines.push({ level, message }); },
    }, tmpSpecsDir));
    tracker.stop();
    return lines.filter((l) => l.level === "warn");
  }

  it("warns when Claude is signed in but the sign-in type is unreadable (older CLI, or a value the cap rejected)", async () => {
    const warns = await bootLines({ claudeCode: "ok", codex: "ok" });
    expect(warns.map((w) => w.message)).toEqual([expect.stringContaining("sign-in type could not be read")]);
  });

  it("warns that an API-key sign-in is billed per use", async () => {
    const warns = await bootLines({ claudeCode: "ok", codex: "ok", claudeAuthMethod: "api_key" });
    expect(warns.map((w) => w.message)).toEqual([expect.stringContaining("API key")]);
  });

  it("does not warn for a subscription sign-in, nor when Claude is not the usable runtime", async () => {
    expect(await bootLines({ claudeCode: "ok", codex: "ok", claudeAuthMethod: "claude.ai" })).toEqual([]);
    expect(await bootLines({ claudeCode: "unavailable", codex: "ok" })).toEqual([]);
  });
});
