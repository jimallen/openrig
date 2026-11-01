import { Command } from "commander";
import { accessSync, constants, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import net from "node:net";
import { execSync } from "node:child_process";
import { resolveDaemonPath } from "../daemon-lifecycle.js";
import { formatDaemonHostForUrl } from "../client.js";
import { ConfigStore } from "../config-store.js";
import { buildWritableHomeCheck } from "../system-preflight.js";
import { HC_GENERATION, buildHcHostFailure, classifyHcCore, probeHcInstall, readHcHello, type HcHelloOutcome } from "../tmux-health.js";
import { parse as parseYaml } from "yaml";
import { compareSpecToLive, topologyFromRigSpec, topologyFromLiveLogicalIds } from "@openrig/daemon/spec-conformance";
import { classifyNodeVersion } from "../node-support.js";
import { checkProviderReadiness } from "../provider-auth.js";

interface DoctorCheck {
  name: string;
  status: "pass" | "warn" | "fail" | "skipped";
  message: string;
  reason?: string;
  fix?: string;
}

export interface DoctorDeps {
  exists: (p: string) => boolean;
  baseDir: string;
  readFile: (path: string) => string | null;
  exec: (cmd: string) => string;
  checkPort: (port: number, host: string) => Promise<boolean>;
  configStore: Pick<ConfigStore, "resolve">;
  platform?: NodeJS.Platform;
  /** Same CODEX_HOME and credential environment used by setup. */
  env?: NodeJS.ProcessEnv;
  mkdirp?: (path: string) => void;
  checkWritable?: (path: string) => void;
  fetch?: (url: string) => Promise<{ ok: boolean; json?: () => Promise<unknown> }>;
  /**
   * Build B — path to a rig spec to check against the RUNNING rig of the same name (`--spec`).
   *
   * Supplied explicitly because it cannot be discovered. Nothing persists a running rig's spec
   * path: the `rigs` table has no spec/rigRoot column, `rig_services.rig_root` is empty, and
   * `projection_manifest.source_spec` is empty. The daemon does not remember which file described
   * the rig it is running. Absent, the check SKIPS with that reason rather than passing.
   */
  specPath?: string;
  /** Live seat ids (`<pod>.<member>`) for the spec's rig; null when the topology cannot be read. */
  fetchLiveLogicalIds?: (rigName: string) => Promise<string[] | null>;
  /** One `hello` to the hc core's socket (default: the real socket). Never starts a core. */
  readHcHello?: () => Promise<HcHelloOutcome>;
}

const DEFAULT_PORT = 7433;

function defaultCheckPort(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1000);
    socket.on("connect", () => { socket.destroy(); resolve(false); });
    socket.on("error", () => { socket.destroy(); resolve(true); });
    socket.on("timeout", () => { socket.destroy(); resolve(true); });
    socket.connect(port, host);
  });
}

