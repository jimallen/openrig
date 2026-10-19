// OF-32: where a fresh seat's startup policy comes from. A fresh conversation has no continuity, so by default it
// re-reads the rig's recorded spec source as it is now (a library link follows its current target). The saved
// startup context (written by the seat's last successful launch: its first launch, or the last fresh launch that
// produced an occupant) is replayed only when the operator asks for it (`--startup-from stored`), when the rig
// records no source, or when the spec does not declare the seat. Resume never comes through here: it keeps the stored context, because the
// conversation already holds the text that context delivered.
//
// Every fresh launch decides its source through `resolveFreshSeatStartup`: `rig seat launch --fresh` and (stage 3)
// every restore launch that is not an exact resume (`rig up --existing`, with or without `--fresh <seat>`). Neither
// verb has its own copy of this decision.
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { ProjectionEntry, ProjectionPlan } from "./projection-planner.js";
import type { ResolvedStartupFile, RuntimeAdapter } from "./runtime-adapter.js";
import type { StartupAction } from "./types.js";
import { resolveStartupProof } from "./startup-resolver.js";
import { serializeStartupContext } from "./startup-orchestrator.js";
import { reanchorBuiltinStartupFile, reanchorShippedProjectionEntry } from "./builtin-startup-files.js";

/** What the operator asked a fresh launch to start from. */
export type StartupFrom = "spec" | "stored";

export const STARTUP_FROM_VALUES: readonly StartupFrom[] = ["spec", "stored"];

export type SeatStartupRead =
  /** The rig records no spec source (created before OpenRig recorded one, or not from a spec file). */
  | { kind: "unrecorded" }
  /** The recorded spec does not declare this seat (added with `rig add` after launch, or dropped from the spec). */
  | { kind: "undeclared"; specSource: string }
  /** A source is recorded but cannot give this seat a startup policy; nothing was launched or written. */
  | { kind: "refused"; code: "startup_source_unavailable" | "startup_source_changed"; message: string; specSource: string }
  | {
      kind: "spec";
      /** The recorded spelling, for example a spec library link. */
      specSource: string;
      /** The file actually read, after re-anchoring and following links. */
      specPath: string;
      plan: ProjectionPlan;
      resolvedStartupFiles: ResolvedStartupFile[];
      startupActions: StartupAction[];
      resolvedSpec: { name: string; version: string; hash: string };
      warnings: string[];
    };

/** The seam a fresh launch asks for a re-read; PodRigInstantiator implements it. Reads only; writes nothing. */
export interface SeatStartupSpecReader {
  readSeatStartupFromSpec(input: { rigId: string; nodeId: string; adapter: RuntimeAdapter; sessionName: string }): Promise<SeatStartupRead>;
}

/** OF-32: where a fresh launch took its startup policy from, as reported to the operator and the audit event. */
export type FreshStartupSource =
  | { kind: "spec"; specSource: string; specPath: string }
  | { kind: "stored"; reason: "requested" | "no_recorded_source" | "not_in_spec" };

/** A fresh seat's startup policy, from whichever source `resolveFreshSeatStartup` chose. */
export interface FreshStartupContext {
  plan: ProjectionPlan;
  resolvedStartupFiles: ResolvedStartupFile[];
  startupActions: StartupAction[];
  runtime: string;
  hash: string;
  source: FreshStartupSource;
  /** Agent spec provenance of a re-read context, written with the context row. */
  resolvedSpec?: { name: string; version: string; hash: string };
  /** Operator-facing notes about the source (no recorded source; re-read warnings). */
  sourceWarnings: string[];
}

/** Every way the source decision can refuse. Nothing has been launched, stopped or written when it does. */
export interface FreshStartupRefusal {
  ok: false;
  code:
    | "startup_context_missing"
    | "startup_context_malformed"
    | "startup_context_runtime_mismatch"
    | "startup_source_unavailable"
    | "startup_source_changed"
    | "runtime_adapter_missing"
    | "launch_unavailable";
  message: string;
  guidance?: string;
}

export const NO_RECORDED_SOURCE_WARNING = "This rig records no spec source (it was created before OpenRig recorded one, or not from a spec file), "
  + "so this fresh launch replays the startup files saved at the seat's last successful launch. To pick up spec changes, create the rig again from its spec.";

