import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HC_GENERATION, HcClient, HcError, HcOutcomeUnknownError, HcUnavailableError, resolveHcSocket } from "../src/adapters/hc-client.js";

type Handler = (method: string, params: Record<string, unknown>, id: number, socket: Socket) => void;

const HELLO = { generation: HC_GENERATION, version: "0.1.16", core: { id: "c", name: "n" }, framed: false, methods: [], features: [] };
const scratch: { dir: string; server: Server }[] = [];

function reply(socket: Socket, id: number, result: unknown): void {
  socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

/** A fake core on a private socket: answers hello, then hands every other method to `handler`. */
async function fakeCore(handler: Handler, hello: unknown = HELLO): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "hc-client-"));
  const path = join(dir, "c.sock");
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const message = JSON.parse(buffer.slice(0, end)) as { id: number; method: string; params: Record<string, unknown> };
        buffer = buffer.slice(end + 1);
        if (message.method === "hello") reply(socket, message.id, hello);
        else handler(message.method, message.params, message.id, socket);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  scratch.push({ dir, server });
  return path;
}

afterEach(async () => {
  for (const { dir, server } of scratch.splice(0)) {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveHcSocket", () => {
  it("prefers HC_SOCKET", () => {
    expect(resolveHcSocket({ HC_SOCKET: "/x.sock", XDG_RUNTIME_DIR: "/run" }, "/h")).toBe("/x.sock");
  });
  it("uses the runtime dir and the session on Linux", () => {
    expect(resolveHcSocket({ XDG_RUNTIME_DIR: "/run/user/1", HC_SESSION: "s" }, "/h")).toBe("/run/user/1/herdr-core/s.sock");
  });
  it("uses the state dir without a runtime dir, as macOS has", () => {
    expect(resolveHcSocket({}, "/h")).toBe("/h/.local/state/herdr-core/default/default.sock");
  });
});

describe("HcClient", () => {
  it("returns the result of a call", async () => {
    const path = await fakeCore((method, params, id, socket) => reply(socket, id, { method, params }));
    await expect(new HcClient(path).call("terminal.get", { terminal: "t1" })).resolves.toEqual({ method: "terminal.get", params: { terminal: "t1" } });
  });

  it("reads a reply split across chunks and skips notifications", async () => {
    const path = await fakeCore((_m, _p, id, socket) => {
      const line = `${JSON.stringify({ jsonrpc: "2.0", id, result: "whole" })}\n`;
      socket.write(`${JSON.stringify({ method: "heartbeat", params: { seq: 1 } })}\n`);
      socket.write(line.slice(0, 7));
      setTimeout(() => socket.write(line.slice(7)), 5);
    });
    await expect(new HcClient(path).call("x")).resolves.toBe("whole");
  });

  it("keeps a refusal's kind and hint", async () => {
    const path = await fakeCore((_m, _p, id, socket) => {
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "gone", data: { kind: "not_found", hint: "h" } } })}\n`);
    });
    const err = await new HcClient(path).call("terminal.get").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HcError);
    expect(err).toMatchObject({ kind: "not_found", hint: "h" });
  });

  it("reads a missing socket as unavailable, never as a refusal", async () => {
    const err = await new HcClient("/nonexistent/hc.sock").call("terminal.get").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HcUnavailableError);
  });

  it("reads a core that dies before hello answers as unavailable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hc-client-"));
    const path = join(dir, "c.sock");
    const server = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.listen(path, resolve));
    scratch.push({ dir, server });
    const err = await new HcClient(path).call("terminal.send").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HcUnavailableError);
  });

  it("reads a connection lost after the request as outcome unknown", async () => {
    const path = await fakeCore((_m, _p, _id, socket) => socket.destroy());
    const err = await new HcClient(path).call("terminal.send").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HcOutcomeUnknownError);
    expect(err).toMatchObject({ method: "terminal.send" });
  });

  it("reads a timeout after the request as outcome unknown", async () => {
    const path = await fakeCore(() => {});
    const err = await new HcClient(path).call("terminal.send", {}, { timeoutMs: 20 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HcOutcomeUnknownError);
  });

  it("refuses a core on another generation", async () => {
    const path = await fakeCore(() => {}, { ...HELLO, generation: HC_GENERATION + 1 });
    const err = await new HcClient(path).hello().catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "unsupported_generation" });
  });
});
