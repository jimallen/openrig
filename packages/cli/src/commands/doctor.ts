import { CODEX_CONFIG_POLICY, readCredentialFile, type CredentialFileRead } from "@openrig/daemon/credential-file";
import { Command } from "commander";
import { setOff } from "@openrig/daemon/command-text";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import net from "node:net";
import { execSync } from "node:child_process";
import { resolveDaemonPath } from "../daemon-lifecycle.js";
import { formatDaemonHostForUrl, localDaemonUrl, terminalAuthHeaders } from "../client.js";
import { ConfigStore } from "../config-store.js";
import { resolveHomeDaemon } from "../home-daemon-address.js";
import { buildWritableHomeCheck } from "../system-preflight.js";
import { HC_GENERATION, buildHcHostFailure, classifyHcCore, probeHcInstall, readHcHello, type HcHelloOutcome } from "../tmux-health.js";
import { parse as parseYaml } from "yaml";
import { compareSpecToLive, topologyFromRigSpec, topologyFromLiveLogicalIds } from "@openrig/daemon/spec-conformance";
import { notThisInstanceCore, readThisInstanceCore, type ThisInstanceCore } from "@openrig/daemon/hc";
import { findIgnoredVendoredPlugins } from "@openrig/daemon/vendored-plugin-conflicts";
import { getDefaultOpenRigPath, getOpenRigHome } from "../openrig-compat.js";
import { classifyNodeVersion } from "../node-support.js";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { openInChildProcess } from "../../scripts/check-abi.mjs";
import { checkProviderReadiness } from "../provider-auth.js";
import {
  SEAT_SHELL_NOTE,
  daemonHostRows,
  fetchDaemonHostRows,
  gitTemplateCheck,
  inotifyHeadroomCheck,
  piOperatorLoginCheck,
  remoteHostsCheck,
  runtimesInSpec,
  type LocalHostFacts,
} from "../host-readiness.js";
import { realLocalHostFacts } from "../host-readiness-facts.js";
import { buildSeatPathHeadCheck, type SeatProcess } from "../seat-path-head.js";
import { readSeatProcesses } from "../seat-process-environments.js";
import { configuredSlackSecretsEnvFile, judgeSlackSecretsFile } from "../slack-secrets-check.js";
import { buildSeatGuardCheck, type SeatGuardFiles } from "../seat-guard-health.js";

/** The wrapper's own tests, on the real filesystem: `-x` for the node, `-f` for the script. */
const SEAT_GUARD_FILES: SeatGuardFiles = {
  isExecutable: (file) => { try { accessSync(file, constants.X_OK); return statSync(file).isFile(); } catch { return false; } },
  isFile: (file) => { try { return statSync(file).isFile(); } catch { return false; } },
};

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
  /** workspaces-o9o.160: Codex's config.toml under the credential rule (see provider-auth.ts). */
  readCodexConfig?: (path: string) => CredentialFileRead;
  exec: (cmd: string) => string;
  checkPort: (port: number, host: string) => Promise<boolean>;
  configStore: Pick<ConfigStore, "resolve">;
  platform?: NodeJS.Platform;
  /** Same CODEX_HOME and credential environment used by setup. */
  env?: NodeJS.ProcessEnv;
  mkdirp?: (path: string) => void;
  checkWritable?: (path: string) => void;
  fetch?: (url: string) => Promise<{ ok: boolean; json?: () => Promise<unknown> }>;
  /** workspaces-o9o.181: the endpoint this home's daemon.json records, for the one resolver. Absent: none recorded. */
  recordedDaemonUrl?: () => string | undefined;
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
  /** The core this instance's state dir names (default: core.json under this env's state dir). workspaces-o9o.165. */
  thisInstanceCore?: () => ThisInstanceCore;
  /** workspaces-o9o.180: open an in-memory SQLite database with this CLI's binding, in a child (default: the real binding). */
  probeNativeSqlite?: () => { ok: true } | { ok: false; detail: string };
  /** The daemon's vendored plugins folder (default: OPENRIG_HOME/plugins). */
  pluginsDir?: string;
  /** workspaces-o9o.11: this machine's reads for the host rows (default: the real ones). */
  localHostFacts?: LocalHostFacts;
  /** workspaces-o9o.11: ask the daemon for its host rows; null when it cannot be reached. */
  fetchHostRows?: (input: { seatShell: boolean; runtimes: string[] | null }) => Promise<{ status: number; rows: DoctorCheck[] | null } | null>;
  /** workspaces-o9o.106: the seat processes on this host with their PATH (rig doctor and rig setup pass the /proc reader; null elsewhere).
   *  Required (workspaces-o9o.185): the real reader reads every live process's environment, so no default can reach it unasked. */
  readSeatProcesses: () => SeatProcess[] | null;
  /** The OpenRig instance whose seats that row judges (default: this CLI's OPENRIG_HOME). */
  openrigHome?: string;
  /** workspaces-o9o.151: the Slack connector's configured secrets file. Set, it adds the slack_secrets row (rig doctor sets it;
   *  rig setup, which shares these checks, does not). */
  slackSecretsEnvFile?: () => Promise<string | null>;
  /** workspaces-o9o.173: the file checks behind the seat guard row (default: the real filesystem). */
  seatGuardFiles?: SeatGuardFiles;
}

