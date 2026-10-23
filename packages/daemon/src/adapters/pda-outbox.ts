// pda runtime L1a (pda-runtime-design-9l Rev 2, "The outbox: outbox.log, A1 and A2"): the pda-runner's durable
// outbox. One message a person sends to a pda seat becomes one `enq` record, fsync'd BEFORE anything is
// posted, and is replayed under its original requestId until pda admits it.
//
// Delivery semantics, stated honestly:
//   - Before the `enq` fsync returns, a crash loses the message (at most once). `rig send` may already have
//     reported "landed"; that window is the caller's line editor plus one fsync.
//   - After it, every crash point replays the record under the SAME requestId, and pda admits a
//     (conversation, requestId) once (exactly once). A crash between pda's 2xx and our `ack` append replays
//     and pda answers with the same submissionId.
//
// The log is append-only JSON lines (the L0 `PdaOutboxRecord` union), each followed by fsync(fd):
//   enq     the content, scoped to {agent, baseUrl} (A1)
//   ack     pda admitted it
//   hold    the head cannot be delivered and needs a person (never dropped, never skipped, A2)
//   reject  a definitive 4xx about the content; kept in rejected.log, never silently lost
//   release written only by an operator's release (or a reconnect after a pda restart, in memory only)
// A record is pending if it has an `enq` and no `ack` or `reject`. A torn last line (a crash mid-append) is
// ignored. Compaction is an atomic rewrite: tmp file, fsync, rename over, fsync the directory.
//
// A1: a record is eligible for this outbox only when its {agent, baseUrl} equal the binding it was opened
// for. Others are SET ASIDE: never posted, never dropped, and they do not block this binding's queue.
//
// Nothing here prints. Errors the caller needs are returned as codes.

import fs from "node:fs";
import nodePath from "node:path";
import {
  pdaRequestId, type PdaBinding, type PdaHeldCode, type PdaOutboxRecord, type PdaSeatPaths,
} from "./pda-runner-protocol.js";
import { pdaBodyFits, serializePdaMessage, type PdaCallFailure, type PdaClient } from "./pda-client.js";

// ── Injectable file operations (tests order and interrupt them) ──────────────

export interface OutboxFs {
  mkdirPrivate(dir: string): void;
  /** The whole file as UTF-8, or null when it does not exist. */
  readFile(path: string): string | null;
  /** Open for write (create/truncate, or append) with mode 0600. */
  open(path: string, mode: "write" | "append"): number;
  write(fd: number, data: string): void;
  fsync(fd: number): void;
  close(fd: number): void;
  rename(from: string, to: string): void;
  fsyncDir(dir: string): void;
}

export const nodeOutboxFs: OutboxFs = {
  mkdirPrivate: (dir) => { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); },
  readFile: (path) => {
    try { return fs.readFileSync(path, "utf8"); } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  },
  open: (path, mode) => fs.openSync(path, mode === "append" ? "a" : "w", 0o600),
  write: (fd, data) => { fs.writeSync(fd, data); },
  fsync: (fd) => { fs.fsyncSync(fd); },
  close: (fd) => { fs.closeSync(fd); },
  rename: (from, to) => { fs.renameSync(from, to); },
  fsyncDir: (dir) => {
    const fd = fs.openSync(dir, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  },
};

// ── Constants from the design ────────────────────────────────────────────────

/** After this many 5xx (or protocol-failure) attempts on the same record, it is held. */
export const PDA_OUTBOX_MAX_SERVER_ATTEMPTS = 6;
/** Compact once acked and rejected records exceed this many. */
export const PDA_OUTBOX_COMPACT_THRESHOLD = 64;
export const PDA_OUTBOX_BACKOFF_START_MS = 500;
export const PDA_OUTBOX_BACKOFF_CAP_MS = 10_000;

// ── In-memory state, rebuilt from the log ────────────────────────────────────

