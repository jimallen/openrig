// workspaces-o9o.85: a 401 names the token its own route checks. Terminal-class routes (terminalAuthGuard, and the transport,
// messages and compaction routers) check the daemon's terminal token, but their 401 said "Mission Control auth failed" and told
// the caller to set OPENRIG_AUTH_BEARER_TOKEN, the operator token. Operator routes keep their copy.
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { authBearerTokenMiddleware } from "../src/middleware/auth-bearer-token.js";
import { sessionAdminRoutes } from "../src/routes/sessions.js";
import { transportRoutes } from "../src/routes/transport.js";
import { messageRoutes } from "../src/routes/messages.js";
import { compactionRoutes } from "../src/routes/compaction.js";

const TOKEN = "fixture-" + "terminal-guard-0123456789";

type Body = { error: string; message: string; what_failed: string; why_it_matters: string; what_to_do: string };

function expectTerminalCopy(body: Body): void {
  expect(body.error).toBe("unauthorized");
  expect(body.message).toBe("Terminal auth failed: missing Authorization header");
  expect(body.message).not.toContain("Mission Control");
  expect(body.what_to_do).toContain("OPENRIG_TERMINAL_BEARER_TOKEN");
  expect(body.what_to_do).toContain("<OPENRIG_HOME>/terminal-token");
  // The operator token is named only as the daemon's own fallback on a public bind, never as the thing to set.
  expect(body.what_to_do).not.toMatch(/^Set the auth\.bearerToken/);
  expect(body.what_to_do.indexOf("OPENRIG_TERMINAL_BEARER_TOKEN")).toBeLessThan(body.what_to_do.indexOf("OPENRIG_AUTH_BEARER_TOKEN"));
}

describe("a 401 names the token its own route checks", () => {
  it("terminalAuthGuard (session admin): the terminal token's copy", async () => {
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("terminalBearerToken" as never, TOKEN); await next(); });
    app.route("/api/sessions", sessionAdminRoutes);
    const res = await app.request("/api/sessions/dev1-impl@test-rig/reconcile", { method: "POST" });
    expect(res.status).toBe(401);
    expectTerminalCopy((await res.json()) as Body);
  });

  it.each([
    ["transport", () => transportRoutes({ bearerToken: TOKEN })],
    ["messages", () => messageRoutes({ bearerToken: TOKEN })],
    ["compaction", () => compactionRoutes({ bearerToken: TOKEN })],
  ])("%s routes (the terminal token): the terminal token's copy", async (_name, make) => {
    const app = new Hono();
    app.route("/x", make());
    const res = await app.request("/x/anything", { method: "POST" });
    expect(res.status).toBe(401);
    expectTerminalCopy((await res.json()) as Body);
  });

  it("an operator route keeps the operator token's copy", async () => {
    const app = new Hono();
    app.use("*", authBearerTokenMiddleware({ expectedToken: TOKEN, credential: "operator" }));
    app.get("/", (c) => c.json({ ok: true }));
    const body = (await (await app.request("/")).json()) as Body;
    expect(body.message).toBe("Mission Control auth failed: missing Authorization header");
    expect(body.what_to_do).toContain("OPENRIG_AUTH_BEARER_TOKEN");
    expect(body.what_to_do).not.toContain("OPENRIG_TERMINAL_BEARER_TOKEN");
  });
});
