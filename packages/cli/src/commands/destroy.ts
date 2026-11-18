import { Command } from "commander";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ConfigStore } from "../config-store.js";
import { formatDaemonHostForUrl, localDaemonUrl } from "../client.js";
import { resolveHomeDaemon } from "../home-daemon-address.js";
import { realDeps } from "./daemon.js";
import { getDefaultOpenRigPath, getPreferredOpenRigHome, readOpenRigEnv } from "../openrig-compat.js";
import {
  DESTROY_CONFIRM_TOKEN,
  buildDestroyPlan,
  executeDestroy,
  findListeningPidWithLsof,
  killHcSeatWithCore,
  listManagedHcSeatsFromDb,
  listManagedTmuxSessionsFromDb,
  type DestroyDeps,
  type ListenerInspection,
  type DestroyRuntimeConfig,
  type DestroyScope,
} from "../destroy-helpers.js";
import { stopDaemon } from "../daemon-lifecycle.js";
import { seatCommandRefusal } from "../seat-daemon-guard.js";

export interface DestroyCommandDeps {
  configStore: Pick<ConfigStore, "resolve">;
  destroyDeps: DestroyDeps;
}

interface ResolvedDestroyRuntime {
  runtimeConfig: DestroyRuntimeConfig;
  warnings: string[];
}

/**
 * workspaces-o9o.181 (verify-sec re-review): the one daemon rig destroy may probe and signal. There is NO compatibility default
 * of any kind. destroy works on local state only, so OPENRIG_URL is ignored. This home's daemon.json means exactly that
 * endpoint. A configured target counts only from a config that resolves here, never the resolver's built-in fallback for an
 * unreadable one. A home that names neither, and ANY failure on the way, means no daemon: nothing is probed or signalled, so
 * no config error can lead destroy to the default port's daemon.
 */
