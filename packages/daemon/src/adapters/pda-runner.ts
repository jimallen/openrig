// pda runtime L1b (pda-runtime-design-9l Rev 2, "The pda-runner"): the pane-hosted process that stands between
// an OpenRig seat and ONE pda agent. Launched as
//   node <dist>/adapters/pda-runner.js --session-name <s> --state-root <root> --launch-id <id> --agent <name>
//        --base-url <http://127.0.0.1:port> --token-file <path> [--usage-facts]
// (the argv is built by L0's `buildPdaRunnerArgv`; it holds no secret).
//
// What it does, and where each piece lives:
//   - INPUT   one bracketed paste is one message: `createRunnerInput` (L0) in content mode, with an Enter that
//             becomes ONE `outbox.enqueue` (L1a, durable before any POST). Ctrl-C clears the line and never
//             stops the agent. There are no slash commands: `/abort`, `/reset`, `!x` are content.
//   - OUTPUT  pda's SSE stream (`pda-sse.ts`) rendered to the pane through `PdaPane` (`pda-render.ts`):
//             agent text in full, FULL tool output (Jim's J-2), every string sanitised, then exact-token
//             redacted. Any snapshot (the first, a reconnect's, or a mid-stream overflow's) triggers a gap
//             fill from the transcript; a reply that was streaming across a resync is printed again in full.
//   - STATE   `runner-state.json` (the sidecar, L0's `PdaRunnerState`): ready, connected, busy/idle from the
//             run events, held, outboxPending. It never holds the token, a message body, tool output or a pda
//             error body. `own-submissions.json`: the last 500 submission ids this seat made.
//   - CONTROL `release.request` is polled on the 60 s alive tick and on every attach (`rig seat pda-release`).
//   - ACTIVITY POSTs to the daemon on transitions only; they carry the tool NAME, never its arguments or output.
//   - USAGE   `--usage-facts` is parsed and routed to a `PdaUsageSink`. The sink is a stub here: L2c fills it.
//
// Errors are CODES. No catch block prints an exception's message, cause or stack, and the process-level
// `uncaughtException` / `unhandledRejection` handlers print a code and exit 70.
//
// Exit codes: 0 stopped (SIGTERM, SIGHUP, input closed); 2 bad arguments; 3 the agent does not exist (OpenRig
// never creates one); 4 the token file is not usable; 70 internal.

import fs from "node:fs";
import nodePath from "node:path";
import { pathToFileURL } from "node:url";
import {
  PDA_RUNNER_ERROR_MARKER, PDA_RUNNER_EXIT_MARKER, PDA_RUNNER_LABEL, PDA_RUNNER_READY_MARKER, PDA_RUNTIME,
  isPdaLoopbackBaseUrl, parsePdaRunnerState, pdaAgentNameProblem, pdaSeatPaths, sanitizeForPane,
  type PdaHeldCode, type PdaRunnerArgs, type PdaRunnerErrorCode, type PdaRunnerState, type PdaSeatPaths,
} from "./pda-runner-protocol.js";
import {
  createPdaClient, pdaTokenSourceFromFile,
  type PdaCallFailure, type PdaClient, type PdaTokenReadResult,
} from "./pda-client.js";
import { PdaOutbox, type PdaAttemptOutcome } from "./pda-outbox.js";
import { PdaSseOverflowError, PdaSseParser, parsePdaEventData, type PdaStreamEvent } from "./pda-sse.js";
import {
  HOOK_TOKEN_MARKER, PDA_TOKEN_MARKER, PdaPane, argsFirstLine, entryView, resultText, textDeltaOf,
  type PdaEntryView, type PdaSecret,
} from "./pda-render.js";
import { createRunnerInput, resolveActivityEndpoint } from "./runner-pane-io.js";

// ── Arguments ────────────────────────────────────────────────────────────────

export type PdaArgsResult =
  | { ok: true; args: PdaRunnerArgs }
  /** `reason` is a fixed phrase; no argument value is ever echoed. */
  | { ok: false; code: "pda_args_invalid"; reason: string };

const bad = (reason: string): PdaArgsResult => ({ ok: false, code: "pda_args_invalid", reason });

/** The inverse of L0's `buildPdaRunnerArgv`. Strict: an unknown flag, a missing value, a binding pda would not
 *  accept (non-loopback URL, `main`, a bad name) or a session name that is not one path segment is refused. */
export function parsePdaRunnerArgv(argv: readonly string[]): PdaArgsResult {
  const values = new Map<string, string>();
  let usageFacts = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === "--usage-facts") { usageFacts = true; continue; }
    if (!["--session-name", "--state-root", "--launch-id", "--agent", "--base-url", "--token-file"].includes(flag)) {
      return bad("unknown flag");
    }
    const value = argv[++i];
    if (value === undefined || value.length === 0) return bad("a flag is missing its value");
    if (values.has(flag)) return bad("a flag was given twice");
    values.set(flag, value);
  }
  for (const flag of ["--session-name", "--state-root", "--launch-id", "--agent", "--base-url", "--token-file"]) {
    if (!values.has(flag)) return bad(`${flag} is required`);
  }
  const sessionName = values.get("--session-name")!;
  if (sessionName === "." || sessionName === ".." || /[\\/\u0000]/.test(sessionName)) return bad("--session-name must be one path segment");
  const agent = values.get("--agent")!;
  if (pdaAgentNameProblem(agent) !== null) return bad("--agent is not a name a seat may bind");
  const baseUrl = values.get("--base-url")!;
  if (!isPdaLoopbackBaseUrl(baseUrl)) return bad("--base-url must be http://127.0.0.1:<port>");
  return {
    ok: true,
    args: {
      sessionName, stateRoot: values.get("--state-root")!, launchId: values.get("--launch-id")!,
      binding: { agent, baseUrl }, tokenFile: values.get("--token-file")!, ...(usageFacts ? { usageFacts: true } : {}),
    },
  };
}