type EnqRecord = Extract<PdaOutboxRecord, { op: "enq" }>;
type HoldRecord = Extract<PdaOutboxRecord, { op: "hold" }>;
type RejectRecord = Extract<PdaOutboxRecord, { op: "reject" }>;

interface Entry {
  enq: EnqRecord;
  acked: boolean;
  reject?: RejectRecord;
  hold?: HoldRecord;
}

const isStr = (v: unknown): v is string => typeof v === "string";

/** One line to a record, or null when it is torn or not a well-formed record. */
function parseRecord(line: string): PdaOutboxRecord | null {
  let v: unknown;
  try { v = JSON.parse(line); } catch { return null; }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (!isStr(r.requestId) || !isStr(r.at)) return null;
  switch (r.op) {
    case "enq": return isStr(r.agent) && isStr(r.baseUrl) && isStr(r.content) ? (r as unknown as PdaOutboxRecord) : null;
    case "ack": return isStr(r.submissionId) ? (r as unknown as PdaOutboxRecord) : null;
    case "hold": return isStr(r.code) && typeof r.attempts === "number" ? (r as unknown as PdaOutboxRecord) : null;
    case "reject": return typeof r.status === "number" && r.code === "pda_rejected" ? (r as unknown as PdaOutboxRecord) : null;
    case "release": return r as unknown as PdaOutboxRecord;
    default: return null;
  }
}

function replay(text: string | null): Map<string, Entry> {
  const entries = new Map<string, Entry>();
  if (!text) return entries;
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    const rec = parseRecord(line);
    if (!rec) continue; // a torn last line is ignored; so is any line that is not a record
    const e = entries.get(rec.requestId);
    switch (rec.op) {
      case "enq": if (!e) entries.set(rec.requestId, { enq: rec, acked: false }); break;
      case "ack": if (e) e.acked = true; break;
      case "reject": if (e) e.reject = rec; break;
      case "hold": if (e && !e.acked && !e.reject) e.hold = rec; break;
      case "release": if (e) e.hold = undefined; break;
    }
  }
  return entries;
}

const isPending = (e: Entry): boolean => !e.acked && !e.reject;

// ── The outbox ───────────────────────────────────────────────────────────────

export interface PdaOutboxOptions {
  paths: Pick<PdaSeatPaths, "seatRoot" | "outboxPath" | "rejectedPath">;
  binding: PdaBinding;
  nodeId: string;
  launchId: string;
  fs?: OutboxFs;
  now?: () => Date;
}

export type PdaEnqueueResult =
  | { ok: true; requestId: string }
  /** The serialised body cannot be sent. Nothing was written. */
  | { ok: false; reason: "too_large" };

export interface PdaOutboxSnapshot {
  /** Pending records for this binding (held included). */
  pending: number;
  /** Pending records for another binding (A1). */
  setAside: number;
  held: { requestId: string; code: PdaHeldCode; at: string } | null;
}

export type PdaAttemptOutcome =
  | { kind: "idle" }
  | { kind: "acked"; requestId: string; submissionId: string }
  /** Retry the same record with the same id. `attempts` counts 5xx/protocol failures so far. */
  | { kind: "transient"; reason: "unreachable" | "token" | "server_error" | "protocol"; status?: number; attempts: number }
  | { kind: "held"; requestId: string; code: PdaHeldCode; status?: number }
  /** The head was already held; nothing was attempted. */
  | { kind: "blocked"; requestId: string; code: PdaHeldCode }
  | { kind: "rejected"; requestId: string; status: number; detail?: string };

export interface PdaDrainOptions {
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  /** Called after every attempt; the runner turns outcomes into pane lines and sidecar updates. */
  onOutcome?: (outcome: PdaAttemptOutcome) => void;
}

export type PdaDrainEnd = "empty" | "held" | "aborted";

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });

