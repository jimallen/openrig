// F1/F2 controls on actual Node listeners. F1 drives the production createAppWithWebSocket and its
// registered terminal route with raw socket requests, so duplicate and empty header forms reach the
// adapters exactly as sent. F2 checks the refusal log's emitted content.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import net from "node:net";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type Database from "better-sqlite3";
import { browserBoundary } from "../src/middleware/browser-boundary.js";
import type { NodeListenerOptions } from "../src/adapters/node-websocket.js";
import { createFullTestDb, createTestApp, mockTmuxAdapter } from "./helpers/test-app.js";

type Server = ReturnType<typeof serve>;
const listen = (fetch: Hono["fetch"], options?: NodeListenerOptions) => new Promise<{ server: Server; port: number }>((resolve) => {
  const server = serve({ fetch, port: 0, hostname: "127.0.0.1", ...options }, (info) => resolve({ server, port: info.port }));
});
const close = (s: Server) => new Promise<void>((r) => (s as unknown as net.Server).close(() => r()));

/** Send raw request lines and return the status line. */
function rawRequest(port: number, requestLine: string, headerLines: string[]): Promise<string> {
  return new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1", () => sock.write(`${requestLine}\r\n${headerLines.join("\r\n")}\r\n\r\n`));
    let data = "";
    const done = () => resolve(data.split("\r\n")[0] ?? "");
    sock.on("data", (d) => { data += d; if (data.includes("\r\n")) { sock.destroy(); } });
    sock.on("close", done);
    sock.on("error", done);
    setTimeout(() => sock.destroy(), 1500);
  });
}
const UPGRADE = ["Connection: Upgrade", "Upgrade: websocket", "Sec-WebSocket-Version: 13", `Sec-WebSocket-Key: ${Buffer.from("bb-ws-key-123456").toString("base64")}`];
const settle = () => new Promise((r) => setTimeout(r, 120));

