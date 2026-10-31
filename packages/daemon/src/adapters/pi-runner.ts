// OPR.0.4.6.PI1 — the pane-hosted pi-runner (compiled entry in the daemon dist).
//
// The runner is what makes a Pi seat behave like a normal OpenRig tmux seat
// while everything underneath stays structured RPC:
//
//   pane stdin (rig send / human typing)  ──▶ RPC prompt / steer / follow_up
//   pi RPC events (typed JSONL)           ──▶ (a) human-readable pane mirror
//                                             (b) activity + session_identity
//                                                 POSTs to the daemon
//                                             (c) runner-state.json sidecar
//
// BR-1: activity/session identity derive ONLY from Pi's typed events +
// get_state — never pane scraping. BR-3: the pi child gets a deny-by-default
// env allowlist. BR-5: the trust flag is always explicit. Honest failure:
// a dead pi process prints the EXIT/ERROR marker and records `exited` in the
// sidecar — never a silently frozen pane.
//
// Only node builtins and local runner helpers are imported so the compiled
// entry stays runnable as `node <dist>/adapters/pi-runner.js` with no daemon deps.

import fs from "node:fs";
import nodePath from "node:path";
import readline from "node:readline";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { createRunnerInput, resolveActivityEndpoint } from "./runner-pane-io.js";
import { credentialTaint, judgeChargeProvenance, piCredentialEvidence, piCredentialNotice, type PiCredentialEvidence } from "./pi-readiness.js";
import { extractPiUsageFacts, parsePiSessionHeader, tiesPiForkHeader, type PiSessionBoundary, type PiUsageFact } from "../domain/pi-usage-facts.js";
import { chunkUsagePost } from "../domain/usage-post-limits.js";
import { OpenRouterChargeLookup, openRouterGenerationFetcher, type ChargeProvenance } from "./pi-openrouter-charge.js";
import {
  piSeatPaths, buildPiChildArgs, buildPiChildEnv, buildPendingRunnerState, parsePiRunnerState, piEnvPassthroughRefusal, PI_ENV_PASSTHROUGH_MAX,
  PI_RUNNER_READY_MARKER, PI_RUNNER_EXIT_MARKER, PI_RUNNER_ERROR_MARKER, PI_PROVIDER_ENV_VARS, PI_SIDECAR_TICK_MS, PI_SIDECAR_CHECK_MS,
  type PiRunnerState, type RunnerRuntime,
} from "./pi-runner-protocol.js";

// ── Submitted input boundaries ─────────────────────────────────────────────
// pda L0: the editor and the activity endpoint lookup live in runner-pane-io.ts, shared with other
// pane-hosted runners. Pi calls them with the defaults, which are this runner's behaviour unchanged.
export { createRunnerInput, MAX_RUNNER_INPUT_BYTES as MAX_PI_INPUT_BYTES } from "./runner-pane-io.js";

// ── Pi event → mirror + activity mapping (pure, hermetically testable) ──────

export interface MirrorAndActivity {
  /** Lines to print to the pane (already human-readable). */
  mirrorLines: string[];
  /** Raw text to append to the current mirror line (streamed deltas). */
  mirrorAppend?: string;
  /** Activity POST payload (hookEvent/subtype), when the event maps to one. */
  activity?: { hookEvent: string; subtype: string | null };
  /** Streaming-state transition, when the event carries one. */
  streaming?: boolean;
  /** A typed terminal failure; the core coalesces its exhausted-retry notice. */
  errorNotice?: string;
  /** Pi only: the event type (possibly "") that fell through to the default branch. */
  unhandledType?: string;
}

// Pi reports missing credentials through RPC errors and terminal model failures.
// Add only fixed setting/variable names; never inspect or repeat credential values.
function piCredentialHint(message: string): string {
  const match = /^No API key found for ([a-z0-9-]+)\b/i.exec(message.trim());
  if (!match) return "";
  const provider = match[1]!.toLowerCase();
  const key = Object.hasOwn(PI_PROVIDER_ENV_VARS, provider) ? PI_PROVIDER_ENV_VARS[provider] : undefined;
  return key
    ? ` For managed Pi, set ${key} in the daemon environment and add ${key} to recovery.provider_auth_env_allowlist. Use model ${provider}/<id>, then restart the daemon and relaunch the seat. Default Pi logins are not automatically shared.`
    : " For managed Pi, configure this provider in the seat's PI_CODING_AGENT_DIR (auth.json or models.json). Its key is not in OpenRig's Pi environment passthrough map; default Pi logins are not automatically shared.";
}

function errorNotice(details: unknown[], runtime: RunnerRuntime): string {
  // Empty or control-only fields must not hide a later usable diagnostic.
  const text = details.map(detail => typeof detail === "string"
    ? stripVTControlCharacters(detail).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/g, " ").trim()
    : "").find(Boolean) ?? "";
  const marker = runtime === "omp" ? "[omp-runner] ERROR" : PI_RUNNER_ERROR_MARKER;
  return `${marker} ${text.slice(0, 400) || "request failed"}${runtime === "pi" ? piCredentialHint(text) : ""}`;
}

/** The one model-failure detector for both runtimes. Pi and OMP report a
 *  provider/auth failure on the assistant message itself and still end the
 *  turn normally; OMP repeats the message on turn_end, and either runtime can
 *  announce it again when automatic retries exhaust. The core coalesces the
 *  repeats into one notice per failure. */
function modelErrorNotice(event: Record<string, unknown>, runtime: RunnerRuntime): { errorNotice?: string } {
  if (event.type === "auto_retry_end") {
    return event.success === false ? { errorNotice: errorNotice([event.finalError, event.error], runtime) } : {};
  }
  const message = event.message as Record<string, unknown> | undefined;
  if (message?.role === "assistant" && message.stopReason === "error") {
    return { errorNotice: errorNotice([message.errorMessage, message.error, event.error], runtime) };
  }
  return {};
}

/** A tool call made inside another tool call (a sub-agent's, say) names its parent. The pda runner hides these, and
 *  so does the Pi runner: the parent's line and activity already stand for the work. */
function isNestedToolCall(event: Record<string, unknown>): boolean {
  return event.parentToolCallId !== undefined && event.parentToolCallId !== null;
}

/** The extension UI requests that wait on an answer. Every other method is fire-and-forget traffic. */
function isExtensionDialog(method: unknown): boolean {
  return method === "select" || method === "confirm" || method === "input" || method === "editor";
}

