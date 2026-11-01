// A real open is several app round trips, so `rig terminal open` runs on its own budget (45 s), not the client's 5 s read
// default. Real pieces: the CLI command, DaemonClient over HTTP, the daemon's terminal route, the app provider and the composer.
// Faked: the app (an AppPort whose every command takes 450 ms, as a loaded app might), so the 17-seat, two-page open takes
// longer than the 5 s default and still completes. The positive control is the elapsed time itself.
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { DaemonClient } from "../src/client.js";
import { terminalCommand } from "../src/commands/terminal.js";
import type { TerminalDeps } from "../src/commands/terminal.js";
import type { AppLs, AppPort } from "../../daemon/src/adapters/hc-placement.js";
import { HERDR_APP_PANES_PER_PAGE, HerdrAppProvider } from "../../daemon/src/domain/terminal/herdr-app-provider.js";
import { composeView } from "../../daemon/src/domain/terminal/view-composer.js";
import { terminalRoutes } from "../../daemon/src/routes/terminal.js";

describe("terminal open request budget", () => {
  it("waits for a slow multi-page open instead of abandoning a delivered one", async () => {
    const commands: string[] = [];
    const spaces: AppLs["spaces"] = [];
    let seq = 0;
    const slow = () => new Promise<void>(resolve => setTimeout(resolve, 450));
    const appPort: AppPort = {
      ls: async () => ({ spaces: structuredClone(spaces) }),
      do: async (command, args) => {
        commands.push(command);
        await slow();
        const id = ++seq;
        if (command === "space.new" || command === "tab.new") {
          let space = spaces.find(s => s.id === args["space"]);
          if (!space) { space = { id: `sp${id}`, name: String(args["name"]), tabs: [] }; spaces.push(space); }
          space.tabs.push({ id: `tb${id}`, name: "t", terminals: [{ terminal: `t${id}`, pane: `pn${id}` }] });
          return { space: space.id, tab: `tb${id}`, terminal: `t${id}` };
        }
        return { pane: `pn${id}` };
      },
    };
    const provider = new HerdrAppProvider(appPort);
    const view = composeView("rig:owned-rig", Array.from({ length: 17 }, (_, index) => ({
      seat: `agent-${index}@owned-rig`, label: `Agent ${index}`, tmuxSession: `owned-${index}`,
      host: null, alive: true, readOnly: false,
    })), { resolveHost: () => null, panesPerPage: HERDR_APP_PANES_PER_PAGE });
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("terminalService" as never, {
        openView: () => provider.openView(view),
        status: async () => ({ providers: [{ liveness: await provider.liveness() }] }),
      } as never);
      await next();
    });
    app.route("/api/terminal", terminalRoutes());
    const httpServer = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    if (!httpServer.listening) await new Promise<void>(resolve => httpServer.once("listening", resolve));
    const port = (httpServer.address() as { port: number }).port;
    const deps: TerminalDeps = {
      lifecycleDeps: {
        exists: () => true,
        readFile: () => JSON.stringify({ pid: process.pid, port, host: "127.0.0.1", db: "owned", startedAt: new Date().toISOString() }),
        isProcessAlive: () => true,
        fetch: async () => ({ ok: true }),
      } as TerminalDeps["lifecycleDeps"],
      clientFactory: baseUrl => new DaemonClient(baseUrl),
      columns: async () => undefined,
    };
    const command = new Command();
    command.addCommand(terminalCommand(deps));
    const originalExit = process.exitCode;
    process.exitCode = undefined;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const startedAt = Date.now();
    try {
      await command.parseAsync(["terminal", "open", "owned-rig", "--json"], { from: "user" });
      const elapsed = Date.now() - startedAt;
      expect(process.exitCode).toBeUndefined();
      const result = JSON.parse(String(log.mock.calls[0]?.[0]));
      expect(result.opened).toHaveLength(17);
      expect(result.pages).toBe(2);
      expect(commands.filter(c => c === "space.new")).toHaveLength(1);
      expect(commands.filter(c => c === "tab.new")).toHaveLength(1);
      expect(elapsed, "longer than the client's 5 s read default, or the budget is not what is tested").toBeGreaterThan(5_000);
    } finally {
      process.exitCode = originalExit;
      log.mockRestore();
      httpServer.closeAllConnections();
      await new Promise<void>(resolve => httpServer.close(() => resolve()));
    }
  }, 60_000);
});
