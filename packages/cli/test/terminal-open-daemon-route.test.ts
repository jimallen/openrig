// hc cutover W40: `rig terminal open` as a person types it. The default and --window used to launch the OLD herdr multiplexer
// in a new desktop window (Ghostty/Terminal scripting, a private herdr config, the control socket); with the Herdr app that
// path is dead, so the plain command failed. Both now hand the view to the daemon (POST /api/terminal/open), whose provider
// opens viewers in the running app. Nothing here may launch a window, run herdr, or read the preview.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/index.js";
import type { TerminalDeps } from "../src/commands/terminal.js";

vi.mock("../src/daemon-lifecycle.js", async () => ({
  ...await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js"),
  getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1234, port: 7433 })),
  getDaemonUrl: vi.fn(() => "http://localhost:7433"),
}));

type Call = { method: string; path: string; body?: unknown };
function fixture(columns?: number | undefined, answer: { status: number; data: unknown } = { status: 200, data: { provider: "herdr", ok: true, opened: ["a@r"], absent: [], degraded: [], pages: 1 } }) {
  const calls: Call[] = [];
  const deps: TerminalDeps = {
    lifecycleDeps: {} as TerminalDeps["lifecycleDeps"],
    columns: async () => columns,
    clientFactory: () => ({
      baseUrl: "http://localhost:7433",
      get: vi.fn(async (path: string) => { calls.push({ method: "GET", path }); return { status: 200, data: {} }; }),
      post: vi.fn(async (path: string, body: unknown) => { calls.push({ method: "POST", path, body }); return answer; }),
    }) as unknown as ReturnType<TerminalDeps["clientFactory"]>,
  };
  const program = createProgram({ terminalDeps: deps });
  program.exitOverride();
  return { calls, run: (args: string[]) => program.parseAsync(["node", "rig", "terminal", "open", ...args]) };
}

describe("rig terminal open without --provider goes through the daemon", () => {
  let logs: string[];
  let exit: typeof process.exitCode;
  beforeEach(() => {
    logs = [];
    exit = process.exitCode;
    process.exitCode = undefined;
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));
  });
  afterEach(() => { process.exitCode = exit; vi.restoreAllMocks(); });

  it.each([[[]], [["--window"]]])("%j: one POST /api/terminal/open with the view and the measured width, nothing read first", async (flags) => {
    const f = fixture(140);
    await f.run([...flags, "--json", "--", "saved:kernel"]);
    expect(f.calls).toEqual([{ method: "POST", path: "/api/terminal/open", body: { view: "saved:kernel", viewportColumns: 140 } }]);
    expect(JSON.parse(logs[0]!)).toMatchObject({ ok: true, opened: ["a@r"] });
    expect(process.exitCode).toBeUndefined();
  });

  it("carries --expected-plan, and --provider when named, in the same POST", async () => {
    const f = fixture(120);
    await f.run(["--expected-plan", "plan-1", "--provider", "herdr", "--json", "--", "acme"]);
    expect(f.calls).toEqual([{ method: "POST", path: "/api/terminal/open", body: { view: "acme", provider: "herdr", expectedPlan: "plan-1", viewportColumns: 120 } }]);
  });

  it("sends no width when none could be measured (the daemon's narrow default), never an invented one", async () => {
    const f = fixture(undefined);
    await f.run(["--json", "--", "acme"]);
    expect(f.calls[0]!.body).toEqual({ view: "acme" });
  });

  it("a daemon refusal is the command's exit and its words, not a swallowed window failure", async () => {
    const refused = { provider: "herdr", ok: false, opened: [], absent: [], degraded: [], pages: 0, code: "herdr_unavailable", error: "the Herdr app is not running (herdr-app ls found no window); nothing was opened. Start the Herdr app, then run this again." };
    const f = fixture(100, { status: 200, data: refused });
    await f.run(["acme"]);
    expect(process.exitCode).toBe(1);
    expect(logs.join("\n")).toContain("Start the Herdr app");
    expect(logs.join("\n")).toContain("herdr_unavailable");
  });
});
