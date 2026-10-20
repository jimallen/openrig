import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import nodePath from "node:path";
import { parse as parseToml } from "smol-toml";

/**
 * Per-member Codex MCP servers (`mcp_servers` on a codex member of a rig spec).
 *
 * The spec DECLARES a server; no seat runs it until one seat instance is switched on
 * (`rig seat set-mcp`). This module owns the one shape every surface agrees on: what a
 * declaration may contain (validated at spec load, again at the switch, again before a
 * launch renders it), and where its executable may live.
 *
 * Only a stdio server with a fixed command line is accepted: a SPEC may set command, args,
 * enabled_tools (required) and two timeouts, and nothing else (env, env_vars, url, headers, cwd and
 * the other Codex server keys are refused).
 *
 * That is a statement about the spec, not by itself about what Codex runs. Codex MERGES a `-c
 * mcp_servers.<name>={...}` override with a same-named server defined in any other config layer (the
 * shared config.toml, a trusted project's `.codex/config.toml`, a selected profile); measured by the
 * security review of 97aa027b: an `env` and `cwd` from the shared file reached the declared server.
 * So every launch also refuses a server whose NAME is already defined in one of those layers
 * (codexConfigServerNames; names only, values are never kept).
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
/** Seconds. Below one second Codex rounds a startup timeout to 0 (measured by the security review:
 *  5e-324 arrived as startup_timeout_sec 0), so tiny and denormal values are refused, not just <= 0. */
const MIN_TIMEOUT_SEC = 1;
const MAX_TIMEOUT_SEC = 3600;
/** OpenRig proves a running Codex's identity from its `ps` line, which flattens argv on whitespace
 *  (native-process-lineage tokens). The rendered `-c` value must stay ONE token there, or the resume
 *  token after it would be misread; so no declared string may contain whitespace. */
const NO_WHITESPACE = "must not contain whitespace (a seat's process line must split back into the arguments it was launched with)";

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Text Codex receives byte for byte and an operator can read: no control characters (C0, DEL, C1),
 *  no format characters (bidi overrides, zero-width, BOM, soft hyphen), no line or paragraph separators
 *  (U+2028/2029), no private-use code points and no lone surrogates. What remains needs nothing but
 *  JSON's escapes to be a TOML basic string. */
const NON_PRINTING = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cs}]/u;
function cleanText(value: string): boolean {
  return !NON_PRINTING.test(value);
}

/** A server name that is also a property of every object (`__proto__`, `constructor`, `toString`, ...)
 *  would be lost or hijack an ordinary object map; it is refused outright. */
export function isPrototypeName(name: string): boolean {
  return name === "__proto__" || Object.prototype.hasOwnProperty.call(Object.prototype, name);
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
    else if (isPrototypeName(name)) errors.push(`${at}: server name "${name}" is reserved (an object property name)`);
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
    else if (!cleanText(command)) errors.push(`${sp}.command: must not contain control, format or separator characters`);
    else if (/\s/.test(command)) errors.push(`${sp}.command: ${NO_WHITESPACE}`);
    else if (!nodePath.isAbsolute(command)) errors.push(`${sp}.command: must be an absolute path (got "${command}")`);
    const args = server["args"];
    if (args !== undefined) {
      if (!Array.isArray(args)) errors.push(`${sp}.args: must be a list of strings`);
      else args.forEach((a, i) => {
        if (typeof a !== "string") errors.push(`${sp}.args[${i}]: must be a string`);
        else if (!cleanText(a)) errors.push(`${sp}.args[${i}]: must not contain control, format or separator characters`);
        else if (/\s/.test(a)) errors.push(`${sp}.args[${i}]: ${NO_WHITESPACE}`);
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
      if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v < MIN_TIMEOUT_SEC || v > MAX_TIMEOUT_SEC)) {
        errors.push(`${sp}.${key}: must be a number of seconds from ${MIN_TIMEOUT_SEC} to ${MAX_TIMEOUT_SEC}`);
      }
    }
  }
  return errors;
}