export function destroyDaemonTarget(configStore: Pick<ConfigStore, "resolve">): { host: string; port: number } | { none: string } {
  try {
    const home = resolveHomeDaemon({ explicitUrl: "", recordedUrl: localDaemonUrl(), configStore });
    if (home.kind === "none") return { none: home.reason };
    if (home.kind === "recorded") {
      const url = new URL(home.url);
      const port = Number(url.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return { none: `daemon.json records no usable port (${home.url}).` };
      return { host: url.hostname.replace(/^\[|\]$/g, ""), port };
    }
    if (home.kind !== "configured") return { none: "rig destroy only acts on this home's own daemon." };
    const config = configStore.resolve();
    return { host: config.daemon.host, port: config.daemon.port };
  } catch (err) {
    return { none: `The daemon this OpenRig home means could not be resolved (${err instanceof Error ? err.message : String(err)}); nothing will be probed or signalled.` };
  }
}

function resolveRuntimeConfig(configStore: Pick<ConfigStore, "resolve">): ResolvedDestroyRuntime {
  const warnings: string[] = [];
  const stateRoot = getPreferredOpenRigHome();
  const defaultDbPath = getDefaultOpenRigPath("openrig.sqlite");
  const defaultTranscriptsPath = getDefaultOpenRigPath("transcripts");
  const effectiveDefaultDbPath = join(stateRoot, "openrig.sqlite");
  const effectiveDefaultTranscriptsPath = join(stateRoot, "transcripts");
  const overrideUrl = readOpenRigEnv("OPENRIG_URL", "RIGGED_URL")?.trim();
  if (overrideUrl) {
    warnings.push(`Ignoring ${overrideUrl} from OPENRIG_URL/RIGGED_URL because rig destroy only operates on local state.`);
  }

  const daemon = destroyDaemonTarget(configStore);
  const daemonFields = "none" in daemon
    ? { daemonHost: "", daemonPort: 0, noDaemon: daemon.none }
    : { daemonHost: daemon.host, daemonPort: daemon.port };
  try {
    const config = configStore.resolve();
    return {
      runtimeConfig: {
        stateRoot,
        dbPath: config.db.path === defaultDbPath ? effectiveDefaultDbPath : config.db.path,
        transcriptsPath: config.transcripts.path === defaultTranscriptsPath ? effectiveDefaultTranscriptsPath : config.transcripts.path,
        ...daemonFields,
      },
      warnings,
    };
  } catch (err) {
    warnings.push(`Failed to read config; using the default database and transcripts paths instead: ${err instanceof Error ? err.message : String(err)}`);
    return {
      runtimeConfig: {
        stateRoot,
        dbPath: effectiveDefaultDbPath,
        transcriptsPath: effectiveDefaultTranscriptsPath,
        // workspaces-o9o.181 (verify-sec re-review): no compatibility daemon default. The daemon is this home's recorded
        // endpoint or nothing (destroyDaemonTarget: an unreadable config never yields a configured target).
        ...daemonFields,
      },
      warnings,
    };
  }
}

function realDestroyDeps(): DestroyDeps {
  const lifecycleDeps = realDeps();
  return {
    stopDaemon: async () => { await stopDaemon(lifecycleDeps); },
    inspectListener: async (host: string, port: number): Promise<ListenerInspection> => {
      try {
        const res = await fetch(`http://${formatDaemonHostForUrl(host)}:${port}/healthz`);
        if (!res.ok) {
          return {
            kind: "other_http",
            healthy: false,
            detail: `HTTP ${res.status}`,
          };
        }

        let body: unknown = null;
        try {
          body = await res.json();
        } catch {
          return {
            kind: "other_http",
            healthy: false,
            detail: "Response body was not valid OpenRig health JSON.",
          };
        }

        if (body && typeof body === "object" && (body as Record<string, unknown>).status === "ok") {
          return { kind: "openrig", healthy: true };
        }

        return {
          kind: "other_http",
          healthy: false,
          detail: "Response body did not match the OpenRig health contract.",
        };
      } catch {
        return { kind: "unreachable" };
      }
    },
    findListeningPid: findListeningPidWithLsof,
    killProcess: (pid: number) => {
      process.kill(pid, "SIGTERM");
    },
    exists: existsSync,
    renamePath: (from: string, to: string) => renameSync(from, to),
    removePath: (targetPath: string) => rmSync(targetPath, { recursive: true, force: true }),
    mkdirp: (targetPath: string) => mkdirSync(targetPath, { recursive: true }),
    listManagedTmuxSessions: listManagedTmuxSessionsFromDb,
    listManagedHcSeats: listManagedHcSeatsFromDb,
    killHcSeat: killHcSeatWithCore,
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => new Date(),
  };
}

function printPlan(
  scope: DestroyScope,
  backup: boolean,
  runtimeConfig: DestroyRuntimeConfig,
  managedTmuxSessions: string[],
  managedHcSeats: string[],
  warnings: string[]
): void {
  console.log("DESTROY PLAN");
  console.log(`  scope: ${scope}`);
  console.log(`  state root: ${runtimeConfig.stateRoot}`);
  console.log(runtimeConfig.noDaemon !== undefined
    ? "  daemon: none (this OPENRIG_HOME names no daemon of its own; nothing will be probed or signalled)"
    : `  daemon: http://${formatDaemonHostForUrl(runtimeConfig.daemonHost)}:${runtimeConfig.daemonPort}`);
  console.log(`  backup: ${backup ? "enabled" : "disabled"}`);
  console.log(`  tmux-bound seats: ${scope === "all" ? `${managedTmuxSessions.length} (this build runs no tmux: any stops the run before state is touched)` : "not looked at"}`);
  console.log(`  hc cleanup: ${scope === "all" ? `enabled (${managedHcSeats.length} managed seat${managedHcSeats.length === 1 ? "" : "s"})` : "disabled"}`);
  for (const warning of warnings) {
    console.log(`  warning: ${warning}`);
  }
  console.log("");
}

function printResult(result: Awaited<ReturnType<typeof executeDestroy>>): void {
  console.log("DESTROY RESULT");
  if (result.seatEnumerationFailures.length > 0) {
    console.log("  daemon: not touched (the seats could not be listed)");
    console.log("  port: not touched");
  } else {
    console.log(`  daemon: ${result.daemonStopped ? "stopped" : "still responding"}`);
    console.log(`  port: ${result.portCleared ? "cleared" : "still occupied"}`);
  }
  if (result.scope === "all") {
    console.log(`  tmux sessions removed: ${result.tmuxKilled}`);
    if (result.tmuxMissing > 0) {
      console.log(`  tmux sessions missing/already gone: ${result.tmuxMissing}`);
    }
    if (result.tmuxUnended.length > 0) console.log(`  tmux-bound seats NOT ended (this build runs no tmux): ${result.tmuxUnended.length}`);
  }
  if (result.scope === "all") {
    console.log(`  hc seats ended: ${result.hcKilled}`);
    if (result.hcMissing > 0) console.log(`  hc seats missing/already gone: ${result.hcMissing}`);
    if (result.hcRefused.length > 0) console.log(`  hc seats left untouched (foreign label), state kept: ${result.hcRefused.length}`);
    if (result.hcUnconfirmed.length > 0) console.log(`  hc seats NOT confirmed ended: ${result.hcUnconfirmed.length}`);
  }
  if (result.backupPaths.length > 0) {
    for (const backupPath of result.backupPaths) {
      console.log(`  backup: ${backupPath}`);
    }
  } else if (result.backup) {
    console.log("  backup: nothing to move");
  }
  console.log(result.stateRecreated ? `  fresh state root: ${result.stateRoot}` : "  fresh state root: not created (state left untouched)");
  for (const warning of result.warnings) {
    console.log(`  warning: ${warning}`);
  }
}

export function destroyCommand(depsOverride?: DestroyCommandDeps): Command {
  const cmd = new Command("destroy").description("Destroy OpenRig local state for recovery");

  cmd
    .option("--state", "Destroy OpenRig state and recreate an empty state root")
    .option("--all", "Destroy OpenRig state and remove managed tmux sessions")
    .option("--backup", "Move state aside instead of deleting it")
    .option("--yes", "Confirm the destructive operation")
    .option("--confirm <token>", `Exact confirmation token: ${DESTROY_CONFIRM_TOKEN}`)
    .action(async (opts: { state?: boolean; all?: boolean; backup?: boolean; yes?: boolean; confirm?: string }) => {
      // First, before any plan or backup: destroy stops the daemon, signals its listener, removes the state and ends the hc seats, and a failed
      // stop only warns, so the refusal in stopDaemon alone would not stop it (review of 6f813a07, F1).
      const refusal = seatCommandRefusal("rig destroy");
      if (refusal !== null) {
        console.error(refusal);
        process.exitCode = 1;
        return;
      }
      const selectedScopes = [opts.state ? "state" : null, opts.all ? "all" : null].filter(Boolean) as DestroyScope[];
      if (selectedScopes.length !== 1) {
        console.error("Specify exactly one destroy scope: --state or --all");
        process.exitCode = 1;
        return;
      }
      if (!opts.yes) {
        console.error("Destroy requires --yes");
        process.exitCode = 1;
        return;
      }
      if (opts.confirm !== DESTROY_CONFIRM_TOKEN) {
        console.error(`Destroy requires: --confirm ${DESTROY_CONFIRM_TOKEN}`);
        process.exitCode = 1;
        return;
      }

      const deps = depsOverride ?? {
        configStore: new ConfigStore(),
        destroyDeps: realDestroyDeps(),
      };

      const { runtimeConfig, warnings } = resolveRuntimeConfig(deps.configStore);
      const plan = buildDestroyPlan(selectedScopes[0]!, Boolean(opts.backup), runtimeConfig, deps.destroyDeps);
      printPlan(plan.scope, plan.backup, runtimeConfig, plan.managedTmuxSessions, plan.managedHcSeats, [...warnings, ...plan.warnings]);
      plan.warnings = [...warnings, ...plan.warnings];
      const result = await executeDestroy(plan, deps.destroyDeps);
      printResult(result);
      if (!result.portCleared || result.hcUnconfirmed.length > 0 || result.hcRefused.length > 0) {
        process.exitCode = 1;
      }
    });

  return cmd;
}
