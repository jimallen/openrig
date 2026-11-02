// hc cutover (W42): a launch the core refuses as `unavailable` while it has no holder used to read `hc refused <seat>: unavailable` on every
// seat. The daemon now says what was found and the fix, in its own words, at all three terminal.run sites, and `rig health` shows it.
// The real-core cause is pinned in hc-launch-refusal.real.test.ts; here the wording, the three sites and the health notice.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDaemon } from "../src/startup.js";
import { HcClient, HcError, type HcTerminal } from "../src/adapters/hc-client.js";
import { HcHost, SEAT_LABEL, hcTerminalName } from "../src/adapters/hc-host.js";
import { HcLifecycle } from "../src/adapters/hc-lifecycle.js";
import { explainLaunchUnavailable } from "../src/adapters/hc-launch-refusal.js";
import type { HealthSourceCoverage } from "../src/domain/health-detectors.js";
import { HcLaunchBlockedHealthSource } from "../src/domain/hc-launch-blocked-health.js";

const T0 = new Date("2031-03-04T05:00:00.000Z");
const reasonOf = (row: HealthSourceCoverage | undefined): string => (row && "reason" in row ? row.reason : "");
// The core's real text for this refusal (measured on hc 0.1.15 and 0.1.16), plus a marker that stands for anything the call carried.
const coreText = "no holder: holder build elf:aaaa differs from core build elf:bbbb s3cret-marker";
const unavailable = () => new HcError(coreText, "unavailable", -32000, "run hc server restart on this machine, then retry");

type Status = { version: string; holder: unknown; holders: unknown[] };
const noHolder: Status = { version: "0.1.15", holder: null, holders: [] };
const withHolder: Status = { version: "0.1.15", holder: { pid: 1, terminals: 1, current: true, instance: "i" }, holders: [{ pid: 1 }] };

class FakeClient extends HcClient {
  calls: string[] = [];
  constructor(private readonly runError: Error, private readonly status: Status | Error) { super("/nonexistent"); }
  override async call<T>(method: string): Promise<T> {
    this.calls.push(method);
    if (method === "terminal.run") throw this.runError;
    if (method === "server.status") { if (this.status instanceof Error) throw this.status; return this.status as T; }
    if (method === "terminal.get") return { address: "t7", name: hcTerminalName("qa@rig"), labels: { [SEAT_LABEL]: "qa@rig" }, argv: [], cwd: "/w", state: "finished", created_ms: 0, screen: "exact", cols: 80, rows: 24 } satisfies HcTerminal as T;
    throw new Error(`unexpected ${method}`);
  }
}

describe("a launch refused as unavailable by a core with no holder", () => {
  it("names the cause, the fix and that nothing was launched, in the daemon's words and never the core's", async () => {
    const client = new FakeClient(unavailable(), noHolder);
    const result = await new HcHost(client, { daemonEnv: {} }).createSession("qa@rig");
    expect(result).toMatchObject({ ok: false, code: "unknown" });
    const message = result.ok ? "" : result.message;
    expect(message).toContain("no holder");
    expect(message).toContain("replaced");                    // the cause
    expect(message).toContain("have the operator restart the hc core");         // the fix
    expect(message).toContain("Nothing was launched");
    expect(message).toContain("hc core 0.1.15");               // the version it read from server.status
    expect(message).not.toContain("elf:");                     // the core's text is never quoted ...
    expect(message).not.toContain("s3cret-marker");            // ... because the call carried the seat's credentials
    expect(message).not.toBe("hc refused qa@rig: unavailable");
  });

  it("reads the core's holders before saying so: a core WITH a holder gets the undetermined wording, not the no-holder claim", async () => {
    const result = await new HcHost(new FakeClient(unavailable(), withHolder), { daemonEnv: {} }).createSession("qa@rig");
    const message = result.ok ? "" : result.message;
    expect(message).toContain("hc refused qa@rig: unavailable");
    expect(message).toContain("hc server status");
    expect(message).not.toContain("replaced");
  });

  it("does not call it no-holder when older holders still run terminals: after a core restart the holder is null and holders is not empty", async () => {
    const afterRestart: Status = { version: "0.1.16", holder: null, holders: [{ pid: 9 }] };
    const refusal = await explainLaunchUnavailable(new FakeClient(unavailable(), afterRestart), "x");
    expect(refusal.noHolder).toBe(false);
    expect(refusal.message).not.toContain("Nothing was launched");
  });

  it("does not claim a cause it could not read: a failed status read gives the undetermined wording", async () => {
    const result = await new HcHost(new FakeClient(unavailable(), new Error("down")), { daemonEnv: {} }).createSession("qa@rig");
    expect(result.ok ? "" : result.message).not.toContain("replaced");
  });

  it("leaves every other refusal kind as it was: the kind and no more", async () => {
    const client = new FakeClient(new HcError("failed s3cret-marker", "spawn_failed", -32000), noHolder);
    const result = await new HcHost(client, { daemonEnv: {} }).createSession("qa@rig");
    expect(result).toEqual({ ok: false, code: "unknown", message: "hc refused qa@rig: spawn_failed" });
    expect(client.calls).toEqual(["terminal.run"]);            // and it did not even ask the core for its status
  });

  it("is told to the client only when the core has no holder, for rig health", async () => {
    const blocked = new FakeClient(unavailable(), noHolder);
    await new HcHost(blocked, { daemonEnv: {} }).createSession("qa@rig");
    expect(blocked.launchBlockedBecause).toContain("have the operator restart the hc core");
    const other = new FakeClient(unavailable(), withHolder);
    await new HcHost(other, { daemonEnv: {} }).createSession("qa@rig");
    expect(other.launchBlockedBecause).toBeNull();
  });

  it("is the same at the respawn site, keeping its note that the previous program had ended", async () => {
    const client = new FakeClient(unavailable(), noHolder);
    const result = await new HcLifecycle(client, { daemonEnv: {} }).respawnPane("qa@rig");
    const message = result.ok ? "" : result.message;
    expect(message).toContain("have the operator restart the hc core");
    expect(message).toContain("(the previous program had already ended)");
  });

  it("is the same at the probe-launch site", async () => {
    const client = new FakeClient(unavailable(), noHolder);
    const result = await new HcLifecycle(client, { daemonEnv: {} }).createProbeSession("probe-1");
    expect(result.ok ? "" : result.message).toContain("have the operator restart the hc core");
  });

  it("takes a version from status only when it is a plain release number", async () => {
    const odd = await explainLaunchUnavailable(new FakeClient(unavailable(), { ...noHolder, version: "0.1.15 s3cret-marker" }), "x");
    expect(odd.message).not.toContain("s3cret-marker");
    expect(odd.noHolder).toBe(true);
  });
});

