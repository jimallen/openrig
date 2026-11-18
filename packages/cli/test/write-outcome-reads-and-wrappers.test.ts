// workspaces-o9o.169, attempt 2 (verify-qa FAIL at a7bfc7184). A write is defined by what it does, not by its HTTP method:
// (1) a POST that only reads must not report an unknown write outcome; (2) every write path keeps UNKNOWN plus the exact
// re-read; (3) a failure that proves nothing was sent (refused, fetch's own bad-port refusal) is never UNKNOWN, in the wrapper
// paths too; (4) the raw daemon POST writers (host pairing, startup proof) follow the same rule.
// The real DaemonClient against a real HTTP server that reads each request in full, then drops the connection before replying.
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DaemonClient, DaemonConnectionError } from "../src/client.js";
import { runProgram } from "../src/cli-error.js";
import { captureCommand } from "../src/commands/capture.js";
import { broadcastCommand } from "../src/commands/broadcast.js";
import { sendCommand } from "../src/commands/send.js";
import { queueCommand } from "../src/commands/queue.js";
import { hostCommand } from "../src/commands/host.js";
import { startupProofCommand } from "../src/commands/startup-proof.js";
import { seatCommand } from "../src/commands/seat.js";
import { agentCommand } from "../src/commands/agent.js";
import { createMcpServer } from "../src/mcp-server.js";
import { runRemoteHttpOp } from "../src/remote-host-ops.js";
import { asLifecycleDeps } from "./helpers/mock-lifecycle-deps.js";


// workspaces-o9o.181: the hermetic fixture home is not ~/.openrig, so a daemon status there needs a port this home names, or it
// reads "no daemon" before any fixture daemon is reached. Port 1: every client here is given its fixture's URL, so this port
// only feeds the mocked status probe; a path that missed its URL would land on a dead port, never the default 7433.
beforeEach(() => { vi.stubEnv("OPENRIG_PORT", "1"); });

const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
  for (const server of servers.splice(0)) {
    server.close();
    await once(server, "close");
  }
});

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("the fixture daemon did not bind TCP");
  return `http://127.0.0.1:${address.port}`;
}

/** A daemon that receives each request in full, records it, and drops the connection before replying. */
async function droppingDaemon(): Promise<{ url: string; received: Array<{ method?: string; path?: string }> }> {
  const received: Array<{ method?: string; path?: string }> = [];
  const url = await listen(async (req) => {
    for await (const chunk of req) void chunk;
    received.push({ method: req.method, path: req.url });
    req.socket.destroy();
  });
  return { url, received };
}

/** A daemon that answers reads (the rig lookup a tool does before writing) and drops every write after reading it in full. */
async function droppingWritesDaemon(): Promise<{ url: string; received: Array<{ method?: string; path?: string }> }> {
  const received: Array<{ method?: string; path?: string }> = [];
  const url = await listen(async (req, res) => {
    for await (const chunk of req) void chunk;
    received.push({ method: req.method, path: req.url });
    if (req.method === "GET" && req.url === "/api/rigs/summary") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([{ id: "rig-1", name: "my-rig" }]));
      return;
    }
    req.socket.destroy();
  });
  return { url, received };
}

/** A port nothing listens on: the connection is refused, so nothing was sent. */
async function closedPort(): Promise<string> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  server.close();
  await once(server, "close");
  return `http://127.0.0.1:${address.port}`;
}

/** Real fetch refuses a port on its bad-port list before connecting, with no OS code (measured, Node 22 undici: ports 1 and 9).
 *  The cli test fetch guard intercepts such ports first, so the shape is injected. */
const badPortFetch: typeof fetch = async () => { throw Object.assign(new TypeError("fetch failed"), { cause: new Error("bad port") }); };

async function caught(run: () => Promise<unknown>): Promise<DaemonConnectionError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof DaemonConnectionError) return error;
    throw error;
  }
  throw new Error("expected a DaemonConnectionError");
}

const running = () => asLifecycleDeps({ fetch: async () => ({ ok: true }), readFile: () => null, exists: () => false, isProcessAlive: () => false });

/** Run one command through the shared program runner (and its shared transport-error renderer); everything printed, joined. */
async function run(command: Command, argv: string[]): Promise<{ output: string; code: number }> {
  const printed: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...line: unknown[]) => { printed.push(line.join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...line: unknown[]) => { printed.push(line.join(" ")); });
  const program = new Command();
  program.addCommand(command);
  const returned = await runProgram(program, ["node", "rig", ...argv], { out: (l) => printed.push(l), err: (l) => printed.push(l), exit: () => {} });
  // A command that catches its own error sets process.exitCode instead of throwing; the runner then returns 0.
  const code = returned !== 0 ? returned : Number(process.exitCode ?? 0);
  return { output: printed.join("\n"), code };
}

