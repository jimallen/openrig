import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HcError, HcUnavailableError, HC_GENERATION, type HcClient, type HcTerminal } from "../src/adapters/hc-client.js";
import type { HcAttachEnd, HcAttachHandlers, HcAttachOpener, HcAttachParams, HcAttachment } from "../src/adapters/hc-attach.js";
import {
  CoreSizeSource, HcViewer, HcViewerUnsupportedError, ModeTracker, cursorOfPaint, fullScreenHistoryReadIsUnsafe,
  type SizeHandlers, type SizeSource, type SizeWatch, type ViewEnd, type ViewHandlers, type ViewSize,
} from "../src/adapters/hc-viewer.js";

const TERMINAL: HcTerminal = { address: "t1", name: "n", labels: {}, argv: [], cwd: "/", state: "live", created_ms: 0, screen: "exact", cols: 200, rows: 120 };
const bytes = (text: string) => Buffer.from(text, "latin1");
const tick = () => new Promise((resolve) => setImmediate(resolve));

// ---- doubles -----------------------------------------------------------------------------------------------------------

interface Plan {
  terminal?: Partial<HcTerminal>;
  /** Frames delivered before open() returns, as when the first paint shares the reply's chunk. */
  early?: Buffer[];
  reject?: unknown;
}

class FakeAttachment {
  detaches = 0;
  constructor(readonly params: HcAttachParams, readonly handlers: HcAttachHandlers, readonly terminal: HcTerminal) {}
  push(data: Buffer | string): void { this.handlers.onData(typeof data === "string" ? bytes(data) : data); }
  end(end: HcAttachEnd): void { this.handlers.onEnd(end); }
}

class FakeOpener implements HcAttachOpener {
  readonly attachments: FakeAttachment[] = [];
  readonly asked: HcAttachParams[] = [];
  readonly queue: Plan[] = [];
  /** Plans used when the queue is empty. */
  fallback: Plan = {};

  async open(params: HcAttachParams, handlers: HcAttachHandlers): Promise<HcAttachment> {
    this.asked.push(params);
    const plan = this.queue.shift() ?? this.fallback;
    if (plan.reject !== undefined) throw plan.reject;
    const fake = new FakeAttachment(params, handlers, { ...TERMINAL, ...plan.terminal });
    this.attachments.push(fake);
    for (const chunk of plan.early ?? []) fake.push(chunk);
    return {
      terminal: fake.terminal,
      observe: params.observe ?? false,
      write: () => { throw new Error("an observer cannot write"); },
      resize: () => { throw new Error("an observer cannot resize"); },
      detach: async () => { fake.detaches++; return { reason: "detached" } as const; },
    };
  }
}

class FakeSizes implements SizeSource {
  readonly watches: { terminal: string; handlers: SizeHandlers; closed: boolean }[] = [];
  reject: unknown = null;
  async watch(terminal: string, handlers: SizeHandlers): Promise<SizeWatch> {
    if (this.reject) throw this.reject;
    const entry = { terminal, handlers, closed: false };
    this.watches.push(entry);
    return { close: () => { entry.closed = true; } };
  }
  get live() { return this.watches.filter((w) => !w.closed); }
}

interface Log { events: string[]; sizes: ViewSize[]; data: string[]; ends: ViewEnd[] }
function recorder(): { log: Log; handlers: ViewHandlers } {
  const log: Log = { events: [], sizes: [], data: [], ends: [] };
  return {
    log,
    handlers: {
      onPaint: () => log.events.push("paint"),
      onSize: (size) => { log.sizes.push(size); log.events.push(`size ${size.cols}x${size.rows}`); },
      onData: (b) => { log.data.push(b.toString("latin1")); log.events.push(`data ${b.toString("latin1")}`); },
      onEnd: (end) => { log.ends.push(end); log.events.push(`end ${end.reason}`); },
    },
  };
}

function rig(options: { delays?: number[]; client?: Partial<HcClient> } = {}) {
  const opener = new FakeOpener();
  const sizes = new FakeSizes();
  const slept: number[] = [];
  const viewer = new HcViewer({
    opener, sizes, client: (options.client ?? {}) as HcClient, reconnectDelaysMs: options.delays ?? [10, 20],
    sleep: async (ms) => { slept.push(ms); },
    paintSettleMs: 5, paintMaxMs: 30, paintFirstMs: 40,
  });
  return { opener, sizes, viewer, slept };
}

// ---- pure reading of the stream ----------------------------------------------------------------------------------------

