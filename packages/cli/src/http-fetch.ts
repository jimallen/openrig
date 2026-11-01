// hc-w46 (QA F2): a fetch for waits longer than the global fetch can wait.
//
// Node's global fetch (undici) gives up on a response that has sent no headers for 300 s (UND_ERR_HEADERS_TIMEOUT), whatever the
// caller's AbortController says, and reports it as "cannot connect" while the daemon carries on and finishes. A transport route sends no
// headers until its delivery ends, so a client budget past 300 s could never be reached; the person resent, and a resent broadcast has a
// fresh identity (a double delivery). `fetchWithTimeout` uses this for any budget past that limit. No timers of its own: the caller's
// signal is the only deadline, which is the point. The global fetch has no public way to set the limit without importing undici.
//
// Covers what the daemon client uses: method, headers, a string or byte body, a signal; http and https; a Response with a streamed body.
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";

/** The wait undici's default dispatcher allows for the first byte of a response. */
export const FETCH_HEADERS_TIMEOUT_MS = 300_000;

function headerPairs(headers: RequestInit["headers"]): Array<[string, string]> {
  if (headers === undefined) return [];
  if (headers instanceof Headers) return [...headers.entries()];
  if (Array.isArray(headers)) return (headers as Array<[string, string]>).map(([k, v]): [string, string] => [String(k), String(v)]);
  return Object.entries(headers as Record<string, string>);
}

export function httpFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  const signal = init.signal ?? undefined;
  const abortError = (): Error => {
    const reason: unknown = signal?.reason;
    return reason instanceof Error ? reason : Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
  };
  return new Promise<Response>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const body = init.body === undefined || init.body === null ? undefined
      : typeof init.body === "string" ? Buffer.from(init.body)
        : init.body instanceof Uint8Array ? Buffer.from(init.body)
          : null;
    if (body === null) return reject(new TypeError("httpFetch carries a string or byte body only"));
    const headers: Record<string, string> = {};
    for (const [key, value] of headerPairs(init.headers)) headers[key.toLowerCase()] = value;
    const request = (url.protocol === "https:" ? https : http).request(url, { method: init.method ?? "GET", headers, agent: false /* one connection per request: a long wait is not a reusable socket, and a stale one would reset */ }, (res) => {
      const out = new Headers();
      for (const [key, value] of Object.entries(res.headers)) {
        if (Array.isArray(value)) for (const v of value) out.append(key, v);
        else if (value !== undefined) out.append(key, value);
      }
      const status = res.statusCode ?? 0;
      const noBody = status === 204 || status === 205 || status === 304 || (init.method ?? "GET") === "HEAD";
      if (noBody) res.resume();
      const response = new Response(noBody ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>), { status, statusText: res.statusMessage ?? "", headers: out });
      signal?.removeEventListener("abort", onAbort);
      signal?.addEventListener("abort", () => res.destroy(abortError()), { once: true });
      resolve(response);
    });
    const onAbort = (): void => { request.destroy(abortError()); reject(abortError()); };
    signal?.addEventListener("abort", onAbort, { once: true });
    // A transport failure reads as fetch's own: TypeError("fetch failed") with the system error as its cause, which is what the client's
    // "cannot connect" classification reads.
    request.on("error", (cause) => {
      if (signal?.aborted) return reject(abortError());
      reject(new TypeError("fetch failed", { cause }));
    });
    request.end(body);
  });
}

/** The fetch to use for a request with this deadline: the global one cannot wait past its headers timeout, so a longer budget goes
 *  through `httpFetch`. An injected fetch (a test's, an embedder's) is never replaced. */
export function fetchForBudget(fetchImpl: typeof fetch, timeoutMs: number): typeof fetch {
  return fetchImpl === globalThis.fetch && timeoutMs > FETCH_HEADERS_TIMEOUT_MS ? (httpFetch as unknown as typeof fetch) : fetchImpl;
}
