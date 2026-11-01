import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HcError, HcUnavailableError, HC_GENERATION, type HcTerminal } from "../src/adapters/hc-client.js";
import { FrameDecoder, HcAttach, MAX_DATA_FRAME, encodeFrame, type HcAttachEnd } from "../src/adapters/hc-attach.js";

/** The frame layout, restated here rather than imported from the module it pins: [channel u32 LE][kind u8][len u32 LE]. */
function frame(channel: number, kind: number, payload: Buffer | string = ""): Buffer {
  const body = typeof payload === "string" ? Buffer.from(payload) : payload;
  const header = Buffer.alloc(9);
  header.writeUInt32LE(channel, 0);
  header[4] = kind;
  header.writeUInt32LE(body.length, 5);
  return Buffer.concat([header, body]);
}

const TERMINAL: HcTerminal = { address: "t1", name: "n", labels: {}, argv: [], cwd: "/", state: "live", created_ms: 0, screen: "exact", cols: 100, rows: 30 };
const scratch: { dir: string; server: Server; sockets: Set<Socket> }[] = [];

/** Track a server's connections so cleanup can end them: close() waits for every one. */
function track(dir: string, server: Server): void {
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  scratch.push({ dir, server, sockets });
}

interface Wire { socket: Socket; frames: Array<{ channel: number; kind: number; payload: Buffer }> }
interface Core { path: string; wires: Wire[]; hellos: unknown[] }

