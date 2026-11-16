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

/** workspaces-o9o.9: `rig seat queued` lists what `rig send` calls "queued": the seat's open rows, which `rig seat held-messages` does not show. */
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
  const program = createProgram({ queueDeps: deps, workflowDeps: deps, watchdogDeps: deps, seatDeps: deps, sendDeps: deps });
  program.exitOverride();
  await program.parseAsync(["node", "rig", ...argv]);
}

const LISTING = {
  seat: "dev@my-rig", knownSeat: true, total: 2, redaction: "transcript",
  items: [
    { id: "seat-msg-1", sender: "lead@my-rig", recordedAt: "2031-03-04T09:00:00.000Z", state: "attempting", attempts: 3, lane: 2, pauseReason: "busy", lastRefusal: null, nextAttemptAt: null, previousOccupant: null, preview: "please review the branch", bodyBytes: 24 },
    { id: "seat-msg-2", sender: "qa@my-rig", recordedAt: "2031-03-04T09:05:00.000Z", state: "accepted", attempts: 0, lane: 2, pauseReason: null, lastRefusal: null, nextAttemptAt: null, previousOccupant: null, preview: "token [REDACTED] inside", bodyBytes: 40 },
  ],
};

beforeEach(() => {
  out = []; calls = [];
  vi.spyOn(console, "log").mockImplementation((...a) => { out.push(a.join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...a) => { out.push(a.join(" ")); });
  process.exitCode = undefined;
});
afterEach(() => { vi.restoreAllMocks(); process.exitCode = undefined; });

describe("rig seat queued", () => {
  it("reads the seat's queued rows with one GET and shows each one: id, sender, time, state, attempts and a preview", async () => {
    await run(["seat", "queued", "dev@my-rig"], { status: 200, data: LISTING });
    expect(calls).toEqual([{ method: "GET", path: "/api/seat/queued/dev%40my-rig?limit=100" }]);
    const text = out.join("\n");
    for (const word of ["seat-msg-1", "lead@my-rig", "2031-03-04T09:00:00.000Z", "attempting", "please review the branch", "seat-msg-2", "qa@my-rig", "accepted", "token [REDACTED] inside"]) {
      expect(text).toContain(word);
    }
    expect(process.exitCode).toBeUndefined();
  });

  it("--json prints the daemon's answer as JSON", async () => {
    await run(["seat", "queued", "dev@my-rig", "--json"], { status: 200, data: LISTING });
    expect(JSON.parse(out.join("\n"))).toEqual(LISTING);
  });
});

describe("rig seat queued: what an empty or partial list says", () => {
  it("an unknown name says so plainly, so an empty list cannot read as 'nothing queued'", async () => {
    await run(["seat", "queued", "dve@my-rig"], { status: 200, data: { seat: "dve@my-rig", knownSeat: false, total: 0, redaction: "transcript", items: [] } });
    const text = out.join("\n");
    expect(text).toContain("dve@my-rig: seat unknown on this host");
    expect(text).not.toContain("nothing queued");
  });

  it("a known seat with nothing open says 'nothing queued'", async () => {
    await run(["seat", "queued", "dev@my-rig"], { status: 200, data: { seat: "dev@my-rig", knownSeat: true, total: 0, redaction: "transcript", items: [] } });
    expect(out.join("\n")).toBe("dev@my-rig: nothing queued.");
  });

  it("a far seat's rows are listed and flagged unknown on this host", async () => {
    await run(["seat", "queued", "dev@my-rig"], { status: 200, data: { ...LISTING, knownSeat: false } });
    expect(out[0]).toBe("dev@my-rig (seat unknown on this host): 2 queued, in delivery order (the first goes next)");
  });

  it("says how many it left out when --limit cut the list", async () => {
    await run(["seat", "queued", "dev@my-rig", "--limit", "2"], { status: 200, data: { ...LISTING, total: 5 } });
    expect(calls[0]!.path).toBe("/api/seat/queued/dev%40my-rig?limit=2");
    expect(out.join("\n")).toContain("Showing 2 of 5; pass --limit to see more.");
  });

  it("labels a relaunch's re-delivery and a row first sent to a previous occupant", async () => {
    const items = [
      { ...LISTING.items[0]!, id: "cos-6045.relaunch-abcd1234", redeliveryOf: "cos-6045" },
      { ...LISTING.items[1]!, previousOccupant: "gen-old", redeliveryOf: null },
    ];
    await run(["seat", "queued", "dev@my-rig"], { status: 200, data: { ...LISTING, items } });
    const text = out.join("\n");
    expect(text).toContain("[re-delivery of cos-6045]");
    expect(text).toContain("[first sent to a previous occupant]");
  });

  it("a daemon refusal prints its words and exits non-zero", async () => {
    await run(["seat", "queued", "dev@my-rig"], { status: 503, data: { error: "Outbox unavailable" } });
    expect(out.join("\n")).toContain("Outbox unavailable");
    expect(process.exitCode).toBe(2);
  });
});

describe("rig send to several seats", () => {
  it("points a row the pump carries at rig seat queued, and a row the typing guard holds at held-messages", async () => {
    const reply = { status: 200, data: { total: 2, sent: 0, retained: 2, failed: 0, results: [
      { ok: true, sessionName: "busy@my-rig", sent: false, outcome: "retained", reason: "handed_to_pump" },
      { ok: true, sessionName: "guarded@my-rig", sent: false, outcome: "retained", reason: "typing_guard_enabled" },
    ] } };
    await run(["send", "--to", "busy@my-rig,guarded@my-rig", "hello"], reply);
    const text = out.join("\n");
    expect(text).toContain("busy@my-rig: accepted, not yet received; list what waits for it with rig seat queued busy@my-rig");
    expect(text).toContain("guarded@my-rig: retained, not delivered; inspect with rig seat held-messages");
    expect(text).not.toContain("busy@my-rig: retained");
  });
});
