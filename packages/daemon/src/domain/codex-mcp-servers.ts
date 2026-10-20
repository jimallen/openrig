import { accessSync, constants, realpathSync, statSync } from "node:fs";
import nodePath from "node:path";

/**
 * Per-member Codex MCP servers (`mcp_servers` on a codex member of a rig spec).
 *
 * The spec DECLARES a server; no seat runs it until one seat instance is switched on
 * (`rig seat set-mcp`). This module owns the one shape every surface agrees on: what a
 * declaration may contain (validated at spec load, again at the switch, again before a
 * launch renders it), and where its executable may live.
 *
 * Only a stdio server with a fixed command line is accepted. Every key that would let a
 * spec reach further is refused by name: an environment (`env`, `env_vars`), a network
 * transport or its credentials (`url`, `bearer_token_env_var`, `http_headers`,
 * `env_http_headers`), and a working directory (`cwd`). `enabled_tools` is required, so a
 * declaration always names the exact tools the seat gets.
 */
export interface CodexMcpServerDeclaration {
  command: string;
  args: string[];
  enabledTools: string[];
  startupTimeoutSec?: number;
  toolTimeoutSec?: number;
}

export type CodexMcpServers = Record<string, CodexMcpServerDeclaration>;

export const MCP_SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const ALLOWED_KEYS = ["command", "args", "enabled_tools", "startup_timeout_sec", "tool_timeout_sec"] as const;
/** Codex server keys a spec may not set, named so the refusal says why. */
export const REFUSED_MCP_KEYS = ["env", "env_vars", "url", "bearer_token_env_var", "http_headers", "env_http_headers", "cwd"] as const;
const MAX_TIMEOUT_SEC = 3600;

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Text Codex receives byte for byte: no control characters (C0, DEL) and well-formed UTF-16, so the
 *  TOML rendering below never needs anything but JSON's escapes. */
function cleanText(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001f\u007f]/.test(value)
    && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);
}

/** Shape errors for one member's `mcp_servers` block (empty = valid). Reads nothing from disk. */
export function validateMcpServersBlock(raw: unknown, runtime: unknown, prefix: string): string[] {
  const at = `${prefix}.mcp_servers`;
  if (!isMapping(raw)) return [`${at}: must be a mapping of server name to server`];
  const errors: string[] = [];
  if (runtime !== "codex") errors.push(`${at}: only valid when runtime is "codex"`);
  const names = Object.keys(raw);
  if (names.length === 0) errors.push(`${at}: must declare at least one server (omit the key instead)`);
  for (const name of names) {
    const sp = `${at}.${name}`;
    if (!MCP_SERVER_NAME.test(name)) errors.push(`${at}: server name "${name}" must be 1-64 letters, digits, underscores or hyphens`);
    const server = raw[name];
    if (!isMapping(server)) { errors.push(`${sp}: must be a mapping`); continue; }
    for (const key of Object.keys(server)) {
      if ((REFUSED_MCP_KEYS as readonly string[]).includes(key)) {
        errors.push(`${sp}.${key}: not allowed; a rig spec may declare only a stdio server's command, args, enabled_tools and timeouts`);
      } else if (!(ALLOWED_KEYS as readonly string[]).includes(key)) {
        errors.push(`${sp}.${key}: unknown key; allowed: ${ALLOWED_KEYS.join(", ")}`);
      }
    }
    const command = server["command"];
    if (typeof command !== "string" || !command.trim()) errors.push(`${sp}.command: required non-empty string`);
    else if (!cleanText(command)) errors.push(`${sp}.command: must not contain control characters`);
    else if (!nodePath.isAbsolute(command)) errors.push(`${sp}.command: must be an absolute path (got "${command}")`);
    const args = server["args"];
    if (args !== undefined) {
      if (!Array.isArray(args)) errors.push(`${sp}.args: must be a list of strings`);
      else args.forEach((a, i) => {
        if (typeof a !== "string") errors.push(`${sp}.args[${i}]: must be a string`);
        else if (!cleanText(a)) errors.push(`${sp}.args[${i}]: must not contain control characters`);
      });
    }
    const tools = server["enabled_tools"];
    if (tools === undefined) errors.push(`${sp}.enabled_tools: required; list the exact tools this seat may call`);
    else if (!Array.isArray(tools) || tools.length === 0) errors.push(`${sp}.enabled_tools: must be a non-empty list of tool names`);
    else tools.forEach((t, i) => {
      if (typeof t !== "string" || !TOOL_NAME.test(t)) errors.push(`${sp}.enabled_tools[${i}]: must be a tool name (letters, digits, '_', '.', '-')`);
    });
    for (const key of ["startup_timeout_sec", "tool_timeout_sec"] as const) {
      const v = server[key];
      if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > MAX_TIMEOUT_SEC)) {
        errors.push(`${sp}.${key}: must be a number of seconds greater than 0 and at most ${MAX_TIMEOUT_SEC}`);
      }
    }
  }
  return errors;
}

