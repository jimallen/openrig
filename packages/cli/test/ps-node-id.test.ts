// rig ps --nodes --json must show each seat's node row id (the id whoami --node-id and telemetry --node take).
//
// The daemon's node inventory serves BOTH `logicalId` (the pod.member address,
// e.g. "exec.em") and `nodeId` (the nodes-table row id). The compact --json
// projection and the --fields allowlist dropped `nodeId`, so mapping a session to
// its node needed a second command. These tests pin the served shape end to end
// through the real command and a real HTTP fixture, and pin the human-table
// decision (no new column) so a later change to it is deliberate.

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

function depsFor(port: number): StatusDeps {
  return {
    lifecycleDeps: {
      ...lifecycleDeps(),
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) =>
        p === STATE_FILE ? JSON.stringify({ pid: 123, port, db: "t.sqlite", startedAt: "2026-06-19T00:00:00Z" } as DaemonState) : null),
    },
    clientFactory: (baseUrl) => new DaemonClient(baseUrl),
  };
}

let errs: string[] = [];
async function capture(fn: () => Promise<void>): Promise<string[]> {
  const logs: string[] = [];
  errs = [];
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exitCode;
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { errs.push(a.map(String).join(" ")); };
  try { await fn(); } catch { /* exitOverride */ }
  console.log = origLog;
  console.error = origErr;
  process.exitCode = origExit;
  return logs;
}

// Deliberately NOT equal to logicalId, and ULID-shaped, so a mutant that
// projects logicalId (or a constant) into the nodeId slot cannot pass.
const NODE_ID_EM = "01KQ7NODEIDEMXXXXXXXXXXXXX";
const NODE_ID_IMPL = "01KQ7NODEIDIMPLXXXXXXXXXXX";

const node = (logicalId: string, nodeId: string | undefined) => ({
  ...(nodeId === undefined ? {} : { nodeId }),
  rigId: "rig-x",
  rigName: "demo",
  logicalId,
  podId: "pod-1",
  podNamespace: logicalId.split(".")[0],
  canonicalSessionName: `${logicalId.split(".")[1]}@demo`,
  hostSelfId: "host-1",
  nodeKind: "agent",
  runtime: "claude-code",
  model: null,
  sessionStatus: "running",
  startupStatus: "ready",
  restoreOutcome: "n-a",
  lifecycleState: "running",
  tmuxAttachCommand: "tmux attach -t x",
  resumeCommand: "claude --resume y",
  latestError: null,
  hasAssignedWork: false,
  assignedWorkCount: 0,
  pendingWorkCount: 0,
  agentActivity: { state: "idle", reason: "r", evidenceSource: "s", sampledAt: "2026-06-19T12:00:00.000Z", evidence: null },
});

const NODES = [node("exec.em", NODE_ID_EM), node("build.impl", NODE_ID_IMPL)];
const NODES_NO_NODE_ID = [node("exec.em", undefined)];
const PS_DATA = [
  { rigId: "rig-x", name: "demo", rigName: "demo", nodeCount: 2, runningCount: 2, status: "running", lifecycleState: "running", uptime: "1h", latestSnapshot: null },
];

describe("rig ps --nodes — nodeId", () => {
  let server: http.Server;
  let port = 0;
  let servedNodes: unknown[] = NODES;
  let savedSession: string | undefined;

  beforeAll(async () => {
    savedSession = process.env.OPENRIG_SESSION_NAME;
    delete process.env.OPENRIG_SESSION_NAME;
    server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url?.match(/^\/api\/rigs\/rig-x\/nodes/)) res.end(JSON.stringify(servedNodes));
      else if (req.url === "/api/ps") res.end(JSON.stringify(PS_DATA));
      else { res.statusCode = 404; res.end("{}"); }
    });
    await new Promise<void>((r) => server.listen(0, r));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => {
    server.close();
    if (savedSession !== undefined) process.env.OPENRIG_SESSION_NAME = savedSession;
  });

  const run = async (...args: string[]) => {
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(psCommand(depsFor(port)));
    return capture(async () => { await prog.parseAsync(["node", "rig", "ps", "--nodes", "--rig", "demo", ...args]); });
  };

  it("compact --json carries each seat's nodeId next to its logicalId", async () => {
    servedNodes = NODES;
    const rows = JSON.parse((await run("--json")).join(""));
    expect(rows.map((r: Record<string, unknown>) => [r.logicalId, r.nodeId])).toEqual([
      ["exec.em", NODE_ID_EM],
      ["build.impl", NODE_ID_IMPL],
    ]);
  });

  it("compact --json keeps every existing key, in its existing relative order", async () => {
    servedNodes = NODES;
    const [row] = JSON.parse((await run("--json")).join(""));
    const keys = Object.keys(row).filter((k) => k !== "nodeId");
    expect(keys).toEqual([
      "rigId", "rigName", "logicalId", "canonicalSessionName", "hostSelfId", "runtime", "model",
      "sessionStatus", "startupStatus", "oriented", "lifecycleState", "agentActivity",
      "hasAssignedWork", "assignedWorkCount", "pendingWorkCount", "resumeType", "resumeTokenPresent",
      "lastActivity",
    ]);
    // placement: nodeId sits directly after logicalId, in the identity block
    expect(Object.keys(row).slice(0, 4)).toEqual(["rigId", "rigName", "logicalId", "nodeId"]);
  });

  it("an older daemon that serves no nodeId yields null, not a fabricated id", async () => {
    servedNodes = NODES_NO_NODE_ID;
    const [row] = JSON.parse((await run("--json")).join(""));
    expect(row.nodeId).toBeNull();
    expect(row.logicalId).toBe("exec.em");
  });

  it("--full --json still carries nodeId (the raw record)", async () => {
    servedNodes = NODES;
    const rows = JSON.parse((await run("--json", "--full")).join(""));
    expect(rows.map((r: Record<string, unknown>) => r.nodeId)).toEqual([NODE_ID_EM, NODE_ID_IMPL]);
  });

  it("--fields nodeId,logicalId selects nodeId", async () => {
    servedNodes = NODES;
    const out = (await run("--json", "--fields", "logicalId,nodeId")).join("");
    expect(errs.join("\n")).not.toContain("Unknown --fields");
    expect(JSON.parse(out).entries).toEqual([
      { logicalId: "exec.em", nodeId: NODE_ID_EM },
      { logicalId: "build.impl", nodeId: NODE_ID_IMPL },
    ]);
  });

  // Decision pin: the human tables gain no column. The compact table is a pinned
  // token-lean view; the full table already carries the pod.member address as
  // POD + MEMBER; a 26-char row id would blow its fixed 14-col MEMBER-class budget.
  it("human tables do not print the nodeId and keep their header columns", async () => {
    servedNodes = NODES;
    const compact = (await run()).join("\n");
    expect(compact).not.toContain(NODE_ID_EM);
    expect(compact.split("\n")[0]!.trim().split(/\s+/)).toEqual(["RIG", "SESSION", "LIFECYCLE", "ACTIVITY", "WORK", "REASON"]);
    const full = (await run("--full")).join("\n");
    expect(full).not.toContain(NODE_ID_EM);
    expect(full.split("\n")[0]!.trim().split(/\s+/)).toEqual(
      ["RIG", "POD", "MEMBER", "SESSION", "RUNTIME", "MODEL(DECLARED)", "STATUS", "STARTUP", "ORIENTED", "LIFECYCLE", "TERMINAL", "WORK", "ACTIVITY", "CTX", "RESTORE", "ERROR"]);
  });
});