describe("o9o.169 (1): a POST is a read only if its handler writes no durable state", () => {
  // CoS ruling 2026-11-18 (attempt 3): a POST is a read ONLY if its handler, followed to the end, writes no durable state of any
  // kind (rows, events, files, logs that matter); when in doubt it is a write. These seven were followed through their whole
  // call closure (the per-route chain is on the bead): pure validators, file and settings reads, SELECTs.
  const readRoutes = [
    "/api/agents/validate", "/api/rigs/import/validate", "/api/specs/review/rig", "/api/specs/review/agent",
    "/api/workspace/validate", "/api/workspace/doctor", "/api/wake-resolve", "/api/workspace/doctor?root=x",
  ];
  it.each(readRoutes)("POST %s whose reply is lost: no write outcome", async (route) => {
    const daemon = await droppingDaemon();
    const error = await caught(() => new DaemonClient(daemon.url).post(route, {}));
    expect(daemon.received).toHaveLength(1);
    expect(error.writeOutcome).toBeUndefined();
  });

  // Moved to writes by the ruling (attempt 2 listed them as reads): each handler records something durable, or reaches code the
  // trace could not bound. One row each.
  const movedToWrites = [
    "/api/transport/capture", "/api/bundles/inspect", "/api/packages/validate", "/api/packages/plan", "/api/rigs/import/preflight",
    "/api/workflow/validate", "/api/workflow/compile", "/api/ask", "/api/bootstrap/plan",
    "/api/seat/launch-plan/dev-impl%40my-rig", "/api/seat/restart-plan/dev-impl%40my-rig",
  ];
  it.each(movedToWrites)("POST %s whose reply is lost is an unknown write outcome (moved by the ruling)", async (route) => {
    const daemon = await droppingDaemon();
    const error = await caught(() => new DaemonClient(daemon.url).post(route, {}));
    expect(daemon.received).toHaveLength(1);
    expect(error.writeOutcome).toBe("unknown");
  });

  // Near misses: writes beside a listed read, a longer path, and the write the bootstrap verb sends instead of a plan.
  const writeRoutes = [
    "/api/bundles/install", "/api/bootstrap/apply", "/api/transport/send", "/api/workspace/doctor/extra", "/api/workflow/project",
    "/api/seat/launch/dev-impl%40my-rig", "/api/seat/restart-verify/dev-impl%40my-rig", "/api/projects/reclaim-classifier",
    "/api/proof/judge", "/api/context-packs/library/compose", "/api/seat/handover/dev-impl%40my-rig", "/api/agents/validate/x",
  ];
  it.each(writeRoutes)("POST %s whose reply is lost stays an unknown write outcome", async (route) => {
    const daemon = await droppingDaemon();
    const error = await caught(() => new DaemonClient(daemon.url).post(route, {}));
    expect(daemon.received).toHaveLength(1);
    expect(error.writeOutcome).toBe("unknown");
  });

  it("rig agent validate whose reply is lost says nothing about a write", async () => {
    const daemon = await droppingDaemon();
    const { output, code } = await run(agentCommand({ lifecycleDeps: running(), clientFactory: () => new DaemonClient(daemon.url), readFile: () => "name: impl\n" }),
      ["agent", "validate", "agent.yaml"]);
    expect(daemon.received.map((r) => r.path)).toEqual(["/api/agents/validate"]);
    expect(code).not.toBe(0);
    expect(output).not.toContain("UNKNOWN");
    expect(output).not.toMatch(/write was applied/);
  });

  it("rig capture whose reply is lost is an unknown outcome now (moved by the ruling: a missing pane records a verdict)", async () => {
    const daemon = await droppingDaemon();
    const { output, code } = await run(captureCommand({ lifecycleDeps: running(), clientFactory: () => new DaemonClient(daemon.url) }), ["capture", "dev-impl@my-rig"]);
    expect(daemon.received.map((r) => r.path)).toEqual(["/api/transport/capture"]);
    expect(code).not.toBe(0);
    expect(output).toContain("outcome is UNKNOWN");
  });

  it("rig seat handover --dry-run whose reply is lost is an unknown outcome too (moved by the ruling), as the real handover", async () => {
    for (const extra of [["--dry-run"], []]) {
      const daemon = await droppingDaemon();
      const { output } = await run(seatCommand({ lifecycleDeps: running(), clientFactory: () => new DaemonClient(daemon.url) }),
        ["seat", "handover", "dev-impl@my-rig", "--reason", "context-wall", ...extra]);
      expect(daemon.received.map((r) => r.path)).toEqual(["/api/seat/handover/dev-impl%40my-rig"]);
      expect(output).toContain("UNKNOWN");
    }
  });
});

