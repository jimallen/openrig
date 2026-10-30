// Native comms step 3 (design-native-comms-20261030 §8 and §8.1): deliver daemon and agent-to-agent messages into a
// Claude Code seat through the seat's own cross-session inbox socket, with tmux paste kept as the host and the fallback.
//
// What is measured (scratch sessions, claude 2.1.311/2.1.314, Linux and macOS; §8):
//  - the inbox takes `{"type":"user","message":{"role":"user","content":<text>}}` lines; it replies with nothing;
//  - a bypass-permissions seat HOLDS such a message behind a picker unless its launch-flag settings say
//    `"crossSessionInbound":"accept"` (a local settings file is ignored);
//  - the token restricts nothing (a wrong one is accepted) and the auth line is optional: the boundary is the uid, as
//    with tmux. No token is stored or sent here;
//  - a queued message is taken at the seat's next boundary (idle: at once; mid-tool: after the tool; at a permission
//    prompt: after the answer) and its text arrives as the UserPromptSubmit `prompt`;
//  - a UserPromptSubmit hook that answers `decision: block` suppresses a socket-injected copy cleanly.
//
// Delivery is confirmed ONLY by the receiver's UserPromptSubmit hook echoing the row's marker (`ack`), or, when that
// ack was lost, by the marker found in the seat's transcript file. A row falls back to tmux only after a proven
// non-take (a later boundary, no ack, no marker in the transcript). See `sweep`.
import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import type { OutboxEntry, OutboxHandler } from "./outbox-handler.js";
import { nameEnvelope } from "./native-name-envelope.js";

/** The marker line appended to a native message. `<id>` is the outbox row, `<nonce>` a per-row secret the sender never sees. */
export const NATIVE_MARKER_RE = /\[openrig-msg ([A-Za-z0-9._:-]+):([a-f0-9]{16,64})\]/g;
export function nativeMarker(outboxId: string, nonce: string): string {
  return `[openrig-msg ${outboxId}:${nonce}]`;
}
/** Every marker in a prompt, in order. */
export function parseNativeMarkers(prompt: string): Array<{ id: string; nonce: string }> {
  return [...prompt.matchAll(NATIVE_MARKER_RE)].map((m) => ({ id: m[1]!, nonce: m[2]! }));
}

/** The literal the inject-format probe looks for in a claude binary: the user-message line its own help prints. */
export const INJECT_FORMAT_LITERAL = '{"type":"user","message":{"role":"user","content":';
/** The setting a seat's running claude must carry in its argv for native delivery (launch-flag scope, §8 P3/P10). */
export const ACCEPT_SETTING_ARGV_FRAGMENT = '"crossSessionInbound":"accept"';

export interface NativeEndpointRow {
  node_id: string;
  session_name: string | null;
  generation: string | null;
  socket_path: string | null;
  transcript_path: string | null;
  claude_pid: number | null;
  exec_path: string | null;
  claude_version: string | null;
  probe_result: string | null;
  /** ncomms-3d: 1 when the binary parses the sender-name envelope (the launch probe found its parser literal). */
  name_envelope?: number | null;
  registered_at: string;
}

export interface ProcessRow { pid: number; ppid: number; args: string }

