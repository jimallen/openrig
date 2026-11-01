// hc cutover (QA N3): the daemon keeps the core watch it starts, and a refusal that arrives after the first attempt is not
// silent. A core swapped or upgraded under a running daemon refuses the daemon's client, so its calls read as an UNAVAILABLE
// core (never "gone"), instead of the daemon carrying on against a core this build was not written for.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HC_GENERATION, HcClient, HcError, HcUnavailableError } from "../src/adapters/hc-client.js";
import { connectHcCore, type HcCoreWatch } from "../src/adapters/hc-core-watch.js";

const hello = (over: Record<string, unknown> = {}) => ({
  generation: HC_GENERATION, version: "0.1.16", core: { id: "core-a", name: "n" }, ...over,
});

/** A core on a unix socket that answers `hello`, `events.subscribe` and one probe method. */
class ScriptedCore {
  readonly dir = mkdtempSync(join(tmpdir(), "hcr-"));
  readonly socketPath = join(this.dir, "core.sock");
  private server: Server | null = null;
  private readonly sockets: Socket[] = [];
  helloReply: Record<string, unknown> = hello();

  async listen(): Promise<void> {
    this.server = createServer((socket) => {
      this.sockets.push(socket);
      socket.setEncoding("utf8");
      socket.on("error", () => undefined);
      let buffer = "";
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
          const message = JSON.parse(buffer.slice(0, end)) as { id: number; method: string };
          buffer = buffer.slice(end + 1);
          const result = message.method === "hello" ? this.helloReply : message.method === "events.subscribe" ? { seq: 0, terminals: [] } : { ok: true };
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
        }
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(this.socketPath, resolve));
  }
  dropConnections(): void { for (const s of this.sockets.splice(0)) s.destroy(); }
  async close(): Promise<void> {
    this.dropConnections();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    rmSync(this.dir, { recursive: true, force: true });
  }
}

const until = async (check: () => boolean, what: string, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("a refusal after the daemon started", () => {
  const cores: ScriptedCore[] = [];
  const watches: HcCoreWatch[] = [];
  afterEach(async () => {
    for (const w of watches.splice(0)) w.stop();
    for (const c of cores.splice(0)) await c.close();
  });

  async function connected() {
    const core = new ScriptedCore();
    cores.push(core);
    await core.listen();
    const client = new HcClient(core.socketPath);
    const log: string[] = [];
    const watch = await connectHcCore({ socketPath: core.socketPath, env: { OPENRIG_HC_NO_START_CORE: "1" }, client, log: (m) => log.push(m) });
    watches.push(watch);
    expect(watch.state()).toBe("streaming");
    return { core, client, watch, log };
  }

  it("a core swapped under the running daemon refuses the client: its calls fail as an unavailable core, not as a gone seat", async () => {
    const { core, client, watch, log } = await connected();
    await expect(client.call("probe")).resolves.toEqual({ ok: true });  // control: before the swap the client talks to the core
    core.helloReply = hello({ core: { id: "core-b", name: "n" } });
    core.dropConnections();
    await until(() => watch.state() === "refused", "the refusal");
    const failure = await client.call("probe").catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(HcUnavailableError);
    expect(failure).not.toBeInstanceOf(HcError);  // an HcError of kind not_found is how a gone terminal reads
    expect((failure as Error).message).toMatch(/refused/);
    expect(client.refusedBecause).toMatch(/not the one this daemon first saw/);
    expect(log.some((line) => line.includes('"kind":"refused"'))).toBe(true);
  });

  it("a core upgraded to another version refuses the client the same way", async () => {
    const { core, client, watch } = await connected();
    core.helloReply = hello({ version: "9.9.9" });
    core.dropConnections();
    await until(() => watch.state() === "refused", "the refusal");
    await expect(client.call("probe")).rejects.toBeInstanceOf(HcUnavailableError);
    expect(client.refusedBecause).toMatch(/9\.9\.9/);
  });

  it("a core that is merely down never refuses the client", async () => {
    const { core, client, watch } = await connected();
    await core.close();
    cores.splice(0);  // closed already
    await until(() => watch.state() === "reconnecting", "the loss");
    expect(client.refusedBecause).toBeNull();
    const failure = await client.call("probe").catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(HcUnavailableError);
    expect((failure as Error).message).not.toMatch(/refused/);
  });
});

describe("the daemon keeps the watch (source pins: startServer binds ports, so its shutdown list is not run here)", () => {
  const read = (rel: string) => readFileSync(join(__dirname, "..", "src", rel), "utf8");
  it("startup.ts keeps what connectHcCore returns and passes its own client", () => {
    const startup = read("startup.ts");
    expect(startup).toMatch(/const hcCoreWatch = hcClient \? await connectHcCore\(\{ socketPath: hcClient\.socketPath, client: hcClient, onCoreVersion: /);
    expect(startup).toMatch(/return \{ app, db, deps, contextMonitor, eventLoopMonitor, injectWebSocket, \.\.\.\(hcCoreWatch \? \{ hcCoreWatch \} : \{\}\) \}/);
  });
  it("index.ts stops it in the shutdown phases", () => {
    expect(read("index.ts")).toMatch(/\["hc-core-watch", \(\) => hcCoreWatch\?\.stop\(\)\]/);
  });
});
