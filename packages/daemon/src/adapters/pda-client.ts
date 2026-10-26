// pda runtime L1a (pda-runtime-design-9l Rev 2, "Endpoint allowlist", "Token handling"): the loopback HTTP
// client of the pane-hosted pda-runner. This is the anti-corruption layer: the ONLY module that speaks pda's
// HTTP vocabulary. OpenRig never imports `@earendil-works/*`.
//
// What it guarantees, each pinned in test/pda-client.test.ts:
//   - It can call exactly five endpoints (GET /health, GET /agents/:name, GET /agents/:name/events,
//     GET /agents/:name/transcript, POST /agents/:name/messages) for the ONE agent it was built for.
//     There is no create, delete, abort, compact, reset, configure, fork or inspect call to reach.
//   - It never follows a redirect. A 3xx is a protocol failure, and the redirect target is never requested.
//   - The bearer is read from pda's token file (O_NOFOLLOW, a regular file, our uid, no group/other bits,
//     capped at 4 KiB, pda's token format) before first use. It is sent only to the validated loopback base
//     URL, and appears in nothing the client returns.
//   - Failures are CODES: a kind, an HTTP status, and pda's own JSON `error` string after sanitising,
//     redacting the exact bearer value, and capping at 200 characters. An exception's message, cause and stack
//     are discarded, so a runtime that echoes a header value in its error cannot leak it through here.
//
// Nothing in this module logs or prints. Nothing imports daemon code except the L0 contract.

import fs from "node:fs";
import {
  isPdaLoopbackBaseUrl, isPdaTokenFormat, pdaAgentNameProblem, sanitizeForPane,
  type PdaBinding,
} from "./pda-runner-protocol.js";

// ── Body size (design: "Size") ───────────────────────────────────────────────

/** pda's MAX_BODY applies to the JSON request body (`server.mjs:15, 33-37`). */
export const PDA_MAX_BODY_BYTES = 1_048_576;
/** The runner stays this far under the limit, so a header-sized surprise cannot tip a body over. */
export const PDA_BODY_HEADROOM_BYTES = 1024;

/** True when the exact serialised request body is small enough to send. Bytes, not characters. */
export function pdaBodyFits(body: string): boolean {
  return Buffer.byteLength(body, "utf8") <= PDA_MAX_BODY_BYTES - PDA_BODY_HEADROOM_BYTES;
}

/** The one write pda takes from OpenRig: `{content, mode: "followUp", requestId}`. Every paste is
 *  `followUp`, never `steer` (design D6). `content` is text: nothing in it is parsed or prefixed. */
export function serializePdaMessage(message: { content: string; requestId: string }): string {
  return JSON.stringify({ content: message.content, mode: "followUp", requestId: message.requestId });
}

// ── Results: codes, never messages ───────────────────────────────────────────

export type PdaTokenProblem =
  | "unreadable" | "symlink" | "not_regular_file" | "wrong_owner" | "group_or_other_access" | "too_long" | "format";

export type PdaCallFailure =
  /** Connection refused, reset, timeout, or a socket closed before the reply. Transient. */
  | { ok: false; kind: "unreachable" }
  /** A non-2xx reply. `detail` is pda's JSON `error` string, sanitised, redacted and capped; absent when none. */
  | { ok: false; kind: "http"; status: number; detail?: string }
  /** A redirect, or a 2xx whose body is not what the endpoint promises. */
  | { ok: false; kind: "protocol"; status?: number }
  /** The serialised body exceeds the limit; nothing was sent. */
  | { ok: false; kind: "too_large" }
  /** The token file is not usable. `code` is the runner error code; `problem` says which check failed. */
  | { ok: false; kind: "token"; code: "pda_token_format"; problem: PdaTokenProblem };

export type PdaCallResult<T> = { ok: true; value: T } | PdaCallFailure;

// ── The token file ───────────────────────────────────────────────────────────

export type PdaTokenReadResult =
  | { ok: true; token: string }
  | { ok: false; kind: "token"; code: "pda_token_format"; problem: PdaTokenProblem };

const TOKEN_FILE_READ_CAP = 4096;

export interface PdaTokenFileOptions {
  /** The uid that must own the file. Defaults to the runner's own uid. */
  expectedUid?: number;
}

