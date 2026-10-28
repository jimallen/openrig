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
import { adapterFreshStart, type ResolvedStartupFile, type RuntimeAdapter } from "./runtime-adapter.js";
import type { StartupAction } from "./types.js";
import { resolveStartupProof } from "./startup-resolver.js";
import { serializeStartupContext } from "./startup-orchestrator.js";
import { reanchorBuiltinStartupFile, reanchorShippedProjectionEntry } from "./builtin-startup-files.js";
import type { SkillLoadout, SkillRuntime } from "./skill-catalog.js";
import { newestUsableSnapshotCopy, startupContextUnusable, unreadableSnapshotsNote, type UsableSnapshotCopy } from "./own-startup-replay.js";
import { rigAdviceHandleIn } from "./rig-ref.js";

/** What the operator asked a fresh launch to start from. `snapshot:<id>` (OF-36 Q2, Jim 2026-10-20): that snapshot's
 *  copy of the seat's startup context, held to the same rule as the seat's own row before anything is stopped. */
export type StartupFrom = "spec" | "stored" | `snapshot:${string}`;

export const STARTUP_FROM_VALUES: readonly ("spec" | "stored")[] = ["spec", "stored"];
/** Every accepted spelling, for refusal messages. */
export const STARTUP_FROM_FORMS = "one of: spec, stored, snapshot:<snapshot-id>";

/** `--startup-from` / `startupFrom` as given, or null when it is not one of the accepted spellings. */
export function parseStartupFrom(value: unknown): StartupFrom | null {
  if (value === "spec" || value === "stored") return value;
  return typeof value === "string" && /^snapshot:[A-Za-z0-9_-]+$/.test(value) ? value as StartupFrom : null;
}

/** The snapshot id of `snapshot:<id>`, or null. */
export function startupFromSnapshotId(value: StartupFrom | undefined): string | null {
  return value?.startsWith("snapshot:") ? value.slice("snapshot:".length) : null;
}

export type SeatStartupRead =
  /** The rig records no spec source (created before OpenRig recorded one, or not from a spec file). */
  | { kind: "unrecorded" }
  /** The recorded spec does not declare this seat (added with `rig add` after launch, or dropped from the spec). */
  | { kind: "undeclared"; specSource: string }
  /** A source is recorded but cannot give this seat a startup policy; nothing was launched or written. */
  | { kind: "refused"; code: "startup_source_unavailable" | "startup_source_changed" | "startup_source_untrusted"; message: string; specSource: string;
      /** What to do about this refusal, when the usual "restore the spec, or use the stored files" advice would be wrong for it. */
      guidance?: string }
  | {
      kind: "spec";
      /** The recorded spelling, for example a spec library link. */
      specSource: string;
      /** The file actually read, after re-anchoring and following links. */
      specPath: string;
      plan: ProjectionPlan;
      resolvedStartupFiles: ResolvedStartupFile[];
      startupActions: StartupAction[];
      /** Absent for a terminal seat: it has no agent spec. */
      resolvedSpec?: { name: string; version: string; hash: string };
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
  /**
   * OF-122: the agent provenance (name, version, hash) of the persona a seat's `path:` agent_ref reaches NOW, for a launch
   * that replays the saved startup files (they follow the path as typed, so they deliver that release). Null when the
   * seat has no `path:` ref or the persona cannot be read: the recorded provenance then stays as it is. Reads only.
   */
  readSeatAgentProvenance?(input: { nodeId: string }): { name: string; version: string; hash: string } | null;
  /**
   * OF-107: whether the rig's recorded spec source is one a fresh launch refuses (`startup_source_untrusted`). Advice that
   * offers "start it from the recorded spec" asks this first, so it never names a route that is refused. False when no
   * source is recorded, when it is trusted, or when it cannot be judged (a missing file is "unavailable", not untrusted).
   */
  recordedSpecSourceUntrusted?(rigId: string): boolean;
}

/** OF-107: `SeatStartupSpecReader.recordedSpecSourceUntrusted`, false when the daemon has no reader. */
export function specSourceUntrusted(reader: SeatStartupSpecReader | null | undefined, rigId: string): boolean {
  return reader?.recordedSpecSourceUntrusted?.(rigId) ?? false;
}

