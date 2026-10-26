import { createHash } from "node:crypto";
import fs from "node:fs";
import nodePath from "node:path";
import type Database from "better-sqlite3";
import { RigSpecCodec } from "./rigspec-codec.js";
import { RigSpecSchema } from "./rigspec-schema.js";
import { reanchorShippedSpecPath } from "./builtin-startup-files.js";
import { PROJECT_RIG_WORKSPACES, projectRigSlug } from "./project-rig.js";
import { judgeSpecSource, specSourceTrustOf } from "./recorded-spec-source-judge.js";
import {
  commandBinarySha256, mcpArgFilePins, mcpServerPlacementProblem, normalizeMcpServers, serializeMcpServer, specFileTrustProblem, validateMcpServersBlock,
  type McpArgFilePin, type PathJudgeIo, type SeatMcpSelection, type SeatMcpServer,
} from "./codex-mcp-servers.js";

/**
 * One seat instance's switched-on Codex MCP servers (`nodes.codex_mcp_servers`, JSON).
 *
 * A rig spec member DECLARES a server; every seat instance of that member starts with it OFF. `rig seat
 * set-mcp <seat> <name> on` reads the declaration from the rig's RECORDED spec source as that file is now
 * (the OF-32 rule: a library link reaches the release it points at today), checks it, and stores a
 * snapshot here; `off` removes it. Launches read only this column: no launch path reads a spec file, and
 * a later spec edit changes nothing until someone switches the server on again.
 */
export interface StoredSeatMcpServer {
  /** The declaration in spec spelling, as read when it was switched on. */
  declaration: Record<string, unknown>;
  /** Directory of the spec file it was read from (the command may never lie inside it). */
  specDir: string;
  /** The spec file it was read from, after links. */
  declaredIn: string;
  switchedOnAt: string;
  /** The file the command resolved to at switch-on, and its sha256; every launch recomputes the hash. */
  commandPath: string;
  commandSha256: string;
  /** The files named in the declaration's args (config files), pinned at switch-on like the binary (OF-50). */
  argFiles: McpArgFilePin[];
  /** Where the declaration came from: the rig's recorded spec source, or a file the operator named (--spec). */
  specSource: "recorded" | "operator";
  /** sha256 of the spec file's bytes as read at switch-on. */
  specSha256: string;
}

type Stored = Record<string, StoredSeatMcpServer>;

function readColumn(db: Database.Database, nodeId: string): { present: boolean; value: string | null } {
  try {
    const row = db.prepare("SELECT codex_mcp_servers FROM nodes WHERE id = ?").get(nodeId) as { codex_mcp_servers: string | null } | undefined;
    return { present: true, value: row?.codex_mcp_servers ?? null };
  } catch {
    return { present: false, value: null }; // an older database without the column: nothing is switched on
  }
}

function parseStored(value: string | null): { ok: true; stored: Stored } | { ok: false; error: string } {
  if (value === null || value === "") return { ok: true, stored: {} };
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return { ok: false, error: "the stored selection is not valid JSON" }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, error: "the stored selection is not an object" };
  return { ok: true, stored: parsed as Stored };
}

/** What every Codex launch of this seat renders. Unreadable or invalid storage is an error, never "none". */
export function readSeatMcpServers(db: Database.Database, nodeId: string): SeatMcpSelection {
  const column = readColumn(db, nodeId);
  const parsed = parseStored(column.value);
  if (!parsed.ok) return parsed;
  const servers: SeatMcpServer[] = [];
  for (const [name, entry] of Object.entries(parsed.stored)) {
    const errors = entry && typeof entry === "object" ? validateMcpServersBlock({ [name]: entry.declaration }, "codex", "stored") : ["not an object"];
    if (errors.length || typeof entry.specDir !== "string") {
      return { ok: false, error: `stored server "${name}" is invalid (${errors.join("; ") || "no spec directory"})` };
    }
    if (typeof entry.commandSha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.commandSha256)) {
      return { ok: false, error: `stored server "${name}" has no pinned binary checksum; switch it on again` };
    }
    // An entry stored before OF-50 has no pins for the files its args name. Refused, not warned: it cannot be told
    // apart from a server whose config file was never pinned, and a launch would run unverified config.
    const files = (entry as { argFiles?: unknown }).argFiles;
    if (!Array.isArray(files) || !files.every((f) => f && typeof f.arg === "string" && typeof f.realPath === "string" && /^[0-9a-f]{64}$/.test(f.sha256))) {
      return { ok: false, error: `stored server "${name}" has no pinned config files (it was switched on before they were pinned); switch it on again` };
    }
    servers.push({ name, declaration: normalizeMcpServers({ [name]: entry.declaration })![name]!, specDir: entry.specDir, commandSha256: entry.commandSha256, argFiles: files as McpArgFilePin[] });
  }
  return { ok: true, servers };
}