describe("F1: production createAppWithWebSocket + registered terminal route, raw header forms", () => {
  let db: Database.Database;
  let server: Server;
  let port = 0;
  let hasSessionCalls = 0;
  const decisions: string[] = [];

  beforeAll(async () => {
    db = createFullTestDb();
    const ok = async () => ({ ok: true });
    const tmux = {
      ...mockTmuxAdapter(),
      hasSession: async () => { hasSessionCalls++; return true; },
      setWindowOption: ok, startPipePane: ok, stopPipePane: ok, sendKeys: ok, sendText: ok, resizeWindow: ok,
    };
    const built = createTestApp(db, {
      tmux: tmux as never,
      withWebSocket: true,
      appDeps: { webUiEnabled: true, browserBoundaryObserver: (d) => decisions.push(d.code ?? d.outcome) },
    });
    ({ server, port } = await listen(built.app.fetch as Hono["fetch"], built.listenerOptions!()));
  });
  afterAll(async () => { await close(server); db.close(); });

  async function upgradeCase(headers: string[]) {
    const d0 = decisions.length, h0 = hasSessionCalls;
    const status = await rawRequest(port, "GET /api/terminal/seat-1 HTTP/1.1", [...headers, ...UPGRADE]);
    await settle();
    return { status, decisions: decisions.slice(d0), routeEffects: hasSessionCalls - h0 };
  }

  it("positive control: own UI origin upgrades once, one allow decision, route effect present", async () => {
    const r = await upgradeCase([`Host: 127.0.0.1:${port}`, `Origin: http://127.0.0.1:${port}`]);
    console.log("F1-UPGRADE own", JSON.stringify(r));
    expect(r.status).toContain("101");
    expect(r.decisions).toEqual(["allow"]);
    expect(r.routeEffects).toBeGreaterThan(0);
  });

  it("foreign origin control: 403, one refusal, zero route effects", async () => {
    const r = await upgradeCase([`Host: 127.0.0.1:${port}`, "Origin: http://evil.example"]);
    console.log("F1-UPGRADE foreign", JSON.stringify(r));
    expect(r.status).toContain("403");
    expect(r.decisions).toEqual(["browser_origin_refused"]);
    expect(r.routeEffects).toBe(0);
  });

  for (const [name, headers, code] of [
    ["duplicate Host", (p: number) => [`Host: 127.0.0.1:${p}`, "Host: evil.example", `Origin: http://127.0.0.1:${p}`], "untrusted_host"],
    ["empty Host", (p: number) => ["Host: ", `Origin: http://127.0.0.1:${p}`], "untrusted_host"],
    ["empty Host, no Origin", (_p: number) => ["Host: "], "untrusted_host"],
    ["empty Origin", (p: number) => [`Host: 127.0.0.1:${p}`, "Origin: "], "browser_origin_refused"],
    ["duplicate Origin", (p: number) => [`Host: 127.0.0.1:${p}`, `Origin: http://127.0.0.1:${p}`, "Origin: http://evil.example"], "browser_origin_refused"],
  ] as const) {
    it(`${name}: refused on the upgrade path with one decision and zero route effects`, async () => {
      const r = await upgradeCase(headers(port));
      console.log(`F1-UPGRADE ${name}`, JSON.stringify(r));
      // workspaces-o9o.125 (verify-sec): @hono/node-server 2 answers an upgrade whose Host it cannot turn into a URL (empty,
      // malformed) with its own 400 before the app runs. The listener's createServer sends such an upgrade through the app
      // first, so the boundary decides it, as it does over plain HTTP.
      expect(r.status).toContain("403");
      expect(r.decisions).toEqual([code]);
      expect(r.routeEffects).toBe(0);
    });
  }

  // workspaces-o9o.125: Hosts the boundary reads as well formed but the URL standard rejects ("1.2.3.4.5"), or that are malformed
  // ("a b", "x@y"), never reach the adapter's own 400 or 500: the boundary decides them.
  for (const host of ["1.2.3.4.5", "a b", "x@y"]) {
    it(`Host ${JSON.stringify(host)}: the boundary refuses the upgrade (403 untrusted_host), once, and nothing runs`, async () => {
      const r = await upgradeCase([`Host: ${host}`, `Origin: http://127.0.0.1:${port}`]);
      expect(r.status).toContain("403");
      expect(r.decisions).toEqual(["untrusted_host"]);
      expect(r.routeEffects).toBe(0);
    });
  }

  // Measured residual (workspaces-o9o.125): an IPv6 literal the URL standard rewrites ([::ffff:127.0.0.1] becomes [::ffff:7f00:1])
  // is one the boundary accepts, so it is not diverted; the adapter refuses it 400 before the app. No refusal is missed and
  // nothing opens; only the boundary's "allow" is never reached.
  it("an IPv6 Host the URL standard rewrites: the adapter refuses it (400), nothing opens, no decision", async () => {
    const r = await upgradeCase([`Host: [::ffff:127.0.0.1]:${port}`, `Origin: http://127.0.0.1:${port}`]);
    expect(r.status).toContain("400");
    expect(r.decisions).toEqual([]);
    expect(r.routeEffects).toBe(0);
  });

  it("the same shapes over plain HTTP are refused as well", async () => {
    for (const headers of [
      [`Host: 127.0.0.1:${port}`, "Host: evil.example"],
      ["Host: "],
      [`Host: 127.0.0.1:${port}`, "Origin: "],
    ]) {
      const status = await rawRequest(port, "GET /api/ps HTTP/1.1", [...headers, "Connection: close"]);
      console.log("F1-HTTP", JSON.stringify(headers), status);
      expect(status).toContain(" 403 ");
    }
  });

  it("genuinely absent Host (HTTP/1.0, non-browser) is still admitted", async () => {
    const status = await rawRequest(port, "GET /api/ps HTTP/1.0", []);
    expect(status).toContain("200");
  });
});

