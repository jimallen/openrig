import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";
import { serve, type ServerType } from "@hono/node-server";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { HcAttach } from "../src/adapters/hc-attach.js";
import { resolveHcSocket, type HcTerminal } from "../src/adapters/hc-client.js";
import { hcTerminalName, SEAT_LABEL } from "../src/adapters/hc-host.js";
import { HcInput } from "../src/adapters/hc-input.js";
import { registerTerminalWs, terminalSizeFrame } from "../src/routes/terminal-ws.js";
import { HC, PrivateCore, waitUntil } from "./helpers/hc-private-core.js";

describe("terminalSizeFrame", () => {
  it("is a JSON text frame the UI recognises whole, restated here rather than imported", () => {
    expect(terminalSizeFrame(90, 27)).toBe('{"type":"size","cols":90,"rows":27}');
    expect(terminalSizeFrame(200, 120)).toBe('{"type":"size","cols":200,"rows":120}');
  });
});

/** The live terminal route over a private hc core: the registry is built from an injected HcTerminalDeps, with no tmux adapter anywhere
 *  on the request. Programs are node scripts. */
describe.skipIf(!HC)("the terminal WebSocket on herdr-core (private core)", () => {
  const core = new PrivateCore();
  let socket: string;
  let server: ServerType;
  let port = 0;

  const logOf = (name: string): string[] => {
    const path = join(core.root, `${name}.log`);
    return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
  };
  const get = (seat: string) => core.client.call<HcTerminal>("terminal.get", { terminal: hcTerminalName(seat) });
  /** A program that logs every byte typed to it as hex, and says it is blocked on a permission dialog (OSC 7501). */
  const PROGRAM = [
    "const fs=require('fs');const log=process.argv[1]+'.log';",
    "process.stdin.setRawMode(true);process.stdin.resume();",
    "process.stdin.on('data',d=>fs.appendFileSync(log,'KEY '+d.toString('hex')+'\\n'));",
    "process.stdout.write('READY\\r\\n');",
    "process.stdout.write('\\x1b]7501;state=blocked:app=stub:kind=permission\\x1b\\\\');",
    "setInterval(()=>{},1e6);",
  ].join("");
  async function launch(seat: string): Promise<void> {
    await core.client.call("terminal.run", {
      argv: [process.execPath, "-e", PROGRAM, join(core.root, seat.split("@")[0]!)], name: hcTerminalName(seat), labels: { [SEAT_LABEL]: seat },
      cwd: core.root, no_parent: true, no_notify: true, outlive_parent: true,
    });
    await waitUntil(async () => (await get(seat)).status?.state, (state) => state === "blocked", `${seat} blocked`);
  }

  /** A client of the route: every message in order. */
  async function connect(seat: string) {
    const messages: string[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/terminal/${encodeURIComponent(seat)}`);
    ws.onmessage = (event) => { if (typeof event.data === "string") messages.push(event.data); };
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("ws failed to open")); });
    return { ws, messages, sizes: () => messages.filter((m) => m.startsWith('{"type":"size"')) };
  }

  beforeAll(async () => {
    core.start();
    socket = resolveHcSocket(core.env, core.env.HOME);
    const app = new Hono();  // no tmuxAdapter is set on the context: the route must not need one
    const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
    registerTerminalWs(app, upgradeWebSocket as never, { bearerToken: null, hc: { client: core.client } });
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    injectWebSocket(server);
    if (!server.listening) await once(server, "listening");
    port = (server.address() as AddressInfo).port;
    await launch("dialog@rig");
  }, 30_000);

  afterAll(async () => {
    const closed = once(server, "close");
    server.close();
    (server as import("node:http").Server).closeAllConnections?.();
    await closed;
    core.stop();
  });

  it("answers a dialog the program is blocked on: a person's keys and text go in (blocked: allow), where a delivery is refused", async () => {
    // The refusal is real: the same terminal refuses the default policy, so the keys below were let through by the route's wiring.
    const refusing = new HcInput(core.client, new HcAttach(socket));
    await expect(refusing.sendKeys("dialog@rig", ["Enter"])).resolves.toMatchObject({ ok: false, code: "seat_blocked" });
    expect(logOf("dialog")).toEqual([]);

    const { ws, messages } = await connect("dialog@rig");
    try {
      await waitUntil(async () => messages.join(""), (text) => text.includes("READY"), "the paint");
      ws.send(JSON.stringify({ type: "keys", keys: ["Enter"] }));
      await waitUntil(async () => logOf("dialog"), (keys) => keys.includes("KEY 0d"), "the Enter");
      ws.send(JSON.stringify({ type: "text", text: "1" }));
      await waitUntil(async () => logOf("dialog"), (keys) => keys.some((k) => k.startsWith("KEY") && k.endsWith("31")), "the typed 1");
    } finally {
      ws.close();
    }
  }, 30_000);

  it("marks a person's typing as human input under the seat's delivery guard, when the daemon has one", async () => {
    const log: string[] = [];
    const guarded = new Hono();
    const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app: guarded });
    registerTerminalWs(guarded, upgradeWebSocket as never, {
      bearerToken: null,
      hc: {
        client: core.client,
        guard: {
          humanInput: async (name, fn) => { log.push(`human:${name}`); const out = await fn(); log.push("human-done"); return out; },
          input: async (name, fn) => { log.push(`input:${name}`); return fn(); },
          checkInput: (name) => { log.push(`check:${name}`); },
        },
      },
    });
    const other = serve({ fetch: guarded.fetch, port: 0, hostname: "127.0.0.1" });
    injectWebSocket(other);
    if (!other.listening) await once(other, "listening");
    const ws = new WebSocket(`ws://127.0.0.1:${(other.address() as AddressInfo).port}/api/terminal/dialog%40rig`);
    try {
      await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("ws failed to open")); });
      ws.send(JSON.stringify({ type: "keys", keys: ["Enter"] }));
      await waitUntil(async () => log, (all) => all.includes("human-done"), "the guarded input");
      expect(log).toEqual(["human:dialog@rig", "input:dialog@rig", "check:dialog@rig", "human-done"]);
    } finally {
      ws.close();
      const closed = once(other, "close");
      other.close();
      (other as import("node:http").Server).closeAllConnections?.();
      await closed;
    }
  }, 30_000);

  it("tells the socket the terminal's size before its first byte, and again when it changes, back to the original when the writer leaves", async () => {
    const terminal = await get("dialog@rig");
    const { ws, messages, sizes } = await connect("dialog@rig");
    try {
      await waitUntil(async () => messages.join(""), (text) => text.includes("READY"), "the paint");
      expect(messages[0]).toBe(terminalSizeFrame(terminal.cols, terminal.rows));  // the size precedes every byte of the paint
      const writer = await new HcAttach(socket).open({ terminal: terminal.address, cols: 100, rows: 30 }, { onData: () => {}, onEnd: () => {} });
      await waitUntil(async () => sizes(), (all) => all.includes(terminalSizeFrame(100, 30)), "the writer's size");
      await writer.detach();
      await waitUntil(async () => sizes().at(-1), (last) => last === terminalSizeFrame(terminal.cols, terminal.rows), "the original size again");
    } finally {
      ws.close();
    }
  }, 30_000);
});