// ── Effects the runner needs, injectable ─────────────────────────────────────

export interface PdaRunnerFs {
  /** Replace the file atomically (temp file in the same directory, then rename), mode 0600. */
  writeAtomic(path: string, text: string): void;
  readText(path: string): string | null;
  /** lstat: a symlink reports `isFile: false`. Null when the path does not exist. */
  stat(path: string): { isFile: boolean; size: number } | null;
  remove(path: string): void;
}

export const nodeRunnerFs: PdaRunnerFs = {
  writeAtomic: (path, text) => {
    const tmp = `${path}.tmp`;
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, path);
  },
  readText: (path) => {
    try { return fs.readFileSync(path, "utf8"); } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  },
  stat: (path) => {
    try { const st = fs.lstatSync(path); return { isFile: st.isFile(), size: st.size }; } catch { return null; }
  },
  remove: (path) => { try { fs.unlinkSync(path); } catch { /* already gone */ } },
};

/** L2c's seam (usage facts, J-3). Called with raw pda events; the default does nothing. The runner has NO
 *  usage behaviour of its own: `--usage-facts` only selects which sink main() installs. */
export interface PdaUsageSink {
  onRunStart?(event: PdaStreamEvent): void;
  onAssistantEntry?(entry: unknown): void;
  onRunEnd?(event: PdaStreamEvent): void;
}

export interface PdaRunnerDeps {
  args: PdaRunnerArgs;
  nodeId: string;
  generation: string | null;
  client: PdaClient;
  outbox: PdaOutbox;
  /** The token source the client was built with. The runner calls it once before first use (A6). */
  readToken: () => PdaTokenReadResult;
  /** The secrets the runner holds, for exact redaction. */
  secrets: () => readonly PdaSecret[];
  /** The pane (stdout). */
  write: (text: string) => void;
  /** Best-effort POST to the daemon's activity endpoint. Must not throw, must not block. */
  postActivity: (payload: Record<string, unknown>) => void;
  fs: PdaRunnerFs;
  now?: () => Date;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Default 60 000 (the alive tick and the release poll). */
  aliveIntervalMs?: number;
  /** Reconnect backoff: 500 ms doubling to 10 s. */
  backoffStartMs?: number;
  backoffCapMs?: number;
  usage?: PdaUsageSink;
}

const OWN_SUBMISSIONS_MAX = 500;
const RENDERED_IDS_MAX = 2000;
const TRANSCRIPT_FIRST_LIMIT = 50;
const TRANSCRIPT_WIDE_LIMIT = 500;
const GAP_NEWEST = 20;
const ECHO_CAP = 4000;
const NOTICE_INTERVAL_MS = 60_000;
const HELD_MAX_ATTEMPTS = 6;

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });

/** Leave the stream, then reconnect. `error` is what the sidecar should say while detached. */
class Detach extends Error {
  constructor(readonly why: "stream_end" | "protocol" | "unreachable" | "unauthorized", readonly error?: PdaRunnerErrorCode) { super(why); }
}
/** Stop the whole runner with this exit code. */
class Exit extends Error {
  constructor(readonly exitCode: number, readonly error?: PdaRunnerErrorCode) { super("exit"); }
}

