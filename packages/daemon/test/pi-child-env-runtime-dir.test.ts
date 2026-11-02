import { describe, expect, it } from "vitest";
import { buildPiChildEnv } from "../src/adapters/pi-runner-protocol.js";

// A Pi seat's tools run with the pi child's env, which is deny-by-default. Without XDG_RUNTIME_DIR in it, a `rig` or `hc` run by the
// seat resolves the host's runtime dir (incident 2026-11-02: a Pi seat's `rig daemon start` ran with no XDG_RUNTIME_DIR, and the core
// it started took /run/user/<uid>). The seat pane's own value now crosses, like a Codex or Claude seat's whole pane env does. The names
// are restated here, not imported, so a name added to or dropped from the baseline fails a row.
const PANE = {
  PATH: "/bin", HOME: "/h", USER: "u", LOGNAME: "u", TERM: "xterm", LANG: "C", LC_ALL: "C", SHELL: "/bin/sh", TMPDIR: "/t",
  XDG_RUNTIME_DIR: "/private/run",
  XDG_STATE_HOME: "/private/state", XDG_CONFIG_HOME: "/private/config", XDG_DATA_HOME: "/private/data", XDG_CACHE_HOME: "/private/cache",
  DBUS_SESSION_BUS_ADDRESS: "unix:path=/private/bus", SSH_AUTH_SOCK: "/private/agent", DISPLAY: ":0",
  HC_SOCKET: "/private/run/herdr-core/default.sock", HC_SESSION: "default", HC_TERMINAL_SOCKET: "/private/t.sock",
};
const OPTS = { agentDir: "/a", sessionsDir: "/s" };

describe("the pi child's env carries the seat pane's runtime dir, and no other XDG or session-bus name", () => {
  it("pi: XDG_RUNTIME_DIR crosses with the pane's value", () => {
    expect(buildPiChildEnv(PANE, OPTS).XDG_RUNTIME_DIR).toBe("/private/run");
  });
  it("omp: XDG_RUNTIME_DIR crosses with the pane's value", () => {
    expect(buildPiChildEnv(PANE, { ...OPTS, runtime: "omp" }).XDG_RUNTIME_DIR).toBe("/private/run");
  });
  it("brings in nothing else the pane holds: the other XDG dirs, the session bus, the ssh agent, the display and HC_* stay out", () => {
    const env = buildPiChildEnv(PANE, OPTS);
    expect(Object.keys(env).sort()).toEqual([
      "HOME", "LANG", "LC_ALL", "LOGNAME", "PATH", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "SHELL", "TERM", "TMPDIR", "USER", "XDG_RUNTIME_DIR",
    ]);
  });
  it("never makes one up: a pane without it gives a child without it, not the host's /run/user/<uid>", () => {
    const { XDG_RUNTIME_DIR: _omitted, ...withoutIt } = PANE;
    const env = buildPiChildEnv(withoutIt, OPTS);
    expect(env).not.toHaveProperty("XDG_RUNTIME_DIR");
    expect(JSON.stringify(env)).not.toContain("/run/user");
  });
  it("a spec that also names it in env_passthrough changes nothing", () => {
    expect(buildPiChildEnv(PANE, { ...OPTS, extraNames: ["XDG_RUNTIME_DIR"] })).toEqual(buildPiChildEnv(PANE, OPTS));
  });
});