/** The typed form of a block that validateMcpServersBlock accepted. */
export function normalizeMcpServers(raw: unknown): CodexMcpServers | undefined {
  if (!isMapping(raw)) return undefined;
  const out: CodexMcpServers = {};
  for (const [name, value] of Object.entries(raw)) {
    const s = value as Record<string, unknown>;
    out[name] = {
      command: s["command"] as string,
      args: Array.isArray(s["args"]) ? [...(s["args"] as string[])] : [],
      enabledTools: [...(s["enabled_tools"] as string[])],
      ...(typeof s["startup_timeout_sec"] === "number" ? { startupTimeoutSec: s["startup_timeout_sec"] } : {}),
      ...(typeof s["tool_timeout_sec"] === "number" ? { toolTimeoutSec: s["tool_timeout_sec"] } : {}),
    };
  }
  return out;
}

/** The spec spelling of a typed declaration (serialization and stored snapshots). */
export function serializeMcpServer(d: CodexMcpServerDeclaration): Record<string, unknown> {
  return {
    command: d.command,
    ...(d.args.length ? { args: [...d.args] } : {}),
    enabled_tools: [...d.enabledTools],
    ...(d.startupTimeoutSec !== undefined ? { startup_timeout_sec: d.startupTimeoutSec } : {}),
    ...(d.toolTimeoutSec !== undefined ? { tool_timeout_sec: d.toolTimeoutSec } : {}),
  };
}

function inside(child: string, parent: string): boolean {
  const rel = nodePath.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !nodePath.isAbsolute(rel));
}

function realOrSelf(p: string): string {
  try { return realpathSync(p); } catch { return nodePath.resolve(p); }
}

/**
 * Where a declared server's executable may be. Content the seat or the spec controls must never
 * choose the program: the command, followed through its links, may not lie inside the seat's
 * working directory or inside the directory the spec was read from (an archive could ship it).
 * `requireExecutable` also demands an existing executable regular file (the switch and the launch);
 * spec preflight leaves a missing binary to a warning, since a declared server is off by default.
 */
export function mcpServerPlacementProblem(
  server: Pick<CodexMcpServerDeclaration, "command">,
  roots: { seatCwd?: string | null; specDir?: string | null },
  opts: { requireExecutable: boolean },
): string | null {
  let real: string;
  try {
    real = realpathSync(server.command);
  } catch {
    if (opts.requireExecutable) return `its command ${server.command} does not exist`;
    real = nodePath.resolve(server.command);
  }
  for (const [label, root] of [["the seat's working directory", roots.seatCwd], ["the rig spec's directory", roots.specDir]] as const) {
    if (!root) continue;
    const r = realOrSelf(root);
    if (inside(real, r) || inside(nodePath.resolve(server.command), r)) {
      return `its command ${server.command} lies inside ${label} (${r}), so content there could choose the program`;
    }
  }
  if (opts.requireExecutable) {
    try {
      if (!statSync(real).isFile()) return `its command ${server.command} is not a regular file`;
      accessSync(real, constants.X_OK);
    } catch {
      return `its command ${server.command} is not executable`;
    }
  }
  return null;
}
