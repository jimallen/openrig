// hc-w46 (QA F2): the fetch used for waits past the global fetch's 300 s headers timeout. The 300 s itself was measured once on a real
// DaemonClient against a server that answered at 305 s (see the commit message); these rows pin that the replacement is a faithful
// enough fetch for the daemon client, and that it is chosen exactly when the budget needs it.
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonClient, DaemonConnectionError } from "../src/client.js";
import { FETCH_HEADERS_TIMEOUT_MS, fetchForBudget, httpFetch } from "../src/http-fetch.js";
import { FetchTimeoutError, fetchWithTimeout } from "../src/fetch-with-timeout.js";

const servers: http.Server[] = [];
async function serve(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
afterEach(async () => {
  for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>((r) => s.close(() => r())); }
});

describe("which fetch a budget gets", () => {
  it("the global fetch up to its 300 s headers timeout, httpFetch past it, and an injected fetch never replaced", () => {
    expect(FETCH_HEADERS_TIMEOUT_MS).toBe(300_000);
    expect(fetchForBudget(globalThis.fetch, 5_000)).toBe(globalThis.fetch);
    expect(fetchForBudget(globalThis.fetch, 300_000)).toBe(globalThis.fetch);
    expect(fetchForBudget(globalThis.fetch, 300_001)).toBe(httpFetch);
    expect(fetchForBudget(globalThis.fetch, 975_000)).toBe(httpFetch);
    const injected = (async () => new Response("x")) as typeof fetch;
    expect(fetchForBudget(injected, 975_000)).toBe(injected);
  });
});

describe("httpFetch", () => {
  it("POSTs a JSON body with its headers and reads the JSON answer, status and headers", async () => {
    let seen: { method?: string; url?: string; type?: string; len?: string; body: string } = { body: "" };
    const base = await serve((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seen = { method: req.method, url: req.url, type: req.headers["content-type"], len: req.headers["content-length"], body: Buffer.concat(chunks).toString() };
        res.writeHead(201, { "content-type": "application/json", "x-thing": "a" });
        res.end(JSON.stringify({ ok: true, echoed: "é漢" }));
      });
    });
    const res = await httpFetch(`${base}/api/x?q=1`, { method: "POST", headers: { "Content-Type": "application/json", "X-Other": "b" }, body: JSON.stringify({ a: "é漢" }) });
    expect(res.status).toBe(201);
    expect(res.headers.get("x-thing")).toBe("a");
    expect(await res.json()).toEqual({ ok: true, echoed: "é漢" });
    expect(seen).toMatchObject({ method: "POST", url: "/api/x?q=1", type: "application/json", body: JSON.stringify({ a: "é漢" }) });
    expect(seen.len).toBe(String(Buffer.byteLength(JSON.stringify({ a: "é漢" }))));
  });
  it("reads an error status with a body, and a 204 with none", async () => {
    const base = await serve((req, res) => {
      if (req.url === "/gone") { res.writeHead(404, { "content-type": "application/json" }); res.end('{"error":"nope"}'); } else { res.writeHead(204); res.end(); }
    });
    const missing = await httpFetch(`${base}/gone`);
    expect([missing.status, missing.ok, await missing.json()]).toEqual([404, false, { error: "nope" }]);
    const empty = await httpFetch(`${base}/none`, { method: "DELETE" });
    expect([empty.status, await empty.text()]).toEqual([204, ""]);
  });
  it("answers only when the server does: no timer of its own (a 1.2 s answer arrives)", async () => {
    const base = await serve((_req, res) => { setTimeout(() => { res.writeHead(200); res.end("late"); }, 1_200); });
    const started = Date.now();
    const res = await httpFetch(base);
    expect(await res.text()).toBe("late");
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_100);
  });
  it("a closed port is fetch's own TypeError('fetch failed') with the system error as its cause", async () => {
    const base = await serve((_q, r) => r.end());
    const closed = base;
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
    const err = await httpFetch(closed).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect((err as Error).message).toBe("fetch failed");
    expect(((err as Error).cause as NodeJS.ErrnoException).code).toBe("ECONNREFUSED");
  });
  it("an already aborted signal, and one aborted while waiting, reject with the signal's reason", async () => {
    const base = await serve(() => { /* never answers */ });
    const done = new AbortController(); done.abort(new Error("already"));
    await expect(httpFetch(base, { signal: done.signal })).rejects.toThrow("already");
    const later = new AbortController();
    const pending = httpFetch(base, { signal: later.signal });
    setTimeout(() => later.abort(new Error("while waiting")), 100);
    await expect(pending).rejects.toThrow("while waiting");
  });
  it("an abort after the headers fails the body read", async () => {
    const base = await serve((_q, res) => { res.writeHead(200); res.write("part"); /* and never ends */ });
    const ac = new AbortController();
    const res = await httpFetch(base, { signal: ac.signal });
    setTimeout(() => ac.abort(new Error("cut")), 100);
    await expect(res.text()).rejects.toBeDefined();
  });
});

describe("through fetchWithTimeout and DaemonClient, for a budget that needs it", () => {
  it("fetchWithTimeout with a 301 s budget reaches a server that answers in 1 s, and its deadline is still the caller's: an abort is the FetchTimeoutError", async () => {
    const base = await serve((_q, res) => { setTimeout(() => { res.writeHead(200); res.end("ok"); }, 1_000); });
    const res = await fetchWithTimeout(globalThis.fetch, base, {}, { timeoutMs: 301_000, timeoutMessage: "t" });
    expect(await res.text()).toBe("ok");
    const external = new AbortController();
    const slow = await serve(() => { /* never answers */ });
    const aborted = fetchWithTimeout(globalThis.fetch, slow, { signal: external.signal }, { timeoutMs: 301_000, timeoutMessage: "t" });
    setTimeout(() => external.abort(new Error("caller cancelled")), 100);
    await expect(aborted).rejects.toThrow("caller cancelled");
    void FetchTimeoutError;
  });
  it("the route taken is observable: a budget past 300 s goes out on its own connection (Connection: close), a shorter one on the global fetch's keep-alive", async () => {
    const connections: Array<string | undefined> = [];
    const base = await serve((req, res) => { connections.push(req.headers.connection); res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
    await new DaemonClient(base).post("/x", {}, { timeoutMs: 5_000 });
    await new DaemonClient(base).post("/x", {}, { timeoutMs: 400_000 });
    await fetchWithTimeout(globalThis.fetch, base, {}, { timeoutMs: 300_000, timeoutMessage: "t" }).then((r) => r.text());
    await fetchWithTimeout(globalThis.fetch, base, {}, { timeoutMs: 300_001, timeoutMessage: "t" }).then((r) => r.text());
    expect(connections).toEqual(["keep-alive", "close", "keep-alive", "close"]);
  });
  it("a DaemonClient with a 400 s budget: a JSON answer parses, and a closed port is still DaemonConnectionError with its code", async () => {
    const base = await serve((_q, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"hello":"world"}'); });
    expect(await new DaemonClient(base).post("/x", { a: 1 }, { timeoutMs: 400_000 })).toEqual({ status: 200, data: { hello: "world" } });
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
    const err = await new DaemonClient(base).post("/x", {}, { timeoutMs: 400_000 }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonConnectionError);
    expect((err as DaemonConnectionError).causeCode).toBe("ECONNREFUSED");
  });
});
