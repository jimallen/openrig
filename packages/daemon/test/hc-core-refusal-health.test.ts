// hc cutover (Jim, 2026-11-01): a refused core is visible in `rig health`, plainly, with the reason and the fix. The refusal itself
// (HcClient.refuseCore: every later call fails as an unavailable core) is unchanged and pinned by hc-core-refusal.test.ts.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HC_GENERATION, HcClient, HcUnavailableError } from "../src/adapters/hc-client.js";
import { connectHcCore, type HcCoreWatch } from "../src/adapters/hc-core-watch.js";
import { HcCoreRefusalHealthSource } from "../src/domain/hc-core-refusal-health.js";
import type { HealthSourceCoverage } from "../src/domain/health-detectors.js";
import { createDaemon } from "../src/startup.js";

// Far from the wall clock, so a source that read Date.now() instead of its clock shows up.
const T0 = new Date("2031-03-04T05:00:00.000Z");
const reasonOf = (row: HealthSourceCoverage | undefined): string => (row && "reason" in row ? row.reason : "");

describe("HcCoreRefusalHealthSource", () => {
  it("says nothing while no core is refused", () => {
    expect(new HcCoreRefusalHealthSource(() => null, () => T0).coverage()).toEqual([]);
  });

  it("shows one plain notice with the reason and the fix once a core is refused", () => {
    const rows = new HcCoreRefusalHealthSource(() => "the running core is hc 9.9.9; this build is pinned to 0.1.15", () => T0).coverage();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "hc-core-refused", status: "notice", partial: false, evaluatedAt: "2031-03-04T05:00:00.000Z" });
    const reason = reasonOf(rows[0]);
    expect(reason).toContain("the running core is hc 9.9.9; this build is pinned to 0.1.15");  // the reason, verbatim
    expect(reason).toContain("until the daemon restarts");
    expect(reason).toMatch(/after the new version is tested/);                                  // the fix: a tested pin move ...
    expect(reason).toContain("rig daemon stop && rig daemon start");                            // ... then a daemon restart
  });

  it("reads the refusal each time, so it appears when the refusal arrives and never flaps", () => {
    let why: string | null = null;
    const source = new HcCoreRefusalHealthSource(() => why, () => T0);
    expect(source.coverage()).toEqual([]);
    why = "swapped";
    expect(source.coverage()).toHaveLength(1);
    expect(source.coverage()).toHaveLength(1);
  });

  it("is a coverage-only source: no observation, so no finding and no RSI record", () => {
    expect(new HcCoreRefusalHealthSource(() => "x", () => T0).read()).toEqual([]);
  });
});

const hello = (over: Record<string, unknown> = {}) => ({ generation: HC_GENERATION, version: "0.1.15", core: { id: "core-a", name: "n" }, ...over });

/** A core on a unix socket that answers `hello`, `events.subscribe` and one probe method. */
class ScriptedCore {
  readonly dir = mkdtempSync(join(tmpdir(), "hcrh-"));
  readonly socketPath = join(this.dir, "core.sock");
  private server: Server | null = null;
  private readonly sockets: Socket[] = [];
  helloReply: Record<string, unknown> = hello();

  async listen(): Promise<void> {
    this.server = createServer((socket) => {
      this.sockets.push(socket);
      socket.setEncoding("utf8");
      socket.on("error", () => undefined);
      let buffer = "";
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
          const message = JSON.parse(buffer.slice(0, end)) as { id: number; method: string };
          buffer = buffer.slice(end + 1);
          const result = message.method === "hello" ? this.helloReply : message.method === "events.subscribe" ? { seq: 0, terminals: [] } : { ok: true };
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
        }
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(this.socketPath, resolve));
  }
  dropConnections(): void { for (const s of this.sockets.splice(0)) s.destroy(); }
  async close(): Promise<void> {
    this.dropConnections();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    rmSync(this.dir, { recursive: true, force: true });
  }
}

const until = async (check: () => boolean, what: string, ms = 8000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("the notice follows the real client's refusal", () => {
  const cores: ScriptedCore[] = [];
  const watches: HcCoreWatch[] = [];
  afterEach(async () => {
    for (const w of watches.splice(0)) w.stop();
    for (const c of cores.splice(0)) await c.close();
  });

  it("appears when a core upgraded under the running daemon refuses its client, and the client still fails closed", async () => {
    const core = new ScriptedCore();
    cores.push(core);
    await core.listen();
    const client = new HcClient(core.socketPath);
    const source = new HcCoreRefusalHealthSource(() => client.refusedBecause, () => T0);
    watches.push(await connectHcCore({ socketPath: core.socketPath, env: { OPENRIG_HC_NO_START_CORE: "1" }, client, log: () => {} }));
    expect(source.coverage()).toEqual([]);  // control: a core on the pinned version shows nothing
    core.helloReply = hello({ version: "9.9.9" });
    core.dropConnections();
    await until(() => source.coverage().length > 0, "the notice");
    expect(reasonOf(source.coverage()[0])).toContain("9.9.9");
    await expect(client.call("probe")).rejects.toBeInstanceOf(HcUnavailableError);  // fail-closed behaviour unchanged
  });

  it("does not appear for a core that is merely down", async () => {
    const core = new ScriptedCore();
    cores.push(core);
    await core.listen();
    const client = new HcClient(core.socketPath);
    const source = new HcCoreRefusalHealthSource(() => client.refusedBecause, () => T0);
    const watch = await connectHcCore({ socketPath: core.socketPath, env: { OPENRIG_HC_NO_START_CORE: "1" }, client, log: () => {} });
    watches.push(watch);
    await core.close();
    cores.splice(0);
    await until(() => watch.state() === "reconnecting", "the loss");
    expect(source.coverage()).toEqual([]);
  });
});

describe("the daemon's `rig health` carries it", () => {
  it("a core refused after the daemon started shows as a notice in the health projection", async () => {
    const core = new ScriptedCore();
    await core.listen();
    const dir = mkdtempSync(join(tmpdir(), "hcrh-db-"));
    const saved = { HC_SOCKET: process.env.HC_SOCKET, NO_START: process.env.OPENRIG_HC_NO_START_CORE };
    process.env.HC_SOCKET = core.socketPath;
    process.env.OPENRIG_HC_NO_START_CORE = "1";
    const daemon = await createDaemon({ dbPath: join(dir, "openrig.sqlite") });
    try {
      const rows = () => (daemon.deps.healthProjection!.list().coverage ?? []).filter((c) => c.source === "hc-core-refused");
      expect(rows()).toEqual([]);  // control: the pinned core shows nothing
      core.helloReply = hello({ version: "9.9.9" });
      core.dropConnections();
      await until(() => rows().length > 0, "the notice in rig health");
      expect(rows()[0]).toMatchObject({ status: "notice", partial: false });
      expect(reasonOf(rows()[0])).toContain("9.9.9");
    } finally {
      daemon.hcCoreWatch?.stop();
      daemon.eventLoopMonitor.stop();
      daemon.db.close();
      await core.close();
      for (const [key, value] of [["HC_SOCKET", saved.HC_SOCKET], ["OPENRIG_HC_NO_START_CORE", saved.NO_START]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
