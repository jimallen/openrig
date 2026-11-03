// OF-209: `rig remove` said "rerouted []" and nothing about the seat messages still open for the seat it removed (the daemon now reports them
// as `pendingMessageIds` and leaves them open for a successor). The human output names them and what happens next; JSON carries the ids.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type DaemonState } from "../src/daemon-lifecycle.js";
import { removeCommand } from "../src/commands/remove.js";
import type { StatusDeps } from "../src/commands/status.js";

const RESPONSES: Record<string, unknown> = {
  "DELETE /api/rigs/rig-1/nodes/verify.ops": {
    ok: true, rigId: "rig-1", nodeId: "node-9", logicalId: "verify.ops", sessionsKilled: 1, reroutedQitemIds: [], pendingMessageIds: ["1d1c6820", "5a7d140b"], heldMessageIds: ["h1"],
  },
  "DELETE /api/rigs/rig-1/nodes/dev.impl": {
    ok: true, rigId: "rig-1", nodeId: "node-1", logicalId: "dev.impl", sessionsKilled: 1, reroutedQitemIds: [], pendingMessageIds: [], heldMessageIds: [],
  },
};

describe("OF-209 rig remove reports the seat messages still waiting", () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const body = RESPONSES[`${req.method} ${req.url}`];
      res.writeHead(body ? 200 : 404, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body ?? { error: "not found" }));
    });
    await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => { server.close(); });

  function deps(): StatusDeps {
    return {
      lifecycleDeps: {
        spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never),
        fetch: vi.fn(async () => ({ ok: true })),
        kill: vi.fn(() => true),
        readFile: vi.fn((p: string) => p === STATE_FILE
          ? JSON.stringify({ pid: 123, port, db: "test.sqlite", startedAt: "2026-09-30T00:00:00Z" } as DaemonState)
          : null),
        writeFile: vi.fn(),
        removeFile: vi.fn(),
        exists: vi.fn((p: string) => p === STATE_FILE),
        mkdirp: vi.fn(),
        openForAppend: vi.fn(() => 3),
        isProcessAlive: vi.fn(() => true),
      },
      clientFactory: () => new DaemonClient(`http://127.0.0.1:${port}`),
    };
  }

  async function run(command: Command, args: string[]): Promise<{ output: string; exitCode: number | undefined }> {
    const logs: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.join(" ")); });
    const err = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { logs.push(a.join(" ")); });
    process.exitCode = undefined;
    const program = new Command();
    program.exitOverride();
    program.addCommand(command);
    try {
      await program.parseAsync(["node", "rig", ...args]);
      return { output: logs.join("\n"), exitCode: process.exitCode };
    } finally {
      log.mockRestore();
      err.mockRestore();
      process.exitCode = undefined;
    }
  }

  it("names the pending messages and says they wait for a successor", async () => {
    const { output, exitCode } = await run(removeCommand(deps()), ["remove", "rig-1", "verify.ops"]);
    expect(exitCode).toBeUndefined();
    expect(output).toContain("2 message(s) still waiting for verify.ops: 1d1c6820, 5a7d140b.");
    expect(output).toContain("go, labelled, to a seat added later at the same address");
    expect(output).toContain("only if rig rig-1 is archived first");
    expect(output).toContain("1 message(s) held by the typing guard for verify.ops: h1.");
  });

  it("control: says nothing about messages when none wait", async () => {
    const { output } = await run(removeCommand(deps()), ["remove", "rig-1", "dev.impl"]);
    expect(output).toContain("Removed node dev.impl from rig rig-1");
    expect(output).not.toContain("message(s)");
  });
});
