// OF-200 review F3: what a seat's respawn gets when the daemon restarted since the seat was made and only its identity labels survive.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HcAdapter } from "../src/adapters/hc-adapter.js";
import { createDaemon } from "../src/startup.js";
import { seatRestartEnv } from "../src/domain/seat-restart-env.js";

const SOURCES = {
  sessionEnv: { PATH: "/usr/bin:/bin", OPENRIG_HOME: "/h/.openrig", OPENRIG_ACTIVITY_HOOK_TOKEN: "tok", OPENRIG_URL: "http://127.0.0.1:7433", CODEX_HOME: "/shared", HOME: "/h", EMPTY: "  ", UNSET: undefined },
  runtimeSessionEnv: { omp: { OMP_KEY: "k" }, codex: { CODEX_ONLY: "c" } },
};

describe("seatRestartEnv", () => {
  it("is the launch composition: the daemon's session env, the runtime's extra env, and the worktree shim first on PATH", () => {
    const env = seatRestartEnv({ OPENRIG_RUNTIME: "omp" }, SOURCES);
    expect(env).toMatchObject({ OPENRIG_ACTIVITY_HOOK_TOKEN: "tok", OPENRIG_URL: "http://127.0.0.1:7433", HOME: "/h", OMP_KEY: "k", PATH: "/h/.openrig/rig-bin:/usr/bin:/bin" });
    expect(env, "another runtime's extra env is not carried").not.toHaveProperty("CODEX_ONLY");
  });

  it("lets the identity the labels kept win over the daemon's value", () => {
    const env = seatRestartEnv({ OPENRIG_NODE_ID: "n1", OPENRIG_SESSION_NAME: "a@r", OPENRIG_RUNTIME: "codex", CODEX_HOME: "/seat/home" }, SOURCES);
    expect(env).toMatchObject({ OPENRIG_NODE_ID: "n1", OPENRIG_SESSION_NAME: "a@r", CODEX_HOME: "/seat/home", CODEX_ONLY: "c" });
  });

  it("drops a blank or undefined value, as the launch does, and puts no shim on a missing PATH", () => {
    const env = seatRestartEnv({}, { sessionEnv: { OPENRIG_HOME: "/h/.openrig", EMPTY: " ", UNSET: undefined }, runtimeSessionEnv: {} });
    expect(env).toEqual({ OPENRIG_HOME: "/h/.openrig" });
  });

  it("gives the shim the daemon's home when the session env names none", () => {
    const saved = process.env["OPENRIG_HOME"];
    process.env["OPENRIG_HOME"] = "/from/daemon";
    try {
      expect(seatRestartEnv({}, { sessionEnv: { PATH: "/bin" }, runtimeSessionEnv: {} })["PATH"]).toBe("/from/daemon/rig-bin:/bin");
    } finally {
      if (saved === undefined) delete process.env["OPENRIG_HOME"]; else process.env["OPENRIG_HOME"] = saved;
    }
  });
});

describe("the daemon wires it to its host", () => {
  it("a daemon built with the hc host rebuilds a seat's respawn env from its own launch env: the identity, the activity-hook token, the shim first on PATH", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seat-restart-env-"));
    const daemon = await createDaemon({ dbPath: join(dir, "openrig.sqlite") });
    try {
      const adapter = daemon.deps.tmuxAdapter;
      expect(adapter).toBeInstanceOf(HcAdapter);
      const env = (adapter as HcAdapter).restartEnvOf({ OPENRIG_NODE_ID: "node-x", OPENRIG_RUNTIME: "codex" });
      expect(env["OPENRIG_NODE_ID"]).toBe("node-x");
      expect(env["OPENRIG_ACTIVITY_HOOK_TOKEN"], "the token the daemon launches seats with").toMatch(/\S{8,}/);
      expect(env["PATH"]!.split(":")[0]).toMatch(/\/rig-bin$/);
    } finally {
      daemon.hcCoreWatch?.stop();
      daemon.eventLoopMonitor.stop();
      daemon.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
