import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server, type Socket } from "node:net";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { HC_GENERATION } from "../src/adapters/hc-client.js";
import { connectHcCore } from "../src/adapters/hc-core-watch.js";
import { HcCoreRefusalHealthSource } from "../src/domain/hc-core-refusal-health.js";
import type { HealthSourceCoverage } from "../src/domain/health-detectors.js";

// A refused core start (no named runtime location) was a daemon.log line and nothing else (review of 6f813a07, F4): `rig health` showed no cause,
// and the log line was written once per reason for the life of the daemon, so a second outage with the same cause was silent. The fake `hc`
// stands for the real one. Far-from-wall-clock T0, as in hc-core-refusal-health.test.ts.
const T0 = new Date("2031-03-04T05:00:00.000Z");
const reasonOf = (row: HealthSourceCoverage | undefined): string => (row && "reason" in row ? row.reason : "");
const dir = mkdtempSync(join(tmpdir(), "hc-core-start-failure-"));
const ran = join(dir, "ran.txt");
writeFileSync(join(dir, "hc"), `#!/bin/sh\necho "args=$*" >> ${ran}\n`);
chmodSync(join(dir, "hc"), 0o755);
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => rmSync(ran, { force: true }));
const PATH = process.env.PATH ?? "/usr/bin:/bin";
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, what: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await wait(25);
  }
}

describe("HcCoreRefusalHealthSource, core start failures", () => {
  it("says nothing while the core starts", () => {
    expect(new HcCoreRefusalHealthSource(() => null, () => T0, () => null).coverage()).toEqual([]);
  });
  it("shows one notice with the cause and the operator once a core start is refused, and clears when it is not", () => {
    let why: string | null = "refusing to start an hc core: neither XDG_RUNTIME_DIR nor HC_SOCKET is set";
    const source = new HcCoreRefusalHealthSource(() => null, () => T0, () => why);
    const rows = source.coverage();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "hc-core-start-refused", status: "notice", partial: false, evaluatedAt: "2031-03-04T05:00:00.000Z" });
    expect(reasonOf(rows[0])).toContain("neither XDG_RUNTIME_DIR nor HC_SOCKET is set");
    expect(reasonOf(rows[0])).toContain("operator");
    expect(reasonOf(rows[0]), "a seat is never told to run it").not.toMatch(/rig daemon (stop|start|restart)/);
    why = null;
    expect(source.coverage()).toEqual([]);
  });
  it("shows a refused core and a refused core start as two rows", () => {
    const rows = new HcCoreRefusalHealthSource(() => "swapped", () => T0, () => "no location").coverage();
    expect(rows.map((r) => r.source).sort()).toEqual(["hc-core-refused", "hc-core-start-refused"]);
  });
});

describe("connectHcCore reports a refused core start, and a recovery resets it", () => {
  it("reports the cause when refused, clears it when a start goes through, and reports and logs a second outage again", async () => {
    const env: NodeJS.ProcessEnv = { PATH: `${dir}:${PATH}` };  // no HOME, no XDG_*, no HC_SOCKET: refused on every platform
    const socketPath = join(dir, "nothing-listens-here.sock");
    const logs: string[] = [];
    const reports: Array<string | null> = [];
    const watch = await connectHcCore({ socketPath, env, log: (m) => logs.push(m), firstAttemptMs: 300, onCoreStartFailure: (why) => reports.push(why) });
    try {
      const failures = () => logs.filter((m) => m.includes("core_start_failed")).length;
      await until(() => failures() >= 1, "the first refusal in the log");
      expect(reports.at(-1), "reported to the health source").toContain("XDG_RUNTIME_DIR");
      expect(existsSync(ran), "hc never ran").toBe(false);
      env.HC_SOCKET = socketPath;                                   // recovery: the env now names a location
      await until(() => existsSync(ran), "a start that goes through");
      await until(() => reports.at(-1) === null, "the failure cleared");
      delete env.HC_SOCKET;                                         // a second outage, same cause
      await until(() => failures() >= 2, "the same refusal logged again");
      expect(reports.at(-1)).toContain("XDG_RUNTIME_DIR");
    } finally {
      watch.stop();
    }
  }, 30_000);
  it("clears the report when the core turns up by another route (a core started by someone else), not only by a start of ours", async () => {
    const socketPath = join(dir, "core.sock");
    const reports: Array<string | null> = [];
    const logs: string[] = [];
    const watch = await connectHcCore({ socketPath, env: { PATH: `${dir}:${PATH}` }, log: (m) => logs.push(m), firstAttemptMs: 300, onCoreStartFailure: (why) => reports.push(why) });
    const sockets: Socket[] = [];
    const server: Server = createServer((socket) => {
      sockets.push(socket);
      socket.setEncoding("utf8");
      socket.on("error", () => undefined);
      let buffer = "";
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
          const message: unknown = JSON.parse(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
          if (typeof message !== "object" || message === null || !("id" in message) || !("method" in message)) continue;
          const result = message.method === "hello" ? { generation: HC_GENERATION, version: "0.1.16", core: { id: "core-a", name: "n" } } : message.method === "events.subscribe" ? { seq: 0, terminals: [] } : { ok: true };
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
        }
      });
    });
    try {
      await until(() => reports.at(-1) !== undefined && reports.at(-1) !== null, "the refusal reported");
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      await until(() => reports.at(-1) === null, "the report cleared by the core appearing");
      expect(logs.some((m) => m.includes('"connected"'))).toBe(true);
    } finally {
      watch.stop();
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);
});

// Not an in-process daemon: a daemon whose env names no core location resolves the socket to the ACCOUNT's own home on this Mac
// (resolveHcSocket falls back to homedir()), which is the live core. So the wiring is read, not run.
describe("the daemon wires the failure into `rig health` (startup.ts is read: createDaemon cannot be run without a location safely)", () => {
  const startup = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "startup.ts"), "utf8");
  it("passes connectHcCore an onCoreStartFailure that stores the cause", () => {
    expect(startup).toMatch(/connectHcCore\(\{[^\n]*onCoreStartFailure: \(why\) => \{ hcCoreStartFailure = why; \}/);
  });
  it("hands the health source the stored cause as its third argument", () => {
    expect(startup).toContain("new HcCoreRefusalHealthSource(() => hcClient?.refusedBecause ?? null, undefined, () => hcCoreStartFailure)");
  });
});
