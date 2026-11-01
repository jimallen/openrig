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

/**
 * hc cutover: `rig seat retire-unsettled-send <seat> <id> --reason <text>` is the operator's close of a send to an hc seat that was
 * never confirmed delivered or lost. It names the verb `rig health` prints, posts to the daemon's transport route with the seat and id
 * in the path and the reason in the body, and shows a refusal as a refusal (exit 1) with the daemon's own words.
 */
interface Posted { path: string; body: unknown }
let out: string[];
let posted: Posted[];

async function run(argv: string[], reply: { status: number; data: unknown }): Promise<void> {
  const deps: StatusDeps = {
    lifecycleDeps: {} as StatusDeps["lifecycleDeps"],
    clientFactory: () => ({
      get: vi.fn(),
      post: vi.fn(async (path: string, body: unknown) => { posted.push({ path, body }); return reply; }),
    }) as unknown as ReturnType<StatusDeps["clientFactory"]>,
  };
  const program = createProgram({ queueDeps: deps, workflowDeps: deps, watchdogDeps: deps, seatDeps: deps });
  program.exitOverride();
  await program.parseAsync(["node", "rig", ...argv]);
}

beforeEach(() => {
  out = []; posted = [];
  vi.spyOn(console, "log").mockImplementation((...a) => { out.push(a.join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...a) => { out.push(a.join(" ")); });
  process.exitCode = undefined;
});
afterEach(() => { vi.restoreAllMocks(); process.exitCode = undefined; });

describe("rig seat retire-unsettled-send", () => {
  it("posts the seat and id in the path and the reason in the body, and prints the daemon's answer", async () => {
    await run(["seat", "retire-unsettled-send", "dev@my-rig", "outbox-9", "--reason", "looked: the text is there"], { status: 200, data: { entry: { outboxId: "outbox-9", deliveryState: "retired" }, effect: "Closed" } });
    expect(posted).toEqual([{ path: "/api/transport/retire-unsettled/dev%40my-rig/outbox-9", body: { reason: "looked: the text is there" } }]);
    expect(out.join("\n")).toContain('"deliveryState": "retired"');
    expect(process.exitCode).toBeUndefined();
  });

  it("shows a refusal with the daemon's words and a non-zero exit", async () => {
    await run(["seat", "retire-unsettled-send", "dev@my-rig", "outbox-9", "--reason", "x"], { status: 409, data: { error: "outbox outbox-9 is delivered (verified_after_wait), not an unsettled send to an hc seat; nothing was changed.", code: "not_unsettled" } });
    expect(out.join("\n")).toContain("not an unsettled send to an hc seat");
    expect(process.exitCode).toBe(1);
  });

  it("requires a reason: nothing is posted without one", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as typeof process.exit);
    await expect(run(["seat", "retire-unsettled-send", "dev@my-rig", "outbox-9"], { status: 200, data: {} })).rejects.toThrow(/exit 1/);
    expect(stderr.mock.calls.map((c) => String(c[0])).join("")).toMatch(/--reason/);
    expect(posted).toEqual([]);
    exit.mockRestore();
    stderr.mockRestore();
  });
});
