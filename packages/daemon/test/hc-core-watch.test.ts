import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HcHello } from "../src/adapters/hc-client.js";
import {
  EMPTY_HC_VIEW, HC_HEARTBEAT_INTERVAL_MS, HC_HEARTBEAT_TIMEOUT_MS, HC_PINNED_VERSION, HcCoreRefusedError, HcCoreWatch, lossReason, probeCore, reduceHcView, turnsCompleted, verifyHello,
  type HcNotice, type HcStreamMessage, type HcView, type HcViewTerminal,
} from "../src/adapters/hc-core-watch.js";

const T = (address: string, over: Partial<HcViewTerminal> = {}): HcViewTerminal => ({
  address, labels: { "openrig.seat": `seat-${address}` }, argv: ["sh"], cwd: "/", state: "live", created_ms: 0, screen: "exact", cols: 200, rows: 120, turn: 0, status: null, ...over,
});
const apply = (view: HcView, ...messages: HcStreamMessage[]): HcView => messages.reduce((v, m) => reduceHcView(v, m).view, view);
const event = (seq: number, type: string, terminal: string, data: unknown): HcStreamMessage => ({ kind: "event", seq, type, terminal, data });
const snap = (seq: number, ...terminals: HcViewTerminal[]): HcStreamMessage => ({ kind: "snapshot", seq, terminals });

describe("reduceHcView", () => {
  it("replaces the whole view on a snapshot, and its seq with it, even a lower one from a new connection", () => {
    const view = apply(EMPTY_HC_VIEW, snap(900, T("t1"), T("t2")), snap(0, T("t3")));
    expect([...view.terminals.keys()]).toEqual(["t3"]);
    expect(view.seq).toBe(0);
  });
  it("applies an event above the seq and drops one at or below it", () => {
    const base = apply(EMPTY_HC_VIEW, snap(10, T("t1")));
    for (const seq of [9, 10]) {
      const out = reduceHcView(base, event(seq, "turn", "t1", { state: "done", turn: 5 }));
      expect(out.dropped).toBe(true);
      expect(out.view.terminals.get("t1")?.turn).toBe(0);
    }
    const out = reduceHcView(base, event(11, "turn", "t1", { state: "done", turn: 5 }));
    expect(out.dropped).toBe(false);
    expect(out.view.terminals.get("t1")?.turn).toBe(5);
    expect(out.view.seq).toBe(11);
  });
  it("treats `missed` as a full replacement: a terminal removed while the subscriber lagged vanishes", () => {
    const base = apply(EMPTY_HC_VIEW, snap(5, T("t1"), T("t2")));
    const out = reduceHcView(base, { kind: "missed", seq: 40, terminals: [T("t2", { labels: { x: "y" } }), T("t9")] });
    expect([...out.view.terminals.keys()].sort()).toEqual(["t2", "t9"]);
    expect(out.view.terminals.get("t2")?.labels).toEqual({ x: "y" });
    expect(out.notices).toEqual(expect.arrayContaining([{ kind: "missed" }, { kind: "gone", address: "t1" }]));
  });
  it("drops the events at or below a `missed` snapshot's seq that were already in flight", () => {
    const view = apply(EMPTY_HC_VIEW, snap(5, T("t1")), { kind: "missed", seq: 40, terminals: [T("t1")] });
    const stale = reduceHcView(view, event(39, "labels", "t1", { labels: { old: "1" } }));
    expect(stale.dropped).toBe(true);
    expect(stale.view.terminals.get("t1")?.labels).toEqual({ "openrig.seat": "seat-t1" });
    expect(reduceHcView(view, event(41, "labels", "t1", { labels: { new: "1" } })).view.terminals.get("t1")?.labels).toEqual({ new: "1" });
  });
  it("sets labels from the full set an event carries, not a delta", () => {
    const view = apply(EMPTY_HC_VIEW, snap(0, T("t1", { labels: { a: "1", b: "2" } })), event(1, "labels", "t1", { labels: { b: "3" } }));
    expect(view.terminals.get("t1")?.labels).toEqual({ b: "3" });
  });
  it("applies created, status, foreground, finished and removed as measured", () => {
    let view = apply(EMPTY_HC_VIEW, snap(0), event(1, "created", "t1", T("t1")));
    expect(view.terminals.has("t1")).toBe(true);
    view = apply(view, event(2, "status", "t1", { records: {}, reported: true, status: { app: "stub", state: "working" } }));
    expect(view.terminals.get("t1")?.status).toEqual({ app: "stub", state: "working" });
    view = apply(view, event(3, "foreground", "t1", { argv: ["claude"], cwd: "/w", name: "claude", pid: 77 }));
    expect(view.terminals.get("t1")).toMatchObject({ pid: 77, foreground: { name: "claude", pid: 77 } });
    view = apply(view, event(4, "finished", "t1", { exit_code: null, finished_ms: 9, reason: "holder_lost", signal: null }));
    expect(view.terminals.get("t1")).toMatchObject({ state: "finished", reason: "holder_lost", foreground: null });
    view = apply(view, event(5, "removed", "t1", {}));
    expect(view.terminals.has("t1")).toBe(false);
  });
  it("re-reads, not guesses, for an event type or shape it has not measured", () => {
    const base = apply(EMPTY_HC_VIEW, snap(0, T("t1")));
    for (const [type, data] of [["title", { title: "x" }], ["size", { cols: 1 }], ["turn", { turn: "two" }], ["labels", { labels: { a: 1 } }], ["status", "oops"]] as const) {
      const out = reduceHcView(base, event(1, type, "t1", data));
      expect(out.view.stale.has("t1"), type).toBe(true);
      expect(out.view.seq).toBe(1);
    }
    const refreshed = reduceHcView(reduceHcView(base, event(1, "title", "t1", {})).view, { kind: "refreshed", terminal: T("t1", { title: "fresh" }) });
    expect(refreshed.view.stale.size).toBe(0);
    expect(refreshed.view.terminals.get("t1")?.title).toBe("fresh");
  });
  it("re-reads an event for a terminal it never saw", () => {
    expect(reduceHcView(EMPTY_HC_VIEW, event(1, "status", "t9", { status: null })).view.stale.has("t9")).toBe(true);
  });
  it("notes a screen going inexact once, and every finish with its reason and seat", () => {
    const first = reduceHcView(apply(EMPTY_HC_VIEW, snap(0, T("t1"))), { kind: "missed", seq: 3, terminals: [T("t1", { screen: "inexact" })] });
    expect(first.notices).toContainEqual({ kind: "screen_inexact", address: "t1" });
    const again = reduceHcView(first.view, { kind: "missed", seq: 4, terminals: [T("t1", { screen: "inexact" })] });
    expect(again.notices.filter((n) => n.kind === "screen_inexact")).toEqual([]);
    const done = reduceHcView(again.view, event(5, "finished", "t1", { reason: "holder_lost", exit_code: null, finished_ms: 1, signal: null }));
    expect(done.notices).toEqual([{ kind: "finished", address: "t1", reason: "holder_lost", seat: "seat-t1" }]);
  });
});

