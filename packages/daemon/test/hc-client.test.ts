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
  // OF-199: a daemon with no named location joined the account's real core, because the home came from os.homedir() (the passwd
  // entry), not from the env. The env names the location, or there is no socket to talk to.
  it("takes the home from the env's HOME", () => {
    expect(resolveHcSocket({ HOME: "/envhome" })).toBe("/envhome/.local/state/herdr-core/default/default.sock");
  });
  it("takes XDG_STATE_HOME as the location without a HOME", () => {
    expect(resolveHcSocket({ XDG_STATE_HOME: "/st" })).toBe("/st/herdr-core/default/default.sock");
  });
  it("refuses to resolve a socket when the env names no location, instead of asking the passwd entry for the account's home", () => {
    const refusal = (env: NodeJS.ProcessEnv) => { try { resolveHcSocket(env); return null; } catch (e) { return e; } };
    for (const env of [{}, { HOME: "" }, { PATH: "/usr/bin" }]) {
      const error = refusal(env);
      expect(error, JSON.stringify(env)).toBeInstanceOf(HcUnavailableError);
      expect(String((error as Error).message)).toMatch(/HOME/);
    }
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

// A unit row that always runs for the launch-block lifecycle (security review, mutant M10: removing the clear survived because its only
// pin, hc-launch-refusal.real.test.ts, skips without both hc builds). `rig health` shows the block until a launch succeeds.
describe("HcClient launch block", () => {
  const refuseOrRun = (fail: { run: boolean }) => (method: string, _p: Record<string, unknown>, id: number, socket: Socket) => {
    if (method === "terminal.run" && fail.run) {
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "no holder", data: { kind: "unavailable" } } })}\n`);
    } else reply(socket, id, { ok: true });
  };

  it("is read as null until a launch is refused, then as the noted message", async () => {
    const path = await fakeCore(refuseOrRun({ run: false }));
    const client = new HcClient(path);
    expect(client.launchBlockedBecause).toBeNull();
    client.noteLaunchBlocked("the core has no holder");
    expect(client.launchBlockedBecause).toBe("the core has no holder");
  });

  it("is cleared by the next terminal.run that succeeds, and by nothing else", async () => {
    const path = await fakeCore(refuseOrRun({ run: false }));
    const client = new HcClient(path);
    client.noteLaunchBlocked("the core has no holder");
    await client.call("terminal.get", { terminal: "t1" });
    await client.call("terminal.list", {});
    expect(client.launchBlockedBecause, "reads do not clear it").toBe("the core has no holder");
    await client.call("terminal.run", { argv: ["sh"] });
    expect(client.launchBlockedBecause, "a launch that succeeded does").toBeNull();
  });

  it("is kept when the launch itself fails", async () => {
    const fail = { run: true };
    const path = await fakeCore(refuseOrRun(fail));
    const client = new HcClient(path);
    client.noteLaunchBlocked("the core has no holder");
    await expect(client.call("terminal.run", { argv: ["sh"] })).rejects.toBeInstanceOf(HcError);
    expect(client.launchBlockedBecause).toBe("the core has no holder");
  });
});