describe("o9o.169 (2): every write path keeps UNKNOWN and names its exact re-read", () => {
  it("rig send <session>: the re-read names the real session, not a placeholder", async () => {
    const daemon = await droppingDaemon();
    vi.stubEnv("OPENRIG_SESSION_NAME", "seat@rig");
    const { output } = await run(sendCommand({ lifecycleDeps: running(), clientFactory: () => new DaemonClient(daemon.url) }), ["send", "dev-impl@my-rig", "hello"]);
    expect(output).toContain("Delivery UNCONFIRMED");
    expect(output).toContain("rig capture dev-impl@my-rig");
    expect(output).not.toContain("<session>");
  });

  it("rig broadcast --rig: UNKNOWN, and the re-read captures that rig", async () => {
    const daemon = await droppingDaemon();
    vi.stubEnv("OPENRIG_SESSION_NAME", "seat@rig");
    const { output, code } = await run(broadcastCommand({ lifecycleDeps: running(), clientFactory: () => new DaemonClient(daemon.url) }), ["broadcast", "--rig", "my-rig", "hello"]);
    expect(daemon.received.map((r) => r.path)).toEqual(["/api/transport/broadcast"]);
    expect(code).not.toBe(0);
    expect(output).toMatch(/UNKNOWN|UNCONFIRMED/);
    expect(output).toContain("rig capture --rig my-rig");
  });

  it("rig send --pod (the fan-out path): the re-read captures that pod", async () => {
    const daemon = await droppingDaemon();
    vi.stubEnv("OPENRIG_SESSION_NAME", "seat@rig");
    const { output } = await run(sendCommand({ lifecycleDeps: running(), clientFactory: () => new DaemonClient(daemon.url) }), ["send", "--pod", "dev", "hello"]);
    expect(daemon.received.map((r) => r.path)).toEqual(["/api/transport/broadcast"]);
    expect(output).toContain("Delivery UNCONFIRMED");
    expect(output).toContain("rig capture --pod dev");
  });

  it.each([
    ["select", ["host", "select", "local"], "rig config get host.selected --show-source"],
    ["rename", ["host", "rename", "Mac mini 2"], "rig config get host.name --show-source"],
  ])("rig host %s: UNKNOWN, and the re-read reads the config key back", async (_verb, argv, reread) => {
    const daemon = await droppingDaemon();
    vi.stubEnv("OPENRIG_URL", daemon.url);
    const { output, code } = await run(hostCommand(), argv);
    expect(daemon.received.map((r) => r.method)).toEqual(["POST"]);
    expect(code).not.toBe(0);
    expect(output).toContain("outcome is UNKNOWN");
    expect(output).toContain(reread);
  });

  it("rig startup-proof submit: UNKNOWN, and the re-read shows the seat's oriented state", async () => {
    const daemon = await droppingDaemon();
    const env = { OPENRIG_URL: daemon.url, OPENRIG_ACTIVITY_HOOK_TOKEN: "fixture-hook", OPENRIG_SESSION_NAME: "dev-impl@my-rig" };
    const { output, code } = await run(startupProofCommand({ env }), ["startup-proof", "submit", "--challenge-id", "c1", "--answer", "a1"]);
    expect(daemon.received.map((r) => r.path)).toEqual(["/api/activity/hooks"]);
    expect(code).not.toBe(0);
    expect(output).toContain("outcome is UNKNOWN");
    expect(output).toContain("rig ps --nodes --session dev-impl@my-rig --json --fields canonicalSessionName,oriented");
  });

  it("rig startup-proof submit whose connection was refused was not sent (control)", async () => {
    const env = { OPENRIG_URL: await closedPort(), OPENRIG_ACTIVITY_HOOK_TOKEN: "fixture-hook", OPENRIG_SESSION_NAME: "dev-impl@my-rig" };
    const { output } = await run(startupProofCommand({ env }), ["startup-proof", "submit", "--challenge-id", "c1", "--answer", "a1"]);
    expect(output).toContain("was not sent");
    expect(output).not.toContain("UNKNOWN");
  });

  async function mcpCall(url: string, name: string, args: Record<string, unknown>): Promise<string> {
    const server = createMcpServer(new DaemonClient(url));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "o169", version: "1.0.0" });
    await server.connect(serverTransport);
    await mcp.connect(clientTransport);
    try {
      const result = await mcp.callTool({ name, arguments: args });
      const content = result.content as Array<{ type: string; text?: string }>;
      return content.map((c) => c.text ?? "").join("\n");
    } finally {
      await mcp.close();
    }
  }

  it.each([
    ["rig_up", { sourceRef: "/tmp/spec.yaml" }, "rig ps -A"],
    ["rig_down", { rigId: "my-rig" }, "rig ps -A"],
    ["rig_snapshot_create", { rigId: "my-rig" }, "rig snapshot list my-rig"],
    ["rig_restore", { rigId: "my-rig", snapshotId: "snap-1" }, "rig ps --nodes --rig my-rig"],
    ["rig_send", { session: "dev-impl@my-rig", text: "hello" }, "rig capture dev-impl@my-rig"],
    ["rig_chatroom_send", { rigName: "my-rig", body: "hello" }, "rig chatroom history my-rig"],
    ["rig_add", { rigId: "my-rig", podNamespace: "dev", member: { id: "impl2", runtime: "claude-code" } }, "rig ps --nodes --rig my-rig"],
  ])("MCP %s whose reply is lost: the tool result says UNKNOWN and names the re-read", async (tool, args, reread) => {
    const daemon = await droppingWritesDaemon();
    const text = await mcpCall(daemon.url, tool, args);
    expect(daemon.received.filter((r) => r.method === "POST")).toHaveLength(1); // the write reached the daemon
    expect(text).toContain("outcome is UNKNOWN");
    expect(text).toContain(reread);
  });

  it("MCP rig_send whose connection was refused was not delivered (control)", async () => {
    const text = await mcpCall(await closedPort(), "rig_send", { session: "dev-impl@my-rig", text: "hello" });
    expect(text).not.toContain("UNKNOWN");
    expect(text).toContain("not delivered");
  });
});

