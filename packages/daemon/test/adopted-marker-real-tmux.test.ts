// a2 review (b94822a4) F1, F2: the adopted session is told by the OpenRig marker a claim writes into it (@rigged_node_id), read
// through the real tmux adapter on PRIVATE sockets (never the host's server). The marker reads the same whichever window is
// current (F1: a pane list without -s saw only the current window), and a session recreated under the same name on a fresh
// server, where pane ids restart at %0, carries none (F2: a pane id matched it).
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
import { checkAdoptedIdentity } from "../src/domain/adopted-reattach.js";

const run = promisify(exec);
const runFile = promisify(execFile);

describe.skipIf(process.platform === "win32")("the adopted-session marker through real tmux (a2)", () => {
  it("reads unset, set and unreadable apart; the same in every window; absent from a session recreated on a fresh server", async () => {
    const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), "a2-marker-"));
    const first = path.join(socketDir, "first.sock");
    const fresh = path.join(socketDir, "fresh.sock");
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: socketDir };
    delete env.TMUX; delete env.TMUX_TMPDIR;
    const adapterOn = (socket: string) => new TmuxAdapter(async (command) => (await run(`tmux -S ${shellQuote(socket)} ${command.slice(5)}`, { env })).stdout);
    const tmux = (socket: string, args: string[]) => runFile("tmux", ["-S", socket, "-f", "/dev/null", ...args], { env });
    try {
      await tmux(first, ["new-session", "-d", "-s", "person-shell", "sleep 120"]);
      const adapter = adapterOn(first);

      expect(await adapter.readSessionOption("person-shell", "@rigged_node_id")).toEqual({ ok: true, value: null });
      expect(await adapter.setSessionOption("person-shell", "@rigged_node_id", "node-1")).toEqual({ ok: true });
      expect(await adapter.readSessionOption("person-shell", "@rigged_node_id")).toEqual({ ok: true, value: "node-1" });
      const missing = await adapter.readSessionOption("no-such-session", "@rigged_node_id");
      expect(missing.ok).toBe(false);
      expect(await checkAdoptedIdentity("node-1", "no-such-session", (s, k) => adapter.readSessionOption(s, k))).toMatchObject({ kind: "unknown" });

      // F1: a second window, made current. The pane list the b94822a4 check read (no -s) sees only that window's panes.
      await tmux(first, ["new-window", "-t", "=person-shell:", "sleep 120"]);
      await tmux(first, ["select-window", "-t", "=person-shell:1"]);
      const currentWindowPanes = (await adapter.listPanes("person-shell")).map((pane) => pane.id);
      const allPanes = (await tmux(first, ["list-panes", "-s", "-t", "=person-shell:", "-F", "#{pane_id}"])).stdout.trim().split("\n");
      expect(allPanes.length).toBe(2);
      expect(currentWindowPanes).toEqual([allPanes[1]]);
      expect(await checkAdoptedIdentity("node-1", "person-shell", (s, k) => adapter.readSessionOption(s, k))).toEqual({ kind: "same" });
      expect(await checkAdoptedIdentity("node-2", "person-shell", (s, k) => adapter.readSessionOption(s, k))).toEqual({ kind: "replaced", marker: "node-1" });

      // F2: a fresh server and a session recreated under the same name: pane ids restart, so the first pane id repeats.
      await tmux(fresh, ["new-session", "-d", "-s", "person-shell", "sleep 120"]);
      const freshAdapter = adapterOn(fresh);
      expect((await freshAdapter.listPanes("person-shell")).map((pane) => pane.id)).toEqual([allPanes[0]]);
      expect(await checkAdoptedIdentity("node-1", "person-shell", (s, k) => freshAdapter.readSessionOption(s, k))).toEqual({
        kind: "unknown",
        why: "it carries no OpenRig marker (@rigged_node_id): it may have been recreated since rig down, or the marker was never written",
      });
    } finally {
      for (const socket of [first, fresh]) await runFile("tmux", ["-S", socket, "kill-server"], { env }).catch(() => {});
      fs.rmSync(socketDir, { recursive: true, force: true });
    }
  });
});
