import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, lstatSync, readFileSync, realpathSync, statSync, type Stats } from "node:fs";
import os from "node:os";
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

/** The file-system reads the trust judgement makes; injectable so a test can present a foreign owner. */
export interface PathJudgeIo {
  lstat(p: string): Stats;
  stat(p: string): Stats;
  realpath(p: string): string;
  uid(): number | undefined;
  /** Directories a sandboxed Codex seat may write (its writable roots besides its cwd). */
  tempRoots(): string[];
}

/** /tmp, $TMPDIR and /var/folders, as written and resolved (macOS links /tmp and /var into /private). */
function defaultTempRoots(): string[] {
  const roots = ["/tmp", "/private/tmp", "/var/folders", "/private/var/folders", os.tmpdir(), process.env["TMPDIR"] ?? ""].filter(Boolean);
  const out = new Set<string>();
  for (const r of roots) {
    out.add(nodePath.resolve(r));
    try { out.add(realpathSync(r)); } catch { /* absent on this host */ }
  }
  return [...out];
}

export const DEFAULT_PATH_JUDGE_IO: PathJudgeIo = {
  lstat: (p) => lstatSync(p),
  stat: (p) => statSync(p),
  realpath: (p) => realpathSync(p),
  uid: () => (typeof process.getuid === "function" ? process.getuid() : undefined),
  tempRoots: defaultTempRoots,
};

/**
 * Whether a file OpenRig will act on (a server binary, or a spec file named with --spec) could have been
 * written or swapped by someone other than this user, including a sandboxed seat (security review N3, F1,
 * F2; Jim, 2026-10-20). Refused when the path as written or as resolved:
 *  - lies inside the seat's working directory, the spec's directory (binaries only), any git work tree, any
 *    `.workspaces` directory, or a sandbox-writable root (/tmp, $TMPDIR, /var/folders); or
 *  - has a component not owned by this user or root, or a non-link component writable by group or others.
 * Every component of BOTH chains is examined: the written chain with lstat (a link is judged by its owner
 * and by the directory holding it, so a link in a 0777 directory is refused), the resolved chain with stat.
 * There is no sticky-bit exemption: a sandboxed seat can write the sticky temp roots.
 * Returns null when trusted; `missing` when the path does not resolve.
 */
export function untrustedPathProblem(
  file: string,
  what: string,
  roots: { seatCwd?: string | null; specDir?: string | null },
  io: PathJudgeIo = DEFAULT_PATH_JUDGE_IO,
): { kind: "missing" } | { kind: "untrusted"; why: string } | null {
  const written = nodePath.resolve(file);
  let real: string;
  try { real = io.realpath(file); } catch { return { kind: "missing" }; }
  const located = deniedLocation([written, real], file, what, roots, io);
  if (located) return { kind: "untrusted", why: located };
  const uid = io.uid();
  if (uid !== undefined) {
    for (const [chain, read] of [[written, (p: string) => io.lstat(p)], [real, (p: string) => io.stat(p)]] as const) {
      let p = chain;
      for (;;) {
        let st: Stats;
        try { st = read(p); } catch { return { kind: "untrusted", why: `${what} ${file}: ${p} cannot be inspected` }; }
        if (st.uid !== uid && st.uid !== 0) return { kind: "untrusted", why: `${what} ${file} is not protected: ${p} is owned by uid ${st.uid}, not by you or root` };
        if (!st.isSymbolicLink() && (st.mode & 0o022) !== 0) return { kind: "untrusted", why: `${what} ${file} is not protected: ${p} is writable by group or others` };
        const up = nodePath.dirname(p);
        if (up === p) break;
        p = up;
      }
    }
  }
  return null;
}

/**
 * Where a declared server's executable may be: the trust judgement above, plus (with `requireExecutable`, at
 * the switch and every launch) an existing executable regular file. Spec preflight passes
 * `requireExecutable: false` and leaves a missing binary to a warning, since a declared server is off by default.
 */
export function mcpServerPlacementProblem(
  server: Pick<CodexMcpServerDeclaration, "command">,
  roots: { seatCwd?: string | null; specDir?: string | null },
  opts: { requireExecutable: boolean },
  io: PathJudgeIo = DEFAULT_PATH_JUDGE_IO,
): string | null {
  const what = "its command";
  const judged = untrustedPathProblem(server.command, what, roots, io);
  if (judged?.kind === "missing") {
    if (opts.requireExecutable) return `its command ${server.command} does not exist`;
    // Not installed yet: judge the places the path names (by identity of the directories that exist), so a
    // declaration pointing into a seat's folder or a temp root is refused at preflight before the binary exists.
    return deniedLocation([nodePath.resolve(server.command)], server.command, what, roots, io);
  }
  if (judged) return judged.why;
  if (opts.requireExecutable) {
    try {
      const real = io.realpath(server.command);
      if (!io.stat(real).isFile()) return `its command ${server.command} is not a regular file`;
      accessSync(real, constants.X_OK);
    } catch {
      return `its command ${server.command} is not executable`;
    }
  }
  return null;
}