/** The names switched on for this seat (for reports); null when the storage cannot be read. */
export function switchedOnNames(db: Database.Database, nodeId: string): string[] | null {
  const parsed = parseStored(readColumn(db, nodeId).value);
  return parsed.ok ? Object.keys(parsed.stored).sort() : null;
}

/** Write one server's entry (or remove it with null). False when the column is missing or no row matched. */
export function writeSeatMcpServer(db: Database.Database, nodeId: string, name: string, entry: StoredSeatMcpServer | null): boolean {
  const column = readColumn(db, nodeId);
  if (!column.present) return false;
  const parsed = parseStored(column.value);
  // A Map, so no server name can reach an object's prototype (assigning `__proto__` would store nothing).
  const stored = new Map<string, StoredSeatMcpServer>(parsed.ok ? Object.entries(parsed.stored) : []);
  if (entry) stored.set(name, entry); else stored.delete(name);
  const value = stored.size ? JSON.stringify(Object.fromEntries(stored)) : null;
  return db.prepare("UPDATE nodes SET codex_mcp_servers = ? WHERE id = ?").run(value, nodeId).changes > 0;
}

export const declarationSha256 = (declaration: Record<string, unknown>) =>
  createHash("sha256").update(JSON.stringify(declaration)).digest("hex");

export type DeclaredServerRead =
  | { ok: true; entry: StoredSeatMcpServer }
  | { ok: false; code: "mcp_spec_source_unrecorded" | "mcp_spec_source_unavailable" | "mcp_spec_source_changed" | "mcp_server_undeclared" | "mcp_server_unusable"
      | "mcp_spec_file_unavailable" | "mcp_spec_rig_mismatch" | "mcp_spec_file_untrusted" | "mcp_spec_source_untrusted"; message: string };

/**
 * Read one declared server for one seat from its rig's recorded spec source, as that file is now, and
 * check it as a launch will: the spec still validates, still declares this seat with the same runtime,
 * agent and profile, declares the server, and its command is an existing executable outside the seat's
 * directory and the spec's directory. Reads only.
 */