describe("ModeTracker", () => {
  const modes = (...chunks: string[]) => { const t = new ModeTracker(); for (const c of chunks) t.feed(bytes(c)); return t.modes(); };

  it("reads the alternate screen and mouse reporting from DECSET and DECRST", () => {
    expect(modes("\x1b[?1049h")).toEqual({ altScreen: true, mouse: false });
    expect(modes("\x1b[?1000h\x1b[?1006h")).toEqual({ altScreen: false, mouse: true });
    expect(modes("\x1b[?1049h\x1b[?1002h\x1b[?1049l")).toEqual({ altScreen: false, mouse: true });
    expect(modes("\x1b[?1049h\x1b[?1049l\x1b[?1003h\x1b[?1003l")).toEqual({ altScreen: false, mouse: false });
  });

  it("knows each alternate-screen mode and each mouse-reporting mode, and not the encodings", () => {
    for (const mode of [47, 1047, 1049]) expect(modes(`\x1b[?${mode}h`).altScreen).toBe(true);
    for (const mode of [9, 1000, 1001, 1002, 1003]) expect(modes(`\x1b[?${mode}h`).mouse).toBe(true);
    for (const mode of [1005, 1006, 1015, 2004, 25]) expect(modes(`\x1b[?${mode}h`)).toEqual({ altScreen: false, mouse: false });
  });

  it("reads a sequence that sets several modes", () => {
    expect(modes("\x1b[?25;1049;1006h")).toEqual({ altScreen: true, mouse: false });
    expect(modes("\x1b[?1000;1049h\x1b[?1000;25l")).toEqual({ altScreen: true, mouse: false });
  });

  it("reads a sequence split across frames at every offset", () => {
    const text = "x\x1b[?1049hy\x1b[?1000hz";
    for (let at = 1; at < text.length; at++) {
      expect(modes(text.slice(0, at), text.slice(at)), `split at ${at}`).toEqual({ altScreen: true, mouse: true });
    }
  });

  it("does not take a half sequence for a mode, nor keep it past the frame that finishes it", () => {
    expect(modes("\x1b[?104")).toEqual({ altScreen: false, mouse: false });
    expect(modes("\x1b[?104", "x9h")).toEqual({ altScreen: false, mouse: false });
    expect(modes("\x1b[?1049h", "plain text")).toEqual({ altScreen: true, mouse: false });
  });

  it("goes back to the defaults on a soft reset or a full reset, as the first paint opens with one", () => {
    expect(modes("\x1b[?1049h\x1b[?1000h\x1b[!p")).toEqual({ altScreen: false, mouse: false });
    expect(modes("\x1b[?1049h\x1b[?1000h\x1bc")).toEqual({ altScreen: false, mouse: false });
    expect(modes("\x1b[?1049h\x1b[!p\x1b[?1000h")).toEqual({ altScreen: false, mouse: true });
  });

  it("forgets everything on reset()", () => {
    const t = new ModeTracker();
    t.feed(bytes("\x1b[?1049h\x1b[?1000h\x1b[?10"));
    t.reset();
    t.feed(bytes("00h"));
    expect(t.modes()).toEqual({ altScreen: false, mouse: false });
  });
});

describe("fullScreenHistoryReadIsUnsafe", () => {
  it("is unsafe on an alternate screen or with the mouse reported, and safe on a plain screen", () => {
    expect(fullScreenHistoryReadIsUnsafe({ altScreen: false, mouse: false })).toBe(false);
    expect(fullScreenHistoryReadIsUnsafe({ altScreen: true, mouse: false })).toBe(true);
    expect(fullScreenHistoryReadIsUnsafe({ altScreen: false, mouse: true })).toBe(true);
    expect(fullScreenHistoryReadIsUnsafe({ altScreen: true, mouse: true })).toBe(true);
  });
});

describe("cursorOfPaint", () => {
  it("is the last absolute move, zero-based", () => {
    expect(cursorOfPaint("\x1b[H\x1b[2Jbody\x1b[12;20H")).toEqual({ x: 19, y: 11 });
    expect(cursorOfPaint("\x1b[3;4Hmid\x1b[7;30H\x1b]2;title\x07")).toEqual({ x: 29, y: 6 });
  });

  it("reads a move that names only a row, or neither, as column 1 and row 1", () => {
    expect(cursorOfPaint("\x1b[5H")).toEqual({ x: 0, y: 4 });
    expect(cursorOfPaint("text\x1b[H")).toEqual({ x: 0, y: 0 });
  });

  it("is null when the paint holds no move", () => {
    expect(cursorOfPaint("")).toBeNull();
    expect(cursorOfPaint("\x1b[2J\x1b[31mred\x1b[0m")).toBeNull();
  });
});

// ---- the size line -----------------------------------------------------------------------------------------------------

