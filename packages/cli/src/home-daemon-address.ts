import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { ConfigStore } from "./config-store.js";
import { getOpenRigHome, readOpenRigEnv } from "./openrig-compat.js";

/**
 * workspaces-o9o.181: a CLI run with a temporary OPENRIG_HOME must not reach the default daemon.
 *
 * The CLI finds its daemon in this order: OPENRIG_URL (or RIGGED_URL); the home's daemon.json; then the configured
 * daemon.port/daemon.host (OPENRIG_PORT/OPENRIG_HOST, then the home's config.json); then the built-in default
 * 127.0.0.1:7433. For the default home (~/.openrig) that last step is intended: it still finds the daemon when daemon.json
 * is missing. For any OTHER home it reached whatever daemon listens on the default port (on a seat's host, the live one):
 * twice on 2026-11-18 a probe with a temporary OPENRIG_HOME read and wrote the live daemon that way.
 *
 * So a non-default home never falls back to the built-in default: with no daemon.json and no configured port or host, it
 * resolves NO daemon, and the CLI says why instead of sending anything.
 */

/** The address a DaemonClient gets when this home names no daemon: a reserved name that never resolves (RFC 6761
 *  ".invalid"), so nothing can be sent even past the client's own check, and every message names the reason. */
export const NO_HOME_DAEMON_URL = "http://no-daemon-for-this-openrig-home.invalid";

function realOrResolved(p: string): string {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

/** True when OPENRIG_HOME (or RIGGED_HOME) is set to a home other than the default `<user home>/.openrig` (compared by real
 *  path). `userHome` is the user's home directory; a test passes a fixture one, never the real home. */
export function isNonDefaultOpenRigHome(userHome: string = homedir()): boolean {
  if (readOpenRigEnv("OPENRIG_HOME", "RIGGED_HOME") === undefined) return false;
  return realOrResolved(getOpenRigHome()) !== realOrResolved(path.join(userHome, ".openrig"));
}

/**
 * Null when the configured daemon target may be used; otherwise why not: the home is non-default and neither the
 * environment nor the home's own config names a daemon port or host, so the only address left is the built-in default.
 * Consulted only after OPENRIG_URL and the home's daemon.json were found absent.
 */
export function homeWithoutDaemonAddress(options: { userHome?: string; configStore?: ConfigLike } = {}): string | null {
  if (!isNonDefaultOpenRigHome(options.userHome ?? homedir())) return null;
  if (configNamesDaemon(options.configStore ?? new ConfigStore())) return null;
  return `Daemon not running for OPENRIG_HOME ${getOpenRigHome()}: it names no daemon of its own (no daemon.json; no daemon.port or daemon.host in its config.json, OPENRIG_PORT or OPENRIG_HOST), and a home other than ~/.openrig never falls back to the default daemon at 127.0.0.1:7433.`;
}

/** The parts of a config store this reads: the resolved daemon target, and where each value came from when it can say. */
export type ConfigLike = Pick<ConfigStore, "resolve"> & Partial<Pick<ConfigStore, "resolveWithSource">>;

const BUILT_IN = { port: 7433, host: "127.0.0.1" };

/** True when the config explicitly names a daemon port or host: a value from the environment or the config file, or (for a
 *  store that cannot say where a value came from) any value other than the built-in default. Unreadable means no. */
function configNamesDaemon(store: ConfigLike): boolean {
  try {
    if (store.resolveWithSource) {
      return store.resolveWithSource("daemon.port").source !== "default" || store.resolveWithSource("daemon.host").source !== "default";
    }
    const { daemon } = store.resolve();
    return daemon.port !== BUILT_IN.port || daemon.host !== BUILT_IN.host;
  } catch {
    return false;
  }
}

/** What to do about it, for the error's action line. */
export const NO_HOME_DAEMON_ACTION =
  "Set OPENRIG_URL to the daemon you mean (a private one, or http://127.0.0.1:1 to stay offline), or start a daemon for this home with 'rig daemon start'.";
