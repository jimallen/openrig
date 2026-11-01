import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/index.js";
import type { StatusDeps } from "../src/commands/status.js";

vi.mock("../src/daemon-lifecycle.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js");
  return {
    ...actual,
    getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1, port: 7433 })),
    getDaemonUrl: vi.fn(() => "http://localhost:7433"),
  };
});

/** `rig seat cancel-message` ends a message nothing can deliver, and `rig seat read-message` prints one too long to paste. */
interface Call { method: string; path: string; body?: unknown }
let out: string[];
let calls: Call[];

async function run(argv: string[], reply: { status: number; data: unknown }): Promise<void> {
  const deps: StatusDeps = {
    lifecycleDeps: {} as StatusDeps["lifecycleDeps"],
    clientFactory: () => ({
      get: vi.fn(async (path: string) => { calls.push({ method: "GET", path }); return reply; }),
      post: vi.fn(async (path: string, body: unknown) => { calls.push({ method: "POST", path, body }); return reply; }),
    }) as unknown as ReturnType<StatusDeps["clientFactory"]>,
  };
  const program = createProgram({ queueDeps: deps, workflowDeps: deps, watchdogDeps: deps, seatDeps: deps });
  program.exitOverride();
  await program.parseAsync(["node", "rig", ...argv]);
}

beforeEach(() => {
  out = []; calls = [];
  vi.spyOn(console, "log").mockImplementation((...a) => { out.push(a.join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...a) => { out.push(a.join(" ")); });
  process.exitCode = undefined;
});
afterEach(() => { vi.restoreAllMocks(); process.exitCode = undefined; });

describe("rig seat cancel-message", () => {
  it("posts the seat and id in the path and the reason in the body", async () => {
    await run(["seat", "cancel-message", "dev@my-rig", "seat-msg-1", "--reason", "will never pass a gate"], { status: 200, data: { ok: true, id: "seat-msg-1" } });
    expect(calls).toEqual([{ method: "POST", path: "/api/transport/cancel-message/dev%40my-rig/seat-msg-1", body: { reason: "will never pass a gate" } }]);
    expect(process.exitCode).toBeUndefined();
  });

  it("shows a refusal with the daemon's words and a non-zero exit", async () => {
    await run(["seat", "cancel-message", "dev@my-rig", "seat-msg-1", "--reason", "x"], { status: 409, data: { error: "Message seat-msg-1 is not open; nothing was changed." } });
    expect(out.join("\n")).toContain("is not open");
    expect(process.exitCode).toBe(1);
  });

  it("requires a reason: nothing is posted without one", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as typeof process.exit);
    await expect(run(["seat", "cancel-message", "dev@my-rig", "seat-msg-1"], { status: 200, data: {} })).rejects.toThrow(/exit 1/);
    expect(calls).toEqual([]);
    exit.mockRestore();
    stderr.mockRestore();
  });
});

describe("rig seat read-message", () => {
  it("prints the body alone, so an agent reads the message and not JSON", async () => {
    await run(["seat", "read-message", "dev@my-rig", "m1"], { status: 200, data: { id: "m1", body: "the whole long message" } });
    expect(calls).toEqual([{ method: "GET", path: "/api/transport/read-message/dev%40my-rig/m1" }]);
    expect(out).toEqual(["the whole long message"]);
  });

  it("--json keeps the record", async () => {
    await run(["seat", "read-message", "dev@my-rig", "m1", "--json"], { status: 200, data: { id: "m1", body: "x" } });
    expect(JSON.parse(out[0]!)).toMatchObject({ id: "m1", body: "x" });
  });

  it("--operator asks as an operator, so the daemon knows the read settles nothing", async () => {
    await run(["seat", "read-message", "dev@my-rig", "m1", "--operator"], { status: 200, data: { id: "m1", body: "x" } });
    expect(calls).toEqual([{ method: "GET", path: "/api/transport/read-message/dev%40my-rig/m1?operator=1" }]);
  });

  it("a refusal is not printed as a body", async () => {
    await run(["seat", "read-message", "dev@my-rig", "m1"], { status: 404, data: { error: "No message m1 for dev@my-rig" } });
    expect(out.join("\n")).toContain("No message m1");
    expect(process.exitCode).toBe(1);
  });
});
