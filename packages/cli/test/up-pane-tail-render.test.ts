// workspaces-o9o.3 review: a launch that never became ready leaves its pane tail out of every durable store; the daemon
// returns it beside the error (instantiate_error stage detail `paneTails`, a node's `paneTail` on a surviving rig or a
// restore). `rig up` must print it, or the person debugging sees only "pane tail not stored". The stub serves the
// daemon's response shapes; the pin is on the CLI's rendering.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as http from "node:http";
import { Command } from "commander";
import { upCommand } from "../src/commands/up.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type DaemonState, type LifecycleDeps } from "../src/daemon-lifecycle.js";

const TAIL = "[oh-my-zsh] Would you like to update? [Y/n] claude --permission-mode auto";
const ERROR = "Readiness timeout after 30s — harness did not become interactive: x — pane tail not stored";

function mockLifecycleDeps(port: number): LifecycleDeps {
  return {
    spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never),
    fetch: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(() => true),
    readFile: vi.fn((p: string) => p === STATE_FILE
      ? JSON.stringify({ pid: 123, port, db: "test.sqlite", startedAt: "2026-04-20T00:00:00Z" } as DaemonState) : null),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn((p: string) => p === STATE_FILE),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3),
    isProcessAlive: vi.fn(() => true),
  };
}

describe("rig up prints the pane tail of a seat that never became ready (workspaces-o9o.3)", () => {
  let server: http.Server;
  let port: number;
  let reply: { status: number; body: unknown } = { status: 500, body: {} };

  beforeAll(async () => {
    server = http.createServer(async (req, res) => {
      req.resume();
      await new Promise((resolve) => req.on("end", resolve));
      if (req.url === "/api/up" && req.method === "POST") {
        res.writeHead(reply.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(reply.body));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => { server.close(); });

  async function runUp(): Promise<string> {
    const captured: string[] = [];
    const originalExit = process.exitCode;
    vi.spyOn(console, "log").mockImplementation((...args) => captured.push(args.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...args) => captured.push(args.join(" ")));
    try {
      const prog = new Command();
      prog.exitOverride();
      prog.addCommand(upCommand({ lifecycleDeps: mockLifecycleDeps(port), clientFactory: (baseUrl: string) => new DaemonClient(baseUrl),
        preflightExec: async () => "tmux 3.6a" } as never));
      await prog.parseAsync(["node", "rig", "up", "somespec.yaml"]).catch(() => {});
    } finally {
      vi.restoreAllMocks();
      process.exitCode = originalExit;
    }
    return captured.join("\n");
  }

  it("every seat failed: prints each seat's tail from the import_rig stage detail", async () => {
    reply = { status: 500, body: { runId: "r", status: "failed", warnings: [],
      errors: [`all node launches/startups failed — dev.impl: ${ERROR}`],
      stages: [{ stage: "resolve_spec", status: "ok" }, { stage: "import_rig", status: "failed", detail: { code: "instantiate_error", paneTails: [{ logicalId: "dev.impl", paneTail: TAIL }] } }] } };
    expect(await runUp()).toContain(`  dev.impl pane: ${TAIL}`);
  });

  it("every seat needs attention (409): prints each seat's tail after the three-part error (o9o.89)", async () => {
    reply = { status: 409, body: { runId: "r", status: "partial", rigId: "rig-1", warnings: [], errors: ["1 node requires attention"],
      error: { fact: "1 node requires attention", consequence: "rig rig-1 is parked; see rig ps", action: "attach and approve" },
      attentionNodes: [{ logicalId: "dev.impl", reason: "trust_gate" }],
      stages: [{ stage: "import_rig", status: "blocked", detail: { code: "attention_required", attentionNodes: [{ logicalId: "dev.impl", reason: "trust_gate" }],
        paneTails: [{ logicalId: "dev.impl", paneTail: TAIL }] } }] } };
    const out = await runUp();
    expect(out).toContain("1 node requires attention");
    expect(out).toContain(`  dev.impl pane: ${TAIL}`);
  });

  it("one seat failed on a rig that came up: prints its tail from the stage detail's nodes", async () => {
    reply = { status: 200, body: { runId: "r", status: "partial", rigId: "rig-1", warnings: [], errors: [ERROR],
      stages: [{ stage: "import_rig", status: "failed", detail: { rigId: "rig-1", specName: "s", nodes: [
        { logicalId: "dev.impl", status: "launched" },
        { logicalId: "dev.qa", status: "failed", error: ERROR, paneTail: TAIL },
      ] } }] } };
    const out = await runUp();
    expect(out).toContain(`  dev.qa pane: ${TAIL}`);
    expect(out).not.toContain("dev.impl pane:");
  });

  it("a restore: prints a failed seat's tail under its line", async () => {
    reply = { status: 200, body: { status: "restored", rigId: "rig-1", rigName: "r", rigResult: "partially_restored", warnings: [],
      nodes: [{ logicalId: "dev.qa", status: "fresh", paneTail: TAIL }] } };
    expect(await runUp()).toContain(`    pane: ${TAIL}`);
  });

  it("control: nothing is printed for a seat with no tail", async () => {
    reply = { status: 200, body: { status: "restored", rigId: "rig-1", rigName: "r", rigResult: "fully_restored", warnings: [],
      nodes: [{ logicalId: "dev.qa", status: "fresh" }] } };
    expect(await runUp()).not.toContain("pane:");
  });
});
