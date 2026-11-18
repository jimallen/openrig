// workspaces-o9o.172 (ROUTING R-21): the scenario surface `tui_view` reads the TUI control socket's OBSERVE verb "view", the digest of the
// world the TUI renders, so a scenario can put the TUI in a cross-surface `equals` beside `ps` and `queue`. Like `tui_socket` it needs the
// TUI the pipeline provisions on `env.tui: true`, and it sends exactly one OBSERVE line: never anything the TUI would dispatch.
import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
import os from "node:os";
import nodePath from "node:path";
import { rmSync } from "node:fs";
import { validateScenario } from "./helpers/scenario-schema.js";
import { readSurface } from "./helpers/scenario-surfaces.js";
import { runValidatedScenario } from "./helpers/scenario-runner.js";

const sockets: string[] = [];
afterEach(() => { for (const s of sockets.splice(0)) rmSync(s, { force: true }); });

/** A fake TUI control socket that records every line it is sent and answers with `reply`. */
async function fakeTui(reply: (line: string) => unknown): Promise<{ path: string; lines: string[]; close: () => Promise<void> }> {
  const sockPath = nodePath.join(os.tmpdir(), `o9o172-tui-${process.pid}-${sockets.length}.sock`);
  sockets.push(sockPath);
  const lines: string[] = [];
  const server = net.createServer((conn) => {
    let buf = "";
    conn.on("data", (d) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        lines.push(line);
        conn.write(JSON.stringify(reply(line)) + "\n");
      }
    });
  });
  await new Promise<void>((r) => server.listen(sockPath, () => r()));
  return { path: sockPath, lines, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe("the tui_view surface", () => {
  it("is a surface the validator accepts, and like tui_socket it needs env.tui", () => {
    const steps = [{ up: {} }, { expect: { surface: "tui_view", match: { ok: true } } }];
    expect(validateScenario({ scenario: "s", topology: "./t.yaml", env: { tui: true }, steps }).ok).toBe(true);
    const without = validateScenario({ scenario: "s", topology: "./t.yaml", steps });
    expect(without.ok).toBe(false);
    expect(JSON.stringify(without)).toContain("TUI_NOT_DECLARED");
  });

  it("sends exactly the OBSERVE line 'view' and returns the reply; tui_socket still sends 'state'", async () => {
    const tui = await fakeTui((line) => ({ ok: true, instanceId: "t", ...(line === "view" ? { view: { rigs: [{ host: "h", name: "r1" }] } } : { state: {} }) }));
    try {
      const ctx = { rigBin: "/not-run", baseUrl: "http://127.0.0.1:9", readEnv: { OPENRIG_TUI_SOCKET: tui.path } };
      expect(await readSurface("tui_view", ctx)).toMatchObject({ view: { rigs: [{ name: "r1" }] } });
      expect(await readSurface("tui_socket", ctx)).toMatchObject({ state: {} });
      expect(tui.lines).toEqual(["view", "state"]);
    } finally { await tui.close(); }
  });

  it("joins a cross-surface equals by the rig set the TUI holds: the same set passes, a TUI missing the rig fails", async () => {
    const scenario = (validateScenario({ scenario: "s", topology: "./t.yaml", env: { tui: true }, steps: [
      { expect: { surface: "ps", within: "2s", equals: { ps: { pluck: "name" }, tui_view: { path: "view.rigs", pluck: "name" } } } },
    ] }) as { ok: true; scenario: never }).scenario;
    const run = (tuiRigs: string[]) => {
      let t = 0;
      return runValidatedScenario(scenario, {
        runAction: async () => ({ code: 0, stdout: "", stderr: "" }),
        observe: async (surface) => (surface === "ps" ? [{ name: "alpha" }] : { ok: true, view: { rigs: tuiRigs.map((name) => ({ host: "h", name })) } }),
        now: () => (t += 1000), sleep: async () => {}, defaults: { withinMs: 2000, pollIntervalMs: 1000 },
      });
    };
    expect((await run(["alpha"])).verdict).toBe("PASS");
    expect((await run([])).verdict).toBe("FAIL");
  });
});