/** OF-32: a seat its rig's spec does not declare (added later with `rig add`, or dropped from the spec). */
export function notInSpecWarning(logicalId: string, specSource: string): string {
  return `This rig's spec ${specSource} does not declare ${logicalId} (it was added to the rig after launch, or the spec no longer lists it), `
    + "so this fresh launch replays the startup files saved at the seat's last successful launch.";
}

/**
 * Decide and read one fresh seat's startup policy: the rig's recorded spec as it is now (`spec`, the default), or the
 * context saved by the seat's last successful launch (`stored`, also used when the rig records no source or its spec
 * does not declare the seat). The context's runtime must be the seat's. Reads only: a refusal has changed nothing.
 */
export async function resolveFreshSeatStartup(
  deps: {
    db: Database.Database;
    rigRepo: { getRigSpecSource(rigId: string): string | null };
    specReader: SeatStartupSpecReader | null;
    runtimeAdapters: Record<string, RuntimeAdapter | undefined>;
  },
  input: {
    rigId: string;
    nodeId: string;
    logicalId: string;
    runtime: string | null;
    cwd: string;
    sessionName: string;
    startupFrom: StartupFrom;
    /** What the caller's operator can do about a refused re-read (it names that verb's stored escape). */
    refusalGuidance: string;
  },
): Promise<{ ok: true; context: FreshStartupContext } | FreshStartupRefusal> {
  let reread: FreshStartupContext | null = null;
  let storedReason: "requested" | "no_recorded_source" | "not_in_spec" = "requested";
  let undeclaredSource: string | null = null;
  if (input.startupFrom === "spec") {
    const adapter = input.runtime ? deps.runtimeAdapters[input.runtime] : undefined;
    const read = !deps.specReader
      ? (deps.rigRepo.getRigSpecSource(input.rigId) ? null : { kind: "unrecorded" as const })
      : adapter
        ? await deps.specReader.readSeatStartupFromSpec({ rigId: input.rigId, nodeId: input.nodeId, adapter, sessionName: input.sessionName })
        : null;
    if (!read) {
      return adapter
        ? { ok: false, code: "launch_unavailable", message: "This daemon cannot re-read a seat's spec source." }
        : { ok: false, code: "runtime_adapter_missing", message: `No runtime adapter is available for '${input.runtime ?? "missing"}'.` };
    }
    if (read.kind === "refused") {
      return { ok: false, code: read.code, message: read.message, guidance: input.refusalGuidance };
    }
    if (read.kind === "spec") {
      // S04 owns the live ambient skill set, as on the stored path: a fresh seat does not reinstall catalog skills.
      const entries = read.plan.entries.filter((entry) => entry.category !== "skill");
      try {
        resolveStartupProof(read.startupActions, "fresh_start");
      } catch (err) {
        return { ok: false, code: "startup_source_unavailable", message: `This rig's spec source ${read.specSource} gives an invalid startup policy: ${(err as Error).message}.` };
      }
      const row = serializeStartupContext(entries, read.resolvedStartupFiles, read.startupActions);
      reread = {
        plan: { ...read.plan, entries },
        resolvedStartupFiles: read.resolvedStartupFiles,
        startupActions: read.startupActions,
        runtime: read.plan.runtime,
        hash: createHash("sha256").update(JSON.stringify([row.projectionEntriesJson, row.resolvedFilesJson, row.startupActionsJson, read.plan.runtime])).digest("hex"),
        source: { kind: "spec", specSource: read.specSource, specPath: read.specPath },
        resolvedSpec: read.resolvedSpec,
        sourceWarnings: read.warnings,
      };
    } else if (read.kind === "undeclared") {
      storedReason = "not_in_spec";
      undeclaredSource = read.specSource;
    } else {
      storedReason = "no_recorded_source";
    }
  }

  let context: FreshStartupContext;
  if (reread) {
    context = reread;
  } else {
    const startup = readStoredStartupContext(deps.db, input.nodeId, input.cwd);
    if (!startup.ok) return startup.refusal;
    context = {
      ...startup.context,
      source: { kind: "stored", reason: storedReason },
      sourceWarnings: storedReason === "no_recorded_source" ? [NO_RECORDED_SOURCE_WARNING]
        : storedReason === "not_in_spec" ? [notInSpecWarning(input.logicalId, undeclaredSource ?? "")] : [],
    };
  }
  if (!input.runtime || context.runtime !== input.runtime) {
    return {
      ok: false,
      code: "startup_context_runtime_mismatch",
      message: `Persisted startup context runtime '${context.runtime}' does not match current node runtime '${input.runtime ?? "missing"}'.`,
    };
  }
  return { ok: true, context };
}

