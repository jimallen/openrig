// OF-278: seven rig messages waited 160 to 382 min behind one question on 2026-11-07 and `rig ps` said nothing. The daemon serves
// `heldMessages` ({count, oldestAt, line}) on a seat with messages waiting; this pins what `rig ps` does with it: the human tables show the
// line in the trailing cell (joined to the posture note where there is one), --json carries the field only on a seat that has it.
// Harness as ps-seat-posture.test.ts.

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

const HELD = { count: 7, oldestAt: "2031-03-04T10:00:00.000Z", line: "7 held, oldest 6h21m" };
const BUSY = { kind: "busy", source: "runtime_hook", at: "2031-03-04T16:04:41.008Z", tool: "bash", line: "busy: last tool started 16:04Z (bash)" };

function node(logicalId: string, extra: Record<string, unknown> = {}) {
  return {
    rigId: "rig-p", rigName: "q-rig", logicalId, podId: "pod-lab", podNamespace: "lab",
    canonicalSessionName: `${logicalId.replace(".", "-")}@q-rig`, nodeKind: "agent", runtime: "claude-code",
    sessionStatus: "running", startupStatus: "ready", restoreOutcome: "n-a", lifecycleState: "running",
    identityVerdict: null, latestError: null, terminalActive: true,
    hasAssignedWork: false, assignedWorkCount: 0, pendingWorkCount: 0, inProgressWorkCount: 0, blockedWorkCount: 0,
    agentActivity: { state: "needs_input", reason: "question_dialog", evidenceSource: "runtime_hook", sampledAt: "2031-03-04T17:10:00.000Z", evidence: "AskUserQuestion" },
    ...extra,
  };
}
const NODES = [node("lab.asked", { heldMessages: HELD }), node("lab.busyheld", { heldMessages: HELD, seatPosture: BUSY }), node("lab.plain")];

describe("OF-278: rig ps shows how many messages wait for a seat", () => {
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

  it("compact text: a seat with waiting messages carries the held line, even when it is not busy; a seat with none does not", async () => {
    const lines = await capture(async () => { await cmd().parseAsync(["node", "rig", "ps", "--nodes", "-A"]); });
    expect(line(lines, "lab-asked@q-rig"), lines.join("\n")).toContain(HELD.line);
    expect(line(lines, "lab-plain@q-rig")).toBeDefined();
    expect(line(lines, "lab-plain@q-rig")).not.toContain("held");
  });

  it("joins the held line to the posture note instead of hiding either", async () => {
    const lines = await capture(async () => { await cmd().parseAsync(["node", "rig", "ps", "--nodes", "-A"]); });
    expect(line(lines, "lab-busyheld@q-rig")).toContain(`${BUSY.line}; ${HELD.line}`);
  });

  it("--full text carries the held line in the trailing cell", async () => {
    const lines = await capture(async () => { await cmd().parseAsync(["node", "rig", "ps", "--nodes", "-A", "--full"]); });
    expect(line(lines, "lab-asked@q-rig"), lines.join("\n")).toContain(HELD.line);
  });

  it("--json (compact) carries heldMessages whole where there is a wait and leaves the key off every other row (token budget)", async () => {
    const lines = await capture(async () => { await cmd().parseAsync(["node", "rig", "ps", "--nodes", "-A", "--json"]); });
    const nodes = JSON.parse(lines.join("")) as Array<{ canonicalSessionName: string; heldMessages?: unknown }>;
    expect(nodes.find((n) => n.canonicalSessionName === "lab-asked@q-rig")!.heldMessages).toEqual(HELD);
    expect("heldMessages" in nodes.find((n) => n.canonicalSessionName === "lab-plain@q-rig")!).toBe(false);
  });

  it("--fields heldMessages selects it", async () => {
    const lines = await capture(async () => { await cmd().parseAsync(["node", "rig", "ps", "--nodes", "-A", "--json", "--fields", "canonicalSessionName,heldMessages"]); });
    const envelope = JSON.parse(lines.join("")) as { entries: Array<{ canonicalSessionName: string; heldMessages?: unknown }> };
    expect(envelope.entries.find((n) => n.canonicalSessionName === "lab-asked@q-rig")!.heldMessages).toEqual(HELD);
  });
});