describe("CoreSizeSource", () => {
  const scratch: { dir: string; server: Server; sockets: Set<Socket> }[] = [];
  afterEach(async () => {
    for (const { dir, server, sockets } of scratch.splice(0)) {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  interface Request { id: number; method: string; params: Record<string, unknown> }
  async function fakeCore(onRequest: (socket: Socket, request: Request) => void): Promise<{ path: string; requests: Request[]; sockets: Set<Socket> }> {
    const dir = mkdtempSync(join(tmpdir(), "hc-size-"));
    const path = join(dir, "c.sock");
    const requests: Request[] = [];
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {});
      let buffer = "";
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
          const request = JSON.parse(buffer.slice(0, end)) as Request;
          buffer = buffer.slice(end + 1);
          requests.push(request);
          onRequest(socket, request);
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(path, resolve));
    scratch.push({ dir, server, sockets });
    return { path, requests, sockets };
  }
  const reply = (socket: Socket, id: number, result: unknown) => socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  const event = (socket: Socket, type: string, data: unknown, terminal = "t1") => socket.write(`${JSON.stringify({ jsonrpc: "2.0", method: "event", params: { seq: 9, terminal, type, data } })}\n`);
  const standard = (socket: Socket, request: Request) => {
    if (request.method === "hello") reply(socket, request.id, { generation: HC_GENERATION, framed: false });
    else if (request.method === "events.subscribe") reply(socket, request.id, { seq: 1, channel: null, terminals: [{ ...TERMINAL, cols: 90, rows: 27 }] });
  };
  const handlers = () => {
    const seen: ViewSize[] = [];
    const lost: string[] = [];
    return { seen, lost, handlers: { size: (s: ViewSize) => seen.push(s), lost: (c: string) => lost.push(c) } as SizeHandlers };
  };

  it("subscribes to the one terminal in plain mode at this generation, and gives its size from the snapshot", async () => {
    const core = await fakeCore(standard);
    const { seen, handlers: h } = handlers();
    const watch = await new CoreSizeSource(core.path).watch("t1", h);
    expect(core.requests.map((r) => [r.method, r.params])).toEqual([
      ["hello", { generation: HC_GENERATION, framed: false }],
      ["events.subscribe", { terminal: "t1" }],
    ]);
    expect(seen).toEqual([{ cols: 90, rows: 27 }]);
    watch.close();
  });

  it("gives each size event, and nothing else the stream carries", async () => {
    const core = await fakeCore(standard);
    const { seen, handlers: h } = handlers();
    const watch = await new CoreSizeSource(core.path).watch("t1", h);
    const [socket] = [...core.sockets];
    event(socket!, "size", { cols: 100, rows: 30 });
    event(socket!, "title", { title: "x" });
    event(socket!, "restarted", { cols: 5, rows: 5 });  // another event that happens to carry a size
    event(socket!, "size", { cols: 64, rows: 16 }, "t2");  // and another terminal's: the subscription names one, but the line is checked too
    event(socket!, "size", { cols: 64, rows: 16 });
    socket!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "heartbeat", params: { seq: 9 } })}\n`);
    await expect.poll(() => seen).toEqual([{ cols: 90, rows: 27 }, { cols: 100, rows: 30 }, { cols: 64, rows: 16 }]);
    watch.close();
  });

  it("drops a size that is not two positive integers", async () => {
    const core = await fakeCore(standard);
    const { seen, handlers: h } = handlers();
    const watch = await new CoreSizeSource(core.path).watch("t1", h);
    const [socket] = [...core.sockets];
    event(socket!, "size", { cols: 0, rows: 30 });
    event(socket!, "size", { cols: "100", rows: 30 });
    event(socket!, "size", { cols: 100 });
    event(socket!, "size", "oops");
    event(socket!, "size", { cols: 101, rows: 31 });
    await expect.poll(() => seen.at(-1)).toEqual({ cols: 101, rows: 31 });
    expect(seen).toEqual([{ cols: 90, rows: 27 }, { cols: 101, rows: 31 }]);
    watch.close();
  });

  it("says the line is lost when the core closes it, and not after the watch was closed", async () => {
    const core = await fakeCore(standard);
    const first = handlers();
    await new CoreSizeSource(core.path).watch("t1", first.handlers);
    [...core.sockets][0]!.destroy();
    await expect.poll(() => first.lost).toEqual(["the core closed the connection"]);

    const second = handlers();
    const watch = await new CoreSizeSource(core.path).watch("t1", second.handlers);
    watch.close();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(second.lost).toEqual([]);
  });

  it("says the line is lost when the core goes quiet for longer than the heartbeat allows", async () => {
    const core = await fakeCore(standard);
    const { lost, handlers: h } = handlers();
    const watch = await new CoreSizeSource(core.path, { heartbeatTimeoutMs: 40 }).watch("t1", h);
    await expect.poll(() => lost.length).toBe(1);
    expect(lost[0]).toMatch(/no heartbeat or event in 40 ms/);
    watch.close();
  });

  it("keeps a line alive that hears events inside the heartbeat window", async () => {
    const core = await fakeCore(standard);
    const { lost, handlers: h } = handlers();
    const watch = await new CoreSizeSource(core.path, { heartbeatTimeoutMs: 120 }).watch("t1", h);
    const [socket] = [...core.sockets];
    for (let i = 0; i < 4; i++) {
      await new Promise((resolve) => setTimeout(resolve, 60));
      event(socket!, "title", { title: String(i) });
    }
    expect(lost).toEqual([]);
    watch.close();
  });

  it("rejects with hc's own error for a terminal the core does not know, a generation it does not speak, and a core that is not there", async () => {
    const absent = await fakeCore((socket, request) => {
      if (request.method === "hello") reply(socket, request.id, { generation: HC_GENERATION });
      else socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "not_found", data: { kind: "not_found" } } })}\n`);
    });
    await expect(new CoreSizeSource(absent.path).watch("t9", handlers().handlers)).rejects.toMatchObject({ name: "HcError", kind: "not_found" });

    const other = await fakeCore((socket, request) => reply(socket, request.id, { generation: 99 }));
    await expect(new CoreSizeSource(other.path).watch("t1", handlers().handlers)).rejects.toMatchObject({ kind: "unsupported_generation" });

    await expect(new CoreSizeSource("/nonexistent/hc.sock").watch("t1", handlers().handlers)).rejects.toBeInstanceOf(HcUnavailableError);
    const mute = await fakeCore(() => {});
    await expect(new CoreSizeSource(mute.path, { timeoutMs: 40 }).watch("t1", handlers().handlers)).rejects.toBeInstanceOf(HcUnavailableError);
  });
});

