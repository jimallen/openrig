// `rig edge add|list`: what the verb sends, and what the operator reads back.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type DaemonState } from "../src/daemon-lifecycle.js";
import { edgeCommand } from "../src/commands/edge.js";
import { createProgram } from "../src/index.js";
import type { StatusDeps } from "../src/commands/status.js";

describe("rig edge", () => {
  let server: http.Server;
  let port: number;
  let sent: Array<{ method: string; url: string; body: unknown }>;
  let reply: { status: number; body: unknown };

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        sent.push({ method: req.method ?? "", url: req.url ?? "", body: raw ? JSON.parse(raw) : null });
        const summary = req.url === "/api/rigs/summary";
        res.writeHead(summary ? 404 : reply.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(summary ? { error: "none" } : reply.body));
      });
    });
    await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("test server has no port");
    port = address.port;
  });
  afterAll(() => { server.close(); });
  beforeEach(() => { sent = []; reply = { status: 201, body: { ok: true, created: true, edge: { id: "e1", from: "a.b", to: "c.d", kind: "delegates_to" } } }; });

  function deps(): StatusDeps {
    return {
      lifecycleDeps: {
        spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() })), fetch: vi.fn(async () => ({ ok: true })), kill: vi.fn(() => true),
        readFile: vi.fn((p: string) => p === STATE_FILE ? JSON.stringify({ pid: 123, port, db: "test.sqlite", startedAt: "2026-09-30T00:00:00Z" } satisfies DaemonState) : null),
        writeFile: vi.fn(), removeFile: vi.fn(), exists: vi.fn((p: string) => p === STATE_FILE), mkdirp: vi.fn(),
        openForAppend: vi.fn(() => 3), isProcessAlive: vi.fn(() => true),
      },
      clientFactory: () => new DaemonClient(`http://127.0.0.1:${port}`),
    };
  }

  async function run(args: string[]): Promise<{ output: string; exitCode: number | string | undefined }> {
    const logs: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.join(" ")); });
    const err = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { logs.push(a.join(" ")); });
    process.exitCode = undefined;
    const program = new Command();
    program.exitOverride();
    const edge = edgeCommand(deps());
    for (const sub of edge.commands) { sub.exitOverride(); sub.configureOutput({ writeErr: (text) => { logs.push(text); } }); }
    program.addCommand(edge);
    try {
      await program.parseAsync(["node", "rig", "edge", ...args]);
      return { output: logs.join("\n"), exitCode: process.exitCode };
    } finally { log.mockRestore(); err.mockRestore(); process.exitCode = undefined; }
  }
  const posted = () => sent.filter((r) => r.method === "POST");

  it("add posts the seats, the kind, the reason and the operator to the rig's edges route, and says what it did", async () => {
    const { output, exitCode } = await run(["add", "rig-1", "advisor.lead", "queue.worker", "--kind", "escalates_to", "--reason", "pi move", "--operator", "me@kernel"]);
    expect(exitCode).toBeUndefined();
    expect(posted()).toEqual([{ method: "POST", url: "/api/rigs/rig-1/edges", body: { from: "advisor.lead", to: "queue.worker", kind: "escalates_to", reason: "pi move", operator: "me@kernel" } }]);
    expect(output).toBe("Added: advisor.lead escalates_to queue.worker");
  });

  it("add without --kind is refused before anything is sent: no default launch-order edge", async () => {
    await expect(run(["add", "rig-1", "advisor.lead", "queue.worker"])).rejects.toThrow(/--kind/);
    expect(sent).toEqual([]);
  });

  it("add reports an edge that was already there as such", async () => {
    reply = { status: 200, body: { ok: true, created: false, edge: { id: "e1", from: "a", to: "b", kind: "delegates_to" } } };
    const { output, exitCode } = await run(["add", "rig-1", "a", "b", "--kind", "delegates_to"]);
    expect(output).toBe("Already present: a delegates_to b");
    expect(exitCode).toBeUndefined();
  });

  it("add prints the daemon's refusal and exits non-zero", async () => {
    reply = { status: 409, body: { ok: false, code: "would_cycle", message: "Adding x would make the launch order circular" } };
    const { output, exitCode } = await run(["add", "rig-1", "a", "b", "--kind", "delegates_to"]);
    expect(output).toContain("would make the launch order circular");
    expect(exitCode).toBe(1);
  });

  it("list prints one line per edge from the rig's edges route", async () => {
    reply = { status: 200, body: { ok: true, edges: [
      { id: "e1", from: "advisor.lead", to: "queue.worker", kind: "delegates_to" },
      { id: "e2", from: "queue.worker", to: "advisor.lead", kind: "escalates_to" },
    ] } };
    const { output, exitCode } = await run(["list", "rig-1"]);
    expect(sent.filter((r) => r.url === "/api/rigs/rig-1/edges")).toEqual([{ method: "GET", url: "/api/rigs/rig-1/edges", body: null }]);
    expect(output.split("\n")).toEqual(["advisor.lead delegates_to queue.worker", "queue.worker escalates_to advisor.lead"]);
    expect(exitCode).toBeUndefined();
  });

  it("list --json prints the daemon's answer, and an unknown rig exits non-zero", async () => {
    reply = { status: 404, body: { ok: false, code: "rig_not_found", message: "Rig 'x' not found." } };
    const { output, exitCode } = await run(["list", "x", "--json"]);
    expect(JSON.parse(output)).toMatchObject({ code: "rig_not_found" });
    expect(exitCode).toBe(1);
  });

  it("is registered on the rig program, with its edgeDeps seam", () => {
    const edge = createProgram({ edgeDeps: deps() }).commands.find((c) => c.name() === "edge");
    expect(edge?.commands.map((c) => c.name()).sort()).toEqual(["add", "list"]);
  });
});