export class PdaOutbox {
  private readonly paths: PdaOutboxOptions["paths"];
  private readonly binding: PdaBinding;
  private readonly nodeId: string;
  private readonly launchId: string;
  private readonly io: OutboxFs;
  private readonly now: () => Date;
  private entries: Map<string, Entry>;
  private readonly serverAttempts = new Map<string, number>();
  private nextSeq: number;
  /** Acks the runner has not yet been told about are reported through `onAck`. */
  onAck?: (requestId: string, submissionId: string) => void;

  private constructor(options: PdaOutboxOptions) {
    this.paths = options.paths;
    this.binding = { agent: options.binding.agent, baseUrl: options.binding.baseUrl };
    this.nodeId = options.nodeId;
    this.launchId = options.launchId;
    this.io = options.fs ?? nodeOutboxFs;
    this.now = options.now ?? (() => new Date());
    this.entries = new Map();
    this.nextSeq = 1;
  }

  /** Load the log (a torn last line is ignored) and compact it, which also guarantees the file exists with
   *  mode 0600 and its directory entry is durable. */
  static open(options: PdaOutboxOptions): PdaOutbox {
    const outbox = new PdaOutbox(options);
    outbox.io.mkdirPrivate(outbox.paths.seatRoot);
    outbox.entries = replay(outbox.io.readFile(outbox.paths.outboxPath));
    // A sequence number is never reused under one launch id, even after compaction dropped the acked record
    // that used it: it starts above both the log's highest and the wall clock in milliseconds.
    const prefix = `openrig/${outbox.nodeId}/${outbox.launchId}/`;
    let high = 0;
    for (const id of outbox.entries.keys()) {
      if (!id.startsWith(prefix)) continue;
      const n = Number(id.slice(prefix.length));
      if (Number.isSafeInteger(n) && n > high) high = n;
    }
    outbox.nextSeq = Math.max(high + 1, outbox.now().getTime());
    outbox.compact();
    return outbox;
  }

  // ── Reading state ──

  private eligible(): Entry[] {
    return [...this.entries.values()].filter((e) =>
      isPending(e) && e.enq.agent === this.binding.agent && e.enq.baseUrl === this.binding.baseUrl);
  }

  snapshot(): PdaOutboxSnapshot {
    const pending = [...this.entries.values()].filter(isPending);
    const eligible = this.eligible();
    const heldEntry = eligible.find((e) => e.hold !== undefined);
    return {
      pending: eligible.length,
      setAside: pending.length - eligible.length,
      held: heldEntry?.hold ? { requestId: heldEntry.enq.requestId, code: heldEntry.hold.code, at: heldEntry.hold.at } : null,
    };
  }

  // ── Durable appends ──

  private append(record: PdaOutboxRecord): void {
    const fd = this.io.open(this.paths.outboxPath, "append");
    try {
      this.io.write(fd, `${JSON.stringify(record)}\n`);
      this.io.fsync(fd);
    } finally {
      this.io.close(fd);
    }
  }

  private stamp(): string { return this.now().toISOString(); }

  /** Record one message to send. Durable (fsync'd) before this returns and before any POST of it. */
  enqueue(content: string): PdaEnqueueResult {
    const requestId = pdaRequestId(this.nodeId, this.launchId, this.nextSeq);
    if (!pdaBodyFits(serializePdaMessage({ content, requestId }))) return { ok: false, reason: "too_large" };
    this.nextSeq += 1;
    const enq: EnqRecord = { op: "enq", requestId, agent: this.binding.agent, baseUrl: this.binding.baseUrl, content, at: this.stamp() };
    this.append(enq);
    this.entries.set(requestId, { enq, acked: false });
    return { ok: true, requestId };
  }

  // ── Delivery ──

