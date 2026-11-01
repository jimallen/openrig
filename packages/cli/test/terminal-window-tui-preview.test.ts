// The TUI's "Open terminals" path end to end: the TUI's preview, its planId passed as the expected plan, and the CLI
// window opener with the provider omitted (`rig terminal open --window --expected-plan <planId> -- <view>`).
// Real: the daemon's terminal routes and TerminalService (provider selection, composition, plan hashing) over
// localhost, and the TUI and CLI daemon clients.
// Stubbed: the provider adapters' status and liveness, the Herdr binary probe, and the macOS desktop launcher
// (osascript), which records its command instead of opening a window.
import { afterEach, expect, it } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { DaemonClient as CliClient } from "../src/client.js";
import { openTerminalWindow, type WindowDeps } from "../src/terminal-window.js";
import { DaemonClient as TuiClient } from "../../tui/src/daemon-client.js";
import { terminalRoutes } from "../../daemon/src/routes/terminal.js";
import { TerminalService } from "../../daemon/src/domain/terminal/terminal-service.js";
import { HERDR_PANES_PER_PAGE } from "../../daemon/src/domain/terminal/herdr-adapter.js";
import type { TerminalProvider } from "../../daemon/src/domain/terminal/terminal-provider.js";

const servers: Array<{ close(): void }> = [];
afterEach(() => { for (const server of servers.splice(0)) server.close(); });

async function fixture(herdrAvailable: boolean) {
  const seats = ["seat0", "seat1"];
  const providerOpens: string[] = [];
  const provider = (name: string, available: boolean, panesPerPage?: number): TerminalProvider => ({
    name, ...(panesPerPage ? { panesPerPage } : {}),
    status: async () => ({ provider: name, available, capabilities: { layout: true }, ...(name === "herdr" && available ? { launch: { socketPath: "/fixture/herdr.sock" } } : {}) }),
    liveness: async () => ({ alive: available }),
    openView: async (view) => {
      providerOpens.push(name);
      return { provider: name, ok: true, opened: view.opened.map(p => p.seat), absent: view.absent, degraded: view.degraded, pages: view.pages.length };
    },
  });
  const providers: Record<string, TerminalProvider> = { herdr: provider("herdr", herdrAvailable, HERDR_PANES_PER_PAGE) };
  const saved = { id: "fixture", name: "Fixture", members: seats.map(seat => ({ seat, tmuxSession: seat })) };
  const service = new TerminalService({
    resolveProvider: name => providers[name] ?? null,
    viewsStore: { get: viewId => (viewId === "fixture" ? saved : null), list: () => [saved] },
    listRigSeats: () => null, listPodSeats: () => null, listScopeSeats: () => null, listRigNames: () => [],
    resolveHost: () => null, hasSession: () => true, resolveLocalTmux: () => "/fixture/tmux",
  } as ConstructorParameters<typeof TerminalService>[0]);
  const app = new Hono();
  app.use("*", async (c, next) => { (c.set.bind(c) as (k: string, v: unknown) => void)("terminalService", service); await next(); });
  app.route("/api/terminal", terminalRoutes());
  const port = await new Promise<number>(resolve => {
    servers.push(serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, info => resolve(info.port)));
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const launched: string[] = [];
  const deps: WindowDeps = {
    herdrConfig: () => "/fixture/private herdr.toml",
    platform: "darwin", env: { TERM_PROGRAM: "Apple_Terminal", HOME: "/fixture/home" }, exists: () => false,
    exec: async (file, args) => {
      if (args.includes("--version")) { if (!herdrAvailable) throw new Error("herdr: not installed"); return "herdr 0.9.3"; }
      if (file === "/bin/sh") { if (!herdrAvailable) throw new Error("herdr: not installed"); return "/fixture/bin/herdr"; }
      if (file === "/usr/bin/osascript") { launched.push(args.join(" ")); return "window"; }
      throw new Error(`unexpected executable ${file}`);
    },
    launch: async () => {}, sleep: async () => {}, id: () => "fixture",
  };
  return { baseUrl, saved, deps, launched, providerOpens };
}

it("with no Herdr, Open terminals opens no window and no other viewer", async () => {
  const f = await fixture(false);
  const preview = await new TuiClient({ baseUrl: f.baseUrl }).previewTerminal("saved:fixture");
  const result = await openTerminalWindow(new CliClient(f.baseUrl), "saved:fixture", undefined, f.deps, preview.planId);
  expect(result).toMatchObject({ ok: false, provider: "herdr", opened: [], windowAttempted: false });
  expect(result.error).toContain("Herdr is not installed");
  expect(f.launched).toEqual([]);
  expect(f.providerOpens).toEqual([]);
});

it("with Herdr available, Open terminals opens one window and asks the daemon to place the previewed seats once", async () => {
  const f = await fixture(true);
  const preview = await new TuiClient({ baseUrl: f.baseUrl }).previewTerminal("saved:fixture");
  const result = await openTerminalWindow(new CliClient(f.baseUrl), "saved:fixture", undefined, f.deps, preview.planId);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, provider: "herdr", opened: ["seat0", "seat1"] });
  expect(f.launched).toHaveLength(1);
  expect(f.providerOpens).toEqual(["herdr"]);
});

it("with Herdr available, the TUI preview's plan is the one the window opener checks, as before", async () => {
  const f = await fixture(true);
  const tui = await new TuiClient({ baseUrl: f.baseUrl }).previewTerminal("saved:fixture");
  const fetchPlan = async (query: string) => ((await (await fetch(`${f.baseUrl}/api/terminal/preview?view=saved%3Afixture${query}`)).json()) as { planId: string; provider: string });
  const providerless = await fetchPlan("");
  const windowOpener = await fetchPlan("&provider=herdr");
  expect(providerless.provider).toBe("herdr");
  expect(tui.planId).toBe(providerless.planId);
  expect(tui.planId).toBe(windowOpener.planId);
});

it("a view that really changed after the preview is still refused, without a window or a view", async () => {
  const f = await fixture(true);
  const preview = await new TuiClient({ baseUrl: f.baseUrl }).previewTerminal("saved:fixture");
  f.saved.members = f.saved.members.slice(0, 1);
  const result = await openTerminalWindow(new CliClient(f.baseUrl), "saved:fixture", undefined, f.deps, preview.planId);
  expect(result.ok).toBe(false);
  expect(result.error).toContain("The terminal view changed since preview");
  expect(f.launched).toEqual([]);
  expect(f.providerOpens).toEqual([]);
});

it("a provider-less open that isn't a window stays on herdr when Herdr isn't available (there is no other provider)", async () => {
  const f = await fixture(false);
  const response = await fetch(`${f.baseUrl}/api/terminal/open`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ view: "saved:fixture" }) });
  const result = await response.json() as { provider: string; ok: boolean };
  expect(result).toMatchObject({ provider: "herdr", ok: true });
  expect(f.providerOpens).toEqual(["herdr"]);
});
