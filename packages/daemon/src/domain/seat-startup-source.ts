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
import type { SkillLoadout, SkillRuntime } from "./skill-catalog.js";

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
      /** OF-32 N6: the re-read's S04 skill loadout, already checked (nothing written); null when nothing reconciles. */
      skills: SeatSkillProjection | null;
    };

/** One seat's S04 managed-skill loadout as a launch reconciles it: first launch, and a fresh re-read of its spec. */
export interface SeatSkillProjection {
  loadout: SkillLoadout;
  runtime: SkillRuntime;
  cwd: string;
  /** The seat's canonical session name: one owner across first launch and every re-read. */
  topologyOwner: string;
}

export type SeatSkillProjectionResult = { ok: true; warnings: string[] } | { ok: false; error: string };

/**
 * The seam a fresh launch asks for a re-read; PodRigInstantiator implements it. `readSeatStartupFromSpec` reads only
 * and writes nothing. `projectSeatSkills` writes the skills a re-read checked; a caller runs it only for a context it
 * re-read (source `spec`), after its last refusal and before the launch, so a seat that replays its stored context
 * never reconciles.
 */
export interface SeatStartupSpecReader {
  readSeatStartupFromSpec(input: { rigId: string; nodeId: string; adapter: RuntimeAdapter; sessionName: string }): Promise<SeatStartupRead>;
  projectSeatSkills(skills: SeatSkillProjection): SeatSkillProjectionResult;
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
  /** OF-32 N6: set only on a re-read: the skills its launch reconciles through `SeatStartupSpecReader.projectSeatSkills`. */
  skills?: SeatSkillProjection;
}

/**
 * OF-32 N6: reconcile a re-read context's skills, as first launch does, just before its launch. Does nothing for a
 * context replayed from storage (it carries no skills). On success the reconciler's warnings join the source warnings.
 */