// ---- the view ----------------------------------------------------------------------------------------------------------

describe("HcViewer.view", () => {
  it("attaches as an observer and never types or resizes: the fixed 90x27 pin is gone", async () => {
    const { opener, viewer } = rig();
    const { handlers } = recorder();
    const opened = await viewer.view("dev-impl@rig", handlers);
    expect(opened.ok).toBe(true);
    expect(opener.asked).toHaveLength(1);
    expect(opener.asked[0]).toMatchObject({ observe: true });
    expect(opener.asked[0]!.terminal).toMatch(/^s-[0-9a-f]{24}$/);  // the seat's hc name, not the canonical name
    expect(opener.asked[0]!.history ?? 0).toBe(0);
    expect(opener.asked[0]).not.toMatchObject({ cols: 90, rows: 27 });
  });

  it("addresses an hc address as it is, and a terminal hc could not hold as absent", async () => {
    const { opener, viewer } = rig();
    await viewer.view("t7", recorder().handlers);
    expect(opener.asked[0]!.terminal).toBe("t7");
    const none = await viewer.view("%3", recorder().handlers);
    expect(none).toEqual({ ok: false, end: { reason: "absent" } });
    expect(opener.asked).toHaveLength(1);
  });

  it("tells the size before the first byte, even when the first paint came with the attach reply", async () => {
    const { opener, viewer } = rig();
    opener.fallback = { terminal: { cols: 132, rows: 43 }, early: [bytes("\x1b[!p"), bytes("PAINT")] };
    const { log, handlers } = recorder();
    await viewer.view("dev@rig", handlers);
    expect(log.events).toEqual(["paint", "size 132x43", "data \x1b[!p", "data PAINT"]);
  });

  it("follows the terminal's size from its size events, once per change", async () => {
    const { sizes, opener, viewer } = rig();
    const { log, handlers } = recorder();
    const opened = await viewer.view("dev@rig", handlers);
    if (!opened.ok) throw new Error("not open");
    expect(sizes.watches.map((w) => w.terminal)).toEqual(["t1"]);  // the address the attach answered with
    const [watch] = sizes.live;
    watch!.handlers.size({ cols: 200, rows: 120 });  // the snapshot repeats what the attach said
    watch!.handlers.size({ cols: 100, rows: 30 });
    watch!.handlers.size({ cols: 100, rows: 30 });
    watch!.handlers.size({ cols: 64, rows: 16 });
    expect(log.sizes).toEqual([{ cols: 200, rows: 120 }, { cols: 100, rows: 30 }, { cols: 64, rows: 16 }]);
    expect(opened.view.size()).toEqual({ cols: 64, rows: 16 });
  });

  it("reports a size change that happened between the attach and the subscription", async () => {
    const { sizes, viewer } = rig();
    const original = sizes.watch.bind(sizes);
    sizes.watch = async (terminal, handlers) => { handlers.size({ cols: 80, rows: 24 }); return original(terminal, handlers); };
    const { log, handlers } = recorder();
    await viewer.view("dev@rig", handlers);
    await tick();
    expect(log.sizes).toEqual([{ cols: 200, rows: 120 }, { cols: 80, rows: 24 }]);
  });

  it("delivers the program's bytes in order, and tracks its modes from them", async () => {
    const { opener, viewer } = rig();
    const { log, handlers } = recorder();
    const opened = await viewer.view("dev@rig", handlers);
    if (!opened.ok) throw new Error("not open");
    opener.attachments[0]!.push("\x1b[?1049h");
    opener.attachments[0]!.push("\x1b[?1000hhello");
    expect(log.data).toEqual(["\x1b[?1049h", "\x1b[?1000hhello"]);
    expect(opened.view.modes()).toEqual({ altScreen: true, mouse: true });
  });

  it("never lets a throwing listener break the stream", async () => {
    const { opener, viewer } = rig();
    const seen: string[] = [];
    await viewer.view("dev@rig", { onPaint: () => { throw new Error("x"); }, onSize: () => { throw new Error("x"); }, onData: (b) => { seen.push(b.toString()); throw new Error("x"); }, onEnd: () => {} });
    opener.attachments[0]!.push("a");
    opener.attachments[0]!.push("b");
    expect(seen).toEqual(["a", "b"]);
  });

  describe("how it ends", () => {
    it("reports a terminal that is not there as absent, and does not retry", async () => {
      const { opener, viewer, slept } = rig();
      opener.queue.push({ reject: new HcError("nf", "not_found", -32000) });
      expect(await viewer.view("dev@rig", recorder().handlers)).toEqual({ ok: false, end: { reason: "absent" } });
      expect(slept).toEqual([]);
      opener.queue.push({ reject: new HcError("nf", "machine_unknown", -32000) });
      expect(await viewer.view("dev@rig", recorder().handlers)).toEqual({ ok: false, end: { reason: "absent" } });
    });

    it("reports an unreachable core and a core that refuses as unavailable, with no retry on the first attach", async () => {
      const { opener, viewer, slept } = rig();
      opener.queue.push({ reject: new HcUnavailableError("no socket") });
      expect(await viewer.view("dev@rig", recorder().handlers)).toEqual({ ok: false, end: { reason: "unavailable", cause: "no socket" } });
      opener.queue.push({ reject: new HcError("cannot", "unavailable", -32000) });
      expect(await viewer.view("dev@rig", recorder().handlers)).toEqual({ ok: false, end: { reason: "unavailable", cause: "hc refused the attach: unavailable" } });
      expect(slept).toEqual([]);
    });

    it("reports a terminal that had finished with the facts it left", async () => {
      const calls: unknown[] = [];
      const { opener, viewer } = rig({ client: { call: (async (method: string, params: unknown) => { calls.push([method, params]); return { ...TERMINAL, state: "finished", exit_code: 3, reason: "exited", finished_ms: 99, signal: null }; }) as unknown as HcClient["call"] } });
      opener.queue.push({ reject: new HcError("finished", "finished", -32000, "read what it left") });
      expect(await viewer.view("t4", recorder().handlers)).toEqual({ ok: false, end: { reason: "program_ended", exitCode: 3, signal: null, endReason: "exited", finishedMs: 99 } });
      expect(calls).toEqual([["terminal.get", { terminal: "t4" }]]);
    });

    it("reports a finished terminal whose facts cannot be read as ended, with no facts", async () => {
      const { opener, viewer } = rig({ client: { call: (async () => { throw new HcUnavailableError("gone"); }) as unknown as HcClient["call"] } });
      opener.queue.push({ reject: new HcError("finished", "finished", -32000) });
      expect(await viewer.view("t4", recorder().handlers)).toEqual({ ok: false, end: { reason: "program_ended", exitCode: null, signal: null, endReason: null, finishedMs: null } });
    });

    it("ends with the CLOSE frame's exit code, signal and reason", async () => {
      const { opener, viewer, sizes } = rig();
      const { log, handlers } = recorder();
      await viewer.view("dev@rig", handlers);
      await tick();
      expect(sizes.live).toHaveLength(1);
      opener.attachments[0]!.end({ reason: "program_ended", exitCode: 3, signal: null, endReason: "exited", finishedMs: 99 });
      expect(log.ends).toEqual([{ reason: "program_ended", exitCode: 3, signal: null, endReason: "exited", finishedMs: 99 }]);
      expect(sizes.live).toHaveLength(0);  // the size line is closed with the view
      expect(opener.attachments).toHaveLength(1);  // and nothing attaches again
    });

    it("does not call onEnd for its own close, and closes the attach and the size line", async () => {
      const { opener, viewer, sizes } = rig();
      const { log, handlers } = recorder();
      const opened = await viewer.view("dev@rig", handlers);
      if (!opened.ok) throw new Error("not open");
      await tick();
      await opened.view.close();
      expect(opener.attachments[0]!.detaches).toBe(1);
      expect(sizes.live).toHaveLength(0);
      opener.attachments[0]!.push("late");
      opener.attachments[0]!.end({ reason: "detached" });
      expect(log.data).toEqual([]);
      expect(log.ends).toEqual([]);
      expect(await opened.view.repaint()).toBe(false);
    });
  });

  describe("a core restart", () => {
    it("attaches again after a plain EOF, announces the new paint, and keeps the size it knew", async () => {
      const { opener, viewer, sizes } = rig();
      opener.fallback = { terminal: { cols: 100, rows: 30 } };
      const { log, handlers } = recorder();
      await viewer.view("dev@rig", handlers);
      await tick();
      opener.attachments[0]!.push("before");
      opener.attachments[0]!.end({ reason: "core_lost" });
      await expect.poll(() => opener.attachments.length).toBe(2);
      opener.attachments[1]!.push("AFTER");
      expect(log.events).toEqual(["paint", "size 100x30", "data before", "paint", "data AFTER"]);
      expect(log.ends).toEqual([]);
      expect(sizes.watches[0]!.closed).toBe(true);  // the old line closed
      await expect.poll(() => sizes.live.length).toBe(1);
    });

    it("tells a size that changed across the restart", async () => {
      const { opener, viewer } = rig();
      const { log, handlers } = recorder();
      await viewer.view("dev@rig", handlers);
      opener.queue.push({ terminal: { cols: 77, rows: 22 } });
      opener.attachments[0]!.end({ reason: "core_lost" });
      await expect.poll(() => log.sizes.length).toBe(2);
      expect(log.sizes).toEqual([{ cols: 200, rows: 120 }, { cols: 77, rows: 22 }]);
    });

    it("waits out a core that is still down, by the configured delays, and gives up as unavailable after the last", async () => {
      const { opener, viewer, slept } = rig({ delays: [10, 20, 30] });
      const { log, handlers } = recorder();
      await viewer.view("dev@rig", handlers);
      for (let i = 0; i < 4; i++) opener.queue.push({ reject: new HcUnavailableError(`down ${i}`) });
      opener.attachments[0]!.end({ reason: "core_lost" });
      await expect.poll(() => log.ends).toEqual([{ reason: "unavailable", cause: "down 3" }]);
      expect(slept).toEqual([10, 20, 30]);
      expect(opener.asked).toHaveLength(5);
    });

    it("says nothing more once closed, even when a reconnect attempt was in flight", async () => {
      const opener = new FakeOpener();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const open = opener.open.bind(opener);
      let attempts = 0;
      opener.open = async (params, handlers) => { if (++attempts === 2) await gate; return open(params, handlers); };
      const viewer = new HcViewer({ opener, sizes: new FakeSizes(), client: {} as HcClient, reconnectDelaysMs: [10] });
      const { log, handlers } = recorder();
      const opened = await viewer.view("dev@rig", handlers);
      if (!opened.ok) throw new Error("not open");
      opener.queue.push({ reject: new HcError("nf", "not_found", -32000) });
      opener.attachments[0]!.end({ reason: "core_lost" });
      await expect.poll(() => attempts).toBe(2);
      await opened.view.close();
      release();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(log.ends).toEqual([]);
    });

    it("recovers when the core comes back inside the delays", async () => {
      const { opener, viewer, slept } = rig({ delays: [10, 20, 30] });
      const { log, handlers } = recorder();
      await viewer.view("dev@rig", handlers);
      opener.queue.push({ reject: new HcUnavailableError("down") }, { reject: new HcUnavailableError("down") });
      opener.attachments[0]!.end({ reason: "core_lost" });
      await expect.poll(() => opener.attachments.length).toBe(2);
      expect(slept).toEqual([10, 20]);
      expect(log.ends).toEqual([]);
    });

    it("ends absent when the restarted core no longer has the terminal, and ended when it finished", async () => {
      const gone = rig();
      const goneLog = recorder();
      await gone.viewer.view("dev@rig", goneLog.handlers);
      gone.opener.queue.push({ reject: new HcError("nf", "not_found", -32000) });
      gone.opener.attachments[0]!.end({ reason: "core_lost" });
      await expect.poll(() => goneLog.log.ends).toEqual([{ reason: "absent" }]);

      const lost = rig({ client: { call: (async () => ({ ...TERMINAL, state: "finished", reason: "holder_lost", exit_code: null, finished_ms: 5 })) as unknown as HcClient["call"] } });
      const lostLog = recorder();
      await lost.viewer.view("dev@rig", lostLog.handlers);
      lost.opener.queue.push({ reject: new HcError("fin", "finished", -32000) });
      lost.opener.attachments[0]!.end({ reason: "core_lost" });
      await expect.poll(() => lostLog.log.ends).toEqual([{ reason: "program_ended", exitCode: null, signal: null, endReason: "holder_lost", finishedMs: 5 }]);
    });

    it("drops what an attach that is being replaced still sends", async () => {
      const { opener, viewer } = rig();
      const { log, handlers } = recorder();
      await viewer.view("dev@rig", handlers);
      opener.attachments[0]!.end({ reason: "core_lost" });
      await expect.poll(() => opener.attachments.length).toBe(2);
      opener.attachments[0]!.push("STALE");
      opener.attachments[0]!.end({ reason: "program_ended", exitCode: 1, signal: null, endReason: "exited", finishedMs: 1 });
      expect(log.data).toEqual([]);
      expect(log.ends).toEqual([]);
    });
  });

  describe("the size line", () => {
    it("attaches again when the size line is lost, because a viewer that cannot follow the size draws a wrong screen", async () => {
      const { opener, sizes, viewer } = rig();
      const { log, handlers } = recorder();
      await viewer.view("dev@rig", handlers);
      await tick();
      sizes.live[0]!.handlers.lost("no heartbeat");
      await expect.poll(() => opener.attachments.length).toBe(2);
      expect(log.events.filter((e) => e === "paint")).toHaveLength(2);
    });

    it("attaches again when the size line cannot be opened", async () => {
      const { opener, sizes, viewer } = rig({ delays: [5] });
      sizes.reject = new HcUnavailableError("down");
      const { log, handlers } = recorder();
      opener.queue.push({}, { reject: new HcUnavailableError("down") }, { reject: new HcUnavailableError("down") });
      await viewer.view("dev@rig", handlers);
      await expect.poll(() => log.ends).toEqual([{ reason: "unavailable", cause: "down" }]);
    });

    it("ignores a size line that was lost after it had been replaced", async () => {
      const { opener, sizes, viewer } = rig();
      await viewer.view("dev@rig", recorder().handlers);
      await tick();
      const old = sizes.live[0]!;
      opener.attachments[0]!.end({ reason: "core_lost" });
      await expect.poll(() => opener.attachments.length).toBe(2);
      old.handlers.lost("late");
      await tick();
      expect(opener.attachments).toHaveLength(2);
    });
  });

  describe("repaint", () => {
    it("attaches again for a fresh paint, announced, and drops the old attach's bytes", async () => {
      const { opener, viewer } = rig();
      const { log, handlers } = recorder();
      const opened = await viewer.view("dev@rig", handlers);
      if (!opened.ok) throw new Error("not open");
      await tick();
      opener.attachments[0]!.push("live");
      opener.fallback = { early: [bytes("FRESH")] };
      expect(await opened.view.repaint()).toBe(true);
      opener.attachments[0]!.push("stale");
      expect(log.events).toEqual(["paint", "size 200x120", "data live", "paint", "data FRESH"]);
      expect(opener.attachments[0]!.detaches).toBe(1);
    });

    it("tracks the modes of the new paint, not the old one", async () => {
      const { opener, viewer } = rig();
      const opened = await viewer.view("dev@rig", recorder().handlers);
      if (!opened.ok) throw new Error("not open");
      opener.attachments[0]!.push("\x1b[?1049h\x1b[?1000h");
      expect(opened.view.modes()).toEqual({ altScreen: true, mouse: true });
      opener.fallback = { early: [bytes("\x1b[?1049h")] };  // no soft reset in it: the old attach's mouse mode must not carry over
      await opened.view.repaint();
      expect(opened.view.modes()).toEqual({ altScreen: true, mouse: false });
    });

    it("joins a repaint already under way instead of attaching twice", async () => {
      const { opener, viewer } = rig();
      const opened = await viewer.view("dev@rig", recorder().handlers);
      if (!opened.ok) throw new Error("not open");
      const [a, b] = await Promise.all([opened.view.repaint(), opened.view.repaint()]);
      expect([a, b]).toEqual([true, true]);
      expect(opener.attachments).toHaveLength(2);
    });

    it("says false when the view ended while repainting", async () => {
      const { opener, viewer } = rig({ delays: [] });
      const { log, handlers } = recorder();
      const opened = await viewer.view("dev@rig", handlers);
      if (!opened.ok) throw new Error("not open");
      opener.queue.push({ reject: new HcError("nf", "not_found", -32000) });
      expect(await opened.view.repaint()).toBe(false);
      expect(log.ends).toEqual([{ reason: "absent" }]);
      expect(await opened.view.repaint()).toBe(false);
    });
  });
});

