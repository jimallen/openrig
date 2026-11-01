import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { terminalCommand, type TerminalDeps } from "../src/commands/terminal.js";
import type { WindowDeps } from "../src/terminal-window.js";

vi.mock("../src/daemon-lifecycle.js", async () => ({
  ...await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js"),
  getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1234, port: 7433 })),
  getDaemonUrl: vi.fn(() => "http://localhost:7433"),
}));

// Reopening a view. A seat is itself the pane Herdr shows (placed by label, design-hc-cutover section 5), so there is no
// tmux client to prove an earlier tab attached: the CLI keeps no inventory of the app, asks the daemon to place the seats
// each time, and never closes anything. Closing a tab or space KILLS the terminals in it (design section 5).
const planId = "0123456789abcdef".repeat(4);

function fixture(seats = ["exec-cos@eztrack", "dev-impl@eztrack", "dev-qa@eztrack"], id = "kernel") {
  const panes = seats.map(seat => ({ seat, label: seat, paneCommand: `hc attach ${seat}` }));
  const composed = { id, opened: panes, pages: [panes], absent: [] as Array<{ seat: string; host: string | null; reason: string }>, degraded: [] as Array<{ seat: string; host: string; reason: string }> };
  const get = vi.fn(async (url: string) => ({ status: 200, data: url.includes("preview") ? {
    planId, composed,
    status: { launch: { socketPath: "/daemon home/herdr.sock" } },
  } : { providers: [{ liveness: { alive: true } }] } }));
  const post = vi.fn(async () => ({ status: 200, data: { provider: "herdr", ok: true, opened: panes.map(p => p.seat), absent: [], degraded: [], pages: 1 } }));
  const workspaces = vi.fn(async () => JSON.stringify({ result: { workspaces: [{ workspace_id: "ws-0", label: "rig:eztrack", focused: true }] } }));
  const exec = vi.fn(async (file: string, args: string[]) => {
    if (file === "/usr/bin/osascript") return "window-sized";
    if (args.includes("--version")) return "herdr 0.9.3";
    if (file === "/bin/sh") return "/fixture/bin/herdr";
    if (file === "/usr/bin/env" && args.at(-2) === "workspace" && args.at(-1) === "list") return workspaces();
    throw new Error(`Unexpected command: ${file} ${args.join(" ")}`);
  });
  const windowDeps: WindowDeps = {
    platform: "darwin", env: { TERM_PROGRAM: "Apple_Terminal", HERDR_SESSION: "wrong", HERDR_SOCKET_PATH: "/wrong.sock" },
    exists: () => false, exec, launch: vi.fn(async () => {}), sleep: vi.fn(async () => {}), herdrConfig: vi.fn(() => "/fixture/private herdr.toml"), id: () => "fixture",
  };
  const deps: TerminalDeps = {
    lifecycleDeps: {} as TerminalDeps["lifecycleDeps"], windowDeps,
    clientFactory: () => ({ baseUrl: "http://localhost:7433", get, post }) as unknown as ReturnType<TerminalDeps["clientFactory"]>,
  };
  return { composed, workspaces, exec, post, get, windowDeps, run: (args: string[] = ["--json"]) => new Command().addCommand(terminalCommand(deps)).parseAsync(["terminal", "open", `saved:${id}`, ...args], { from: "user" }) };
}

describe("reopening a Herdr view in a desktop window", () => {
  let logs: string[];
  let originalExit: typeof process.exitCode;
  beforeEach(() => {
    logs = [];
    originalExit = process.exitCode;
    process.exitCode = undefined;
    vi.spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));
  });
  afterEach(() => { process.exitCode = originalExit; vi.restoreAllMocks(); });

  it("asks the daemon to place the previewed plan once per open, and reads no tab inventory", async () => {
    const f = fixture();
    await f.run();
    await f.run(["--window", "--json"]);
    expect(f.post).toHaveBeenCalledTimes(2);
    expect(f.post).toHaveBeenNthCalledWith(1, "/api/terminal/open", { view: "saved:kernel", provider: "herdr", expectedPlan: planId }, { timeoutMs: 45_000 });
    expect(f.exec.mock.calls.filter(([file]) => file === "/usr/bin/osascript")).toHaveLength(2);
    // The only /usr/bin/env command the old reuse path ran were Herdr inventory reads and a tab focus; none remain.
    expect(f.exec.mock.calls.filter(([file]) => file === "/usr/bin/env")).toEqual([]);
    expect(JSON.parse(logs[1]!)).toMatchObject({ ok: true, opened: ["exec-cos@eztrack", "dev-impl@eztrack", "dev-qa@eztrack"] });
    expect(JSON.parse(logs[1]!).reusedWorkspace).toBeUndefined();
    expect(process.exitCode).toBeUndefined();
  });

  it("never closes or parks anything in the app, whatever it already shows", async () => {
    const f = fixture();
    f.windowDeps.env = { TERM_PROGRAM: "herdr", HERDR_SOCKET_PATH: "/daemon home/herdr.sock" };
    await f.run();
    await f.run();
    const words = f.exec.mock.calls.map(([file, args]) => `${file} ${args.join(" ")}`).join("\n");
    expect(words).not.toMatch(/\b(close|kill|park|send-text)\b/);
    expect(logs.join("\n")).not.toMatch(/herdr (workspace|tab) close/);
  });

  it("says the panes are viewers, so closing one leaves the seat running", async () => {
    const f = fixture();
    await f.run();
    const notes = (JSON.parse(logs[0]!) as { notes: string[] }).notes;
    expect(notes).toContain("These panes are viewers of the seats: closing one leaves the seat running.");
  });

  it("creates once inside the person's own Herdr, with no window or config change, and says whether the space is showing", async () => {
    const f = fixture();
    f.windowDeps.env = { TERM_PROGRAM: "herdr", HERDR_SOCKET_PATH: "/daemon home/herdr.sock" };
    await f.run();
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(f.exec.mock.calls.some(([file]) => file === "/usr/bin/osascript")).toBe(false);
    expect(f.windowDeps.herdrConfig).not.toHaveBeenCalled();
    expect(f.windowDeps.launch).not.toHaveBeenCalled();
    expect(JSON.parse(logs[0]!).window).toBeUndefined();
    expect(JSON.parse(logs[0]!).notes).toContain("Herdr did not confirm the view's space is focused; ask the person whether they see it.");
  });

  it("keeps a refused open from claiming a space and from retrying", async () => {
    const f = fixture();
    f.post.mockResolvedValueOnce({ status: 409, data: { error: "view changed" } } as never);
    await f.run();
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logs[0]!)).toMatchObject({ ok: false, error: expect.stringContaining("view changed") });
  });

  it("retains the preview's absent and degraded members in the open result", async () => {
    const f = fixture();
    f.composed.absent.push({ seat: "dev-x@eztrack", host: null, reason: "not running" });
    f.post.mockResolvedValueOnce({ status: 409, data: { error: "refused" } } as never);
    await f.run();
    expect(JSON.parse(logs[0]!)).toMatchObject({ absent: f.composed.absent });
  });
});