export function mapPiEvent(event: Record<string, unknown>, runtime: RunnerRuntime = "pi"): MirrorAndActivity {
  const type = typeof event.type === "string" ? event.type : "";
  switch (type) {
    case "agent_start":
      return { mirrorLines: [], activity: { hookEvent: "active", subtype: "agent_start" }, streaming: true };
    case "agent_end":
      // OMP marks a non-final agent_end with isTerminal:false; Pi (agent-session.d.ts) with willRetry:true, and the
      // retry's own agent_start/agent_end follow. Neither is the end of the run, so neither is a Stop.
      return (runtime === "omp" && event.isTerminal === false) || (runtime === "pi" && event.willRetry === true)
        ? { mirrorLines: [], streaming: true }
        : { mirrorLines: [""], activity: { hookEvent: "Stop", subtype: "agent_end" }, streaming: false };
    case "turn_end":
      // OMP repeats an assistant failure on turn_end (sometimes only there).
      // Pi keeps main's mapping: turn_end carries no notice.
      return runtime === "omp" ? { mirrorLines: [], ...modelErrorNotice(event, runtime) } : { mirrorLines: [] };
    case "turn_start":
    case "message_start":
      return { mirrorLines: [] };
    case "message_update": {
      // Pi streams assistant text as `assistantMessageEvent` text_delta
      // records. Only the delta is mirrored: Pi 0.84.0 dropped the cumulative
      // `message` from RPC message_update, and older Pi sent it alongside the
      // same deltas, so appending it repeated the growing text. Thinking and
      // tool-call argument deltas stay out of the pane; tool calls get their
      // own one-line summaries from tool_execution_*.
      const update = event.assistantMessageEvent as Record<string, unknown> | undefined;
      const delta = update?.type === "text_delta" && typeof update.delta === "string" ? update.delta : "";
      return delta ? { mirrorLines: [], mirrorAppend: delta } : { mirrorLines: [] };
    }
    case "message_end":
      // The message text already streamed via message_update appends; this
      // terminates the line. (mapPiEvent is stateless, so a hypothetical
      // updates-carried-nothing case is a VM-calibration follow-up, not
      // silently guessed here.)
      return { mirrorLines: [""], ...modelErrorNotice(event, runtime) };
    case "tool_execution_start": {
      if (runtime === "pi" && isNestedToolCall(event)) return { mirrorLines: [] };
      const tool = typeof event.toolName === "string" ? event.toolName : (typeof event.name === "string" ? event.name : "tool");
      return { mirrorLines: [`  ⚙ ${tool} …`], activity: { hookEvent: "PreToolUse", subtype: tool } };
    }
    case "tool_execution_end": {
      if (runtime === "pi" && isNestedToolCall(event)) return { mirrorLines: [] };
      const tool = typeof event.toolName === "string" ? event.toolName : (typeof event.name === "string" ? event.name : "tool");
      const failed = event.isError === true || event.error != null;
      return { mirrorLines: [`  ⚙ ${tool} ${failed ? "FAILED" : "done"}`] };
    }
    case "queue_update":
      return { mirrorLines: [] };
    // Pi 1.3.0 RPC events the pane deliberately does not show (types: pi-coding-agent AgentSessionEvent). They are
    // named so "known and quiet" differs from "never looked at" (the default branch of a Pi runner logs an
    // unhandled-event marker, once per type). The run's idle signal is agent_end (the seat's Stop), so agent_settled
    // adds nothing; entry_appended announces a NON-message entry (a custom entry, a context edit; Pi saves user,
    // assistant and tool-result messages at message_end without any event) and is not a cursor source (see
    // RunnerCore.handleEvent); tool_execution_update is a partial tool result, and the one-line tool summaries come
    // from tool_execution_start/_end; extension_ui_request reaches here only as notify/setStatus/... traffic the pane has nothing to show for
    // (the dialog methods select/confirm/input/editor are cancelled and surfaced by RunnerCore.handleEvent).
    case "agent_settled":
    case "entry_appended":
    case "extension_ui_request":
    case "tool_execution_update":
    case "session_info_changed":
    case "thinking_level_changed":
    case "summarization_retry_scheduled":
    case "summarization_retry_attempt_start":
    case "summarization_retry_finished":
    case "bash_execution_update":
      return { mirrorLines: [] };
    case "compaction_start":
      return { mirrorLines: [`[${runtime}] compacting context…`], activity: { hookEvent: "active", subtype: "compaction" } };
    case "compaction_end":
      return { mirrorLines: [`[${runtime}] compaction done`] };
    // OMP names its automatic compaction separately. Pi keeps main's mapping
    // (unmapped), so an idle Pi seat never reads as running after one.
    case "auto_compaction_start":
      return runtime === "omp"
        ? { mirrorLines: ["[omp] compacting context…"], activity: { hookEvent: "active", subtype: "compaction" } }
        : { mirrorLines: [] };
    case "auto_compaction_end":
      return runtime === "omp" ? { mirrorLines: ["[omp] compaction done"] } : { mirrorLines: [] };
    case "auto_retry_start":
      return { mirrorLines: ["[pi] transient error — retrying"], activity: { hookEvent: "active", subtype: "auto_retry" } };
    case "auto_retry_end": {
      const notice = modelErrorNotice(event, runtime);
      return notice.errorNotice ? { mirrorLines: [""], ...notice } : { mirrorLines: [] };
    }
    case "extension_error": {
      const message = typeof event.message === "string" ? event.message : "extension error";
      return { mirrorLines: [`${PI_RUNNER_ERROR_MARKER} extension: ${message}`] };
    }
    default:
      // OMP's event surface is not enumerated here, so only Pi reports a type it has no case for.
      return runtime === "pi" ? { mirrorLines: [], unhandledType: type } : { mirrorLines: [] };
  }
}

/** The most distinct unhandled event types one runner reports: a stream cannot flood the pane. */
const MAX_UNHANDLED_EVENT_MARKERS = 16;

// ── The runner core (injected effects; owns protocol state) ─────────────────

export interface RunnerIo {
  /** Write one JSONL command to pi stdin. */
  sendRpc(cmd: Record<string, unknown>): void;
  /** Print a full line to the pane. */
  mirrorLine(line: string): void;
  /** Append raw text to the current pane line (streamed deltas). */
  mirrorAppend(text: string): void;
  /** POST to the daemon activity endpoint. May resolve to the parsed JSON
   *  response (null on transport failure) so identity delivery can retry. */
  postActivity(payload: Record<string, unknown>): void | Promise<Record<string, unknown> | null>;
  /** Persist the runner-state sidecar. */
  writeSidecar(state: PiRunnerState): void;
  /** OMP can announce a path before a session file exists. */
  sessionFileExists?(path: string): boolean;
  /** Terminate OMP when get_state cannot establish a resumable seat. */
  stopChild?(): void;
  /** OPR.0.7.0.2 (only with --usage-facts): POST usage facts from persisted entries to the daemon. Best-effort;
   *  resolves true only when the daemon accepted them, `{ refused }` (the daemon's code) when it answered 413. */
  postUsageFacts?(payload: Record<string, unknown>): Promise<boolean | { charged: string[]; rejected?: number } | { refused: string }>;
  /** OPR.0.7.0.2 K4 (only with --openrouter-charge): queue OpenRouter charge lookups for facts the daemon stored;
   *  `charged` already have a charge there. */
  enqueueChargeLookups?(piSessionId: string, items: Array<{ fact: PiUsageFact; provenance: ChargeProvenance }>, charged: ReadonlySet<string>): void;
  /** OPR.0.7.0.2 K4: Pi's OpenRouter credential metadata now (taken at start and at every refresh). */
  credentialEvidence?(): PiCredentialEvidence;
  /** The first line of a Pi session file (its header), or null when it can't be read. */
  readFirstLine?(path: string): string | null;
  /** The entry ids of a complete, valid Pi session file (a fork's parent); null when it isn't one. Never blocks. */
  readSessionEntryIds?(path: string): Promise<ReadonlySet<string> | null>;
  now(): string;
}

/** The `code` of a daemon refusal body (usage_facts_too_many, usage_body_too_large), or "http_413" when it has none. */
async function refusalCode(res: Response): Promise<string> {
  const body = await res.json().catch(() => null) as { code?: unknown } | null;
  return typeof body?.code === "string" ? body.code : "http_413";
}

/** What a /pi-usage reply means to the runner: `{ refused }` for a 413 (given up, never resent), false for any other
 *  failure (resent on the next refresh), else the entries the daemon already has a charge for. */
export async function interpretUsageFactsReply(res: Response): Promise<false | { charged: string[]; rejected?: number } | { refused: string }> {
  if (res.status === 413) return { refused: await refusalCode(res) };
  if (!res.ok) return false;
  const reply = await res.json().catch(() => null) as { charged?: unknown; rejected?: unknown } | null;
  const rejected = typeof reply?.rejected === "number" && reply.rejected > 0 ? reply.rejected : undefined;
  return { charged: Array.isArray(reply?.charged) ? reply.charged.filter((id): id is string => typeof id === "string") : [], ...(rejected ? { rejected } : {}) };
}

/** What a /pi-usage-charges reply means to the charge lookup: `{ refused }` for a 413, false for any other failure,
 *  else the entry ids the daemon acknowledged storing. */
export async function interpretChargesReply(res: Response): Promise<ReadonlySet<string> | false | { refused: string }> {
  if (res.status === 413) return { refused: await refusalCode(res) };
  if (!res.ok) return false;
  const reply = await res.json().catch(() => null) as { acknowledged?: unknown } | null;
  return new Set(Array.isArray(reply?.acknowledged) ? reply.acknowledged.filter((id): id is string => typeof id === "string") : []);
}

const GET_STATE_ID = "pi-runner-get-state";
const CATCH_UP_ID = "pi-runner-catch-up";
const CURSOR_REFRESH_ID = "pi-runner-cursor-refresh";
/** RPC commands that carry operator input. Their failure means the seat
 *  cannot do the requested work; other command failures are not attention. */
const INPUT_COMMANDS: Record<string, true> = { prompt: true, steer: true, follow_up: true };

/** OPR.0.7.0.2: the largest fork parent read to decide a header tie; a larger parent leaves the tie unknown. */
const PARENT_SESSION_READ_LIMIT_BYTES = 64 * 1024 * 1024;

/**
 * OPR.0.7.0.2: the entry ids of a fork's parent session file, read only to decide a tie with the fork header.
 * Absence from the result is a claim that the parent doesn't have the entry, so only a complete, valid file
 * answers: a regular file (checked on the opened handle, opened non-blocking so a FIFO or device can't stall the
 * runner), at most `limitBytes` actually read from that handle, a session header first, every line a whole
 * entry with an id, and no torn last line. Anything else is null (the tie stays unknown and is retried). Ids only.
 */