/** A fake framed core on a private socket. `onFrames` decides what each batch of client frames gets back. */
async function fakeCore(options: {
  hello?: Record<string, unknown>;
  attach?: (wire: Wire, id: number, params: unknown) => void;
  onFrame?: (wire: Wire, f: { channel: number; kind: number; payload: Buffer }) => void;
}): Promise<Core> {
  const dir = mkdtempSync(join(tmpdir(), "hc-attach-"));
  const path = join(dir, "c.sock");
  const wires: Wire[] = [];
  const hellos: unknown[] = [];
  const server = createServer((socket) => {
    const wire: Wire = { socket, frames: [] };
    wires.push(wire);
    let line = Buffer.alloc(0);
    let framed = false;
    const decoder = new FrameDecoder();
    socket.on("error", () => {});
    socket.on("data", (chunk: Buffer) => {
      if (!framed) {
        line = Buffer.concat([line, chunk]);
        const end = line.indexOf(0x0a);
        if (end < 0) return;
        const hello = JSON.parse(line.subarray(0, end).toString()) as { id: number; method: string; params: unknown };
        hellos.push({ method: hello.method, params: hello.params });
        socket.write(JSON.stringify({ jsonrpc: "2.0", id: hello.id, result: { generation: HC_GENERATION, version: "0.1.16", core: { id: "c", name: "n" }, framed: true, methods: [], features: [], ...options.hello } }) + "\n");
        framed = true;
        chunk = line.subarray(end + 1);
        if (chunk.length === 0) return;
      }
      for (const f of decoder.push(chunk)) {
        if (f.channel === 0) {
          const request = JSON.parse(f.payload.toString()) as { id: number; method: string; params: unknown };
          if (request.method === "terminal.attach") options.attach?.(wire, request.id, request.params);
        } else {
          wire.frames.push(f);
          options.onFrame?.(wire, f);
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  track(dir, server);
  return { path, wires, hellos };
}

const attachedReply = (id: number, channel = 7) => frame(0, 0, JSON.stringify({ jsonrpc: "2.0", id, result: { channel, terminal: TERMINAL } }));

afterEach(async () => {
  for (const { dir, server, sockets } of scratch.splice(0)) {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("frames", () => {
  it("lays a frame out as channel u32 LE, kind u8, length u32 LE, payload", () => {
    expect(encodeFrame(0x01020304, 3, Buffer.from([9, 8])).toString("hex")).toBe("04030201" + "03" + "02000000" + "0908");
    expect(encodeFrame(1, 2).toString("hex")).toBe("01000000" + "02" + "00000000");
  });

  it("decodes frames however the bytes are split, and several in one chunk", () => {
    const bytes = Buffer.concat([frame(1, 0, "abc"), frame(2, 2, ""), frame(1, 0, "defgh")]);
    const whole = new FrameDecoder().push(bytes);
    expect(whole.map((f) => [f.channel, f.kind, f.payload.toString()])).toEqual([[1, 0, "abc"], [2, 2, ""], [1, 0, "defgh"]]);
    const decoder = new FrameDecoder();
    const piecemeal = [...bytes].flatMap((b) => decoder.push(Buffer.from([b])));
    expect(piecemeal.map((f) => [f.channel, f.kind, f.payload.toString()])).toEqual([[1, 0, "abc"], [2, 2, ""], [1, 0, "defgh"]]);
  });
});

describe("HcAttach", () => {
  it("keeps a first paint that arrives in the same chunk as the attach reply", async () => {
    const core = await fakeCore({ attach: (wire, id) => wire.socket.write(Buffer.concat([attachedReply(id), frame(7, 0, "PAINT")])) });
    const seen: string[] = [];
    const a = await new HcAttach(core.path).open({ terminal: "t1", cols: 100, rows: 30 }, { onData: (b) => seen.push(b.toString()), onEnd: () => {} });
    await expect.poll(() => seen).toEqual(["PAINT"]);
    expect(a.terminal.address).toBe("t1");
    await a.detach(50);
  });

  it("grants credit for every byte of every frame it receives", async () => {
    const core = await fakeCore({ attach: (wire, id) => wire.socket.write(Buffer.concat([attachedReply(id), frame(7, 0, "12345"), frame(7, 0, "ab")])) });
    await new HcAttach(core.path).open({ terminal: "t1", cols: 1, rows: 1 }, { onData: () => {}, onEnd: () => {} });
    await expect.poll(() => core.wires[0]!.frames.filter((f) => f.kind === 1).map((f) => [f.channel, f.payload.readUInt32LE(0)])).toEqual([[7, 5], [7, 2]]);
  });

  it("asks for framed mode at the generation this build speaks, before anything else", async () => {
    const core = await fakeCore({ attach: (wire, id) => wire.socket.write(attachedReply(id)) });
    const a = await new HcAttach(core.path).open({ terminal: "t1", cols: 1, rows: 1 }, { onData: () => {}, onEnd: () => {} });
    expect(core.hellos).toEqual([{ method: "hello", params: { generation: 1, framed: true } }]);
    await a.detach(50);
  });

  it("sends the attach parameters the core reads", async () => {
    let params: unknown;
    const core = await fakeCore({ attach: (wire, id, p) => { params = p; wire.socket.write(attachedReply(id)); } });
    const a = await new HcAttach(core.path).open({ terminal: "t1", cols: 120, rows: 40, observe: true, history: 5 }, { onData: () => {}, onEnd: () => {} });
    expect(params).toEqual({ terminal: "t1", cols: 120, rows: 40, observe: true, history: 5, resumed: false });
    await a.detach(50);
  });

  it("refuses a core on another generation, and an attach the core refuses", async () => {
    const other = await fakeCore({ hello: { generation: 99 } });
    await expect(new HcAttach(other.path).open({ terminal: "t1", cols: 1, rows: 1 }, { onData: () => {}, onEnd: () => {} }))
      .rejects.toMatchObject({ name: "HcError", kind: "unsupported_generation" });
    const refusing = await fakeCore({ attach: (wire, id) => wire.socket.write(frame(0, 0, JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "finished", data: { kind: "finished", hint: "read it" } } }))) });
    const error = await new HcAttach(refusing.path).open({ terminal: "t1", cols: 1, rows: 1 }, { onData: () => {}, onEnd: () => {} }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HcError);
    expect(error).toMatchObject({ kind: "finished", hint: "read it" });
  });

  it("reads an unreachable socket and a core that never answers hello as unavailable", async () => {
    await expect(new HcAttach("/nonexistent/hc.sock").open({ terminal: "t1", cols: 1, rows: 1 }, { onData: () => {}, onEnd: () => {} })).rejects.toBeInstanceOf(HcUnavailableError);
    const dir = mkdtempSync(join(tmpdir(), "hc-attach-"));
    const path = join(dir, "s.sock");
    const server = createServer(() => {});
    await new Promise<void>((resolve) => server.listen(path, resolve));
    track(dir, server);
    await expect(new HcAttach(path, 80).open({ terminal: "t1", cols: 1, rows: 1 }, { onData: () => {}, onEnd: () => {} })).rejects.toBeInstanceOf(HcUnavailableError);
  });

  describe("how a stream ends", () => {
    async function opened(onFrame?: (wire: Wire, f: { channel: number; kind: number; payload: Buffer }) => void) {
      const core = await fakeCore({ attach: (wire, id) => wire.socket.write(attachedReply(id)), onFrame });
      const ends: HcAttachEnd[] = [];
      const a = await new HcAttach(core.path).open({ terminal: "t1", cols: 100, rows: 30 }, { onData: () => {}, onEnd: (e) => ends.push(e) });
      return { core, a, ends };
    }

    it("reads a CLOSE with a payload as the program's end, carrying its exit code, signal and reason", async () => {
      const { core, ends } = await opened();
      core.wires[0]!.socket.write(frame(7, 2, JSON.stringify({ exit_code: 3, finished_ms: 99, reason: "exited", signal: null })));
      await expect.poll(() => ends).toEqual([{ reason: "program_ended", exitCode: 3, signal: null, endReason: "exited", finishedMs: 99 }]);
    });

    it("reads an EOF with no CLOSE as the core being lost", async () => {
      const { core, ends } = await opened();
      core.wires[0]!.socket.destroy();
      await expect.poll(() => ends).toEqual([{ reason: "core_lost" }]);
    });

    it("detaches on the core's empty CLOSE, and says so once", async () => {
      const { a, ends } = await opened((wire, f) => { if (f.kind === 2) wire.socket.write(frame(f.channel, 2)); });
      await expect(a.detach()).resolves.toEqual({ reason: "detached" });
      await expect(a.detach()).resolves.toEqual({ reason: "detached" });
      expect(ends).toEqual([{ reason: "detached" }]);
    });

    it("says no_answer, not detached, when the core does not answer the CLOSE", async () => {
      const { a } = await opened();
      await expect(a.detach(60)).resolves.toEqual({ reason: "no_answer" });
    });
  });

  describe("writing", () => {
    it("splits a long write into frames of at most 16 KiB, in order, on the attach channel", async () => {
      const { core, a } = await (async () => {
        const c = await fakeCore({ attach: (wire, id) => wire.socket.write(attachedReply(id)) });
        const att = await new HcAttach(c.path).open({ terminal: "t1", cols: 100, rows: 30 }, { onData: () => {}, onEnd: () => {} });
        return { core: c, a: att };
      })();
      a.write(Buffer.alloc(40_000, 0x61));
      await expect.poll(() => core.wires[0]!.frames.filter((f) => f.kind === 0).map((f) => f.payload.length)).toEqual([16_384, 16_384, 7_232]);
      expect(MAX_DATA_FRAME).toBe(16_384);
      expect(core.wires[0]!.frames.every((f) => f.channel === 7)).toBe(true);
    });

    it("sends a resize as u16 LE columns then rows", async () => {
      const c = await fakeCore({ attach: (wire, id) => wire.socket.write(attachedReply(id)) });
      const a = await new HcAttach(c.path).open({ terminal: "t1", cols: 100, rows: 30 }, { onData: () => {}, onEnd: () => {} });
      a.resize(0x0102, 0x0304);
      await expect.poll(() => c.wires[0]!.frames.filter((f) => f.kind === 3).map((f) => f.payload.toString("hex"))).toEqual(["02010403"]);
    });

    it("throws on an observer instead of dropping the bytes silently", async () => {
      const c = await fakeCore({ attach: (wire, id) => wire.socket.write(attachedReply(id)) });
      const a = await new HcAttach(c.path).open({ terminal: "t1", cols: 100, rows: 30, observe: true }, { onData: () => {}, onEnd: () => {} });
      expect(() => a.write("x")).toThrow(/observer/);
      expect(() => a.resize(1, 1)).toThrow(/observer/);
      expect(c.wires[0]!.frames.filter((f) => f.kind === 0 || f.kind === 3)).toEqual([]);
    });

    it("refuses to write after the stream ended", async () => {
      const c = await fakeCore({ attach: (wire, id) => wire.socket.write(attachedReply(id)) });
      const ends: HcAttachEnd[] = [];
      const a = await new HcAttach(c.path).open({ terminal: "t1", cols: 100, rows: 30 }, { onData: () => {}, onEnd: (e) => ends.push(e) });
      c.wires[0]!.socket.write(frame(7, 2, "{}"));
      await expect.poll(() => ends.length).toBe(1);
      expect(() => a.write("x")).toThrow(HcUnavailableError);
    });
  });
});
