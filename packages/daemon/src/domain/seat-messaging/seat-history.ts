import type Database from "better-sqlite3";

/**
 * Whether a rig ever had this seat, read from that rig's own history (OF-209). `deleteNode` takes the node, its sessions, bindings and tenures with it
 * (they cascade), but the `events` log is append-only and keyed by rig id and node id on purpose: a `node.removed` event names the removed node, and the
 * same node's `node.launched` / `node.added` event carries its `sessionName` and `logicalId`, and `session.detached` its `sessionName`. So a seat
 * removed from this rig is found by: a `node.removed` event of this rig whose node has such a naming event matching the seat. A rig with a node that was
 * never launched (and so never named in an event) and was then removed has no record; such a seat reads as one the rig never had, which is right
 * for messages (nothing was ever sent to a seat that never ran). Rows of other rigs, archived ones with the same name included, are never read.
 */
export function rigHadSeat(db: Database.Database, rigId: string, seat: string): boolean {
  try {
    return db.prepare(`
      SELECT 1 FROM events removed
       WHERE removed.rig_id = ? AND removed.type = 'node.removed'
         AND EXISTS (
           SELECT 1 FROM events named
            WHERE named.rig_id = removed.rig_id AND named.node_id = removed.node_id
              AND named.type IN ('node.added', 'node.launched', 'session.detached')
              AND (json_extract(named.payload, '$.sessionName') = ?
                   OR replace(json_extract(named.payload, '$.logicalId'), '.', '-') || '@' || (SELECT name FROM rigs WHERE id = removed.rig_id) = ?))
       LIMIT 1`).get(rigId, seat, seat) !== undefined;
  } catch (error) {
    if ((error as Error).message.includes("no such table")) return false;  // a curated schema keeps no history
    throw error;
  }
}

/** The unarchived rigs a seat name's rig part (after the last `@`) names. */
export function liveRigsNamedBy(db: Database.Database, seat: string): Array<{ id: string; name: string }> {
  if (!seat.includes("@")) return [];
  return db.prepare("SELECT id, name FROM rigs WHERE name = ? AND archived_at IS NULL").all(seat.slice(seat.lastIndexOf("@") + 1)) as Array<{ id: string; name: string }>;
}
