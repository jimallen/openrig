// "Is the seat host healthy" is hc: installed, the pinned version, and a core on this build's protocol generation.
// The production consequence of each row: a wrong answer here either lets OpenRig launch seats on a host it cannot
// speak to, or reads a machine with no core yet as broken.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HC_GENERATION, HC_PINNED_VERSION, buildHcHostFailure, classifyHcCore, parseHcVersion, probeHcHostAsync, probeHcInstall,
  readHcHello, resolveHcSocketPath, type HcHelloOutcome,
} from "../src/tmux-health.js";

// The pin is restated, not imported: a change to it must fail here and be a deliberate, reviewed edit.
describe("the pins", () => {
  it("are hc 0.1.15 and protocol generation 1", () => {
    expect(HC_PINNED_VERSION).toBe("0.1.15");
    expect(HC_GENERATION).toBe(1);
  });
});

describe("parseHcVersion", () => {
  it.each([["hc 0.1.15\n", "0.1.15"], ["hc 12.30.4", "12.30.4"], ["usage: hc", null], ["", null]])("%j -> %j", (output, expected) => {
    expect(parseHcVersion(output)).toBe(expected);
  });
});

describe("probeHcInstall (hc --version alone)", () => {
  const seen: string[] = [];
  const run = (answer: () => string) => probeHcInstall((cmd) => { seen.push(cmd); return answer(); });
  beforeEach(() => { seen.length = 0; });

  it("is pinned only for exactly the pinned version", () => {
    expect(run(() => "hc 0.1.15\n")).toEqual({ installed: true, available: true, version: "0.1.15", detail: null, code: "pinned" });
    for (const other of ["0.1.14", "0.1.16", "0.2.0", "1.1.15"]) {
      expect(run(() => `hc ${other}\n`), other).toMatchObject({ installed: true, available: false, version: other, code: "version_mismatch" });
    }
  });

  it("is not_installed when the command fails, and unhealthy when its output has no version", () => {
    expect(run(() => { throw new Error("hc: command not found"); })).toMatchObject({ installed: false, available: false, code: "not_installed", detail: "hc: command not found" });
    expect(run(() => "usage: hc")).toMatchObject({ installed: true, available: false, code: "unhealthy" });
  });

  it("runs only `hc --version`: no command that starts a core", () => {
    run(() => "hc 0.1.15");
    run(() => { throw new Error("x"); });
    expect(seen).toEqual(["hc --version", "hc --version"]);
  });
});

describe("classifyHcCore", () => {
  const cases: Array<[string, HcHelloOutcome, { code: string; available: boolean }]> = [
    ["pinned version, this generation", { kind: "hello", generation: 1, version: "0.1.15" }, { code: "available", available: true }],
    ["another generation", { kind: "hello", generation: 2, version: "0.1.15" }, { code: "unsupported_generation", available: false }],
    ["generation 0", { kind: "hello", generation: 0, version: "0.1.15" }, { code: "unsupported_generation", available: false }],
    ["another version on this generation", { kind: "hello", generation: 1, version: "0.1.14" }, { code: "version_mismatch", available: false }],
    ["a refusal of our generation", { kind: "refused", refusal: "unsupported_generation", detail: "this core speaks generation 2" }, { code: "unsupported_generation", available: false }],
    ["a refusal of another kind", { kind: "refused", refusal: "invalid_params", detail: "bad" }, { code: "unhealthy", available: false }],
    ["an unreadable reply", { kind: "unreadable", detail: "not JSON" }, { code: "unhealthy", available: false }],
    ["no core", { kind: "no_core", detail: "no hc core at /x (ENOENT)" }, { code: "no_core", available: true }],
  ];
  it.each(cases)("%s", (_label, outcome, expected) => {
    expect(classifyHcCore(outcome)).toMatchObject(expected);
  });

  it("generation is judged before version, so a core of both kinds reads as the generation refusal", () => {
    expect(classifyHcCore({ kind: "hello", generation: 2, version: "9.9.9" }).code).toBe("unsupported_generation");
  });
});

