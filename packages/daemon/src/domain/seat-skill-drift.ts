// workspaces-o9o.30: skill drift of a seat whose fresh launch replays saved startup files.
//
// A launch from the stored files (`--startup-from stored`) or a snapshot's copy (`--startup-from snapshot:<id>`) never
// reconciles skills: the replayed context carries none (seat-startup-source.ts, projectRereadSkills). So after the spec
// narrows or changes a seat's skills, the seat keeps the set its last reconcile recorded. The drift is the difference
// between that recorded set and the set the spec selects now, both for the seat's OWN topology owner in the skill
// ownership manifest: seats that share a folder keep each other's skills, so a folder's on-disk union is not this
// seat's selection. Pure: the caller reads both sides (a read-only spec re-read) and records what this returns.
import { freshSeatLaunchCommand } from "./active-occupant.js";
import type { RigEvent } from "./types.js";

/** The skills a seat's recorded selection and its spec's current selection disagree on. Both lists are sorted. */
export interface SeatSkillDrift {
  /** Recorded for the seat (still projected) but no longer selected by its spec. */
  extra: string[];
  /** Selected by the spec but not recorded for the seat (never projected for it). */
  missing: string[];
}

/** Where a launch that does not reconcile took its startup files from. */
export type ReplayedStartup = { kind: "stored" } | { kind: "snapshot"; snapshotId: string };

/** One drift observation, as a launch carries it and `seat.skills_drift_observed` records it. */
export interface SeatSkillDriftObservation extends SeatSkillDrift {
  specSource: string;
  replayed: ReplayedStartup;
  /** The command that brings the seat's skills in line with its spec, as the CLI spells it. */
  fix: string;
}

const byBytes = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The drift between a seat's recorded and planned topology selections, or null when they hold the same skills. */
export function compareSeatSkillSelection(selection: { recorded: readonly string[]; planned: readonly string[] }): SeatSkillDrift | null {
  const recorded = new Set(selection.recorded);
  const planned = new Set(selection.planned);
  const extra = [...recorded].filter((id) => !planned.has(id)).sort(byBytes);
  const missing = [...planned].filter((id) => !recorded.has(id)).sort(byBytes);
  return extra.length === 0 && missing.length === 0 ? null : { extra, missing };
}

/** The fix: a fresh launch from the spec (the default source), which reconciles skills. The seat is live after the
 *  replay that found the drift, so the command carries `--stop`. */
export function seatSkillDriftFix(logicalId: string, rigHandle: string): string {
  return freshSeatLaunchCommand(logicalId, rigHandle, undefined, { stop: true });
}

function replayedPhrase(replayed: ReplayedStartup): string {
  return replayed.kind === "snapshot" ? `snapshot ${replayed.snapshotId}'s copy of its startup files` : "the startup files saved at its last successful launch";
}

/** The launch warning for an observed drift. */
export function seatSkillDriftWarning(observation: SeatSkillDriftObservation): string {
  const parts = [
    observation.extra.length > 0 ? `no longer in the spec: ${observation.extra.join(", ")}` : null,
    observation.missing.length > 0 ? `in the spec but not projected: ${observation.missing.join(", ")}` : null,
  ].filter((part): part is string => part !== null);
  return `skills_drift: this launch replayed ${replayedPhrase(observation.replayed)}, which never update a seat's skills, `
    + `so its skills differ from its spec ${observation.specSource} (${parts.join("; ")}). `
    + `To bring them in line with the spec, run: ${observation.fix}`;
}

/** The launch warning when the spec could not be read to compare against. The launch itself is unaffected. */
export function seatSkillDriftUncheckedWarning(replayed: ReplayedStartup, reason: string): string {
  return `skills_drift_unchecked: this launch replayed ${replayedPhrase(replayed)}, which never update a seat's skills, `
    + `and its skills were not compared with its spec, which could not be read: ${reason}`;
}

type SkillsDriftEvent = Extract<RigEvent, { type: "seat.skills_drift_observed" }>;

/** What a launch that has started its seat learned about the seat's skills against its spec. */
export type SkillsAfterLaunch =
  /** A replay whose recorded skills differ from the spec's. */
  | { kind: "drift"; observation: SeatSkillDriftObservation }
  /** The skills match the spec: a launch from the spec (it reconciled them), or a replay whose comparison found no drift. */
  | { kind: "in_line"; specSource: string; startupSource: "spec" | "stored" | "snapshot"; snapshotId?: string }
  /** Nothing was compared (no spec source, a seat the spec does not declare, an unreadable spec, a restore replay the
   *  operator did not ask for): whatever was recorded before still stands. */
  | { kind: "unknown" };

/** The minimal read of the events table this module needs: a port, so the core imports no database driver. */
export interface SkillsDriftEventReader {
  prepare(sql: string): { get(...params: unknown[]): unknown };
}

/** A seat's current skill drift as `rig seat status` reports it, or null. */
export interface SeatSkillDriftStatus extends SeatSkillDrift {
  specSource: string;
  startupSource: "stored" | "snapshot";
  snapshotId?: string;
  fix: string;
  observedAt: string;
}

/**
 * The seat's current drift: its newest `seat.skills_drift_observed` event, when that one names a drift. A launch that
 * finds the seat's skills in line records an empty observation only while a drift is shown (`skillsDriftEventAfterLaunch`),
 * so the newest event is always the seat's current state.
 */
export function readSeatSkillDrift(events: SkillsDriftEventReader, nodeId: string): SeatSkillDriftStatus | null {
  const row = events.prepare("SELECT payload, created_at AS createdAt FROM events WHERE node_id = ? AND type = 'seat.skills_drift_observed' ORDER BY seq DESC LIMIT 1")
    .get(nodeId) as { payload: string; createdAt: string } | undefined;
  if (!row) return null;
  let event: SkillsDriftEvent;
  try { event = JSON.parse(row.payload) as SkillsDriftEvent; } catch { return null; }
  if (event.startupSource === "spec" || !event.fix || (event.extra.length === 0 && event.missing.length === 0)) return null;
  return {
    extra: event.extra, missing: event.missing, specSource: event.specSource, startupSource: event.startupSource,
    ...(event.snapshotId ? { snapshotId: event.snapshotId } : {}), fix: event.fix, observedAt: row.createdAt,
  };
}

/**
 * The `seat.skills_drift_observed` event a launch records once it has started the seat, or null: a drift always; skills
 * in line only while the seat shows a drift (`shownDrift`), which that empty observation then clears; nothing when
 * nothing was compared.
 */
export function skillsDriftEventAfterLaunch(
  seat: { rigId: string; nodeId: string; logicalId: string; sessionName: string },
  after: SkillsAfterLaunch,
  shownDrift: boolean,
): SkillsDriftEvent | null {
  if (after.kind === "drift") {
    const { observation } = after;
    return {
      type: "seat.skills_drift_observed", ...seat,
      specSource: observation.specSource, startupSource: observation.replayed.kind,
      ...(observation.replayed.kind === "snapshot" ? { snapshotId: observation.replayed.snapshotId } : {}),
      extra: [...observation.extra], missing: [...observation.missing], fix: observation.fix,
    };
  }
  if (after.kind === "in_line" && shownDrift) {
    return {
      type: "seat.skills_drift_observed", ...seat,
      specSource: after.specSource, startupSource: after.startupSource,
      ...(after.snapshotId ? { snapshotId: after.snapshotId } : {}),
      extra: [], missing: [],
    };
  }
  return null;
}