// workspaces-o9o.125: the terminal WebSocket on @hono/node-server 2's own upgradeWebSocket, through the production
// createAppWithWebSocket and its listenerOptions. A daemon that listens beyond loopback carries a terminal token
// (workspaces-o9o.78; the decision is pinned in terminal-token-policy.test.ts): there an upgrade opens only with it. A
// loopback-only daemon has none and opens without one. The boundary (Host, Origin) answers before the token check either way.
describe("o9o.125: the production terminal WebSocket on @hono/node-server 2", () => {
  const TOKEN = "tok-" + "c".repeat(24);
  const ok = async () => ({ ok: true });
  const tmux = () => Object.assign(mockTmuxAdapter(), {
    hasSession: async () => { effects++; return true; },
    setWindowOption: ok, startPipePane: ok, stopPipePane: ok, sendKeys: ok, sendText: ok, resizeWindow: ok,
  });
  let effects = 0;
  const seen: string[] = [];
  const built: Array<{ server: Server; port: number; db: Database.Database }> = [];
  async function start(terminalBearerToken: string | null) {
    const db = createFullTestDb();
    const app = createTestApp(db, {
      tmux: tmux(), withWebSocket: true,
      appDeps: { webUiEnabled: true, terminalBearerToken, browserBoundaryObserver: (d) => seen.push(d.code ?? d.outcome) },
    });
    const { server, port } = await listen(app.app.fetch as Hono["fetch"], app.listenerOptions!());
    built.push({ server, port, db });
    return port;
  }
  let tokened = 0;
  let tokenless = 0;
  beforeAll(async () => { tokened = await start(TOKEN); tokenless = await start(null); });
  afterAll(async () => { for (const b of built) { await close(b.server); b.db.close(); } });

  async function upgrade(port: number, path: string, headers: string[]) {
    const e0 = effects;
    const status = await rawRequest(port, `GET ${path} HTTP/1.1`, [...headers, ...UPGRADE]);
    await settle();
    return { status, effects: effects - e0 };
  }
  const own = (port: number) => [`Host: 127.0.0.1:${port}`, `Origin: http://127.0.0.1:${port}`];

  it("with a terminal token: refused 401 without it or with a wrong one, and opens (101) with it", async () => {
    const none = await upgrade(tokened, "/api/terminal/seat-1", own(tokened));
    const wrong = await upgrade(tokened, `/api/terminal/seat-1?token=${"tok-" + "d".repeat(24)}`, own(tokened));
    const right = await upgrade(tokened, `/api/terminal/seat-1?token=${TOKEN}`, own(tokened));
    console.log("O9O125-TOKEN", JSON.stringify({ none, wrong, right }));
    expect(none.status).toContain("401");
    expect(none.effects).toBe(0);
    expect(wrong.status).toContain("401");
    expect(wrong.effects).toBe(0);
    expect(right.status).toContain("101");
    expect(right.effects).toBeGreaterThan(0);
  });

  it("without a terminal token (loopback only): opens without one", async () => {
    const r = await upgrade(tokenless, "/api/terminal/seat-1", own(tokenless));
    expect(r.status).toContain("101");
    expect(r.effects).toBeGreaterThan(0);
  });

  it("the boundary answers first: an unknown Origin or Host is refused 403 even with the token, and nothing opens", async () => {
    const s0 = seen.length;
    const origin = await upgrade(tokened, `/api/terminal/seat-1?token=${TOKEN}`, [`Host: 127.0.0.1:${tokened}`, "Origin: http://evil.example"]);
    const host = await upgrade(tokened, `/api/terminal/seat-1?token=${TOKEN}`, [`Host: EVIL.EXAMPLE.:${tokened}`]);
    const noTokenOrigin = await upgrade(tokenless, "/api/terminal/seat-1", [`Host: 127.0.0.1:${tokenless}`, "Origin: http://evil.example"]);
    expect(origin.status).toContain("403");
    expect(host.status).toContain("403");
    expect(noTokenOrigin.status).toContain("403");
    expect(origin.effects + host.effects + noTokenOrigin.effects).toBe(0);
    expect(seen.slice(s0)).toEqual(["browser_origin_refused", "untrusted_host", "browser_origin_refused"]);
  });
});

describe("F2: refusal log content on an actual listener", () => {
  const lines: string[] = [];
  let server: Server;
  let port = 0;
  beforeAll(async () => {
    const app = new Hono();
    app.use("/api/*", browserBoundary({ webUiEnabled: false, bearerTokens: [], warn: (l) => lines.push(l) }));
    app.all("/api/*", (c) => c.json({ ok: true }));
    ({ server, port } = await listen(app.fetch));
  });
  afterAll(async () => { await close(server); });

  it("an encoded control character in the path is replaced in the log; a long path is bounded; the query never appears", async () => {
    await rawRequest(port, "GET /api/a%1Bb?token=SECRET HTTP/1.1", ["Host: evil-1.example", "Connection: close"]);
    await rawRequest(port, `GET /api/${"x".repeat(9000)} HTTP/1.1`, ["Host: evil-2.example", "Connection: close"]);
    console.log("F2-LOG", JSON.stringify(lines.map((l) => ({ length: l.length, hasEsc: l.includes("\u001b"), head: l.slice(0, 120) }))));
    expect(lines).toHaveLength(2);
    expect(lines[0]).not.toContain("\u001b");
    expect(lines[0]).toContain("/api/a?b");
    expect(lines[0]).not.toContain("SECRET");
    expect(lines[1]!.length).toBeLessThan(400);
  });
});