/** OS and tmux access, injected so tests never reach a live seat, socket or process. */
export interface NativeInboxDeps {
  db: Database.Database;
  outbox: OutboxHandler;
  /** `transport.native_claude`; read at each decision, so the setting takes effect without a restart. */
  enabled: () => boolean;
  /** The pid of the seat's pane process (its shell or claude), or null. */
  panePid: (sessionName: string) => Promise<number | null>;
  listProcesses: () => Promise<ProcessRow[]>;
  socketExists: (path: string) => boolean;
  /** Writes the lines to the socket. `none`: no byte left; `all`: every byte flushed; `partial`: unknown. */
  write: (socketPath: string, lines: unknown[]) => Promise<"none" | "all" | "partial">;
  /** Whether the file contains `needle` (a plain substring search; false when unreadable). */
  fileIncludes: (path: string, needle: string) => boolean;
  /** Probe a claude binary: version and whether its inject-format literal is present, plus whether the file changed
   *  after the process started (then the running version is unknown). ncomms-3d: `nameEnvelope`, whether its
   *  sender-name envelope parser is present (absent: plain content). */
  probeBinary: (execPath: string, pid: number) => Promise<{ version: string | null; literal: boolean; replacedSinceStart: boolean; nameEnvelope?: boolean }>;
  /** ncomms-3c: the executable a running claude was started from, found from its pid (null when it cannot be found, or
   *  the file was replaced since: then the running version is unknown). A hook's environment carries CLAUDE_PID but
   *  not CLAUDE_CODE_EXECPATH (measured on claude 2.1.314, Linux and macOS), so the relay cannot report the binary. */
  resolveExecPath?: (pid: number) => Promise<string | null>;
  /** The node's live occupant generation, or null when unknown. */
  liveGeneration: (nodeId: string) => string | null;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** How long a send waits for the ack before returning unconfirmed (default 1.5 s; an idle seat acked in 48 ms, measured). */
  ackWindowMs?: number;
  /** Past this age an unacked row is checked for a proven non-take. */
  deadlineMs?: number;
  /** Past this age a row with no boundary since its write is dead-lettered (indeterminate), never re-sent. */
  hardDeadlineMs?: number;
  /** Called after a native row settles (review F3 and the R3 sender notice): the queue records the outcome on the
   *  row's qitem, and the sender is told when the outcome is not a delivery. Errors are the callback's own. */
  onSettled?: (row: OutboxEntry, outcome: NativeSettlement) => void;
}

/** How a native row settled: `delivered` (hook ack or transcript), `unconfirmed` (indeterminate: hard deadline or a
 *  partial write; never re-sent), or `failing_over` (no take proven; the tmux fallback follows). */
export interface NativeSettlement { kind: "delivered" | "unconfirmed" | "failing_over"; evidence: string; detail: string | null }

export type NativeEligibility =
  | { ok: true; nodeId: string; endpoint: NativeEndpointRow }
  | { ok: false; reason: string };

export interface NativeDeliverResult {
  /** `fallback`: nothing was written, use tmux. `written`: the rows are native, acked or pending. `pending`: the id is
   *  already a native write awaiting its ack, so nothing was written again (review F2: a repeat coalesces). */
  kind: "fallback" | "written" | "pending";
  reason?: string;
  outboxIds: string[];
  acked: boolean;
  /** `partial`: the write may or may not have landed; the rows are indeterminate and are never re-sent. */
  write?: "all" | "partial";
}

export interface NativeFallback { outboxId: string; sessionName: string; senderSession: string; body: string; auditPointer: string | null; wake: boolean }

const AGENT_RUNTIMES = new Set(["claude-code", "codex", "pi", "pda", "omp", "stub"]);

function newNonce(): string { return randomBytes(12).toString("hex"); }

export class ClaudeNativeInbox {
  private readonly waiters = new Map<string, () => void>();
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly ackWindowMs: number;
  readonly deadlineMs: number;
  readonly hardDeadlineMs: number;

  constructor(private readonly deps: NativeInboxDeps) {
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    // ncomms-3c: 1.5 s (an idle seat acked in about 50 ms, measured end to end), so a native send stays well inside the
    // CLI's 5 s request timeout together with the eligibility checks.
    this.ackWindowMs = deps.ackWindowMs ?? 1_500;
    this.deadlineMs = deps.deadlineMs ?? 120_000;
    this.hardDeadlineMs = deps.hardDeadlineMs ?? 30 * 60_000;
  }

  private hasTables(): boolean {
    return this.deps.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='seat_native_endpoints'").get() !== undefined;
  }

