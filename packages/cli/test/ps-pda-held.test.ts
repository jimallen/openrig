// OF-89: what the daemon reports for a pda seat that holds a message (agentActivity needs_input, reason
// pda_message_held; daemon side: packages/daemon/test/pda-held-visible.test.ts) reaches the operator in `rig ps`,
// in the compact text table (the seat shows as needing input with the reason) and in --json. The CLI renders
// agentActivity generically; this pins that nothing in the rendering hides a pda seat's held reason, and that a pda
// seat that holds nothing shows no reason. Mirrors the ps-compact.test.ts harness.

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { psCommand } from "../src/commands/ps.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

function lifecycleDeps(): LifecycleDeps {
  return {
    spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never),
    fetch: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(() => true),
    readFile: vi.fn(() => null),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn(() => false),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3),
    isProcessAlive: vi.fn(() => true),
  };
}

async function capture(fn: () => Promise<void>): Promise<string[]> {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  try { await fn(); } catch { /* commander throws on exitOverride */ } finally { console.log = origLog; }
  return logs;
}

function pdaNode(logicalId: string, activity: { state: string; reason: string }) {
  return {
    rigId: "rig-p", rigName: "pda-rig", logicalId,
    podId: "pod-lab", podNamespace: "lab",
    canonicalSessionName: `${logicalId.replace(".", "-")}@pda-rig`,
    nodeKind: "agent", runtime: "pda",
    sessionStatus: "running", startupStatus: "ready", restoreOutcome: "n-a", lifecycleState: "running",
    identityVerdict: null, latestError: null, terminalActive: true,
    hasAssignedWork: false, assignedWorkCount: 0, pendingWorkCount: 0, inProgressWorkCount: 0, blockedWorkCount: 0,
    agentActivity: { ...activity, evidenceSource: "runtime_hook", sampledAt: "2026-10-26T12:00:00.000Z", evidence: activity.reason },
  };
}

const NODES = [
  pdaNode("lab.held", { state: "needs_input", reason: "pda_message_held" }),
  pdaNode("lab.fine", { state: "idle", reason: "attached_idle" }),
];

describe("OF-89: rig ps shows a pda seat that holds a message", () => {
  let server: http.Server;
  let port: number;
  let savedSessionName: string | undefined;

  beforeAll(async () => {
    savedSessionName = process.env.OPENRIG_SESSION_NAME;
    delete process.env.OPENRIG_SESSION_NAME;
    server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url?.match(/^\/api\/rigs\/rig-p\/nodes/)) res.end(JSON.stringify(NODES));
      else if (req.url === "/api/ps") {
        res.end(JSON.stringify([{ rigId: "rig-p", name: "pda-rig", rigName: "pda-rig", nodeCount: 2, runningCount: 2, status: "running", lifecycleState: "running", uptime: "1h", latestSnapshot: null }]));
      } else res.end("[]");
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => {
    server.close();
    if (savedSessionName !== undefined) process.env.OPENRIG_SESSION_NAME = savedSessionName;
  });

  function cmd(): Command {
    const deps: StatusDeps = {
      lifecycleDeps: {
        ...lifecycleDeps(),
        exists: vi.fn((p: string) => p === STATE_FILE),
        readFile: vi.fn((p: string) => (p === STATE_FILE
          ? JSON.stringify({ pid: 123, port, db: "test.sqlite", startedAt: "2026-10-26T00:00:00Z" } as DaemonState) : null)),
      },
      clientFactory: (baseUrl) => new DaemonClient(baseUrl),
    };
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(psCommand(deps));
    return prog;
  }

  it("text: the held seat reads needs_input with its reason on the row; the seat that holds nothing carries none", async () => {
    const lines = await capture(async () => { await cmd().parseAsync(["node", "rig", "ps", "--nodes", "-A"]); });
    const held = lines.find((l) => l.includes("lab-held@pda-rig"));
    const fine = lines.find((l) => l.includes("lab-fine@pda-rig"));
    expect(held, lines.join("\n")).toBeDefined();
    expect(held).toContain("needs_input");
    expect(held).toContain("pda_message_held");
    expect(fine).toBeDefined();
    expect(fine).not.toContain("pda_message_held");
    expect(fine).not.toContain("attached_idle"); // an idle seat shows no reason
  });

  it("--json: the held seat's agentActivity carries state needs_input and the reason", async () => {
    const lines = await capture(async () => { await cmd().parseAsync(["node", "rig", "ps", "--nodes", "-A", "--json"]); });
    const nodes = JSON.parse(lines.join("")) as Array<{ canonicalSessionName: string; agentActivity: { state: string; reason?: string } }>;
    expect(nodes.find((n) => n.canonicalSessionName === "lab-held@pda-rig")!.agentActivity).toMatchObject({ state: "needs_input", reason: "pda_message_held" });
    expect(nodes.find((n) => n.canonicalSessionName === "lab-fine@pda-rig")!.agentActivity.state).toBe("idle");
  });
});