export function runDoctorChecks(deps: DoctorDeps, providerChecks: DoctorCheck[] = checkProviderReadiness(deps)): { checks: DoctorCheck[]; portCheck: Promise<DoctorCheck>; asyncChecks: Promise<DoctorCheck>[] } {
  const checks: DoctorCheck[] = [...providerChecks];

  // 1. Daemon dist
  const daemonPath = resolveDaemonPath(deps.baseDir, deps.exists);
  const daemonEntry = path.join(daemonPath, "dist/index.js");
  if (deps.exists(daemonEntry)) {
    checks.push({ name: "daemon_dist", status: "pass", message: `Daemon dist found at ${daemonPath}` });
  } else {
    checks.push({
      name: "daemon_dist",
      status: "fail",
      message: "Daemon dist not found.",
      reason: "The daemon compiled output is required to start the OpenRig daemon process.",
      fix: "Run 'npm run build:package' from the repo root, or reinstall with 'npm install -g @openrig/cli'.",
    });
  }

  // 2. UI dist
  const uiDistPath = path.resolve(daemonPath, "..", "ui", "dist", "index.html");
  if (deps.exists(uiDistPath)) {
    checks.push({ name: "ui_dist", status: "pass", message: "UI dist found." });
  } else {
    checks.push({
      name: "ui_dist",
      status: "fail",
      message: "UI dist not found.",
      reason: "The pre-built UI assets are required for the dashboard to render.",
      fix: "Run 'npm run build:package' from the repo root, or reinstall with 'npm install -g @openrig/cli'.",
    });
  }

  // 3. Node version
  const nodeSupport = classifyNodeVersion(process.version);
  if (nodeSupport.kind === "supported") {
    checks.push({ name: "node_version", status: "pass", message: `Node ${process.version}` });
  } else if (nodeSupport.kind === "untested") {
    checks.push({ name: "node_version", status: "warn", message: nodeSupport.message! });
  } else {
    checks.push({
      name: "node_version",
      status: "fail",
      message: nodeSupport.message!,
      reason: nodeSupport.reason,
      fix: nodeSupport.fix,
    });
  }

  // 4. hc: the seat host. Installed and an accepted version here; the running core's generation is an async check
  // below. Neither starts a core.
  const hcProbe = probeHcInstall((cmd) => deps.exec(cmd));
  if (hcProbe.code === "not_installed") {
    checks.push({
      name: "hc",
      status: "fail",
      message: "hc not found.",
      reason: "OpenRig runs agent seats in hc terminals.",
      fix: "Install hc (herdr-core), see https://herdr.dev/core/ for the tested version, then rerun 'rig doctor'.",
    });
  } else if (hcProbe.available && hcProbe.version) {
    checks.push(hcProbe.warning
      ? { name: "hc", status: "warn", message: `hc ${hcProbe.version} (untested)`, reason: hcProbe.warning }
      : { name: "hc", status: "pass", message: `hc ${hcProbe.version}` });
  } else {
    const failure = buildHcHostFailure(hcProbe.code, hcProbe.detail ?? "unknown hc failure");
    checks.push({
      name: "hc",
      status: "fail",
      message: failure.message,
      reason: failure.reason,
      fix: failure.fix,
    });
  }

  // 6. Writable state paths (shared with preflight)
  const config = deps.configStore.resolve();
  const writableCheck = buildWritableHomeCheck(config, path.dirname(config.db.path), {
    mkdirp: deps.mkdirp,
    checkWritable: deps.checkWritable,
  });
  checks.push({
    name: writableCheck.name,
    status: writableCheck.ok ? "pass" : "fail",
    message: writableCheck.ok ? "Writable state paths verified." : writableCheck.error ?? "State paths are not writable.",
    reason: writableCheck.reason,
    fix: writableCheck.fix,
  });

  // 7. Port availability (async) — daemon already running on that port counts as OK.
  // OPR.0.4.7 slice-05 item-4b: resolve the daemon host+port ONCE from config and use
  // BOTH for checkPort, healthz, and messages (a daemon on a non-default
  // configured host/port must not be reported missing). Defaults stay 127.0.0.1:7433.
  const daemonHost = config.daemon.host ?? "127.0.0.1";
  const daemonPort = config.daemon.port ?? DEFAULT_PORT;
  const daemonBase = `http://${formatDaemonHostForUrl(daemonHost)}:${daemonPort}`;
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const portCheck = deps.checkPort(daemonPort, daemonHost).then(async (available): Promise<DoctorCheck> => {
    if (available) {
      return { name: "port", status: "pass", message: `Port ${daemonHost}:${daemonPort} available.` };
    }
    // Port in use — check if it's our daemon via healthz
    try {
      const res = await fetchFn(`${daemonBase}/healthz`);
      if (res.ok) {
        return { name: "port", status: "pass", message: `Port ${daemonHost}:${daemonPort} in use by OpenRig daemon.` };
      }
    } catch { /* not our daemon */ }
    return {
      name: "port",
      status: "fail",
      message: `Port ${daemonHost}:${daemonPort} is in use by another process.`,
      reason: "The daemon needs this port to serve the API and UI.",
      fix: `Stop the process using port ${daemonPort}, or start the daemon on a different port with: rig daemon start --port <port>`,
    };
  });

  const asyncChecks: Promise<DoctorCheck>[] = [portCheck];

  if (hcProbe.available) asyncChecks.push(buildHcCoreCheck(deps));
  asyncChecks.push(buildSpecConformanceCheck(deps));

  return { checks, portCheck, asyncChecks };
}

