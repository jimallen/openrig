// workspaces-o9o.169: a write whose connection drops after the request may have reached the daemon must not be reported as
// "not delivered": the daemon may have committed it, and a seat told otherwise may redo the work. Only a failure that proves
// nothing was sent (the connection was refused, the name did not resolve, the connection was blocked here) is nondelivery.
// The real DaemonClient against a real HTTP server: the server reads the whole request (the write has arrived) and then drops
// the connection before any reply, the way a daemon that commits and then dies or restarts does.
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonClient, DaemonConnectionError } from "../src/client.js";
import { runProgram } from "../src/cli-error.js";
import { queueCommand, type QueueDeps } from "../src/commands/queue.js";
import { healthCommand, type HealthDeps } from "../src/commands/health.js";
import { printTransportFailureForTest } from "../src/commands/send.js";
import { STATE_FILE, type DaemonState } from "../src/daemon-lifecycle.js";
import { asLifecycleDeps } from "./helpers/mock-lifecycle-deps.js";

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

/** A daemon that receives each request in full, records it, and drops the connection before replying. */
async function droppingDaemon(): Promise<{ url: string; received: Array<{ method?: string; path?: string }> }> {
  const received: Array<{ method?: string; path?: string }> = [];
  const server = createServer(async (req) => {
    for await (const chunk of req) void chunk;
    received.push({ method: req.method, path: req.url });
    req.socket.destroy();
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("the fixture daemon did not bind TCP");
  return { url: `http://127.0.0.1:${address.port}`, received };
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

async function caught(run: () => Promise<unknown>): Promise<DaemonConnectionError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof DaemonConnectionError) return error;
    throw error;
  }
  throw new Error("expected a DaemonConnectionError");
}

describe("o9o.169: the client marks a write it may have delivered as an unknown outcome", () => {
  it.each(["post", "put", "delete"] as const)("%s whose connection drops after the daemon read it: writeOutcome is unknown", async (method) => {
    const daemon = await droppingDaemon();
    const client = new DaemonClient(daemon.url);
    const error = await caught(() => method === "delete" ? client.delete("/api/x") : client[method]("/api/x", { a: 1 }));
    expect(daemon.received).toEqual([{ method: method.toUpperCase(), path: "/api/x" }]);
    expect(error.writeOutcome).toBe("unknown");
  });

  it("a read whose connection drops changes nothing: it is not marked as a write", async () => {
    const daemon = await droppingDaemon();
    const error = await caught(() => new DaemonClient(daemon.url).get("/api/x"));
    expect(daemon.received).toHaveLength(1);
    expect(error.writeOutcome).toBeUndefined();
  });

  // The whole rule, cause by cause: only a connection that was never made proves nothing was sent. Codes the kernel can also
  // report on a socket that already sent the request (route loss, an interface going down, a firewall change) do not.
  const cases: Array<[string | undefined, "unknown" | undefined]> = [
    ["ECONNREFUSED", undefined], ["ENOTFOUND", undefined], ["EAI_AGAIN", undefined], ["EADDRNOTAVAIL", undefined],
    ["UND_ERR_CONNECT_TIMEOUT", undefined], ["ERR_INVALID_URL", undefined],
    ["ECONNRESET", "unknown"], ["UND_ERR_SOCKET", "unknown"], ["EPIPE", "unknown"], ["EHOSTUNREACH", "unknown"],
    ["ENETUNREACH", "unknown"], ["EHOSTDOWN", "unknown"], ["ENETDOWN", "unknown"], ["EPERM", "unknown"], ["EACCES", "unknown"],
    [undefined, "unknown"],
  ];
  it.each(cases)("a write failing with cause %s: writeOutcome %s", async (code, expected) => {
    const failing: typeof fetch = async () => {
      throw Object.assign(new TypeError("fetch failed"), code === undefined ? {} : { cause: Object.assign(new Error(code), { code }) });
    };
    const error = await caught(() => new DaemonClient("http://127.0.0.1:9", { fetchImpl: failing }).post("/api/x", {}));
    expect(error.causeCode).toBe(code);
    expect(error.writeOutcome).toBe(expected);
  });

  // Real fetch refuses a port on its bad-port list before connecting, with no OS code (measured, Node 22 undici: ports 1 and 9:
  // TypeError "fetch failed", cause.message "bad port"). The cli test fetch guard intercepts such ports first, so the shape is injected.
  it("a write to a port fetch itself refuses (its bad-port list, no OS code) was not sent", async () => {
    const badPort: typeof fetch = async () => { throw Object.assign(new TypeError("fetch failed"), { cause: new Error("bad port") }); };
    const error = await caught(() => new DaemonClient("http://127.0.0.1:1", { fetchImpl: badPort }).post("/api/x", { a: 1 }));
    expect(error.causeCode).toBeUndefined();
    expect(error.writeOutcome).toBeUndefined();
  });

  it("a write to a port that refuses the connection was provably not sent: it stays not delivered", async () => {
    const error = await caught(async () => new DaemonClient(await closedPort()).post("/api/x", { a: 1 }));
    expect(error.causeCode).toBe("ECONNREFUSED");
    expect(error.writeOutcome).toBeUndefined();
  });
});

