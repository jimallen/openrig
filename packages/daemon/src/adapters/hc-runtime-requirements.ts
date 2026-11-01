// What a seat's runtime (Claude Code, Codex, Pi) needs from its host once the host is herdr-core and not tmux.
// Pure decisions and one version probe; nothing here starts a seat, touches a config file or reads a screen.
// Design: design-hc-cutover-20261031.md sections 7, 14 and 15. Each rule below names the source it rests on, and
// what is only argued from source rather than measured on a real agent.

import { unknownDaemonSupportMessage, type CodexDaemonSupport } from "../domain/codex-daemon-support.js";

// ── Codex: a minimum version ─────────────────────────────────────────────────────────────────────────────────────
// hc reads a program's state from OSC 7501. Codex began to emit it in 0.163.0 (openai/codex PR 52725, "Report
// terminal program status with OSC 7501", merged 2026-10-09, listed in the rust-v0.163.0 release notes). That is an
// argument from source and release notes. Measured on real seats (spike 4): 0.158 reported nothing, 0.166.0 did.
// Nothing between was run, so the floor OpenRig enforces is the lowest version that was measured.

/** The first release whose notes list OSC 7501 status reporting. Argued from source, not measured on a seat. */
export const CODEX_OSC_7501_FIRST_RELEASE = "0.163.0";
/** The lowest Codex a seat may run under hc: the lowest measured to report status (spike 4). Lower it toward
 *  CODEX_OSC_7501_FIRST_RELEASE only after a seat on 0.163 to 0.165 has been measured to report. */
export const CODEX_MINIMUM_VERSION = "0.166.0";

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated prerelease identifiers, or null for a release. */
  prerelease: string | null;
}

const SEMVER = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?/;

/** The first version in a tool's output (`codex-cli 0.166.0`, `0.163.0-alpha.1`), or null when there is none. */
export function parseSemVer(output: string): SemVer | null {
  const match = SEMVER.exec(output);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] ?? null };
}