export function readDeclaredMcpServer(input: {
  /** The rig's recorded spec source (rigs.spec_source_path), used unless the operator names a file. */
  specSource: string | null;
  /** `rig seat set-mcp --spec <file>` (Jim, 2026-10-20): an absolute path the operator chose. It must declare
   *  this rig by name; it is used when nothing is recorded and overrides what is. */
  operatorSpecFile?: string;
  rigName: string;
  server: string;
  node: { logicalId: string; runtime: string | null; agentRef: string | null; profile: string | null; cwd: string | null };
  now: () => string;
  /** Roots an operator-named spec must lie under (released copies, spec library); the recorded spec directory
   *  is added here. Empty: no --spec file is accepted. */
  trustedSpecRoots?: string[];
  /** The trust rule's file-system reads; production never passes it. */
  io?: PathJudgeIo;
  /** The shared-docs rigs folder the recorded source may sit in (exactly <name>/rig.yaml). Default: the daemon's own. */
  recordedExactDepthRoot?: () => string;
}): DeclaredServerRead {
  const operator = input.operatorSpecFile !== undefined;
  const specSource = operator ? input.operatorSpecFile! : input.specSource;
  if (!specSource) {
    return { ok: false, code: "mcp_spec_source_unrecorded", message: "This rig has no recorded spec source (it was launched before OpenRig recorded one, or from text). Name the reviewed spec file with --spec <file>, or relaunch the rig from its spec file." };
  }
  const unavailable = (detail: string): DeclaredServerRead => operator
    ? { ok: false, code: "mcp_spec_file_unavailable", message: `The spec file ${specSource} cannot be used for MCP servers: ${detail}` }
    : { ok: false, code: "mcp_spec_source_unavailable", message: `This rig's spec source ${specSource} cannot be read for MCP servers: ${detail}` };
  if (!nodePath.isAbsolute(specSource)) return unavailable("it is not an absolute path.");
  // The operator-named file decides what runs, and a seat chooses the path it sends, so it must lie under a
  // trusted spec root (Jim, 2026-10-20, "Allow-list": re-check F1, R1, R2), compared by identity, with one link,
  // and pass the deny and ownership rules too.
  // OF-103 / OF-49: the RECORDED source is judged by the same rules `rig spec-source set` applies, at every read, because
  // it decides what runs just as an operator-named file does (a value recorded by `rig up`, or a file or link changed
  // after `set`, is not trusted for having been recorded). An operator-named file is read with the recorded directory as a
  // root only when the recorded source itself passes.
  const trust = specSourceTrustOf({ specRoots: () => input.trustedSpecRoots ?? [], ...(input.io ? { io: input.io } : {}) }, input.recordedExactDepthRoot);
  let recordedPasses = false;
  if (input.specSource && nodePath.isAbsolute(input.specSource)) {
    const judged = judgeSpecSource({ specSource: input.specSource, use: "read", rigName: input.rigName, seatFolders: input.node.cwd ? [input.node.cwd] : [], trust });
    recordedPasses = judged.ok;
    if (!operator && !judged.ok && judged.code !== "spec_unreadable") {
      return { ok: false, code: "mcp_spec_source_untrusted", message: `This rig's spec source ${input.specSource} is not trusted for MCP servers: ${judged.message}` };
    }
  }
  if (operator) {
    let problem = specFileTrustProblem(specSource, input.trustedSpecRoots ?? [], input.node.cwd, input.io);
    if (problem && input.specSource && recordedPasses) {
      // The recorded spec's own folder is a root for a SIBLING file only (a spec file directly beside it), never for what lies
      // deeper: when the recorded source sits in the shared-docs rigs folder (<rig>/rig.yaml), the folders below it
      // (<rig>/state/<pod>) are Codex state folders a sandboxed seat can write.
      try {
        const recordedDir = nodePath.dirname(fs.realpathSync(reanchorShippedSpecPath(input.specSource)));
        const operatorDir = nodePath.dirname(fs.realpathSync(specSource));
        if (operatorDir === recordedDir) problem = specFileTrustProblem(specSource, [recordedDir], input.node.cwd, input.io);
      } catch { /* unreadable: not a root */ }
    }
    if (problem) {
      return { ok: false, code: "mcp_spec_file_untrusted", message: `The spec file ${specSource} cannot be trusted for MCP servers: ${problem}. Name the reviewed release copy (~/.agents-release/...), a spec in the spec library, or the rig's own spec file.` };
    }
  }
  let specPath: string;
  let bytes: Buffer;
  try {
    specPath = fs.realpathSync(operator ? specSource : reanchorShippedSpecPath(specSource));
    bytes = fs.readFileSync(specPath);
  } catch (err) {
    return unavailable(`it could not be read (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}).`);
  }
  const yaml = bytes.toString("utf-8");
  const specSha256 = createHash("sha256").update(bytes).digest("hex");
  let raw: unknown;
  try { raw = RigSpecCodec.parse(yaml); } catch (err) { return unavailable(`it no longer parses (${(err as Error).message}).`); }
  const validation = RigSpecSchema.validate(raw);
  if (!validation.valid) return unavailable(`it no longer validates (${validation.errors.join("; ")}).`);
  const spec = RigSpecSchema.normalize(raw as Record<string, unknown>);
  const node = input.node;
  if (operator && !declaresRig(raw as Record<string, unknown>, input.rigName, node.cwd)) {
    return { ok: false, code: "mcp_spec_rig_mismatch", message: `The spec file ${specPath} declares rig "${spec.name}", not this seat's rig "${input.rigName}"${(raw as Record<string, unknown>)["project_rig"] === true ? " (as a project rig it would name the rig after its project folder, which is not this seat's)" : ""}.` };
  }
  const pod = spec.pods.find((p) => p.members.some((m) => `${p.id}.${m.id}` === node.logicalId));
  const member = pod?.members.find((m) => `${pod.id}.${m.id}` === node.logicalId);
  if (!pod || !member) return { ok: false, code: "mcp_server_undeclared", message: `The spec ${specPath} does not declare seat ${node.logicalId}, so it declares no MCP server for it.` };
  const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
  const drift = [
    !same(member.runtime, node.runtime) ? `runtime ${member.runtime} (seat: ${node.runtime ?? "none"})` : null,
    !same(member.agentRef, node.agentRef) ? `agent_ref ${member.agentRef} (seat: ${node.agentRef ?? "none"})` : null,
    !same(member.profile, node.profile) ? `profile ${member.profile} (seat: ${node.profile ?? "none"})` : null,
  ].filter((d): d is string => d !== null);
  if (drift.length) return { ok: false, code: "mcp_spec_source_changed", message: `The spec ${specPath} no longer matches this seat: it now declares ${drift.join(", ")}.` };
  const declaration = member.mcpServers?.[input.server];
  if (!declaration) {
    const declared = Object.keys(member.mcpServers ?? {}).sort();
    return { ok: false, code: "mcp_server_undeclared", message: `The spec ${specPath} declares no MCP server "${input.server}" for ${node.logicalId}${declared.length ? ` (it declares: ${declared.join(", ")})` : ""}.` };
  }
  const specDir = nodePath.dirname(specPath);
  const place = mcpServerPlacementProblem(declaration, { seatCwd: node.cwd, specDir }, { requireExecutable: true }, input.io);
  if (place) return { ok: false, code: "mcp_server_unusable", message: `MCP server "${input.server}" cannot be switched on: ${place}.` };
  const commandSha256 = commandBinarySha256(declaration.command);
  if (!commandSha256) return { ok: false, code: "mcp_server_unusable", message: `MCP server "${input.server}" cannot be switched on: its command ${declaration.command} cannot be read to pin its checksum.` };
  const argFiles = mcpArgFilePins(declaration.args, { seatCwd: node.cwd, ...(input.io ? { io: input.io } : {}) });
  if (!argFiles.ok) return { ok: false, code: "mcp_server_unusable", message: `MCP server "${input.server}" cannot be switched on: ${argFiles.error}.` };
  return { ok: true, entry: { declaration: serializeMcpServer(declaration), specDir, declaredIn: specPath, switchedOnAt: input.now(),
    commandPath: fs.realpathSync(declaration.command), commandSha256, argFiles: argFiles.pins, specSource: operator ? "operator" : "recorded", specSha256 } };
}

/**
 * Whether a spec declares this rig: by name, or, for a project rig, by the name `rig up --cwd <project>`
 * gives it (the project folder's slug), judged from the seat's own folder <project>/.workspaces/<pod>-<member>.
 *
 * TRUST BOUNDARY: this is a typo guard, not a security boundary. A project-rig spec matches any seat of any
 * project it could be launched into, and a plain spec's `name` is whatever the file says, so the match binds
 * nothing about who wrote the file (security re-check of aa8b6af1). What makes an operator-named spec safe to
 * act on is the file's place and ownership (untrustedPathProblem above), never this comparison.
 */
export function declaresRig(raw: Record<string, unknown>, rigName: string, seatCwd: string | null): boolean {
  if (raw["name"] === rigName) return true;
  if (raw["project_rig"] !== true || !seatCwd) return false;
  const workspaces = nodePath.dirname(seatCwd);
  return nodePath.basename(workspaces) === PROJECT_RIG_WORKSPACES && projectRigSlug(nodePath.dirname(workspaces)) === rigName;
}