export async function readPiSessionEntryIds(
  path: string,
  limitBytes = PARENT_SESSION_READ_LIMIT_BYTES,
  /** Test seam only: called after the stat and after the read, to change the file at those points. */
  testHooks?: { afterStat?: () => void | Promise<void>; afterRead?: () => void | Promise<void> },
): Promise<ReadonlySet<string> | null> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(path, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limitBytes) return null;
    await testHooks?.afterStat?.();
    // Complete only with evidence: the read reaches end of file (a read returns 0 bytes) before filling a buffer
    // one byte larger than the stat, it got exactly the stat's size, and the size is unchanged afterwards. A parent
    // that grew, shrank or is still being written answers nothing (the tie stays unknown and is read again later).
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    let reachedEnd = false;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) { reachedEnd = true; break; }
      length += bytesRead;
    }
    if (!reachedEnd || length !== stat.size || length === 0) return null;
    await testHooks?.afterRead?.();
    if ((await handle.stat()).size !== length) return null;
    const text = buffer.subarray(0, length).toString("utf8");
    if (!text.endsWith("\n")) return null; // Pi ends every entry with a newline: a torn or partial write
    const lines = text.slice(0, -1).split("\n");
    const ids = new Set<string>();
    for (const [index, line] of lines.entries()) {
      const entry = JSON.parse(line) as unknown; // a malformed line throws: incomplete, so null
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
      const { type, id } = entry as { type?: unknown; id?: unknown };
      if (index === 0) {
        if (type !== "session") return null;
        continue;
      }
      if (typeof id !== "string" || !id) return null;
      ids.add(id);
    }
    return ids;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export class RunnerCore {
  private streaming = false;
  private sessionFile: string | undefined;
  private sessionId: string | undefined;
  private lastEntryId: string | undefined;
  private ready = false;
  /** OF-148: the pane editor reports a bracketed paste open past the hint delay; written to the sidecar only while true. */
  private pasteOpen = false;
  /** OF-153: the editor line holds a recovered lost paste; written to the sidecar only while true. */
  private pasteLeftover = false;
  private assistantErrorShown = false;
  private started = false;
  /** OMP attention (runtime_error | permission_prompt) that must survive the
   *  end of the turn; cleared by the next agent_start. */
  private attention: "runtime_error" | "permission_prompt" | null = null;
  /** Whether the last activity posted is that attention. Later activity in
   *  the same turn (a tool call after a denied approval) replaces it. */
  private attentionIsLatest = false;
  /** Set once the daemon confirms it persisted the resume token. */
  private identityPersisted = false;
  private identityInFlight = false;
  /** OPR.0.7.0.2: the session header boundary; null until it has been read (read again until it can be). */
  private usageBoundary: PiSessionBoundary | null = null;
  /** OPR.0.7.0.2 K4: the last credential observation, and each entry's provenance judged when first observed. */
  private lastCredentialEvidence: PiCredentialEvidence | null = null;
  /** Sticky for this process: what an observation showed Pi may have loaded (see credentialTaint). */
  private credentialTainted: string | null = null;
  private readonly chargeProvenance = new Map<string, ChargeProvenance>();
  /** OPR.0.7.0.2: a fork parent read is under way (at most one at a time). */
  private parentReadInFlight = false;
  /** OPR.0.7.0.2: the last get_entries batch reported, replayed when a parent read completes. */
  private latestUsageEntries: unknown[] = [];
  /** Entry ids the daemon has accepted with a known origin. Anything else is sent again on the next refresh;
   *  the daemon stores each (session, entry) once regardless. */
  private readonly postedUsageEntryIds = new Set<string>();
  /** OF-105: a usage post loop is running, and a refresh arrived while it ran (reported again when it settles). */
  private usagePostInFlight = false;
  private usagePostRerun = false;
  private readonly loggedUnsafeCountEntryIds = new Set<string>();
  private readonly unhandledEventTypes = new Set<string>();

  constructor(
    private io: RunnerIo,
    private identity: { sessionName: string; nodeId?: string; launchId?: string; generation?: string },
    private opts: { catchUpSince?: string; runtime?: RunnerRuntime; usageFacts?: boolean; openRouterCharge?: boolean;
      /** K4: the credential observation taken before Pi was spawned. */
      launchCredentialEvidence?: PiCredentialEvidence } = {},
  ) {
    // The durable cursor seeds from the carried-over value (FR-5) so this
    // instance's own sidecar writes never regress it to undefined before a
    // newer entry supersedes it.
    this.lastEntryId = opts.catchUpSince;
  }
  /** Runner readiness is the sidecar's acknowledged get_state, not RPC transport ready. */
  isReady(): boolean { return this.ready; }

  /** Kick off identity capture. Called once pi's RPC stream is up. */
  start(): void {
    // K4: the first credential observation, before Pi can make any request of this runner's.
    if (this.opts.openRouterCharge && this.runtime === "pi" && this.io.credentialEvidence) {
      // The production runner observes before it spawns Pi (launchCredentialEvidence), so Pi loads after it.
      this.lastCredentialEvidence = this.opts.launchCredentialEvidence ?? this.io.credentialEvidence();
      this.noteTaint(this.lastCredentialEvidence);
    }
    // OMP's start is driven by the transport `ready` frame and must run once;
    // Pi keeps main's unconditional start.
    if (this.runtime === "omp") {
      if (this.started) return;
      this.started = true;
    }
    this.io.sendRpc({ type: "get_state", id: GET_STATE_ID });
    if (this.opts.catchUpSince) {
      // Durable catch-up cursor (FR-5): replay session entries the previous
      // runner instance had not yet projected. Mirror-only; activity states
      // are live-only signals.
      this.io.sendRpc({ type: "get_entries", since: this.opts.catchUpSince, id: CATCH_UP_ID });
    }
  }

  /** One LF-delimited JSONL record from pi stdout. */
  handlePiLine(rawLine: string): void {
    const line = rawLine.trim();
    if (!line) return;
    let record: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
      record = parsed as Record<string, unknown>;
    } catch {
      // Non-JSON noise on pi stdout — mirror it verbatim so nothing hides.
      this.io.mirrorLine(line);
      return;
    }

    if (record.type === "response") {
      this.handleResponse(record);
      return;
    }
    this.handleEvent(record);
  }

  private get runtime(): RunnerRuntime { return this.opts.runtime ?? "pi"; }

  /** One aggregated paste block from pane stdin. */
  handleUserBlock(block: string): void {
    if (block === "/abort") {
      this.io.sendRpc({ type: "abort" });
      this.io.mirrorLine("[pi-runner] abort sent");
      return;
    }
    if (block.startsWith("/followup ")) {
      const message = block.slice("/followup ".length);
      this.io.sendRpc({ type: "follow_up", message });
      this.io.mirrorLine(`you (follow-up) ▸ ${message}`);
      return;
    }
    if (this.streaming) {
      // Mid-stream: steer delivers after the current turn's tool calls,
      // before the next model call (Pi's documented semantics).
      this.io.sendRpc({ type: "steer", message: block });
      this.io.mirrorLine(`you (steer) ▸ ${block}`);
      return;
    }
    this.io.sendRpc({ type: "prompt", message: block });
    this.io.mirrorLine(`you ▸ ${block}`);
  }

  /** Child process exit — honest, loud, durable. */
  handlePiExit(code: number | null): void {
    this.ready = false;
    this.pasteLeftover = false;
    this.pasteOpen = false; // the `exited` record is the last word; an open paste cannot outlive the runner's answer
    this.io.mirrorLine(`[${this.runtime}-runner] EXITED ${this.runtime} exited (code ${code ?? "unknown"})`);
    this.writeSidecar({ exited: { code, at: this.io.now() } });
    this.io.postActivity(this.activityPayload("Stop", `${this.runtime}_exited`));
  }

  private handleResponse(record: Record<string, unknown>): void {
    if (record.success === false || record.error != null) {
      const detail = typeof record.error === "string" ? record.error : "request failed";
      const message = detail + (this.runtime === "pi" ? piCredentialHint(detail) : "");
      if (record.id === GET_STATE_ID) {
        this.ready = false;
        this.writeSidecar({});
        this.io.mirrorLine(this.runtime === "omp" ? `[omp-runner] ERROR rpc get_state: ${message}` : `${PI_RUNNER_ERROR_MARKER} rpc: ${message}`);
        // OMP cannot provide a resume token without get_state; stop it so the
        // launch fails now instead of waiting out readiness.
        if (this.runtime === "omp") this.io.stopChild?.();
        return;
      }
      this.io.mirrorLine(`[${this.runtime}-runner] ERROR rpc: ${message}`);
      // Only a rejected input means the seat cannot do the requested work.
      // A mistimed /abort (or any control command) leaves the seat idle.
      if (this.runtime === "omp" && typeof record.command === "string" && Object.hasOwn(INPUT_COMMANDS, record.command)) {
        this.raiseAttention("runtime_error");
      }
      return;
    }
    if (record.id === GET_STATE_ID) {
      const data = (record.data ?? record.state ?? record) as Record<string, unknown>;
      const sessionFile = typeof data.sessionFile === "string" ? data.sessionFile : undefined;
      const sessionId = typeof data.sessionId === "string" ? data.sessionId : undefined;
      this.sessionFile = sessionFile ?? this.sessionFile;
      this.sessionId = sessionId ?? this.sessionId;
      this.ready = this.runtime === "pi" || !!this.sessionFile;
      if (!this.ready) {
        this.io.mirrorLine("[omp-runner] ERROR rpc get_state returned no session file; cannot provide a resume token");
        this.io.stopChild?.();
        return;
      }
      this.writeSidecar({});
      this.io.mirrorLine(`${this.runtime === "omp" ? "[omp-runner] READY" : PI_RUNNER_READY_MARKER} session=${this.sessionFile ?? "unknown"}`);
      this.postSessionIdentity();
      return;
    }
    if (record.id === CURSOR_REFRESH_ID || record.id === CATCH_UP_ID) {
      const data = (record.data ?? record) as Record<string, unknown>;
      const entries = Array.isArray(data.entries) ? data.entries : (Array.isArray(record.entries) ? record.entries : []);
      const last = entries.at(-1);
      const lastId = last !== null && typeof last === "object" && typeof (last as Record<string, unknown>).id === "string"
        ? (last as Record<string, unknown>).id as string
        : undefined;
      if (lastId) {
        this.lastEntryId = lastId;
        this.writeSidecar({});
      }
      this.reportUsageFacts(entries);
      return;
    }
  }

  /** OPR.0.7.0.2: report usage from the persisted entries a get_entries response returned (catch-up after a
   *  restart, or the refresh after each agent_end). Pi only, and only with --usage-facts. Never live updates. */
  /** K4: what an observation shows Pi may hold for the rest of the process (an extension, a credential-bearing
   *  models.json entry, or a reading that couldn't be made) is sticky at once. */
  private noteTaint(e: PiCredentialEvidence): void {
    this.credentialTainted ??= credentialTaint(e)?.sticky ?? null;
  }

  private reportUsageFacts(entries: unknown[]): void {
    if (!this.opts.usageFacts || this.runtime !== "pi" || !this.io.postUsageFacts) return;
    if (this.usageBoundary === null) {
      const firstLine = this.sessionFile && this.io.readFirstLine ? this.io.readFirstLine(this.sessionFile) : null;
      this.usageBoundary = firstLine ? parsePiSessionHeader(firstLine) : null;
    }
    this.latestUsageEntries = entries;
    const { facts, malformed, unsafeCountEntryIds } = extractPiUsageFacts(entries, this.usageBoundary);
    // OF-90: a fact whose token count is not a safe integer is skipped (the daemon would refuse it); say so once per entry.
    for (const entryId of unsafeCountEntryIds) {
      if (this.loggedUnsafeCountEntryIds.has(entryId)) continue;
      this.loggedUnsafeCountEntryIds.add(entryId);
      this.io.mirrorLine(`[pi-runner] usage fact skipped: code=usage_count_not_safe_integer entry=${entryId}`);
    }
    if (this.opts.openRouterCharge && this.io.credentialEvidence) {
      // Each entry's credential is judged once, from the observations before and after it was first seen.
      const now = this.io.credentialEvidence();
      this.noteTaint(now);
      for (const fact of facts) {
        if (!this.chargeProvenance.has(fact.entryId)) {
          this.chargeProvenance.set(fact.entryId, this.credentialTainted
            ? { ok: false, reason: this.credentialTainted }
            : judgeChargeProvenance(this.lastCredentialEvidence, now, fact.entryTimestamp));
        }
      }
      this.lastCredentialEvidence = now;
    }
    // A new entry often shares the fork header's millisecond, and so can a copied one: only the parent session's
    // entry ids tell them apart. Read them in the background, only when such a tie needs deciding; meanwhile the
    // tie goes as unknown. A complete answer is kept and these entries are reported again with it; anything
    // else leaves the tie unknown, to be read again on a later refresh.
    const boundary = this.usageBoundary;
    if (boundary?.parentSession && !boundary.parentEntryIds && !this.parentReadInFlight && this.io.readSessionEntryIds
      && facts.some((fact) => !this.postedUsageEntryIds.has(fact.entryId) && tiesPiForkHeader(fact.entryTimestamp, boundary))) {
      this.parentReadInFlight = true;
      void this.io.readSessionEntryIds(boundary.parentSession).then((parentEntryIds) => {
        this.parentReadInFlight = false;
        if (!parentEntryIds || this.usageBoundary !== boundary) return;
        this.usageBoundary = { ...boundary, parentEntryIds };
        // The latest batch, so a tie that arrived while the read was under way settles now too.
        this.reportUsageFacts(this.latestUsageEntries);
      }, () => { this.parentReadInFlight = false; });
    }
    const fresh = facts.filter((fact) => !this.postedUsageEntryIds.has(fact.entryId));
    if (fresh.length === 0 && malformed === 0) return;
    // OF-105: one post loop at a time. A refresh that arrives while one is in flight would compute `fresh` before
    // that loop has marked anything posted and post every chunk a second time, so it only raises the rerun flag; when
    // the loop settles, the latest batch is reported again and sends just what is still unposted.
    if (this.usagePostInFlight) { this.usagePostRerun = true; return; }
    this.usagePostInFlight = true;
    void this.postFreshUsageFacts(fresh, malformed).finally(() => {
      this.usagePostInFlight = false;
      if (!this.usagePostRerun) return;
      this.usagePostRerun = false;
      this.reportUsageFacts(this.latestUsageEntries);
    });
  }

  /** OF-90: post the fresh facts in chunks the daemon accepts (at most USAGE_MAX_FACTS and USAGE_CHUNK_BODY_BYTES), in
   *  order, one chunk at a time. A chunk the daemon refuses with a 413 is given up with a logged code, never resent:
   *  resending the same chunk would be refused the same way on every refresh, forever. */
  private async postFreshUsageFacts(fresh: PiUsageFact[], malformed: number): Promise<void> {
    const post = this.io.postUsageFacts;
    if (!post) return;
    const chunks = fresh.length > 0 ? chunkUsagePost(fresh) : [[] as PiUsageFact[]];
    for (const [index, chunk] of chunks.entries()) {
      let result: boolean | { charged: string[]; rejected?: number } | { refused: string };
      try {
        result = await post.call(this.io, {
          sessionName: this.identity.sessionName,
          nodeId: this.identity.nodeId,
          generation: this.identity.generation,
          piSessionId: this.sessionId,
          sessionCreatedAt: this.usageBoundary?.createdAt ?? null,
          forked: this.usageBoundary ? this.usageBoundary.parentSession !== null : null,
          facts: chunk,
          malformed: index === 0 ? malformed : 0,
          ...(this.opts.openRouterCharge ? { wantCharged: true } : {}),
        });
      } catch {
        return; // best-effort: resent on the next refresh
      }
      // Only a stored fact with a known origin is done: a failed post, or an origin not settled yet (no readable
      // header, or a tie with an unreadable parent), is sent again with the next refresh (the store upgrades an
      // unknown origin once it is known). The chunks after a failed one wait for that refresh too.
      if (result === false) return;
      if (typeof result === "object" && "refused" in result) {
        for (const fact of chunk) this.postedUsageEntryIds.add(fact.entryId);
        this.io.mirrorLine(`[pi-runner] usage facts refused: code=${result.refused} count=${chunk.length}; not retried`);
        continue;
      }
      for (const fact of chunk) if (fact.origin !== "unknown") this.postedUsageEntryIds.add(fact.entryId);
      // OF-90: facts the daemon stored nothing for (it refused their shape) are settled as posted above and would
      // otherwise vanish silently, so say how many.
      if (typeof result === "object" && "charged" in result && (result.rejected ?? 0) > 0) {
        this.io.mirrorLine(`[pi-runner] usage facts rejected by the daemon: code=usage_fact_rejected count=${result.rejected}`);
      }
      // K4: the charge is looked up only for facts the daemon has stored, never for one it already has.
      if (this.opts.openRouterCharge && this.sessionId && this.io.enqueueChargeLookups) {
        this.io.enqueueChargeLookups(this.sessionId, chunk.map((fact) => ({
          fact, provenance: this.chargeProvenance.get(fact.entryId) ?? { ok: false, reason: "its credential wasn't observed" },
        })), new Set(typeof result === "object" ? result.charged : []));
      }
    }
  }

  private raiseAttention(subtype: "runtime_error" | "permission_prompt"): void {
    // Runtime failures outrank denied approvals. Only emit when the visible
    // attention changes or intervening activity replaced it.
    const next = this.attention === "runtime_error" ? this.attention : subtype;
    if (this.attention === next && this.attentionIsLatest) return;
    this.attention = next;
    this.attentionIsLatest = true;
    this.io.postActivity(this.activityPayload("Notification", next));
  }

  private clearAttention(): void {
    this.attention = null;
    this.attentionIsLatest = false;
  }

  /** An event type no case handles: one pane line per type (never its payload), at most MAX_UNHANDLED_EVENT_MARKERS
   *  types. The type is shown only if it looks like an event name, so a hostile stream cannot put text in the pane. */
  private noteUnhandledEvent(type: string): void {
    const shown = /^[A-Za-z0-9_.:-]{1,64}$/.test(type) ? type : "<unnamed>";
    if (this.unhandledEventTypes.has(shown) || this.unhandledEventTypes.size >= MAX_UNHANDLED_EVENT_MARKERS) return;
    this.unhandledEventTypes.add(shown);
    this.io.mirrorLine(`[pi-runner] unhandled event type=${shown}`);
  }

  private handleEvent(event: Record<string, unknown>): void {
    if (event.type === "extension_ui_request" && (this.runtime === "omp" || isExtensionDialog(event.method))) {
      // RPC does not mount an interactive UI. Reply at once; otherwise the
      // child can wait forever for approval that cannot be given in the pane.
      // OMP cancels every request that has an id; Pi only needs its dialogs answered (the rest is fire-and-forget).
      if (typeof event.id === "string") {
        this.io.sendRpc({ type: "extension_ui_response", id: event.id, cancelled: true });
      }
      if (isExtensionDialog(event.method)) {
        this.io.mirrorLine(`[${this.runtime}-runner] Approval/input requested; cancelled because the managed RPC pane cannot answer it. Operator action required: review the denied action and re-send a safe instruction, or change the seat permission policy explicitly.`);
        this.raiseAttention("permission_prompt");
      }
      return;
    }
    const message = event.message as Record<string, unknown> | undefined;
    if (event.type === "agent_start" || (event.type === "message_start" && message?.role === "assistant")) {
      this.assistantErrorShown = false;
    }
    // Durable cursor. For Pi it comes ONLY from a get_entries result (the catch-up and the refresh after each
    // agent_end): the cursor must mean "every entry up to here went through a get_entries batch", because a restored
    // runner's catch-up reads from it to report usage. No Pi 1.3.0 stdout event carries a top-level entry id (its
    // `entry_appended` nests one, but running the cursor ahead of the last batch would make a restart skip those
    // entries' usage), while `extension_ui_request` and `bash_execution_update` carry a top-level `id` that is a
    // random UUID / a command id, which a restore rejects ("Entry not found"). OMP keeps the generic path (any event
    // carrying `entryId` or `id`): its event shapes were not available to check, so its behaviour is unchanged.
    const entryId = this.runtime !== "omp" ? undefined
      : typeof event.entryId === "string" ? event.entryId
      : (typeof event.id === "string" ? event.id : undefined);
    if (entryId) {
      this.lastEntryId = entryId;
      this.writeSidecar({});
    }

    // A cancelled dialog's attention (either runtime) ends with the next run.
    if (event.type === "agent_start") this.clearAttention();
    if (this.runtime === "omp") {
      // A successful automatic retry supersedes the failed attempt.
      if (event.type === "auto_retry_start" && this.attention === "runtime_error") this.clearAttention();
      // Some paths omit agent_start; turn_start still opens a new turn.
      if (event.type === "turn_start") this.assistantErrorShown = false;
    }
    let mapped = mapPiEvent(event, this.runtime);
    // A willRetry agent_end holds the seat busy for a retry that may never come: /abort during the backoff ends with
    // auto_retry_end{success:false} and agent_settled, and no further agent_start/agent_end. Pi emits agent_settled
    // once, when the whole run (retries included) is over, so a Pi seat still busy at that point has ended its run.
    // After a normal final agent_end the seat is already idle, so this adds nothing there.
    if (this.runtime === "pi" && event.type === "agent_settled" && this.streaming) {
      mapped = { mirrorLines: [""], activity: { hookEvent: "Stop", subtype: "agent_end" }, streaming: false };
    }
    if (mapped.unhandledType !== undefined) this.noteUnhandledEvent(mapped.unhandledType);
    if (mapped.streaming !== undefined && mapped.streaming !== this.streaming) {
      this.streaming = mapped.streaming;
      this.writeSidecar({});
    }
    // OMP writes its JSONL lazily; re-announce identity after each turn until
    // the daemon confirms the token. Pi's get_state identity is final.
    if (event.type === "agent_end" && this.runtime === "omp") this.postSessionIdentity();
    if (event.type === "agent_end") {
      // QA RED fold (qitem-20260707020922): live events do not reliably carry
      // session-entry ids, so the durable cursor starved (lastEntryId stayed
      // null in real runs). Refresh it from the source of truth after every
      // completed turn — get_entries returns append-order entries with stable
      // ids; the response handler advances the cursor from the tail.
      this.io.sendRpc({ type: "get_entries", id: CURSOR_REFRESH_ID });
    }
    if (mapped.mirrorAppend) this.io.mirrorAppend(mapped.mirrorAppend);
    for (const line of mapped.mirrorLines) this.io.mirrorLine(line);
    if (mapped.errorNotice) {
      // Pi can announce the same failed message again when retries exhaust,
      // and OMP repeats it on turn_end. Keep the first useful detail even if
      // the repeat lacks it, then reset at the next assistant message/agent
      // turn, not at agent_end.
      if (event.type === "message_end" || !this.assistantErrorShown) {
        this.io.mirrorLine(mapped.errorNotice);
      }
      this.assistantErrorShown = true;
      // OMP still ends the turn normally after a model failure; the operator
      // has to act, so the seat shows attention rather than idle.
      if (this.runtime === "omp") this.raiseAttention("runtime_error");
    }
    if (!mapped.activity) return;
    if (mapped.activity.hookEvent === "Stop" && this.attention) {
      // The turn ended, but the operator still has to act. Drop the Stop; if
      // later activity replaced the attention, restore it as the final state.
      if (!this.attentionIsLatest) this.raiseAttention(this.attention);
    } else {
      this.attentionIsLatest = false;
      this.io.postActivity(this.activityPayload(mapped.activity.hookEvent, mapped.activity.subtype));
    }
  }

  /** Re-deliver OMP identity until the daemon confirms the resume token.
   *  Called from a timer so a daemon restart during the first turn cannot
   *  leave a seat with history but no restorable token. */
  retrySessionIdentity(): void {
    if (this.runtime === "omp" && this.ready) this.postSessionIdentity();
  }

  private postSessionIdentity(): void {
    if (this.runtime === "omp" && (!this.sessionFile || !this.io.sessionFileExists?.(this.sessionFile))) return;
    if (this.runtime === "omp" && (this.identityPersisted || this.identityInFlight)) return;
    const result = this.io.postActivity({
      eventFamily: "session_identity",
      sessionName: this.identity.sessionName,
      nodeId: this.identity.nodeId ?? null,
      runtime: this.runtime,
      generation: this.identity.generation ?? null,
      hookEvent: "SessionStart",
      sessionId: this.sessionId ?? "unknown",
      sessionFile: this.sessionFile ?? null,
      occurredAt: this.io.now(),
    });
    if (this.runtime !== "omp" || !result) return;
    this.identityInFlight = true;
    void result.then(
      (body) => { if (body?.tokenPersisted === true) this.identityPersisted = true; },
      () => { /* unacknowledged; the next agent_end or retry tick re-posts */ },
    ).finally(() => { this.identityInFlight = false; });
  }

  private activityPayload(hookEvent: string, subtype: string | null): Record<string, unknown> {
    return {
      sessionName: this.identity.sessionName,
      nodeId: this.identity.nodeId ?? null,
      generation: this.identity.generation ?? null,
      runtime: this.runtime,
      hookEvent,
      subtype,
      occurredAt: this.io.now(),
    };
  }

  private writeSidecar(patch: Partial<PiRunnerState>): void {
    this.io.writeSidecar({
      ready: this.ready,
      // Launch-attempt scope: every write is stamped so the daemon can
      // distinguish THIS runner instance's truth from stale artifacts.
      launchId: this.identity.launchId,
      sessionFile: this.sessionFile,
      sessionId: this.sessionId,
      lastEntryId: this.lastEntryId,
      // OF-88: the runner's turn state, for `rig send` readiness. OMP attention is NOT written here: it is display
      // evidence (the Notification hook, rig ps, the UI), never send gating, as a pda hold is after OF-89.
      busy: this.streaming,
      updatedAt: this.io.now(),
      // OF-119: every write proves the runner is running; tickAlive() keeps proving it while nothing else is written.
      aliveAt: this.io.now(),
      ...(this.pasteOpen ? { pasteOpen: true } : {}),
      ...(this.pasteLeftover ? { pasteLeftover: true } : {}),
      ...patch,
    });
  }

  /** OF-148: the editor's open-paste edge. Written at once (not at the next alive tick), so a closed paste stops refusing
   *  sends within one write. Before the runner is ready, or after it exited, only the flag is kept: a write then would
   *  replace the pending or `exited` record. */
  setPasteOpen(open: boolean): void {
    this.pasteOpen = open;
    if (this.ready) this.writeSidecar({});
  }

  /** OF-153: the editor's recovered-paste edge, written at once like `setPasteOpen`. */
  setPasteLeftover(held: boolean): void {
    this.pasteLeftover = held;
    if (this.ready) this.writeSidecar({});
  }

  /** OF-119: rewrite the sidecar so its `aliveAt` stays fresh while the runner idles. Only a ready runner ticks: before
   *  it is ready the sidecar is not an answer, and after the child exits the `exited` record must stay the last word. */
  tickAlive(): void {
    if (this.ready) this.writeSidecar({});
  }
}

