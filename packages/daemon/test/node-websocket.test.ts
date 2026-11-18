// workspaces-o9o.125: each listener gets its own WebSocketServer. @hono/node-server 2 closes a listener's WebSocketServer
// when that listener closes, and the daemon can bind several hosts, so a shared one would end every other listener's
// upgrades with the first close. Real listeners, real upgrades, an inert handler.
import { afterAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import { serve, upgradeWebSocket } from "@hono/node-server";
import WebSocket from "ws";
import { newNodeWebSocketOption } from "../src/adapters/node-websocket.js";

type Server = ReturnType<typeof serve>;
const servers: Server[] = [];
afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
});

function listen(app: Hono): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1", websocket: newNodeWebSocketOption() }, (info) => resolve({ server, port: info.port }));
    servers.push(server);
  });
}

const opens = (port: number) => new Promise<boolean>((resolve) => {
  const sock = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  sock.on("open", () => { sock.close(); resolve(true); });
  sock.on("error", () => resolve(false));
  sock.on("unexpected-response", () => resolve(false));
});

describe("newNodeWebSocketOption", () => {
  it("is a fresh, server-less WebSocketServer each time", () => {
    const a = newNodeWebSocketOption();
    const b = newNodeWebSocketOption();
    expect(a.server).not.toBe(b.server);
    expect(a.server.options.noServer).toBe(true);
    a.server.close();
    b.server.close();
  });

  it("closing one listener leaves another listener's upgrades working", async () => {
    const app = new Hono();
    app.get("/ws", upgradeWebSocket(() => ({})));
    const first = await listen(app);
    const second = await listen(app);
    expect(await opens(first.port)).toBe(true);
    expect(await opens(second.port)).toBe(true);
    await new Promise<void>((r) => first.server.close(() => r()));
    servers.splice(servers.indexOf(first.server), 1);
    expect(await opens(second.port)).toBe(true);
    expect((second.server.address() as AddressInfo).port).toBe(second.port);
  });
});
