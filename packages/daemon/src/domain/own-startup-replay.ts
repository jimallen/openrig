// What restore replays for a seat it starts fresh: the seat's OWN saved startup context (node_startup_context), or a
// snapshot's copy of it. Restore and restore-check both ask this module (through fresh-seat-restore-decision.ts), so the
// check cannot read the row differently from the restore it predicts (OF-32 N-C4, OF-36, OF-41, OF-39).
//
// The rule (OF-36):
//  - The own row is replayed when it is a valid startup setup for this seat: JSON, the shape the seat's own fresh
//    launch accepts (`parseStartupContextShape`, the one rule), and the seat's runtime. One writer
//    (startup-orchestrator `writeStartupContext`) writes it at every successful launch, so it is the newest context.
//  - A seat with no row replays the restored snapshot's copy, as before (it can be no older than anything).
//  - A row that is not usable (not JSON, the wrong shape, another runtime) is treated as unreadable: restore replays the
//    newest snapshot copy of this seat's context that IS usable. Snapshots copy the row verbatim, so a snapshot taken
//    after the break carries the same damage and fails the same rule; the newest usable copy is therefore the newest one
//    taken before the break (or after a repair). A successful launch saves what it replayed as the seat's new row.
//  - When no snapshot holds a usable copy, restore starts nothing for the seat: before the restore for a seat it would
//    start unlisted, before the seat's launch for a listed seat or a `rig launch` target.
import type Database from "better-sqlite3";
import { readNodeStartupSnapshot } from "./snapshot-capture.js";
import { startupContextShapeProblem, untrustedSpecSourceRemedy } from "./seat-startup-source.js";
import type { NodeStartupSnapshot } from "./types.js";
import { namedRows } from "./named-rows.js";

export type OwnStartupForRestore =
  /** The seat has no saved context. */
  | { kind: "none" }
  /** The row is a valid startup setup for this seat: restore replays it. */
  | { kind: "usable"; snapshot: NodeStartupSnapshot }
  /** The row cannot be replayed: why. */
  | { kind: "unusable"; why: string };

/** Why `ctx` cannot be replayed for a seat whose runtime is `runtime`, or null when it can. `runtime` null: not compared. */
export function startupContextUnusable(ctx: unknown, runtime: string | null): string | null {
  if (!ctx || typeof ctx !== "object" || Array.isArray(ctx)) return "it is not a startup context";
  const row = ctx as Record<string, unknown>;
  const shape = startupContextShapeProblem({
    projectionEntries: row["projectionEntries"], resolvedStartupFiles: row["resolvedStartupFiles"],
    startupActions: row["startupActions"], runtime: row["runtime"],
  });
  if (shape) return shape;
  if (runtime && row["runtime"] !== runtime) return `it names runtime '${String(row["runtime"])}', not the seat's runtime '${runtime}'`;
  return null;
}

export function readOwnStartupForRestore(db: Database.Database, nodeId: string, runtime: string | null): OwnStartupForRestore {
  let snapshot: NodeStartupSnapshot | null;
  try {
    snapshot = readNodeStartupSnapshot(db, nodeId);
  } catch (err) {
    return { kind: "unusable", why: `a column is not JSON (${(err as Error).message})` };
  }
  if (!snapshot) return { kind: "none" };
  const why = startupContextUnusable(snapshot, runtime);
  return why ? { kind: "unusable", why } : { kind: "usable", snapshot };
}

export interface UsableSnapshotCopy {
  snapshotId: string;
  kind: string;
  createdAt: string;
  context: NodeStartupSnapshot;
  /** OF-168: ids of NEWER snapshots of this rig passed over because their saved data is not JSON (so what they hold for this seat
   *  is unknown, not "nothing"). Absent when none were. A caller that replays this copy says so. */
  skippedUnreadable?: string[];
}

/**
 * The newest snapshot of this rig whose copy of this seat's startup context is usable for it (found by logical id: a
 * seat removed and grown back has a new node id), or null. Newest by the order snapshot selection uses (created_at,
 * then insertion). Reads only the node list and the startup-context map of each snapshot, newest first, and stops at
 * the first usable copy; a snapshot whose data is not JSON is skipped and NAMED (`skippedUnreadable`) when a usable copy is found past it.
 */