/** The running core's side of seat-host health: its protocol generation and version. It reads the core's socket and
 *  never starts one, so a machine with no core yet passes with a note. */
async function buildHcCoreCheck(deps: DoctorDeps): Promise<DoctorCheck> {
  const outcome = await (deps.readHcHello ?? (() => readHcHello()))();
  const core = classifyHcCore(outcome);
  if (core.code === "available") {
    return core.warning
      ? { name: "hc_core", status: "warn", message: `hc core ${core.version} (untested), protocol generation ${HC_GENERATION}.`, reason: core.warning }
      : { name: "hc_core", status: "pass", message: `hc core ${core.version}, protocol generation ${HC_GENERATION}.` };
  }
  if (core.code === "no_core") {
    return { name: "hc_core", status: "pass", message: "No hc core running; one starts with the first seat.", reason: core.detail ?? undefined };
  }
  const failure = buildHcHostFailure(core.code, core.detail ?? "unknown hc core failure");
  return { name: "hc_core", status: "fail", message: failure.message, reason: failure.reason, fix: failure.fix };
}

/**
 * Build B — does the rig spec still describe the rig that is running?
 *
 * Nothing writes a spec back after `rig expand`, and the spec is what a bundle export copies
 * verbatim, so a rig can outgrow its own description silently. This is the check that says so —
 * and, once a spec is reconciled by hand, the check that VERIFIES the write-back landed instead of
 * someone eyeballing YAML.
 *
 * SKIPS rather than passes when it has no input. A check that cannot find its subject and stays
 * quiet is indistinguishable from one that looked and found nothing wrong.
 */
async function buildSpecConformanceCheck(deps: DoctorDeps): Promise<DoctorCheck> {
  const name = "spec_live_conformance";
  if (!deps.specPath) {
    return {
      name,
      status: "skipped",
      message: "No --spec given; spec-vs-live topology not checked.",
      reason:
        "A running rig's spec path is not persisted anywhere (the rigs table has no spec/rigRoot column), so this check cannot discover it.",
      fix: "rig doctor --spec <path/to/rig.yaml>",
    };
  }

  const raw = deps.readFile(deps.specPath);
  if (raw === null) {
    return { name, status: "fail", message: `Rig spec could not be read at ${deps.specPath}.` };
  }

  let spec: { name?: unknown; pods?: unknown };
  try {
    spec = parseYaml(raw) as { name?: unknown; pods?: unknown };
  } catch (err) {
    return { name, status: "fail", message: `Rig spec at ${deps.specPath} is not valid YAML: ${(err as Error).message}` };
  }
  const rigName = typeof spec?.name === "string" ? spec.name : "";
  if (!rigName || !Array.isArray(spec?.pods)) {
    return { name, status: "fail", message: `Rig spec at ${deps.specPath} declares no name or no pods.` };
  }

  const liveIds = deps.fetchLiveLogicalIds ? await deps.fetchLiveLogicalIds(rigName) : null;
  if (liveIds === null) {
    return {
      name,
      status: "skipped",
      message: `Live topology for '${rigName}' could not be read; conformance unknown.`,
      reason: "Absence of live data is not evidence of conformance, so this is reported as unknown rather than passing.",
    };
  }

  const result = compareSpecToLive(topologyFromRigSpec(spec as never), topologyFromLiveLogicalIds(liveIds));
  if (result.conforms) {
    return {
      name,
      status: "pass",
      message: `Spec matches the running rig '${rigName}' (${result.spec.pods} pods/${result.spec.seats} seats).`,
    };
  }
  return {
    name,
    status: "warn",
    message: `Rig '${rigName}': ${result.message}`,
    reason: "A bundle export copies the SPEC verbatim, so this rig would export smaller than it runs.",
    fix: "Reconcile the spec with the running topology, then re-run this check to verify the write-back.",
  };
}