const HELD_TEXT: Record<PdaHeldCode, string> = {
  pda_message_held: "pda did not take the message",
  pda_agent_missing: "the pda agent does not exist",
  pda_unauthorized: "pda refused the token",
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export class PdaRunner {
  private readonly now: () => Date;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly paths: PdaSeatPaths;
  private readonly pane: PdaPane;
  private readonly stopper = new AbortController();
  private readonly usage: PdaUsageSink;

  private ready = false;
  private connected = false;
  private busy = false;
  private lastPostedBusy: boolean | null = null;
  private lastEntryId: string | undefined;
  private error: { code: PdaRunnerErrorCode; at: string } | null = null;
  private exited: { code: number | null; at: string } | null = null;
  private finished = false;
  private everAttached = false;
  private unknownEvents = 0;
  private aliveTimer: ReturnType<typeof setInterval> | undefined;

  /** Streamed assistant text is in progress (some deltas were printed and no message_end has closed them). */
  private streaming = false;
  /** A snapshot arrived while a reply might be mid-flight: the next assistant message is printed again in full. */
  private maybePartial = false;
  private readonly rendered = new Map<string, true>();
  private ownSubmissions: string[] = [];

  private attachAbort: AbortController | null = null;
  private currentStream: { close(): void } | null = null;
  private pumping = false;
  private pumpAgain = false;
  private readonly lastNotice = new Map<string, number>();

  constructor(private readonly deps: PdaRunnerDeps) {
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? defaultSleep;
    this.usage = deps.usage ?? {};
    this.paths = pdaSeatPaths(deps.args.stateRoot, deps.args.sessionName);
    this.pane = new PdaPane(deps.write, deps.secrets);
    deps.outbox.onAck = (_requestId, submissionId) => this.onAck(submissionId);
  }

  // ── Public surface ──

  /** An Enter after a paste: one block, one message. Durable before anything is posted. */
  submit(block: string): void {
    let result: ReturnType<PdaOutbox["enqueue"]>;
    try {
      result = this.deps.outbox.enqueue(block);
    } catch {
      this.pane.line(`${PDA_RUNNER_ERROR_MARKER} pda_outbox_write_failed: the message was NOT saved and will NOT be sent`);
      this.pane.endBatch();
      return;
    }
    if (!result.ok) {
      this.pane.line(`${PDA_RUNNER_ERROR_MARKER} not sent: the message is too large for pda`);
    } else {
      const shown = block.length > ECHO_CAP ? `${block.slice(0, ECHO_CAP)} … (${block.length - ECHO_CAP} more characters)` : block;
      this.pane.block(shown, "      ", "you ▸ ");
      this.writeSidecar();
      this.kick();
    }
    this.pane.endBatch();
  }

  /** Ctrl-C. The editor has cleared the line. This never reaches the agent. */
  interrupted(): void {
    this.pane.line("[pda-runner] input cleared (Ctrl-C never stops the agent)");
    this.pane.endBatch();
  }

  stop(): void {
    this.stopper.abort();
    this.currentStream?.close();
  }

  /** Record a fatal internal error: a code, never a message. Returns the exit code to use. */
  fatal(label: string): number {
    this.pane.line(`${PDA_RUNNER_ERROR_MARKER} internal (${label})`);
    this.pane.endBatch();
    this.finish(70);
    return 70;
  }

  // ── The run loop ──

  async run(): Promise<number> {
    // The prior launch's cursor, when it was for this same binding: capture is rebuilt from it, not reprinted.
    this.loadPriorCursor();
    this.loadOwnSubmissions();
    this.writeSidecar();

    // A6: the token is validated against pda's own format before first use. Codes only.
    const token = this.deps.readToken();
    if (!token.ok) return this.exitWith(new Exit(4, "pda_token_format"), token.problem);

    const snap = this.deps.outbox.snapshot();
    if (snap.setAside > 0) {
      this.pane.line(`[pda-runner] ${snap.setAside} message(s) read for another pda binding are held and will not be sent to ${this.deps.args.binding.agent}; see outbox.log`);
      this.pane.endBatch();
    }
    this.aliveTimer = setInterval(() => this.tick(), this.deps.aliveIntervalMs ?? 60_000);
    this.aliveTimer.unref();

    let delay = this.deps.backoffStartMs ?? 500;
    const cap = this.deps.backoffCapMs ?? 10_000;
    try {
      while (!this.stopper.signal.aborted) {
        try {
          const attached = await this.attachOnce();
          if (attached) delay = this.deps.backoffStartMs ?? 500;
        } catch (err) {
          if (err instanceof Exit) return this.exitWith(err);
          if (!(err instanceof Detach)) throw err;
          this.afterDetach(err);
        }
        if (this.stopper.signal.aborted) break;
        await this.sleep(delay, this.stopper.signal);
        delay = Math.min(delay * 2, cap);
      }
    } finally {
      this.detach();
    }
    return this.finish(0);
  }

  private exitWith(exit: Exit, tokenProblem?: string): number {
    if (exit.error) this.error = { code: exit.error, at: this.stamp() };
    if (exit.error === "pda_token_format") {
      this.pane.line(`${PDA_RUNNER_ERROR_MARKER} pda_token_format: the token file is not in pda's token format${tokenProblem ? ` (${tokenProblem})` : ""}`);
    } else if (exit.error === "pda_agent_missing") {
      this.pane.line(`${PDA_RUNNER_ERROR_MARKER} pda_agent_missing: pda has no agent '${this.deps.args.binding.agent}' (OpenRig never creates one)`);
    }
    this.pane.endBatch();
    return this.finish(exit.exitCode);
  }

  private finish(code: number): number {
    if (this.finished) return code;
    this.finished = true;
    if (this.aliveTimer) clearInterval(this.aliveTimer);
    this.ready = false;
    this.connected = false;
    this.exited = { code, at: this.stamp() };
    this.writeSidecar();
    this.pane.line(`${PDA_RUNNER_EXIT_MARKER} code=${code}`);
    this.pane.endBatch();
    this.stop();
    return code;
  }

  // ── Attach, stream, resync ──

  /** One connection. True once it reached READY (so the caller resets its backoff). Throws Detach or Exit. */
  private async attachOnce(): Promise<boolean> {
    const client = this.deps.client;
    this.check(await client.health());
    this.check(await client.getAgent());
    const events = await client.openEvents(0);
    if (!events.ok) { this.check(events); throw new Detach("unreachable", "pda_unreachable"); }
    const stream = events.value;
    this.currentStream = stream;
    const attach = new AbortController();
    this.attachAbort = attach;
    let reachedReady = false;
    const parser = new PdaSseParser();
    const reader = stream.body.getReader();
    let snapshotsSeen = 0;
    try {
      for (;;) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try { chunk = await reader.read(); } catch {
          if (this.stopper.signal.aborted) return reachedReady;
          throw new Detach("unreachable", "pda_unreachable");
        }
        if (chunk.done) { if (!this.stopper.signal.aborted) throw new Detach("stream_end"); return reachedReady; }
        let messages;
        try { messages = parser.push(chunk.value); } catch (err) {
          if (err instanceof PdaSseOverflowError) throw new Detach("protocol", "pda_protocol");
          throw err;
        }
        for (const message of messages) {
          const event = parsePdaEventData(message.data);
          if (!event) continue; // not an event: ignored, never rendered
          try {
            const wasSnapshot = event.type === "snapshot";
            await this.handleEvent(event, snapshotsSeen === 0);
            if (wasSnapshot) { snapshotsSeen += 1; reachedReady = true; }
          } catch (err) {
            if (err instanceof Detach || err instanceof Exit) throw err;
            // A bug in one event's handler must not take the seat down, and must not print a message.
            this.pane.line(`${PDA_RUNNER_ERROR_MARKER} internal (event_handler)`);
          }
          this.pane.endBatch();
        }
      }
    } finally {
      stream.close();
      try { reader.releaseLock(); } catch { /* the reader is already released */ }
      this.currentStream = null;
      this.detach();
    }
  }

  /** Map a failed client call to the runner's reaction. Returns normally only for a success. */
  private check(result: { ok: true } | PdaCallFailure): void {
    if (result.ok) return;
    switch (result.kind) {
      case "token": throw new Exit(4, "pda_token_format");
      case "unreachable": throw new Detach("unreachable", "pda_unreachable");
      case "http":
        if (result.status === 404) throw new Exit(3, "pda_agent_missing");
        if (result.status === 401) throw new Detach("unauthorized", "pda_unauthorized");
        throw new Detach("protocol", "pda_protocol");
      default: throw new Detach("protocol", "pda_protocol");
    }
  }

  private detach(): void {
    this.attachAbort?.abort();
    this.attachAbort = null;
  }

  private afterDetach(why: Detach): void {
    const wasConnected = this.connected;
    this.connected = false;
    this.pane.closeLine();
    if (why.error) this.error = { code: why.error, at: this.stamp() };
    if (wasConnected) {
      this.lastPostedBusy = null;
      this.postActivity("Notification", "pda_disconnected");
      this.pane.line("[pda-runner] stream lost; reconnecting");
    } else if (why.error && this.shouldNotice(`detach:${why.error}`)) {
      const text = why.error === "pda_unauthorized" ? "pda refused the token; retrying"
        : why.error === "pda_protocol" ? "pda sent something unexpected; retrying" : "pda unreachable; retrying";
      this.pane.line(`[pda-runner] ${text}`);
    }
    this.pane.endBatch();
    this.writeSidecar();
  }

  private shouldNotice(key: string): boolean {
    const at = this.now().getTime();
    const last = this.lastNotice.get(key);
    if (last !== undefined && at - last < NOTICE_INTERVAL_MS) return false;
    this.lastNotice.set(key, at);
    return true;
  }

  // ── Events ──

  private async handleEvent(event: PdaStreamEvent, firstSnapshot: boolean): Promise<void> {
    switch (event.type) {
      case "snapshot": return this.onSnapshot(event, firstSnapshot);
      case "run_start":
        this.busy = true;
        this.lastPostedBusy = true;
        this.postActivity("active", "run_start");
        this.usage.onRunStart?.(event);
        this.writeSidecar();
        return;
      case "run_end":
        this.pane.closeLine();
        this.busy = false;
        this.lastPostedBusy = false;
        this.maybePartial = false;
        this.streaming = false; // the run is over: whatever was streaming is not coming back
        this.pane.line("── idle ──");
        this.postActivity("Stop", "run_end");
        this.usage.onRunEnd?.(event);
        this.writeSidecar();
        return;
      case "message_update": {
        const delta = textDeltaOf(event);
        if (delta === null || delta.length === 0) return;
        this.streaming = true;
        this.pane.append(delta);
        return;
      }
      case "message_end": return this.onMessageEnd(event);
      case "tool_execution_start": {
        if (event.parentToolCallId !== undefined && event.parentToolCallId !== null) return; // nested calls are not shown
        const name = typeof event.toolName === "string" && event.toolName.length > 0 ? event.toolName : "tool";
        this.pane.line(`  ⚙ ${name}: ${argsFirstLine(event.args)}`);
        this.postActivity("PreToolUse", name);
        return;
      }
      case "tool_execution_end": return this.onToolEnd(event);
      case "entry_appended": {
        const view = entryView(event.entry);
        // Assistant text and tool results are rendered by their own live events; this path adds the rest.
        if (view && view.role !== "assistant" && view.role !== "toolResult") this.renderEntry(view, "live");
        return;
      }
      case "submission": return this.onSubmission(event);
      case "auto_retry_start":
        this.pane.line("[pda-runner] transient error; retrying");
        this.postActivity("active", "auto_retry");
        return;
      case "compaction_start":
        this.pane.line("[pda-runner] compacting context…");
        this.postActivity("active", "compaction");
        return;
      case "compaction_end":
        this.pane.line("[pda-runner] compaction finished");
        return;
      case "task_failed": {
        const reason = typeof event.error === "string" ? event.error : typeof event.reason === "string" ? event.reason : "";
        this.pane.line(`[pda-runner] task failed${reason ? `: ${reason.slice(0, 200)}` : ""}`);
        return;
      }
      case "stream_end": throw new Detach("stream_end");
      case "usage_changed": return; // totals are not shown here (the usage lane's)
      default: this.unknownEvents += 1;
    }
  }

  private async onSnapshot(snapshot: PdaStreamEvent, firstOfConnection: boolean): Promise<void> {
    const run = snapshot.run;
    if (run !== undefined && run !== null && !isObj(run)) throw new Detach("protocol", "pda_protocol");
    const busy = run !== undefined && run !== null;

    // Whatever was streaming may have lost deltas; whatever is running may have started before we saw it.
    this.pane.closeLine();
    this.maybePartial = this.streaming || busy;

    await this.fillGap();

    this.busy = busy;
    const wasConnected = this.connected;
    this.connected = true;
    if (this.lastPostedBusy !== busy) {
      this.postActivity(busy ? "active" : "Stop", busy ? "attached_busy" : "attached_idle");
      this.lastPostedBusy = busy;
    }
    if (firstOfConnection || !wasConnected) this.onAttached();
    this.writeSidecar();
  }

  /** The first snapshot of a connection has been resynced: the seat is attached. */
  private onAttached(): void {
    const first = !this.everAttached;
    this.everAttached = true;
    this.ready = true;
    this.error = null;
    this.lastNotice.clear();
    if (first) this.pane.line(`${PDA_RUNNER_READY_MARKER} agent=${this.deps.args.binding.agent}`);
    else {
      this.pane.line("[pda-runner] reconnected");
      // A held head is retried after a reconnect that follows a pda restart (A2); in memory only.
      this.deps.outbox.retryHeldAfterReconnect();
    }
    this.pollRelease();
    this.kick();
  }

  // ── Gap fill ──

  private async fillGap(): Promise<void> {
    let entries = await this.transcript(TRANSCRIPT_FIRST_LIMIT);
    const cursor = this.lastEntryId;
    let from = 0;
    let gap = false;
    if (cursor !== undefined) {
      let at = entries.findIndex((e) => entryView(e)?.id === cursor);
      if (at < 0) {
        entries = await this.transcript(TRANSCRIPT_WIDE_LIMIT);
        at = entries.findIndex((e) => entryView(e)?.id === cursor);
      }
      if (at >= 0) from = at + 1;
      else gap = true;
    } else if (!this.everAttached) {
      gap = true; // the first look at this conversation: its history, newest last
    } else {
      gap = entries.length >= TRANSCRIPT_FIRST_LIMIT; // everything returned is new; a full window may hide older entries
    }
    let todo = entries.slice(from);
    if (gap && todo.length > GAP_NEWEST) todo = todo.slice(todo.length - GAP_NEWEST);
    if (gap && todo.length > 0) {
      this.pane.line(cursor === undefined
        ? `[pda-runner] showing the newest ${todo.length} entries`
        : `[pda-runner] (gap: entries before these were not retrieved) showing the newest ${todo.length}`);
    }
    for (const entry of todo) {
      const view = entryView(entry);
      if (view) this.renderEntry(view, "gap");
    }
  }

  private async transcript(limit: number): Promise<unknown[]> {
    const result = await this.deps.client.getTranscript(limit);
    if (!result.ok) { this.check(result); throw new Detach("unreachable", "pda_unreachable"); }
    const value = result.value;
    const list = Array.isArray(value) ? value : isObj(value) && Array.isArray(value.entries) ? value.entries : null;
    if (list === null) throw new Detach("protocol", "pda_protocol");
    return list;
  }

  // ── Rendering ──

  private isOwn(view: PdaEntryView): boolean {
    if (view.requestId !== null && view.requestId.startsWith(`openrig/${this.deps.nodeId}/`)) return true;
    return view.submissionId !== null && this.ownSubmissions.includes(view.submissionId);
  }

  private remember(key: string): boolean {
    if (this.rendered.has(key)) return false;
    this.rendered.set(key, true);
    if (this.rendered.size > RENDERED_IDS_MAX) {
      const oldest = this.rendered.keys().next().value;
      if (oldest !== undefined) this.rendered.delete(oldest);
    }
    return true;
  }

  private renderEntry(view: PdaEntryView, source: "gap" | "live"): void {
    if (view.id !== null && !this.remember(view.id)) return;
    if (view.kind === "pi.reset") { this.pane.line("[pda-runner] conversation was reset"); this.advance(view); return; }
    switch (view.role) {
      case "user":
        if (!this.isOwn(view)) this.pane.block(view.text, "        ", "other ▸ ");
        break;
      case "assistant":
        for (const call of view.toolCalls) this.pane.line(`  ⚙ ${call.name}: ${argsFirstLine(call.args)}`);
        if (view.text.length > 0) {
          if (source === "gap" && this.maybePartial) {
            this.pane.line("[pda-runner] (reply resent in full after resync)");
            this.maybePartial = false;
          }
          this.pane.block(view.text, "");
        }
        break;
      case "toolResult":
        if (view.toolCallId === null || this.remember(`tool:${view.toolCallId}`)) this.pane.block(view.text.length > 0 ? view.text : "(no output)", view.isError ? "  ✗ " : "  │ ")
        break;
      default:
        break;
    }
    this.advance(view);
  }

  private advance(view: PdaEntryView): void {
    if (view.id !== null) this.lastEntryId = view.id;
  }

  private onMessageEnd(event: PdaStreamEvent): void {
    const view = entryView(event.entry);
    const wasStreaming = this.streaming;
    this.streaming = false;
    const partial = this.maybePartial;
    this.maybePartial = false;
    if (!view || view.role !== "assistant") { this.pane.closeLine(); return; }
    if (view.id !== null && this.rendered.has(view.id)) { this.pane.closeLine(); return; } // the gap fill printed it whole
    if (view.id !== null) this.remember(view.id);
    this.pane.closeLine();
    if (partial) {
      if (view.text.length > 0) {
        this.pane.line("[pda-runner] (reply resent in full after resync)");
        this.pane.block(view.text, "");
      }
    } else if (!wasStreaming && view.text.length > 0) {
      this.pane.block(view.text, ""); // nothing was streamed: print the whole reply
    }
    this.advance(view);
    this.usage.onAssistantEntry?.(event.entry);
    this.writeSidecar();
  }

  private onToolEnd(event: PdaStreamEvent): void {
    if (event.parentToolCallId !== undefined && event.parentToolCallId !== null) return;
    const view = event.entry !== undefined ? entryView(event.entry) : null;
    const callId = typeof event.toolCallId === "string" ? event.toolCallId : view?.toolCallId ?? null;
    if (callId !== null && !this.remember(`tool:${callId}`)) return;
    if (view?.id) this.remember(view.id);
    const text = view && view.text.length > 0 ? view.text : resultText(event.result);
    const isError = event.isError === true || view?.isError === true;
    this.pane.block(text.length > 0 ? text : "(no output)", isError ? "  ✗ " : "  │ ");
    if (view) this.advance(view);
  }

  private onSubmission(event: PdaStreamEvent): void {
    const requestId = typeof event.requestId === "string" ? event.requestId : null;
    const own = requestId !== null && requestId.startsWith(`openrig/${this.deps.nodeId}/`);
    if (own && typeof event.submissionId === "string") this.recordOwn(event.submissionId);
    const outcome = event.outcome ?? event.status;
    if (own && outcome === "unanswered") {
      const reason = typeof event.reason === "string" ? `: ${event.reason.slice(0, 200)}` : "";
      this.pane.line(`[pda-runner] not answered${reason}`);
    }
  }

  // ── Own submissions ──

  private loadOwnSubmissions(): void {
    try {
      const text = this.deps.fs.readText(this.paths.ownSubmissionsPath);
      const parsed = text === null ? null : (JSON.parse(text) as unknown);
      const ids = isObj(parsed) && Array.isArray(parsed.ids) ? parsed.ids.filter((x): x is string => typeof x === "string") : [];
      this.ownSubmissions = ids.slice(-OWN_SUBMISSIONS_MAX);
    } catch { this.ownSubmissions = []; }
  }

  private recordOwn(submissionId: string): void {
    if (this.ownSubmissions.includes(submissionId)) return;
    this.ownSubmissions.push(submissionId);
    if (this.ownSubmissions.length > OWN_SUBMISSIONS_MAX) this.ownSubmissions.splice(0, this.ownSubmissions.length - OWN_SUBMISSIONS_MAX);
    try {
      this.deps.fs.writeAtomic(this.paths.ownSubmissionsPath, JSON.stringify({ version: 1, ids: this.ownSubmissions }));
    } catch { /* attribution is best-effort; delivery is not affected */ }
  }

  /** The outbox's onAck hook: pda admitted a message. */
  private onAck(submissionId: string): void {
    this.recordOwn(submissionId);
    const shown = submissionId.length > 80 ? `${submissionId.slice(0, 80)}…` : submissionId;
    this.pane.line(`[pda-runner] queued (submission ${shown})`);
    this.pane.endBatch();
  }

  // ── Delivery ──

  private kick(): void {
    const attach = this.attachAbort;
    if (!attach || attach.signal.aborted) return; // detached: the next attach replays
    if (this.pumping) { this.pumpAgain = true; return; }
    this.pumping = true;
    const signal = attach.signal;
    void (async () => {
      try {
        do {
          this.pumpAgain = false;
          await this.deps.outbox.drain(this.deps.client, {
            signal, sleep: this.sleep, onOutcome: (outcome) => this.onOutcome(outcome),
          });
        } while (this.pumpAgain && !signal.aborted);
      } catch {
        this.pane.line(`${PDA_RUNNER_ERROR_MARKER} internal (delivery)`);
        this.pane.endBatch();
      } finally {
        this.pumping = false;
        this.writeSidecar();
        if (this.pumpAgain) this.kick(); // work arrived while a detached pump was winding down
      }
    })();
  }

  private onOutcome(outcome: PdaAttemptOutcome): void {
    switch (outcome.kind) {
      case "transient":
        if (outcome.reason === "unreachable" && this.shouldNotice("post:unreachable")) {
          this.pane.line("[pda-runner] held: pda unreachable; the message is saved and will be sent when it returns");
        } else if (outcome.reason === "token" && this.shouldNotice("post:token")) {
          this.error = { code: "pda_token_format", at: this.stamp() };
          this.pane.line(`${PDA_RUNNER_ERROR_MARKER} pda_token_format: the token file is not usable; retrying`);
        } else if (outcome.reason === "server_error" || outcome.reason === "protocol") {
          this.pane.line(`[pda-runner] pda did not take the message (${outcome.status ?? "protocol"}); retry ${outcome.attempts}/${HELD_MAX_ATTEMPTS}`);
        }
        break;
      case "held":
        this.pane.line(`${PDA_RUNNER_ERROR_MARKER} ${outcome.code}: ${HELD_TEXT[outcome.code]}; later messages wait behind it. Resolve with: rig seat pda-release`);
        break;
      case "rejected": {
        const detail = outcome.detail ? ` ${outcome.detail}` : "";
        this.pane.line(`${PDA_RUNNER_ERROR_MARKER} not delivered: ${outcome.status}${detail}`);
        break;
      }
      default: break;
    }
    this.pane.endBatch();
    this.writeSidecar();
  }

  // ── Control file and alive tick ──

  private tick(): void {
    try {
      this.writeSidecar();
      this.pollRelease();
    } catch { /* a tick must never take the seat down */ }
  }

  /** `release.request` is a signal, not a document: its existence asks for one release of the held head. It
   *  is removed BEFORE the release is applied, so a crash between the two can never release a later message. */
  private pollRelease(): void {
    const file = this.paths.releaseRequestPath;
    const st = this.deps.fs.stat(file);
    if (!st) return;
    this.deps.fs.remove(file);
    if (!st.isFile || st.size > 4096) return;
    const released = this.deps.outbox.release();
    this.pane.line(released
      ? "[pda-runner] release requested: retrying the held message"
      : "[pda-runner] release requested, but no message is held");
    this.pane.endBatch();
    this.writeSidecar();
    if (released) this.kick();
  }

  // ── Activity ──

  private postActivity(hookEvent: string, subtype: string | null): void {
    const safeSubtype = subtype === null ? null : sanitizeForPane(subtype).slice(0, 64);
    try {
      this.deps.postActivity({
        sessionName: this.deps.args.sessionName,
        nodeId: this.deps.nodeId,
        generation: this.deps.generation,
        runtime: PDA_RUNTIME,
        hookEvent,
        subtype: safeSubtype,
        occurredAt: this.stamp(),
      });
    } catch { /* best-effort */ }
  }

  // ── Sidecar ──

  private stamp(): string { return this.now().toISOString(); }

  private loadPriorCursor(): void {
    try {
      const text = this.deps.fs.readText(this.paths.runnerStatePath);
      const prior = text === null ? null : parsePdaRunnerState(text);
      const b = this.deps.args.binding;
      if (prior && prior.agent === b.agent && prior.baseUrl === b.baseUrl && prior.lastEntryId) this.lastEntryId = prior.lastEntryId;
    } catch { /* an unreadable prior sidecar is absent */ }
  }

  private writeSidecar(): void {
    const snap = this.deps.outbox.snapshot();
    const at = this.stamp();
    const error = this.error ?? (snap.setAside > 0 ? { code: "pda_outbox_binding_mismatch" as const, at } : null);
    const state: PdaRunnerState = {
      ready: this.ready,
      launchId: this.deps.args.launchId,
      updatedAt: at,
      aliveAt: at,
      agent: this.deps.args.binding.agent,
      baseUrl: this.deps.args.binding.baseUrl,
      connected: this.connected,
      busy: this.busy,
      ...(this.lastEntryId !== undefined ? { lastEntryId: this.lastEntryId } : {}),
      outboxPending: snap.pending,
      ...(snap.held ? { held: snap.held } : {}),
      ...(snap.setAside > 0 ? { setAside: snap.setAside } : {}),
      ...(error ? { error } : {}),
      ...(this.exited ? { exited: this.exited } : {}),
    };
    try {
      this.deps.fs.writeAtomic(this.paths.runnerStatePath, JSON.stringify(state));
    } catch { /* best-effort: a reader that cannot read the sidecar has no runner answer */ }
  }
}

