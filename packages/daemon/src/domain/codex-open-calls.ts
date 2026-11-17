/**
 * workspaces-o9o.31: a Codex seat's tool calls still open in its current turn, read from its rollout, because Codex relays no tool hook
 * (hooks/codex.json: SessionStart, UserPromptSubmit, Stop, PostCompact, PermissionRequest).
 *
 * The rollout's shape, measured (structure only) on this host's rollouts from codex-cli 0.137 to 0.158 and on one 0.166.0 turn:
 * - a call is a `response_item` whose payload type is `custom_tool_call` (every one seen; name `exec`) or `function_call` (the Responses API's
 *   name for the same item, kept so either spelling counts), with a `call_id`;
 * - it ends with a `*_output` item that carries the same `call_id`;
 * - a turn starts with `event_msg` `task_started` and ends with `event_msg` `task_complete`;
 * - the call's record is written when the call starts: in 0.158 rollouts its `timestamp` precedes its output's by the call's run time (15 calls of
 *   5 to 30 s). That is argued from 0.158 files; on 0.166.0 it is not measured (the one turn's call ended in 84 ms).
 * Pure: the caller hands it the rollout's lines, oldest first.
 */
import type { OpenToolCall } from "./agent-activity-store.js";

/** The port the seat status reads a Codex seat's open calls through; the rollout adapter implements it. */
export interface SeatOpenCallsSource {
  openToolCalls(input: { sessionName?: string | null }): OpenToolCall[];
}

const CALL_STARTS = new Set(["custom_tool_call", "function_call"]);
const CALL_ENDS = new Set(["custom_tool_call_output", "function_call_output"]);

interface RolloutRecord {
  timestamp?: unknown;
  type?: unknown;
  payload?: { type?: unknown; call_id?: unknown; name?: unknown } | null;
}

/** The calls of the current turn that have no output yet, oldest first. A turn that has ended has none. Lines that do not parse are skipped:
 *  a tail read starts mid-line, and a line still being written ends mid-line. */
export function codexOpenCallsIn(lines: readonly string[]): OpenToolCall[] {
  const open = new Map<string, OpenToolCall>();
  for (const line of lines) {
    let record: RolloutRecord;
    try { record = JSON.parse(line) as RolloutRecord; } catch { continue; }
    if (!record || typeof record !== "object") continue;
    const payload = record.payload && typeof record.payload === "object" ? record.payload : null;
    const kind = payload?.type;
    if (record.type === "event_msg" && (kind === "task_started" || kind === "task_complete")) { open.clear(); continue; }
    if (record.type !== "response_item" || typeof kind !== "string" || typeof payload?.call_id !== "string" || !payload.call_id) continue;
    if (CALL_STARTS.has(kind) && typeof record.timestamp === "string" && Number.isFinite(Date.parse(record.timestamp))) {
      open.set(payload.call_id, { tool: typeof payload.name === "string" && payload.name ? payload.name : "a tool", callId: payload.call_id, startedAt: record.timestamp });
    } else if (CALL_ENDS.has(kind)) {
      open.delete(payload.call_id);
    }
  }
  return [...open.values()].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
}
