// OF-267: a seat busy in a long tool call reads `unknown / stale_runtime_hook` in ACTIVITY, which a sender takes for a broken seat.
// The daemon now serves `seatPosture` (daemon side: packages/daemon/test/seat-posture.test.ts). This pins what `rig ps` does with it:
// the human tables show the posture line for a busy seat and for an open turn the hooks cannot confirm (and for no other posture),
// and --json / --fields carry the field. Mirrors the ps-pda-held.test.ts harness.

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

const POSTURE = {
  busy: { kind: "busy", source: "runtime_hook", at: "2031-03-04T16:04:41.008Z", tool: "bash", line: "busy: last tool started 16:04Z (bash)" },
  open: { kind: "unknown-open-turn", source: "runtime_hook", at: "2031-03-04T16:04:41.008Z", tool: "bash", line: "unknown: last hook PreToolUse bash 16:04Z (66 min ago), no Stop since" },
  hc: { kind: "busy", source: "hc_status", at: "2031-03-04T16:04:40.000Z", tool: null, line: "busy: working since 16:04Z (hc status)" },
  idle: { kind: "idle", source: "runtime_hook", at: "2031-03-04T16:04:41.008Z", tool: null, line: "idle: last hook Stop 16:04Z" },
};

function piNode(logicalId: string, state: string, seatPosture?: unknown) {
  return {
    rigId: "rig-p", rigName: "pi-rig", logicalId,
    podId: "pod-lab", podNamespace: "lab",
    canonicalSessionName: `${logicalId.replace(".", "-")}@pi-rig`,
    nodeKind: "agent", runtime: "pi",
    sessionStatus: "running", startupStatus: "ready", restoreOutcome: "n-a", lifecycleState: "running",
    identityVerdict: null, latestError: null, terminalActive: true,
    hasAssignedWork: false, assignedWorkCount: 0, pendingWorkCount: 0, inProgressWorkCount: 0, blockedWorkCount: 0,
    agentActivity: { state, reason: "stale_runtime_hook", evidenceSource: "runtime_hook", sampledAt: "2031-03-04T17:10:00.000Z", evidence: "bash" },
    ...(seatPosture ? { seatPosture } : {}),
  };
}

const NODES = [
  piNode("lab.busy", "running", POSTURE.busy),
  piNode("lab.open", "unknown", POSTURE.open),
  piNode("lab.hc", "unknown", POSTURE.hc),
  piNode("lab.idle", "idle", POSTURE.idle),
  piNode("lab.old", "unknown"),
];

describe("OF-267: rig ps reports what a seat's hooks support about busy", () => {
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
        res.end(JSON.stringify([{ rigId: "rig-p", name: "pi-rig", rigName: "pi-rig", nodeCount: 5, runningCount: 5, status: "running", lifecycleState: "running", uptime: "1h", latestSnapshot: null }]));
      } else res.end("[]");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
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

  const line = (lines: string[], seat: string) => lines.find((l) => l.includes(seat));

  it("compact text: the busy seat and the open-turn seat carry their posture line; idle and an older daemon's seat carry none", async () => {
    const lines = await capture(async () => { await cmd().parseAsync(["node", "rig", "ps", "--nodes", "-A"]); });
    expect(line(lines, "lab-busy@pi-rig"), lines.join("\n")).toContain(POSTURE.busy.line);
    expect(line(lines, "lab-open@pi-rig")).toContain(POSTURE.open.line);
    expect(line(lines, "lab-hc@pi-rig")).toContain(POSTURE.hc.line); // busy from the core's status, named as such
    expect(line(lines, "lab-idle@pi-rig")).toBeDefined();
    expect(line(lines, "lab-idle@pi-rig")).not.toContain("idle: last hook");
    expect(line(lines, "lab-old@pi-rig")).not.toMatch(/busy|last hook/);
  });

  it("the open-turn line never says busy", async () => {
    const lines = await capture(async () => { await cmd().parseAsync(["node", "rig", "ps", "--nodes", "-A"]); });
    expect(line(lines, "lab-open@pi-rig")).not.toContain("busy");
  });

  it("--full text carries the same lines in the trailing cell", async () => {
    const lines = await capture(async () => { await cmd().parseAsync(["node", "rig", "ps", "--nodes", "-A", "--full"]); });
    expect(line(lines, "lab-busy@pi-rig"), lines.join("\n")).toContain(POSTURE.busy.line);
    expect(line(lines, "lab-open@pi-rig")).toContain(POSTURE.open.line);
    expect(line(lines, "lab-idle@pi-rig")).not.toContain("idle: last hook");
  });

  it("--json (compact) carries seatPosture whole for a busy or open-turn seat and leaves the key off every other row (token budget)", async () => {
    const lines = await capture(async () => { await cmd().parseAsync(["node", "rig", "ps", "--nodes", "-A", "--json"]); });
    const nodes = JSON.parse(lines.join("")) as Array<{ canonicalSessionName: string; seatPosture?: unknown }>;
    const of = (s: string) => nodes.find((n) => n.canonicalSessionName === s)!;
    expect(of("lab-open@pi-rig").seatPosture).toEqual(POSTURE.open);
    expect(of("lab-busy@pi-rig").seatPosture).toEqual(POSTURE.busy);
    expect(of("lab-hc@pi-rig").seatPosture).toEqual(POSTURE.hc);
    expect("seatPosture" in of("lab-idle@pi-rig")).toBe(false);
    expect("seatPosture" in of("lab-old@pi-rig")).toBe(false);
  });

  it("--full --json carries seatPosture on every row the daemon served it for", async () => {
    const lines = await capture(async () => { await cmd().parseAsync(["node", "rig", "ps", "--nodes", "-A", "--full", "--json"]); });
    const nodes = JSON.parse(lines.join("")) as Array<{ canonicalSessionName: string; seatPosture?: unknown }>;
    expect(nodes.find((n) => n.canonicalSessionName === "lab-idle@pi-rig")!.seatPosture).toEqual(POSTURE.idle);
    expect(nodes.find((n) => n.canonicalSessionName === "lab-open@pi-rig")!.seatPosture).toEqual(POSTURE.open);
  });

  it("--fields seatPosture selects it", async () => {
    const lines = await capture(async () => { await cmd().parseAsync(["node", "rig", "ps", "--nodes", "-A", "--json", "--fields", "canonicalSessionName,seatPosture"]); });
    const envelope = JSON.parse(lines.join("")) as { entries: Array<{ canonicalSessionName: string; seatPosture?: unknown }> };
    expect(envelope.entries.find((n) => n.canonicalSessionName === "lab-open@pi-rig")!.seatPosture).toEqual(POSTURE.open);
  });
});