  /** SessionStart: the relay reports the seat's socket, transcript and claude pid. The binary is found from the pid and
   *  probed here, at the launch of the process (criterion 2); the result is recorded with the version. A binary the
   *  relay reports is used only when the pid gives none (no current Claude Code puts it in a hook's environment). */
  async registerEndpoint(input: { nodeId: string; sessionName: string; generation: string | null; socketPath: string; transcriptPath: string | null; claudePid: number | null; execPath: string | null }): Promise<NativeEndpointRow | null> {
    if (!this.hasTables()) return null;
    let version: string | null = null;
    let probe = input.claudePid ? "fail:exec_path_unresolved" : "fail:no_claude_pid";
    let execPath: string | null = null;
    let envelope = false;
    if (input.claudePid) {
      try { execPath = (await this.deps.resolveExecPath?.(input.claudePid)) ?? input.execPath; } catch { execPath = input.execPath; }
    }
    if (execPath && input.claudePid) {
      try {
        const p = await this.deps.probeBinary(execPath, input.claudePid);
        version = p.version;
        probe = !p.version ? "fail:version_unknown" : p.replacedSinceStart ? "fail:binary_replaced_since_start"
          : !p.literal ? "fail:inject_format_absent" : "pass";
        envelope = probe === "pass" && p.nameEnvelope === true;
      } catch {
        probe = "fail:probe_error";
      }
    }
    const row: NativeEndpointRow = {
      node_id: input.nodeId, session_name: input.sessionName, generation: input.generation, socket_path: input.socketPath,
      transcript_path: input.transcriptPath, claude_pid: input.claudePid, exec_path: execPath, claude_version: version,
      probe_result: probe, name_envelope: envelope ? 1 : 0, registered_at: this.now().toISOString(),
    };
    this.deps.db.prepare(`INSERT INTO seat_native_endpoints (node_id, session_name, generation, socket_path, transcript_path, claude_pid, exec_path, claude_version, probe_result, name_envelope, registered_at)
      VALUES (@node_id, @session_name, @generation, @socket_path, @transcript_path, @claude_pid, @exec_path, @claude_version, @probe_result, @name_envelope, @registered_at)
      ON CONFLICT(node_id) DO UPDATE SET session_name=excluded.session_name, generation=excluded.generation, socket_path=excluded.socket_path,
        transcript_path=excluded.transcript_path, claude_pid=excluded.claude_pid, exec_path=excluded.exec_path, claude_version=excluded.claude_version,
        probe_result=excluded.probe_result, name_envelope=excluded.name_envelope, registered_at=excluded.registered_at`).run(row);
    return row;
  }

  endpointFor(nodeId: string): NativeEndpointRow | null {
    if (!this.hasTables()) return null;
    return (this.deps.db.prepare("SELECT * FROM seat_native_endpoints WHERE node_id = ?").get(nodeId) as NativeEndpointRow | undefined) ?? null;
  }

  /** The current node and runtime a running session name answers to, or null. */
  private seatOf(sessionName: string): { nodeId: string; runtime: string | null } | null {
    const row = this.deps.db.prepare(`SELECT s.node_id AS nodeId, n.runtime AS runtime FROM sessions s JOIN nodes n ON n.id = s.node_id
      WHERE s.session_name = ? AND s.status = 'running' ORDER BY s.created_at DESC, s.id DESC LIMIT 1`).get(sessionName) as { nodeId: string; runtime: string | null } | undefined;
    return row ?? null;
  }

  /** Criterion 5: only daemon and agent-to-agent messages go native. The daemon's own identities (`<name>@system`,
   *  `daemon@kernel`) and managed agent seats qualify; a human, terminal seat, unregistered or unnamed sender stays on
   *  tmux, because a native message reaches the model framed as a peer message. */
  isNativeSender(senderSession: string | null | undefined): boolean {
    if (!senderSession || senderSession === "unknown") return false;
    if (/^[a-z][a-z0-9-]*@system$/.test(senderSession) || senderSession === "daemon@kernel") return true;
    const seat = this.seatOf(senderSession);
    return !!seat && !!seat.runtime && AGENT_RUNTIMES.has(seat.runtime);
  }