describe("turns and loss", () => {
  it("counts a turn by comparing `turn`, never by counting status events", () => {
    let view = apply(EMPTY_HC_VIEW, snap(0, T("t1")));
    const before = view.terminals.get("t1");
    // Coalesced: 20,000 reports reached a subscriber as a few events, and none of them is a turn count.
    view = apply(view, event(1, "status", "t1", { status: { state: "working" } }), event(2, "status", "t1", { status: { state: "idle" } }), event(3, "status", "t1", { status: { state: "working" } }));
    expect(turnsCompleted(before, view.terminals.get("t1")!)).toBe(0);
    view = apply(view, event(4, "turn", "t1", { state: "done", turn: 3 }));
    expect(turnsCompleted(before, view.terminals.get("t1")!)).toBe(3);
  });
  it("counts the difference between two readings, and never a negative one", () => {
    expect(turnsCompleted({ turn: 2 }, { turn: 5 })).toBe(3);
    expect(turnsCompleted({ turn: 5 }, { turn: 2 })).toBe(0);
    expect(turnsCompleted(undefined, { turn: 4 })).toBe(4);
  });
  it("pins the heartbeat the core was measured to send, and allows for more than one late beat", () => {
    expect(HC_HEARTBEAT_INTERVAL_MS).toBe(15_000);
    expect(HC_HEARTBEAT_TIMEOUT_MS).toBeGreaterThanOrEqual(2 * HC_HEARTBEAT_INTERVAL_MS);
  });
  it("reads a lost seat from hc's reason, not from the program's own exit or a kill", () => {
    expect(lossReason({ state: "finished", reason: "holder_lost" })).toBe("holder_lost");
    expect(lossReason({ state: "finished", reason: "server_stop" })).toBe("server_stop");
    expect(lossReason({ state: "finished", reason: "exited" })).toBeNull();
    expect(lossReason({ state: "finished", reason: "killed" })).toBeNull();
    expect(lossReason({ state: "live", reason: "holder_lost" })).toBeNull();
  });
});