function tokenFailure(problem: PdaTokenProblem): Extract<PdaTokenReadResult, { ok: false }> {
  return { ok: false, kind: "token", code: "pda_token_format", problem };
}

/** Read and validate pda's token file. Opened `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` (NONBLOCK so a FIFO cannot
 *  hang the open); the OPEN handle must be a regular file owned by `expectedUid` with no group or other bits;
 *  the read is capped at 4 KiB; the trimmed value must match pda's token format. Every refusal is a
 *  `problem` code. The value, its length and the file's content are never in the result of a refusal. */
export function readPdaTokenFile(tokenFile: string, options: PdaTokenFileOptions = {}): PdaTokenReadResult {
  const expectedUid = options.expectedUid ?? (typeof process.getuid === "function" ? process.getuid() : -1);
  let fd: number;
  try {
    fd = fs.openSync(tokenFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (err) {
    // ELOOP (Linux) / EMLINK (macOS) is O_NOFOLLOW meeting a symlink. Only the errno code is inspected.
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    return tokenFailure(code === "ELOOP" || code === "EMLINK" ? "symlink" : "unreadable");
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return tokenFailure("not_regular_file");
    if (st.uid !== expectedUid) return tokenFailure("wrong_owner");
    if ((st.mode & 0o077) !== 0) return tokenFailure("group_or_other_access");
    const buf = Buffer.alloc(TOKEN_FILE_READ_CAP + 1);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    if (n > TOKEN_FILE_READ_CAP) return tokenFailure("too_long");
    const token = buf.subarray(0, n).toString("utf8").trim();
    if (!isPdaTokenFormat(token)) return tokenFailure("format");
    return { ok: true, token };
  } catch {
    return tokenFailure("unreadable");
  } finally {
    try { fs.closeSync(fd); } catch { /* the descriptor is gone either way */ }
  }
}

// ── The client ───────────────────────────────────────────────────────────────

/** A live `events` response. The body is raw SSE bytes: parsing is the stream lane's (L1b). */
export interface PdaEventStream {
  body: ReadableStream<Uint8Array>;
  close(): void;
}

/** The five calls, and the one binding they are for. Exactly these keys. */
export interface PdaClient {
  readonly binding: PdaBinding;
  /** GET /health. No bearer. */
  health(): Promise<PdaCallResult<true>>;
  /** GET /agents/:name. A 404 is `{kind: "http", status: 404}`: the agent is missing, and OpenRig never creates it. */
  getAgent(): Promise<PdaCallResult<Record<string, unknown>>>;
  /** GET /agents/:name/events?tail=N (SSE). `tail` is a non-negative integer. */
  openEvents(tail: number): Promise<PdaCallResult<PdaEventStream>>;
  /** GET /agents/:name/transcript?limit=N. `limit` is an integer from 1 to 500. */
  getTranscript(limit: number): Promise<PdaCallResult<unknown>>;
  /** POST /agents/:name/messages with the EXACT serialised body string the caller measured (see
   *  `serializePdaMessage`). That same string is what is sent. Over the limit: `too_large`, nothing sent. */
  postMessage(body: string): Promise<PdaCallResult<{ submissionId: string }>>;
}

export interface PdaClientOptions {
  /** The seat's binding. The base URL must satisfy the L0 loopback rule; the agent must be bindable. */
  binding: PdaBinding;
  /** Returns the current token. Called before first use, and once more after a 401 (a rotated token). */
  readToken: () => PdaTokenReadResult;
  /** Per-request budget for everything but the event stream's lifetime. Default 10 s. */
  timeoutMs?: number;
  /** Extra exact values to redact from pda's error text (for example the runner's activity hook token). A bare
   *  string is replaced by `[redacted:secret]`; pass `{value, marker}` to name it, for example
   *  `{value: hookToken, marker: "[redacted:openrig-hook-token]"}`. The bearer is always `[redacted:pda-token]`. */
  redact?: ReadonlyArray<string | { value: string; marker: string }>;
  /** Test seam; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** The runner is stopping (OF-98): every request in flight is aborted (it reads as `unreachable`, which every caller
   *  already treats as transient: a message POST stays in the outbox and is re-sent under its request id), and none
   *  starts. The event stream is closed by its own `close()`. */
  stopSignal?: AbortSignal;
}

const ERROR_BODY_CAP = 64 * 1024;
const SUCCESS_BODY_CAP = 16 * 1024 * 1024;
const DETAIL_CAP = 200;
/** What replaces the bearer in any text this client returns (design: Token handling). */
export const PDA_TOKEN_MARKER = "[redacted:pda-token]";
export const PDA_TRANSCRIPT_MAX_LIMIT = 500;

/** A chunk read past `cap` bytes is a protocol failure, not a silent truncation. */
async function readBodyCapped(res: Response, cap: number): Promise<string | null> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) { await reader.cancel().catch(() => undefined); return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createPdaClient(options: PdaClientOptions): PdaClient {
  const { binding } = options;
  if (!isPdaLoopbackBaseUrl(binding.baseUrl)) {
    throw new RangeError("pda client: the base URL must be http://127.0.0.1:<port> (pda listens on loopback only)");
  }
  if (pdaAgentNameProblem(binding.agent) !== null) {
    throw new RangeError("pda client: the agent is not a name a seat may bind");
  }
  const baseUrl = binding.baseUrl;
  const agentPath = `/agents/${binding.agent}`;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  let token: string | null = null;

  const secrets = (): Array<{ value: string; marker: string }> => [
    ...(token ? [{ value: token, marker: PDA_TOKEN_MARKER }] : []),
    ...(options.redact ?? []).map((r) => (typeof r === "string" ? { value: r, marker: "[redacted:secret]" } : r)),
  ].filter((s) => s.value.length > 0);

  /** pda's JSON `error` string made safe for a pane or a sidecar: control sequences stripped first, then the
   *  exact secret values replaced (so a stripped sequence cannot assemble one), then capped. */
  function safeDetail(bodyText: string): string | undefined {
    let parsed: unknown;
    try { parsed = JSON.parse(bodyText); } catch { return undefined; }
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const raw = (parsed as Record<string, unknown>).error;
    if (typeof raw !== "string") return undefined;
    let text = sanitizeForPane(raw);
    for (const secret of secrets()) text = text.split(secret.value).join(secret.marker);
    text = text.slice(0, DETAIL_CAP);
    return text.length > 0 ? text : undefined;
  }

  type Raw = { ok: true; res: Response; cancelTimer: () => void; abort: () => void } | PdaCallFailure;

  /** One request, with the single 401 re-read. Returns the raw 2xx response, or a failure. */
  async function send(
    method: "GET" | "POST", pathAndQuery: string,
    opts: { bearer: boolean; body?: string; stream?: boolean },
  ): Promise<Raw> {
    for (let reread = 0; reread < 2; reread++) {
      if (opts.bearer && (token === null || reread > 0)) {
        // The source may be custom: it can throw, and it may not have format-checked. Either is a token failure,
        // never an outage (an LF in a header value would make fetch throw, and read as "unreachable" forever).
        let read: PdaTokenReadResult;
        try { read = options.readToken(); } catch { return tokenFailure("unreadable"); }
        if (!read.ok) return read;
        if (!isPdaTokenFormat(read.token)) return tokenFailure("format");
        token = read.token;
      }
      if (options.stopSignal?.aborted) return { ok: false, kind: "unreachable" };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const onStop = (): void => controller.abort();
      options.stopSignal?.addEventListener("abort", onStop, { once: true });
      const cancelTimer = (): void => { clearTimeout(timer); options.stopSignal?.removeEventListener("abort", onStop); };
      let res: Response;
      try {
        const headers: Record<string, string> = {};
        if (opts.bearer && token !== null) headers["Authorization"] = `Bearer ${token}`;
        if (opts.body !== undefined) headers["Content-Type"] = "application/json";
        if (opts.stream) headers["Accept"] = "text/event-stream";
        res = await doFetch(`${baseUrl}${pathAndQuery}`, {
          method, headers, body: opts.body, redirect: "manual", signal: controller.signal,
        });
      } catch {
        cancelTimer();
        return { ok: false, kind: "unreachable" };
      }
      if (res.status >= 300 && res.status < 400) {
        cancelTimer();
        await res.body?.cancel().catch(() => undefined);
        return { ok: false, kind: "protocol", status: res.status };
      }
      if (res.status === 401 && opts.bearer && reread === 0) {
        cancelTimer();
        await res.body?.cancel().catch(() => undefined);
        continue;
      }
      if (res.status < 200 || res.status >= 300) {
        let text: string | null = "";
        try { text = await readBodyCapped(res, ERROR_BODY_CAP); } catch { text = ""; }
        cancelTimer();
        const detail = text === null ? undefined : safeDetail(text);
        return detail === undefined ? { ok: false, kind: "http", status: res.status } : { ok: false, kind: "http", status: res.status, detail };
      }
      // The timer stays armed through the caller's body read (`json`), or is cancelled by the caller (stream).
      return { ok: true, res, cancelTimer, abort: () => controller.abort() };
    }
    return { ok: false, kind: "http", status: 401 };
  }

  async function json(raw: Raw): Promise<PdaCallResult<unknown>> {
    if (!raw.ok) return raw;
    let text: string | null;
    try {
      text = await readBodyCapped(raw.res, SUCCESS_BODY_CAP);
    } catch {
      // The socket closed or the budget expired mid-body: transient, like any other unreachable reply.
      raw.cancelTimer();
      return { ok: false, kind: "unreachable" };
    }
    raw.cancelTimer();
    if (text === null) return { ok: false, kind: "protocol", status: raw.res.status };
    try {
      return { ok: true, value: JSON.parse(text) as unknown };
    } catch {
      return { ok: false, kind: "protocol", status: raw.res.status };
    }
  }

  const client: PdaClient = {
    binding: { agent: binding.agent, baseUrl },

    async health() {
      const raw = await send("GET", "/health", { bearer: false });
      if (!raw.ok) return raw;
      raw.cancelTimer();
      await raw.res.body?.cancel().catch(() => undefined);
      return { ok: true, value: true };
    },

    async getAgent() {
      const parsed = await json(await send("GET", agentPath, { bearer: true }));
      if (!parsed.ok) return parsed;
      if (typeof parsed.value !== "object" || parsed.value === null || Array.isArray(parsed.value)) {
        return { ok: false, kind: "protocol" };
      }
      return { ok: true, value: parsed.value as Record<string, unknown> };
    },

    async openEvents(tail) {
      if (!Number.isInteger(tail) || tail < 0) throw new RangeError("pda client: tail must be a non-negative integer");
      const raw = await send("GET", `${agentPath}/events?tail=${tail}`, { bearer: true, stream: true });
      if (!raw.ok) return raw;
      raw.cancelTimer();
      const body = raw.res.body;
      if (!body) return { ok: false, kind: "protocol", status: raw.res.status };
      return { ok: true, value: { body, close: () => { raw.abort(); } } };
    },

    async getTranscript(limit) {
      if (!Number.isInteger(limit) || limit < 1 || limit > PDA_TRANSCRIPT_MAX_LIMIT) {
        throw new RangeError("pda client: limit must be an integer from 1 to 500");
      }
      return json(await send("GET", `${agentPath}/transcript?limit=${limit}`, { bearer: true }));
    },

    async postMessage(body) {
      if (!pdaBodyFits(body)) return { ok: false, kind: "too_large" };
      const parsed = await json(await send("POST", `${agentPath}/messages`, { bearer: true, body }));
      if (!parsed.ok) return parsed;
      const v = parsed.value;
      const submissionId = typeof v === "object" && v !== null ? (v as Record<string, unknown>).submissionId : undefined;
      // pda's SubmissionId is a NUMBER (pi-durable types.d.ts:21, `Id<"submission">`; app.mjs `send` returns
      // `submission.id` as is). A string id is accepted too; either way the caller gets it as a string.
      const asText = typeof submissionId === "number" && Number.isSafeInteger(submissionId) && submissionId >= 0 ? String(submissionId)
        : typeof submissionId === "string" && submissionId.length > 0 ? submissionId : null;
      if (asText === null) return { ok: false, kind: "protocol" };
      return { ok: true, value: { submissionId: asText } };
    },
  };
  return client;
}

/** A token source for the runner: re-reads the file on every call, so a rotated token is picked up. */
export function pdaTokenSourceFromFile(tokenFile: string, options: PdaTokenFileOptions = {}): () => PdaTokenReadResult {
  return () => readPdaTokenFile(tokenFile, options);
}