/** OF-107: how to get past a refused (untrusted) recorded spec source: record a reviewed copy from a trusted spec root. */
export function untrustedSpecSourceRemedy(rigId: string): string {
  return `Fixing or restoring the file at the recorded path does not help; record a reviewed copy from a trusted spec root instead: rig spec-source set ${rigId} <path-to-rig.yaml> --operator <address> (rig spec-source show ${rigId} says whether a launch would refuse the recorded one).`;
}

/** OF-32: where a fresh launch took its startup policy from, as reported to the operator and the audit event. */
export type FreshStartupSource =
  | { kind: "spec"; specSource: string; specPath: string }
  | { kind: "stored"; reason: "requested" | "no_recorded_source" | "not_in_spec" }
  /** OF-36 Q2: `--startup-from snapshot:<id>`, that snapshot's copy of the seat's startup context. */
  | { kind: "snapshot"; snapshotId: string };

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
    | "startup_source_untrusted"
    | "runtime_adapter_missing"
    | "launch_unavailable"
    | "fresh_start_unsupported";
  message: string;
  guidance?: string;
}

/** pda L2a (design A4, census row 25): the refusal for a seat whose runtime has no fresh start. One text, so restore,
 *  restore-check, the plan and `rig seat launch --fresh` say the same thing. It never suggests `--fresh`. */
