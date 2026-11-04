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
  // OF-205 (a): the daemon's own record of which runtime a seat is (startup.ts reads nodes.runtime); a label never says it.
  runtimeOf: (identity: Readonly<Record<string, string>>): string | undefined => ({ "n-omp": "omp", "n-codex": "codex" } as Record<string, string>)[identity["OPENRIG_NODE_ID"] ?? ""],
};

describe("seatRestartEnv", () => {
  it("is the launch composition: the daemon's session env, the runtime's extra env, and the worktree shim first on PATH", () => {
    const env = seatRestartEnv({ OPENRIG_NODE_ID: "n-omp", OPENRIG_RUNTIME: "omp" }, SOURCES);
    expect(env).toMatchObject({ OPENRIG_ACTIVITY_HOOK_TOKEN: "tok", OPENRIG_URL: "http://127.0.0.1:7433", HOME: "/h", OMP_KEY: "k", PATH: "/h/.openrig/rig-bin:/usr/bin:/bin" });
    expect(env, "another runtime's extra env is not carried").not.toHaveProperty("CODEX_ONLY");
  });

  it("lets the identity the labels kept win over the daemon's value", () => {
    const env = seatRestartEnv({ OPENRIG_NODE_ID: "n-codex", OPENRIG_SESSION_NAME: "a@r", OPENRIG_RUNTIME: "codex", CODEX_HOME: "/seat/home" }, SOURCES);
    expect(env).toMatchObject({ OPENRIG_NODE_ID: "n-codex", OPENRIG_SESSION_NAME: "a@r", CODEX_HOME: "/seat/home", CODEX_ONLY: "c" });
  });

  // OF-205 (a), from the OF-200 review G2: the respawn picked the daemon's extra env layer by the OPENRIG_RUNTIME LABEL of the terminal, and anything that can
  // run `hc` as the same user can write a label. Today the one layer is omp's provider auth env, so a label saying "omp" on a codex seat made its next respawn
  // carry omp's provider keys. The record decides.
  it("a label that says another runtime picks no layer: a codex seat labelled omp gets codex's layer, never omp's provider keys, and the env says codex", () => {
    const env = seatRestartEnv({ OPENRIG_NODE_ID: "n-codex", OPENRIG_SESSION_NAME: "a@r", OPENRIG_RUNTIME: "omp" }, SOURCES);
    expect(env, "the forged label's layer").not.toHaveProperty("OMP_KEY");
    expect(env).toMatchObject({ CODEX_ONLY: "c", OPENRIG_RUNTIME: "codex" });
  });

  it("a seat the record does not know gets no runtime layer, whatever its label says", () => {
    const env = seatRestartEnv({ OPENRIG_NODE_ID: "n-gone", OPENRIG_RUNTIME: "omp" }, SOURCES);
    expect(env).not.toHaveProperty("OMP_KEY");
    expect(env, "the daemon's own launch env still reaches it").toMatchObject({ OPENRIG_ACTIVITY_HOOK_TOKEN: "tok" });
  });

  it("drops a blank or undefined value, as the launch does, and puts no shim on a missing PATH", () => {
    const env = seatRestartEnv({}, { sessionEnv: { OPENRIG_HOME: "/h/.openrig", EMPTY: " ", UNSET: undefined }, runtimeSessionEnv: {}, runtimeOf: () => undefined });
    expect(env).toEqual({ OPENRIG_HOME: "/h/.openrig" });
  });

  it("gives the shim the daemon's home when the session env names none", () => {
    const saved = process.env["OPENRIG_HOME"];
    process.env["OPENRIG_HOME"] = "/from/daemon";
    try {
      expect(seatRestartEnv({}, { sessionEnv: { PATH: "/bin" }, runtimeSessionEnv: {}, runtimeOf: () => undefined })["PATH"]).toBe("/from/daemon/rig-bin:/bin");
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
      // OF-205 (a): the runtime is the record's. A seat the database knows (node and session name together) is its record's runtime whatever its label says;
      // the label of a seat whose name does not match the record's is not believed either.
      daemon.db.prepare("INSERT INTO rigs (id, name) VALUES ('r1', 'wired')").run();
      daemon.db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd) VALUES ('node-omp', 'r1', 'dev.omp', 'omp', '/tmp')").run();
      daemon.db.prepare("INSERT INTO sessions (id, node_id, session_name, status) VALUES ('s1', 'node-omp', 'dev-omp@wired', 'running')").run();
      expect((adapter as HcAdapter).restartEnvOf({ OPENRIG_NODE_ID: "node-omp", OPENRIG_SESSION_NAME: "dev-omp@wired", OPENRIG_RUNTIME: "codex" })["OPENRIG_RUNTIME"]).toBe("omp");
      expect((adapter as HcAdapter).restartEnvOf({ OPENRIG_NODE_ID: "node-omp", OPENRIG_SESSION_NAME: "someone-else@wired", OPENRIG_RUNTIME: "codex" })["OPENRIG_RUNTIME"], "a name the record does not pair with the node").toBe("codex");
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
