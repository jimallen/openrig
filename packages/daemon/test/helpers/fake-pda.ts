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

import http from "node:http";
import type { AddressInfo, Socket } from "node:net";

export interface FakePdaEntry { submissionId: string; requestId: string; content: string }

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
  const byKey = new Map<string, FakePdaEntry>();       // `${agent}\0${requestId}` -> entry (dedupe index)
  const queue: FakePdaPostBehaviour[] = [];
  const streams = new Set<http.ServerResponse>();
  const sockets = new Set<Socket>();
  let seq = 0;

  const json = (res: http.ServerResponse, status: number, body: unknown): void => {
    const text = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
    res.end(text);
  };

  const admit = (agent: string, requestId: string, content: string): FakePdaEntry => {
    const key = `${agent}\u0000${requestId}`;
    const existing = byKey.get(key);
    if (dedupe && existing) return existing;
    const entry: FakePdaEntry = { submissionId: `sub-${++seq}`, requestId, content };
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
    if (entry.method === "GET" && tail === "/transcript") return json(res, 200, { entries: log.get(agent) ?? [] });
    if (entry.method === "GET" && tail === "/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.write(`data: ${JSON.stringify({ type: "snapshot", agent })}\n\n`);
      streams.add(res);
      res.on("close", () => streams.delete(res));
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
        return json(res, 202, { submissionId: admitted.submissionId });
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
