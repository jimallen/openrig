import type Database from "better-sqlite3";

/** The rows that name a seat: by its binding's session, or, with no binding, by `<logical id with dots as dashes>@<rig>`. */
const SEAT_ROWS = `SELECT n.id AS nodeId, r.name AS rig, r.archived_at AS archivedAt,
    (SELECT generation_uuid FROM occupant_tenures t WHERE t.node_id = n.id ORDER BY generation_ordinal DESC LIMIT 1) AS occupant
  FROM nodes n JOIN rigs r ON r.id = n.rig_id LEFT JOIN bindings b ON b.node_id = n.id
  WHERE b.tmux_session = ? OR (b.tmux_session IS NULL AND replace(n.logical_id, '.', '-') || '@' || r.name = ?)`;

export interface SeatRow { nodeId: string; rig: string; archivedAt: string | null; occupant: string | null }

/** Every node row that names this seat, archived rigs included. */
export function seatRows(db: Database.Database, seat: string): SeatRow[] {
  return db.prepare(SEAT_ROWS).all(seat, seat) as SeatRow[];
}

/** The occupant generation of the one live seat this name is, or null: no such seat here (a far seat, a ghost), no tenure yet, or more than one
 *  live row (unknown). A tenure ledger or node table that is missing reads as null: a curated schema has no occupants, and nothing is bound.
 *  This is the occupant a message sent now is for, which is what the pump compares with the occupant that finally receives it. */
export function currentOccupantOfSeat(db: Database.Database, seat: string): string | null {
  try {
    const live = seatRows(db, seat).filter((row) => row.archivedAt === null);
    return live.length === 1 ? live[0]!.occupant : null;
  } catch {
    return null;
  }
}