export function freshStartUnsupportedRefusal(runtime: string, logicalId: string): FreshStartupRefusal {
  return {
    ok: false, code: "fresh_start_unsupported",
    message: `${logicalId} is a ${runtime} seat, and a ${runtime} seat has no fresh start: ${runtime} owns the conversation, and OpenRig never creates or resets it.`,
    guidance: "Resume it instead: rig up <rig> --existing re-attaches the seat to the agent its resume token names. To drive another agent, re-instantiate the seat with that binding.",
  };
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
    /** OF-107: the stored escape alone, for a refusal where fixing the spec is not the way out (`startup_source_untrusted`). */
    storedEscapeGuidance?: string;
  },
): Promise<{ ok: true; context: FreshStartupContext } | FreshStartupRefusal> {
  // pda L2a (design A4): checked FIRST, before any source is read, for every caller of this one decision (restore of a
  // `--fresh`-listed seat, its prediction in restore-check and the plan, and `rig seat launch --fresh`).
  const runtimeAdapter = input.runtime ? deps.runtimeAdapters[input.runtime] : undefined;
  if (runtimeAdapter && adapterFreshStart(runtimeAdapter) === "unsupported") return freshStartUnsupportedRefusal(input.runtime!, input.logicalId);
  const fromSnapshot = startupFromSnapshotId(input.startupFrom);
  if (fromSnapshot) {
    // OF-36 Q2: an explicitly named snapshot's copy, checked here, before anything is stopped or launched.
    const copy = readSnapshotStartupCopy(deps.db, input, fromSnapshot);
    return copy.ok ? { ok: true, context: copy.context } : { ok: false, code: "startup_source_unavailable", message: copy.message, guidance: copy.guidance };
  }
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
      // OF-107: an untrusted source is not repaired by restoring or fixing the file at its path, so the usual advice would
      // send the operator in a circle; it is told to record a trusted copy, with the stored files as the other way out.
      const untrustedGuidance = read.code === "startup_source_untrusted"
        ? `${untrustedSpecSourceRemedy(input.rigId)}${stored.ok && input.storedEscapeGuidance ? ` Or ${input.storedEscapeGuidance}` : ""}`
        : undefined;
      const guidance = read.guidance ? read.guidance : untrustedGuidance ? untrustedGuidance : stored.ok ? input.refusalGuidance
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
        ...(read.resolvedSpec ? { resolvedSpec: read.resolvedSpec } : {}),
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
            specRoute: storedReason === "requested" && !!deps.rigRepo.getRigSpecSource(input.rigId) && !specSourceUntrusted(deps.specReader, input.rigId),
            rigName: ((name) => name === undefined ? input.rigId : rigAdviceHandleIn(deps.db, input.rigId, name))(
              (deps.db.prepare("SELECT name FROM rigs WHERE id = ?").get(input.rigId) as { name: string } | undefined)?.name),
            snapshotRoute: newestUsableSnapshotCopy(deps.db, input.rigId, input.logicalId, input.runtime),
          }) }
        : startup.refusal;
    }
    // OF-122: the stored files follow the typed path, so the launch delivers the release it reaches now; the node's
    // recorded version and hash (what `rig whoami` shows) are refreshed to that release when the launch succeeds.
    const provenance = deps.specReader?.readSeatAgentProvenance?.({ nodeId: input.nodeId }) ?? null;
    context = {
      ...startup.context,
      ...(provenance ? { resolvedSpec: provenance } : {}),
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
 *      `rig launch <rig> <seat>` alone resumes a seat with a resume token under the default policy.
 *    - Not JSON (OF-36 Q1): `rig down` snapshots the rig with no copy for this seat, so the same route applies.
 */
function malformedContextGuidance(
  input: { rigId: string; logicalId: string; sessionName: string },
  how: { notJson: boolean; specRoute: boolean; rigName: string; snapshotRoute: UsableSnapshotCopy | null },
): string {
  const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
  const repair = "the saved row has to be repaired outside restore";
  // OF-36 Q2: when some snapshot holds a valid copy, the narrowest way back is that copy, for this seat only.
  const viaSnapshot = how.snapshotRoute
    ? `To start only this seat from the newest snapshot copy of its startup files that is valid, leaving the other seats running: rig seat launch ${quote(`${input.logicalId}@${how.rigName}`)} --fresh --stop --startup-from snapshot:${how.snapshotRoute.snapshotId} --reason "<why>" (snapshot ${how.snapshotRoute.snapshotId}, ${how.snapshotRoute.kind}, taken ${how.snapshotRoute.createdAt}; the launch saves that copy as the seat's new context).${unreadableSnapshotsNote(how.snapshotRoute)} `
    : "No snapshot of this rig holds a valid copy of this seat's startup files. ";
  // OF-36 Q1: `rig down` now snapshots the rig even when this seat's context is not JSON (that seat gets no copy), so
  // one restore route serves both kinds of damage.
  const viaRestore = `A restore that starts this seat fresh replays the newest snapshot copy of its startup files that is valid and saves it as its new context: rig down ${input.rigId}, then rig up ${quote(how.rigName)} --existing --fresh ${quote(input.logicalId)} --startup-from stored (this stops and restarts every seat; the snapshot rig down takes ${how.notJson ? "holds no copy of this context" : "carries the damage"} and is passed over). If no snapshot holds a valid copy, that restore refuses this seat and starts nothing for it; then ${repair}. Note that rig launch ${input.rigId} ${input.logicalId} on its own resumes a seat that has a resume token under the default restore policy (resume_if_possible), delivers nothing and leaves the context unreadable.`;
  if (how.specRoute) {
    return `${viaSnapshot}Or start it from the rig's recorded spec instead: rig seat launch ${quote(`${input.logicalId}@${how.rigName}`)} --fresh --stop --reason "<why>". That re-reads the spec and delivers the spec's current startup files, not the saved ones, saves them as the seat's new context, and leaves the other seats running. If the spec can no longer start the seat, that launch is refused and changes nothing. ${viaRestore}`;
  }
  return how.notJson
    ? `A column of the saved startup context is not JSON, and there is no spec to re-read for this seat. ${viaSnapshot}${viaRestore}`
    : `The saved startup context is not a valid startup setup, and there is no spec to re-read for this seat. ${viaSnapshot}${viaRestore}`;
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

  const hash = createHash("sha256")
    .update(JSON.stringify([row.projection_entries_json, row.resolved_files_json, row.startup_actions_json, row.runtime]))
    .digest("hex");
  return { ok: true, context: startupContextOf({ entries, resolvedStartupFiles, startupActions }, row.runtime as string, cwd, hash) };
}

function startupContextOf(
  parsed: { entries: ProjectionEntry[]; resolvedStartupFiles: ResolvedStartupFile[]; startupActions: StartupAction[] },
  runtime: string, cwd: string, hash: string,
): Omit<FreshStartupContext, "source" | "sourceWarnings" | "resolvedSpec"> {
  const startupFiles = parsed.resolvedStartupFiles.map((file) => ({
    kind: file.kind,
    path: file.path,
    deliveryHint: file.deliveryHint,
    required: file.required,
    appliesOn: file.appliesOn,
  }));
  const plan: ProjectionPlan = {
    runtime,
    cwd,
    entries: parsed.entries,
    startup: { files: startupFiles, actions: parsed.startupActions },
    conflicts: [],
    noOps: [],
    diagnostics: [],
  };
  return { plan, resolvedStartupFiles: parsed.resolvedStartupFiles, startupActions: parsed.startupActions, runtime, hash };
}

/**
 * OF-36 Q2: `--startup-from snapshot:<id>`. That snapshot's copy of this seat's startup context (the seat found by
 * logical id: a seat removed and grown back has a new node id), held to the rule the seat's own row is held to
 * (`startupContextUnusable`: the shape its fresh launch accepts, and the seat's runtime). Reads only.
 */
export function readSnapshotStartupCopy(
  db: Database.Database,
  seat: { rigId: string; logicalId: string; runtime: string | null; cwd: string },
  snapshotId: string,
): { ok: true; context: FreshStartupContext } | { ok: false; message: string; guidance: string } {
  const refuse = (message: string) => {
    const best = newestUsableSnapshotCopy(db, seat.rigId, seat.logicalId, seat.runtime);
    return {
      ok: false as const,
      message,
      guidance: best
        ? `The newest snapshot of this rig whose copy of ${seat.logicalId}'s startup files can be used is ${best.snapshotId} (${best.kind}, taken ${best.createdAt}): --startup-from snapshot:${best.snapshotId}.${unreadableSnapshotsNote(best)}`
        : `No snapshot of this rig holds a copy of ${seat.logicalId}'s startup files that can be used.`,
    };
  };
  if (!seat.runtime) return refuse(`Seat ${seat.logicalId} has no runtime, so no snapshot copy can be checked against it.`);
  const row = db.prepare("SELECT rig_id, data FROM snapshots WHERE id = ?").get(snapshotId) as { rig_id: string; data: string } | undefined;
  if (!row) return refuse(`Snapshot ${snapshotId} does not exist.`);
  if (row.rig_id !== seat.rigId) return refuse(`Snapshot ${snapshotId} belongs to another rig, not this seat's.`);
  let data: { nodes?: unknown; nodeStartupContext?: Record<string, unknown> };
  try {
    data = JSON.parse(row.data);
  } catch {
    return refuse(`Snapshot ${snapshotId} cannot be read (its data is not JSON).`);
  }
  const node = Array.isArray(data.nodes)
    ? data.nodes.find((candidate) => !!candidate && typeof candidate === "object" && (candidate as { logicalId?: unknown }).logicalId === seat.logicalId) as { id?: unknown } | undefined
    : undefined;
  if (!node || typeof node.id !== "string") return refuse(`Snapshot ${snapshotId} does not hold seat ${seat.logicalId}.`);
  const copy = data.nodeStartupContext?.[node.id];
  if (copy === null || copy === undefined) return refuse(`Snapshot ${snapshotId} holds no copy of ${seat.logicalId}'s startup context.`);
  const why = startupContextUnusable(copy, seat.runtime);
  if (why) return refuse(`Snapshot ${snapshotId}'s copy of ${seat.logicalId}'s startup context cannot be used: ${why}.`);
  const raw = copy as { projectionEntries: unknown; resolvedStartupFiles: unknown; startupActions: unknown; runtime: string };
  const parsed = parseStartupContextShape(raw);
  if (!parsed.ok) return refuse(`Snapshot ${snapshotId}'s copy of ${seat.logicalId}'s startup context cannot be used: ${parsed.detail}.`);
  const hash = createHash("sha256").update(JSON.stringify([raw.projectionEntries, raw.resolvedStartupFiles, raw.startupActions, raw.runtime])).digest("hex");
  return {
    ok: true,
    context: { ...startupContextOf(parsed, raw.runtime, seat.cwd, hash), source: { kind: "snapshot", snapshotId }, sourceWarnings: [] },
  };
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