// ---- the tmux adapter's viewer methods ---------------------------------------------------------------------------------

describe("the tmux adapter's viewer methods", () => {
  it("getPaneCursorPosition is where the first paint leaves the cursor, with the terminal's geometry", async () => {
    const { opener, viewer } = rig();
    opener.fallback = { terminal: { cols: 90, rows: 27 }, early: [bytes("\x1b[!p\x1b[H\x1b[2Jtext\x1b[12;20H\x1b]2;title\x07")] };
    expect(await viewer.getPaneCursorPosition("dev@rig")).toEqual({ x: 19, y: 11, width: 90, height: 27 });
    expect(opener.asked[0]).toMatchObject({ observe: true });
    expect(opener.attachments[0]!.detaches).toBe(1);
  });

  it("getPaneCursorPosition is null for a paint with no cursor, a terminal that is not there, an unreachable core, and nothing painted", async () => {
    const plain = rig();
    plain.opener.fallback = { early: [bytes("just text")] };
    expect(await plain.viewer.getPaneCursorPosition("dev@rig")).toBeNull();
    const gone = rig();
    gone.opener.fallback = { reject: new HcError("nf", "not_found", -32000) };
    expect(await gone.viewer.getPaneCursorPosition("dev@rig")).toBeNull();
    const down = rig();
    down.opener.fallback = { reject: new HcUnavailableError("down") };
    expect(await down.viewer.getPaneCursorPosition("dev@rig")).toBeNull();
    const silent = rig();
    expect(await silent.viewer.getPaneCursorPosition("dev@rig")).toBeNull();
    expect(await rig().viewer.getPaneCursorPosition("%3")).toBeNull();
  });

  it("startPipePane is refused by decision, naming the viewer, and holds nothing", async () => {
    const { opener, viewer } = rig();
    const result = await viewer.startPipePane("dev@rig", "/tmp/out.log");
    expect(result).toMatchObject({ ok: false, code: "unsupported" });
    expect(result.ok === false && result.message).toMatch(/terminal\.attach/);
    expect(opener.asked).toEqual([]);
  });

  it("stopPipePane succeeds: no pipe was ever started", async () => {
    const { opener, viewer } = rig();
    expect(await viewer.stopPipePane("dev@rig")).toEqual({ ok: true });
    expect(opener.asked).toEqual([]);
  });

  it("resizeWindow keeps the tmux adapter's argument checks and is otherwise refused by decision", async () => {
    const { opener, viewer } = rig();
    for (const [cols, rows] of [[0, 27], [-1, 27], [90.5, 27], [Number.NaN, 27], [90, 0], [90, 1.5], [90, Number.POSITIVE_INFINITY]] as const) {
      expect(await viewer.resizeWindow("dev@rig", cols, rows), `${cols}x${rows}`).toMatchObject({ ok: false, code: "validation_error" });
    }
    expect(await viewer.resizeWindow("dev@rig", 90, 27)).toMatchObject({ ok: false, code: "unsupported" });
    expect(opener.asked).toEqual([]);  // nothing attached as a writer to force a size
  });

  it("listClients throws, so that no client does not read as an empty list", async () => {
    await expect(rig().viewer.listClients()).rejects.toBeInstanceOf(HcViewerUnsupportedError);
    await expect(rig().viewer.listClients()).rejects.toThrow(/no list of attached clients/);
  });

  it("switchClient is refused by decision", async () => {
    expect(await rig().viewer.switchClient("/dev/ttys003", "=dev@rig:0")).toMatchObject({ ok: false, code: "unsupported" });
  });
});

