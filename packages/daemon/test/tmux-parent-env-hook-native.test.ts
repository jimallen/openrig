// #771 — a seat launch must not carry the parent Claude Code identity, and must leave every other terminal's process alone. On tmux this
// was a server-level `after-new-session` hook that linked an existing window into the new session, and a cleanup that restarted only
// the pane `new-session` created. hc has no hooks and no linked windows (a launch is one `terminal.run`), so what is left of the intent
// is pinned here: the neighbour terminal keeps the very process it had, and the seat's own program gets no parent identity.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { HcAdapter } from "../src/adapters/hc-adapter.js";
import { hcTerminalName, SEAT_LABEL } from "../src/adapters/hc-host.js";
import { findHc, startHcScratch, type HcScratch } from "./helpers/hc-scratch.js";

describe.skipIf(!findHc())("seat launch beside another terminal (hc)", () => {
  let scratch: HcScratch;
  beforeAll(() => { scratch = startHcScratch(); }, 60_000);
  afterAll(() => { vi.unstubAllEnvs(); scratch?.cleanup(); });

  it("launches the seat without the parent identity; the existing terminal keeps its process", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "hc-parent-env-"));
    vi.stubEnv("SHELL", "/bin/sh");
    vi.stubEnv("CLAUDECODE", "1");
    const adapter = new HcAdapter(scratch.client());
    const get = (name: string) => scratch.client().call<{ address: string; pid: number; state: string }>("terminal.get", { terminal: hcTerminalName(name) });
    try {
      await scratch.client().call("terminal.run", {
        argv: ["sleep", "600"], name: hcTerminalName("owner"), labels: { [SEAT_LABEL]: "owner" }, cwd: temp, no_parent: true, no_notify: true, outlive_parent: true,
      });
      const before = await get("owner");
      const result = await adapter.createSession("seat", temp, { OPENRIG_NODE_ID: "n1" });
      expect(result).toMatchObject({ ok: true });

      // The neighbour was not restarted: same terminal, same process, still running.
      const after = await get("owner");
      expect(after).toMatchObject({ address: before.address, pid: before.pid, state: "live" });
      expect(() => process.kill(before.pid, 0)).not.toThrow();

      // The seat's own program was given its launch identity and not the parent's.
      const seen = path.join(temp, "seat.env");
      expect(await adapter.sendText("seat", `/usr/bin/env > '${seen}.tmp' && mv '${seen}.tmp' '${seen}'`)).toEqual({ ok: true });
      expect(await adapter.sendKeys("seat", ["Enter"])).toEqual({ ok: true });
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(seen) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      const environ = fs.readFileSync(seen, "utf8").split("\n");
      expect(environ.filter((entry) => entry.startsWith("CLAUDECODE="))).toEqual([]);
      expect(environ).toContain("OPENRIG_NODE_ID=n1");
    } finally {
      await adapter.killSession("seat"); await adapter.killSession("owner");
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});
