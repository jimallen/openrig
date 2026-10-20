import { createHash } from "node:crypto";
import fs from "node:fs";
import nodePath from "node:path";
import type Database from "better-sqlite3";
import { RigSpecCodec } from "./rigspec-codec.js";
import { RigSpecSchema } from "./rigspec-schema.js";
import { reanchorShippedSpecPath } from "./builtin-startup-files.js";
import {
  mcpServerPlacementProblem, normalizeMcpServers, serializeMcpServer, validateMcpServersBlock,
  type SeatMcpSelection, type SeatMcpServer,
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
    servers.push({ name, declaration: normalizeMcpServers({ [name]: entry.declaration })![name]!, specDir: entry.specDir });
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
  | { ok: false; code: "mcp_spec_source_unrecorded" | "mcp_spec_source_unavailable" | "mcp_spec_source_changed" | "mcp_server_undeclared" | "mcp_server_unusable"; message: string };

/**
 * Read one declared server for one seat from its rig's recorded spec source, as that file is now, and
 * check it as a launch will: the spec still validates, still declares this seat with the same runtime,
 * agent and profile, declares the server, and its command is an existing executable outside the seat's
 * directory and the spec's directory. Reads only.
 */
export function readDeclaredMcpServer(input: {
  specSource: string | null;
  server: string;
  node: { logicalId: string; runtime: string | null; agentRef: string | null; profile: string | null; cwd: string | null };
  now: () => string;
}): DeclaredServerRead {
  const { specSource } = input;
  if (!specSource) {
    return { ok: false, code: "mcp_spec_source_unrecorded", message: "This rig has no recorded spec source (it was launched before OpenRig recorded one, or from text), so there is no reviewed declaration to switch on. Relaunch the rig from its spec file, then switch the server on." };
  }
  const unavailable = (detail: string): DeclaredServerRead => ({ ok: false, code: "mcp_spec_source_unavailable", message: `This rig's spec source ${specSource} cannot be read for MCP servers: ${detail}` });
  if (!nodePath.isAbsolute(specSource)) return unavailable("it is not an absolute path.");
  let specPath: string;
  let yaml: string;
  try {
    specPath = fs.realpathSync(reanchorShippedSpecPath(specSource));
    yaml = fs.readFileSync(specPath, "utf-8");
  } catch (err) {
    return unavailable(`it could not be read (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}).`);
  }
  let raw: unknown;
  try { raw = RigSpecCodec.parse(yaml); } catch (err) { return unavailable(`it no longer parses (${(err as Error).message}).`); }
  const validation = RigSpecSchema.validate(raw);
  if (!validation.valid) return unavailable(`it no longer validates (${validation.errors.join("; ")}).`);
  const spec = RigSpecSchema.normalize(raw as Record<string, unknown>);
  const node = input.node;
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
  const place = mcpServerPlacementProblem(declaration, { seatCwd: node.cwd, specDir }, { requireExecutable: true });
  if (place) return { ok: false, code: "mcp_server_unusable", message: `MCP server "${input.server}" cannot be switched on: ${place}.` };
  return { ok: true, entry: { declaration: serializeMcpServer(declaration), specDir, declaredIn: specPath, switchedOnAt: input.now() } };
}
