// pda runtime L1a (pda-runtime-design-9l Rev 2, "The faithful fake"): a real loopback `node:http` server that
// behaves like pda where the pda-runner's delivery guarantees depend on it:
//   - it REALLY dedups: a POST for a (conversation, requestId) it has admitted returns the SAME submissionId
//     and adds no entry (pda P2: a requestId is admitted at most once per conversation, with no expiry);
//   - it ADMITS before it drops a socket (`admit_then_drop`): the submission is committed, then the connection
//     dies with no reply, which is exactly the case that makes a retry dangerous;
//   - it LOGS every request (method, path) BEFORE routing, so a 404'd `/abort` is still counted;
//   - `dedupe: false` is the negative control: the same server without P2. A test of exactly-once delivery
//     MUST fail against it, or that test is not testing dedup.
// It speaks only what the client needs: /health, /agents/:name, /agents/:name/events, /agents/:name/transcript,
// /agents/:name/messages. Every other route answers 404 (after being logged).
//
// REAL SHAPES (pi-durable 1.3.0 `dist/harness/events.d.ts`, `dist/types.d.ts`, `pi-ai/dist/types.d.ts`; pda
// `src/server.mjs`, `src/app.mjs`). Nothing here is an invented vocabulary any more:
//   - every id (entry, submission, conversation) is a NUMBER (types.d.ts:18-21); `POST .../messages` answers
//     `{submissionId: <number>, status: "queued"}` (app.mjs `send`);
//   - the transcript is `{entries: EntryRecord[]}`, oldest first, the newest `limit` of them (app.mjs `transcript`);
//   - an admitted input appends a user EntryRecord (`{id, conversationId, kind, model: [UserMessage]}`) and its
//     SubmissionRecord (`{id, type: "input", conversationId, requestId, status, entry}`, types.d.ts:336-366);
//   - the event stream opens with the real SnapshotEvent (events.d.ts:35-64, `entries` trimmed by `tail`, plus
//     `totalEntries`, server.mjs:57-62), then one `data:` line per AgentEvent. An admit emits `message_start` +
//     `message_end{entry}` and then `submission{record}`, in that order (events.js:205-222, :263-264).
// `emit`, `streamReply` and `injectOtherClientMessage` let a test drive the stream with those same shapes.

import http from "node:http";
import type { AddressInfo, Socket } from "node:net";

export interface FakePdaEntry { submissionId: number; requestId: string; content: string; entryId: number }

/** What the NEXT POST /agents/:name/messages does. Consumed in order; once empty, posts are admitted (202). */
export type FakePdaPostBehaviour =
  | { action: "admit" }
  /** Commit the submission, then kill the socket with no reply. */
  | { action: "admit_then_drop" }
  /** Reply with `status` (and an optional JSON body) WITHOUT admitting. */
  | { action: "status"; status: number; body?: unknown }
  /** 3xx (default 302) to another path on this server; the target must never be requested. */
  | { action: "redirect"; to: string; status?: number };

export interface FakePdaRequest { method: string; path: string; url: string }

export interface FakePdaOptions {
  /** The bearer pda would accept. */
  token: string;
  /** Agents that exist. Default: ["research"]. */
  agents?: string[];
  /** Default true. `false` makes this a pda WITHOUT P2, for the negative control. */
  dedupe?: boolean;
  /** pda's MAX_BODY. Default 1 MiB. */
  maxBodyBytes?: number;
}

export interface FakePda {
  readonly baseUrl: string;
  /** Every request, in arrival order, logged before routing. */
  readonly requests: FakePdaRequest[];
  /** The Authorization header of every request that carried one, in arrival order. */
  readonly authorizations: string[];
  /** Raw POST bodies as received, in arrival order. */
  readonly postBodies: string[];
  /** POST messages requests seen per requestId (a dedup hit counts). */
  readonly postsByRequestId: Map<string, number>;
  entries(agent: string): FakePdaEntry[];
  /** Write one raw AgentEvent to every open event stream of `agent`. */
  emit(agent: string, event: unknown): void;
  /** A run answering with `chunks` as text deltas: run_start, message_start, message_update*, message_end, run_end. */
  streamReply(agent: string, chunks: string[]): { entryId: number };
  /** A user message from another client (`pda send`, `pda chat`): its entry and a submission with that client's id. */
  injectOtherClientMessage(agent: string, text: string, requestId?: string): { entryId: number; submissionId: number };
  /** Kill every open event stream's socket (pda restarted / the connection dropped), without a stream_end. */
  dropStreams(): void;
  /** The conversation as EntryRecords, oldest first. */
  transcriptOf(agent: string): unknown[];
  /** Queue behaviours for upcoming message POSTs. */
  script(...behaviours: FakePdaPostBehaviour[]): void;
  /** Change the accepted bearer (a rotated token). */
  setToken(token: string): void;
  /** Runs after the request is logged and before it is routed (ordering probes, file swaps). */
  beforeRoute?: (req: FakePdaRequest) => void;
  /** Runs when a message POST has been parsed, BEFORE the behaviour is applied (ordering probes). */
  onPost?: (info: { agent: string; requestId: string | null }) => void;
  /** Number of event streams currently open. */
  openStreams(): number;
  close(): Promise<void>;
}

