import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDaemon } from "../src/startup.js";
import type { ArgvExecFn, ExecFn, TmuxAdapter } from "../src/adapters/tmux.js";
import type { CmuxTransportFactory } from "../src/adapters/cmux.js";

const cmuxFactory: CmuxTransportFactory = async () => { throw Object.assign(new Error(""), { code: "ENOENT" }); };

function argvExecOf(adapter: TmuxAdapter): ArgvExecFn | undefined {
  return (adapter as unknown as { argvExec?: ArgvExecFn }).argvExec;
}

// A full daemon composition took 3-28 s per file on a loaded host.
describe("createDaemon tmux exec wiring", { timeout: 120000 }, () => {
  let tmuxDir: string;
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  // better-sqlite3 picks its native addon by process.platform on first open; load the host's one first.
  beforeAll(() => { new Database(":memory:").close(); });
  beforeEach(() => {
    // Any real tmux call during composition reaches an empty private directory, never a live server.
    tmuxDir = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-startup-tmux-"));
    vi.stubEnv("TMUX_TMPDIR", tmuxDir);
    vi.stubEnv("TMUX", undefined);
    vi.stubEnv("OPENRIG_NO_KERNEL", "1");
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", platform);
    vi.unstubAllEnvs();
    fs.rmSync(tmuxDir, { recursive: true, force: true });
  });

  // The seat host is hc unless a suite injects a tmux exec (startup.ts: "no runtime path passes one"), so no platform
  // reaches the tmux adapter's argv exec by default and OPENRIG_TMUX_SHELL has nothing left to choose.
  for (const host of ["linux", "darwin", "win32"] as const) {
    it(`seats the daemon on hc, with no tmux exec, on ${host}`, async () => {
      Object.defineProperty(process, "platform", { ...platform, value: host });
      const daemon = await createDaemon({ dbPath: ":memory:", cmuxFactory });
      try {
        expect(daemon.deps.tmuxAdapter.hostKind).toBe("hc");
        // Its exec is the refusal HcAdapter installs, so a tmux call that slipped through fails loudly and never runs tmux.
        await expect(argvExecOf(daemon.deps.tmuxAdapter)!(["list-sessions"])).rejects.toThrow(/a tmux path was reached/);
      } finally {
        daemon.eventLoopMonitor.stop();
        daemon.db.close();
      }
    });
  }

  it("OPENRIG_TMUX_SHELL=1 does not move the daemon off hc", async () => {
    vi.stubEnv("OPENRIG_TMUX_SHELL", "1");
    const daemon = await createDaemon({ dbPath: ":memory:", cmuxFactory });
    try {
      expect(daemon.deps.tmuxAdapter.hostKind).toBe("hc");
    } finally {
      daemon.eventLoopMonitor.stop();
      daemon.db.close();
    }
  });

  it("an injected argv exec keeps the tmux adapter, and is the exec it runs", async () => {
    const argvExec: ArgvExecFn = async () => "";
    const daemon = await createDaemon({ dbPath: ":memory:", cmuxFactory, argvExec });
    try {
      expect(daemon.deps.tmuxAdapter.hostKind).toBe("tmux");
      expect(argvExecOf(daemon.deps.tmuxAdapter)).toBe(argvExec);
    } finally {
      daemon.eventLoopMonitor.stop();
      daemon.db.close();
    }
  });

  it("keeps an injected string exec on the shell path, so its fake sees every command", async () => {
    const tmuxExec: ExecFn = async () => "";
    const daemon = await createDaemon({ dbPath: ":memory:", cmuxFactory, tmuxExec });
    try {
      expect(argvExecOf(daemon.deps.tmuxAdapter)).toBeUndefined();
    } finally {
      daemon.eventLoopMonitor.stop();
      daemon.db.close();
    }
  });
});