  /** Criteria 1, 2, 4, 5 and R5/R6: every condition must hold, or the message uses tmux. Each refusal names its reason. */
  async eligibility(sessionName: string, senderSession: string | null | undefined): Promise<NativeEligibility> {
    if (!this.deps.enabled()) return { ok: false, reason: "native_disabled" };
    if (!this.hasTables()) return { ok: false, reason: "native_schema_absent" };
    if (!this.isNativeSender(senderSession)) return { ok: false, reason: "sender_not_native" };
    const seat = this.seatOf(sessionName);
    if (!seat) return { ok: false, reason: "seat_not_running" };
    if (seat.runtime !== "claude-code") return { ok: false, reason: "runtime_not_claude" };
    const endpoint = this.endpointFor(seat.nodeId);
    if (!endpoint || !endpoint.socket_path || !endpoint.claude_pid) return { ok: false, reason: "no_endpoint" };
    if (endpoint.session_name !== sessionName) return { ok: false, reason: "endpoint_session_mismatch" };
    if (endpoint.probe_result !== "pass") return { ok: false, reason: `probe_${endpoint.probe_result ?? "missing"}` };
    const live = this.deps.liveGeneration(seat.nodeId);
    if (live !== null && endpoint.generation !== null && live !== endpoint.generation) return { ok: false, reason: "endpoint_generation_stale" };
    if (!this.deps.socketExists(endpoint.socket_path)) return { ok: false, reason: "socket_missing" };
    // Review N5: Claude names its inbox `<pid>.sock` (measured: /tmp/cc-socks/<pid>.sock, /run/user/<uid>/cc-socks/<pid>.sock).
    const socketPid = /(?:^|\/)(\d+)\.sock$/.exec(endpoint.socket_path)?.[1];
    if (socketPid !== undefined && Number(socketPid) !== endpoint.claude_pid) return { ok: false, reason: "socket_pid_mismatch" };
    const panePid = await this.deps.panePid(sessionName);
    if (!panePid) return { ok: false, reason: "pane_pid_unknown" };
    const procs = await this.deps.listProcesses();
    const byPid = new Map(procs.map((p) => [p.pid, p]));
    const claude = byPid.get(endpoint.claude_pid);
    if (!claude) return { ok: false, reason: "claude_pid_dead" };
    let cursor: ProcessRow | undefined = claude;
    let descends = false;
    for (let hops = 0; cursor && hops < 32; hops++) {
      if (cursor.pid === panePid) { descends = true; break; }
      cursor = byPid.get(cursor.ppid);
    }
    if (!descends) return { ok: false, reason: "claude_not_in_seat_pane" };
    if (!claude.args.includes(ACCEPT_SETTING_ARGV_FRAGMENT)) return { ok: false, reason: "seat_lacks_accept_setting" };
    return { ok: true, nodeId: seat.nodeId, endpoint };
  }

