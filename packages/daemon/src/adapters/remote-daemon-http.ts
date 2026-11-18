// OPR.0.4.4.15 — the SHARED daemon→daemon HTTP core (arch cell 1, RATIFIED). workspaces-o9o.161: the adapter for the domain's
// RemoteDaemonClient port (src/domain/hosts/remote-daemon-client.ts); moved here from src/domain/hosts, the mechanics unchanged.
//
// Extracted from topology/remote-up-leaf.ts so the P4 aggregation fan-out
// does not mint a second copy of security-adjacent transport code (bearer
// resolution + bounded-abort discipline + status classification). The
// up-leaf is now a thin consumer that FORMATS this module's structured
// result into its shipped error strings (its tests byte-preserved).
//
// DEADLINE IS A REQUIRED ARGUMENT (arch sharpening, no module default):
// the up-leaf passes its 120s long-running rig-up budget at ITS call-site;
// the attention aggregator passes its 5s read-class deadline at ITS
// call-site. A buried default would invite the next consumer to silently
// inherit the wrong class.
//
// The G-R2B1-1 discipline is structural here: ONE deadline armed through
// the WHOLE exchange — request AND body parse (2xx or error body). A host
// that sends headers and never finishes the body yields a structured
// timeout, never a hung caller. The body race is explicit against the
// signal (a hand-built/proxied Response is not necessarily wired to the
// controller — no trust in fetch internals).

import type { HttpHostEntry } from "../domain/hosts/hosts-registry-reader.js";
import {
  resolveBearer, type BearerSources, type RemoteDaemonClient, type RemoteJsonRequest, type RemoteJsonResult, type RemoteRawRequest,
  type RemoteRawResult,
} from "../domain/hosts/remote-daemon-client.js";

import { nodeCredentialFileReader } from "./node-credential-file-reader.js";

export type { RemoteJsonFailure, RemoteJsonFailureKind, RemoteJsonResult, RemoteRawResult } from "../domain/hosts/remote-daemon-client.js";
export { resolveBearer } from "../domain/hosts/remote-daemon-client.js";

/** What the HTTP client needs from the world: the bearer sources, and fetch (injected for tests; defaults to global fetch). */
export interface RemoteJsonDeps extends BearerSources {
  fetchImpl?: typeof fetch;
}

export interface RemoteJsonOptions extends RemoteJsonRequest, RemoteJsonDeps {}

export interface RemoteRawOptions extends RemoteRawRequest, RemoteJsonDeps {}

/** The daemon's own client: bearer files read by the node credential reader, and the given fetch (a route's test seam) or the
 *  global one. What a route or startup.ts hands to the domain. */
export function nodeRemoteDaemonClient(fetchImpl?: typeof fetch): RemoteDaemonClient {
  return new HttpRemoteDaemonClient({ credentialFiles: nodeCredentialFileReader, ...(fetchImpl ? { fetchImpl } : {}) });
}

/** The client for one HTTP request: over the fetch a test set on its context as `remoteFetchImpl`, or the global one. The context is
 *  read here, on the adapter side, so no domain code names fetch or the test seam. */
export function contextRemoteDaemonClient(c: { get(key: string): unknown }): RemoteDaemonClient {
  return nodeRemoteDaemonClient(c.get("remoteFetchImpl") as typeof fetch | undefined);
}

/** The port over HTTP: every request goes through remoteJsonRequest / remoteRawRequest with this client's deps. */
export class HttpRemoteDaemonClient implements RemoteDaemonClient {
  constructor(private readonly deps: RemoteJsonDeps) {}

  requestJson(host: HttpHostEntry, path: string, request: RemoteJsonRequest): Promise<RemoteJsonResult> {
    return remoteJsonRequest(host, path, { ...request, ...this.deps });
  }

  requestRaw(host: HttpHostEntry, path: string, request: RemoteRawRequest): Promise<RemoteRawResult> {
    return remoteRawRequest(host, path, { ...request, ...this.deps });
  }
}

/** One bounded daemon→daemon JSON exchange. The single deadline covers
 *  request + body; every outcome is structured — this function never hangs
 *  and never throws. */
