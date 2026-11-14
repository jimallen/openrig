import path from "node:path";
import { getSeatCwdFault } from "./cwd-resolution.js";

/**
 * A seat's own Claude Code config home (spec `claude_config_dir`, `rig seat set-claude-home`).
 *
 * Claude Code names a config home's login after the EXACT `CLAUDE_CONFIG_DIR` string (on macOS the keychain item is
 * `Claude Code-credentials-<first 8 hex of sha256(value)>`; measured with Claude Code 2.1.325: `/Users/x/.claude-y`,
 * `/Users/x/.claude-y/` and `~/.claude-y` name three different items). So OpenRig stores and exports one canonical
 * spelling: absolute, `~/` expanded against the daemon's HOME, no trailing slash, no `.`/`..` segments. A relative
 * value is refused (it would resolve against each seat's working directory).
 *
 * The default home is never written: an exported `CLAUDE_CONFIG_DIR=$HOME/.claude` is not the unset default (it
 * selects `<dir>/.claude.json` and a suffixed keychain item: #154/#225), so `$HOME/.claude` is refused and "back to
 * the default" is the absence of a value (unset, nothing exported).
 */

export const CLAUDE_CONFIG_DIR_FIELD = "claude_config_dir";

/** The checks that need no HOME: shape only. Null when the raw value is acceptable before expansion. */
export function claudeConfigDirShapeError(raw: unknown): string | null {
  if (typeof raw !== "string") return "must be a text value (an absolute path or ~/<path>)";
  if (raw.length === 0) return "must not be empty; omit the field for the daemon's default Claude home";
  if (raw.trim() !== raw) return "must not start or end with whitespace";
  if (/[\0\n\r]/.test(raw)) return "must not contain NUL or line breaks";
  if (raw === "~" || !(raw.startsWith("/") || raw.startsWith("~/"))) {
    return "must be an absolute path or start with ~/ (a relative path would resolve against each seat's working directory)";
  }
  const body = raw.startsWith("~/") ? raw.slice(2) : raw.slice(1);
  if (body.split("/").some((segment) => segment === "." || segment === "..")) return "must not contain . or .. segments";
  return null;
}

export type ClaudeConfigDirResult = { ok: true; value: string } | { ok: false; reason: string };

/** The one canonical spelling of a seat's Claude home, or why the value is refused. */
export function normalizeClaudeConfigDir(raw: unknown, home: string | undefined): ClaudeConfigDirResult {
  const shape = claudeConfigDirShapeError(raw);
  if (shape) return { ok: false, reason: shape };
  const text = raw as string;
  let absolute = text;
  if (text.startsWith("~/")) {
    if (!home || !path.isAbsolute(home)) return { ok: false, reason: "starts with ~/ but the daemon's HOME is not an absolute path" };
    absolute = path.join(home, text.slice(2));
  }
  // path.resolve collapses repeated and trailing slashes; the segment check above already refused . and ..
  const value = path.resolve(absolute);
  if (value === path.parse(value).root) return { ok: false, reason: "must not be the filesystem root" };
  if (home && path.isAbsolute(home)) {
    const h = path.resolve(home);
    if (value === h) return { ok: false, reason: "must not be the home directory itself" };
    if (value === path.join(h, ".claude")) {
      return { ok: false, reason: `${value} is the default Claude home; omit the field (or clear the seat's choice) to use it, since exporting it explicitly selects a different login` };
    }
  }
  return { ok: true, value };
}

/** The daemon's HOME, as the launch environment gives it to seats. */
export function daemonHomeForClaudeConfigDir(env: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
  return env.HOME;
}

/** Launch-time check: the stored home must still be a directory. OpenRig never creates one: a new home has no login. */
export function claudeConfigDirLaunchRefusal(dir: string | null | undefined, fault: (dir: string) => ReturnType<typeof getSeatCwdFault> = getSeatCwdFault): string | null {
  if (!dir) return null;
  const found = fault(dir);
  if (!found) return null;
  const what = found.kind === "missing" ? "does not exist" : found.what;
  return `claude_config_dir_missing: the seat's Claude config home ${dir} ${what}; create it and log in to it (CLAUDE_CONFIG_DIR=${dir} claude), or clear the seat's choice with rig seat set-claude-home <seat> --clear`;
}

/** The launch environment a seat's own Claude home adds: `{ CLAUDE_CONFIG_DIR }` when the node has one, else nothing. */
export function seatClaudeConfigDirEnv(node: { claudeConfigDir?: string | null } | null | undefined): { CLAUDE_CONFIG_DIR?: string } {
  return node?.claudeConfigDir ? { CLAUDE_CONFIG_DIR: node.claudeConfigDir } : {};
}

/**
 * What a seat's Claude home lacks for an unattended seat, read-only and names only. OpenRig never writes a home's
 * user-level settings; these are findings for the operator. Never opens a credential file; the login itself is not
 * checked here (`CLAUDE_CONFIG_DIR=<dir> claude auth status` answers it).
 */
export function claudeConfigDirFindings(dir: string, opts: { fullBypass: boolean; nonInterruptive: boolean },
  read: { exists: (p: string) => boolean; isDirectory: (p: string) => boolean; readFile: (p: string) => string }): string[] {
  const findings: string[] = [];
  if (!read.exists(dir) || !read.isDirectory(dir)) {
    findings.push(`${dir} is not a directory: the seat will refuse to launch until it exists and is logged in (CLAUDE_CONFIG_DIR=${dir} claude)`);
    return findings;
  }
  if (!read.exists(path.join(dir, ".claude.json"))) {
    findings.push(`${dir}/.claude.json is missing: Claude has never run with this home, so it is probably not logged in (CLAUDE_CONFIG_DIR=${dir} claude)`);
  }
  if (opts.fullBypass && !opts.nonInterruptive) {
    let skip = false;
    const settings = path.join(dir, "settings.json");
    try {
      const parsed = read.exists(settings) ? JSON.parse(read.readFile(settings)) as unknown : null;
      skip = typeof parsed === "object" && parsed !== null && (parsed as Record<string, unknown>)["skipDangerousModePermissionPrompt"] === true;
    } catch { /* unparseable: reported as not set */ }
    if (!skip) {
      findings.push(`${settings} does not set skipDangerousModePermissionPrompt: this full-bypass seat's rig is not non-interruptive, so each launch stops at Claude's bypass-permissions warning`);
    }
  }
  return findings;
}
