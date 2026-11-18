// workspaces-o9o.172 (CoS decision A, after a real-TUI measurement): the TUI reads a rig's seats only once that rig is selected, so a
// scenario that compares agents must first drill the TUI into the rig. The `tui` action does exactly that and nothing more: its payload
// is `{ rig: <name> }`, it sends the ONE grammar line `rig <name>` (a drill the TUI already accepts) to the TUI control socket, never to
// the daemon, and it fails when the TUI does not accept the line.
import { afterEach, describe, expect, it, vi } from "vitest";
import net from "node:net";
import os from "node:os";
import nodePath from "node:path";
import { rmSync } from "node:fs";
import { validateScenario } from "./helpers/scenario-schema.js";
import { buildRealDeps } from "./helpers/scenario-real-deps.js";
import type { RigResult } from "./helpers/scenario-daemon.js";

const sockets: string[] = [];
afterEach(() => { for (const s of sockets.splice(0)) rmSync(s, { force: true }); });

/** A fake TUI control socket that records every line it is sent and answers with `reply`. */
async function fakeTui(reply: (line: string) => unknown): Promise<{ path: string; lines: string[]; close: () => Promise<void> }> {
  const sockPath = nodePath.join(os.tmpdir(), `o9o172-act-${process.pid}-${sockets.length}.sock`);
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

function deps(socketPath: string | undefined) {
  const runRig = vi.fn(async (_args: string[]): Promise<RigResult> => ({ code: 0, stdout: "", stderr: "" }));
  const readEnv: Record<string, string | undefined> = { OPENRIG_URL: "http://127.0.0.1:1", ...(socketPath ? { OPENRIG_TUI_SOCKET: socketPath } : {}) };
  const daemon = { readEnv, baseUrl: "http://127.0.0.1:1", sigterm: vi.fn(async () => {}), restart: vi.fn(async () => {}) };
  return { runRig, deps: buildRealDeps({ daemon, rigBin: "/not-run", topologyPath: "/t/spec.yaml", runRig }) };
}

describe("the tui action (o9o.172)", () => {
  it("the validator accepts { rig: <name> } with env.tui, and refuses free text, extra keys, unsafe names and a missing env.tui", () => {
    const scenario = (tui: unknown, env: Record<string, unknown> | null = { tui: true }) =>
      validateScenario({ scenario: "s", topology: "./t.yaml", ...(env ? { env } : {}), steps: [{ up: {} }, { tui }] });
    expect(scenario({ rig: "mutation-pod-stub" }).ok).toBe(true);
    for (const bad of ["rig mutation-pod-stub", { rig: "a", pod: "b" }, { pod: "b" }, { rig: "" }, { rig: "a\nview" }, { rig: "a b" },
      { rig: ":quit" }, { rig: "x".repeat(101) }, { rig: 7 }]) {
      const r = scenario(bad);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      expect(JSON.stringify(r)).toContain("TUI_ACTION_INVALID");
    }
    const noEnv = scenario({ rig: "a" }, null);
    expect(noEnv.ok).toBe(false);
    expect(JSON.stringify(noEnv)).toContain("TUI_NOT_DECLARED");
  });

  it("sends exactly the one grammar line `rig <name>` to the TUI socket, and never runs the rig CLI", async () => {
    const tui = await fakeTui(() => ({ ok: true, screen: "topology", drill: ["rig:mutation-pod-stub"] }));
    try {
      const { runRig, deps: d } = deps(tui.path);
      const r = await d.runAction("tui", { rig: "mutation-pod-stub" }, undefined);
      expect(r.code).toBe(0);
      expect(tui.lines).toEqual(["rig mutation-pod-stub"]);
      expect(runRig).not.toHaveBeenCalled();
    } finally { await tui.close(); }
  });

  it("fails when the TUI does not accept the line, carrying its reply", async () => {
    const tui = await fakeTui(() => ({ ok: false, error: "no rig named nope" }));
    try {
      const r = await deps(tui.path).deps.runAction("tui", { rig: "nope" }, undefined);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("no rig named nope");
    } finally { await tui.close(); }
  });

  it("re-checks the payload at the adapter: an unsafe name sends nothing", async () => {
    const tui = await fakeTui(() => ({ ok: true }));
    try {
      const { runRig, deps: d } = deps(tui.path);
      const r = await d.runAction("tui", { rig: "a\nview" }, undefined);
      expect(r.code).not.toBe(0);
      expect(tui.lines).toEqual([]);
      expect(runRig).not.toHaveBeenCalled();
    } finally { await tui.close(); }
  });

  it("with no TUI socket it fails named, and does not fall back to the daemon", async () => {
    const { runRig, deps: d } = deps(undefined);
    const r = await d.runAction("tui", { rig: "a" }, undefined);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("OPENRIG_TUI_SOCKET");
    expect(runRig).not.toHaveBeenCalled();
  });
});

describe("the real adapter hands since to the tui_view reader (o9o.172)", () => {
  it("a view read at or after the expect's start comes back confirmedDuringStep; one before it does not", async () => {
    const readAt = "2026-11-18T18:00:00.000Z";
    const tui = await fakeTui(() => ({ ok: true, view: { readAt, stale: false, settled: true, rigs: [] } }));
    try {
      const { deps: d } = deps(tui.path);
      const at = Date.parse(readAt);
      expect(await d.observe("tui_view", { since: at })).toMatchObject({ view: { confirmedDuringStep: true } });
      expect(await d.observe("tui_view", { since: at + 1 })).toMatchObject({ view: { confirmedDuringStep: false } });
    } finally { await tui.close(); }
  });
});