describe("probeHcHostAsync", () => {
  const hc = (version: string) => async () => `hc ${version}\n`;
  const hello = (outcome: HcHelloOutcome) => async () => outcome;
  const good: HcHelloOutcome = { kind: "hello", generation: 1, version: "0.1.15" };

  it("is available only when installed, pinned and the core agrees", async () => {
    expect(await probeHcHostAsync(hc("0.1.15"), hello(good))).toMatchObject({ code: "available", available: true, version: "0.1.15" });
  });

  it("does not ask the core when hc is missing or not the pin", async () => {
    let asked = 0;
    const counting = async (): Promise<HcHelloOutcome> => { asked++; return good; };
    expect((await probeHcHostAsync(async () => { throw new Error("nope"); }, counting)).code).toBe("not_installed");
    expect((await probeHcHostAsync(hc("0.1.14"), counting)).code).toBe("version_mismatch");
    expect(asked).toBe(0);
  });

  it("keeps the CLI's version when the core reports none (no core)", async () => {
    expect(await probeHcHostAsync(hc("0.1.15"), hello({ kind: "no_core", detail: "d" }))).toMatchObject({ code: "no_core", available: true, version: "0.1.15" });
  });

  it("reports the core's version when the core is the one that differs", async () => {
    expect(await probeHcHostAsync(hc("0.1.15"), hello({ kind: "hello", generation: 1, version: "0.1.14" }))).toMatchObject({ code: "version_mismatch", version: "0.1.14" });
  });
});

describe("buildHcHostFailure", () => {
  it("names the pin and the cause, and never tells the person to run a command that starts a core", () => {
    for (const code of ["version_mismatch", "unsupported_generation", "unhealthy"] as const) {
      const f = buildHcHostFailure(code, "DETAIL");
      expect(f.reason + f.fix, code).toContain(code === "unhealthy" ? "DETAIL" : HC_PINNED_VERSION);
      expect(f.reason, code).toContain("DETAIL");
      expect(`${f.message}${f.reason}${f.fix}`, code).not.toMatch(/tmux/i);
    }
  });
});

describe("resolveHcSocketPath", () => {
  it("follows hc: HC_SOCKET, then the runtime dir, then the state dir; HC_SESSION names the core", () => {
    expect(resolveHcSocketPath({ HC_SOCKET: "/s/x.sock", XDG_RUNTIME_DIR: "/r" }, "/h")).toBe("/s/x.sock");
    expect(resolveHcSocketPath({ XDG_RUNTIME_DIR: "/r" }, "/h")).toBe("/r/herdr-core/default.sock");
    expect(resolveHcSocketPath({ XDG_RUNTIME_DIR: "/r", HC_SESSION: "qa" }, "/h")).toBe("/r/herdr-core/qa.sock");
    expect(resolveHcSocketPath({ XDG_STATE_HOME: "/st", HC_SESSION: "qa" }, "/h")).toBe("/st/herdr-core/qa/qa.sock");
    expect(resolveHcSocketPath({}, "/h")).toBe("/h/.local/state/herdr-core/default/default.sock");
  });
});