export async function remoteJsonRequest(host: HttpHostEntry, path: string, opts: RemoteJsonOptions): Promise<RemoteJsonResult> {
  const bearer = opts.resolvedBearer ?? resolveBearer(host, opts);
  if (!bearer.ok) return { ok: false, kind: "bearer", detail: bearer.detail };

  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${host.url.replace(/\/$/, "")}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: opts.method,
      headers: {
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(bearer.token ? { Authorization: `Bearer ${bearer.token}` } : {}),
        ...(opts.headers ?? {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      ...(opts.redirect !== undefined ? { redirect: opts.redirect } : {}),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (controller.signal.aborted) return { ok: false, kind: "timeout", phase: "request", detail: "" };
    return { ok: false, kind: "network", detail: (err as Error).message };
  }

  // A redirect the caller won't follow is classified on its status alone; its body is never read.
  if (opts.redirect === "manual" && res.status >= 300 && res.status < 400) {
    clearTimeout(timer);
    await res.body?.cancel().catch(() => {});
    return { ok: false, kind: "http", status: res.status, detail: "" };
  }

  // Body parse under the SAME still-armed deadline, raced explicitly.
  const abortRace = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(new Error("body read aborted"));
    if (controller.signal.aborted) onAbort();
    else controller.signal.addEventListener("abort", onAbort, { once: true });
  });

  let payload: unknown;
  let bodyTimedOut = false;
  try {
    if (opts.maxBytes === undefined) payload = await Promise.race([res.json(), abortRace]);
    else {
      const text = await Promise.race([readBounded(res, opts.maxBytes), abortRace]);
      if (text === null) {
        return { ok: false, kind: "network", status: res.status, tooLarge: true, detail: `answer larger than ${opts.maxBytes} bytes` };
      }
      payload = JSON.parse(text);
    }
  } catch (err) {
    if (controller.signal.aborted) bodyTimedOut = true;
    else if (!(err instanceof SyntaxError)) {
      return { ok: false, kind: "network", status: res.status, outcome: "indeterminate",
        detail: `Response body could not be read after HTTP ${res.status}; operation outcome is unknown: ${err instanceof Error ? err.message : String(err)}` };
    }
    // Completed non-JSON body: payload stays undefined; status is the honest detail
  } finally {
    clearTimeout(timer);
  }

  if (bodyTimedOut) return { ok: false, kind: "timeout", phase: "body", status: res.status, detail: "" };
  if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, payload };

  const remoteError = payload && typeof payload === "object" && typeof (payload as { error?: unknown }).error === "string"
    ? (payload as { error: string }).error
    : "";
  return { ok: false, kind: "http", status: res.status, detail: remoteError };
}

/** The body as text, or null once it passes `maxBytes` (the rest isn't read). */
async function readBounded(res: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** One bounded daemon→daemon GET, body passed through as text for ANY origin
 *  status (arch P3 verbatim rule). Same bearer resolution + single-deadline +
 *  explicit body race discipline as remoteJsonRequest; never hangs, never
 *  throws. */
export async function remoteRawRequest(host: HttpHostEntry, path: string, opts: RemoteRawOptions): Promise<RemoteRawResult> {
  const bearer = resolveBearer(host, opts);
  if (!bearer.ok) return { ok: false, kind: "bearer", detail: bearer.detail };

  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${host.url.replace(/\/$/, "")}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "GET",
      headers: bearer.token ? { Authorization: `Bearer ${bearer.token}` } : {},
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (controller.signal.aborted) return { ok: false, kind: "timeout", phase: "request", detail: "" };
    return { ok: false, kind: "network", detail: (err as Error).message };
  }

  const abortRace = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(new Error("body read aborted"));
    if (controller.signal.aborted) onAbort();
    else controller.signal.addEventListener("abort", onAbort, { once: true });
  });

  let bodyText = "";
  let bodyTimedOut = false;
  try {
    bodyText = await Promise.race([res.text(), abortRace]);
  } catch (err) {
    if (controller.signal.aborted) bodyTimedOut = true;
    else return { ok: false, kind: "network", status: res.status,
      detail: `Response body could not be read after HTTP ${res.status}; operation outcome is unknown: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    clearTimeout(timer);
  }

  if (bodyTimedOut) return { ok: false, kind: "timeout", phase: "body", status: res.status, detail: "" };
  return { ok: true, status: res.status, contentType: res.headers.get("content-type") ?? "application/json", bodyText };
}
