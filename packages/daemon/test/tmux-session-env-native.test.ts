import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { HcAdapter } from "../src/adapters/hc-adapter.js";
import { hcTerminalName } from "../src/adapters/hc-host.js";
import { SeatLaunchEnvironment } from "../src/domain/seat-launch-environment.js";
import { findHc, startHcScratch, type HcScratch } from "./helpers/hc-scratch.js";

// What a seat's launch recorded about itself (node id, session name, runtime), read back by exact name. tmux read it from the session
// environment (`show-environment`) and the exact-name risk was a prefix match onto a neighbouring session; hc holds it in labels
// written at launch (HcHost.createSession, sessionEnvLabels) and finds the terminal by the digest of the whole name.
describe.skipIf(!findHc())("hc seat launch environment, read back by exact name", () => {
  let scratch: HcScratch;
  let adapter: HcAdapter;
  beforeAll(async () => {
    scratch = startHcScratch();
    adapter = new HcAdapter(scratch.client());
    vi.stubEnv("SHELL", "/bin/sh");
    await expect(adapter.createSession("worker-long", scratch.root, {
      OPENRIG_NODE_ID: "neighbor-node", OPENRIG_SESSION_NAME: "worker-long", OPENRIG_RUNTIME: "terminal",
    })).resolves.toEqual({ ok: true });
  }, 60_000);
  afterAll(() => { vi.unstubAllEnvs(); scratch?.cleanup(); });

  it("rejects an absent prefix rather than reading its neighbor", async () => {
    await expect(adapter.getSessionEnv("worker", "OPENRIG_NODE_ID")).rejects.toThrow("Cannot read the session's launch environment.");
    expect(await adapter.getSessionEnv("worker-long", "OPENRIG_NODE_ID")).toBe("neighbor-node");
  });

  it("launch correction does not reassert a stale target's neighbor identity", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "hc-env-"));
    const cli = path.join(home, "rig-fixture");
    fs.writeFileSync(cli, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const launch = new SeatLaunchEnvironment(adapter, { OPENRIG_HOME: home }, home, cli);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // The ordinary launch caller must retain its previous command when its target has gone, without reasserting a neighbor's identity.
      expect(await launch.command("worker", "printf fixture")).toBe("printf fixture");
    } finally { warning.mockRestore(); fs.rmSync(home, { recursive: true, force: true }); }
  });

  it("reads the exact name and the terminal address, each its own seat's value", async () => {
    try {
      await expect(adapter.createSession("worker", scratch.root, { OPENRIG_NODE_ID: "own-node" })).resolves.toEqual({ ok: true });
      const address = (await adapter.listPanes("worker"))[0]!.id;
      expect(address).toBe((await scratch.client().call<{ address: string }>("terminal.get", { terminal: hcTerminalName("worker") })).address);
      expect(await adapter.getSessionEnv("worker", "OPENRIG_NODE_ID")).toBe("own-node");
      expect(await adapter.getSessionEnv(address, "OPENRIG_NODE_ID")).toBe("own-node");
      expect(await adapter.getSessionEnv("worker-long", "OPENRIG_NODE_ID")).toBe("neighbor-node");
    } finally { await adapter.killSession("worker"); }
  });

  // Found by this conversion: getSessionEnv finds the terminal through hcTerminalRef, which reads a leading `=` as tmux's exact marker and
  // drops it, so the seat literally named `=worker` answers with the value of `worker`. createSession/probeSession keep the name as given.
  it.fails("reads a seat whose name literally starts with `=` from that seat (DEFECT: hcTerminalRef strips the `=`)", async () => {
    try {
      await expect(adapter.createSession("worker", scratch.root, { OPENRIG_NODE_ID: "own-node" })).resolves.toEqual({ ok: true });
      await expect(adapter.createSession("=worker", scratch.root, { OPENRIG_NODE_ID: "literal-node" })).resolves.toEqual({ ok: true });
      expect(await adapter.getSessionEnv("=worker", "OPENRIG_NODE_ID")).toBe("literal-node");
    } finally { await adapter.killSession("worker"); await adapter.killSession("=worker"); }
  });

  it("preserves absent/unset variables and invalid-key rejection", async () => {
    expect(await adapter.getSessionEnv("worker-long", "OPENRIG_UNSET_FIXTURE")).toBeUndefined();
    // A launch that recorded no node id reads back as unset, as `set-environment -r` left it under tmux.
    await expect(adapter.createSession("unset-id", scratch.root, { OPENRIG_RUNTIME: "terminal" })).resolves.toEqual({ ok: true });
    try {
      expect(await adapter.getSessionEnv("unset-id", "OPENRIG_NODE_ID")).toBeUndefined();
      expect(await adapter.getSessionEnv("unset-id", "OPENRIG_RUNTIME")).toBe("terminal");
    } finally { await adapter.killSession("unset-id"); }
    await expect(adapter.getSessionEnv("worker-long", "not-a-key")).rejects.toThrow("Invalid session environment key.");
  });
});
