import { pickLatestByOrdering } from "../agent-activity-store.js";
import type { AgentActivity } from "../types.js";

/** Whether a Claude seat has passed a point where it takes input since a time (OF-285).
 *  - `passed`: it has, or it sits at one now. A line written before that has been taken, or was lost.
 *  - `pending`: it has not: a tool call is still running, or a dialog is still open. A line written before is queued in Claude.
 *  - `unknown`: the daemon holds no usable evidence. */
export type InputPoint = "passed" | "pending" | "unknown";

/** Hook events at which Claude takes the lines queued on its socket: a tool call ended, the turn stopped, a prompt was submitted (a line
 *  was taken), or the session started (a restart drops whatever was queued in the old process). A dialog's close is one of these: an approved
 *  permission or an answered AskUserQuestion ends in PostToolUse. A denied permission fires no hook (measured, 2.1.314), so the next
 *  tool end or Stop is its input point. */
export const INPUT_POINT_EVENTS: readonly string[] = ["PostToolUse", "PostToolUseFailure", "Stop", "UserPromptSubmit", "SessionStart"];

const LATEST_ROWS = 20;

/** The two reads this needs of the daemon's database, named here so the domain does not import the driver (the hexagonal ratchet). */
export interface InputPointDb {
  prepare(sql: string): { get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] };
}

/** Reads the seat's recorded hook activity (the `agent.activity` events the relay's hooks write) against a time: `sinceMs` is when this message
 *  was last written to the socket. Never throws: a read that fails is `unknown`. */
export function seatInputPoint(db: InputPointDb, nodeId: string, sinceMs: number): InputPoint {
  try {
    // eventAt is the hook's own time, stored as an ISO string (Date.toISOString, fixed width), so a string comparison orders it.
    const after = db.prepare(`SELECT 1 FROM events WHERE node_id = ? AND type = 'agent.activity'
      AND json_extract(payload, '$.activity.rawEvent') IN (${INPUT_POINT_EVENTS.map(() => "?").join(", ")})
      AND json_extract(payload, '$.activity.eventAt') > ? LIMIT 1`).get(nodeId, ...INPUT_POINT_EVENTS, new Date(sinceMs).toISOString());
    if (after !== undefined) return "passed";
    const rows = db.prepare(`SELECT payload FROM events WHERE node_id = ? AND type = 'agent.activity' ORDER BY seq DESC LIMIT ${LATEST_ROWS}`).all(nodeId) as Array<{ payload: string }>;
    const latest = pickLatestByOrdering(rows.map((row) => JSON.parse(row.payload) as { activity?: AgentActivity }))?.activity;
    if (!latest) return "unknown";
    // Nothing since the write. A seat last seen running or asking is still inside what it was doing; one last seen idle is at its prompt.
    if (latest.state === "running" || latest.state === "needs_input") return "pending";
    return latest.state === "idle" ? "passed" : "unknown";
  } catch {
    return "unknown";
  }
}