describe("o9o.169: every queue write verb on one item says UNKNOWN and names the re-read when the connection drops", () => {
  const ID = "qitem-20261118-o169";
  const verbs: Array<[string, string[]]> = [
    ["claim", ["claim", ID]],
    ["unclaim", ["unclaim", ID]],
    ["update", ["update", ID, "--state", "done", "--closure-reason", "no-follow-on"]],
    ["block", ["block", ID, "--on", "human@kernel"]],
    ["resolve", ["resolve", ID, "--decision", "go"]],
    ["handoff", ["handoff", ID, "--to", "next@rig"]],
    ["handoff-and-complete", ["handoff-and-complete", ID, "--to", "next@rig"]],
    ["fallback", ["fallback", ID, "--destination", "next@rig"]],
  ];

  it.each(verbs)("rig queue %s", async (_verb, args) => {
    const daemon = await droppingDaemon();
    vi.stubEnv("OPENRIG_SESSION_NAME", "seat@rig");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const printed: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...line: unknown[]) => { printed.push(line.join(" ")); });
    const deps: QueueDeps = {
      lifecycleDeps: asLifecycleDeps({
        fetch: async () => ({ ok: true }), readFile: () => null, exists: () => false, isProcessAlive: () => false,
      }),
      clientFactory: () => new DaemonClient(daemon.url),
    };
    const program = new Command();
    program.addCommand(queueCommand(deps));
    const code = await runProgram(program, ["node", "rig", "queue", ...args], {
      out: (line) => printed.push(line), err: (line) => printed.push(line), exit: () => {},
    });
    const output = printed.join("\n");

    expect(daemon.received.map((r) => r.method)).toEqual(["POST"]); // the write reached the daemon
    expect(code).not.toBe(0);
    expect(output).toContain("outcome is UNKNOWN");
    expect(output).not.toContain("was not delivered");
    expect(output).toContain(`Re-read with 'rig queue show '${ID}' --json' before any retry`);
  });

  it("a queue write whose connection was refused was not delivered, and is not called indeterminate (control)", async () => {
    const url = await closedPort();
    vi.stubEnv("OPENRIG_SESSION_NAME", "seat@rig");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const printed: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...line: unknown[]) => { printed.push(line.join(" ")); });
    const deps: QueueDeps = {
      lifecycleDeps: asLifecycleDeps({ fetch: async () => ({ ok: true }), readFile: () => null, exists: () => false, isProcessAlive: () => false }),
      clientFactory: () => new DaemonClient(url),
    };
    const program = new Command();
    program.addCommand(queueCommand(deps));
    await runProgram(program, ["node", "rig", "queue", "claim", ID], { out: (l) => printed.push(l), err: (l) => printed.push(l), exit: () => {} });
    const output = printed.join("\n");
    expect(output).toContain("The command was not delivered.");
    expect(output).not.toContain("INDETERMINATE");
    expect(output).not.toContain("UNKNOWN");
  });
});

