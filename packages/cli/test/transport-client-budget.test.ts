// hc-w45 (QA F1): EVERY client of the daemon's transport routes waits past the daemon's own bound, by the one shared rule
// (@openrig/daemon/transport-budget). Production consequence of a shorter wait: the client reports a delivered message as
// failed/UNCONFIRMED after 5 s, the person sends again, and a broadcast (a fresh identity each time) is delivered twice.
//
// Three guards: (1) the CENSUS of files that call the routes, so a new client fails by name until listed; (2) each call's
// options come from the shared rule, never a number, and no census file defines a timeout constant of its own; (3) the real
// `rig broadcast` against a daemon that takes 6 s (QA's measurement: it threw at 5007 ms with the message delivered).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { broadcastCommand } from "../src/commands/broadcast.js";
import { DaemonClient } from "../src/client.js";

vi.mock("../src/daemon-lifecycle.js", async () => ({
  ...await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js"),
  getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1234, port: 7433 })),
  getDaemonUrl: vi.fn(() => "http://localhost:7433"),
}));

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []);
const rel = (f: string) => path.relative(SRC, f).split(path.sep).join("/");
const FILES = walk(SRC);
const read = (f: string) => fs.readFileSync(f, "utf8");

/** The call expression text that starts at `index` (the literal inside the call), by walking out to the call's closing paren. */
function callAround(text: string, index: number): string {
  let start = index; let depth = 0;
  for (; start > 0; start--) { const ch = text[start]!; if (ch === ")") depth++; else if (ch === "(") { if (depth === 0) break; depth--; } }
  let end = start; depth = 0;
  for (; end < text.length; end++) { const ch = text[end]!; if (ch === "(") depth++; else if (ch === ")") { depth--; if (depth === 0) break; } }
  return text.slice(start, end + 1);
}

const TRANSPORT_ROUTE = /["'`]\/api\/transport\/(send|broadcast)["'`]/g;
const SHARED = /transportSendOptions\(|transportSendBudgetMs\(|transportFanoutBudgetMs\(|transportWakingWriteBudgetMs\(|transportRequestOptions\(|transportBroadcastOptions\(/;

describe("the census of transport clients", () => {
  const clients = FILES.filter((f) => TRANSPORT_ROUTE.test(read(f)) && (TRANSPORT_ROUTE.lastIndex = 0, true)).map(rel).sort();
  it("is exactly these files (a new client fails here, by name, until it takes the shared budget and is listed)", () => {
    expect(clients).toEqual(["commands/broadcast.ts", "commands/send.ts", "commands/walk.ts", "mcp-server.ts"]);
  });
  it("every call to /api/transport/send or /broadcast takes its wait from the shared rule", () => {
    const bad: string[] = [];
    let calls = 0;
    for (const f of clients) {
      const text = read(path.join(SRC, f));
      for (const m of text.matchAll(TRANSPORT_ROUTE)) {
        const before = text.slice(Math.max(0, m.index! - 40), m.index!);
        if (!/(post|postText|runRemoteHttpOp)(<[^>]*>)?\(\s*(["'`A-Za-z, ]*)?$/.test(before) && !/\(\s*$/.test(before) && !/"POST",\s*$/.test(before)) continue; // a comment or doc mention
        calls++;
        const call = callAround(text, m.index!);
        if (!SHARED.test(call)) bad.push(`${f}: ${call.replace(/\s+/g, " ").slice(0, 110)}`);
      }
    }
    expect(calls, "positive control: the scan saw the calls").toBeGreaterThanOrEqual(8);
    expect(bad).toEqual([]);
  });
  it("no transport client file keeps a timeout constant of its own", () => {
    for (const f of clients) {
      const text = read(path.join(SRC, f));
      expect(text, f).not.toMatch(/(?:SEND|BROADCAST|IDLE|TRANSPORT|CROSS_HOST|OVERHEAD)\w*_MS\s*=\s*[\d_]+/);
      expect(text, f).not.toMatch(/timeoutMs:\s*[\d_]+\b/);
    }
  });
  it("the file-local wrappers are built from the shared functions", () => {
    const send = read(path.join(SRC, "commands/send.ts"));
    expect(send).toMatch(/function transportRequestOptions[\s\S]*?transportSendBudgetMs\(/);
    expect(send).toMatch(/function transportBroadcastOptions[\s\S]*?transportFanoutBudgetMs\(/);
    expect(read(path.join(SRC, "mcp-server.ts"))).toMatch(/function transportSendOptions[\s\S]*?transportSendBudgetMs\(/);
  });
});

describe("writes that wake seats before they answer", () => {
  it("every workflow write, and the mission-control resolve, waits the waking-write budget", () => {
    const workflow = read(path.join(SRC, "commands/workflow.ts"));
    const posts = [...workflow.matchAll(/client\.post</g)].map((m) => callAround(workflow, m.index! + 12));
    expect(posts.length, "positive control").toBeGreaterThanOrEqual(8);
    // validate and compile read a spec; every other write may wake a seat before it answers
    expect(posts.filter((p) => !/\/api\/workflow\/(validate|compile)/.test(p.slice(0, 120)) && !p.includes("transportWakingWriteBudgetMs(")).map((p) => p.replace(/\s+/g, " ").slice(0, 90))).toEqual([]);
    const queue = read(path.join(SRC, "commands/queue.ts"));
    const resolve = callAround(queue, queue.indexOf('"/api/mission-control/action"'));
    expect(resolve).toContain("transportWakingWriteBudgetMs(");
  });
});

describe("rig broadcast against a daemon that takes longer than 5 s", () => {
  let logs: string[]; let exit: typeof process.exitCode;
  beforeEach(() => { logs = []; exit = process.exitCode; process.exitCode = undefined; vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" "))); });
  afterEach(() => { process.exitCode = exit; vi.restoreAllMocks(); });

  it("waits for the answer: one POST, delivered, no timeout, so nobody resends (QA: threw at 5007 ms, posts 1)", async () => {
    let posts = 0; let finished = 0;
    const server = (await import("node:http")).createServer((req, res) => {
      posts++;
      req.resume();
      setTimeout(() => { finished++; res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ total: 1, sent: 1, failed: 0, results: [{ ok: true, sessionName: "a@r" }] })); }, 6_000);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const program = new Command();
      program.addCommand(broadcastCommand({
        lifecycleDeps: {} as never,
        clientFactory: () => new DaemonClient(`http://127.0.0.1:${port}`),
      } as never));
      const started = Date.now();
      await program.parseAsync(["broadcast", "--rig", "r", "--json", "hello"], { from: "user" });
      expect(Date.now() - started).toBeGreaterThan(5_900);
      expect({ posts, finished }).toEqual({ posts: 1, finished: 1 });
      expect(JSON.parse(logs[0]!)).toMatchObject({ sent: 1 });
      expect(process.exitCode).toBeUndefined();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 30_000);
});