// ── Process-level fatal handlers ─────────────────────────────────────────────

/** A short code for an unexpected failure, or "unexpected". Never the message, cause or stack. */
export function fatalLabel(err: unknown): string {
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,39}$/.test(code) ? code : "unexpected";
}

export interface FatalProcess {
  on(event: "uncaughtException" | "unhandledRejection", listener: (reason: unknown) => void): unknown;
  exit(code: number): never | void;
}

/** Node's default handlers print the stack and message, and either can carry a header value (the measured
 *  `Headers` echo). These print a code and exit 70. */
export function installPdaRunnerFatalHandlers(proc: FatalProcess, onFatal: (label: string) => number): void {
  const handle = (reason: unknown): void => {
    let code = 70;
    try { code = onFatal(fatalLabel(reason)); } catch { /* still exit */ }
    proc.exit(code);
  };
  proc.on("uncaughtException", handle);
  proc.on("unhandledRejection", handle);
}

// ── Input wiring ─────────────────────────────────────────────────────────────

/** The shared editor in pda mode: a paste is content (ETX included), Ctrl-C clears the line, Enter after a
 *  paste is one message. There is no slash command and no prefix handler. */
export function wirePdaRunnerInput(runner: Pick<PdaRunner, "submit" | "interrupted">, input: NodeJS.ReadStream, output: NodeJS.WriteStream) {
  return createRunnerInput(input, output, (block) => runner.submit(block), {
    label: PDA_RUNNER_LABEL,
    interruptInsidePaste: "content",
    onInterrupt: () => runner.interrupted(),
  });
}

