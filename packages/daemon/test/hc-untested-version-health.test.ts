// hc cutover (Jim, 2026-11-01): a core of the tested minor line that is not the tested version is accepted, and `rig health` says so in
// one notice beside the refused-core notice (hc-core-refusal-health.ts), on the same path. The production consequence of a wrong row:
// a silent untested core hides that an app update moved hc under OpenRig; a stale or false notice makes a healthy host look wrong.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HC_GENERATION, HcClient } from "../src/adapters/hc-client.js";
import { connectHcCore, type HcCoreWatch } from "../src/adapters/hc-core-watch.js";
import { HcCoreRefusalHealthSource } from "../src/domain/hc-core-refusal-health.js";
import { HcUntestedVersionHealthSource } from "../src/domain/hc-untested-version-health.js";
import type { HealthSourceCoverage } from "../src/domain/health-detectors.js";
import { createDaemon } from "../src/startup.js";

// Far from the wall clock, so a source that read Date.now() instead of its clock shows up.
const T0 = new Date("2031-03-04T05:00:00.000Z");
const reasonOf = (row: HealthSourceCoverage | undefined): string => (row && "reason" in row ? row.reason : "");

describe("HcUntestedVersionHealthSource", () => {
  it.each([null, "0.1.16", "0.1.14", "0.2.0", "0.2.16", "1.1.16", "0.1.16-rc1", "nonsense"])("says nothing for %j: no core yet, the tested version, or a version the refusal notice speaks for", (version) => {
    expect(new HcUntestedVersionHealthSource(() => version, () => T0).coverage()).toEqual([]);
  });

  it.each(["0.1.15", "0.1.17", "0.1.99"])("shows one notice for hc %s naming it and the tested 0.1.16, on the injected clock", (version) => {
    const rows = new HcUntestedVersionHealthSource(() => version, () => T0).coverage();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "hc-untested-version", status: "notice", partial: false, evaluatedAt: "2031-03-04T05:00:00.000Z" });
    expect(reasonOf(rows[0])).toContain(version);
    expect(reasonOf(rows[0])).toContain("0.1.16");
    expect(reasonOf(rows[0])).toContain("Seats keep running");
  });

  it("reads the version each time, so it appears and clears with the core and never flaps", () => {
    let version: string | null = "0.1.16";
    const source = new HcUntestedVersionHealthSource(() => version, () => T0);
    expect(source.coverage()).toEqual([]);
    version = "0.1.17";
    expect(source.coverage()).toHaveLength(1);
    expect(source.coverage()).toHaveLength(1);
    version = "0.1.16";
    expect(source.coverage()).toEqual([]);
  });

  it("is a coverage-only source: no observation, so no finding and no RSI record", () => {
    expect(new HcUntestedVersionHealthSource(() => "0.1.17", () => T0).read()).toEqual([]);
  });
});

const hello = (over: Record<string, unknown> = {}) => ({ generation: HC_GENERATION, version: "0.1.16", core: { id: "core-a", name: "n" }, ...over });

/** A core on a unix socket that answers `hello`, `events.subscribe` and one probe method. */
class ScriptedCore {
  readonly dir = mkdtempSync(join(tmpdir(), "hcuv-"));
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

describe("the notice follows the core the watch is connected to", () => {
  const cores: ScriptedCore[] = [];
  const watches: HcCoreWatch[] = [];
  afterEach(async () => {
    for (const w of watches.splice(0)) w.stop();
    for (const c of cores.splice(0)) await c.close();
  });

  it("appears for a core updated under the running daemon, keeps the same core id, clears when the tested version returns, and gives way to the refusal for an unaccepted one", async () => {
    const core = new ScriptedCore();
    cores.push(core);
    await core.listen();
    const client = new HcClient(core.socketPath);
    let version: string | null = null;
    const untested = new HcUntestedVersionHealthSource(() => version, () => T0);
    const refused = new HcCoreRefusalHealthSource(() => client.refusedBecause, () => T0);
    const watch = await connectHcCore({ socketPath: core.socketPath, env: { OPENRIG_HC_NO_START_CORE: "1" }, client, log: () => {}, onCoreVersion: (v) => { version = v; } });
    watches.push(watch);
    expect(version).toBe("0.1.16");
    expect(untested.coverage()).toEqual([]);  // control: the tested version shows nothing

    core.helloReply = hello({ version: "0.1.17" });
    core.dropConnections();
    await until(() => untested.coverage().length > 0, "the untested notice");
    expect(reasonOf(untested.coverage()[0])).toMatch(/0\.1\.17.*0\.1\.16/);
    expect(watch.state()).toBe("streaming");
    expect(watch.pinnedCoreId()).toBe("core-a");        // the same core id: not a swapped core
    expect(client.refusedBecause).toBeNull();           // accepted: no refusal, calls still go through
    expect(refused.coverage()).toEqual([]);

    core.helloReply = hello({ version: "0.1.16" });
    core.dropConnections();
    await until(() => untested.coverage().length === 0, "the notice to clear");

    core.helloReply = hello({ version: "0.2.0" });
    core.dropConnections();
    await until(() => refused.coverage().length > 0, "the refusal notice");
    expect(untested.coverage()).toEqual([]);            // the refusal speaks; no stale untested row beside it
    expect(version).toBeNull();
    expect(reasonOf(refused.coverage()[0])).toContain("0.2.0");
  });
});

describe("the daemon's `rig health` carries it beside the refusal notice", () => {
  it("an accepted but untested core shows as a notice, and a refused one shows as the refusal notice and not as this one", async () => {
    const core = new ScriptedCore();
    await core.listen();
    const dir = mkdtempSync(join(tmpdir(), "hcuv-db-"));
    const saved = { HC_SOCKET: process.env.HC_SOCKET, NO_START: process.env.OPENRIG_HC_NO_START_CORE };
    process.env.HC_SOCKET = core.socketPath;
    process.env.OPENRIG_HC_NO_START_CORE = "1";
    const daemon = await createDaemon({ dbPath: join(dir, "openrig.sqlite") });
    try {
      const rows = (source: string) => (daemon.deps.healthProjection!.list().coverage ?? []).filter((c) => c.source === source);
      expect(rows("hc-untested-version")).toEqual([]);  // control: the tested core shows nothing
      core.helloReply = hello({ version: "0.1.99" });
      core.dropConnections();
      await until(() => rows("hc-untested-version").length > 0, "the untested notice in rig health");
      expect(rows("hc-untested-version")[0]).toMatchObject({ status: "notice", partial: false });
      expect(reasonOf(rows("hc-untested-version")[0])).toMatch(/0\.1\.99.*0\.1\.16/);
      expect(rows("hc-core-refused")).toEqual([]);
      core.helloReply = hello({ version: "0.2.0" });
      core.dropConnections();
      await until(() => rows("hc-core-refused").length > 0, "the refusal notice in rig health");
      expect(rows("hc-untested-version")).toEqual([]);
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