  /** Writes one message natively. Its rows are created (plain send) or adopted (committed wake rows) and claimed
   *  BEFORE the write (R1). Nothing written: the claim is released and the caller uses tmux. */
  async deliver(input: {
    sessionName: string; senderSession: string; text: string; endpoint: NativeEndpointRow;
    committedOutboxIds?: string[]; deliveryId?: string; auditPointer?: string | null; identityProvenance?: string | null;
  }): Promise<NativeDeliverResult> {
    const writtenAt = this.now().toISOString();
    const transcript = input.endpoint.transcript_path ?? null;
    // Review F2: a caller's fixed id (a queue nudge, a watchdog occurrence) repeated while its native write still awaits
    // its ack coalesces onto it: nothing is written again and nothing goes through tmux.
    if (!input.committedOutboxIds && input.deliveryId && this.deps.outbox.isNativePending(input.deliveryId)) {
      return { kind: "pending", outboxIds: [input.deliveryId], acked: false };
    }
    const claimed: Array<{ id: string; nonce: string; created: boolean }> = [];
    this.deps.db.transaction(() => {
      const ids = input.committedOutboxIds ?? [input.deliveryId ?? null];
      for (const given of ids) {
        const nonce = newNonce();
        if (given && this.deps.outbox.getById(given)) {
          if (this.deps.outbox.claimNative(given, nonce, writtenAt, transcript)) {
            claimed.push({ id: given, nonce, created: false });
            continue;
          }
          // A committed wake row must be claimable: the drain claimed it for this send. A held (retained) or retired id
          // keeps today's path, whose readback answers "retained" without sending.
          const prior = this.deps.outbox.getById(given)!.deliveryState;
          if (input.committedOutboxIds || !["delivered", "failed", "indeterminate"].includes(prior)) throw new Error(`native: row ${given} is not claimable`);
          // Review F2: a repeat of an id that already settled is a new attempt, with its own row.
          const attempt = this.deps.outbox.nextAttemptId(given);
          const entry = this.deps.outbox.record({ outboxId: attempt, senderSession: input.senderSession, destinationSession: input.sessionName,
            body: input.text, auditPointer: input.auditPointer ?? undefined, identityProvenance: input.identityProvenance ?? null });
          if (!this.deps.outbox.claimNative(entry.outboxId, nonce, writtenAt, transcript)) throw new Error(`native: new row ${entry.outboxId} not claimable`);
          claimed.push({ id: entry.outboxId, nonce, created: true });
        } else {
          const entry = this.deps.outbox.record({ ...(given ? { outboxId: given } : {}), senderSession: input.senderSession,
            destinationSession: input.sessionName, body: input.text, auditPointer: input.auditPointer ?? undefined,
            identityProvenance: input.identityProvenance ?? null });
          if (!this.deps.outbox.claimNative(entry.outboxId, nonce, writtenAt, transcript)) throw new Error(`native: new row ${entry.outboxId} not claimable`);
          claimed.push({ id: entry.outboxId, nonce, created: true });
        }
      }
    })();
    const markers = claimed.map((c) => nativeMarker(c.id, c.nonce)).join("\n");
    const plain = `${input.text}\n\n${markers}`;
    // ncomms-3d: the sender's seat name, so Claude Code labels the message with it instead of "unknown".
    const content = (input.endpoint.name_envelope === 1 ? nameEnvelope(input.senderSession, plain) : null) ?? plain;
    const acks = claimed.map((c) => new Promise<void>((resolve) => this.waiters.set(c.id, resolve)));
    const written = await this.deps.write(input.endpoint.socket_path!, [{ type: "user", message: { role: "user", content } }]);
    if (written === "none") {
      for (const c of claimed) this.waiters.delete(c.id);
      this.deps.db.transaction(() => { for (const c of claimed) this.deps.outbox.releaseNativeClaim(c.id, c.created); })();
      return { kind: "fallback", reason: "socket_write_failed", outboxIds: [], acked: false };
    }
    if (written === "partial") {
      for (const c of claimed) {
        this.waiters.delete(c.id);
        if (this.deps.outbox.settleNative(c.id, "indeterminate", { path: "native", evidence: "native_unconfirmed", detail: "write_partial" })) {
          this.notify(c.id, { kind: "unconfirmed", evidence: "native_unconfirmed", detail: "write_partial" });
        }
      }
      return { kind: "written", write: "partial", outboxIds: claimed.map((c) => c.id), acked: false };
    }
    const all = Promise.all(acks).then(() => true);
    const acked = await Promise.race([all, this.sleep(this.ackWindowMs).then(() => false)]);
    for (const c of claimed) this.waiters.delete(c.id);
    return { kind: "written", write: "all", outboxIds: claimed.map((c) => c.id), acked };
  }

  /** UserPromptSubmit with markers (R2, R4): each marker whose id and nonce match a native row in `sending`, addressed
   *  to the hooking seat, settles it delivered. `block` is true only when the prompt carries markers and EVERY one names
   *  a row already settled delivered by other means: then the copy is a late duplicate. */
  ack(input: { nodeId: string; sessionName: string; markers: Array<{ id: string; nonce: string }>; promptId?: string | null }): { acked: string[]; block: boolean } {
    const acked: string[] = [];
    let duplicates = 0;
    for (const m of input.markers) {
      const wasPending = this.deps.outbox.getById(m.id)?.deliveryState;
      const r = this.deps.outbox.ackNative(m.id, m.nonce, input.sessionName, input.promptId ?? null);
      if (r === "acked") {
        acked.push(m.id);
        this.waiters.get(m.id)?.();
        if (wasPending !== "delivered") this.notify(m.id, { kind: "delivered", evidence: "native_hook_delivered", detail: null });
      } else if (r === "already_delivered") {
        duplicates++;
      }
    }
    return { acked, block: input.markers.length > 0 && duplicates === input.markers.length };
  }