// ── CLI entry ────────────────────────────────────────────────────────────────

interface RunnerArgs {
  runtime?: RunnerRuntime;
  sessionName: string;
  stateRoot: string;
  cwd: string;
  launchId: string;
  model?: string;
  trust: "approve" | "no-approve";
  sessionFile?: string;
  forkRef?: string;
  /** OPR.0.7.0.2: report usage facts from persisted entries (the daemon passes it when usage.pi_cost_facts is on). */
  usageFacts?: boolean;
  openRouterCharge?: boolean;
  /** The seat's extra environment names for the pi child (spec `env_passthrough`). */
  envPassthrough?: string[];
}

/** OF-87: the pane editor for the Pi and OMP runners. A Ctrl-C byte inside a bracketed paste is pasted text, so one
 *  paste is one message and only a real key press submits /abort. (A paste whose closing marker never arrives
 *  therefore keeps swallowing Ctrl-C until it does, as in the pda runner; after PASTE_OPEN_HINT_MS the editor prints a
 *  pane line saying so and how to close it, OF-119.) */
export function wirePiRunnerInput(
  core: Pick<RunnerCore, "handleUserBlock"> & Partial<Pick<RunnerCore, "setPasteOpen" | "setPasteLeftover">>,
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
) {
  return createRunnerInput(input, output, (block) => core.handleUserBlock(block), {
    interruptInsidePaste: "content",
    // OF-148: `rig send` refuses while this is true (PiRuntimeAdapter.sendReadiness).
    onPasteOpenChange: (open) => core.setPasteOpen?.(open),
    // OF-153: `rig send` also refuses while the line holds a recovered lost paste (PiRuntimeAdapter.sendReadiness).
    onPasteLeftoverChange: (held) => core.setPasteLeftover?.(held),
  });
}

