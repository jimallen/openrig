import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { ConfigStore } from "./config-store.js";
import { getOpenRigHome, readOpenRigEnv } from "./openrig-compat.js";

/**
 * workspaces-o9o.181: which daemon an OpenRig home means. The ONE resolver every CLI path consults BEFORE any probe, request
 * or bind (verify-sec ruling): the client, daemon status and stop, doctor, crash-cart, the preflight, and every start path
 * (rig daemon start, rig start, rig up, auto-start).
 *
 * To reach a daemon, a home means, in order: OPENRIG_URL (or RIGGED_URL, or a caller's explicit address); its daemon.json;
 * then its configured daemon.port/daemon.host (OPENRIG_PORT/OPENRIG_HOST, then its config.json). For the default home
 * (~/.openrig) the configured target falls back to the built-in 127.0.0.1:7433, as before. A home other than ~/.openrig that
 * names none of these means NO daemon: twice on 2026-11-18 a probe with a temporary OPENRIG_HOME read and wrote the live
 * daemon by falling back to the default port.
 *
 * To START a daemon, a home needs a port to bind: an explicit --port, a configured daemon.port, or the default home's
 * built-in 7433. A home other than ~/.openrig with none refuses before any probe or bind (CoS ruling A, 2026-11-18): it
 * never starts on, or probes, the default port.
 */

/** The address a DaemonClient gets when this home names no daemon: a reserved name that never resolves (RFC 6761
 *  ".invalid"), so nothing can be sent even past the client's own check, and every message names the reason. */
export const NO_HOME_DAEMON_URL = "http://no-daemon-for-this-openrig-home.invalid";

/** The daemon a home means, for reaching it. `configured` carries the host and port; the caller formats the URL. */
export type HomeDaemon =
  | { kind: "explicit"; url: string }
  | { kind: "recorded"; url: string }
  | { kind: "configured"; host: string; port: number }
  | { kind: "none"; reason: string };

/** The parts of a config store this reads: the resolved daemon target, and where each value came from when it can say. */
export type ConfigLike = Pick<ConfigStore, "resolve"> & Partial<Pick<ConfigStore, "resolveWithSource">>;

export interface HomeDaemonInput {
  /** An address the caller was given (a --url, a constructor argument). Absent: OPENRIG_URL or RIGGED_URL. */
  explicitUrl?: string;
  /** The address this home's daemon.json records, read by the caller through its own deps. */
  recordedUrl?: string;
  configStore?: ConfigLike;
  /** The user's home directory; a test passes a fixture one, never the real home. */
  userHome?: string;
}

/** Which daemon this home means, for reaching it (see the module comment). */
export function resolveHomeDaemon(input: HomeDaemonInput = {}): HomeDaemon {
  // Both addresses are returned exactly as given (the client has always used OPENRIG_URL verbatim); "" counts as absent.
  const explicit = input.explicitUrl ?? readOpenRigEnv("OPENRIG_URL", "RIGGED_URL");
  if (explicit) return { kind: "explicit", url: explicit };
  if (input.recordedUrl) return { kind: "recorded", url: input.recordedUrl };
  const store = input.configStore ?? new ConfigStore();
  const nonDefault = isNonDefaultOpenRigHome(input.userHome ?? homedir());
  if (nonDefault && !configNames(store, "either")) return { kind: "none", reason: noDaemonReason() };
  try {
    const { daemon } = store.resolve();
    return { kind: "configured", host: daemon.host, port: daemon.port };
  } catch {
    // An unreadable config: the default home keeps its built-in fallback, as before; any other home means no daemon.
    return nonDefault ? { kind: "none", reason: noDaemonReason() } : { kind: "configured", ...BUILT_IN };
  }
}

/** Whether this home may start (bind) a daemon: null when it may, otherwise why not (see the module comment). */
export function homeBindRefusal(input: { explicitPort?: boolean; configStore?: ConfigLike; userHome?: string } = {}): string | null {
  if (input.explicitPort) return null;
  if (!isNonDefaultOpenRigHome(input.userHome ?? homedir())) return null;
  if (configNames(input.configStore ?? new ConfigStore(), "port")) return null;
  return `OPENRIG_HOME ${getOpenRigHome()} names no daemon port of its own (no daemon.port in its config.json, no OPENRIG_PORT), and a home other than ~/.openrig never starts a daemon on, or probes, the default port 127.0.0.1:7433. Nothing was started.`;
}

/** What to do about a home that names no daemon, for an error's action line. */
export const NO_HOME_DAEMON_ACTION =
  "Set OPENRIG_URL to the daemon you mean (a private one, or http://127.0.0.1:1 to stay offline), or give this home its own port (OPENRIG_PORT, or daemon.port in its config.json) and start its daemon with 'rig daemon start'.";

/** What to do about a home that may not start a daemon, for an error's action line. */
export const NO_HOME_BIND_ACTION =
  "Set OPENRIG_PORT (or daemon.port in this home's config.json, or pass --port) to a free port, or set OPENRIG_URL to the daemon you mean.";

/**
 * Null when the configured daemon target may be used; otherwise why not. Kept for callers that have already ruled out an
 * explicit address and a recorded one; new code asks resolveHomeDaemon.
 */
export function homeWithoutDaemonAddress(options: { userHome?: string; configStore?: ConfigLike } = {}): string | null {
  const home = resolveHomeDaemon({ explicitUrl: "", recordedUrl: undefined, ...options });
  return home.kind === "none" ? home.reason : null;
}

function realOrResolved(p: string): string {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

/** True when OPENRIG_HOME (or RIGGED_HOME) is set to a home other than the default `<user home>/.openrig` (compared by real
 *  path). `userHome` is the user's home directory; a test passes a fixture one, never the real home. */
export function isNonDefaultOpenRigHome(userHome: string = homedir()): boolean {
  if (readOpenRigEnv("OPENRIG_HOME", "RIGGED_HOME") === undefined) return false;
  return realOrResolved(getOpenRigHome()) !== realOrResolved(path.join(userHome, ".openrig"));
}

function noDaemonReason(): string {
  return `Daemon not running for OPENRIG_HOME ${getOpenRigHome()}: it names no daemon of its own (no daemon.json; no daemon.port or daemon.host in its config.json, OPENRIG_PORT or OPENRIG_HOST), and a home other than ~/.openrig never falls back to the default daemon at 127.0.0.1:7433.`;
}

const BUILT_IN = { port: 7433, host: "127.0.0.1" };

/** True when the config explicitly names the daemon's port (or, for "either", its port or host): a value from the environment
 *  or the config file, or (for a store that cannot say where a value came from) a value other than the built-in default.
 *  Unreadable means no. */
function configNames(store: ConfigLike, which: "port" | "either"): boolean {
  // The environment names a value without the config file (env wins over file in the store), so it counts even when the
  // home's config cannot be read (a 0600 home, or a config.json the credential rule refuses).
  if (readOpenRigEnv("OPENRIG_PORT", "RIGGED_PORT")) return true;
  if (which === "either" && readOpenRigEnv("OPENRIG_HOST", "RIGGED_HOST")) return true;
  try {
    if (store.resolveWithSource) {
      const port = store.resolveWithSource("daemon.port").source !== "default";
      return which === "port" ? port : port || store.resolveWithSource("daemon.host").source !== "default";
    }
    const { daemon } = store.resolve();
    const port = daemon.port !== BUILT_IN.port;
    return which === "port" ? port : port || daemon.host !== BUILT_IN.host;
  } catch {
    return false;
  }
}
