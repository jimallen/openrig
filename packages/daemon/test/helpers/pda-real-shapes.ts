// pda runtime L1b: fixtures built from pda's REAL wire shapes, not from this lane's own vocabulary. Every builder
// names the declaration it follows. Sources, read-only: pi-durable 1.3.0 `dist/harness/events.d.ts` (EVENTS) and
// `dist/types.d.ts` (TYPES), pi-ai `dist/types.d.ts` (AI), pda `src/server.mjs` (SERVER) and `src/app.mjs` (APP).
// The first version of this lane guessed these shapes (string ids, `assistantMessageEvent`, top-level submission
// fields) and its tests and its fake were written to the same guess; the review caught it. The tests that use only
// these builders cannot drift that way, and `GUESSED_SHAPES` below is kept as the NEGATIVE: what the runner must not
// depend on.

type Json = Record<string, unknown>;

const USAGE = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

// ── messages (AI: types.d.ts:246-278 content parts, :357-361 UserMessage, :362-408 AssistantMessage, :414-436 ToolResultMessage)
export const userMessage = (text: string): Json => ({ role: "user", content: [{ type: "text", text }], timestamp: 1_760_000_000_000 });
export const assistantMessage = (parts: Json[], extra: Json = {}): Json => ({
  role: "assistant", content: parts, api: "openai-completions", provider: "ollama-cloud", model: "m", usage: USAGE, stopReason: "stop",
  timestamp: 1_760_000_000_000, ...extra,
});
export const toolResultMessage = (toolCallId: string, text: string, isError = false): Json => ({
  role: "toolResult", toolCallId, toolName: "bash", content: [{ type: "text", text }], isError, timestamp: 1_760_000_000_000,
});

// ── entries (TYPES: types.d.ts:290-305 EntryRecord; ids are NUMBERS, :18-21; kinds from entries.js:11-30, e.g. `pi.tool-result` at :20)
const entry = (id: number, kind: string, message?: Json, extra: Json = {}): Json => ({
  id, conversationId: 1, kind, ...(message === undefined ? {} : { model: [message] }), ...extra,
});
export const userEntry = (id: number, text: string): Json => entry(id, "pi.user", userMessage(text));
export const assistantEntry = (id: number, text: string, extra: Json = {}): Json => entry(id, "pi.assistant", assistantMessage([{ type: "text", text }], extra));
export const toolResultEntry = (id: number, toolCallId: string, text: string, isError = false): Json => entry(id, "pi.tool-result", toolResultMessage(toolCallId, text, isError));
/** A model-less bookkeeping entry (`pi.reset`, entries.js:25): arrives as entry_appended, not message_end. */
export const bareEntry = (id: number, kind: string): Json => entry(id, kind);
/** A compaction entry carries its summary as a UserMessage (types.d.ts:290-305, kind `pi.compaction`). */
export const compactionEntry = (id: number, summary: string): Json => entry(id, "pi.compaction", userMessage(summary));

// ── submissions (TYPES: types.d.ts:336-366 SubmissionRecord)
export const submissionRecord = (r: { id: number; requestId?: string; status: "queued" | "placed" | "done" | "unanswered"; entry?: number; answer?: number; reason?: string }): Json => ({
  id: r.id, type: "input", conversationId: 1, ...(r.requestId === undefined ? {} : { requestId: r.requestId }),
  status: r.status, ...(r.entry === undefined ? {} : { entry: r.entry }), ...(r.answer === undefined ? {} : { answer: r.answer }),
  ...(r.reason === undefined ? {} : { reason: r.reason }),
});