  /** One delivery attempt for the FIFO head of this binding's pending records. */
  async attempt(client: PdaClient): Promise<PdaAttemptOutcome> {
    if (client.binding.agent !== this.binding.agent || client.binding.baseUrl !== this.binding.baseUrl) {
      throw new RangeError("pda outbox: the client is bound to a different pda agent than this outbox");
    }
    const head = this.eligible()[0];
    if (!head) return { kind: "idle" };
    const id = head.enq.requestId;
    if (head.hold) return { kind: "blocked", requestId: id, code: head.hold.code };

    const result = await client.postMessage(serializePdaMessage({ content: head.enq.content, requestId: id }));
    if (result.ok) {
      this.append({ op: "ack", requestId: id, submissionId: result.value.submissionId, at: this.stamp() });
      head.acked = true;
      this.serverAttempts.delete(id);
      this.onAck?.(id, result.value.submissionId);
      this.compactIfNeeded();
      return { kind: "acked", requestId: id, submissionId: result.value.submissionId };
    }
    return this.afterFailure(head, result);
  }

  private afterFailure(head: Entry, f: PdaCallFailure): PdaAttemptOutcome {
    const id = head.enq.requestId;
    switch (f.kind) {
      case "unreachable":
        return { kind: "transient", reason: "unreachable", attempts: this.serverAttempts.get(id) ?? 0 };
      case "token":
        // The token file is unusable. The record stays pending and is retried; the runner reports the code.
        return { kind: "transient", reason: "token", attempts: this.serverAttempts.get(id) ?? 0 };
      case "too_large":
        return this.reject(head, 413, undefined);
      case "protocol":
        return this.boundedServerFailure(head, "protocol", f.status);
      case "http": {
        const s = f.status;
        if (s >= 500) return this.boundedServerFailure(head, "server_error", s);
        if (s === 401) return this.hold(head, "pda_unauthorized", s);
        if (s === 404) return this.hold(head, "pda_agent_missing", s);
        if (s === 400 || s === 413) return this.reject(head, s, f.detail);
        // 409 and every other 4xx are unexpected: the contract changed, so stop and ask a person.
        return this.hold(head, "pda_message_held", s);
      }
    }
  }

  private boundedServerFailure(head: Entry, reason: "server_error" | "protocol", status?: number): PdaAttemptOutcome {
    const id = head.enq.requestId;
    const attempts = (this.serverAttempts.get(id) ?? 0) + 1;
    this.serverAttempts.set(id, attempts);
    if (attempts >= PDA_OUTBOX_MAX_SERVER_ATTEMPTS) return this.hold(head, "pda_message_held", status, attempts);
    return { kind: "transient", reason, ...(status === undefined ? {} : { status }), attempts };
  }

  private hold(head: Entry, code: PdaHeldCode, status?: number, attempts?: number): PdaAttemptOutcome {
    const id = head.enq.requestId;
    const record: HoldRecord = {
      op: "hold", requestId: id, code, ...(status === undefined ? {} : { status }),
      attempts: attempts ?? (this.serverAttempts.get(id) ?? 0), at: this.stamp(),
    };
    this.append(record);
    head.hold = record;
    return { kind: "held", requestId: id, code, ...(status === undefined ? {} : { status }) };
  }

  private reject(head: Entry, status: number, detail: string | undefined): PdaAttemptOutcome {
    const id = head.enq.requestId;
    const record: RejectRecord = { op: "reject", requestId: id, status, code: "pda_rejected", at: this.stamp() };
    this.append(record);
    head.reject = record;
    this.serverAttempts.delete(id);
    this.compactIfNeeded();
    return { kind: "rejected", requestId: id, status, ...(detail === undefined ? {} : { detail }) };
  }

  /** Deliver until the queue is empty or the head is held, backing off 0.5 s doubling to 10 s on transient
   *  failures, forever (pda is down or restarting). A 5xx is bounded by the record's attempt count instead. */
  async drain(client: PdaClient, options: PdaDrainOptions = {}): Promise<PdaDrainEnd> {
    const sleep = options.sleep ?? defaultSleep;
    let delay = PDA_OUTBOX_BACKOFF_START_MS;
    for (;;) {
      if (options.signal?.aborted) return "aborted";
      const outcome = await this.attempt(client);
      options.onOutcome?.(outcome);
      switch (outcome.kind) {
        case "idle": return "empty";
        case "held": case "blocked": return "held";
        case "transient":
          await sleep(delay, options.signal);
          delay = Math.min(delay * 2, PDA_OUTBOX_BACKOFF_CAP_MS);
          break;
        default:
          delay = PDA_OUTBOX_BACKOFF_START_MS;
      }
    }
  }