export function parseRunnerArgs(argv: string[]): RunnerArgs {
  const args: Partial<RunnerArgs> & { trust?: "approve" | "no-approve" } = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${flag} requires a value`);
      return value;
    };
    switch (flag) {
      case "--session-name": args.sessionName = next(); break;
      case "--runtime": {
        const runtime = next();
        if (runtime !== "pi" && runtime !== "omp") throw new Error(`unsupported runtime: ${runtime}`);
        args.runtime = runtime;
        break;
      }
      case "--state-root": args.stateRoot = next(); break;
      case "--cwd": args.cwd = next(); break;
      case "--launch-id": args.launchId = next(); break;
      case "--model": args.model = next(); break;
      case "--session": args.sessionFile = next(); break;
      case "--fork": args.forkRef = next(); break;
      case "--usage-facts": args.usageFacts = true; break;
      case "--openrouter-charge": args.openRouterCharge = true; break;
      case "--env-pass": {
        const names = next().split(",").filter((name) => name.length > 0);
        if (names.length > PI_ENV_PASSTHROUGH_MAX) throw new Error(`--env-pass names at most ${PI_ENV_PASSTHROUGH_MAX} variables`);
        for (const name of names) {
          const refusal = piEnvPassthroughRefusal(name);
          if (refusal) throw new Error(`--env-pass: ${name} ${refusal}`);
        }
        args.envPassthrough = names;
        break;
      }
      case "--approve": args.trust = "approve"; break;
      case "--no-approve": args.trust = "no-approve"; break;
      case "--approval-mode": {
        const mode = next();
        if (mode !== "yolo" && mode !== "always-ask") throw new Error(`unsupported OMP approval mode: ${mode}`);
        args.trust = mode === "yolo" ? "approve" : "no-approve";
        break;
      }
      default: throw new Error(`unknown flag: ${flag}`);
    }
  }
  if (!args.sessionName) throw new Error("--session-name is required");
  if (!args.stateRoot) throw new Error("--state-root is required");
  if (!args.cwd) throw new Error("--cwd is required");
  if (!args.launchId) throw new Error("--launch-id is required (launch-attempt scoping)");
  if (args.runtime === "omp") {
    if (!argv.includes("--approval-mode") || argv.some((flag) => flag === "--approve" || flag === "--no-approve")) {
      throw new Error("OMP requires --approval-mode yolo or always-ask, not Pi trust flags");
    }
  } else if (!args.trust || argv.includes("--approval-mode")) {
    throw new Error("an explicit trust flag is required: --approve or --no-approve");
  }
  if (args.sessionFile && args.forkRef) throw new Error("--session and --fork are mutually exclusive");
  return args as RunnerArgs;
}

/** The runner-side sidecar handshake, extracted for hermetic testing (guard
 *  re-verdict, qitem-20260707013815): read the PRIOR record's durable cursor
 *  FIRST, then stamp the launch-scoped pending record — the write carries the
 *  cursor forward so no reset in the chain can erase it. `catchUpSince` is
 *  only surfaced when resuming: a fresh/fork session has no prior projection
 *  to catch up. */
export function prepareRunnerSidecar(
  fsOps: { readFile(p: string): string; writeFile(p: string, c: string): void; exists(p: string): boolean },
  runnerStatePath: string,
  launchId: string,
  resuming: boolean,
  now: () => string,
): { catchUpSince: string | undefined } {
  let prior: PiRunnerState | null = null;
  try {
    prior = fsOps.exists(runnerStatePath) ? parsePiRunnerState(fsOps.readFile(runnerStatePath)) : null;
  } catch { /* unreadable prior sidecar — treated as absent */ }
  try {
    fsOps.writeFile(runnerStatePath, JSON.stringify(buildPendingRunnerState(launchId, now(), prior)));
  } catch { /* best-effort; the adapter pre-writes an equivalent pending record */ }
  return { catchUpSince: resuming ? prior?.lastEntryId : undefined };
}

/** OF-119: keep the runner's sidecar fresh while it idles: rewrite it once `everyMs` of WALL-CLOCK time has passed since the
 *  last tick, checking every PI_SIDECAR_CHECK_MS (unref'd, so it never keeps the process alive). Wall clock, because the
 *  reader judges `aliveAt` by it and Node's timers stand still while a laptop sleeps: a plain 60 s interval would leave a
 *  healthy runner looking stale for up to 60 s after a wake, so the check notices the jump and writes at once. A runner
 *  whose event loop is blocked stops ticking, and `rig send` stops believing its last `busy` after the alive window. */
export function startAliveTick(core: Pick<RunnerCore, "tickAlive">, everyMs = PI_SIDECAR_TICK_MS): ReturnType<typeof setInterval> {
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    if (now - last < everyMs && now >= last) return; // a clock stepped back also writes
    last = now;
    core.tickAlive();
  }, PI_SIDECAR_CHECK_MS);
  timer.unref();
  return timer;
}

/** OF-119: write the sidecar through a temp file and a rename, so a reader never parses a half-written record (it would
 *  read null and `rig send` would fall back to the pane classifier). Best-effort, as every sidecar write is. */
export function writeSidecarAtomic(
  fsOps: { writeFile(p: string, c: string): void; rename(from: string, to: string): void },
  path: string,
  state: PiRunnerState,
): void {
  try {
    const tmp = `${path}.tmp`;
    fsOps.writeFile(tmp, JSON.stringify(state));
    fsOps.rename(tmp, path);
  } catch { /* best-effort; the adapter falls back to pane markers */ }
}

/** How often an OMP runner re-delivers an unconfirmed session identity. */
const IDENTITY_RETRY_MS = 30_000;

export interface ExecutableResolverOps {
  isExecutable(path: string): boolean;
  realpath(path: string): string;
  /** Run a launcher (argv, no shell) and return its trimmed stdout. */
  run(file: string, args: string[], env: NodeJS.ProcessEnv): string;
}

const nodeResolverOps: ExecutableResolverOps = {
  isExecutable: (path) => {
    try {
      fs.accessSync(path, fs.constants.X_OK);
      return fs.statSync(path).isFile();
    } catch {
      return false;
    }
  },
  realpath: (path) => fs.realpathSync(path),
  run: (file, args, env) => execFileSync(file, args, { env, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }).trim(),
};

/** Resolve `name` to the absolute path of the real binary, using the
 *  runner's own environment. The child later runs under a per-seat HOME, and
 *  version-manager shims (mise) find their target through HOME, so the shim
 *  itself must never be what the child executes. */
export function resolveRuntimeExecutable(
  name: string,
  env: NodeJS.ProcessEnv,
  ops: ExecutableResolverOps = nodeResolverOps,
): { ok: true; path: string } | { ok: false; error: string } {
  const onPath = (env.PATH ?? "").split(nodePath.delimiter)
    .filter((dir) => nodePath.isAbsolute(dir))
    .map((dir) => nodePath.join(dir, name))
    .find((candidate) => ops.isExecutable(candidate));
  if (!onPath) return { ok: false, error: `'${name}' was not found on PATH (${env.PATH ?? ""})` };
  let real: string;
  try {
    real = ops.realpath(onPath);
  } catch (err) {
    return { ok: false, error: `could not resolve ${onPath}: ${(err as Error).message}` };
  }
  if (nodePath.basename(real) !== "mise") return { ok: true, path: real };
  // A mise shim is a symlink to mise itself; ask mise for the tool it maps to.
  let target: string;
  try {
    target = ops.run(real, ["which", name], env);
  } catch (err) {
    return { ok: false, error: `${onPath} is a mise shim and 'mise which ${name}' failed: ${(err as Error).message}` };
  }
  if (!nodePath.isAbsolute(target) || !ops.isExecutable(target)) {
    return { ok: false, error: `${onPath} is a mise shim but 'mise which ${name}' returned no executable (${target || "empty"})` };
  }
  try {
    return { ok: true, path: ops.realpath(target) };
  } catch (err) {
    return { ok: false, error: `could not resolve ${target}: ${(err as Error).message}` };
  }
}

/** Enrich an actual CLI rejection, without guessing compatibility from a version
 * or from help (older Pi prints help before validating unknown long flags). */
export function piLaunchCapabilityError(
  command: string,
  trust: "approve" | "no-approve",
  line: string,
  readVersion: () => string,
): string | undefined {
  const diagnostic = stripVTControlCharacters(line);
  if (!/unknown options?:/i.test(diagnostic) || !/--(?:name|approve|no-approve)(?=[\s,.:]|$)/.test(diagnostic)) return;
  let version = "unknown version";
  try {
    const value = stripVTControlCharacters(readVersion()).trim();
    if (/^[0-9][A-Za-z0-9.+_-]{0,63}$/.test(value)) version = `version ${value}`;
  } catch { /* diagnostics only; never changes the child's outcome */ }
  return `Pi invoked as ${command} (${version}; exact executable path unknown) rejects the managed --name/--${trust} flags. Install the current @earendil-works/pi-coding-agent (npm install -g @earendil-works/pi-coding-agent) and check 'command -v pi' in this pane; an older Pi installation may be shadowing it.`;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  let args: RunnerArgs;
  try {
    args = parseRunnerArgs(argv);
  } catch (err) {
    console.error(`${PI_RUNNER_ERROR_MARKER} ${(err as Error).message}`);
    process.exitCode = 2;
    return;
  }

  const runtime = args.runtime ?? "pi";
  const paths = piSeatPaths(args.stateRoot, args.sessionName);
  fs.mkdirSync(paths.agentDir, { recursive: true });
  fs.mkdirSync(paths.sessionsDir, { recursive: true });

  const { catchUpSince } = prepareRunnerSidecar(
    {
      readFile: (p) => fs.readFileSync(p, "utf8"),
      writeFile: (p, c) => fs.writeFileSync(p, c),
      exists: (p) => fs.existsSync(p),
    },
    paths.runnerStatePath,
    args.launchId,
    !!args.sessionFile,
    () => new Date().toISOString(),
  );

  const endpoint = resolveActivityEndpoint(process.env);
  const childEnv = buildPiChildEnv(process.env as Record<string, string | undefined>, {
    agentDir: paths.agentDir,
    sessionsDir: paths.sessionsDir,
    model: args.model,
    runtime,
    sessionName: args.sessionName,
    nodeId: process.env.OPENRIG_NODE_ID,
    openrigHome: process.env.OPENRIG_HOME,
    openrigUrl: endpoint?.baseUrl ?? process.env.OPENRIG_URL,
    extraNames: args.envPassthrough,
  });
  const childArgs = buildPiChildArgs({
    sessionsDir: paths.sessionsDir,
    sessionName: args.sessionName,
    model: args.model,
    trust: args.trust,
    sessionFile: args.sessionFile,
    forkRef: args.forkRef,
    runtime,
  });

  if (runtime === "pi") {
    console.log(`[pi-runner] seat ${args.sessionName}: ${piCredentialNotice({
      model: args.model, agentDir: paths.agentDir, env: childEnv,
      readFile: (file) => {
        if (fs.statSync(file).size > 1024 * 1024) throw new Error("Unbounded metadata");
        return fs.readFileSync(file, "utf8");
      },
    })}`);
  }
  console.log(`[${runtime}-runner] starting ${runtime} --mode rpc (seat ${args.sessionName})`);
  console.log(`[${runtime}-runner] send text normally; prefixes: "/followup <text>" queues after the turn, "/abort" cancels`);

  // OMP runs under a per-seat HOME. A HOME-dependent launcher on PATH (a mise
  // shim) cannot find its target there, so resolve the real binary first,
  // with the runner's own environment.
  let command: string = runtime;
  if (runtime === "omp") {
    const resolved = resolveRuntimeExecutable("omp", process.env);
    if (!resolved.ok) {
      console.error(`[omp-runner] ERROR launch: ${resolved.error}`);
      // Record the exit for this launch so the adapter fails it now instead
      // of waiting out its readiness timeout. The durable cursor survives.
      const at = new Date().toISOString();
      try {
        const pending = parsePiRunnerState(fs.readFileSync(paths.runnerStatePath, "utf8"));
        const exitedState: PiRunnerState = { ready: false, launchId: args.launchId, lastEntryId: pending?.lastEntryId, updatedAt: at, exited: { code: 127, at } };
        fs.writeFileSync(paths.runnerStatePath, JSON.stringify(exitedState));
      } catch { /* the pane ERROR marker still fails readiness */ }
      process.exitCode = 127;
      return;
    }
    command = resolved.path;
  }

  // OPR.0.7.0.2 K4: OpenRouter's charge, looked up with the key this runner forwarded to Pi, only for requests whose
  // credential is established as that key by the observations before and after them.
  const readMetadata = (file: string): string => {
    if (fs.statSync(file).size > 1024 * 1024) throw new Error("Unbounded metadata");
    return fs.readFileSync(file, "utf8");
  };
  const credentialEvidence = (): PiCredentialEvidence => piCredentialEvidence({
    agentDir: paths.agentDir, cwd: args.cwd, env: childEnv, now: () => Date.now(), readFile: readMetadata,
    statId: (file) => {
      try { const st = fs.statSync(file); return `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`; }
      catch (error) { if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return "absent"; throw error; }
    },
    listDir: (dir) => {
      try { return fs.readdirSync(dir); }
      catch (error) { if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return []; throw error; }
    },
  });
  // Observed before Pi is spawned, so whatever Pi loads at its start was there for this observation to see
  // (or was added after it, and is then seen by the next one).
  const launchCredentialEvidence = args.openRouterCharge === true && runtime === "pi" ? credentialEvidence() : undefined;

  const child = spawn(command, childArgs, {
    cwd: args.cwd,
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });

  // The child may close its pipe before the first RPC write completes.
  child.stdin.on("error", () => { /* spawn/exit handlers own the diagnosis */ });

  const chargeLookup = new OpenRouterChargeLookup({
    fetchGeneration: openRouterGenerationFetcher(() => childEnv["OPENROUTER_API_KEY"]),
    postCharges: async (piSessionId, charges) => {
      if (!endpoint || typeof fetch !== "function") return false;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      return fetch(new URL("/api/activity/pi-usage-charges", endpoint.baseUrl).toString(), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${endpoint.token}` },
        body: JSON.stringify({ sessionName: args.sessionName, nodeId: process.env.OPENRIG_NODE_ID, piSessionId, charges }),
        signal: controller.signal,
      }).then(interpretChargesReply, () => false as const).finally(() => clearTimeout(timeout));
    },
    schedule: (fn, ms) => { setTimeout(fn, ms).unref(); },
    notice: (line) => { process.stdout.write(`${line}\n`); },
  });

  const io: RunnerIo = {
    sendRpc: (cmd) => {
      try { child.stdin.write(`${JSON.stringify(cmd)}\n`); } catch { /* exit handler reports */ }
    },
    mirrorLine: (line) => process.stdout.write(`${line}\n`),
    mirrorAppend: (text) => process.stdout.write(text),
    postActivity: (payload) => {
      if (!endpoint || typeof fetch !== "function") return;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1500);
      const request = fetch(new URL("/api/activity/hooks", endpoint.baseUrl).toString(), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${endpoint.token}` },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (runtime !== "omp") {
        request.catch(() => { /* best-effort — never blocks the loop */ }).finally(() => clearTimeout(timeout));
        return;
      }
      // OMP reads the acknowledgement so identity delivery can retry; null
      // (transport failure or a non-OK reply) means "not yet persisted".
      return request
        .then(async (response) => response.ok ? await response.json() as Record<string, unknown> : null)
        .catch(() => null)
        .finally(() => clearTimeout(timeout));
    },
    writeSidecar: (state) => writeSidecarAtomic(
      { writeFile: (p, c) => fs.writeFileSync(p, c), rename: (a, b) => fs.renameSync(a, b) }, paths.runnerStatePath, state),
    now: () => new Date().toISOString(),
    stopChild: () => { child.kill(); },
    sessionFileExists: (path) => fs.existsSync(path),
    postUsageFacts: async (payload) => {
      if (!endpoint || typeof fetch !== "function") return false;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      return fetch(new URL("/api/activity/pi-usage", endpoint.baseUrl).toString(), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${endpoint.token}` },
        body: JSON.stringify(payload),
        signal: controller.signal,
      }).then(interpretUsageFactsReply, () => false /* best-effort: a later refresh re-sends what wasn't stored */).finally(() => clearTimeout(timeout));
    },
    ...(args.openRouterCharge === true && runtime === "pi" ? {
      enqueueChargeLookups: (piSessionId: string, items: Array<{ fact: PiUsageFact; provenance: ChargeProvenance }>, charged: ReadonlySet<string>) =>
        chargeLookup.enqueue(piSessionId, items, charged),
      credentialEvidence,
    } : {}),
    readFirstLine: (path) => {
      try {
        const fd = fs.openSync(path, "r");
        try {
          const buffer = Buffer.alloc(8192);
          const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
          const text = buffer.subarray(0, read).toString("utf8");
          const end = text.indexOf("\n");
          return end >= 0 ? text.slice(0, end) : null;
        } finally { fs.closeSync(fd); }
      } catch { return null; }
    },
    readSessionEntryIds: (path) => readPiSessionEntryIds(path),
  };

  const core = new RunnerCore(io, {
    sessionName: args.sessionName, nodeId: process.env.OPENRIG_NODE_ID, launchId: args.launchId,
    // Carry the emitting tenure; never infer it from a later daemon read or Pi event.
    generation: process.env.OPENRIG_OCCUPANT_GENERATION,
  }, { catchUpSince, runtime, usageFacts: args.usageFacts === true, openRouterCharge: args.openRouterCharge === true, launchCredentialEvidence });

  let transportUp = runtime === "pi";
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    if (runtime === "omp" && !core.isReady()) {
      try {
        const frame = JSON.parse(line) as { type?: string };
        if (frame.type === "ready") {
          transportUp = true;
          core.start();
        }
      } catch { /* surface non-JSON stdout through the core */ }
    }
    core.handlePiLine(line);
  });
  startAliveTick(core);
  // Re-deliver OMP identity until the daemon confirms the resume token.
  const identityRetry = runtime === "omp" ? setInterval(() => core.retrySessionIdentity(), IDENTITY_RETRY_MS) : undefined;
  identityRetry?.unref();
  // The last few stderr lines, so an OMP that exits during startup is
  // reported with its own words in the error, not only above it.
  const stderrTail: string[] = [];
  let reportedPiCapability = false;
  readline.createInterface({ input: child.stderr }).on("line", (line) => {
    if (!line.trim()) return;
    process.stdout.write(`[${runtime}:err] ${line}\n`);
    stderrTail.push(line.length > OMP_STDERR_TAIL_CHARS ? `${line.slice(0, OMP_STDERR_TAIL_CHARS)}...` : line);
    if (stderrTail.length > OMP_STDERR_TAIL_LINES) stderrTail.shift();
    if (runtime === "pi" && !core.isReady() && !reportedPiCapability) {
      const detail = piLaunchCapabilityError(command, args.trust, line, () => {
        const version = spawnSync(command, ["--version"], { cwd: args.cwd, env: childEnv, encoding: "utf8",
          timeout: 3000, killSignal: "SIGKILL", maxBuffer: 4096, stdio: ["ignore", "pipe", "pipe"] });
        if (version.error || version.status !== 0) return "";
        // Older Pi redirects even --version to stderr when stdout is a pipe.
        return version.stdout.trim() || version.stderr.trim();
      });
      if (detail) {
        reportedPiCapability = true;
        process.stdout.write(`[pi-runner] ${detail}\n`);
      }
    }
  });
  const input = wirePiRunnerInput(core, process.stdin, process.stdout);

  if (runtime === "pi") {
    child.on("error", (err) => {
      console.error(`${PI_RUNNER_ERROR_MARKER} failed to spawn pi: ${err.message}`);
      const code = (err as NodeJS.ErrnoException).code === "ENOENT" ? 127 : 1;
      core.handlePiExit(code);
      input.close();
      process.exitCode = code;
    });
    child.on("exit", (code) => {
      core.handlePiExit(code);
      input.close();
      process.exitCode = code ?? 1;
    });
    core.start();
    return;
  }

  // OMP: one exit record per launch. When the RPC session never became
  // resumable, say which startup phase OMP reached and how it exited, and
  // show its own last output; the runner does not know why OMP stopped.
  let exited = false;
  const recordExit = (code: number | null, signal?: NodeJS.Signals | null): void => {
    if (exited) return;
    exited = true;
    clearInterval(identityRetry);
    if (!core.isReady()) {
      const how = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
      const output = stderrTail.length > 0 ? ` Its last output: ${stderrTail.join(" | ")}` : " It printed nothing on stderr.";
      console.error(transportUp
        ? "[omp-runner] ERROR OMP did not establish a resumable RPC session. Authenticate this isolated seat using HOME=<seat-root> PI_CODING_AGENT_DIR=<seat-root>/agent omp and /login, or provide its declared model provider key in the OpenRig daemon environment. Default OMP credentials are not shared."
        : `[omp-runner] ERROR OMP exited during startup, before its RPC transport started (${command}, ${how}).${output}`);
    }
    core.handlePiExit(code);
    input.close();
    process.exitCode = code ?? 1;
  };
  child.on("error", (err) => {
    console.error(`[omp-runner] ERROR failed to spawn omp: ${err.message}`);
    recordExit(null);
  });
  // "close" fires once OMP's stdio is drained, so its stderr is in the tail
  // before the exit is reported. A child that inherited OMP's stdio (an LSP
  // or MCP server) can hold "close" open, so "exit" also records the exit
  // after a short grace period; recordExit runs once, whichever comes first.
  child.on("close", (code, signal) => recordExit(code, signal));
  child.on("exit", (code, signal) => { setTimeout(() => recordExit(code, signal), OMP_EXIT_GRACE_MS).unref(); });
}

/** Stderr lines kept for an OMP startup failure report, and their length cap. */
const OMP_STDERR_TAIL_LINES = 5;
const OMP_STDERR_TAIL_CHARS = 300;
/** How long after OMP's own exit to wait for its stderr to drain. */
const OMP_EXIT_GRACE_MS = 1_000;

// Compiled-entry guard: run main() only when executed directly (not imported
// by tests). import.meta.url === file URL of process.argv[1] when direct.
const invokedDirectly = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    // pathToFileURL handles percent-encoding (spaces etc.) the way
    // import.meta.url does — a hand-built `file://${path}` string does not.
    return import.meta.url === pathToFileURL(nodePath.resolve(entry)).href;
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  void main();
}