// ── events (EVENTS)
/** SnapshotEvent (:35-64), with `totalEntries` added by the server (SERVER: trimSnapshot, :57-62). `run` is absent when idle. */
export const snapshotEvent = (o: { entries?: Json[]; run?: number[] } = {}): Json => ({
  type: "snapshot", entries: o.entries ?? [], totalEntries: (o.entries ?? []).length,
  ...(o.run === undefined ? {} : { run: { inputs: o.run } }),
  tools: [], nestedTools: [], compactions: [], inbox: [], agent: {}, usage: {},
});
export const runStart = (inputs: number[] = []): Json => ({ type: "run_start", inputs });        // :66-68
export const runEnd = (inputs: number[] = []): Json => ({ type: "run_end", inputs });            // :69-71
export const messageStart = (message: Json): Json => ({ type: "message_start", message });       // :76-79
export const messageEnd = (e: Json): Json => ({ type: "message_end", entry: e });                // :85-87
/** message_update (:81-84), changes per MessageChange (:14-34). */
export const deltaEvent = (delta: string, contentIndex = 0): Json => ({ type: "message_update", usage: USAGE, changes: [{ type: "text_delta", contentIndex, delta }] });
export const thinkingDeltaEvent = (delta: string): Json => ({ type: "message_update", usage: USAGE, changes: [{ type: "thinking_delta", contentIndex: 0, delta }] });
export const changesEvent = (changes: Json[]): Json => ({ type: "message_update", usage: USAGE, changes });
/** tool_execution_start (:88-91) with ToolEventCall (:165-171). */
export const toolStart = (toolCallId: string, toolName: string, args: Json, parentToolCallId?: string): Json => ({
  type: "tool_execution_start", toolCallId, toolName, args, ...(parentToolCallId === undefined ? {} : { parentToolCallId }),
});
/** A model-issued call ends with its result ENTRY (:108-112); absent when the tool task faulted or the run ended. */
export const toolEnd = (toolCallId: string, toolName: string, resultEntry?: Json): Json => ({
  type: "tool_execution_end", toolCallId, toolName, ...(resultEntry === undefined ? {} : { entry: resultEntry }),
});
/** A NESTED call ends with `result`, not `entry` (:108-112); the runner shows only top-level calls. */
export const nestedToolEnd = (toolCallId: string, toolName: string, parentToolCallId: string, text: string): Json => ({
  type: "tool_execution_end", toolCallId, toolName, parentToolCallId, result: { content: [{ type: "text", text }] },
});
export const submissionEvent = (r: Parameters<typeof submissionRecord>[0]): Json => ({ type: "submission", record: submissionRecord(r) });   // :115-118
export const entryAppended = (e: Json): Json => ({ type: "entry_appended", entry: e });                                                      // :129-132
export const taskFailed = (message: string, kind = "pi.generation"): Json => ({ type: "task_failed", taskId: 9, kind, message });            // :139-143
export const autoRetryStart = (errorMessage: string): Json => ({ type: "auto_retry_start", attempt: 1, at: 0, errorMessage });                 // :119-123
export const compactionEnd = (error?: string): Json => ({ type: "compaction_end", taskId: 9, reason: "threshold", ...(error === undefined ? {} : { error }) });   // :153-158
/** `stream_end{end}` where `end` is a WatchEnd, `{reason: "stopped" | "cancelled" | "session_closed" | "retired"}` (TYPES: types.d.ts:772-777);
 *  written by the server at SERVER :88 (`write({type: "stream_end", end})`). */
export const streamEnd = (reason: "stopped" | "cancelled" | "session_closed" | "retired" = "session_closed"): Json => ({ type: "stream_end", end: { reason } });

/** The shapes the FIRST version of this lane guessed. Kept only as a negative: feeding them to the runner must not
 *  make it show streamed text, record ownership or acknowledge anything. */
export const GUESSED_SHAPES = {
  delta: (text: string): Json => ({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } }),
  submission: (requestId: string, submissionId: string): Json => ({ type: "submission", requestId, submissionId, outcome: "placed" }),
  stringIdEntry: (id: string, text: string): Json => ({ id, model: [userMessage(text)], requestId: "openrig/x/y/1", submissionId: "sub-1" }),
};