const hello = (over: Partial<HcHello> = {}): HcHello => ({ generation: 1, version: HC_PINNED_VERSION, core: { id: "core-a", name: "n" }, framed: false, methods: [], features: [], ...over });

describe("verifyHello", () => {
  it("accepts the pinned generation, version and core", () => {
    expect(() => verifyHello(hello(), { coreId: "core-a" })).not.toThrow();
  });
  it("refuses an unknown generation", () => {
    expect(() => verifyHello(hello({ generation: 2 }))).toThrow(expect.objectContaining({ kind: "unsupported_generation" }));
    expect(() => verifyHello(hello({ generation: 0 }))).toThrow(HcCoreRefusedError);
  });
  it("refuses a version that is not pinned, and accepts a listed one", () => {
    expect(() => verifyHello(hello({ version: "0.1.16" }))).toThrow(expect.objectContaining({ kind: "unsupported_version" }));
    expect(() => verifyHello(hello({ version: "0.1.16" }), { versions: ["0.1.16"] })).not.toThrow();
  });
  it("refuses a core that is not the one first seen", () => {
    expect(() => verifyHello(hello({ core: { id: "core-b", name: "n" } }), { coreId: "core-a" })).toThrow(expect.objectContaining({ kind: "core_changed" }));
  });
});

/** A core that speaks the protocol on a unix socket, so the watch's real connection code runs against scripted traffic. */
class FakeCore {
  readonly dir = mkdtempSync(join(tmpdir(), "hcw-"));
  readonly socketPath = join(this.dir, "core.sock");
  private server: Server | null = null;
  readonly connections: Socket[] = [];
  helloReply: () => Record<string, unknown> = () => ({ ...hello() });
  helloError: Record<string, unknown> | null = null;
  snapshot: () => { seq: number; terminals: HcViewTerminal[] } = () => ({ seq: 0, terminals: [] });
  silent = false;
  subscribes = 0;
  subscribeParams: unknown[] = [];
  /** Other methods (`terminal.get`): a result, or an `error` object. */
  methodsAnswered: Record<string, (params: unknown) => { result: unknown } | { error: Record<string, unknown> }> = {};
  /** Written in the same chunk as the subscribe reply, as a busy core can deliver them. */
  afterSnapshot: Record<string, unknown>[] = [];

