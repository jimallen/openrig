/**
 * workspaces-o9o.31: a Codex seat's tool calls still open in its current turn. Codex relays no tool hook (hooks/codex.json: SessionStart,
 * UserPromptSubmit, Stop, PostCompact, PermissionRequest), so the seat's status reads them from what the seat's own record says happened.
 *
 * The domain knows only the events: a turn started or ended, a call started (with its tool and when) or ended. Which records of a Codex
 * rollout are which event is the adapter's translation (adapters/codex-rollout-open-calls.ts), so no Codex wire label lives here.
 */
import type { OpenToolCall } from "./agent-activity-store.js";

/** The port the seat status reads a Codex seat's open calls through; the rollout adapter implements it. */
export interface SeatOpenCallsSource {
  openToolCalls(input: { sessionName?: string | null }): OpenToolCall[];
}

/** What a seat's record says happened, in the order it was recorded. */
export type SeatTurnEvent =
  | { kind: "turn_started" }
  | { kind: "turn_ended" }
  | { kind: "call_started"; callId: string; tool: string; at: string }
  | { kind: "call_ended"; callId: string };

/**
 * The calls of the current turn that have not ended, oldest first. A turn boundary forgets the last turn's calls. A call whose end is
 * recorded before its start (o9o.31 review FIX 4: the order a writer flushes in is not promised) is ended all the same.
 */
export function openCallsIn(events: readonly SeatTurnEvent[]): OpenToolCall[] {
  const open = new Map<string, OpenToolCall>();
  const ended = new Set<string>();
  for (const event of events) {
    if (event.kind === "turn_started" || event.kind === "turn_ended") {
      open.clear();
      ended.clear();
    } else if (event.kind === "call_ended") {
      open.delete(event.callId);
      ended.add(event.callId);
    } else if (!ended.has(event.callId)) {
      open.set(event.callId, { tool: event.tool, callId: event.callId, startedAt: event.at });
    }
  }
  return [...open.values()].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
}
