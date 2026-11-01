// hc cutover W41 (security F5): `POST /api/terminal/open` and the rig alias act on the running Herdr app (new spaces, writable
// viewer panes), so with a terminal bearer configured they require it, as the removed open-cmux route did. The read routes
// (views, preview, status) stay open. Measured before the fix: no Authorization -> 200 and the provider reached.
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { terminalRoutes, rigTerminalRoutes } from "../src/routes/terminal.js";

const TOKEN = "t0ken-for-the-terminal-guard-0123456789";

function makeApp(token: string | null) {
  const opened: string[] = [];
  const service = {
    openView: async (req: { view: string }) => { opened.push(req.view); return { provider: "herdr", ok: true, opened: [req.view], absent: [], degraded: [], pages: 1 }; },
    listViews: async () => ({ saved: [], rigs: [] }),
    status: async () => ({ providers: [] }),
    previewView: async () => ({ planId: "p" }),
  };
  const app = new Hono();
  app.use("*", async (c, next) => {
    (c.set.bind(c) as (k: string, v: unknown) => void)("terminalService", service);
    (c.set.bind(c) as (k: string, v: unknown) => void)("terminalBearerToken", token);
    await next();
  });
  app.route("/api/terminal", terminalRoutes());
  app.route("/api/rigs/:rigId/terminal", rigTerminalRoutes);
  return { app, opened };
}
const post = (app: Hono, path: string, authorization?: string) => app.request(path, {
  method: "POST", body: JSON.stringify({ view: "acme" }),
  headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
});

describe.each(["/api/terminal/open", "/api/rigs/r1/terminal/open"])("POST %s with a terminal bearer configured", (path) => {
  it("refuses a request with no Authorization, and the provider is never reached", async () => {
    const { app, opened } = makeApp(TOKEN);
    expect((await post(app, path)).status).toBe(401);
    expect(opened).toEqual([]);
  });
  it("refuses a wrong token and a wrong scheme", async () => {
    const { app, opened } = makeApp(TOKEN);
    expect((await post(app, path, "Bearer wrong")).status).toBe(401);
    expect((await post(app, path, `Basic ${TOKEN}`)).status).toBe(401);
    expect(opened).toEqual([]);
  });
  it("accepts the right token", async () => {
    const { app, opened } = makeApp(TOKEN);
    expect((await post(app, path, `Bearer ${TOKEN}`)).status).toBe(200);
    expect(opened).toHaveLength(1);
  });
  it("with no token configured (a loopback bind) stays open", async () => {
    const { app, opened } = makeApp(null);
    expect((await post(app, path)).status).toBe(200);
    expect(opened).toHaveLength(1);
  });
});

describe("the read routes stay open under a configured bearer", () => {
  it.each(["/api/terminal/views", "/api/terminal/status", "/api/terminal/preview?view=acme"])("GET %s", async (path) => {
    const { app } = makeApp(TOKEN);
    expect((await app.request(path)).status).toBe(200);
  });
});