  async listen(): Promise<void> {
    this.server = createServer((socket) => {
      this.connections.push(socket);
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("error", () => undefined);
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
          const message: unknown = JSON.parse(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
          if (this.silent || typeof message !== "object" || message === null || !("id" in message) || !("method" in message) || typeof message.method !== "string") continue;
          if (message.method === "hello") {
            socket.write(`${JSON.stringify(this.helloError ? { jsonrpc: "2.0", id: message.id, error: this.helloError } : { jsonrpc: "2.0", id: message.id, result: this.helloReply() })}\n`);
          } else if (message.method in this.methodsAnswered) {
            const answer = this.methodsAnswered[message.method]!("params" in message ? message.params : undefined);
            socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, ...answer })}\n`);
          } else if (message.method === "events.subscribe") {
            this.subscribes++;
            this.subscribeParams.push("params" in message ? message.params : undefined);
            const lines = [{ jsonrpc: "2.0", id: message.id, result: this.snapshot() }, ...this.afterSnapshot.map((m) => ({ jsonrpc: "2.0", ...m }))];
            socket.write(lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
          }
        }
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(this.socketPath, resolve));
  }
  push(message: Record<string, unknown>): void {
    for (const socket of this.connections) if (!socket.destroyed) socket.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }
  dropConnections(): void {
    for (const socket of this.connections.splice(0)) socket.destroy();
  }
  async close(): Promise<void> {
    this.dropConnections();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    rmSync(this.dir, { recursive: true, force: true });
  }
}

const until = async (check: () => boolean, what: string, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("HcCoreWatch against a scripted core", () => {
  const cores: FakeCore[] = [];
  const watches: HcCoreWatch[] = [];
  afterEach(async () => {
    for (const w of watches.splice(0)) w.stop();
    for (const c of cores.splice(0)) await c.close();
  });
  const setup = async (options: Partial<ConstructorParameters<typeof HcCoreWatch>[0]> = {}) => {
    const core = new FakeCore();
    cores.push(core);
    await core.listen();
    const notices: HcNotice[] = [];
    const watch = new HcCoreWatch({ socketPath: core.socketPath, onNotice: (n) => notices.push(n), reconnectDelaysMs: [20], heartbeatTimeoutMs: 400, helloTimeoutMs: 400, ...options });
    watches.push(watch);
    return { core, notices, watch };
  };

  it("starts from the snapshot and keeps the view current from events", async () => {
    const { core, watch } = await setup();
    core.snapshot = () => ({ seq: 7, terminals: [T("t1")] });
    await expect(watch.start()).resolves.toBe("streaming");
    expect(watch.view().seq).toBe(7);
    core.push({ method: "event", params: { seq: 8, type: "turn", terminal: "t1", data: { state: "done", turn: 1 } } });
    await until(() => watch.view().terminals.get("t1")?.turn === 1, "the turn event");
  });
  it("delivers events that arrive in the same chunk as the snapshot after it, not before", async () => {
    const { core, watch } = await setup();
    core.snapshot = () => ({ seq: 7, terminals: [T("t1")] });
    core.afterSnapshot = [{ method: "event", params: { seq: 8, type: "turn", terminal: "t1", data: { state: "done", turn: 9 } } }];
    await watch.start();
    await until(() => watch.view().terminals.get("t1")?.turn === 9, "the event after the snapshot");
  });
  it("reconnects after a plain EOF and takes the new connection's snapshot, seq included", async () => {
    const { core, notices, watch } = await setup();
    core.snapshot = () => ({ seq: 900, terminals: [T("t1"), T("t2")] });
    await watch.start();
    core.snapshot = () => ({ seq: 0, terminals: [T("t3")] });
    core.dropConnections();
    await until(() => core.subscribes === 2 && watch.view().seq === 0, "the second snapshot");
    expect([...watch.view().terminals.keys()]).toEqual(["t3"]);
    expect(notices.filter((n) => n.kind === "disconnected")).toHaveLength(1);
    core.push({ method: "event", params: { seq: 1, type: "turn", terminal: "t3", data: { state: "done", turn: 2 } } });
    await until(() => watch.view().terminals.get("t3")?.turn === 2, "an event whose seq is below the old connection's");
  });
  it("treats a missing heartbeat as a dead stream and reconnects", async () => {
    const { core, notices, watch } = await setup({ heartbeatTimeoutMs: 150 });
    await watch.start();
    await until(() => core.subscribes === 2, "a second subscribe after the silence");
    expect(notices).toContainEqual(expect.objectContaining({ kind: "stream_dead" }));
  });
  it("stays on a stream that keeps hearing heartbeats", async () => {
    const { core, notices, watch } = await setup({ heartbeatTimeoutMs: 200 });
    await watch.start();
    for (let i = 0; i < 6; i++) {
      core.push({ method: "heartbeat", params: { seq: 0 } });
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    expect(core.subscribes).toBe(1);
    expect(notices.some((n) => n.kind === "stream_dead")).toBe(false);
  });
  it("applies `missed` as a replacement mid-stream", async () => {
    const { core, notices, watch } = await setup();
    core.snapshot = () => ({ seq: 1, terminals: [T("t1"), T("t2")] });
    await watch.start();
    core.push({ method: "missed", params: { seq: 50, terminals: [T("t2")] } });
    await until(() => watch.view().seq === 50, "the missed snapshot");
    expect([...watch.view().terminals.keys()]).toEqual(["t2"]);
    expect(notices).toContainEqual({ kind: "missed" });
  });
  it("refuses an unknown generation at start, and does not retry", async () => {
    const { core, notices, watch } = await setup();
    core.helloReply = () => ({ ...hello({ generation: 2 }) });
    await expect(watch.start()).rejects.toMatchObject({ kind: "unsupported_generation" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(watch.state()).toBe("refused");  // still, after several reconnect delays would have passed
    expect(core.subscribes).toBe(0);
    expect(notices.filter((n) => n.kind === "refused")).toHaveLength(1);
    expect(notices).toContainEqual(expect.objectContaining({ kind: "refused" }));
  });
  it("refuses a core that answers `unsupported_generation` itself", async () => {
    const { core, watch } = await setup();
    core.helloError = { code: -32000, message: "unsupported_generation", data: { kind: "unsupported_generation" } };
    await expect(watch.start()).rejects.toBeInstanceOf(HcCoreRefusedError);
  });
  it("refuses a version that is not pinned", async () => {
    const { core, watch } = await setup();
    core.helloReply = () => ({ ...hello({ version: "9.9.9" }) });
    await expect(watch.start()).rejects.toMatchObject({ kind: "unsupported_version" });
  });
  it("refuses a different core after a reconnect, and stops", async () => {
    const { core, watch } = await setup();
    await watch.start();
    core.helloReply = () => ({ ...hello({ core: { id: "core-b", name: "n" } }) });
    core.dropConnections();
    await until(() => watch.state() === "refused", "the refusal");
    expect(core.subscribes).toBe(1);
  });
  it("keeps retrying, not refusing, while the core is unreachable, and reports it as unavailable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hcw-"));
    const watch = new HcCoreWatch({ socketPath: join(dir, "none.sock"), reconnectDelaysMs: [20] });
    watches.push(watch);
    try {
      await expect(watch.start()).resolves.toBe("reconnecting");
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(watch.state()).toBe("reconnecting");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("starts a core when its socket is gone, as after a reboot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hcw-"));
    let starts = 0;
    const watch = new HcCoreWatch({ socketPath: join(dir, "none.sock"), reconnectDelaysMs: [20], startSettleMs: 20, startCore: async () => { starts++; } });
    watches.push(watch);
    await watch.start();
    expect(starts).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });
  it("never starts a core when one may be alive and slow", async () => {
    let starts = 0;
    const { core, watch: hung } = await setup({ startCore: async () => { starts++; } });
    core.silent = true;
    await hung.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(starts).toBe(0);
  });
  it("re-reads a terminal an event could not update, and drops one that is no longer there", async () => {
    const { core, watch } = await setup();
    core.snapshot = () => ({ seq: 1, terminals: [T("t1"), T("t2")] });
    core.methodsAnswered["terminal.get"] = (params) => {
      const wanted = typeof params === "object" && params !== null && "terminal" in params ? params.terminal : undefined;
      return wanted === "t1" ? { result: T("t1", { title: "re-read" }) } : { error: { code: -32000, message: "no terminal", data: { kind: "not_found" } } };
    };
    await watch.start();
    core.push({ method: "event", params: { seq: 2, type: "title", terminal: "t1", data: { title: "ignored shape" } } });
    core.push({ method: "event", params: { seq: 3, type: "title", terminal: "t2", data: {} } });
    await until(() => watch.view().terminals.get("t1")?.title === "re-read" && !watch.view().terminals.has("t2") && watch.view().stale.size === 0, "the re-read and the drop");
  });
  it("subscribes to only the terminals carrying the labels it was given", async () => {
    const { core, watch } = await setup({ labels: { "openrig.seat": "w@rig" } });
    await watch.start();
    expect(core.subscribeParams).toEqual([{ labels: { "openrig.seat": "w@rig" } }]);
  });
  it("lets a listener throw without breaking the stream", async () => {
    const { core, watch } = await setup({ onNotice: () => { throw new Error("listener"); } });
    core.snapshot = () => ({ seq: 1, terminals: [T("t1")] });
    await expect(watch.start()).resolves.toBe("streaming");
    core.push({ method: "event", params: { seq: 2, type: "turn", terminal: "t1", data: { state: "done", turn: 4 } } });
    await until(() => watch.view().terminals.get("t1")?.turn === 4, "an event after a throwing listener");
  });
});

describe("probeCore", () => {
  it("reads a socket nobody created as absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hcw-"));
    try {
      await expect(probeCore(join(dir, "x.sock"))).resolves.toEqual({ state: "absent" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("reads a core that accepts and never answers as unresponsive, not as gone", async () => {
    const core = new FakeCore();
    await core.listen();
    core.silent = true;
    try {
      await expect(probeCore(core.socketPath, { helloTimeoutMs: 80 })).resolves.toMatchObject({ state: "unresponsive" });
    } finally {
      await core.close();
    }
  });
  it("answers with the hello of a core that is there", async () => {
    const core = new FakeCore();
    await core.listen();
    try {
      await expect(probeCore(core.socketPath)).resolves.toMatchObject({ state: "present", hello: { generation: 1 } });
    } finally {
      await core.close();
    }
  });
});