export const FAKE_PDA_ALLOWLIST: ReadonlyArray<(r: FakePdaRequest) => boolean> = [
  (r) => r.method === "GET" && r.path === "/health",
  (r) => r.method === "GET" && /^\/agents\/[^/]+$/.test(r.path),
  (r) => r.method === "GET" && /^\/agents\/[^/]+\/events$/.test(r.path),
  (r) => r.method === "GET" && /^\/agents\/[^/]+\/transcript$/.test(r.path),
  (r) => r.method === "POST" && /^\/agents\/[^/]+\/messages$/.test(r.path),
];

/** Requests that are none of the five endpoints the client may call. */
export function nonAllowlisted(requests: readonly FakePdaRequest[]): FakePdaRequest[] {
  return requests.filter((r) => !FAKE_PDA_ALLOWLIST.some((allowed) => allowed(r)));
}

export async function startFakePda(options: FakePdaOptions): Promise<FakePda> {
  let token = options.token;
  const agents = new Set(options.agents ?? ["research"]);
  const dedupe = options.dedupe ?? true;
  const maxBody = options.maxBodyBytes ?? 1_048_576;
  const requests: FakePdaRequest[] = [];
  const authorizations: string[] = [];
  const postBodies: string[] = [];
  const postsByRequestId = new Map<string, number>();
  const log = new Map<string, FakePdaEntry[]>();       // agent -> entries, in admission order
  const records = new Map<string, unknown[]>();        // agent -> EntryRecords (the conversation), oldest first
  let entrySeq = 0;
  const byKey = new Map<string, FakePdaEntry>();       // `${agent}\0${requestId}` -> entry (dedupe index)
  const queue: FakePdaPostBehaviour[] = [];
  const streams = new Set<http.ServerResponse>();
  const streamAgent = new Map<http.ServerResponse, string>();
  const sockets = new Set<Socket>();
  let seq = 0;

  const writeEvent = (agent: string, event: unknown): void => {
    for (const res of streams) if (streamAgent.get(res) === agent) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const userEntry = (agent: string, text: string): { id: number; record: Record<string, unknown> } => {
    const id = ++entrySeq;
    const record = { id, conversationId: 1, kind: "pi.user", model: [{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }] };
    records.set(agent, [...(records.get(agent) ?? []), record]);
    return { id, record };
  };
  const emitInput = (agent: string, text: string, requestId: string | undefined, submissionId: number): number => {
    const { id, record } = userEntry(agent, text);
    writeEvent(agent, { type: "message_start", message: (record.model as unknown[])[0] });
    writeEvent(agent, { type: "message_end", entry: record });
    writeEvent(agent, { type: "submission", record: {
      id: submissionId, type: "input", conversationId: 1, ...(requestId === undefined ? {} : { requestId }), status: "placed", entry: id } });
    return id;
  };

  const json = (res: http.ServerResponse, status: number, body: unknown): void => {
    const text = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
    res.end(text);
  };

  const admit = (agent: string, requestId: string, content: string): FakePdaEntry => {
    const key = `${agent}\u0000${requestId}`;
    const existing = byKey.get(key);
    if (dedupe && existing) return existing;
    const submissionId = ++seq;
    const entryId = emitInput(agent, content, requestId, submissionId);
    const entry: FakePdaEntry = { submissionId, requestId, content, entryId };
    byKey.set(key, entry);
    const list = log.get(agent) ?? [];
    list.push(entry);
    log.set(agent, list);
    return entry;
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const entry: FakePdaRequest = { method: req.method ?? "", path: url.pathname, url: `${url.pathname}${url.search}` };
    requests.push(entry);                       // logged BEFORE routing
    const auth = req.headers["authorization"];
    if (typeof auth === "string") authorizations.push(auth);
    fake.beforeRoute?.(entry);

    if (entry.method === "GET" && entry.path === "/health") return json(res, 200, { ok: true });
    if (auth !== `Bearer ${token}`) return json(res, 401, { error: "unauthorized" });

    const m = /^\/agents\/([^/]+)(\/[^/]+)?$/.exec(entry.path);
    const agent = m?.[1];
    const tail = m?.[2];
    if (!m || !agent || !agents.has(agent)) return json(res, 404, { error: "not found" });

    if (entry.method === "GET" && tail === undefined) return json(res, 200, { name: agent, state: "idle" });
    if (entry.method === "GET" && tail === "/transcript") {
      const limit = Math.min(Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50), 500);
      return json(res, 200, { entries: (records.get(agent) ?? []).slice(-limit) });
    }
    if (entry.method === "GET" && tail === "/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      const tailN = Math.min(Math.max(0, Number(url.searchParams.get("tail") ?? 20) || 0), 500);
      const all = records.get(agent) ?? [];
      res.write(`data: ${JSON.stringify({
        type: "snapshot", entries: tailN === 0 ? [] : all.slice(-tailN), totalEntries: all.length,
        tools: [], nestedTools: [], compactions: [], inbox: [], agent: {}, usage: {},
      })}\n\n`);
      streams.add(res);
      streamAgent.set(res, agent);
      res.on("close", () => { streams.delete(res); streamAgent.delete(res); });
      return;
    }
    if (entry.method === "POST" && tail === "/messages") {
      const chunks: Buffer[] = [];
      let bytes = 0;
      req.on("data", (c: Buffer) => { bytes += c.length; if (bytes <= maxBody) chunks.push(c); });
      req.on("end", () => {
        if (bytes > maxBody) return json(res, 413, { error: "body too large" });
        const raw = Buffer.concat(chunks).toString("utf8");
        postBodies.push(raw);
        let parsed: { content?: unknown; requestId?: unknown; mode?: unknown } = {};
        try { parsed = JSON.parse(raw) as typeof parsed; } catch { return json(res, 400, { error: "invalid json" }); }
        const requestId = typeof parsed.requestId === "string" ? parsed.requestId : null;
        if (requestId) postsByRequestId.set(requestId, (postsByRequestId.get(requestId) ?? 0) + 1);
        fake.onPost?.({ agent, requestId });
        if (typeof parsed.content !== "string" || requestId === null) return json(res, 400, { error: "content and requestId required" });
        const behaviour = queue.shift() ?? { action: "admit" as const };
        if (behaviour.action === "status") return json(res, behaviour.status, behaviour.body ?? { error: `scripted ${behaviour.status}` });
        if (behaviour.action === "redirect") { res.writeHead(behaviour.status ?? 302, { Location: behaviour.to }); return res.end(); }
        const admitted = admit(agent, requestId, parsed.content);   // ADMIT first ...
        if (behaviour.action === "admit_then_drop") { req.socket.destroy(); return; }   // ... then drop
        return json(res, 202, { submissionId: admitted.submissionId, status: "queued" });
      });
      return;
    }
    return json(res, 404, { error: "not found" });
  });
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  const fake: FakePda = {
    baseUrl: `http://127.0.0.1:${port}`,
    requests, authorizations, postBodies, postsByRequestId,
    entries: (agent) => [...(log.get(agent) ?? [])],
    transcriptOf: (agent) => [...(records.get(agent) ?? [])],
    dropStreams: () => { for (const r of streams) r.destroy(); },
    emit: (agent, event) => writeEvent(agent, event),
    injectOtherClientMessage: (agent, text, requestId) => {
      const submissionId = ++seq;
      const entryId = emitInput(agent, text, requestId, submissionId);
      return { entryId, submissionId };
    },
    streamReply: (agent, chunks) => {
      const inputs = [seq];
      writeEvent(agent, { type: "run_start", inputs });
      const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
      const partial = { role: "assistant", content: [], api: "openai-completions", provider: "test", model: "m", usage, stopReason: "stop", timestamp: Date.now() };
      writeEvent(agent, { type: "message_start", message: partial });
      chunks.forEach((delta) => writeEvent(agent, { type: "message_update", usage, changes: [{ type: "text_delta", contentIndex: 0, delta }] }));
      const id = ++entrySeq;
      const record = { id, conversationId: 1, kind: "pi.assistant", model: [{ ...partial, content: [{ type: "text", text: chunks.join("") }] }] };
      records.set(agent, [...(records.get(agent) ?? []), record]);
      writeEvent(agent, { type: "message_end", entry: record });
      writeEvent(agent, { type: "run_end", inputs });
      return { entryId: id };
    },
    script: (...b) => { queue.push(...b); },
    setToken: (t) => { token = t; },
    openStreams: () => streams.size,
    close: () => new Promise<void>((resolve) => {
      for (const r of streams) r.destroy();
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    }),
  };
  return fake;
}
