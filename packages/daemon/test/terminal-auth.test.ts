import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { transportRoutes } from "../src/routes/transport.js";

function buildApp(bearerToken: string | null): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("sessionTransport" as never, {
      resolveSessions: async () => ({ ok: true, sessions: [{ sessionName: "test", tmuxSession: "test" }] }),
      send: async () => ({ ok: true }),
      capture: async () => ({ ok: true, content: "test output" }),
      broadcast: async () => ({ ok: true, results: [] }),
    });
    await next();
  });
  app.route("/api/transport", transportRoutes({ bearerToken }));
  return app;
}

describe("terminal-token auth on transport routes", () => {
  const TOKEN = "test-terminal-" + "token-abc123";

  describe("with token required", () => {
    const app = buildApp(TOKEN);

    it("POST /send without token returns 401", async () => {
      const res = await app.request("/api/transport/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: "test", text: "hello" }),
      });
      expect(res.status).toBe(401);
    });

    it("POST /send with wrong token returns 401", async () => {
      const res = await app.request("/api/transport/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer wrong-token",
        },
        body: JSON.stringify({ session: "test", text: "hello" }),
      });
      expect(res.status).toBe(401);
    });

    it("POST /send with valid token passes auth", async () => {
      const res = await app.request("/api/transport/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({ session: "test", text: "hello" }),
      });
      expect(res.status).not.toBe(401);
    });

    it("POST /capture without token returns 401", async () => {
      const res = await app.request("/api/transport/capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: "test" }),
      });
      expect(res.status).toBe(401);
    });

    it("POST /capture with valid token passes auth", async () => {
      const res = await app.request("/api/transport/capture", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({ session: "test" }),
      });
      expect(res.status).not.toBe(401);
    });

    it("POST /broadcast without token returns 401", async () => {
      const res = await app.request("/api/transport/broadcast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rig: "test", text: "hello" }),
      });
      expect(res.status).toBe(401);
    });
  });

  describe("with no token (null)", () => {
    const app = buildApp(null);

    it("POST /send passes through without auth", async () => {
      const res = await app.request("/api/transport/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: "test", text: "hello" }),
      });
      expect(res.status).not.toBe(401);
    });
  });
});
