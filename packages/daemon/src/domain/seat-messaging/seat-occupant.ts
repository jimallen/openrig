import type Database from "better-sqlite3";

/** The rows that name a seat: by its binding's session, or, with no binding, by `<logical id with dots as dashes>@<rig>`. `occupant` is the latest
 *  tenure's generation (minted at every launch); `conversation` is the conversation that tenure belongs to (its own generation, unless the launch
 *  resumed the one before), which a database from before migration 125 has no column for. */
function seatRowsSql(withConversation: boolean): string {
  const latest = (column: string) => `(SELECT ${column} FROM occupant_tenures t WHERE t.node_id = n.id ORDER BY generation_ordinal DESC LIMIT 1)`;
  return `SELECT n.id AS nodeId, r.name AS rig, r.archived_at AS archivedAt, ${latest("generation_uuid")} AS occupant,
    ${withConversation ? latest("coalesce(conversation_uuid, generation_uuid)") : latest("generation_uuid")} AS conversation
  FROM nodes n JOIN rigs r ON r.id = n.rig_id LEFT JOIN bindings b ON b.node_id = n.id
  WHERE b.tmux_session = ? OR (b.tmux_session IS NULL AND replace(n.logical_id, '.', '-') || '@' || r.name = ?)`;
}

export interface SeatRow { nodeId: string; rig: string; archivedAt: string | null; occupant: string | null; conversation: string | null }

const conversationColumn = new WeakMap<Database.Database, boolean>();
function hasConversationColumn(db: Database.Database): boolean {
  let known = conversationColumn.get(db);
  if (known === undefined) {
    known = (db.prepare("PRAGMA table_info(occupant_tenures)").all() as Array<{ name: string }>).some((c) => c.name === "conversation_uuid");
    conversationColumn.set(db, known);
  }
  return known;
}

/** Every node row that names this seat, archived rigs included. */
export function seatRows(db: Database.Database, seat: string): SeatRow[] {
  return db.prepare(seatRowsSql(hasConversationColumn(db))).all(seat, seat) as SeatRow[];
}

/** The conversation of the one live seat this name is, or null: no such seat here (a far seat, a ghost), no tenure yet, or more than one live row
 *  (unknown). A tenure ledger or node table that is missing reads as null: a curated schema has no occupants, and nothing is bound. This is the
 *  agent a message sent now is for, which is what the pump compares with the agent that finally receives it: a launch that resumes the conversation
 *  does not change it, a fresh launch or a handover does. */
export function currentConversationOfSeat(db: Database.Database, seat: string): string | null {
  try {
    const live = seatRows(db, seat).filter((row) => row.archivedAt === null);
    return live.length === 1 ? live[0]!.conversation : null;
  } catch {
    return null;
  }
}
