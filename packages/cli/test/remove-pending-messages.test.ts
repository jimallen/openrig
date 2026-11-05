// OF-209: `rig remove` said "rerouted []" and nothing about the seat messages still open for the seat it removed (the daemon now reports them
// as `pendingMessageIds` and leaves them open for a successor). The human output names them and what happens next; JSON carries the ids.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type DaemonState } from "../src/daemon-lifecycle.js";
import { removeCommand } from "../src/commands/remove.js";
import { shrinkCommand } from "../src/commands/shrink.js";
import { releaseCommand } from "../src/commands/release.js";
import type { StatusDeps } from "../src/commands/status.js";

const RESPONSES: Record<string, unknown> = {
  "DELETE /api/rigs/rig-1/pods/crew": {
    ok: true, status: "ok", rigId: "rig-1", podId: "pod-1", namespace: "crew", removedLogicalIds: ["dev.a", "dev.b"], sessionsKilled: 2, reroutedQitemIds: [],
    pendingMessageIds: ["a1", "b1"], heldMessageIds: ["h1"], nodes: [],
  },
  "DELETE /api/rigs/rig-1/pods/empty": {
    ok: true, status: "ok", rigId: "rig-1", podId: "pod-2", namespace: "empty", removedLogicalIds: ["dev.c"], sessionsKilled: 1, reroutedQitemIds: [],
    pendingMessageIds: [], heldMessageIds: [], nodes: [],
  },
  "DELETE /api/rigs/rig-1/pods/half": {
    ok: true, status: "partial", rigId: "rig-1", podId: "pod-3", namespace: "half", removedLogicalIds: ["dev.a"], sessionsKilled: 1, reroutedQitemIds: [],
    pendingMessageIds: ["a1"], heldMessageIds: [], nodes: [{ nodeId: "n1", logicalId: "dev.a", status: "removed", sessionsKilled: 1 }, { nodeId: "n2", logicalId: "dev.b", status: "failed", sessionsKilled: 0, error: "kill failed" }],
  },
  "POST /api/rigs/rig-1/release": {
    ok: true, status: "ok", rigId: "rig-1", deleted: true, released: [{ nodeId: "n1", logicalId: "dev.a", sessionId: "s1", sessionName: "dev-a@rig-1" }], failed: [],
    pendingMessageIds: ["r1"], heldMessageIds: ["h9"],
  },
  "POST /api/rigs/rig-2/release": {
    ok: true, status: "ok", rigId: "rig-2", deleted: false, released: [], failed: [], pendingMessageIds: [], heldMessageIds: [],
  },
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

  // OF-211: the same report for `rig shrink` (members removed through the same path, so their messages wait too) and `rig release --delete`
  // (a deleted rig keeps no seat for a successor, so its messages are returned: the words differ, the ids are reported).
  it("shrink names the pending and held messages and says they wait for a successor", async () => {
    const { output, exitCode } = await run(shrinkCommand(deps()), ["shrink", "rig-1", "crew"]);
    expect(exitCode).toBeUndefined();
    expect(output).toContain("Removed pod crew from rig rig-1");
    expect(output).toContain("2 message(s) still waiting for the removed seats of pod crew: a1, b1.");
    expect(output).toContain("go, labelled, to a seat added later at the same address");
    expect(output).toContain("only if rig rig-1 is archived first");
    expect(output).toContain("1 message(s) held by the typing guard for the removed seats of pod crew: h1.");
  });
  it("shrink names them on a partial result too", async () => {
    const { output, exitCode } = await run(shrinkCommand(deps()), ["shrink", "rig-1", "half"]);
    expect(exitCode).toBe(1);
    expect(output).toContain("1 message(s) still waiting for the removed seats of pod half: a1.");
  });
  it("shrink: the return to senders is conditional on archiving the rig AND on a queue reaching the sender", async () => {
    const { output } = await run(shrinkCommand(deps()), ["shrink", "rig-1", "half"]);
    expect(output).toContain("they go back to their senders, where a queue can reach them, only if rig rig-1 is archived first");
  });
  it("shrink control: says nothing about messages when none wait", async () => {
    const { output } = await run(shrinkCommand(deps()), ["shrink", "rig-1", "empty"]);
    expect(output).toContain("Removed pod empty from rig rig-1");
    expect(output).not.toContain("message(s)");
  });
  // OF-236 e (review of211 N2): "they go back to their senders" is true only where a queue can reach the sender (daemon: QueueSenderReturn.hasQueue: a `name@rig`
  // sender whose rig exists, not `@system`, not `daemon@kernel`); otherwise the message ends on its row with its text kept and nobody told. The text says so.
  it("release --delete names the open messages and says they go back to their senders only where a queue can reach the sender", async () => {
    const { output, exitCode } = await run(releaseCommand(deps()), ["release", "rig-1", "--delete"]);
    expect(exitCode).toBeUndefined();
    expect(output).toContain("1 message(s) were still open for the seats of rig rig-1: r1.");
    expect(output).toContain("each goes back to its sender where a queue can reach the sender");
    expect(output).toContain("otherwise it ends on its row, text kept, and nobody is told");
    expect(output, "no unconditional promise of a return").not.toMatch(/they go back to their senders[.:]|They go back to their senders too/);
    expect(output).toContain("1 message(s) held by the typing guard for the seats of rig rig-1: h9.");
    expect(output).toContain("They are returned or kept on the same terms.");
  });
  it("release control: says nothing about messages when none were open", async () => {
    const { output } = await run(releaseCommand(deps()), ["release", "rig-2"]);
    expect(output).toContain("Released 0 claimed session(s) from rig rig-2");
    expect(output).not.toContain("message(s)");
  });
});
