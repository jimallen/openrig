// Real daemon routes, kernel composition/plan hashing, both clients and the window opener.
// HTTP stays in-process; provider availability, the Herdr probe and desktop launching are simulated.
import { afterEach, expect, it } from "vitest";
import { Hono } from "hono";
import { DaemonClient as CliClient } from "../src/client.js";
import { openTerminalWindow, type WindowDeps } from "../src/terminal-window.js";
import { DaemonClient as TuiClient } from "../../tui/src/daemon-client.js";
import { terminalRoutes } from "../../daemon/src/routes/terminal.js";
import { TerminalService } from "../../daemon/src/domain/terminal/terminal-service.js";
import type { TerminalProvider } from "../../daemon/src/domain/terminal/terminal-provider.js";

const stdoutDescriptors = Object.getOwnPropertyDescriptors(process.stdout);
function terminalWidth(columns?: number): void {
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  Object.defineProperty(process.stdout, "columns", { configurable: true, value: columns });
}
afterEach(() => {
  for (const key of ["isTTY", "columns"]) {
    const descriptor = stdoutDescriptors[key];
    if (descriptor) Object.defineProperty(process.stdout, key, descriptor);
    else delete (process.stdout as unknown as Record<string, unknown>)[key];
  }
});

function fixture() {
  const seats = ["operator", "dashboard", "advisor"];
  const alive = new Set(seats);
  const kernelSeats = ["operator.agent", "operator.human", "advisor.lead"].map((logicalId, i) => ({
    logicalId, canonicalSessionName: seats[i]!, tmuxSession: seats[i]!, attachmentType: "tmux", rigName: "kernel", runtime: "stub",
  }));
  const providerOpens: string[][][] = [];
  const provider: TerminalProvider = {
    name: "herdr", status: async () => ({ provider: "herdr", available: true, capabilities: { layout: true }, launch: { socketPath: "/fixture/herdr.sock" } }),
    liveness: async () => ({ alive: true }),
    openView: async view => {
      providerOpens.push(view.pages.map(page => page.map(pane => pane.seat)));
      return { provider: "herdr", ok: true, opened: view.opened.map(pane => pane.seat), absent: view.absent, degraded: view.degraded, pages: view.pages.length };
    },
  };
  const service = new TerminalService({
    resolveProvider: () => provider, viewsStore: { get: () => null, list: () => [] },
    listRigSeats: name => name === "kernel" ? kernelSeats : null,
    listPodSeats: () => null, listScopeSeats: () => null, listRigNames: () => ["kernel"],
    resolveHost: () => null, hasSession: name => alive.has(name), resolveLocalTmux: () => "/fixture/tmux",
  } as ConstructorParameters<typeof TerminalService>[0]);
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("terminalService" as never, service); await next(); });
  app.route("/api/terminal", terminalRoutes());
  const fetchImpl: typeof fetch = async (url, init) => app.request(String(url), init);
  const baseUrl = "http://127.0.0.1:7433";
  const launched: string[] = [], commands: string[][] = [];
  const deps: WindowDeps = {
    columns: async () => process.stdout.columns,
    platform: "darwin", env: { TERM_PROGRAM: "Apple_Terminal", HOME: "/fixture/home" }, exists: () => false,
    herdrConfig: () => "/fixture/private herdr.toml",
    exec: async (file, args) => {
      if (args.includes("--version")) return "herdr 0.9.3";
      if (file === "/bin/sh") return "/fixture/bin/herdr";
      if (file === "/usr/bin/osascript") { launched.push(args.join(" ")); return "window"; }
      // Any other executable (a tmux, a Herdr inventory read) is recorded, and nothing here answers it.
      commands.push([file, ...args]);
      throw new Error(`unexpected executable ${file}`);
    },
    launch: async () => {}, sleep: async () => {}, id: () => "fixture",
  };
  return { tui: new TuiClient({ baseUrl, fetchImpl }), cli: new CliClient(baseUrl, { fetchImpl }), deps, launched, commands, providerOpens, kernelSeats, alive };
}

it.each([119, 120, 159, 160, undefined])("opens the default kernel at the previewed width %s", async columns => {
  terminalWidth(columns);
  const f = await fixture();
  const preview = await f.tui.previewTerminal("saved:kernel");
  const wide = columns !== undefined && columns >= 120;
  const result = await openTerminalWindow(f.cli, "saved:kernel", undefined, f.deps, preview.planId);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, provider: "herdr", pages: wide ? 2 : 3 });
  expect(preview.composed.pages.map(page => page.map(pane => pane.seat))).toEqual(wide
    ? [["dashboard", "operator"], ["advisor"]] : [["operator"], ["dashboard"], ["advisor"]]);
  expect(result.opened).toEqual(preview.composed.opened.map(pane => pane.seat));
  // The daemon, not the CLI, places the seats: it was asked once, with the pages the preview showed.
  expect(f.providerOpens).toEqual([preview.composed.pages.map(page => page.map(pane => pane.seat))]);
  expect(f.commands).toEqual([]);
  expect(f.launched).toHaveLength(1);
});

it.each([[119, 120], [120, 119], [undefined, 120], [120, undefined]])("requires a fresh preview after resizing %s to %s", async (before, after) => {
  terminalWidth(before);
  const f = await fixture();
  const tui = f.tui;
  const preview = await tui.previewTerminal("saved:kernel");
  terminalWidth(after);
  const stale = await openTerminalWindow(f.cli, "saved:kernel", undefined, f.deps, preview.planId);
  expect(stale.ok).toBe(false);
  expect(stale.error).toContain("The terminal view changed since preview");
  expect(f.launched).toEqual([]);
  expect(f.commands).toEqual([]);
  expect(f.providerOpens).toEqual([]);
  const fresh = await tui.previewTerminal("saved:kernel");
  expect(fresh.planId).not.toBe(preview.planId);
  const result = await openTerminalWindow(f.cli, "saved:kernel", undefined, f.deps, fresh.planId);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, provider: "herdr" });
});

it("allows a resize that keeps the same kernel composition", async () => {
  terminalWidth(160);
  const f = await fixture();
  const tui = f.tui;
  const preview = await tui.previewTerminal("saved:kernel");
  terminalWidth(159);
  expect((await tui.previewTerminal("saved:kernel")).planId).toBe(preview.planId);
  const result = await openTerminalWindow(f.cli, "saved:kernel", undefined, f.deps, preview.planId);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, provider: "herdr" });
});

it.each(["topology", "liveness"])("still refuses a real kernel %s change at a wide width", async change => {
  terminalWidth(160);
  const f = await fixture();
  const preview = await f.tui.previewTerminal("saved:kernel");
  if (change === "topology") f.kernelSeats.pop();
  else f.alive.delete("advisor");
  const result = await openTerminalWindow(f.cli, "saved:kernel", undefined, f.deps, preview.planId);
  expect(result.ok).toBe(false);
  expect(result.error).toContain("The terminal view changed since preview");
  expect(f.launched).toEqual([]);
  expect(f.commands).toEqual([]);
  expect(f.providerOpens).toEqual([]);
});