export function doctorCommand(depsOverride?: DoctorDeps): Command {
  const cmd = new Command("doctor")
    .description("Check installation, provider authentication, writable paths, port/daemon and the hc core")
    .addHelpText("after", "\nWith --spec, compares declared and live topology. This is not an end-to-end readiness check.\nReports Claude and Codex authentication using setup's checks, including configured Codex credential variables. No agent task or provider request is tested.\nInspect your team with rig ps --nodes --rig <rig> and rig capture <seat> --lines 30.");

  cmd
    .option("--json", "JSON output for agents")
    .option("--spec <path>", "Rig spec to check against the running rig of the same name (spec-vs-live topology)")
    .action(async (opts: { json?: boolean; spec?: string }) => {
      const deps: DoctorDeps = depsOverride ?? {
        exists: existsSync,
        baseDir: import.meta.dirname,
        readFile: (p: string) => { try { return readFileSync(p, "utf-8"); } catch { return null; } },
        exec: (c: string) => execSync(c, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }),
        checkPort: defaultCheckPort,
        configStore: new ConfigStore(),
        mkdirp: (dirPath: string) => mkdirSync(dirPath, { recursive: true }),
        checkWritable: (dirPath: string) => accessSync(dirPath, constants.W_OK),
        specPath: opts.spec ? path.resolve(opts.spec) : undefined,
        // Returns null on ANY failure to read the live side. The conformance check treats null as
        // "unknown" and skips — an unreachable daemon must never read as a matching topology.
        fetchLiveLogicalIds: async (rigName: string): Promise<string[] | null> => {
          try {
            const cfg = new ConfigStore().resolve();
            const base = `http://${formatDaemonHostForUrl(cfg.daemon.host ?? "127.0.0.1")}:${cfg.daemon.port ?? DEFAULT_PORT}`;
            const rigsRes = await fetch(`${base}/api/rigs`);
            if (!rigsRes.ok) return null;
            const rigs = (await rigsRes.json()) as Array<{ id?: string; name?: string }>;
            const rig = rigs.find((r) => r.name === rigName);
            if (!rig?.id) return null;
            const nodesRes = await fetch(`${base}/api/rigs/${rig.id}/nodes`);
            if (!nodesRes.ok) return null;
            const nodes = (await nodesRes.json()) as Array<{ logicalId?: string | null }>;
            return nodes.map((n) => n.logicalId ?? "");
          } catch {
            return null;
          }
        },
      };

      // Only the newly added provider probes inherit setup's timeout.
      const providerChecks = checkProviderReadiness(depsOverride ?? {
        ...deps,
        exec: (c: string) => execSync(c, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 30_000 }),
      });
      const { checks, asyncChecks } = runDoctorChecks(deps, providerChecks);
      const resolvedAsync = await Promise.all(asyncChecks);
      const allChecks = [...checks, ...resolvedAsync];
      const healthy = allChecks.every((c) => c.status !== "fail");

      if (opts.json) {
        console.log(JSON.stringify({ healthy, checks: allChecks }, null, 2));
        if (!healthy) process.exitCode = 1;
        return;
      }

      for (const check of allChecks) {
        const icon = check.status === "pass" ? "OK" : check.status === "warn" ? "WARN" : check.status === "skipped" ? "SKIP" : "FAIL";
        console.log(`  [${icon}] ${check.name}: ${check.message}`);
        if (check.reason) console.log(`       Why: ${check.reason}`);
        if (check.fix) console.log(`       Fix: ${check.fix}`);
      }

      console.log("");
      console.log(healthy ? "No failures in the checks above. Review any WARN or SKIP rows." : "Some checks failed. Review the FAIL rows and their fixes above.");
      console.log("Authentication checks report local provider facts; no agent task or provider request was tested.");
      console.log("Only the harnesses selected for your project need a login; an unused harness does not.");
      console.log("A credential variable being set does not prove the provider accepts it or that managed seats receive it.");
      console.log("Inspect your team with `rig ps --nodes --rig <rig>` and `rig capture <seat> --lines 30`.");
      if (!healthy) process.exitCode = 1;
    });

  return cmd;
}