/** Negative when `a` is older than `b`. A prerelease is older than its release, as in semver. */
export function compareSemVer(a: SemVer, b: SemVer): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  const left = a.prerelease.split(".");
  const right = b.prerelease.split(".");
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i];
    const r = right[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const ln = /^\d+$/.test(l) ? Number(l) : null;
    const rn = /^\d+$/.test(r) ? Number(r) : null;
    if (ln !== null && rn !== null) { if (ln !== rn) return ln < rn ? -1 : 1; continue; }
    if (ln !== null) return -1;
    if (rn !== null) return 1;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

export type CodexVersionCheck =
  | { kind: "ok"; version: string }
  | { kind: "too_old"; version: string; minimum: string }
  | { kind: "unknown"; detail: string };

/** Classifies one `codex --version` output. No version in it is `unknown`, never `ok`. */
export function checkCodexVersion(output: string, minimum: string = CODEX_MINIMUM_VERSION): CodexVersionCheck {
  const found = parseSemVer(output);
  if (!found) return { kind: "unknown", detail: "codex --version did not print a version" };
  const floor = parseSemVer(minimum);
  if (!floor) throw new Error(`minimum Codex version ${JSON.stringify(minimum)} is not a version`);
  const version = `${found.major}.${found.minor}.${found.patch}${found.prerelease ? `-${found.prerelease}` : ""}`;
  return compareSemVer(found, floor) < 0 ? { kind: "too_old", version, minimum } : { kind: "ok", version };
}

/** One `codex --version` run: `runVersion` resolves with its output or rejects. Failure is `unknown`. */
export async function probeCodexVersion(runVersion: () => Promise<string>, minimum: string = CODEX_MINIMUM_VERSION): Promise<CodexVersionCheck> {
  let output: string;
  try {
    output = await runVersion();
  } catch (error) {
    return { kind: "unknown", detail: `codex --version failed: ${String(error instanceof Error ? error.message : error).split("\n")[0]}` };
  }
  return checkCodexVersion(output, minimum);
}

export type CodexVersionDetector = (cwd: string) => Promise<CodexVersionCheck>;

/** The production detector for the Codex a seat in `cwd` would run: `codex --version` with the launch PATH, bounded.
 *  Same shape as codexDaemonSupportProbe, so the two answers describe one binary. */
export function codexVersionProbe(launchPath?: string, timeoutMs = 10_000, codexHome?: string, minimum: string = CODEX_MINIMUM_VERSION): CodexVersionDetector {
  return (cwd) => probeCodexVersion(async () => {
    const { execFile } = await import("node:child_process");
    const env = { ...process.env, ...(launchPath ? { PATH: launchPath } : {}), ...(codexHome ? { CODEX_HOME: codexHome } : {}) };
    let deadline: ReturnType<typeof setTimeout> | undefined;
    return new Promise<string>((resolve, reject) => {
      deadline = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
      execFile("codex", ["--version"], { cwd, env, timeout: timeoutMs, killSignal: "SIGKILL", encoding: "utf-8" }, (error, stdout) => {
        if (error) reject(error.killed ? new Error(`timed out after ${timeoutMs} ms`) : error);
        else resolve(stdout);
      });
    }).finally(() => clearTimeout(deadline));
  }, minimum);
}

// ── Codex: --no-daemon is required, not optional ─────────────────────────────────────────────────────────────────
// hc documents that Codex must run with --no-daemon "or its commands execute outside hc". On tmux a Codex whose
// `--help` lacks the flag (`legacy`) keeps the old invocation (codex-daemon-support.ts); under hc that Codex is also
// older than the version floor, but the daemon-support answer is checked on its own, so a floor lowered later cannot
// reopen a seat that runs outside hc.

/** The reason this Codex may not be a seat under hc, or null when it may. `daemon` is codex-daemon-support's answer. */
export function codexHcLaunchRefusal(version: CodexVersionCheck, daemon: CodexDaemonSupport): string | null {
  if (version.kind === "too_old") {
    return `Codex ${version.version} is older than ${version.minimum}, the oldest that reports its status to hc `
      + `(0.158 reported nothing). Seats on it lose activity state, so OpenRig did not launch it. Update the Codex the daemon's PATH finds.`;
  }
  if (version.kind === "unknown") {
    return `Cannot tell which Codex this seat would run (${version.detail}), so OpenRig did not launch it under hc. `
      + "Make sure `codex --version` runs in the seat's working directory with the daemon's PATH.";
  }
  if (daemon.kind === "unknown") return unknownDaemonSupportMessage(daemon.detail);
  if (daemon.kind === "legacy") {
    return "This Codex does not list --no-daemon. Under hc a Codex that shares one app-server daemon runs its commands "
      + "outside hc, so OpenRig did not launch it.";
  }
  return null;
}

/** The launch-time decision both Codex launch paths (prepareLaunch and resume) make when the host is hc: the version probe, then
 *  `codexHcLaunchRefusal` with the daemon-support answer the launch already has (one probe per launch). A probe that is not wired
 *  is not asked, as with `detectDaemonSupport` itself ("absent keeps the existing invocation"): production wires both in startup.ts,
 *  which a test pins, and an adapter composed without them (a fixture) is not refused for it. Returns the refusal text, or null. */
export async function codexHcPreflight(cwd: string, detectVersion: CodexVersionDetector | undefined, daemonSupport: CodexDaemonSupport | undefined): Promise<string | null> {
  const version: CodexVersionCheck = detectVersion ? await detectVersion(cwd) : { kind: "ok", version: CODEX_MINIMUM_VERSION };
  return codexHcLaunchRefusal(version, daemonSupport ?? { kind: "supported" });
}

// ── Codex: no self-update ────────────────────────────────────────────────────────────────────────────────────────
// Codex's startup update check is the config key `check_for_update_on_startup` (default true): codex-rs/tui/src/
// updates.rs returns no upgrade when it is false, so the prompt that offers `npm install -g @openai/codex` is never
// shown (config.schema.json: "Set to false only if your Codex updates are centrally managed"). `-c key=value` is a
// launch-local override. OpenRig already passes it on every Codex launch (adapters/kernel-authority.ts,
// baseOperationalLaunchArgs); the spike's self-update came from a Codex started by hand without it. This module
// only checks that a command still carries it.

export const CODEX_UPDATE_CHECK_KEY = "check_for_update_on_startup";

/** Splits a command the way a POSIX shell would, for plain words, single and double quotes and backslashes.
 *  Only what shellQuote produces and the launch builders type; no expansion, no operators. */
export function splitShellWords(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let inWord = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) throw new Error("unterminated single quote");
      current += command.slice(i + 1, end);
      i = end;
      inWord = true;
    } else if (c === '"') {
      inWord = true;
      for (i++; i < command.length && command[i] !== '"'; i++) {
        if (command[i] === "\\" && i + 1 < command.length && '"\\$`'.includes(command[i + 1]!)) i++;
        current += command[i]!;
      }
      if (i >= command.length) throw new Error("unterminated double quote");
    } else if (c === "\\" && i + 1 < command.length) {
      current += command[++i]!;
      inWord = true;
    } else if (/\s/.test(c)) {
      if (inWord) { words.push(current); current = ""; inWord = false; }
    } else {
      current += c;
      inWord = true;
    }
  }
  if (inWord) words.push(current);
  return words;
}

/** The words of a Codex launch before any `--`, which ends options. */
function codexOptionWords(argv: readonly string[]): readonly string[] {
  const end = argv.indexOf("--");
  return end < 0 ? argv : argv.slice(0, end);
}

/** True when the last `-c`/`--config` override of the update check in `argv` turns it off. The last one wins, so
 *  `-c check_for_update_on_startup=false ... -c check_for_update_on_startup=true` is on. */
export function codexArgvDisablesUpdateCheck(argv: readonly string[]): boolean {
  const words = codexOptionWords(argv);
  let state: boolean | null = null;
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    let override: string | undefined;
    if ((word === "-c" || word === "--config") && i + 1 < words.length) override = words[++i]!;
    else if (word.startsWith("--config=")) override = word.slice("--config=".length);
    if (override === undefined) continue;
    const eq = override.indexOf("=");
    if (eq < 0 || override.slice(0, eq).trim() !== CODEX_UPDATE_CHECK_KEY) continue;
    state = override.slice(eq + 1).trim() === "false" ? true : false;
  }
  return state === true;
}