/**
 * Location checks compared by IDENTITY, not text (security re-check of 53a39e80, R2). macOS volumes are
 * case-insensitive and reachable through firmlinks (/System/Volumes/Data/...), so the same directory has many
 * spellings and a seat chooses the spelling it sends. Every existing ancestor of each candidate path is
 * stat'ed, and a named root (the seat's cwd, the spec directory, each temp root) matches when its own
 * dev/ino is among them. `.workspaces` is matched case-insensitively and `.git` by existence, both of which
 * hold under any spelling of the ancestors.
 */
function deniedLocation(paths: string[], file: string, what: string, roots: { seatCwd?: string | null; specDir?: string | null }, io: PathJudgeIo): string | null {
  const ids = new Set<string>();
  for (const p of paths) for (const id of ancestorIdentities(p, io)) ids.add(id);
  const chooses = what === "its command" ? "the program" : "what runs";
  const named: Array<[string, string | null | undefined]> = [["the seat's working directory", roots.seatCwd], ["the rig spec's directory", roots.specDir]];
  for (const [label, root] of named) {
    if (!root) continue;
    const id = identityOf(root, io);
    if (id && ids.has(id)) return `${what} ${file} lies inside ${label} (${root}), so content there could choose ${chooses}`;
  }
  for (const temp of io.tempRoots()) {
    const id = identityOf(temp, io);
    if (id && ids.has(id)) return `${what} ${file} lies inside the temporary directory ${temp}, which a sandboxed seat can write`;
  }
  for (const p of paths) {
    const tree = controlledTree(p);
    if (tree) return `${what} ${file} lies inside ${tree}, so content there could choose ${chooses}`;
  }
  return null;
}

/** "dev:ino" of a path (links followed); null when it cannot be stat'ed. */
export function identityOf(p: string, io: PathJudgeIo = DEFAULT_PATH_JUDGE_IO): string | null {
  try { const st = io.stat(p); return `${st.dev}:${st.ino}`; } catch { return null; }
}

/** The identities of a path and every ancestor that exists (a missing tail is skipped, so a not-yet-installed
 *  binary is still judged by the directories it names). */
function ancestorIdentities(p: string, io: PathJudgeIo): string[] {
  const out: string[] = [];
  let d = nodePath.resolve(p);
  for (;;) {
    const id = identityOf(d, io);
    if (id) out.push(id);
    const up = nodePath.dirname(d);
    if (up === d) return out;
    d = up;
  }
}

/** The nearest enclosing git work tree or `.workspaces` directory (any letter case) of a path; null when none. */
function controlledTree(p: string): string | null {
  let d = nodePath.dirname(p);
  for (;;) {
    if (nodePath.basename(d).toLowerCase() === ".workspaces") return `the seat workspaces directory ${d}`;
    if (existsSync(nodePath.join(d, ".git"))) return `the git work tree ${d}`;
    const up = nodePath.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/**
 * Whether a spec file named with `rig seat set-mcp --spec` may supply a declaration (Jim, 2026-10-20,
 * "Allow-list", after the re-check of 53a39e80). Accepted only when ALL hold:
 *  - its resolved file lies under one of the trusted spec roots (the release copies under ~/.agents-release,
 *    the spec library, the rig's recorded spec directory), compared by dev/ino of the resolved chain, so no
 *    spelling of a path (case, firmlink, link) changes the answer and no seat-writable root that nobody
 *    listed (an --add-dir state folder, a configured writable_root) can qualify;
 *  - it is a regular file with exactly one link (a hard link elsewhere could be written through);
 *  - the deny rules and the ownership rule of untrustedPathProblem pass for it as well.
 */
export function specFileTrustProblem(
  file: string,
  trustedRoots: string[],
  seatCwd: string | null,
  io: PathJudgeIo = DEFAULT_PATH_JUDGE_IO,
): string | null {
  let real: string;
  let st: Stats;
  try { real = io.realpath(file); st = io.stat(real); } catch { return null; } // unreadable: the caller's read reports it
  if (!st.isFile()) return `the spec file ${file} is not a regular file`;
  if (st.nlink > 1) return `the spec file ${file} has ${st.nlink} hard links; a link elsewhere could change it`;
  const chain = new Set(ancestorIdentities(real, io));
  const anchored = trustedRoots.some((root) => { const id = identityOf(root, io); return id !== null && chain.has(id); });
  if (!anchored) return `the spec file ${file} is not under a trusted spec root (${trustedRoots.join(", ") || "none configured"})`;
  const judged = untrustedPathProblem(file, "the spec file", { seatCwd }, io);
  return judged?.kind === "untrusted" ? judged.why : null;
}

/** The trusted spec roots for --spec: the released spec copies and the spec library roots. The rig's recorded
 *  spec directory is added per request by the caller. */
export function mcpSpecRoots(input: { home: string; specLibraryRoots: string[] }): string[] {
  return [nodePath.join(input.home, ".agents-release"), ...input.specLibraryRoots];
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
  /** The trust rule's file-system reads; production never passes it (tests anchor fixtures with it). */
  io: PathJudgeIo = DEFAULT_PATH_JUDGE_IO,
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
    const place = mcpServerPlacementProblem(server.declaration, { seatCwd, specDir: server.specDir }, { requireExecutable: true }, io);
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
