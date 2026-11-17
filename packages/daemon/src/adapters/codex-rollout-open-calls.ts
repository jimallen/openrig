import fs from "node:fs";
import type { OpenToolCall } from "../domain/agent-activity-store.js";
import { codexOpenCallsIn } from "../domain/codex-open-calls.js";

/** How much of a rollout's end is read. A turn's start and its open calls are near the end; a call older than the window is not shown, which
 *  reads as today's "turn running" line, never a wrong tool. */
export const CODEX_ROLLOUT_TAIL_BYTES = 256 * 1024;

/**
 * A Codex seat's open tool calls, from the rollout of its current thread (workspaces-o9o.31). `rolloutOf` names the file, the way the seat's
 * message gate finds it. Read on each call, read only, and never throws: no rollout, or one it cannot read, has no open calls.
 */
export class CodexRolloutOpenCalls {
  constructor(private readonly rolloutOf: (sessionName: string) => string | null, private readonly tailBytes = CODEX_ROLLOUT_TAIL_BYTES) {}

  openToolCalls(input: { sessionName?: string | null }): OpenToolCall[] {
    try {
      const path = input.sessionName ? this.rolloutOf(input.sessionName) : null;
      return path ? codexOpenCallsIn(tailLines(path, this.tailBytes)) : [];
    } catch {
      return [];
    }
  }
}

/** The whole lines within the file's last `bytes`. A read that starts mid-file starts one byte early and drops everything up to the first
 *  newline: the cut part of a line, or nothing when the window starts exactly at a line's start, so a whole line is never dropped. */
function tailLines(path: string, bytes: number): string[] {
  const fd = fs.openSync(path, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes - 1);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    return (start > 0 ? text.slice(text.indexOf("\n") + 1) : text).split("\n");
  } finally {
    fs.closeSync(fd);
  }
}
