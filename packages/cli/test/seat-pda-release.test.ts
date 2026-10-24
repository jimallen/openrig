// pda L2a round 2: rig seat pda-release, the command the pda-runner's held-message line and the transport's refusal name.
// It posts the seat's session name and the operator's reason to the daemon's guarded route; it never writes a file itself.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { seatCommand, type SeatDeps } from "../src/commands/seat.js";

vi.mock("../src/daemon-lifecycle.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js");
  return {
    ...actual,
    getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1, port: 7433 })),
    getDaemonUrl: vi.fn(() => "http://localhost:7433"),
  };
});

interface PostCall { path: string; body: unknown; options: unknown }

function deps(response: { status: number; data: Record<string, unknown> }, postCalls: PostCall[]): SeatDeps {
  return {
    lifecycleDeps: {} as SeatDeps["lifecycleDeps"],
    clientFactory: () => ({
      post: vi.fn(async (path: string, body: unknown, options: unknown) => { postCalls.push({ path, body, options }); return response; }),
    }) as unknown as ReturnType<SeatDeps["clientFactory"]>,
  };
}

describe("rig seat pda-release", () => {
  let logs: string[];
  let errors: string[];
  beforeEach(() => {
    logs = []; errors = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a) => errors.push(a.join(" ")));
    process.exitCode = undefined;
  });

  it("posts the session and the reason to the guarded route with the terminal auth headers, and prints the daemon's message", async () => {
    const postCalls: PostCall[] = [];
    await seatCommand(deps({ status: 200, data: { ok: true, message: "Release requested for dev-research@rig." } }, postCalls))
      .parseAsync(["node", "rig", "pda-release", "dev-research@rig", "--reason", "pda restarted; retry the held message"]);
    expect(postCalls).toHaveLength(1);
    expect(postCalls[0]!.path).toBe("/api/sessions/dev-research%40rig/pda-release");
    expect(postCalls[0]!.body).toEqual({ reason: "pda restarted; retry the held message" });
    expect(postCalls[0]!.options).toHaveProperty("headers");
    expect(logs.join("\n")).toContain("Release requested for dev-research@rig.");
    expect(process.exitCode).toBeUndefined();
  });

  it("a refusal (409: nothing held, not a pda seat, a release already pending) is printed and exits 1", async () => {
    const postCalls: PostCall[] = [];
    await seatCommand(deps({ status: 409, data: { ok: false, code: "no_held_message", error: "No message is held for dev-research@rig." } }, postCalls))
      .parseAsync(["node", "rig", "pda-release", "dev-research@rig", "--reason", "x"]);
    expect(errors.join("\n")).toContain("No message is held");
    expect(process.exitCode).toBe(1);
  });

  it("--reason is required: nothing is posted without it", async () => {
    const postCalls: PostCall[] = [];
    const cmd = seatCommand(deps({ status: 200, data: {} }, postCalls));
    cmd.exitOverride();
    for (const sub of cmd.commands) sub.exitOverride();
    await expect(cmd.parseAsync(["node", "rig", "pda-release", "dev-research@rig"])).rejects.toThrow(/reason/);
    expect(postCalls).toEqual([]);
  });
});