describe("HcLaunchBlockedHealthSource", () => {
  it("says nothing while no launch is blocked", () => {
    expect(new HcLaunchBlockedHealthSource(() => null, () => T0).coverage()).toEqual([]);
  });
  it("shows one notice with the message, read each time so it clears with the client's state", () => {
    let why: string | null = "hc cannot launch x: no holder. Fix: run hc server restart";
    const source = new HcLaunchBlockedHealthSource(() => why, () => T0);
    const rows = source.coverage();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "hc-launch-blocked", status: "notice", partial: false, evaluatedAt: "2031-03-04T05:00:00.000Z" });
    expect(reasonOf(rows[0])).toContain("run hc server restart");
    why = null;
    expect(source.coverage()).toEqual([]);
    expect(source.read()).toEqual([]);
  });
});

/** A scripted core on a unix socket: `hello`, a stream subscription, status of a core with no holder, and a launch it refuses as unavailable. */
class RefusingCore {
  readonly dir = mkdtempSync(join(tmpdir(), "hclr-"));
  readonly socketPath = join(this.dir, "core.sock");
  private server: Server | null = null;
  private readonly sockets: Socket[] = [];
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
          const reply = message.method === "terminal.run"
            ? { error: { code: -32000, message: coreText, data: { kind: "unavailable" } } }
            : { result: message.method === "hello" ? { generation: 1, version: "0.1.16", core: { id: "core-a", name: "n" } }
              : message.method === "events.subscribe" ? { seq: 0, terminals: [] } : message.method === "server.status" ? noHolder : { ok: true } };
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, ...reply })}\n`);
        }
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(this.socketPath, resolve));
  }
  async close(): Promise<void> {
    for (const s of this.sockets.splice(0)) s.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    rmSync(this.dir, { recursive: true, force: true });
  }
}

describe("the daemon's `rig health` carries it", () => {
  it("a launch the daemon's own client had refused for want of a holder shows as a notice in the health projection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hclrd-"));
    const core = new RefusingCore();
    await core.listen();
    const saved = { HC_SOCKET: process.env.HC_SOCKET, NO_START: process.env.OPENRIG_HC_NO_START_CORE };
    process.env.HC_SOCKET = core.socketPath;
    process.env.OPENRIG_HC_NO_START_CORE = "1";
    const daemon = await createDaemon({ dbPath: join(dir, "openrig.sqlite") });
    try {
      const rows = () => (daemon.deps.healthProjection!.list().coverage ?? []).filter((c) => c.source === "hc-launch-blocked");
      expect(rows()).toEqual([]);  // control: nothing refused yet, nothing shown
      const result = await new HcHost(daemon.deps.hcTerminal!.client, { daemonEnv: {} }).createSession("qa@rig");
      expect(result).toMatchObject({ ok: false });
      expect(rows()).toHaveLength(1);
      expect(rows()[0]).toMatchObject({ status: "notice", partial: false });
      expect(reasonOf(rows()[0])).toContain("have the operator restart the hc core");
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