describe("o9o.169 (3): a failure that proves nothing was sent is never UNKNOWN, in the wrapper paths too", () => {
  it("the client records that nothing was sent, for a refused connection and for fetch's bad-port refusal", async () => {
    const refused = await caught(async () => new DaemonClient(await closedPort()).post("/api/x", {}));
    expect(refused.provablyNotSent).toBe(true);
    const badPort = await caught(() => new DaemonClient("http://127.0.0.1:1", { fetchImpl: badPortFetch }).post("/api/x", {}));
    expect(badPort.provablyNotSent).toBe(true);
    const dropped = await caught(async () => new DaemonClient((await droppingDaemon()).url).post("/api/x", {}));
    expect(dropped.provablyNotSent).toBeUndefined();
  });

  it("rig queue create whose connection was refused was not delivered, never UNKNOWN", async () => {
    const url = await closedPort();
    vi.stubEnv("OPENRIG_SESSION_NAME", "seat@rig");
    const { output } = await run(queueCommand({ lifecycleDeps: running(), clientFactory: () => new DaemonClient(url) }),
      ["queue", "create", "--destination", "next@rig", "--body", "work"]);
    expect(output).toContain("was not delivered");
    expect(output).not.toContain("UNKNOWN");
  });

  it("rig queue create whose reply is lost stays UNKNOWN (control)", async () => {
    const daemon = await droppingDaemon();
    vi.stubEnv("OPENRIG_SESSION_NAME", "seat@rig");
    const { output } = await run(queueCommand({ lifecycleDeps: running(), clientFactory: () => new DaemonClient(daemon.url) }),
      ["queue", "create", "--destination", "next@rig", "--body", "work"]);
    expect(output).toContain("outcome is UNKNOWN");
  });

  it("a remote host op refused by fetch's bad-port list did not arrive: no outcomeUnknown", async () => {
    const result = await runRemoteHttpOp("anon-b", "POST", "/api/transport/send", { session: "a@r", text: "hi" }, {
      clientFactory: (url) => new DaemonClient(url, { fetchImpl: badPortFetch }),
      hostRegistryLoader: () => ({ ok: true, registry: { hosts: [{ id: "anon-b", transport: "http", url: "http://127.0.0.1:1" }] } }),
    }, {});
    expect(result.ok).toBe(false);
    expect(result.outcomeUnknown).toBeUndefined();
  });

  it("a remote host op whose reply is lost may have arrived: outcomeUnknown (control)", async () => {
    const daemon = await droppingDaemon();
    const result = await runRemoteHttpOp("anon-b", "POST", "/api/transport/send", { session: "a@r", text: "hi" }, {
      clientFactory: (url) => new DaemonClient(url),
      hostRegistryLoader: () => ({ ok: true, registry: { hosts: [{ id: "anon-b", transport: "http", url: daemon.url }] } }),
    }, {});
    expect(result.outcomeUnknown).toBe(true);
  });
});