  // ── Operator and reconnect release ──

  /** `rig seat pda-release`: append a `release` for the held head so it is retried for another cycle.
   *  Returns the released requestId, or null when nothing is held. Never drops the message. */
  release(): string | null {
    const held = this.eligible().find((e) => e.hold !== undefined);
    if (!held) return null;
    this.append({ op: "release", requestId: held.enq.requestId, at: this.stamp() });
    held.hold = undefined;
    this.serverAttempts.delete(held.enq.requestId);
    return held.enq.requestId;
  }

  /** A reconnect that follows a pda restart makes a held head eligible once more, in memory only: no record
   *  is written, so a runner restart reads the hold again. Returns whether a head was un-held. */
  retryHeldAfterReconnect(): boolean {
    const held = this.eligible().find((e) => e.hold !== undefined);
    if (!held) return false;
    held.hold = undefined;
    this.serverAttempts.delete(held.enq.requestId);
    return true;
  }

  // ── Compaction (atomic rewrite) ──

  private compactIfNeeded(): void {
    let terminal = 0;
    for (const e of this.entries.values()) if (!isPending(e)) terminal += 1;
    if (terminal > PDA_OUTBOX_COMPACT_THRESHOLD) this.compact();
  }

  /** Rewrite the log with only pending records (each `enq`, plus its live `hold`). Kept `reject` records are
   *  copied to rejected.log first, so a rejected message is never silently lost. Order of durability:
   *    1. rejected.log append + fsync     2. outbox.log.tmp write + fsync
   *    3. rename over outbox.log          4. fsync the directory
   *  A crash before step 3 leaves the old log, which is still correct. */
  compact(): void {
    const { outboxPath, rejectedPath } = this.paths;
    this.copyRejected(rejectedPath);
    const lines: string[] = [];
    for (const e of this.entries.values()) {
      if (!isPending(e)) continue;
      lines.push(JSON.stringify(e.enq));
      if (e.hold) lines.push(JSON.stringify(e.hold));
    }
    const tmp = `${outboxPath}.tmp`;
    const fd = this.io.open(tmp, "write");
    try {
      this.io.write(fd, lines.map((l) => `${l}\n`).join(""));
      this.io.fsync(fd);
    } finally {
      this.io.close(fd);
    }
    this.io.rename(tmp, outboxPath);
    this.io.fsyncDir(nodePath.dirname(outboxPath));
    for (const [id, e] of this.entries) if (!isPending(e)) { this.entries.delete(id); this.serverAttempts.delete(id); }
  }

  private copyRejected(rejectedPath: string): void {
    const rejected = [...this.entries.values()].filter((e) => e.reject !== undefined);
    if (rejected.length === 0) return;
    const already = new Set<string>();
    for (const line of (this.io.readFile(rejectedPath) ?? "").split("\n")) {
      if (line.length === 0) continue;
      try {
        const id = (JSON.parse(line) as { requestId?: unknown }).requestId;
        if (typeof id === "string") already.add(id);
      } catch { /* a torn line in rejected.log: its record is copied again below if it was ours */ }
    }
    const fresh = rejected.filter((e) => !already.has(e.enq.requestId));
    if (fresh.length === 0) return;
    const fd = this.io.open(rejectedPath, "append");
    try {
      for (const e of fresh) {
        this.io.write(fd, `${JSON.stringify({
          requestId: e.enq.requestId, agent: e.enq.agent, baseUrl: e.enq.baseUrl, content: e.enq.content,
          status: e.reject?.status, rejectedAt: e.reject?.at, at: e.enq.at,
        })}\n`);
      }
      this.io.fsync(fd);
    } finally {
      this.io.close(fd);
    }
  }
}
