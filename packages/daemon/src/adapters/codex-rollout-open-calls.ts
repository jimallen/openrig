import fs from "node:fs";
import type { OpenToolCall } from "../domain/agent-activity-store.js";
import { openCallsIn, type SeatOpenCallsSource, type SeatTurnEvent } from "../domain/codex-open-calls.js";

/** How much of a rollout's end is read. A turn's start and its open calls are near the end; a call older than the window is not shown, which
 *  reads as today's "turn running" line, never a wrong tool. */
export const CODEX_ROLLOUT_TAIL_BYTES = 256 * 1024;

/**
 * The anti-corruption translation of a Codex rollout line into a seat turn event (o9o.31 review FIX 5: the wire labels live here only).
 * Measured (structure only) on this host's codex-cli 0.137 to 0.158 rollouts and one 0.166.0 turn:
 * - a call is a `response_item` whose payload type is `custom_tool_call` (every one seen; name `exec`) or `function_call` (the Responses API's
 *   name for the same item), with a `call_id`, and it ends with the `*_output` item carrying the same `call_id`;
 * - a turn starts with `event_msg` `task_started` and ends with `event_msg` `task_complete`;
 * - a call's record is written when the call starts: in 0.158 rollouts its `timestamp` precedes its output's by the run time (15 calls of 5 to
 *   30 s). Argued from 0.158 files; on 0.166.0 it is not measured (the one turn's call ended in 84 ms).
 * A line it cannot read (cut by the tail window, or still being written) is no event.
 */
export function codexRolloutEvent(line: string): SeatTurnEvent | null {
  let record: { timestamp?: unknown; type?: unknown; payload?: { type?: unknown; call_id?: unknown; name?: unknown } | null };
  try { record = JSON.parse(line) as typeof record; } catch { return null; }
  if (!record || typeof record !== "object") return null;
  const payload = record.payload && typeof record.payload === "object" ? record.payload : null;
  const kind = payload?.type;
  if (record.type === "event_msg") return kind === "task_started" ? { kind: "turn_started" } : kind === "task_complete" ? { kind: "turn_ended" } : null;
  if (record.type !== "response_item" || typeof payload?.call_id !== "string" || !payload.call_id) return null;
  if (kind === "custom_tool_call" || kind === "function_call") {
    if (typeof record.timestamp !== "string" || !Number.isFinite(Date.parse(record.timestamp))) return null;
    return { kind: "call_started", callId: payload.call_id, tool: typeof payload.name === "string" && payload.name ? payload.name : "a tool", at: record.timestamp };
  }
  return kind === "custom_tool_call_output" || kind === "function_call_output" ? { kind: "call_ended", callId: payload.call_id } : null;
}

/**
 * A Codex seat's open tool calls, from the rollout of its current thread (workspaces-o9o.31). `rolloutOf` names the file. Read on each call,
 * read only, and never throws: no rollout, or one it cannot or will not read, has no open calls.
 */
export class CodexRolloutOpenCalls implements SeatOpenCallsSource {
  constructor(private readonly rolloutOf: (sessionName: string) => string | null, private readonly tailBytes = CODEX_ROLLOUT_TAIL_BYTES) {}

  openToolCalls(input: { sessionName?: string | null }): OpenToolCall[] {
    try {
      const path = input.sessionName ? this.rolloutOf(input.sessionName) : null;
      const lines = path ? tailLines(path, this.tailBytes) : null;
      return lines ? openCallsIn(lines.map(codexRolloutEvent).filter((e): e is SeatTurnEvent => e !== null)) : [];
    } catch {
      return [];
    }
  }
}

/**
 * The whole lines within the file's last `bytes`, or null when the path is not a regular file. The path comes from a database another
 * program writes, so it is checked before it is opened (o9o.31 review FIX 2: opening a FIFO blocks): lstat first (a symlink, FIFO, socket or
 * device is refused), then open without following a link and without blocking, then fstat the open file, so a swap between the two is refused
 * too. A read that starts mid-file starts one byte early and drops everything up to the first newline: the cut part of a line, or nothing when
 * the window starts exactly at a line's start, so a whole line is never dropped.
 */
function tailLines(path: string, bytes: number): string[] | null {
  if (!fs.lstatSync(path).isFile()) return null;
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;
    const start = Math.max(0, stat.size - bytes - 1);
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    return (start > 0 ? text.slice(text.indexOf("\n") + 1) : text).split("\n");
  } finally {
    fs.closeSync(fd);
  }
}