describe("a person's typing", () => {
  it("goes through the injected input, by name", async () => {
    const calls: unknown[] = [];
    const viewer = new HcViewer({
      opener: new FakeOpener(), sizes: new FakeSizes(), client: {} as HcClient,
      input: {
        keys: async (name, keys) => { calls.push(["keys", name, keys]); return { ok: true }; },
        paste: async (name, text) => { calls.push(["paste", name, text]); return { ok: true }; },
        humanInput: async (_name, fn) => fn(),
      },
    });
    expect(await viewer.pressKeys("dev@rig", ["Up", "Enter"])).toEqual({ ok: true });
    expect(await viewer.pasteText("dev@rig", "hello")).toEqual({ ok: true });
    expect(calls).toEqual([["keys", "dev@rig", ["Up", "Enter"]], ["paste", "dev@rig", "hello"]]);
    expect(await viewer.humanInput!("dev@rig", async () => 7)).toBe(7);
  });

  it("refuses, saying so, when the viewer was built without a way to type", async () => {
    const { viewer } = rig();
    expect(await viewer.pressKeys("dev@rig", ["a"])).toMatchObject({ ok: false, code: "input_unavailable" });
    expect(await viewer.pasteText("dev@rig", "a")).toMatchObject({ ok: false, code: "input_unavailable" });
    expect(viewer.humanInput).toBeUndefined();
  });

  it("reads history through the injected capture, as plain text", async () => {
    const asked: unknown[] = [];
    const viewer = new HcViewer({ opener: new FakeOpener(), sizes: new FakeSizes(), client: {} as HcClient, capture: { capturePaneContent: async (t: string, n?: number) => { asked.push([t, n]); return "a\nb\n"; } } });
    expect(await viewer.readHistory("dev@rig", 57)).toBe("a\nb\n");
    expect(asked).toEqual([["dev@rig", 57]]);
  });
});