describe("readHcHello over a socket", () => {
  let dir: string;
  let server: Server | null;
  let sockets: Socket[];
  let sockPath: string;
  const received: string[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hch-hello-"));
    sockPath = join(dir, "c.sock");
    server = null;
    sockets = [];
    received.length = 0;
  });
  afterEach(async () => {
    for (const s of sockets) s.destroy();
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    rmSync(dir, { recursive: true, force: true });
  });

  async function core(onLine: (line: string, socket: Socket) => void): Promise<void> {
    server = createServer((socket) => {
      sockets.push(socket);
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          received.push(line);
          onLine(line, socket);
        }
      });
    });
    await new Promise<void>((done) => server!.listen(sockPath, done));
  }

  it("sends hello pinned to our generation, and reads the generation and version", async () => {
    await core((line, socket) => {
      const request = JSON.parse(line) as { id: number };
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { generation: 1, version: "0.1.15", core: { id: "c", name: "n" } } })}\n`);
    });
    expect(await readHcHello(sockPath)).toEqual({ kind: "hello", generation: 1, version: "0.1.15" });
    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0]!)).toMatchObject({ jsonrpc: "2.0", method: "hello", params: { generation: HC_GENERATION, framed: false } });
  });

  it("reads a refusal by its kind", async () => {
    await core((line, socket) => {
      const request = JSON.parse(line) as { id: number };
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "this core speaks generation 2", data: { kind: "unsupported_generation" } } })}\n`);
    });
    expect(await readHcHello(sockPath)).toEqual({ kind: "refused", refusal: "unsupported_generation", detail: "this core speaks generation 2" });
  });

  it("reads a reply split across writes", async () => {
    await core((line, socket) => {
      const text = `${JSON.stringify({ jsonrpc: "2.0", id: (JSON.parse(line) as { id: number }).id, result: { generation: 1, version: "0.1.15" } })}\n`;
      socket.write(text.slice(0, 10));
      setTimeout(() => socket.write(text.slice(10)), 20);
    });
    expect(await readHcHello(sockPath)).toMatchObject({ kind: "hello", generation: 1 });
  });

  it("is unreadable, not healthy, when the reply is garbled, incomplete, or the core hangs up or stays silent", async () => {
    for (const [label, behave, wait] of [
      ["not JSON", (_l: string, s: Socket) => { s.write("{{{\n"); }, 3000],
      ["no generation", (_l: string, s: Socket) => { s.write(`${JSON.stringify({ id: 1, result: { version: "0.1.15" } })}\n`); }, 3000],
      ["hangs up", (_l: string, s: Socket) => { s.end(); }, 3000],
      ["silent", () => {}, 150],
    ] as const) {
      if (server) { for (const s of sockets) s.destroy(); await new Promise<void>((done) => server!.close(() => done())); }
      rmSync(sockPath, { force: true });
      await core(behave);
      const started = Date.now();
      const outcome = await readHcHello(sockPath, wait);
      expect(outcome.kind, label).toBe("unreadable");
      // Only the silent core is answered by the timer; the others are answered when the reply or the hang-up arrives.
      if (label !== "silent") expect(Date.now() - started, label).toBeLessThan(1500);
    }
  });

  it("is no_core when nothing listens: a socket never made and one whose listener has gone", async () => {
    expect(await readHcHello(join(dir, "none.sock"))).toMatchObject({ kind: "no_core" });
    await core(() => {});
    for (const s of sockets) s.destroy();
    await new Promise<void>((done) => server!.close(() => done()));
    server = null;
    // The listener is gone, so there is nothing to connect to.
    expect(await readHcHello(sockPath)).toMatchObject({ kind: "no_core" });
  });

  it("is no_core for a stale socket file whose listener was killed (refused), and for a path through a file (not a directory)", async () => {
    // A listener killed without cleaning up leaves its socket file: connecting is refused rather than not found.
    const child = spawn(process.execPath, ["-e", `require("node:net").createServer().listen(${JSON.stringify(sockPath)}, () => console.log("up"))`], { stdio: ["ignore", "pipe", "ignore"] });
    try {
      await new Promise<void>((done) => child.stdout!.once("data", () => done()));
      child.kill("SIGKILL");
      await new Promise<void>((done) => child.once("exit", () => done()));
      expect(await readHcHello(sockPath)).toMatchObject({ kind: "no_core", detail: expect.stringContaining("ECONNREFUSED") });
    } finally {
      child.kill("SIGKILL");
    }
    writeFileSync(join(dir, "afile"), "");
    expect(await readHcHello(join(dir, "afile", "c.sock"))).toMatchObject({ kind: "no_core", detail: expect.stringContaining("ENOTDIR") });
  });
});