interface PersistedStartupContextRow {
  projection_entries_json: string;
  resolved_files_json: string;
  startup_actions_json: string;
  runtime: string | null;
}

/** The context saved by the seat's last successful launch (node_startup_context), validated and re-anchored. */
export function readStoredStartupContext(
  db: Database.Database,
  nodeId: string,
  cwd: string,
): { ok: true; context: Omit<FreshStartupContext, "source" | "sourceWarnings" | "resolvedSpec"> } | { ok: false; refusal: FreshStartupRefusal } {
  const row = db.prepare(
    "SELECT projection_entries_json, resolved_files_json, startup_actions_json, runtime FROM node_startup_context WHERE node_id = ?",
  ).get(nodeId) as PersistedStartupContextRow | undefined;
  if (!row) {
    return {
      ok: false,
      refusal: {
        ok: false,
        code: "startup_context_missing",
        message: `Persisted startup context is missing for node ${nodeId}; fresh launch refuses to invent an empty startup policy.`,
      },
    };
  }

  let rawEntries: unknown;
  let rawFiles: unknown;
  let rawActions: unknown;
  try {
    rawEntries = JSON.parse(row.projection_entries_json);
    rawFiles = JSON.parse(row.resolved_files_json);
    rawActions = JSON.parse(row.startup_actions_json);
  } catch (error) {
    return malformedStartupContext(nodeId, `JSON parse failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(rawEntries) || !Array.isArray(rawFiles) || !Array.isArray(rawActions) || !row.runtime?.trim()) {
    return malformedStartupContext(nodeId, "projection entries, resolved files, and startup actions must be arrays and runtime must be non-empty");
  }

  const entries: ProjectionEntry[] = [];
  for (const raw of rawEntries) {
    if (!isRecord(raw)
      || !isProjectionCategory(raw["category"])
      || !hasStrings(raw, ["effectiveId", "sourceSpec", "sourcePath", "resourcePath", "absolutePath"])
      || !isOptionalString(raw["resourceType"])
      || !isOptionalString(raw["target"])
      || !isOptionalOneOf(raw["mergeStrategy"], ["managed_block", "append"] as const)
      || !isOptionalOneOf(raw["pluginType"], ["claude", "codex", "auto"] as const)) {
      return malformedStartupContext(nodeId, "projection_entries_json contains an invalid entry");
    }
    // S04 owns the live ambient skill set. Replaying the older catalog
    // selection here could reinstall a skill that work-install removed.
    if (raw["category"] === "skill") continue;
    // #261: shipped-spec resources follow the running install.
    entries.push(reanchorShippedProjectionEntry({
      category: raw["category"],
      effectiveId: raw["effectiveId"],
      sourceSpec: raw["sourceSpec"],
      sourcePath: raw["sourcePath"],
      resourcePath: raw["resourcePath"],
      absolutePath: raw["absolutePath"],
      classification: "safe_projection",
      ...(typeof raw["resourceType"] === "string" ? { resourceType: raw["resourceType"] } : {}),
      ...(typeof raw["mergeStrategy"] === "string" ? { mergeStrategy: raw["mergeStrategy"] as ProjectionEntry["mergeStrategy"] } : {}),
      ...(typeof raw["target"] === "string" ? { target: raw["target"] } : {}),
      ...(typeof raw["pluginType"] === "string" ? { pluginType: raw["pluginType"] as ProjectionEntry["pluginType"] } : {}),
    }));
  }

  const resolvedStartupFiles: ResolvedStartupFile[] = [];
  for (const raw of rawFiles) {
    if (!isRecord(raw)
      || !hasStrings(raw, ["path", "absolutePath", "ownerRoot"])
      || !isOneOf(raw["deliveryHint"], ["auto", "guidance_merge", "skill_install", "send_text"] as const)
      || typeof raw["required"] !== "boolean"
      || !isStringArrayOf(raw["appliesOn"], ["fresh_start", "restore"] as const)
      || !isOptionalOneOf(raw["kind"], ["file"] as const)) {
      return malformedStartupContext(nodeId, "resolved_files_json contains an invalid entry");
    }
    // #261: recognized built-in startup files follow the running install.
    resolvedStartupFiles.push(reanchorBuiltinStartupFile({
      path: raw["path"],
      absolutePath: raw["absolutePath"],
      ownerRoot: raw["ownerRoot"],
      deliveryHint: raw["deliveryHint"],
      required: raw["required"],
      appliesOn: raw["appliesOn"],
      ...(raw["kind"] === "file" ? { kind: "file" as const } : {}),
      // The guarded-reader flag must survive the reload, or a relaunch reads the culture file unguarded.
      ...(raw["guardedRead"] === true ? { guardedRead: true as const } : {}),
    }));
  }

  const startupActions: StartupAction[] = [];
  for (const raw of rawActions) {
    if (!isRecord(raw)
      || !isOneOf(raw["type"], ["slash_command", "send_text", "startup_proof"] as const)
      || typeof raw["value"] !== "string"
      || !isOneOf(raw["phase"], ["after_files", "after_ready"] as const)
      || !isStringArrayOf(raw["appliesOn"], ["fresh_start", "restore"] as const)
      || typeof raw["idempotent"] !== "boolean"
      || !isOptionalOneOf(raw["builtin"], ["session_identity"] as const)) {
      return malformedStartupContext(nodeId, "startup_actions_json contains an invalid entry");
    }
    startupActions.push({
      type: raw["type"],
      value: raw["value"],
      phase: raw["phase"],
      appliesOn: raw["appliesOn"],
      idempotent: raw["idempotent"],
      ...(raw["builtin"] === "session_identity" ? { builtin: "session_identity" as const } : {}),
    });
  }

  try {
    resolveStartupProof(startupActions, "fresh_start");
  } catch (err) {
    return malformedStartupContext(nodeId, (err as Error).message);
  }

  const startupFiles = resolvedStartupFiles.map((file) => ({
    kind: file.kind,
    path: file.path,
    deliveryHint: file.deliveryHint,
    required: file.required,
    appliesOn: file.appliesOn,
  }));
  const plan: ProjectionPlan = {
    runtime: row.runtime,
    cwd,
    entries,
    startup: { files: startupFiles, actions: startupActions },
    conflicts: [],
    noOps: [],
    diagnostics: [],
  };
  const hash = createHash("sha256")
    .update(JSON.stringify([row.projection_entries_json, row.resolved_files_json, row.startup_actions_json, row.runtime]))
    .digest("hex");
  return { ok: true, context: { plan, resolvedStartupFiles, startupActions, runtime: row.runtime, hash } };
}

function malformedStartupContext(nodeId: string, detail: string): { ok: false; refusal: FreshStartupRefusal } {
  return {
    ok: false,
    refusal: {
      ok: false,
      code: "startup_context_malformed",
      message: `Persisted startup context is malformed for node ${nodeId}: ${detail}.`,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasStrings<T extends string>(value: Record<string, unknown>, keys: readonly T[]): value is Record<T, string> & Record<string, unknown> {
  return keys.every((key) => typeof value[key] === "string" && value[key].trim().length > 0);
}

function isProjectionCategory(value: unknown): value is ProjectionEntry["category"] {
  return isOneOf(value, ["skill", "guidance", "subagent", "plugin", "runtime_resource"] as const);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

function isOptionalOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T | undefined {
  return value === undefined || isOneOf(value, allowed);
}

function isStringArrayOf<T extends string>(value: unknown, allowed: readonly T[]): value is T[] {
  return Array.isArray(value) && value.every((entry) => isOneOf(entry, allowed));
}