export function newestUsableSnapshotCopy(db: Database.Database, rigId: string, logicalId: string, runtime: string | null): UsableSnapshotCopy | null {
  const rows = db.prepare(
    `SELECT id, kind, created_at,
            NOT json_valid(data) AS damaged,
            CASE WHEN json_valid(data) THEN json_extract(data, '$.nodes') END AS nodes,
            CASE WHEN json_valid(data) THEN json_extract(data, '$.nodeStartupContext') END AS ctx
       FROM snapshots WHERE rig_id = ? ORDER BY created_at DESC, rowid DESC`,
  ).iterate(rigId) as IterableIterator<{ id: string; kind: string; created_at: string; damaged: number; nodes: string | null; ctx: string | null }>;
  const skippedUnreadable: string[] = [];
  for (const row of rows) {
    if (row.damaged) { skippedUnreadable.push(row.id); continue; }
    if (!row.nodes || !row.ctx) continue;
    let nodes: unknown;
    let byNode: unknown;
    try {
      nodes = JSON.parse(row.nodes);
      byNode = JSON.parse(row.ctx);
    } catch {
      continue;
    }
    if (!Array.isArray(nodes) || !byNode || typeof byNode !== "object") continue;
    const node = nodes.find((candidate) => candidate && typeof candidate === "object" && (candidate as { logicalId?: unknown }).logicalId === logicalId) as { id?: unknown } | undefined;
    if (!node || typeof node.id !== "string") continue;
    const copy = (byNode as Record<string, unknown>)[node.id];
    if (copy === null || copy === undefined || startupContextUnusable(copy, runtime)) continue;
    // `iterate` holds the statement open until the loop ends; leaving it with return closes it.
    return { snapshotId: row.id, kind: row.kind, createdAt: row.created_at, context: copy as NodeStartupSnapshot, ...(skippedUnreadable.length > 0 ? { skippedUnreadable } : {}) };
  }
  return null;
}

export type SeatStartupForRestore =
  /** The seat's own row. */
  | { kind: "own"; context: NodeStartupSnapshot }
  /** The seat has no row: the restored snapshot's copy (null: it holds none either). */
  | { kind: "snapshot"; context: NodeStartupSnapshot | null }
  /** What the seat would replay cannot be used; this is the newest usable copy, and the warning says so. */
  | { kind: "fallback"; context: NodeStartupSnapshot; from: UsableSnapshotCopy; why: string; warning: string }
  /** What the seat would replay cannot be used, and no snapshot holds a usable copy. `ownRow`: the seat has a saved
   *  row of its own (one that cannot be used); false when it has none at all. */
  | { kind: "none_usable"; why: string; ownRow: boolean };

/**
 * What a seat restore starts fresh replays (the rule at the top of this file). `selectedCopy`: the restored snapshot's
 * copy of this seat's context (replayed only when the seat has no row of its own).
 */
export function seatStartupForRestore(
  db: Database.Database,
  seat: { rigId: string; nodeId: string; logicalId: string; runtime: string | null },
  selectedCopy: NodeStartupSnapshot | null | undefined,
): SeatStartupForRestore {
  const own = readOwnStartupForRestore(db, seat.nodeId, seat.runtime);
  if (own.kind === "usable") return { kind: "own", context: own.snapshot };
  let why: string;
  if (own.kind === "none") {
    if (!selectedCopy) return { kind: "snapshot", context: null };
    // The restored snapshot's copy is held to the shape rule only: whether its runtime is the seat's is restore's own
    // earlier gate (restoreRuntimeCompatibilityError), which stops the seat before this is asked.
    const shape = startupContextUnusable(selectedCopy, null);
    if (!shape) return { kind: "snapshot", context: selectedCopy };
    why = `it has no saved startup context of its own, and this snapshot's copy cannot be used: ${shape}`;
  } else {
    why = `its saved startup context cannot be used: ${own.why}`;
  }
  const from = newestUsableSnapshotCopy(db, seat.rigId, seat.logicalId, seat.runtime);
  if (!from) return { kind: "none_usable", why, ownRow: own.kind !== "none" };
  return {
    kind: "fallback", context: from.context, from, why,
    warning: `Restore: ${seat.logicalId}: ${why}. This fresh start replays the copy of its startup files saved in snapshot ${from.snapshotId} (${from.kind}, ${from.createdAt}), the newest snapshot of this rig whose copy can be used; a successful launch saves it as the seat's new context.${unreadableSnapshotsNote(from)}`,
  };
}

