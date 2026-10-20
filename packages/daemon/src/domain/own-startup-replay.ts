// What restore does with a seat's OWN saved startup context (node_startup_context) when the seat is started fresh
// without being listed with --fresh (and for the pre-restore validation of such a seat). Restore and restore-check
// both ask this module, so the check cannot read the row differently from the restore it predicts (OF-32 follow-up,
// N-C4).
//
// Restore reads the row leniently: anything that is JSON is replayed as it is, and the snapshot's copy is used only
// when the seat has no row or a column is not JSON. A row that is JSON of the wrong shape is therefore NOT a row
// without a context: it is replayed, and the replay can fail. Measured at 95fd7cc0 (restore-check-predicts-refusals
// test, "agreement table"): a column that is not a list, or a null member of the files or projection list, ends the
// restore (`restore_error`, or the seat `failed` after its launch with the session left in place); other odd members
// (a number, an object with no path) are replayed without complaint.
import type Database from "better-sqlite3";
import { readNodeStartupSnapshot } from "./snapshot-capture.js";
import type { NodeStartupSnapshot } from "./types.js";

export type OwnStartupForRestore =
  /** The seat has no saved context: restore replays the snapshot's copy. */
  | { kind: "none" }
  /** A column is not JSON: restore replays the snapshot's copy instead (its pre-restore capture throws on it, so a
   *  whole `restore()` fails first; `rig launch` falls back). */
  | { kind: "unparseable"; why: string }
  /** The row parsed: restore replays it. `replayProblem` says why that replay fails, when it does. */
  | { kind: "row"; snapshot: NodeStartupSnapshot; replayProblem: string | null };

/** Why restore cannot replay this (parsed) saved context, or null when it can. Derived from what restore dereferences
 *  when it validates and replays a context: the three lists are iterated, and the files and projection members are
 *  read property by property. */
export function ownStartupReplayProblem(ctx: unknown): string | null {
  const row = (ctx ?? {}) as Record<string, unknown>;
  for (const [field, column] of [["projectionEntries", "projection_entries_json"], ["resolvedStartupFiles", "resolved_files_json"], ["startupActions", "startup_actions_json"]] as const) {
    if (!Array.isArray(row[field])) return `${column} is not a list`;
  }
  if ((row["resolvedStartupFiles"] as unknown[]).some((member) => member === null)) return "resolved_files_json has an empty member";
  if ((row["projectionEntries"] as unknown[]).some((member) => member === null)) return "projection_entries_json has an empty member";
  return null;
}

export function readOwnStartupForRestore(db: Database.Database, nodeId: string): OwnStartupForRestore {
  let snapshot: NodeStartupSnapshot | null;
  try {
    snapshot = readNodeStartupSnapshot(db, nodeId);
  } catch (err) {
    return { kind: "unparseable", why: (err as Error).message };
  }
  return snapshot ? { kind: "row", snapshot, replayProblem: ownStartupReplayProblem(snapshot) } : { kind: "none" };
}