/** The typed form of a block that validateMcpServersBlock accepted. */
export function normalizeMcpServers(raw: unknown): CodexMcpServers | undefined {
  if (!isMapping(raw)) return undefined;
  // Null prototype: a key can only ever be an own entry, whatever its name.
  const out = Object.create(null) as CodexMcpServers;
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
 * Where a declared server's executable may be. Content another principal controls must never choose the
 * program (security review N3): the command may not lie in the seat's working directory, the directory the
 * spec was read from (an archive could ship it), ANY git work tree (a merge or a peer seat could change it)
 * or ANY `.workspaces` directory (a sibling seat's folder). Both the path as written and the file it
 * resolves to are judged, so a link cannot launder either side. The resolved file and every directory
 * above it must be owned by this user or root and not writable by group or others; a group- or
 * world-writable directory is accepted only with the sticky bit (as /tmp), where others cannot rename or
 * replace the entry below it. `requireExecutable` (the switch and every launch) also demands an existing
 * executable regular file; spec preflight leaves a missing binary to a warning.
 */
export function mcpServerPlacementProblem(
  server: Pick<CodexMcpServerDeclaration, "command">,
  roots: { seatCwd?: string | null; specDir?: string | null },
  opts: { requireExecutable: boolean },
): string | null {
  const written = nodePath.resolve(server.command);
  let real: string;
  let exists = true;
  try {
    real = realpathSync(server.command);
  } catch {
    if (opts.requireExecutable) return `its command ${server.command} does not exist`;
    real = written;
    exists = false;
  }
  for (const p of written === real ? [real] : [written, real]) {
    for (const [label, root] of [["the seat's working directory", roots.seatCwd], ["the rig spec's directory", roots.specDir]] as const) {
      if (!root) continue;
      const r = realOrSelf(root);
      if (inside(p, r) || inside(p, nodePath.resolve(root))) {
        return `its command ${server.command} lies inside ${label} (${r}), so content there could choose the program`;
      }
    }
    const tree = controlledTree(p);
    if (tree) return `its command ${server.command} lies inside ${tree}, so content there could choose the program`;
  }
  if (exists) {
    const unsafe = unsafeOwnership(real);
    if (unsafe) return `its command ${server.command} is not protected: ${unsafe}`;
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

/** The nearest enclosing git work tree or `.workspaces` directory of a path, described; null when none. */
function controlledTree(p: string): string | null {
  let d = nodePath.dirname(p);
  for (;;) {
    if (nodePath.basename(d) === ".workspaces") return `the seat workspaces directory ${d}`;
    if (existsSync(nodePath.join(d, ".git"))) return `the git work tree ${d}`;
    const up = nodePath.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/** Why the resolved file or a directory above it could be changed by someone else; null when it cannot. */
function unsafeOwnership(real: string): string | null {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid === undefined) return null; // no POSIX ownership to judge (Windows)
  let p = real;
  for (;;) {
    let st;
    try { st = statSync(p); } catch { return `${p} cannot be inspected`; }
    if (st.uid !== uid && st.uid !== 0) return `${p} is owned by uid ${st.uid}, not by you or root`;
    if ((st.mode & 0o022) !== 0 && !(p !== real && st.isDirectory() && (st.mode & 0o1000) !== 0)) {
      return `${p} is writable by group or others`;
    }
    const up = nodePath.dirname(p);
    if (up === p) return null;
    p = up;
  }
}

/** One switched-on server for one seat: the declaration snapshot and the spec directory it came from. */
export interface SeatMcpServer {
  name: string;
  declaration: CodexMcpServerDeclaration;
  /** Directory of the spec file the declaration was read from; the command may not lie inside it. */
  specDir: string | null;
  /** sha256 of the binary the command resolved to when the server was switched on (Jim, 2026-10-20). */
  commandSha256: string;
}

/** sha256 (hex) of the file a command resolves to now; null when it cannot be read. */
export function commandBinarySha256(command: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(realpathSync(command))).digest("hex");
  } catch {
    return null;
  }
}

/** What a launch path is told about a seat: its switched-on servers, or why they cannot be read. */
export type SeatMcpSelection = { ok: true; servers: SeatMcpServer[] } | { ok: false; error: string };

/** TOML basic string. Validation already refused control characters and lone surrogates, and for every
 *  other character JSON's escapes (\" and \\) are TOML's escapes too. */
const tomlString = (value: string) => JSON.stringify(value);

/** The single `-c mcp_servers.<name>={...}` inline-table override for one server (no leading space). */
export function renderCodexMcpOverride(server: SeatMcpServer): string {
  const d = server.declaration;
  const parts = [`command=${tomlString(d.command)}`, `args=[${d.args.map(tomlString).join(",")}]`];
  if (d.startupTimeoutSec !== undefined) parts.push(`startup_timeout_sec=${d.startupTimeoutSec}`);
  if (d.toolTimeoutSec !== undefined) parts.push(`tool_timeout_sec=${d.toolTimeoutSec}`);
  parts.push(`enabled_tools=[${d.enabledTools.map(tomlString).join(",")}]`);
  return `mcp_servers.${server.name}={${parts.join(",")}}`;
}

/**
 * The launch segment for a seat's switched-on servers: one ` -c '<override>'` per server, in name
 * order, quoted with the fork's shellQuote. Every server is re-validated (shape, then place, with an
 * existing executable required) before anything is rendered, so a malformed or misplaced declaration
 * refuses the launch with the remedy instead of reaching Codex. No selection, or none switched on,
 * renders "" and the command is byte-identical to a launch without this feature.
 */
export function prepareSeatMcpLaunchArgs(
  selection: SeatMcpSelection | undefined,
  seatCwd: string,
  quote: (value: string) => string,
  /** The sandbox this launch actually passes (observed from its posture flags); null when a profile decides. */
  sandbox: string | null,
  /** Server names other Codex config layers already define; asked only when a server is switched on. */
  existingNames?: () => ReturnType<typeof codexConfigServerNames>,
): { ok: true; arg: string; warnings: string[] } | { ok: false; error: string } {
  if (!selection) return { ok: true, arg: "", warnings: [] };
  if (!selection.ok) return { ok: false, error: `Codex MCP servers for this seat cannot be read: ${selection.error}` };
  const servers = [...selection.servers].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  let arg = "";
  const warnings: string[] = [];
  const taken = servers.length && existingNames ? existingNames() : { ok: true as const, names: new Map<string, string>() };
  if (!taken.ok) return { ok: false, error: `Codex MCP servers for this seat cannot start: ${taken.error}` };
  for (const server of servers) {
    const remedy = `turn it off with: rig seat set-mcp <seat> ${server.name} off`;
    const shape = validateMcpServersBlock({ [server.name]: serializeMcpServer(server.declaration) }, "codex", "seat");
    if (shape.length) return { ok: false, error: `Codex MCP server "${server.name}" for this seat is not valid (${shape.join("; ")}); ${remedy}` };
    const definedIn = taken.names.get(server.name);
    if (definedIn) {
      return { ok: false, error: `Codex MCP server "${server.name}" for this seat cannot start: a server named "${server.name}" is already defined in ${definedIn}, and Codex would merge that definition (its env, cwd or transport) into this one; remove or rename it there, or ${remedy}` };
    }
    const again = `switch it on again to accept the new binary (rig seat set-mcp <seat> ${server.name} on --reason ...), or ${remedy}`;
    const place = mcpServerPlacementProblem(server.declaration, { seatCwd, specDir: server.specDir }, { requireExecutable: true });
    if (place) {
      return { ok: false, error: `Codex MCP server "${server.name}" for this seat cannot start: ${place}; ${/does not exist$/.test(place) ? again : remedy}` };
    }
    // The binary pinned at switch-on, recomputed at every launch: an upgrade, an edit or a retargeted link
    // is refused until an operator switches the server on again.
    const now = commandBinarySha256(server.declaration.command);
    if (now !== server.commandSha256) {
      return { ok: false, error: `Codex MCP server "${server.name}" for this seat cannot start: its command ${server.declaration.command} now resolves to a binary whose sha256 (${now ?? "unreadable"}) differs from the one switched on (${server.commandSha256}); ${again}` };
    }
    arg += ` -c ${quote(renderCodexMcpOverride(server))}`;
    // Measured (design report M9, review N1): Codex does not sandbox MCP server processes. Jim's rule:
    // allow on a seat that is not full_bypass, and say so at every launch.
    if (sandbox !== "danger-full-access") warnings.push(unsandboxedServerWarning(server.name, `this launch's sandbox is ${sandbox ?? "decided by a Codex profile"}, not danger-full-access`));
  }
  return { ok: true, arg, warnings };
}

/** The warning for a server that will run with the user's full rights on a seat whose own commands are sandboxed. */
export function unsandboxedServerWarning(name: string, why: string): string {
  return `Codex MCP server "${name}" runs outside Codex's sandbox with your full user rights (${why}); it can do what this seat's own commands cannot.`;
}

/** The Codex config files whose `mcp_servers` tables a `-c mcp_servers.<name>` override would merge with:
 *  the shared config.toml, a selected profile file, and every `.codex/config.toml` from the seat's working
 *  directory up to the root (Codex reads a trusted project's; checking all of them is the stricter reading). */
export function codexConfigLayerFiles(input: { sharedCodexHome: string; seatCwd: string; profileFile?: string | null }): string[] {
  const files = [nodePath.join(input.sharedCodexHome, "config.toml")];
  if (input.profileFile) files.push(input.profileFile);
  let d = nodePath.resolve(input.seatCwd);
  for (;;) {
    files.push(nodePath.join(d, ".codex", "config.toml"));
    const up = nodePath.dirname(d);
    if (up === d) break;
    d = up;
  }
  return files;
}

/** Server NAMES already defined in those files (name -> first file defining it). Each existing file is
 *  parsed and only the keys of its `mcp_servers` table are kept; no value is returned, logged or stored. A
 *  file that exists but cannot be read or parsed is an error: a same-named server cannot be ruled out. */
export function codexConfigServerNames(files: string[]): { ok: true; names: Map<string, string> } | { ok: false; error: string } {
  const names = new Map<string, string>();
  for (const file of files) {
    if (!existsSync(file)) continue;
    let table: unknown;
    try {
      table = (parseToml(readFileSync(file, "utf-8")) as Record<string, unknown>)["mcp_servers"];
    } catch (err) {
      return { ok: false, error: `${file} cannot be read to rule out a same-named server (${(err as Error).message.split("\n")[0]})` };
    }
    if (table && typeof table === "object" && !Array.isArray(table)) {
      for (const name of Object.keys(table)) if (!names.has(name)) names.set(name, file);
    }
  }
  return { ok: true, names };
}
