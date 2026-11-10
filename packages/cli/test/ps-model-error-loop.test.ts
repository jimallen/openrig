// OF-286: verify-qa and verify-sec@eztrack had their model requests cut for hours on 2026-11-10 and `rig ps` showed them busy, nothing else. The daemon
// serves `modelErrorLoop` ({count, total, since, lastAt, lastError, gaveUpAt?, line}) on a Pi or OMP seat flagged as looping on model errors; this pins what
// `rig ps` does with it: the compact table leads the REASON with the line, the wide table says model errors in its trailing cell, --json carries the field only
// on a seat that has it, and the seat's ACTIVITY is what it was (a looping seat is still working). Harness as ps-held-messages.test.ts.

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

const LOOP = { count: 4, total: 11, since: "2031-03-04T04:29:00.000Z", lastAt: "2031-03-04T05:02:00.000Z", lastError: "terminated", line: 'looping on model errors: 11 failed requests since 04:29Z (33m), last "terminated"' };
const HELD = { count: 2, oldestAt: "2031-03-04T10:00:00.000Z", line: "2 held, oldest 6h21m" };

function node(logicalId: string, extra: Record<string, unknown> = {}) {
  return {
    rigId: "rig-p", rigName: "q-rig", logicalId, podId: "pod-lab", podNamespace: "lab",
    canonicalSessionName: `${logicalId.replace(".", "-")}@q-rig`, nodeKind: "agent", runtime: "pi",
    sessionStatus: "running", startupStatus: "ready", restoreOutcome: "n-a", lifecycleState: "running",
    identityVerdict: null, latestError: null, terminalActive: true,
    hasAssignedWork: false, assignedWorkCount: 0, pendingWorkCount: 0, inProgressWorkCount: 0, blockedWorkCount: 0,
    agentActivity: { state: "running", reason: "auto_retry", evidenceSource: "runtime_hook", sampledAt: "2031-03-04T17:10:00.000Z", evidence: null },
    ...extra,
  };
}
const NODES = [node("lab.looping", { modelErrorLoop: LOOP }), node("lab.loopheld", { modelErrorLoop: { ...LOOP, gaveUpAt: "2031-03-04T05:06:00.000Z", line: LOOP.line + "; the runtime gave up at 05:06Z" }, heldMessages: HELD }), node("lab.plain")];

describe("OF-286: rig ps marks a seat looping on model errors", () => {
  let server: http.Server; let port: number; let savedSessionName: string | undefined;
  beforeAll(async () => {
    savedSessionName = process.env.OPENRIG_SESSION_NAME; delete process.env.OPENRIG_SESSION_NAME;
    server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url?.match(/^\/api\/rigs\/rig-p\/nodes/)) res.end(JSON.stringify(NODES));
      else if (req.url === "/api/ps") res.end(JSON.stringify([{ rigId: "rig-p", name: "q-rig", rigName: "q-rig", nodeCount: 3, runningCount: 3, status: "running", lifecycleState: "running", uptime: "1h", latestSnapshot: null }]));
      else res.end("[]");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => { server.close(); if (savedSessionName !== undefined) process.env.OPENRIG_SESSION_NAME = savedSessionName; });

  function cmd(): Command {
    const deps: StatusDeps = {
      lifecycleDeps: { ...lifecycleDeps(), exists: vi.fn((p: string) => p === STATE_FILE),
        readFile: vi.fn((p: string) => (p === STATE_FILE ? JSON.stringify({ pid: 123, port, db: "test.sqlite", startedAt: "2026-10-26T00:00:00Z" } as DaemonState) : null)) },
      clientFactory: (baseUrl) => new DaemonClient(baseUrl),
    };
    const prog = new Command(); prog.exitOverride(); prog.addCommand(psCommand(deps)); return prog;
  }
  const line = (lines: string[], seat: string) => lines.find((l) => l.includes(seat));

  it("compact text: the reason leads with the loop line (count, last error, since); a plain seat has none; ACTIVITY is unchanged", async () => {
    const lines = await capture(async () => { await cmd().parseAsync(["node", "rig", "ps", "--nodes", "-A"]); });
    const looping = line(lines, "lab-looping@q-rig")!;
    expect(looping, lines.join("\n")).toContain(LOOP.line);
    expect(looping).toMatch(/\brunning\b/);               // still working: the marker is in the reason, not in the activity
    expect(looping).not.toMatch(/needs-input/);
    expect(line(lines, "lab-plain@q-rig")).not.toContain("model errors");
  });

  it("joins the loop line to what else the seat carries (messages held for it) instead of hiding either", async () => {
    const lines = await capture(async () => { await cmd().parseAsync(["node", "rig", "ps", "--nodes", "-A"]); });
    expect(line(lines, "lab-loopheld@q-rig")).toContain(`the runtime gave up at 05:06Z; ${HELD.line}`);
  });

  it("--full text says model errors with the failed-request count in the trailing cell", async () => {
    const lines = await capture(async () => { await cmd().parseAsync(["node", "rig", "ps", "--nodes", "-A", "--full"]); });
    expect(line(lines, "lab-looping@q-rig"), lines.join("\n")).toContain("model errors x11");
    expect(line(lines, "lab-plain@q-rig")).not.toContain("model errors");
  });

  it("--json (compact) carries modelErrorLoop whole on the seat that has it and leaves the key off every other row; the activity state stays running", async () => {
    const lines = await capture(async () => { await cmd().parseAsync(["node", "rig", "ps", "--nodes", "-A", "--json"]); });
    const nodes = JSON.parse(lines.join("")) as Array<{ canonicalSessionName: string; modelErrorLoop?: unknown; agentActivity: Record<string, string> }>;
    const looping = nodes.find((n) => n.canonicalSessionName === "lab-looping@q-rig")!;
    expect(looping.modelErrorLoop).toEqual(LOOP);
    expect(looping.agentActivity.state).toBe("running");
    expect(looping.agentActivity).toHaveProperty("reason", "auto_retry"); // the compact row treats the loop as attention, as the daemon's ATTN count does
    expect("reason" in (nodes.find((n) => n.canonicalSessionName === "lab-plain@q-rig")!.agentActivity)).toBe(false);
    expect("modelErrorLoop" in nodes.find((n) => n.canonicalSessionName === "lab-plain@q-rig")!).toBe(false);
  });

  it("--fields modelErrorLoop selects it", async () => {
    const lines = await capture(async () => { await cmd().parseAsync(["node", "rig", "ps", "--nodes", "-A", "--json", "--fields", "canonicalSessionName,modelErrorLoop"]); });
    const envelope = JSON.parse(lines.join("")) as { entries: Array<{ canonicalSessionName: string; modelErrorLoop?: unknown }> };
    expect(envelope.entries.find((n) => n.canonicalSessionName === "lab-looping@q-rig")!.modelErrorLoop).toEqual(LOOP);
  });
});
