import type Database from "better-sqlite3";
import { readStoredJsonObject } from "./stored-json.js";

/** Read an existing fresh-launch effect, fenced by the current generation.
 * Older builds could leave a detached predecessor unsuperseded. The owning
 * event still names the deliberate successor: timestamps and newest-row
 * guesses are unnecessary. No history or native identity is rewritten here.
 */
export function readFreshOccupantRelations(db: Database.Database, rigId: string): Record<string, string | null> {
  const generations = db.prepare(`
    SELECT t.node_id AS nodeId, t.generation_uuid AS generation
    FROM occupant_tenures t JOIN nodes n ON n.id = t.node_id
    WHERE n.rig_id = ? AND t.generation_ordinal =
      (SELECT MAX(t2.generation_ordinal) FROM occupant_tenures t2 WHERE t2.node_id = t.node_id)
  `).all(rigId) as Array<{ nodeId: string; generation: string }>;
  const current = new Map(generations.map((row) => [row.nodeId, row.generation]));
  const events = db.prepare("SELECT node_id AS nodeId, payload FROM events WHERE rig_id = ? AND type = 'seat.fresh_launched' ORDER BY seq")
    .all(rigId) as Array<{ nodeId: string | null; payload: string }>;
  const relation: Record<string, string | null> = {};
  for (const row of events) {
    // OF-51: a damaged event row cannot say which session it launched, so the seat it names (the row's own node_id
    // column) has no readable relation: null, the same "unavailable" a contradiction gives, which restore and the plan
    // already fail closed on. It is never a 500 for the route that asks, and never skipped as if it had not happened.
    const event = readStoredJsonObject(row.payload);
    if (!event) {
      if (row.nodeId && current.has(row.nodeId)) relation[row.nodeId] = null;
      continue;
    }
    if (typeof event.nodeId !== "string" || !current.has(event.nodeId)
      || event.newGeneration !== current.get(event.nodeId)) continue;
    const id = typeof event.sessionId === "string" && event.sessionId ? event.sessionId : null;
    if (Object.prototype.hasOwnProperty.call(relation, event.nodeId) && relation[event.nodeId] !== id) {
      relation[event.nodeId] = null; // contradictory current effects remain unavailable
    } else relation[event.nodeId] = id;
  }
  return relation;
}