export function projectRereadSkills(specReader: SeatStartupSpecReader | null, context: FreshStartupContext): { ok: true } | { ok: false; message: string } {
  if (!context.skills) return { ok: true };
  if (!specReader) return { ok: false, message: "This daemon cannot project a re-read seat's skills." };
  const projected = specReader.projectSeatSkills(context.skills);
  if (!projected.ok) return { ok: false, message: `Its skills could not be projected into ${context.skills.cwd}: ${projected.error}.` };
  context.sourceWarnings.push(...projected.warnings);
  return { ok: true };
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
      // N-C2 re-check N6: the caller's guidance offers the stored files as the way out; when they cannot be used either,
      // that escape is refused too (it would print the spec-route advice back), so it is not offered.
      const stored = readStoredStartupContext(deps.db, input.nodeId, input.cwd);
      const guidance = stored.ok ? input.refusalGuidance
        : `Restore or fix the spec at that path. The seat's saved startup context cannot be used either (${stored.refusal.message}), so rig seat launch --fresh --startup-from stored is refused too.`;
      return { ok: false, code: read.code, message: read.message, guidance };
    }
    if (read.kind === "spec") {
      // The plan's skill entries stay out of the adapter's projection, as on the stored path: S04's reconciler owns the
      // live skill set. A re-read reaches it through `read.skills` instead (OF-32 N6), as first launch does.
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
        sourceWarnings: [...read.warnings],
        ...(read.skills ? { skills: read.skills } : {}),
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
    if (!startup.ok) {
      return startup.refusal.code === "startup_context_malformed"
        ? { ...startup.refusal, guidance: malformedContextGuidance(input, {
            notJson: startup.unparseable === true,
            // A spec is read on this refusal only when the operator asked for the stored files; and it must be recorded.
            specRoute: storedReason === "requested" && !!deps.rigRepo.getRigSpecSource(input.rigId),
            rigName: (deps.db.prepare("SELECT name FROM rigs WHERE id = ?").get(input.rigId) as { name: string } | undefined)?.name ?? input.rigId,
          }) }
        : startup.refusal;
    }
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

/**
 * What the operator can do about a saved startup context that cannot be read (N-C2, rewritten for OF-36). The advice
 * splits on what this builder knows, and every command it names was run against the real CLI
 * (seat-malformed-context-cli.integration.test.ts):
 *  - `specRoute`: the operator asked for `--startup-from stored` and the rig records a spec source. Then
 *    `rig seat launch <seat@rig> --fresh --stop` (default: re-read the spec) heals every kind of unreadable row, keeps
 *    the other seats running, and delivers the spec's CURRENT startup files, not the saved ones. A spec that can no
 *    longer start the seat refuses it and changes nothing; the restore route below is then the way back.
 *  - The restore route (OF-36). Restore treats an unreadable row as no row: a seat it starts fresh replays the newest
 *    snapshot copy of its startup files that is valid, and a successful launch saves it as the seat's new context; when
 *    no snapshot holds a valid copy it refuses that seat and starts nothing for it.
 *    - Wrong shape: `rig down` copies the row verbatim (that copy is passed over), and
 *      `rig up --existing --fresh <seat> --startup-from stored` starts the seat fresh whatever its restore policy.
 *    - Not JSON: `rig down` cannot snapshot the seat, so a following `rig up --existing` has no snapshot of the rig as
 *      it was stopped (what it does instead depends on the older snapshots: N-C2 N5 measured `no_snapshot` with none);
 *      the rig is never advised to be stopped. `rig seat stop` + `rig launch <rig> <seat>` restores
 *      only this seat, and starts it fresh only when its restore policy does (for example checkpoint_only); under the
 *      default policy a seat with a resume token is resumed, nothing is delivered and the row stays unreadable.
 */
function malformedContextGuidance(
  input: { rigId: string; logicalId: string; sessionName: string },
  how: { notJson: boolean; specRoute: boolean; rigName: string },
): string {
  const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
  const repair = "the saved row has to be repaired outside restore";
  const viaRestore = how.notJson
    ? `Do not stop the rig: rig down cannot snapshot this seat, so a following rig up --existing has no snapshot of the rig as it was stopped. Stop only this seat (rig seat stop ${quote(input.sessionName)} --reason "<why>"), then run rig launch ${input.rigId} ${input.logicalId}: a seat that starts fresh there (for example under restore policy checkpoint_only) replays the newest snapshot copy of its startup files that is valid and saves it as its new context, or, if no snapshot holds one, is refused and nothing is started for it. Under the default policy (resume_if_possible) a seat with a resume token is resumed instead: nothing is delivered and the context stays unreadable. If it is resumed or refused, ${repair}.`
    : `A restore that starts this seat fresh replays the newest snapshot copy of its startup files that is valid and saves it as its new context: rig down ${quote(how.rigName)}, then rig up ${quote(how.rigName)} --existing --fresh ${quote(input.logicalId)} --startup-from stored (this stops and restarts every seat; the snapshot rig down takes carries the damage and is passed over). If no snapshot holds a valid copy, that restore refuses this seat and starts nothing for it; then ${repair}. Note that rig launch ${input.rigId} ${input.logicalId} on its own resumes a seat that has a resume token under the default restore policy (resume_if_possible), delivers nothing and leaves the context unreadable.`;
  if (how.specRoute) {
    return `Start it from the rig's recorded spec instead: rig seat launch ${quote(`${input.logicalId}@${how.rigName}`)} --fresh --stop --reason "<why>". That re-reads the spec and delivers the spec's current startup files, not the saved ones, saves them as the seat's new context, and leaves the other seats running. If the spec can no longer start the seat, that launch is refused and changes nothing. ${viaRestore}`;
  }
  return how.notJson
    ? `A column of the saved startup context is not JSON, and there is no spec to re-read for this seat. ${viaRestore}`
    : `The saved startup context is not a valid startup setup, and there is no spec to re-read for this seat. ${viaRestore}`;
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
): { ok: true; context: Omit<FreshStartupContext, "source" | "sourceWarnings" | "resolvedSpec"> } | { ok: false; refusal: FreshStartupRefusal; unparseable?: true } {
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
    return { ...malformedStartupContext(nodeId, `JSON parse failed: ${error instanceof Error ? error.message : String(error)}`), unparseable: true };
  }
  const parsed = parseStartupContextShape({ projectionEntries: rawEntries, resolvedStartupFiles: rawFiles, startupActions: rawActions, runtime: row.runtime });
  if (!parsed.ok) return malformedStartupContext(nodeId, parsed.detail);
  const { entries, resolvedStartupFiles, startupActions } = parsed;

  const startupFiles = resolvedStartupFiles.map((file) => ({
    kind: file.kind,
    path: file.path,
    deliveryHint: file.deliveryHint,
    required: file.required,
    appliesOn: file.appliesOn,
  }));
  const runtime = row.runtime as string;
  const plan: ProjectionPlan = {
    runtime,
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
  return { ok: true, context: { plan, resolvedStartupFiles, startupActions, runtime, hash } };
}

/**
 * OF-36: the one rule for whether a saved startup context (parsed) is a valid startup setup: the rule the seat's own
 * fresh launch applies to its row (`readStoredStartupContext`), and the rule restore applies to the row and to every
 * snapshot copy it might replay instead (own-startup-replay.ts). On success it gives the context as a launch replays it
 * (skill entries dropped, built-ins re-anchored to the running install).
 */
export function parseStartupContextShape(raw: { projectionEntries: unknown; resolvedStartupFiles: unknown; startupActions: unknown; runtime: unknown }):
  { ok: true; entries: ProjectionEntry[]; resolvedStartupFiles: ResolvedStartupFile[]; startupActions: StartupAction[] } | { ok: false; detail: string } {
  const rawEntries = raw.projectionEntries;
  const rawFiles = raw.resolvedStartupFiles;
  const rawActions = raw.startupActions;
  if (!Array.isArray(rawEntries) || !Array.isArray(rawFiles) || !Array.isArray(rawActions) || typeof raw.runtime !== "string" || !raw.runtime.trim()) {
    return { ok: false, detail: "projection entries, resolved files, and startup actions must be arrays and runtime must be non-empty" };
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
      return { ok: false, detail: "projection_entries_json contains an invalid entry" };
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
      return { ok: false, detail: "resolved_files_json contains an invalid entry" };
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
      return { ok: false, detail: "startup_actions_json contains an invalid entry" };
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
    return { ok: false, detail: (err as Error).message };
  }
  return { ok: true, entries, resolvedStartupFiles, startupActions };
}

/** Why a parsed startup context is not a valid startup setup, or null when it is (`parseStartupContextShape`). */
export function startupContextShapeProblem(raw: { projectionEntries: unknown; resolvedStartupFiles: unknown; startupActions: unknown; runtime: unknown }): string | null {
  const parsed = parseStartupContextShape(raw);
  return parsed.ok ? null : parsed.detail;
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