describe("o9o.169: rig send and rig broadcast say UNCONFIRMED, not \"not sent\", when the request may have arrived", () => {
  function rendered(error: DaemonConnectionError): string {
    const printed: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...line: unknown[]) => { printed.push(line.join(" ")); });
    printTransportFailureForTest(error);
    return printed.join("\n");
  }

  it("a send whose connection drops after the daemon read it: delivery UNCONFIRMED", async () => {
    const daemon = await droppingDaemon();
    const text = rendered(await caught(() => new DaemonClient(daemon.url).post("/api/transport/send", { session: "a@r", text: "hi" })));
    expect(daemon.received).toHaveLength(1);
    expect(text).toContain("Delivery UNCONFIRMED");
    expect(text).not.toContain("was not sent");
  });

  it("a send whose connection was refused was not sent", async () => {
    const text = rendered(await caught(async () => new DaemonClient(await closedPort()).post("/api/transport/send", { session: "a@r", text: "hi" })));
    expect(text).toContain("The message was not sent.");
  });
});

describe("o9o.169: every rig health write names its re-read when its reply is lost; a read is unchanged", () => {
  const ID = "qitem-health-o169";
  let scratch = "";
  afterEach(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); scratch = ""; });
  function jsonFile(): string {
    scratch = mkdtempSync(join(tmpdir(), "o169-health-"));
    const file = join(scratch, "in.json");
    writeFileSync(file, "{}");
    return file;
  }
  const writes: Array<[string, () => string[], string]> = [
    ["policy --file", () => ["policy", "--file", jsonFile(), "--json"], "rig health policy --json"],
    ["checkpoint --file", () => ["checkpoint", "--file", jsonFile(), "--json"], "rig health checkpoint --json"],
    ["diagnose --apply", () => ["diagnose", "--apply", "--json"], "rig health diagnosis list --json"],
    ["diagnosis record", () => ["diagnosis", "record", ID, "--file", jsonFile(), "--json"], `rig health diagnosis show '${ID}' --json`],
    ["diagnosis notify", () => ["diagnosis", "notify", ID, "--json"], `rig health diagnosis show '${ID}' --json`],
  ];

  async function runHealth(args: string[]): Promise<{ error?: string; nextInspection?: string; received: number }> {
    const daemon = await droppingDaemon();
    const state: DaemonState = { pid: 123, port: 7433, db: "test.sqlite", startedAt: "2026-11-18T00:00:00Z" };
    const deps: HealthDeps = {
      lifecycleDeps: asLifecycleDeps({
        exists: (path: string) => path === STATE_FILE,
        readFile: (path: string) => path === STATE_FILE ? JSON.stringify(state) : null,
        fetch: async () => ({ ok: true }), isProcessAlive: () => true,
      }),
      clientFactory: () => new DaemonClient(daemon.url),
      resolveIdentity: () => ({ sessionName: "seat@rig" }),
    };
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...line: unknown[]) => { lines.push(line.join(" ")); });
    vi.spyOn(console, "error").mockImplementation((...line: unknown[]) => { lines.push(line.join(" ")); });
    const program = new Command();
    program.exitOverride();
    program.addCommand(healthCommand(deps));
    await program.parseAsync(["node", "rig", "health", ...args]);
    const parsed: { error?: string; nextInspection?: string } = JSON.parse(lines.find((l) => l.trim().startsWith("{")) ?? "{}");
    return { ...parsed, received: daemon.received.length };
  }

  it.each(writes)("rig health %s", async (_name, args, recheck) => {
    const result = await runHealth(args());
    expect(result.received).toBe(1);
    expect(result.error).toBe("health_write_outcome_unknown");
    expect(result.nextInspection).toBe(recheck);
  });

  it("a read whose connection drops is still daemon_unavailable (control)", async () => {
    const result = await runHealth(["diagnosis", "show", ID, "--json"]);
    expect(result.received).toBe(1);
    expect(result.error).toBe("health_daemon_unavailable");
  });
});