/** True when the argv runs Codex with --no-daemon. Codex accepts it before or after resume/fork (its own test
 *  `resume_and_fork_preserve_no_daemon`), so position is not checked. */
export function codexArgvUsesNoDaemon(argv: readonly string[]): boolean {
  return codexOptionWords(argv).includes("--no-daemon");
}

/** The same two checks on a typed command line, as the tmux-era builders produce it. A line that cannot be split
 *  (an unterminated quote) passes neither. */
export function codexCommandDisablesUpdateCheck(command: string): boolean {
  try { return codexArgvDisablesUpdateCheck(splitShellWords(command)); } catch { return false; }
}
export function codexCommandUsesNoDaemon(command: string): boolean {
  try { return codexArgvUsesNoDaemon(splitShellWords(command)); } catch { return false; }
}

// ── Claude Code: no self-update ──────────────────────────────────────────────────────────────────────────────────
// Claude's installer updates itself in place in the background. Documented (code.claude.com setup and env-vars,
// read 2026-10-31; both names are also present as strings in the installed claude binary):
//   DISABLE_AUTOUPDATER=1  stops background updates; `claude update` still works.
//   DISABLE_UPDATES=1      blocks every update path, `claude update` and `claude install` included. The setup guide
//                          names it for a CLI shared by several sessions: an in-place npm upgrade removes the
//                          binary that other sessions are running.
// Not CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: it also stops auto-updates, but it makes Remote Control unavailable.
// OpenRig sets neither for a seat today (only the auth-status reader child gets DISABLE_AUTOUPDATER).

export const CLAUDE_SELF_UPDATE_OFF_ENV: Readonly<Record<string, string>> = Object.freeze({ DISABLE_UPDATES: "1" });

/** Env a seat of `runtime` needs so it cannot update the CLI it shares, to merge into `terminal.run.env`.
 *  Codex is switched off by a launch flag and Pi's RPC mode never checks (see the report), so they add nothing. */
export function selfUpdateOffEnv(runtime: string): Record<string, string> {
  return runtime === "claude-code" ? { ...CLAUDE_SELF_UPDATE_OFF_ENV } : {};
}

// ── Claude Code: Remote Control must survive a new launch path ───────────────────────────────────────────────────
// `--remote-control=<seat name>` is argv built by claude-remote-control.ts, so it does not depend on tmux. What can
// switch Remote Control off is the environment (code.claude.com remote-control, "Requirements"). Under hc a seat's
// env is the core's env plus `terminal.run.env`, and the API cannot unset a core variable, so these names must be
// removed by the launch wrapper (HcHost's `env -u`) when the seat declares Remote Control and its own env lacks them.

/** Unavailable whenever set (non-empty; DISABLE_GROWTHBOOK documents `1` or `true`). */
export const REMOTE_CONTROL_BLOCKING_ENV = ["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "DISABLE_GROWTHBOOK"] as const;
/** Unavailable only when the organization requires Trusted Devices, which the daemon cannot see. */
export const REMOTE_CONTROL_CONDITIONAL_ENV = ["DISABLE_TELEMETRY", "DO_NOT_TRACK"] as const;
/** Unavailable when it points at a host other than api.anthropic.com. */
export const REMOTE_CONTROL_ENDPOINT_ENV = "ANTHROPIC_BASE_URL";

/** Every name the launch wrapper should clear for a Remote Control seat that does not set it itself. */
export const REMOTE_CONTROL_ENV_NAMES: readonly string[] = [
  ...REMOTE_CONTROL_BLOCKING_ENV, ...REMOTE_CONTROL_CONDITIONAL_ENV, REMOTE_CONTROL_ENDPOINT_ENV,
];

export interface RemoteControlEnvFindings {
  /** Names in `env` that make Remote Control unavailable. */
  blocking: string[];
  /** Names in `env` that make it unavailable only under a Trusted Devices policy. */
  conditional: string[];
}

/** What in a seat's own env turns Remote Control off. Values are never returned, only names. */
export function remoteControlEnvFindings(env: Readonly<Record<string, string | undefined>>): RemoteControlEnvFindings {
  const set = (name: string) => (env[name] ?? "") !== "";
  const blocking: string[] = REMOTE_CONTROL_BLOCKING_ENV.filter(set);
  const endpoint = env[REMOTE_CONTROL_ENDPOINT_ENV];
  if (endpoint && !isAnthropicApiEndpoint(endpoint)) blocking.push(REMOTE_CONTROL_ENDPOINT_ENV);
  return { blocking, conditional: REMOTE_CONTROL_CONDITIONAL_ENV.filter(set) };
}

function isAnthropicApiEndpoint(value: string): boolean {
  try { return new URL(value).hostname === "api.anthropic.com"; } catch { return false; }
}