  /** The deadline rule (R3). For each native row still `sending`: past the deadline, a boundary since the write (a Stop
   *  or a UserPromptSubmit; the row's own would have acked it) means the seat moved past it. Then the transcript is
   *  searched for the marker: found, the ack was lost and the row is delivered; absent, the row was not taken and is
   *  returned for the tmux path. No boundary by the hard deadline: indeterminate, never re-sent. */
  sweep(): { fallbacks: NativeFallback[]; settled: Array<{ outboxId: string; state: string; evidence: string }> } {
    const fallbacks: NativeFallback[] = [];
    const settled: Array<{ outboxId: string; state: string; evidence: string }> = [];
    if (!this.hasTables()) return { fallbacks, settled };
    const now = this.now().getTime();
    for (const row of this.deps.outbox.listNativePending()) {
      const writtenAt = Date.parse(row.nativeWrittenAt ?? "");
      if (!Number.isFinite(writtenAt) || now - writtenAt < this.deadlineMs) continue;
      const seat = this.seatOf(row.destinationSession);
      const endpoint = seat ? this.endpointFor(seat.nodeId) : null;
      const boundary = seat ? this.boundarySince(seat.nodeId, row.nativeWrittenAt!) : false;
      if (boundary) {
        const marker = row.nativeNonce ? nativeMarker(row.outboxId, row.nativeNonce) : null;
        // Review N3: the transcript at write time, and the current one (a /clear moves the seat to a new file).
        const transcripts = [...new Set([row.nativeTranscriptPath, endpoint?.transcript_path].filter((p): p is string => !!p))];
        if (marker && transcripts.some((p) => this.deps.fileIncludes(p, marker))) {
          if (this.deps.outbox.settleNative(row.outboxId, "delivered", { path: "native", evidence: "native_transcript" })) {
            this.notify(row.outboxId, { kind: "delivered", evidence: "native_transcript", detail: null });
          }
          settled.push({ outboxId: row.outboxId, state: "delivered", evidence: "native_transcript" });
          continue;
        }
        this.deps.outbox.settleNative(row.outboxId, "failed", { path: "native", evidence: "native_unconfirmed", detail: "boundary_without_ack" });
        this.notify(row.outboxId, { kind: "failing_over", evidence: "native_unconfirmed", detail: "boundary_without_ack" });
        settled.push({ outboxId: row.outboxId, state: "failed", evidence: "native_unconfirmed" });
        fallbacks.push({ outboxId: row.outboxId, sessionName: row.destinationSession, senderSession: row.senderSession, body: row.body,
          auditPointer: row.auditPointer, wake: row.outboxId.startsWith("wake-intent-") });
        continue;
      }
      if (now - writtenAt >= this.hardDeadlineMs) {
        if (this.deps.outbox.settleNative(row.outboxId, "indeterminate", { path: "native", evidence: "native_unconfirmed", detail: "no_boundary_by_hard_deadline" })) {
          this.notify(row.outboxId, { kind: "unconfirmed", evidence: "native_unconfirmed", detail: "no_boundary_by_hard_deadline" });
        }
        settled.push({ outboxId: row.outboxId, state: "indeterminate", evidence: "native_unconfirmed" });
      }
    }
    return { fallbacks, settled };
  }

  private notify(outboxId: string, outcome: NativeSettlement): void {
    if (!this.deps.onSettled) return;
    const row = this.deps.outbox.getById(outboxId);
    if (!row) return;
    try { this.deps.onSettled(row, outcome); } catch { /* a notice that fails never undoes a settlement */ }
  }

  /** A Stop or a UserPromptSubmit recorded for the node with an eventAt after `since`. */
  private boundarySince(nodeId: string, since: string): boolean {
    const row = this.deps.db.prepare(`SELECT 1 FROM events WHERE node_id = ? AND type = 'agent.activity'
      AND json_extract(payload, '$.activity.rawEvent') IN ('Stop', 'UserPromptSubmit')
      AND json_extract(payload, '$.activity.eventAt') > ? LIMIT 1`).get(nodeId, since);
    return row !== undefined;
  }
}