// ── Activity poster (real) ───────────────────────────────────────────────────

/** Posts in order, one at a time, each with a 1.5 s budget; a failure is dropped. A bounded backlog keeps a
 *  dead daemon from growing memory: past the bound new posts are dropped. */
export function createActivityPoster(
  endpoint: { baseUrl: string; token: string } | null,
  fetchImpl: typeof fetch = globalThis.fetch,
): (payload: Record<string, unknown>) => void {
  if (!endpoint || typeof fetchImpl !== "function") return () => undefined;
  const url = new URL("/api/activity/hooks", endpoint.baseUrl).toString();
  let chain: Promise<void> = Promise.resolve();
  let queued = 0;
  return (payload) => {
    if (queued >= 100) return;
    queued += 1;
    chain = chain.then(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      try {
        const res = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${endpoint.token}` },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        await res.body?.cancel().catch(() => undefined);
      } catch { /* best-effort */ } finally { clearTimeout(timer); queued -= 1; }
    });
  };
}

// ── main ─────────────────────────────────────────────────────────────────────

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parsePdaRunnerArgv(argv);
  if (!parsed.ok) {
    console.error(`${PDA_RUNNER_ERROR_MARKER} ${parsed.code}: ${parsed.reason}`);
    process.exitCode = 2;
    return;
  }
  const { args } = parsed;
  const paths = pdaSeatPaths(args.stateRoot, args.sessionName);
  fs.mkdirSync(paths.seatRoot, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(paths.seatRoot, 0o700); } catch { /* not ours to change */ }

  const endpoint = resolveActivityEndpoint(process.env);
  const hookToken = endpoint?.token ?? process.env.OPENRIG_ACTIVITY_HOOK_TOKEN?.trim() ?? "";
  const nodeId = process.env.OPENRIG_NODE_ID?.trim() || args.sessionName;
  const generation = process.env.OPENRIG_OCCUPANT_GENERATION?.trim() || null;

  // Every bearer value this process has read stays in the redaction list for its lifetime (a rotated token's
  // predecessor may still be in output the agent already produced).
  const bearers = new Set<string>();
  const baseSource = pdaTokenSourceFromFile(args.tokenFile);
  const trackedSource = (): PdaTokenReadResult => {
    const read = baseSource();
    if (read.ok) bearers.add(read.token);
    return read;
  };
  const secrets = (): PdaSecret[] => [
    ...[...bearers].map((value) => ({ value, marker: PDA_TOKEN_MARKER })),
    ...(hookToken.length > 0 ? [{ value: hookToken, marker: HOOK_TOKEN_MARKER }] : []),
  ];

  const client = createPdaClient({ binding: args.binding, readToken: trackedSource, redact: hookToken ? [hookToken] : [] });
  const outbox = PdaOutbox.open({ paths, binding: args.binding, nodeId, launchId: args.launchId });
  const runner = new PdaRunner({
    args, nodeId, generation, client, outbox,
    readToken: trackedSource, secrets,
    write: (text) => { process.stdout.write(text); },
    postActivity: createActivityPoster(endpoint),
    fs: nodeRunnerFs,
    usage: args.usageFacts ? stubUsageSink : undefined,
  });

  installPdaRunnerFatalHandlers(process, (label) => runner.fatal(label));
  for (const signal of ["SIGTERM", "SIGHUP"] as const) process.on(signal, () => runner.stop());

  const input = wirePdaRunnerInput(runner, process.stdin, process.stdout);
  input.once("close", () => runner.stop());
  const code = await runner.run();
  input.close();
  process.exitCode = code;
}

/** L2c fills this. Until then `--usage-facts` is accepted and does nothing. */
const stubUsageSink: PdaUsageSink = {};

// Compiled-entry guard, as the Pi runner: run main() only when executed directly, not when imported by tests.
const invokedDirectly = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    return import.meta.url === pathToFileURL(nodePath.resolve(entry)).href;
  } catch { return false; }
})();
if (invokedDirectly) void main();