/** OF-168: (every caller that offers or replays a snapshot copy says this) the newer snapshots passed over on the way to `from` because their saved data is not JSON: what they hold for this seat is
 *  unknown, so the operator is told rather than left to assume the newest snapshot was read. Empty when none were. */
export function unreadableSnapshotsNote(from: UsableSnapshotCopy | null): string {
  return from?.skippedUnreadable?.length ? ` Newer snapshot${from.skippedUnreadable.length === 1 ? "" : "s"} ${namedRows(from.skippedUnreadable)} could not be read (saved data is not JSON) and ${from.skippedUnreadable.length === 1 ? "was" : "were"} passed over; repair or remove ${from.skippedUnreadable.length === 1 ? "it" : "them"}.` : "";
}

/** The sentence restore refuses with when no snapshot holds a usable copy. */
export function noUsableCopyMessage(logicalId: string, why: string): string {
  return `${logicalId}: no snapshot of this rig holds a readable copy of its startup files, and ${why}.`;
}

/**
 * What the operator can do when restore refuses a seat for want of a usable startup context. Every command named here
 * was run against a real CLI and daemon (restore-own-row-cli.integration.test.ts).
 *  - `restore`: a whole `rig up --existing` was refused before it started anything (the seat was not listed).
 *  - `seat`: restore refused only this seat (listed with --fresh, or a `rig launch` target); the others were restored.
 * `specRecorded`: a fresh start that re-reads the rig's recorded spec is a route this seat has not tried: for `restore`
 * the rig records a spec source; for `seat` the operator asked for the stored files (`--startup-from stored`) and the
 * rig records a spec source. Otherwise the seat's source was already the stored row because the rig records no spec
 * or its spec does not declare the seat.
 */
export function noUsableCopyRemedy(how: { scope: "restore" | "seat"; rigName: string; logicalId: string; specRecorded: boolean; ownRow: boolean;
  /** OF-107: the recorded spec is refused as untrusted, so "start it from the recorded spec" is not offered (the rig's id, for the fix). */
  specUntrusted?: { rigId: string } }): string {
  const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
  // Review F2 (4728c079): a seat with no saved row has nothing to repair.
  const repair = how.ownRow ? "the saved row has to be repaired outside restore"
    : "nothing can start it from saved files (it has no saved startup context of its own, and no snapshot holds a usable copy)";
  if (how.specRecorded && how.specUntrusted) {
    const fix = untrustedSpecSourceRemedy(how.specUntrusted.rigId);
    const then = how.scope === "restore"
      ? `then run: rig up ${quote(how.rigName)} --existing --fresh ${quote(how.logicalId)}`
      : `then run: rig seat launch ${quote(`${how.logicalId}@${how.rigName}`)} --fresh --reason "<why>"`;
    return `This rig's recorded spec source is not trusted, so a fresh start from it is refused (startup_source_untrusted) and nothing can rebuild this seat's startup files until that is fixed. ${fix} After that, ${then}. Otherwise ${repair}.`;
  }
  if (how.scope === "restore") {
    const listed = `rig up ${quote(how.rigName)} --existing --fresh ${quote(how.logicalId)}`;
    return how.specRecorded
      ? `Start this seat from the rig's recorded spec instead (the spec's current startup files, not the saved ones): ${listed}. If the spec no longer declares the seat or cannot start it, that restore refuses only this seat and restores the others; then ${repair}.`
      : `This rig records no spec source, so nothing can rebuild this seat's startup files: ${repair}. To restore the other seats meanwhile: ${listed} (that restore refuses only this seat and starts nothing for it).`;
  }
  return how.specRecorded
    ? `To start it from the rig's recorded spec instead (the spec's current startup files, not the saved ones): rig seat launch ${quote(`${how.logicalId}@${how.rigName}`)} --fresh --reason "<why>". If the spec no longer declares the seat or cannot start it, that launch is refused and changes nothing; then ${repair}.`
    : `There is no spec to re-read for this seat (the rig records no spec source, or its spec does not declare the seat), so ${repair}.`;
}
