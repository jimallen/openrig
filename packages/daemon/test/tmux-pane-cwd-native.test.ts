import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { HcAdapter } from "../src/adapters/hc-adapter.js";
import { hcTerminalName } from "../src/adapters/hc-host.js";
import { findHc, startHcScratch, type HcScratch } from "./helpers/hc-scratch.js";

describe.skipIf(!findHc())("hc seat paths", () => {
  let scratch: HcScratch;
  beforeAll(() => { scratch = startHcScratch(); vi.stubEnv("SHELL", "/bin/sh"); }, 60_000);
  afterAll(() => { vi.unstubAllEnvs(); scratch?.cleanup(); });

  it("preserves pipe characters in the seat's cwd and still reports geometry", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "hc-cwd-"));
    const cwd = path.join(temp, "work|assets|120");
    fs.mkdirSync(cwd);
    const adapter = new HcAdapter(scratch.client());
    try {
      expect(await adapter.createSession("fixture", cwd)).toEqual({ ok: true });
      const terminal = await scratch.client().call<{ address: string; cols: number; rows: number }>("terminal.get", { terminal: hcTerminalName("fixture") });
      const panes = await adapter.listPanes("fixture");
      expect(panes).toHaveLength(1);
      expect(panes[0]).toMatchObject({ cwd: fs.realpathSync(cwd), index: 0, width: terminal.cols, height: terminal.rows, active: true });
      expect(panes[0]!.width).toBeGreaterThan(0);
      expect(panes[0]!.height).toBeGreaterThan(0);
      // A pane is the terminal's address (`t7`), where tmux's was `%7`.
      expect(panes[0]!.id).toBe(terminal.address);
      expect(panes[0]!.id).toMatch(/^t\d+$/);
    } finally {
      await adapter.killSession("fixture");
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});