/**
 * workspaces-o9o.11: the host section, checked before a host's first launch. It is separate from runDoctorChecks
 * because `rig setup` runs those too, and setup must not start a probe shell. Reads and reports; fixes nothing.
 */
export async function runHostReadinessChecks(deps: DoctorDeps, options: { seatShell: boolean }): Promise<DoctorCheck[]> {
  const facts = deps.localHostFacts ?? realLocalHostFacts();
  let runtimes: string[] | null = null;
  if (deps.specPath) {
    const raw = deps.readFile(deps.specPath);
    if (raw !== null) {
      try { runtimes = runtimesInSpec(parseYaml(raw)); } catch { runtimes = null; }
    }
  }
  const config = deps.configStore.resolve() as { pi?: { operatorLoginDir?: string } };
  const local: DoctorCheck[] = [
    piOperatorLoginCheck(config.pi?.operatorLoginDir, runtimes === null ? null : runtimes.includes("pi"), facts),
    inotifyHeadroomCheck(facts),
    gitTemplateCheck(facts),
    remoteHostsCheck(facts),
  ];
  const response = deps.fetchHostRows ? await deps.fetchHostRows({ seatShell: options.seatShell, runtimes }) : null;
  return [...daemonHostRows(response, options.seatShell), ...local];
}


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
  // 3b. workspaces-o9o.180: the binding opens a database here (what the postinstall checked when npm ran it; npm 11 skips it on a
  // global install). Only on a Node the range admits: on any other the row above already fails. In a child, so a crash is reported.
  if (nodeSupport.kind === "supported" || nodeSupport.kind === "untested") {
    const opened = (deps.probeNativeSqlite ?? probeNativeSqliteForReal)();
    checks.push(opened.ok
      ? { name: "node_sqlite", status: "pass", message: "The SQLite binding opens a database on this Node." }
      : {
        name: "node_sqlite", status: "fail",
        message: "The SQLite binding (better-sqlite3) cannot open a database on this Node.",
        reason: opened.detail,
        fix: "Run 'npm rebuild better-sqlite3' in the CLI's install, or reinstall @openrig/cli with a supported Node.",
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

  // 6b. Vendored plugin folders the daemon ignores (workspaces-o9o.44). Read from disk, so it answers while the daemon is down.
  checks.push(buildVendoredPluginsCheck(deps.pluginsDir ?? getDefaultOpenRigPath("plugins")));
  // workspaces-o9o.106: a seat launched before the seat PATH head runs without the git worktree shim until relaunched.
  const seatProcesses = deps.readSeatProcesses();
  checks.push(buildSeatPathHeadCheck(seatProcesses, deps.openrigHome ?? getOpenRigHome()));
  // workspaces-o9o.173: a Claude seat whose guard's node or script is gone runs a degraded guard that refuses every kill.
  checks.push(buildSeatGuardCheck(seatProcesses, deps.openrigHome ?? getOpenRigHome(), deps.seatGuardFiles ?? SEAT_GUARD_FILES));

  // 7. Port availability (async) — daemon already running on that port counts as OK.
  // workspaces-o9o.181: the one resolver says which daemon this home means BEFORE anything is probed. A home that names
  // none is reported without probing; an explicit OPENRIG_URL or this home's recorded endpoint is asked directly; only a
  // configured target (OPR.0.4.7 slice-05 item-4b: host AND port, for checkPort, healthz and messages) is bind-checked.
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const home = resolveHomeDaemon({ configStore: deps.configStore, recordedUrl: deps.recordedDaemonUrl?.() });
  const portCheck = home.kind === "none"
    ? Promise.resolve<DoctorCheck>({
        name: "port",
        status: "fail",
        message: "This OPENRIG_HOME names no daemon of its own; nothing was probed.",
        reason: home.reason,
        fix: `Give this home its own port with ${setOff("rig config set daemon.port <port>")}, or set OPENRIG_URL to the daemon you mean.`,
      })
    : home.kind !== "configured"
      ? (async (): Promise<DoctorCheck> => {
          try {
            const res = await fetchFn(`${home.url.replace(/\/+$/, "")}/healthz`);
            if (res.ok) return { name: "port", status: "pass", message: `The daemon this home means (${home.url}) answers.` };
          } catch { /* no answer */ }
          return {
            name: "port",
            status: "fail",
            message: `The daemon this home means (${home.url}, from ${home.kind === "explicit" ? "OPENRIG_URL" : "daemon.json"}) did not answer.`,
            reason: "Commands that need the daemon will fail until it answers.",
            fix: `Check it with ${setOff("rig daemon status")}; if it is down, start it.`,
          };
        })()
      : configuredPortCheck(deps, home.host, home.port, fetchFn);

  const asyncChecks: Promise<DoctorCheck>[] = [portCheck];

  if (hcProbe.available) asyncChecks.push(buildHcCoreCheck(deps));
  asyncChecks.push(buildSpecConformanceCheck(deps));
  const slackSecretsEnvFile = deps.slackSecretsEnvFile;
  if (slackSecretsEnvFile) asyncChecks.push(slackSecretsEnvFile().then((f) => judgeSlackSecretsFile(f)));

  return { checks, portCheck, asyncChecks };
}

/** workspaces-o9o.181: the port check for a configured target (OPR.0.4.7 slice-05 item-4b: the configured host AND port). */
function configuredPortCheck(deps: DoctorDeps, daemonHost: string, daemonPort: number, fetchFn: NonNullable<DoctorDeps["fetch"]>): Promise<DoctorCheck> {
  const daemonBase = `http://${formatDaemonHostForUrl(daemonHost)}:${daemonPort}`;
  return deps.checkPort(daemonPort, daemonHost).then(async (available): Promise<DoctorCheck> => {
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
}

/** workspaces-o9o.181: the base URL of the daemon this home means, for doctor's live reads; null when it means none. */
function homeDaemonBase(): string | null {
  const home = resolveHomeDaemon({ recordedUrl: localDaemonUrl() });
  if (home.kind === "none") return null;
  return home.kind === "configured" ? `http://${formatDaemonHostForUrl(home.host)}:${home.port}` : home.url.replace(/\/+$/, "");
}

/** The running core's side of seat-host health: its protocol generation and version. It reads the core's socket and
 *  never starts one, so a machine with no core yet passes with a note. */
async function buildHcCoreCheck(deps: DoctorDeps): Promise<DoctorCheck> {
  const outcome = await (deps.readHcHello ?? (() => readHcHello()))();
  const core = classifyHcCore(outcome);
  if (core.code === "available") {
    // workspaces-o9o.165: the daemon refuses, and does not start against, a core at its socket that another state dir's core.json names
    // (core_not_this_instance); its log says so, and so does this check, which needs no running daemon. Judged with this shell's env,
    // the same rule the daemon applies to its own.
    const instance = outcome.kind === "hello" ? (deps.thisInstanceCore ?? (() => readThisInstanceCore(process.env)))() : null;
    // An unreadable core.json refuses whatever the core reports; another id refuses. A core that reports no id (an older hc) is
    // refused too once core.json names one (workspaces-87f, CoS ruling refining o9o.165 F4): the daemon refuses it as core_changed.
    const notMine = instance === null || outcome.kind !== "hello" ? null
      : instance.kind === "unreadable" ? notThisInstanceCore(instance, "")
      : outcome.coreId !== undefined ? notThisInstanceCore(instance, outcome.coreId)
      : null;
    if (!notMine && instance?.kind === "id" && outcome.kind === "hello" && outcome.coreId === undefined) {
      return {
        name: "hc_core", status: "fail",
        message: `hc core ${core.version} does not report its id, but this instance's state dir names core ${instance.id}; the daemon refuses it and does not start.`,
        reason: `This instance's core.json (${instance.file}) names core ${instance.id}. An hc that sends its id keeps sending it, so a core at this socket that sends none is taken for another core (core_changed).`,
        fix: "Have the operator stop the core that is there, or run the daemon with the HOME that core was started with; then rerun 'rig doctor'. A seat does neither: it reports this to the operator.",
      };
    }
    if (notMine) {
      return {
        name: "hc_core", status: "fail",
        message: "The hc core at this instance's socket is not this instance's core; the daemon refuses it and does not start.",
        reason: notMine,
        fix: "Have the operator stop the core that is there, or run the daemon with the HOME that core was started with; then rerun 'rig doctor'. A seat does neither: it reports this to the operator.",
      };
    }
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
 * workspaces-o9o.44 — a second folder in the plugins folder that registers a hook another folder already provides (an
 * operator's backup copy of openrig-core, say) once crash-looped the daemon. The daemon now ignores it and starts; this
 * check names the same folders, by the same rule, so the person can move them out. Nothing is moved or deleted here.
 */
function buildVendoredPluginsCheck(pluginsDir: string): DoctorCheck {
  const name = "vendored_plugins";
  const ignored = findIgnoredVendoredPlugins(pluginsDir);
  if (ignored.length === 0) return { name, status: "pass", message: `No duplicate plugin folders in ${pluginsDir}.` };
  return {
    name,
    status: "warn",
    message: ignored.map((i) => `${i.path} is ignored (${i.keptPath} is used): ${i.reason}.`).join(" "),
    reason: "Two folders in the plugins folder register the same hook. The daemon keeps one and ignores the other; it never moves or deletes either.",
    fix: `Move ${ignored.map((i) => i.path).join(", ")} out of ${pluginsDir}.`,
  };
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
    .description("Check installation, provider authentication, writable paths, port/daemon, the hc core, and this host before a first launch")
    .addHelpText("after", "\nWith --spec, compares declared and live topology. This is not an end-to-end readiness check.\nReports Claude and Codex authentication using setup's checks, including configured Codex credential variables. No agent task or provider request is tested.\nInspect your team with rig ps --nodes --rig <rig> and rig capture <seat> --lines 30.\nThe host rows check this machine before a first launch: a seat's login shell and the runtimes it finds (seat_shell, seat_runtime_*), the spec folders, the Pi operator login, inotify headroom, the git template and the registered remote hosts. seat_shell starts one login shell the way a seat launch does, so your login profile runs once; --no-seat-shell skips it. Nothing is changed: each problem row names its fix.");

  cmd
    .option("--json", "JSON output for agents")
    .option("--spec <path>", "Rig spec to check against the running rig of the same name (spec-vs-live topology)")
    .option("--no-seat-shell", "Skip the host check that starts one login shell the way a seat launch does")
    .action(async (opts: { json?: boolean; spec?: string; seatShell?: boolean }) => {
      const deps: DoctorDeps = depsOverride ?? {
        exists: existsSync,
        baseDir: import.meta.dirname,
        readFile: (p: string) => { try { return readFileSync(p, "utf-8"); } catch { return null; } },
        readCodexConfig: (p: string) => readCredentialFile(p, CODEX_CONFIG_POLICY), // o9o.160: Codex config under the credential rule
        exec: (c: string) => execSync(c, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }),
        checkPort: defaultCheckPort,
        recordedDaemonUrl: localDaemonUrl,
        configStore: new ConfigStore(),
        mkdirp: (dirPath: string) => mkdirSync(dirPath, { recursive: true }),
        checkWritable: (dirPath: string) => accessSync(dirPath, constants.W_OK),
        specPath: opts.spec ? path.resolve(opts.spec) : undefined,
        slackSecretsEnvFile: () => configuredSlackSecretsEnvFile(getOpenRigHome()),
        readSeatProcesses: () => readSeatProcesses(),
        // Returns null on ANY failure to read the live side. The conformance check treats null as
        // "unknown" and skips — an unreachable daemon must never read as a matching topology.
        fetchHostRows: async (input) => {
          const base = homeDaemonBase(); // workspaces-o9o.181: the one resolver; no daemon for this home: unknown, never the default
          if (base === null) return null;
          return fetchDaemonHostRows(fetch, base, terminalAuthHeaders(), input);
        },
        fetchLiveLogicalIds: async (rigName: string): Promise<string[] | null> => {
          const base = homeDaemonBase(); // workspaces-o9o.181: as above
          if (base === null) return null;
          try {
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
      const seatShell = opts.seatShell !== false;
      const hostChecks = await runHostReadinessChecks(deps, { seatShell });
      const allChecks = [...checks, ...resolvedAsync, ...hostChecks];
      const seatShellRan = seatShell && hostChecks.some((c) => c.name === "seat_shell" && c.status !== "skipped");
      const healthy = allChecks.every((c) => c.status !== "fail");

      if (opts.json) {
        console.log(JSON.stringify({ healthy, checks: allChecks, ...(seatShellRan ? { note: SEAT_SHELL_NOTE } : {}) }, null, 2));
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
      if (seatShellRan) console.log(SEAT_SHELL_NOTE);
      if (!healthy) process.exitCode = 1;
    });

  return cmd;
}

/** The real binding's open, in a child process (scripts/check-abi.mjs openInChildProcess). */
function probeNativeSqliteForReal(): { ok: true } | { ok: false; detail: string } {
  try {
    return openInChildProcess(createRequire(import.meta.url).resolve("better-sqlite3"), spawnSync);
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
